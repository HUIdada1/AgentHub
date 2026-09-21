// 生态接入 · CC Switch：把 AgentHub 反代网关注册（upsert）为 CC Switch 的 provider 条目
// 只读写 ~/.cc-switch/cc-switch.db 的 providers 表（固定 id），绝不动其它 provider。
//
// meta 里的字段语义见 CC Switch 源码：
// 1) apiFormat = "openai_chat"：网关只提供 Chat Completions，需要 CC Switch 做协议翻译。
//    必须显式写 meta.apiFormat，不能只靠 base_url 兜底——CC Switch 的
//    codex_provider_uses_chat_completions() 在读到 config 里的 wire_api 后**提前 return**，
//    base_url 那层永远轮不到；而 Codex 的 wire_api 按 Codex 侧语义必须是 "responses"，
//    于是判定为「非 chat」→ 不转换 → Codex 的 /v1/responses 直接打到网关 → 404。
//    （Claude 侧同理走 meta.apiFormat，见 get_claude_api_format()。）
// 2) commonConfigEnabled = true：切换条目时 CC Switch 会用条目内容**整体覆写** live 配置，
//    只有 true 才会把用户的「通用配置片段」合并进来。设 false 等于每次切到本条目就丢掉
//    用户全局配置里的插件 / 状态栏 / 项目信任 / desktop 偏好等。置 true 不会污染网关路由：
//    片段提取时已剥掉 model、model_provider、整个 [model_providers] 表与 model_catalog_json。
// 3) Claude 条目只写 ANTHROPIC_AUTH_TOKEN（Authorization: Bearer）：AgentHub 网关只认该
//    请求头，实测只发 x-api-key 会 401；同时写两个变量还会触发 Claude Code
//    「AUTH_TOKEN 与 API_KEY 并存」鉴权告警。meta.apiKeyField 同步声明，避免表单回写。
// 4) Claude 条目的 *_MODEL 存真实上游模型（接管时 CC Switch 的 model_mapper 会据此把
//    Claude 角色别名映射回真实模型），*_MODEL_NAME 只作展示名，不得写入别名。
//    非接管路径（如 CC Switch 的「打开终端」）不经过转换，直连网关必然 404，
//    因此 UI 必须引导用户开启代理接管后正常启动 claude，而不是用「打开终端」。
// 测试可用 CCSWITCH_DB_PATH 环境变量把库位置指到临时目录（备份目录跟随其父目录）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("../config.cjs");

// 驱动与 store.cjs 一致：Node 22 内置 node:sqlite 优先，better-sqlite3 回退
let Database = null;
let driver = "none";
try {
  Database = require("node:sqlite").DatabaseSync;
  driver = "node:sqlite";
} catch {
  try {
    Database = require("better-sqlite3");
    driver = "better-sqlite3";
  } catch {
    Database = null;
  }
}

/** 固定 id：靠它做幂等 upsert，也保证不触碰用户其它 provider */
const FIXED = {
  claude: "agenthub-gateway-claude",
  codex: "agenthub-gateway-codex",
  "claude-desktop": "agenthub-gateway-claude-desktop",
};
const APP_NAMES = {
  claude: "AgentHub 网关（Claude Code）",
  codex: "AgentHub 网关（Codex）",
  "claude-desktop": "AgentHub 网关（Claude Desktop）",
};
const ICONS = {
  claude: { icon: "anthropic", iconColor: "#D4915D" },
  codex: { icon: "openai", iconColor: "#10A37F" },
  "claude-desktop": { icon: "claude", iconColor: "#D4915D" },
};

/** 只保留最近 N 份本应用生成的写前备份：备份含明文密钥，无限累积是一种安全负担 */
const BACKUP_KEEP = 10;

/** INSERT 用到的全部列（自检与写入共用，单一事实源）：
 *  schema 漂移时按这份清单把写入错误归类为「CC Switch 版本不兼容」 */
const INSERT_COLS = [
  "id", "app_type", "name", "settings_config", "website_url", "category",
  "created_at", "sort_index", "notes", "icon", "icon_color", "meta",
  "is_current", "in_failover_queue",
];

function ccDir() {
  return process.env.CCSWITCH_DB_PATH ? path.dirname(process.env.CCSWITCH_DB_PATH) : path.join(os.homedir(), ".cc-switch");
}

function dbPath() {
  return process.env.CCSWITCH_DB_PATH || path.join(os.homedir(), ".cc-switch", "cc-switch.db");
}

/** 打开 CC Switch 库；不写库的调用（status/备份）也只是纯 SELECT/VACUUM，不必单独开只读 */
function openDb() {
  if (!Database) throw new Error("SQLite 驱动不可用（node:sqlite / better-sqlite3 均加载失败）");
  const db = driver === "better-sqlite3" ? new Database(dbPath(), { timeout: 3000 }) : new Database(dbPath());
  db.exec("PRAGMA busy_timeout = 3000"); // CC Switch 应用可能正持着库连接，等待锁释放而非直接失败（WAL 与回滚日志模式均适用）
  return db;
}

function formatTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p3(d.getMilliseconds())}`;
}

/** 写前备份：主路径 VACUUM INTO 产出单一一致性快照（含 WAL 未合并帧），无需复制 .db/-wal/-shm 三件套即可避免撕裂；
 *  不支持 VACUUM INTO 的老 SQLite 才退化为三件套文件拷贝（见下方兜底分支，尽力而为）；
 *  目标已存在时按 .1/.2 后缀递增，保证每次注册的备份独立落盘；返回实际写入的路径 */
function backupTo(backupPath) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  let target = backupPath;
  let n = 0;
  while (fs.existsSync(target)) {
    n += 1;
    target = `${backupPath}.${n}`;
  }
  const src = openDb();
  try {
    const esc = String(target).replace(/\\/g, "\\\\").replace(/'/g, "''");
    src.exec(`VACUUM INTO '${esc}'`);
  } catch {
    // 老 SQLite 不支持 VACUUM INTO 时退化为文件拷贝（仅兜底；CC Switch 官方同款做法）
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = dbPath() + suffix;
      if (fs.existsSync(f)) fs.copyFileSync(f, target + suffix);
    }
  } finally {
    src.close();
  }
  if (!fs.existsSync(target)) throw new Error("备份失败：未生成备份文件");
  return target;
}

/** 备份轮换：仅清理本应用前缀（cc-switch.db.bak_agenthub_*）的旧备份，保留最近 keep 份；
 *  其它任何文件（含用户自己的备份）一概不动；按修改时间倒序计数，失败静默跳过 */
function rotateBackups(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const prefix = "cc-switch.db.bak_agenthub_";
  const mine = names
    .filter((n) => n.startsWith(prefix))
    .map((n) => {
      const full = path.join(dir, n);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: n, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const f of mine.slice(keep)) {
    try {
      fs.unlinkSync(f.full);
      removed++;
    } catch {
      /* 删除失败不影响本次注册 */
    }
  }
  return removed;
}

/** 组装条目的 settings_config / meta（字符串化后入库） */
function buildEntry(appType, { base, apiKey, model }) {
  if (appType === "claude") {
    // 真实上游模型必须留在 *_MODEL：CC Switch 接管时会把 live 里的角色字段改写成
    // claude-sonnet-5 等别名，再由 model_mapper 用这里的 *_MODEL 映射回真实模型。
    // *_MODEL_NAME 仅供展示，写别名会导致接管后上游收到错误模型名。
    const upstream = String(model);
    return {
      settings_config: {
        env: {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_MODEL: upstream,
          ANTHROPIC_DEFAULT_SONNET_MODEL: upstream,
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: upstream,
          ANTHROPIC_DEFAULT_OPUS_MODEL: upstream,
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: upstream,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: upstream,
          ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: upstream,
          CLAUDE_CODE_SUBAGENT_MODEL: upstream,
        },
      },
      meta: {
        apiFormat: "openai_chat",
        commonConfigEnabled: true,
        apiKeyField: "ANTHROPIC_AUTH_TOKEN",
      },
    };
  }
  if (appType === "claude-desktop") {
    // Claude Desktop 3P profile 与 Claude Code 是不同入口，只能走 Proxy 模型映射模式：
    // 网关是 openai_chat 且模型非 Sonnet/Opus/Haiku 三档角色 id，直连模式会被 Desktop 拒绝。
    // 模型不写 env，统一放 meta.claudeDesktopModelRoutes（routeId → 真实上游模型），
    // 由 CC Switch 本地网关（127.0.0.1:15721/claude-desktop）做角色映射 + 协议转换。
    // Desktop 3P 不走 CC Switch 的通用配置 / MCP / Skills 同步，故不写 commonConfigEnabled。
    const upstream = String(model);
    return {
      settings_config: {
        env: {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_AUTH_TOKEN: apiKey,
        },
      },
      meta: {
        apiFormat: "openai_chat",
        claudeDesktopMode: "proxy",
        // 四角色 routeId 全映射到同一上游模型（上游 CLAUDE_DESKTOP_ROLE_ROUTE_IDS；
        // value 形态 { model, labelOverride } 对照上游 ClaudeDesktopProviderForm 的落库样板）
        // labelOverride 必须等于 model：留空时 Desktop 菜单显示的是角色名，看不出实际在跑哪个模型
        claudeDesktopModelRoutes: {
          "claude-sonnet-5": { model: upstream, labelOverride: upstream },
          "claude-opus-5": { model: upstream, labelOverride: upstream },
          "claude-haiku-4-5": { model: upstream, labelOverride: upstream },
          "claude-fable-5": { model: upstream, labelOverride: upstream },
        },
      },
    };
  }
  // codex：CC Switch 依此写 ~/.codex/config.toml + auth.json
  // wire_api 保持 "responses"（Codex 客户端侧语义），真正的 Chat 翻译由 meta.apiFormat 触发；
  // 这两者不矛盾——上游 Chat、客户端 Responses，正是 CC Switch 转换层存在的意义。
  const esc = String(model).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const toml = [
    'model_provider = "custom"',
    `model = "${esc}"`,
    'model_reasoning_effort = "high"',
    "disable_response_storage = true",
    "",
    "[model_providers.custom]",
    'name = "AgentHub"',
    `base_url = "${base}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n");
  return {
    settings_config: {
      auth: { OPENAI_API_KEY: apiKey },
      config: toml,
      // 模型目录：CC Switch 接管后会投影成 ~/.codex/cc-switch-model-catalog.json，
      // Codex 的 /model 才能列出网关模型；缺这项时只能用内置模型名。
      // 字段形态对照本机已跑通的 Buddy 条目（codex_config.rs 的 codex_catalog_model_specs）：
      // reasoningLevels 决定可选档位，defaultReasoningLevel 只在同时给了 reasoningLevels 时生效，
      // 否则回落「模板默认档仍在列表里则用模板默认，否则取最高档」。
      modelCatalog: {
        models: [
          {
            model,
            displayName: model,
            contextWindow: 300000,
            reasoningLevels: ["low", "high", "max"],
            defaultReasoningLevel: "high",
          },
        ],
      },
    },
    meta: {
      apiFormat: "openai_chat",
      commonConfigEnabled: true,
      // 思考能力：Codex 客户端经 CC Switch 转 Chat 时，声明上游网关支持思考模式与思考深度档位。
      // supportsThinking / supportsEffort 即 CC Switch「支持思考模式 / 支持思考等级」开关
      // （effort 开启会自动带起 thinking，见 transform_codex_chat.rs 的 supports_thinking 推断）；
      // 网关为通用 Chat 层，effort 档位按 passthrough 原样透传（modelCatalog.reasoningLevels 已背书 low/high/max），
      // thinking/effort 参数名取上游默认值（thinking / reasoning_effort，顶层 OpenAI 风格字段，
      // 与本机跑通的「赔钱国模」等 Chat 上游条目一致）。
      codexChatReasoning: {
        supportsThinking: true,
        supportsEffort: true,
        thinkingParam: "thinking",
        effortParam: "reasoning_effort",
        effortValueMode: "passthrough",
        outputFormat: "auto",
      },
    },
  };
}

/** 只读视图：CC Switch 是否已安装 + 三个固定条目是否已注册 + 各应用代理接管是否已开启 */
function status() {
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return {
      installed: false,
      dbPath: p,
      takeover: { claude: false, codex: false, claudeDesktop: false },
      entries: [
        { appType: "claude", registered: false },
        { appType: "codex", registered: false },
        { appType: "claude-desktop", registered: false },
      ],
    };
  }
  const db = openDb();
  try {
    let rows = [];
    let incompatible = false;
    // 代理接管状态：proxy_config.enabled 为该应用是否已接管（等价于 require routing）。
    // 读取失败按未接管处理，只在 UI 上提示，不影响注册本身。
    let takeover = { claude: false, codex: false, claudeDesktop: false };
    try {
      // 与 register 同源校验：providers 表存在且具备 INSERT 所需的全部列
      const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`).get();
      if (!hasTable) throw new Error("no providers table");
      const cols = new Set(db.prepare(`PRAGMA table_info(providers)`).all().map((c) => c.name));
      if (INSERT_COLS.some((c) => !cols.has(c))) throw new Error("missing providers columns");
      rows = db.prepare(`SELECT id, name FROM providers WHERE id IN (?, ?, ?)`)
        .all(FIXED.claude, FIXED.codex, FIXED["claude-desktop"]);
      try {
        // Claude Desktop 的映射模式依赖 CC Switch 本地网关常驻：本机 proxy_config 无
        // claude-desktop 行，借 claude 行的 proxy_enabled 判断全局代理网关是否在线。
        const ps = db.prepare(`SELECT app_type, proxy_enabled, enabled FROM proxy_config WHERE app_type IN ('claude','codex')`).all();
        takeover = {
          claude: !!ps.find((r) => r.app_type === "claude")?.enabled,
          codex: !!ps.find((r) => r.app_type === "codex")?.enabled,
          claudeDesktop: !!ps.find((r) => r.app_type === "claude")?.proxy_enabled,
        };
      } catch {
        /* proxy_config 缺失/结构不同：按未接管展示 */
      }
    } catch {
      incompatible = true; // 库在但表/列缺失等，按未注册展示并提示库异常
    }
    return {
      installed: true,
      incompatible,
      dbPath: p,
      takeover,
      entries: ["claude", "codex", "claude-desktop"].map((t) => {
        const row = rows.find((r) => r.id === FIXED[t]);
        return { appType: t, registered: !!row, name: row ? row.name : undefined };
      }),
    };
  } finally {
    db.close();
  }
}

/** 注册（upsert）固定 id 条目：备份 → 表自检 → UPDATE 优先，0 行则 INSERT */
function register({ appType, apiKey, model, port } = {}) {
  const t = String(appType || "");
  if (t !== "claude" && t !== "codex" && t !== "claude-desktop") return { ok: false, message: `未知应用类型 "${t}"` };
  const key = String(apiKey || "").trim();
  const mdl = String(model || "").trim();
  if (!key) return { ok: false, message: "请先选择网关 API Key" };
  if (!mdl) return { ok: false, message: "请填写默认模型" };
  if (!Number.isFinite(port) || port <= 0) {
    const cfg = config.loadConfig();
    port = (cfg && cfg.proxy && cfg.proxy.port) || 9527;
  }
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return { ok: false, message: "未检测到 CC Switch（缺少 ~/.cc-switch/cc-switch.db），请先安装并启动一次 CC Switch" };
  }

  // 1) 写前整库备份（失败则中止，不碰原库）
  let backupPath = "";
  try {
    backupPath = backupTo(path.join(ccDir(), "backups", `cc-switch.db.bak_agenthub_${formatTimestamp()}`));
  } catch (e) {
    return { ok: false, message: `备份失败，已中止：${(e && e.message) || e}` };
  }
  rotateBackups(path.dirname(backupPath), BACKUP_KEEP); // 轮换失败不影响本次注册

  // 2) 表结构自检：providers 表与其 INSERT 所需的全部列
  const db = openDb();
  try {
    const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`).get();
    if (!hasTable) return { ok: false, message: "CC Switch 数据库版本不兼容（providers 表不存在）" };
    const cols = new Set(db.prepare(`PRAGMA table_info(providers)`).all().map((c) => c.name));
    const missing = INSERT_COLS.filter((c) => !cols.has(c));
    if (missing.length) {
      return { ok: false, message: `CC Switch 数据库版本不兼容（providers 缺列：${missing.join("、")}），请升级 CC Switch 后重试` };
    }

    // 3) 组装并 upsert
    const base = `http://127.0.0.1:${port}`;
    const entry = buildEntry(t, { base, apiKey: key, model: mdl });
    const now = Date.now();
    const name = APP_NAMES[t];
    const settings = JSON.stringify(entry.settings_config);
    const meta = JSON.stringify(entry.meta);
    const notes = `由 AgentHub 生态接入页生成（${new Date(now).toLocaleString("zh-CN")}）`;
    const upd = db.prepare(`UPDATE providers SET name = ?, settings_config = ?, notes = ?, meta = ? WHERE id = ?`)
      .run(name, settings, notes, meta, FIXED[t]);
    let action = "updated";
    if (!upd.changes) {
      // 排在同 app 分组其它条目末尾；固定 id 本身不参与计 max（避免覆盖已有条目顺序）
      const maxRow = db.prepare(
        `SELECT COALESCE(MAX(sort_index), 0) AS m FROM providers WHERE app_type = ? AND id NOT IN (?, ?, ?)`
      ).get(t, FIXED.claude, FIXED.codex, FIXED["claude-desktop"]);
      const sortIndex = Number((maxRow && maxRow.m) || 0) + 1;
      db.prepare(
        `INSERT INTO providers (${INSERT_COLS.join(", ")})
         VALUES (${INSERT_COLS.map(() => "?").join(", ")})`
      ).run(
        FIXED[t], t, name, settings, "https://github.com/HUIdada1/AgentHub", "custom",
        now, sortIndex, notes, ICONS[t].icon, ICONS[t].iconColor, meta, "0", "0"
      );
      action = "inserted";
    }
    // 回传真实条目名：提示语直接用它，避免前端另行拼一套名字而与 CC Switch 里显示的不一致
    return { ok: true, action, backupPath, dbPath: p, appType: t, name };
  } finally {
    db.close();
  }
}

module.exports = { status, register };
