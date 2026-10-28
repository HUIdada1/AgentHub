/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-28
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 生态接入 · CC Switch：把 AgentHub **本地网关**注册（upsert）为 CC Switch 的 provider 条目
// 只读写 ~/.cc-switch/cc-switch.db 的 providers 表（固定 id），绝不动其它 provider。
//
// 【恢复说明 2026-10-28】本模块随 fdb3e55「反代网关 → 号池管家」改造下线归档，现恢复回主树。
// 恢复时**必须**改掉对已删除的 proxy/server.cjs 的依赖——原文只有一处 `server.status().port`，
// 而那条转发链路已经不存在了；留着的直接后果是 require 期就抛 MODULE_NOT_FOUND，连同整个
// 号池编排层的 register 一起起不来。现在端口一律从 localgw 取（见下方 gatewayPort()）。
// config.cjs 也随那两处调用消失而不再被本模块使用（已移除顶层 require）。
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
// 测试可用 CCSWITCH_DB_PATH 环境变量把库位置指到临时目录（备份目录跟随其父目录）；
// live 探测读的是 os.homedir()（Windows 取 USERPROFILE、类 Unix 取 HOME），自测里两个都指到 fixture 家目录，
// 否则会用真机的 ~/.claude 与 ~/.codex 喂断言——那既不确定，也是在读用户私有配置
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * 网关监听端口（注册条目的 base_url 与 live 指向分类都要它）。
 *
 * 原实现从 proxy/server.cjs 的 status() 取——那条转发链路已在 fdb3e55 下线归档，
 * 现在唯一在跑的网关是 localgw，端口按以下优先级取：
 *   ① localgw 实际监听端口（改过配置没重启时以监听为准）
 *   ② localgw 配置里的目标端口（未启动时 status() 回的就是它，这里只作兜底）
 *   ③ 9527（runtime 缺 node:sqlite 等极端情况下的历史默认，保证总有一个可写的值）
 *
 * 为什么惰性 require 且 try/catch：localgw/server.cjs 顶层会连带装配 routing/models/oplog
 * 一整串模块，而 ccswitch 只管「写 CC Switch 库」这一件事，不该因为网关子模块出问题就整体不可用
 * （与 localgw/routing.cjs 顶部「不能 require proxy/index.cjs」同源：依赖要窄、失败要局部化）。
 */
function gatewayPort() {
  try {
    const s = require("../localgw/server.cjs").status();
    if (Number.isFinite(s && s.port) && s.port > 0) return s.port;
  } catch { /* localgw 未装配（如早期启动阶段）时走下面两条兜底 */ }
  try {
    const p = (require("../localgw/config.cjs").get() || {}).port;
    if (Number.isFinite(p) && p > 0) return p;
  } catch { /* 配置读不到时用缺省 */ }
  return 9527;
}

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

/** CC Switch 本地代理的监听端口（本机 CC Switch 日志 24 次启动均为 127.0.0.1:15721，
 *  cc-switch 未把该端口暴露成配置项，故按观测值写死）。
 *  live 配置指向它 = 客户端正被 CC Switch 接管转换；指向网关端口 = 直连。 */
const CCS_PROXY_PORT = 15721;

/** live 配置指向分类：gateway=直连 AgentHub 网关；ccswitch=经 CC Switch 本地代理；
 *  other=指向其它地址；unset=未配置服务地址。 */
function classifyLiveTarget(rawUrl, gatewayPort) {
  const url = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!url) return { url: "", target: "unset" };
  let host = "";
  let port = 0;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    return { url, target: "other" };
  }
  // URL.hostname 对 IPv6 回的是带方括号的形态（new URL("http://[::1]:9527").hostname === "[::1]"），
  // 所以两种写法都要认——只写 "::1" 会让 http://[::1]:9527 这种本地地址落进 other
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (local && port === gatewayPort) return { url, target: "gateway" };
  if (local && port === CCS_PROXY_PORT) return { url, target: "ccswitch" };
  return { url, target: "other" };
}

/** 读各应用 live 配置的实际指向——真实流量路径的地面真相，库里的接管开关只是意图。
 *  Claude Code：~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL；
 *  Codex：~/.codex/config.toml 的 model_provider → [model_providers.X] base_url。
 *  任何读取失败都按未配置处理，不影响状态卡其余部分。 */
function readLiveRouting(gatewayPort) {
  const read = (fn) => {
    try {
      return fn();
    } catch {
      return { url: "", target: "unset" };
    }
  };
  const claude = read(() => {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
    return classifyLiveTarget(j && j.env && j.env.ANTHROPIC_BASE_URL, gatewayPort);
  });
  const codex = read(() => {
    const toml = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    const cur = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(toml);
    let url = "";
    if (cur) {
      // provider 名要当字面量拼进正则：名字里带 . * [ 等元字符时不能让它匹配到别的段
      const esc = cur[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sec = new RegExp(`\\[\\s*model_providers\\.${esc}\\s*\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(toml);
      if (sec) url = (/^\s*base_url\s*=\s*"([^"]+)"/m.exec(sec[1]) || [])[1] || "";
    }
    return classifyLiveTarget(url, gatewayPort);
  });
  return { claude, codex };
}

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
      // 字段形态对照本机已跑通的 Buddy 条目（官方 Codex 配置结构 codex_catalog_model_specs）：
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
      // （effort 开启会自动带起 thinking，见官方 Codex 的 supports_thinking 推断）；
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

/** 只读视图：CC Switch 是否已安装 + 三个固定条目是否已注册 + 各应用代理接管状态 + live 配置实际指向。
 *  可传 { port } 显式指定网关端口（测试用）；缺省依次取实际监听端口 → 配置端口 → 9527 */
function status({ port } = {}) {
  // 网关端口判定：显式入参 → 实际监听端口（改过配置没重启时以监听为准）→ 配置端口 → 9527
  // 显式入参只用于自测；正常路径一律走 gatewayPort()（本地网关的实际监听端口）
  let gwPort = 0;
  if (Number.isFinite(port) && port > 0) gwPort = port;
  if (!gwPort) gwPort = gatewayPort();
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return {
      installed: false,
      dbPath: p,
      takeover: { claude: false, codex: false, claudeDesktop: false },
      live: readLiveRouting(gwPort),
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
    // 代理接管状态（proxy_config 两列的实测语义）：
    //   enabled = 接管开关的持久化意图——CC Switch 退出后仍为 1，下次启动自动恢复接管；
    //   proxy_enabled = 当前是否接管中——退出时随「Live 配置已恢复」归零，运行且接管中为 1。
    // 即：enabled=1 而 CC Switch 未运行时，live 配置其实已被恢复为直连网关，「路由已开启」
    // 不代表流量正经过它。读取失败按未接管处理，只在 UI 上提示，不影响注册本身。
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
        // claude-desktop 行，借 claude 行的 proxy_enabled 判断当前是否接管中。
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
      live: readLiveRouting(gwPort),
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
  // 未显式指定端口时取本地网关的实际监听端口（原实现读 config.proxy.port——那是已下线
  // 转发服务的端口段，配置里可能仍留着旧值 9527，而真正在跑的是 localgw 的端口）
  if (!Number.isFinite(port) || port <= 0) port = gatewayPort();
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

module.exports = { status, register, classifyLiveTarget };
