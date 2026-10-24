/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 存储层：SQLite（WAL）+ DPAPI 加密凭据
// 表结构：keys / agents / accounts / credits_history / usage_requests
// 驱动优先 better-sqlite3（方案选型），ABI 不匹配等加载失败时回退 Node 22 内置 node:sqlite（接口对齐）
// 凭据（token/refreshToken）不落明文：复用 config.cjs 的 safeStorage(DPAPI) enc:v1: 信封，等效方案 vault.bin
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("../config.cjs");
const { redact } = require("./redact.cjs");

// 驱动与用量同步模块一致：Node 22 内置 node:sqlite 优先（纯 JS 无原生编译依赖）；
// 老运行时没有 node:sqlite 时回退 better-sqlite3（方案选型，接口对齐）
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

/** 网关数据目录：%APPDATA%\AgentHub\proxy\（stats.db / rules / logs 都在这里） */
function proxyDir() {
  const d = path.join(config.dataDir(), "proxy");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL DEFAULT '',
  key_suffix TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT 'auto',
  route_order TEXT NOT NULL DEFAULT '',
  daily_quota INTEGER NOT NULL DEFAULT 0,
  rate_limit INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  pool_strategy TEXT NOT NULL DEFAULT 'expire_first',
  cost_tier TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  uid TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '',
  refresh_enc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  credits INTEGER NOT NULL DEFAULT 0,
  credits_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  cool_until INTEGER NOT NULL DEFAULT 0,
  cool_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'paste',
  last_used INTEGER NOT NULL DEFAULT 0,
  today_day TEXT NOT NULL DEFAULT '',
  today_req INTEGER NOT NULL DEFAULT 0,
  today_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  token_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credits_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel, account_id, day)
);
CREATE TABLE IF NOT EXISTS credit_packages (
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  remaining INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_credit_pkg_acc ON credit_packages(account_id);
CREATE TABLE IF NOT EXISTS model_cooldowns (
  acc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  until INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (acc_id, model)
);
CREATE TABLE IF NOT EXISTS usage_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  req_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  key_name TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_requests(ts);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_requests(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage_requests(channel, ts);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_requests(model, ts);
CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  op TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oplog_ts ON op_logs(ts);
`;

/**
 * 渠道注册表（UI 列表 / 健康检查 / 池同步校验 / key 路由校验的单一事实源）。
 * Qoder 双区：CN 与 INTL 各自独立接入（账号与额度池互不相通）。
 * INTL 免费额度不含 DeepSeek-Flash / GLM-5.3-Flash 等（需充值/额度覆盖才有可用模型），
 * 界面提示已注明；其签名器依赖本机安装的国际版客户端。
 * costTier = 成本档种子默认（cost-first 路由排序用）：free=免费额度渠道 / low=签到白送类 /
 * 不带=未标注（运行时按 normal 解释）。仅收有把握的两条，宁缺勿滥——错标 free 会把付费渠道排前面烧钱。
 */
const QODER_INTL_ENABLED = true;

// AutoClaw 双区开关：两地同协议同签名（appId/appKey 逐字相同），仅域名与登录方式不同
// （国内手机验证码 / 国际 OAuth）。地区是通道属性不是账号属性，故做成两个独立渠道 id，
// 不在账号上挂 region 字段——做成账号字段会让界面与选路分不清哪条账号走哪个站点。
const AUTOCLAW_INTL_ENABLED = true;

const CHANNELS = [
  // Cline 双池（免费额度池 / ClinePass 订阅池）：标准 OpenAI 兼容上游（api.cline.bot/api/v1），
  // 鉴权 Authorization: Bearer workos:<JWT>，无签名、无会话、无桌面端依赖——登录走 WorkOS
  // 设备授权（RFC 8628，四步：authorize/device → 浏览器确认 → authenticate 轮询 → /auth/register
  // 换 Cline 会话令牌）。两个独立 channel id 不做成「一家的一个选项」：界面混池、模型启停键冲突、
  // 同名模型短名归属漂移都是混池建模的真实缺陷（同款拆分）。
  // 池是身份不是账号属性，cline_free 标 costTier "free"（免费额度池，cost-first 路由正确优先），
  // cline_pass 不标（付费订阅，错标 free 会让 cost-first 烧钱）。
  { id: "cline_free", display: "Cline Free", domain: "api.cline.bot", costTier: "free" },
  { id: "cline_pass", display: "Cline Pass", domain: "api.cline.bot" },
  { id: "trae", display: "Trae SOLO CN", domain: "api.trae.cn" },
  { id: "workbuddy", display: "WorkBuddy CN", domain: "copilot.tencent.com" },
  { id: "workbuddy_ai", display: "WorkBuddy AI", domain: "www.workbuddy.ai" },
  { id: "raccoon", display: "商汤小浣熊", domain: "xiaohuanxiong.com" },
  // LobsterAI（网易有道龙虾）：原生 OpenAI 兼容 + 每日签到 100 积分 + 19 个模型。
  // 登录走应用内回环 OAuth（127.0.0.1/auth/callback），无需本机安装官方客户端。
  // ModelScope（魔搭 · 阿里）：官方 OpenAI 兼容网关 + 魔粒每日任务（登录 200/日 + 绑云 50/日
  // + 点赞 40/日）。唯一**官方公开 API** 型渠道：无客户端、无签名、无逆向。
  { id: "modelscope", display: "ModelScope（魔搭）", domain: "api-inference.modelscope.cn", costTier: "free" },
  { id: "lobster", display: "LobsterAI（有道）", domain: "lobsterai-server.youdao.com", costTier: "low" },
  { id: "zcode", display: "ZCode（智谱）", domain: "zcode.z.ai" },
  // CatPaw（美团）：上游是**有状态会话协议**（round → event → turn → event），适配器声明
  // stateful 走会话式转发；凭据是桌面端会话 Cookie 值（X-Passport-Token）+ user-uid 独立头，
  // 无签到、无刷新接口（过期只能在客户端重新登录）。成本档暂不标注（套餐口径未实测）
  { id: "catpaw", display: "CatPaw（美团）", domain: "ai.catpaw.meituan.com" },
  // Qoder CN：账号与额度池与 INTL 互不相通，各自独立接入。
  // 注意：该渠道签名依赖本机安装的客户端（wasm 提取），凭据可导入但未装客户端时不可调用。
  { id: "qoder", display: "Qoder CN", domain: "gateway.qoder.com.cn" },
  ...(QODER_INTL_ENABLED ? [{ id: "qoder_intl", display: "Qoder International", domain: "api2.qoder.sh" }] : []),
  // AutoClaw 双区（智谱 AutoGLM 加速站 / 国际站）：同套协议与签名指纹，仅域名与登录方式不同。
  // 账号体系两区独立，桌面端登录态文件却是同一个（%APPDATA%/AutoClaw/auth.json）——
  // 桌面导入时哪边登录了就是哪边的账号，靠用户选对目标渠道（与 Qoder 双区同口径）。
  { id: "autoclaw", display: "AutoClaw 国内版", domain: "autoglm-acceleration-api.zhipuai.cn" },
  ...(AUTOCLAW_INTL_ENABLED ? [{ id: "autoclaw_intl", display: "AutoClaw 国际版", domain: "autoglm-api.autoglm.ai" }] : []),
  // Accio（阿里）双区：国际版 / 国内版是**同一个网关**（phoenix-gw.alibaba.com），差别只在
  // x-package-region 头与登录站点（www.accio.com / www.accio-ai.com），账号与额度两区独立。
  // 上游不是 OpenAI 协议而是阿里 ADK 的 Gemini 风格信封，走会话式转发（stateful）。
  // 成本档暂不标注（套餐口径未实测）。
  { id: "accio", display: "Accio", domain: "phoenix-gw.alibaba.com" },
  { id: "accio_cn", display: "Accio 国内版", domain: "phoenix-gw.alibaba.com" },
  // CodeArts（华为云 AI 代码助手 / snap-access）：SDK-HMAC-SHA256 签名 + DPoP + 有状态会话
  // （每账号 3 路并发），临时凭据到期前 15 分钟续，走会话式转发（stateful）。无地区分叉。
  { id: "codearts", display: "CodeArts（华为云）", domain: "snap-access.cn-north-4.myhuaweicloud.com" },
  // Loomy（讯飞）：无状态 OpenAI 兼容，HMAC-SHA1 签名（账号域），手机验证码登录，每日签到
  // 刷赠送积分。无地区分叉。
  { id: "loomy", display: "Loomy（讯飞）", domain: "loomyad.xunfei.cn", costTier: "low" },
];

// 内置渠道 id 的只读名单：凡是「这一行是不是提供商」的判定都走它，而不是看 kind 列——
// 老库里那几行由 ALTER 的 DEFAULT 补成 'builtin'，但一条被手改脏的内置行若只按 kind 判，
// 会同时出现在渠道列表与提供商列表里（见 listProviders 的第二道挡）。
const BUILTIN_IDS = new Set(CHANNELS.map((c) => c.id));

/** 打开数据库（幂等）；建表 + WAL + 三渠道种子 + 90 天流水 GC */
function open() {
  if (db) return db;
  if (!Database) throw new Error("无可用 SQLite 驱动（better-sqlite3 加载失败且无 node:sqlite）");
  const file = path.join(proxyDir(), "stats.db");
  db = new Database(file);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  // 在线迁移：accounts.meta（账号元数据 JSON：domain/enterpriseId/editionType 等，WB 头矩阵用）
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN meta TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  // 在线迁移：accounts.updated_at（账号最后更新时间戳，用于多机同步冲突仲裁）
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  // 在线迁移：accounts.token_at（**凭据**写入时刻，只有 token/refreshToken 真正变化才推进）。
  // 号池同步的「凭据谁新」仲裁必须用它而不是 updated_at：后者被额度刷新/冷却/备注/签到等
  // 无关更新一路顶新，会让刚刷失败（被判 relogin）的一侧拿着坏凭据在 LWW 里胜出，
  // 反向污染另一台健康机器的凭据。存量为 0 的行按 updated_at 回填保底
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN token_at INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  db.prepare("UPDATE accounts SET token_at = updated_at WHERE token_at = 0").run();
  // 在线迁移：keys.key_enc（完整 Key 的 DPAPI 加密信封，供列表随时查看 / 复制）
  try {
    db.exec("ALTER TABLE keys ADD COLUMN key_enc TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  // 在线迁移：keys.updated_at（Key 最后更新时间戳，多机同步 LWW 仲裁——issue #92 修改/删除传播）
  try {
    db.exec("ALTER TABLE keys ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  // 老版本只增不改不删，存量行更新时间按迁移时刻起算（此后任何修改都会盖出更新的时间戳）
  db.prepare("UPDATE keys SET updated_at = ? WHERE updated_at = 0").run(Date.now());
  // 在线迁移：usage_requests 缓存 token（命中率统计；Anthropic 协议上游如 zcode 会回 cache_read/creation）
  try {
    db.exec("ALTER TABLE usage_requests ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  // ===== 一次性数据迁移：小浣熊账号 uid 由「签发方域名」纠正为账号 ID（sub）=====
  // 旧版 tokenUid 取 JWT 的 iss（= "xiaohuanxiong.com/iam" 签发方常量，所有账号都相同），
  // 于是历史行 uid 被写成该域名：号池里加不进第二个小浣熊号，跨机还会把不同账号当同一个
  // 互相覆盖凭据。这里只把「uid 恰好等于该域名」的行用 token 里的 sub 纠正，别的形态不动；
  // 解不开 token 或没有 sub 则跳过（下次启动再试）。
  try {
    const RACCOON_ISS_UID = "xiaohuanxiong.com/iam";
    const rows = db.prepare("SELECT id, uid, name, token_enc FROM accounts WHERE channel = 'raccoon' AND uid = ?").all(RACCOON_ISS_UID);
    if (rows.length) {
      const subOf = (tok) => {
        try {
          const parts = String(tok || "").split(".");
          if (parts.length < 2) return "";
          const pl = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
          return String((pl && pl.sub) || "");
        } catch { return ""; }
      };
      const updUid = db.prepare("UPDATE accounts SET uid = ? WHERE id = ?");
      const updName = db.prepare("UPDATE accounts SET name = ? WHERE id = ?");
      let fixed = 0;
      for (const row of rows) {
        const sub = subOf(config.decryptSecret(row.token_enc));
        if (!sub || sub === RACCOON_ISS_UID) continue;
        updUid.run(sub, row.id);
        // 名字若还是按旧 uid 派生的「账号 」+域名前 6 字符，一并纠正（不覆盖用户自定义名）
        if (row.name === "账号 " + String(row.uid).slice(0, 6)) updName.run("账号 " + sub.slice(0, 12), row.id);
        fixed++;
      }
      if (fixed) {
        try { require("./oplog.cjs").log("info", "号池账号", `纠正 ${fixed} 个小浣熊账号的 uid（签发方域名 → 账号 ID）`, { channel: "raccoon" }); } catch { /* 日志失败无碍 */ }
      }
    }
  } catch { /* 迁移失败不阻断启动，下次再试 */ }
  try {
    db.exec("ALTER TABLE usage_requests ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  // 在线迁移：keys.route_order（per-key 路由策略覆盖，''=跟随全局）/ agents.cost_tier（渠道成本档，''=未标注按 normal）
  try {
    db.exec("ALTER TABLE keys ADD COLUMN route_order TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN cost_tier TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  // 在线迁移：keys.allowed_channels / keys.allowed_models（Key 级渠道/模型白名单，空 = 不限制）
  // Key 级渠道/模型白名单（allowedProviders/allowedModels，对齐 R9）：
  // 存量行空串 = 不限制（升级绝不能让已有 Key 失效），JSON 数组形态存储
  try {
    db.exec("ALTER TABLE keys ADD COLUMN allowed_channels TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  try {
    db.exec("ALTER TABLE keys ADD COLUMN allowed_models TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  // 在线迁移：自定义提供商（同一张 agents 表扩列成「渠道表」，详见 migrateProviders 的注释）
  migrateProviders(db);
  const ins = db.prepare("INSERT OR IGNORE INTO agents (id, display, domain, pool_strategy, cost_tier, updated_at) VALUES (?,?,?,?,?,?)");
  const updDisplay = db.prepare("UPDATE agents SET display = ? WHERE id = ?");
  // 存量行成本档回填：INSERT OR IGNORE 不触碰已存在的行，这里只给「从未标注过」的行补种子默认
  // （守卫 cost_tier=''，用户手动改过的档位永不覆盖）
  const updTier = db.prepare("UPDATE agents SET cost_tier=? WHERE id=? AND cost_tier=''");
  for (const c of CHANNELS) {
    ins.run(c.id, c.display, c.domain, "expire_first", c.costTier || "", Date.now());
    updDisplay.run(c.display, c.id);
    if (c.costTier) updTier.run(c.costTier, c.id);
  }
  gc();
  return db;
}

/** 自定义提供商落库：不建新表，agents 表扩列即成为「渠道表」。
 *  为什么扩列而不建新表：pool_strategy 已在此表、accounts.channel 已以它为键，
 *  于是号池的轮转 / 冷却 / 租约 / 模型级负缓存 / 用量统计 / 号池页全部零改动生效。
 *  单独包一个函数（而不是摊进 open()）是为了让 open() 只多一行。 */
function migrateProviders(d) {
  const cols = [
    "kind TEXT NOT NULL DEFAULT 'builtin'",
    "base_url TEXT NOT NULL DEFAULT ''",
    "models_json TEXT NOT NULL DEFAULT '[]'",
    "extra_headers TEXT NOT NULL DEFAULT '{}'",
    "extra_body TEXT NOT NULL DEFAULT '{}'",
    "enabled INTEGER NOT NULL DEFAULT 1",
  ];
  for (const c of cols) {
    try { d.exec(`ALTER TABLE agents ADD COLUMN ${c}`); } catch { /* 已存在 */ }
  }
}

/** 流水保留期（天）：设置页 proxy.usageRetentionDays 可调，启动 GC 与统计页「清理」共用。
 *  放本模块的模块级变量（与 pool.expiringSoonDays 同一套做法），让热路径模块不依赖 config；
 *  由 index.cjs 的 register() 从设置灌入一次——它跑在 main.cjs 的 proxy.boot() 之前，
 *  所以首次 open() 里的 gc() 看到的已经是用户配的值，不是这里的默认值。
 *  默认 90 = 本改动之前写死在 gc() 里的那个数。 */
let usageRetentionDays = 90;
function setUsageRetention(days) {
  // 只接受 1~3650 的整数：非法值（NaN / 0 / 负数 / 超界）一律忽略并保留现值，
  // 不能让一个手滑的配置项把启动 GC 变成「删光」或「永不删」。
  const n = Math.round(Number(days) || 0);
  if (n >= 1 && n <= 3650) usageRetentionDays = n;
}

/** 流水按保留期 GC，启动时执行；余额历史同步清理；操作日志 30 天 + 5 万行上限 */
function gc() {
  const cutoff = Date.now() - Math.max(1, usageRetentionDays) * 86400000;
  db.prepare("DELETE FROM usage_requests WHERE ts < ?").run(cutoff);
  const dayCut = dayStr(cutoff);
  db.prepare("DELETE FROM credits_history WHERE day < ?").run(dayCut);
  // 操作日志：30 天 + 行数上限（每条代理请求一条，量级同 usage_requests；超限删最老）
  const logCut = Date.now() - 30 * 86400000;
  db.prepare("DELETE FROM op_logs WHERE ts < ?").run(logCut);
  db.prepare("DELETE FROM op_logs WHERE id NOT IN (SELECT id FROM op_logs ORDER BY id DESC LIMIT 50000)").run();
  // 流水行数上限：未认证请求也写流水（401 早退处记账），仅 90 天裁剪挡不住
  // 失控进程刷 401 撑大 stats.db——超限删最老，口径对齐 op_logs 的双上限
  db.prepare("DELETE FROM usage_requests WHERE id NOT IN (SELECT id FROM usage_requests ORDER BY id DESC LIMIT 200000)").run();
}

function dayStr(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ===== API Keys（鉴权实时查 SHA-256 哈希；完整 Key 以 DPAPI 信封存库，供列表随时查看 / 复制） =====

function hashKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

/** 路由合法性：auto 或任一已接入渠道（渠道扩充后无需改这里） */
function routeOk(route) {
  return route === "auto" || CHANNELS.some((c) => c.id === route);
}

/** per-key 路由策略白名单：''=跟随全局；非法值一律按跟随全局处理 */
function routeOrderOk(order) {
  return order === "" || order === "score" || order === "cost-first";
}

/** Key 参数整单校验（retry_api 语义：任一字段非法整体拒绝，不落半套配置）。
 *  isPatch=true 时只校验出现的字段（updateKey 的部分更新）；返回非法原因（空串 = 通过） */
function validateKeyParams(p, isPatch) {
  if (!isPatch || p.name != null) {
    if (p.name != null && typeof p.name !== "string") return "name 必须是字符串";
  }
  if (!isPatch || p.dailyQuota != null) {
    if (p.dailyQuota != null && (!Number.isFinite(Number(p.dailyQuota)) || Number(p.dailyQuota) < 0))
      return "dailyQuota 必须是非负数字";
  }
  if (!isPatch || p.rateLimit != null) {
    if (p.rateLimit != null && (!Number.isFinite(Number(p.rateLimit)) || Number(p.rateLimit) < 0))
      return "rateLimit 必须是非负数字";
  }
  return "";
}

function createKey({ name, route, routeOrder, dailyQuota, rateLimit }) {
  open();
  const v = validateKeyParams({ name, route, routeOrder, dailyQuota, rateLimit });
  if (v) throw new Error(v);
  const secret = "sk-" + crypto.randomBytes(24).toString("hex"); // 48 hex
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO keys (id, name, key_hash, key_enc, key_prefix, key_suffix, route, route_order, daily_quota, rate_limit, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)"
  ).run(
    id,
    String(name || "").slice(0, 64) || "未命名 Key",
    hashKey(secret),
    config.encryptSecret(secret),
    secret.slice(0, 7),
    secret.slice(-4),
    routeOk(route) ? route : "auto",
    routeOrderOk(routeOrder) ? routeOrder : "",
    Math.max(0, Number(dailyQuota) || 0),
    Math.max(0, Number(rateLimit) || 0),
    Date.now(),
    Date.now()
  );
  return { id, secret };
}

/** Key 白名单字段解析：空串/非数组 → 不限制（空数组 = 不限制等价）；脏数据容错剔除 */
function parseKeyAllowList(raw) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()) : [];
  } catch { return []; }
}

/** Key 白名单序列化：数组 → JSON 串落库；非数组/空 → 空串（不限制） */
function serializeKeyAllowList(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return JSON.stringify(list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()));
}

function listKeys() {
  open();
  const rows = db.prepare("SELECT * FROM keys ORDER BY created_at DESC").all();
  const day = dayStr();
  const usage = db.prepare(
    "SELECT key_id, COUNT(*) AS req, SUM(prompt_tokens + completion_tokens) AS tokens FROM usage_requests WHERE ts >= ? GROUP BY key_id"
  ).all(dayStartMs(day));
  const umap = new Map(usage.map((u) => [u.key_id, u]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mask: `${r.key_prefix}····${r.key_suffix}`,
    secret: r.key_enc ? config.decryptSecret(r.key_enc) : "",
    route: r.route,
    routeOrder: r.route_order || "",
    dailyQuota: r.daily_quota,
    rateLimit: r.rate_limit,
    allowedChannels: parseKeyAllowList(r.allowed_channels),
    allowedModels: parseKeyAllowList(r.allowed_models),
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at || 0,
    todayReq: (umap.get(r.id) || {}).req || 0,
    todayTokens: (umap.get(r.id) || {}).tokens || 0,
  }));
}

/**
 * 从别的设备导入/更新一把 API Key（号池 WebDAV 同步用）。
 *
 * 与 createKey 的区别：createKey 自己生成密钥，这里用**给定的明文密钥**入库——
 * 跨设备同步要求同一个 sk- 在各设备都能用，所以只能沿用原密钥。
 * 落库时按本机能力重新加密（Windows 走 DPAPI、无 safeStorage 的环境走明文降级），
 * 所以不直接搬运对端的 key_enc（跨平台解不开）。
 *
 * 幂等 + LWW（issue #92）：同 id 已存在时按 updatedAt 新者胜——远端改过（改名/改配额/
 * 启停）就同步过来；老版本对端不带 updatedAt（按 0）永远本机为准，与旧版「只补缺」一致。
 * 同 key_hash 但不同 id（同一把 Key 换了 id）视为已存在跳过，密文本就相同。
 */
function importKey({ id, name, secret, route, routeOrder, dailyQuota, rateLimit, enabled, createdAt, updatedAt }) {
  open();
  const s = String(secret || "").trim();
  if (!s) return { ok: false, reason: "empty-secret" };
  const hash = hashKey(s);
  const rid = String(id || "");
  const remoteAt = Math.max(0, Number(updatedAt) || 0);
  const dup = db.prepare("SELECT * FROM keys WHERE key_hash = ? OR id = ?").get(hash, rid);
  if (dup) {
    if (dup.id === rid && remoteAt > (dup.updated_at || 0)) {
      db.prepare("UPDATE keys SET name=?, route=?, route_order=?, daily_quota=?, rate_limit=?, enabled=?, updated_at=? WHERE id=?")
        .run(
          String(name || "").slice(0, 64) || dup.name,
          routeOk(route) ? route : dup.route,
          routeOrderOk(routeOrder) ? routeOrder : dup.route_order,
          patchNum(dailyQuota, dup.daily_quota),
          patchNum(rateLimit, dup.rate_limit),
          enabled === false ? 0 : enabled === true ? 1 : dup.enabled,
          remoteAt,
          rid
        );
      return { ok: true, updated: true };
    }
    return { ok: false, reason: "exists" };
  }
  db.prepare(
    "INSERT INTO keys (id, name, key_hash, key_enc, key_prefix, key_suffix, route, route_order, daily_quota, rate_limit, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    rid || crypto.randomUUID(),
    String(name || "").slice(0, 64) || "未命名 Key",
    hash,
    config.encryptSecret(s),
    s.slice(0, 7),
    s.slice(-4),
    routeOk(route) ? route : "auto",
    routeOrderOk(routeOrder) ? routeOrder : "",
    Math.max(0, Number(dailyQuota) || 0),
    Math.max(0, Number(rateLimit) || 0),
    enabled === false ? 0 : 1,
    Number(createdAt) || Date.now(),
    remoteAt || Date.now()
  );
  return { ok: true };
}

/** 数值补丁：远端没带（null/undefined）时保留本机现值；带了（含 0）取合法化后的值 */
function patchNum(v, cur) {
  return v == null ? cur : Math.max(0, Number(v) || 0);
}

function dayStartMs(day) {
  const d = day ? new Date(day + "T00:00:00") : new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 鉴权实时查库：启停/删除即时生效 */
function findKeyBySecret(secret) {
  open();
  const r = db.prepare("SELECT * FROM keys WHERE key_hash = ?").get(hashKey(secret));
  if (!r) return null;
  return {
    id: r.id, name: r.name, route: r.route, routeOrder: r.route_order || "", dailyQuota: r.daily_quota,
    rateLimit: r.rate_limit, enabled: !!r.enabled,
    allowedChannels: parseKeyAllowList(r.allowed_channels),
    allowedModels: parseKeyAllowList(r.allowed_models),
  };
}

function updateKey(id, patch) {
  open();
  const cur = db.prepare("SELECT * FROM keys WHERE id = ?").get(String(id));
  if (!cur) return false;
  const v = validateKeyParams(patch, true);
  if (v) throw new Error(v);
  const name = patch.name != null ? String(patch.name).slice(0, 64) : cur.name;
  const route = patch.route != null && routeOk(patch.route) ? patch.route : cur.route;
  const routeOrder = patch.routeOrder != null && routeOrderOk(patch.routeOrder) ? patch.routeOrder : cur.route_order;
  const quota = patch.dailyQuota != null ? Math.max(0, Number(patch.dailyQuota) || 0) : cur.daily_quota;
  const rate = patch.rateLimit != null ? Math.max(0, Number(patch.rateLimit) || 0) : cur.rate_limit;
  const allowedChannels = patch.allowedChannels != null ? serializeKeyAllowList(patch.allowedChannels) : cur.allowed_channels;
  const allowedModels = patch.allowedModels != null ? serializeKeyAllowList(patch.allowedModels) : cur.allowed_models;
  // 白名单字段的非法形态（非数组）整体拒绝——与 validateKeyParams 同口径，不落半套配置
  if (patch.allowedChannels != null && !Array.isArray(patch.allowedChannels)) throw new Error("allowedChannels 必须是字符串数组");
  if (patch.allowedModels != null && !Array.isArray(patch.allowedModels)) throw new Error("allowedModels 必须是字符串数组");
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled;
  // updated_at 推进：号池同步按它做 LWW，把改名/改配额/启停传播到其他设备（issue #92）
  db.prepare("UPDATE keys SET name=?, route=?, route_order=?, daily_quota=?, rate_limit=?, allowed_channels=?, allowed_models=?, enabled=?, updated_at=? WHERE id=?")
    .run(name, route, routeOrder, quota, rate, allowedChannels, allowedModels, enabled, Date.now(), cur.id);
  return true;
}

function deleteKey(id) {
  open();
  return db.prepare("DELETE FROM keys WHERE id = ?").run(String(id)).changes > 0;
}

/** Key 今日已用请求数（配额判定） */
function keyTodayReq(keyId) {
  open();
  const r = db.prepare("SELECT COUNT(*) AS c FROM usage_requests WHERE key_id = ? AND ts >= ?").get(String(keyId), dayStartMs());
  return r.c || 0;
}

// ===== 渠道（agents 表：号池调度策略） =====

function listAgents() {
  open();
  return db.prepare("SELECT * FROM agents ORDER BY rowid").all().map((r) => ({
    id: r.id, display: r.display, domain: r.domain, poolStrategy: r.pool_strategy,
    costTier: r.cost_tier || "",
    kind: BUILTIN_IDS.has(r.id) ? "builtin" : r.kind,
    enabled: !!r.enabled,
  }));
}

function setPoolStrategy(channel, strategy) {
  open();
  if (!["expire_first", "credit_first", "round_robin"].includes(strategy)) return false;
  db.prepare("UPDATE agents SET pool_strategy=?, updated_at=? WHERE id=?").run(strategy, Date.now(), String(channel));
  invalidateChannels();
  return true;
}

/** 渠道成本档（cost-first 路由排序用）：free=免费额度 / low=签到白送 / normal=普通（''也是 normal） */
function setAgentCostTier(channel, tier) {
  open();
  if (!["free", "low", "normal"].includes(tier)) return false;
  db.prepare("UPDATE agents SET cost_tier=?, updated_at=? WHERE id=?").run(tier, Date.now(), String(channel));
  return true;
}

// ===== 渠道（agents 表 = 内置渠道 + 用户自建提供商；这张表就是「渠道」的唯一真相源） =====

/** 渠道的**路由视图**：内置各家在前、启用中的自建提供商在后。所有「这个渠道存在吗 / 它叫什么 /
 *  它有哪些号」的判定都走这里，不再各自读常量。
 *  内置行的 display/domain 以 CHANNELS 代码常量为准（库里那行只承载 pool_strategy），
 *  这样改内置渠道的展示名不需要迁移已建库。
 *  memo 的生命周期只覆盖一次配置读取：提供商写路径（saveProvider/deleteProvider）显式失效。 */
let channelsMemo = null;
function invalidateChannels() { channelsMemo = null; }

function channelList() {
  if (channelsMemo) return channelsMemo;
  open();
  const out = CHANNELS.map((c) => ({ id: c.id, display: c.display, domain: c.domain, kind: "builtin", enabled: true }));
  for (const r of db.prepare("SELECT * FROM agents ORDER BY rowid").all()) {
    if (BUILTIN_IDS.has(r.id) || r.kind === "builtin" || !r.enabled) continue;
    out.push(providerChannelView(r));
  }
  channelsMemo = out;
  return out;
}

/** 渠道展示名。已停用的提供商也要能解析出来：统计页 / TOP 榜列的是历史流水里的 channel 值，
 *  那条流水产生时它还在启用，今天停用它不代表历史该退化成裸 slug。 */
function channelDisplay(id) {
  const k = String(id);
  const hit = channelList().find((c) => c.id === k);
  if (hit) return hit.display || k;
  const p = getProvider(k);
  return (p && p.display) || k;
}

function providerChannelView(r) {
  return {
    id: r.id,
    display: r.display || r.id,
    domain: r.domain || "",
    kind: r.kind,
    enabled: !!r.enabled,
    baseUrl: r.base_url || "",
    models: parseModelsJson(r.models_json),
    extraHeaders: parseJsonMap(r.extra_headers, r.id, "extra_headers"),
    extraBody: parseJsonMap(r.extra_body, r.id, "extra_body"),
    updatedAt: r.updated_at || 0,
  };
}

function parseModelsJson(raw) {
  try {
    const a = JSON.parse(raw || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 坏 JSON 只可能是用户手改库或上一版写入异常：按空对象继续服务，
 *  但绝不静默——让它在这里留下痕迹，否则 extraHeaders 消失会让上游 401 而看不出原因 */
function parseJsonMap(raw, id, col) {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    console.warn(`[proxy.store] agents.${col} 不是合法 JSON 对象（渠道 ${id}），按空处理`);
    return {};
  }
}

/** 管理面视图：含**已停用**的条目（channelList() 只给启用中的，停用条目总得能列出来再打开）。
 *  内置行按 id 再挡一道：老库里那几行的 kind 由 ALTER 的 DEFAULT 补成 'builtin'，
 *  但 id 命中内置名单的一律不当提供商处理，免得一条被改脏的行同时出现在两个视图里。 */
function listProviders() {
  open();
  return db
    .prepare("SELECT * FROM agents WHERE kind != 'builtin' ORDER BY rowid")
    .all()
    .filter((r) => !BUILTIN_IDS.has(r.id))
    .map(providerChannelView);
}

function getProvider(id) {
  open();
  const r = db.prepare("SELECT * FROM agents WHERE id = ?").get(String(id));
  if (!r || BUILTIN_IDS.has(r.id) || r.kind === "builtin") return null;
  return providerChannelView(r);
}

function isBuiltinChannel(id) { return BUILTIN_IDS.has(String(id)); }

/** 新增或整体覆盖一个提供商行。updated_at 一并前进，adapters 的动态适配器实例缓存以它为键，
 *  所以改完配置不必重启网关。 */
function saveProvider(p) {
  open();
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, display, domain, pool_strategy, updated_at, kind, base_url, models_json, extra_headers, extra_body, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET display=excluded.display, domain=excluded.domain,
       pool_strategy=excluded.pool_strategy, updated_at=excluded.updated_at, kind=excluded.kind,
       base_url=excluded.base_url, models_json=excluded.models_json,
       extra_headers=excluded.extra_headers, extra_body=excluded.extra_body, enabled=excluded.enabled`
  ).run(
    String(p.id),
    String(p.display || p.id).slice(0, 64),
    String(p.domain || ""),
    ["expire_first", "credit_first", "round_robin"].includes(p.poolStrategy) ? p.poolStrategy : "round_robin",
    now,
    String(p.kind),
    String(p.baseUrl || ""),
    JSON.stringify(Array.isArray(p.models) ? p.models : []),
    JSON.stringify(p.extraHeaders && typeof p.extraHeaders === "object" ? p.extraHeaders : {}),
    JSON.stringify(p.extraBody && typeof p.extraBody === "object" ? p.extraBody : {}),
    p.enabled === false ? 0 : 1
  );
  invalidateChannels();
  return getProvider(p.id);
}

/** 删除提供商连带它的 Key：removeAccount 负责清 credits_history 与 model_cooldowns，
 *  不先逐个删就直接 DELETE agents 会留下两处孤儿行。 */
function deleteProvider(id) {
  open();
  if (!getProvider(id)) return false;
  for (const acc of db.prepare("SELECT id FROM accounts WHERE channel = ?").all(String(id))) removeAccount(acc.id);
  const n = db.prepare("DELETE FROM agents WHERE id = ?").run(String(id)).changes;
  invalidateChannels();
  return n > 0;
}

// ===== 号池账号 =====

/** 行内凭据是否真的可用：号池同步曾把空 token 的账号（加密空串信封）传播进库，
 *  hasToken 只看 token_enc 非空会把这类坏号当可用号调度（全 401）。这里真实解密判一次。
 *  解密结果按信封 memo（信封不变=结果不变；更新凭据会写新信封），避免每次选号都打 DPAPI */
const usableCache = new Map();
function tokenUsable(r) {
  if (!r.token_enc) return false;
  const hit = usableCache.get(r.token_enc);
  if (hit !== undefined) return hit;
  if (usableCache.size > 512) usableCache.clear();
  let ok = false;
  try {
    ok = !!config.decryptSecret(r.token_enc);
  } catch {
    ok = false;
  }
  usableCache.set(r.token_enc, ok);
  return ok;
}

function accountView(r) {
  const meta = parseMeta(r.meta);
  // 冷却到期在**读时**派生回 online 并落库。不能只在 poolAccounts 被调用时复活：
  // 调度只挑 online 账号，若"复活"依赖该渠道被访问，就会出现
  // 「冷却 → 不被任何请求选中 → 永不复活」的死结（实测 workbuddy_ai 因一次 54 万 token
  // 请求顶穿首字节预算被熔断 30 分钟，之后 12.5 小时没有任何调用方唤醒它，
  // 渠道一直显示报错、模型目录也不再刷新）。
  // 顺带清掉过期的"最近错误"：它属于那次冷却，冷却结束就不再是当前状态
  // （完整历史仍保留在 usage_requests，不会丢）。
  let status = r.status;
  let coolUntil = r.cool_until;
  let coolReason = r.cool_reason || "";
  let lastError = meta.lastError || null;
  if (status === "cooling" && coolUntil && coolUntil <= Date.now()) {
    status = "online";
    coolUntil = 0;
    coolReason = "";
    lastError = null;
    const nextMeta = { ...meta };
    delete nextMeta.lastError;
    updateAccount(r.id, { status, coolUntil, coolReason, meta: nextMeta });
  }
  return {
    id: r.id,
    channel: r.channel,
    uid: r.uid,
    name: r.name,
    status,
    credits: r.credits,
    creditsAt: r.credits_at,
    expiresAt: r.expires_at,
    coolUntil,
    coolReason,
    /** 最近一次上游错误（气泡展示用；只留最新一条） */
    lastError,
    /** 今日签到结果（号池行内按钮三态与详情弹窗数据源；只留当天一条，跨天由前端按 day 判为过期） */
    checkin: meta.checkin && typeof meta.checkin === "object" ? meta.checkin : null,
    /** 首登奖励结算台账（小浣熊一次性新手福利；key → 结算时刻，落了即「已领取」） */
    onboardingGrants: meta.onboardingGrants && typeof meta.onboardingGrants === "object" ? meta.onboardingGrants : null,
    /** 账号备注（号池列表副行展示 + 备注弹窗；落 meta.note，随 WebDAV 同步） */
    note: typeof meta.note === "string" ? meta.note : "",
    source: r.source,
    lastUsed: r.last_used,
    todayReq: r.today_day === dayStr() ? r.today_req : 0,
    todayTokens: r.today_day === dayStr() ? r.today_tokens : 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at || Math.max(r.credits_at || 0, r.last_used || 0, r.created_at || 0),
    /** 凭据（token/refreshToken）写入时刻：号池同步的凭据新旧仲裁依据（0=老库未回填） */
    tokenAt: r.token_at || 0,
    hasToken: tokenUsable(r),
    domain: meta.domain || "",
    enterpriseId: meta.enterpriseId || "",
    meta,
  };
}

function parseMeta(raw) {
  try {
    const m = JSON.parse(raw || "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function listAccounts(channel) {
  open();
  const rows = channel
    ? db.prepare("SELECT * FROM accounts WHERE channel = ? ORDER BY created_at").all(String(channel))
    : db.prepare("SELECT * FROM accounts ORDER BY channel, created_at").all();
  return rows.map(accountView);
}

/** 渠道的原始行（含 token_enc 密文信封）：提供商的 Key 去重与「拿一把已有 Key 去探测」需要
 *  解密的原料，而 listAccounts 给的是脱敏视图。与 listAccounts 同一排序，只在「要不要解密」上分家。 */
function accountRows(channel) {
  open();
  return channel
    ? db.prepare("SELECT * FROM accounts WHERE channel = ? ORDER BY created_at").all(String(channel))
    : db.prepare("SELECT * FROM accounts ORDER BY channel, created_at").all();
}

function getAccount(id) {
  open();
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(String(id));
  return r || null;
}

/** 取解密后的凭据（仅主进程内部使用，绝不外传渲染层）
 *  meta：一并带出账号元数据（Cookie 等会话凭据存在 meta 里，值本身已由 encryptSecret 加密）。
 *  适配器需要 meta 才能按账号取 Cookie（/api/v1 族专用），故在此统一解密并透传。 */
function accountSecrets(r) {
  const meta = parseMeta(r && r.meta);
  // Cookie 值以 meta.msCookie 存放，落库前经 config.encryptSecret（DPAPI），此处解回明文
  if (meta && meta.msCookie) meta.msCookie = config.decryptSecret(meta.msCookie);
  return {
    token: config.decryptSecret(r.token_enc),
    refreshToken: config.decryptSecret(r.refresh_enc),
    meta,
  };
}

function addAccount({ channel, uid, name, token, refreshToken, source, expiresAt, meta, updatedAt, tokenAt }) {
  open();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, channel, uid, name, token_enc, refresh_enc, status, credits, credits_at, expires_at, cool_until, source, last_used, today_day, today_req, today_tokens, created_at, updated_at, token_at, meta)
     VALUES (?,?,?,?,?,?, 'online', 0, 0, ?, 0, ?, 0, ?, 0, 0, ?, ?, ?, ?)`
  ).run(
    id,
    String(channel),
    String(uid || ""),
    String(name || "").slice(0, 64) || (uid ? `账号 ${String(uid).slice(-6)}` : "未命名账号"),
    config.encryptSecret(token || ""),
    config.encryptSecret(refreshToken || ""),
    Math.max(0, Number(expiresAt) || 0),
    String(source || "paste"),
    dayStr(),
    now,
    Math.max(0, Number(updatedAt) || now),
    // 凭据时刻：号池同步整号入池时沿用快照里的值（凭据是远端那一刻写下的），缺省按当前时刻
    Math.max(0, Number(tokenAt) || Number(updatedAt) || now),
    meta && typeof meta === "object" ? JSON.stringify(meta) : ""
  );
  return id;
}

/** meta 白名单（凭据不走 meta 明文）：token/refreshToken 等凭据一律走独立加密列
 *  （token_enc/refresh_enc），msCookie 在写入前已过 encryptSecret 加密。
 *  这里剥离敏感形态的键（历史版本或外部同步可能带进明文凭据），正常业务键
 *  （lastError/checkin/onboardingGrants/domain/enterpriseId/provider/email 等）不受影响；
 *  值已是密文信封（enc:v1: 桌面 / enc:v2: headless）的键保留——落库方已加密，剥掉会把
 *  oauthClientSecret/msCookie 这类加密会话凭据一并清空，续期链随之断裂 */
const META_SENSITIVE_RE = /token|secret|password|apikey|api[-_]key|jwt|credential/i;
function stripSensitiveMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (META_SENSITIVE_RE.test(k)) {
      if (config.isEncrypted(v)) out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function updateAccount(id, patch) {
  open();
  const cur = getAccount(id);
  if (!cur) return false;
  const sets = [];
  const vals = [];
  const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
  // 用户编辑时钟与活动时钟分开：下面那行 put("updated_at") 是无条件的，每次额度刷新、每次
  // 代理请求扣减都会把 updated_at 推到当下。号池同步拿它仲裁 name/note ⇒ 只要对端跑过流量，
  // 本机这一次改名就永远判负（用户看到「改完名过一会儿自己变回去」）。所以把「本行 name
  // 何时被用户改的」单独记到 meta.renamedAt，由 poolsync 按它比。不加列，避免 schema 迁移。
  const editClock = {};
  if (patch.name != null) {
    const next = String(patch.name).slice(0, 64);
    put("name", next);
    // 同步采纳远端名时由调用方显式传 renamedAt（把本机时钟追平到远端那次编辑），
    // 其余情况只在名字**真的变了**时取当下：同名也推进的话两侧会互相追赶、每轮白写一次。
    if (patch.renamedAt != null) editClock.renamedAt = Number(patch.renamedAt) || 0;
    else if (next !== cur.name) editClock.renamedAt = Date.now();
  }
  if (patch.status != null) put("status", String(patch.status));
  // credits 允许 -1（企业版无限额度哨兵）；其余负值一律归 0。
  // 保留两位小数：Qoder 的 Credits 是浮点计量（实测 0.0066 级），取整会抹掉小额消耗；
  // 既有渠道传整数，不受影响（浮点列在 SQLite 中按 REAL 存）
  if (patch.credits != null) put("credits", Number(patch.credits) < -1 ? 0 : Math.round((Number(patch.credits) || 0) * 100) / 100);
  if (patch.creditsAt != null) put("credits_at", Number(patch.creditsAt) || 0);
  if (patch.expiresAt != null) put("expires_at", Math.max(0, Number(patch.expiresAt) || 0));
  if (patch.coolUntil != null) put("cool_until", Math.max(0, Number(patch.coolUntil) || 0));
  if (patch.coolReason != null) put("cool_reason", String(patch.coolReason));
  if (patch.lastUsed != null) put("last_used", Number(patch.lastUsed) || 0);
  if (patch.token != null) put("token_enc", config.encryptSecret(patch.token));
  if (patch.refreshToken != null) put("refresh_enc", config.encryptSecret(patch.refreshToken));
  // 凭据时钟（与上面改名时钟同一个道理，但要跨机持久比对，故落独立列）：
  // 加密信封带随机数，无法用密文比对，所以解出明文比；只有**值真的变了**才推进 token_at——
  // 每次额度刷新/冷却都会走 updateAccount，无条件推进的话「本机跑过流量」就能让坏凭据
  // 在号池同步的 LWW 里胜出，反向污染另一台健康机器。
  // 调用方显式传 tokenAt 时以传入为准（同步采纳远端凭据：把本机时钟追平到远端那次写入）。
  if (patch.tokenAt != null) put("token_at", Math.max(0, Number(patch.tokenAt) || 0));
  else if (patch.token != null || patch.refreshToken != null) {
    const nextTok = patch.token != null ? String(patch.token) : config.decryptSecret(cur.token_enc);
    const nextRef = patch.refreshToken != null ? String(patch.refreshToken) : config.decryptSecret(cur.refresh_enc);
    if (nextTok !== config.decryptSecret(cur.token_enc) || nextRef !== config.decryptSecret(cur.refresh_enc)) {
      put("token_at", Date.now());
    }
  }
  // meta 只写一次：调用方给的整份（上游既有调用方都是读-改-写来的）与上面补的编辑时钟合并。
  // 编辑时钟优先——它是本次写入的意图，不能被调用方手里的旧快照盖掉；patch.meta 缺省时
  // 以库里的 meta 为底，避免「只改名」把别人写过的 meta 清掉。
  // **空对象与缺省同义**（都表示「本次不改 meta」）：`{}` 是 truthy，原判据会让它整份替换，
  // 把库里的设备绑定元数据（machineId / deviceId / deviceMid / sid）与备注一并清空——
  // 表现是跨机同步后 Qoder 签名失败、小浣熊 200003 串号，而那正是这几列存在的意义。
  // 真想清空请显式写一个不含敏感键的对象（stripSensitiveMeta 负责过滤），别用空对象表达
  const metaIn = patch.meta && typeof patch.meta === "object" && Object.keys(patch.meta).length ? patch.meta : null;
  if (metaIn || Object.keys(editClock).length) {
    put("meta", JSON.stringify(stripSensitiveMeta({ ...(metaIn || parseMeta(cur.meta)), ...editClock })));
  }
  // 维护 updated_at：明确传入或当修改了重要字段时自动刷新
  const nextUpdatedAt = patch.updatedAt != null ? Number(patch.updatedAt) : Date.now();
  put("updated_at", nextUpdatedAt);
  if (!sets.length) return true;
  vals.push(cur.id);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

/** 记录账号最近一次上游错误（号池状态气泡展示用；只留最新一条，message 截 400 字）。
 *  渠道级拦截（11128/WAF）不冷却账号，这类错误只有落在这里才看得见。
 *  落库前过脱敏（redact.cjs）：上游报错回显的 Bearer/JWT 不进 meta 与日志页气泡 */
function noteError(id, message) {
  const msg = redact(String(message || "").trim());
  if (!id || !msg) return;
  open();
  const cur = getAccount(id);
  if (!cur) return;
  const meta = { ...parseMeta(cur.meta), lastError: { at: Date.now(), message: msg.slice(0, 400) } };
  updateAccount(id, { meta });
}

/** 清除账号最近错误（过码成功或手动恢复可用时调用） */
function clearError(id) {
  if (!id) return;
  open();
  const cur = getAccount(id);
  if (!cur) return;
  const meta = parseMeta(cur.meta);
  delete meta.lastError;
  updateAccount(id, { meta });
}

/** 设置账号备注（号池列表「备注」按钮）：落 meta.note（合并进现有 meta，不整包替换），
 *  随 exportPool 快照导出 + mergeSnapshot 备注新者胜传播到其他设备 */
function noteAccount(id, note) {
  if (!id) return false;
  open();
  const cur = getAccount(id);
  if (!cur) return false;
  const meta = { ...parseMeta(cur.meta) };
  const text = String(note || "").trim().slice(0, 200);
  // 内容没变就成功返回，不推进任何时钟：否则两侧拿同一个值互相追赶，每轮同步都白写一次
  // （与 updateAccount 的改名同口径）。
  if ((typeof meta.note === "string" ? meta.note : "") === text) return true;
  // 清除写空串并**保留键**：删键的话「删掉备注」这个动作同步不到对端（对端只认非空
  // remoteNote），结果是本机删掉了、别的机器永久残留旧备注。
  meta.note = text;
  // 备注的编辑时刻独立记一条：updated_at 会被额度刷新/请求扣减推着走，拿它比备注同样会输。
  meta.noteAt = Date.now();
  updateAccount(id, { meta });
  return true;
}

/** 记录账号今日签到结果（meta.checkin）：号池行内按钮「已签到 / 签到失败 + 详情弹窗」的数据源。
 *  只留当天最新一条（同日重跑即覆盖）；跨天不做清理，由前端按 day 判为过期 */
function noteCheckin(id, result, action) {
  if (!id) return;
  open();
  const cur = getAccount(id);
  if (!cur) return;
  const r = result || {};
  const meta = {
    ...parseMeta(cur.meta),
    checkin: {
      day: dayStr(),
      at: Date.now(),
      action: action === "trial" ? "trial" : "checkin",
      ok: r.ok === true,
      already: r.already === true,
      unavailable: r.unavailable === true,
      needCaptcha: r.needCaptcha === true,
      deviceBurned: r.deviceBurned === true,
      credit: Number(r.credit || 0) || 0,
      streakDays: Number(r.streakDays || 0) || 0,
      message: String(r.message || "").slice(0, 400),
    },
  };
  updateAccount(id, { meta });
}

/**
 * 记录小浣熊账号一次首登奖励（onboarding）的结算时刻（meta.onboardingGrants，key → 结算时刻）。
 * settled 只含本轮探测成功的增量（granted true/false 都算落定）；合并进已有台账，永不覆盖旧键。
 * 落了台账的 key 后续签到恒跳过（「后续不再领取」）；失败不落，下轮自然重试（「直到领取成功」）。
 */
function noteOnboardingGrant(id, settled) {
  if (!id || !settled || typeof settled !== "object") return;
  open();
  const cur = getAccount(id);
  if (!cur) return;
  const meta = { ...parseMeta(cur.meta) };
  const ledger = meta.onboardingGrants && typeof meta.onboardingGrants === "object" ? meta.onboardingGrants : {};
  meta.onboardingGrants = { ...ledger, ...settled };
  updateAccount(id, { meta });
}

// ===== 操作日志（op_logs：反代网关各项操作一条一条落库；写入永不抛错由 oplog.cjs 兜） =====

/** 记一条操作日志（字段截断防脏数据撑爆行；ts 用当前时刻） */
function insertOpLog(row) {
  open();
  db.prepare("INSERT INTO op_logs (ts, level, op, message, channel, target, detail) VALUES (?,?,?,?,?,?,?)").run(
    Date.now(),
    String(row.level || "info"),
    String(row.op || "").slice(0, 32),
    String(row.message || "").slice(0, 500),
    String(row.channel || "").slice(0, 32),
    String(row.target || "").slice(0, 120),
    String(row.detail || "").slice(0, 1000)
  );
}

/** 操作日志筛选（与列表同一套 where）：from/to 毫秒区间、level、op */
function opLogWhere(filter) {
  const where = [];
  const vals = [];
  if (Number(filter.from) > 0) { where.push("ts >= ?"); vals.push(Number(filter.from)); }
  if (Number(filter.to) > 0) { where.push("ts <= ?"); vals.push(Number(filter.to)); }
  if (filter.level) { where.push("level = ?"); vals.push(String(filter.level)); }
  if (filter.op) { where.push("op = ?"); vals.push(String(filter.op)); }
  return { clause: where.length ? ` WHERE ${where.join(" AND ")}` : "", vals };
}

/** 分页列表（时间倒序；limit 1~200 封顶） */
function listOpLogs(filter) {
  open();
  const { clause, vals } = opLogWhere(filter || {});
  const total = db.prepare(`SELECT COUNT(*) AS n FROM op_logs${clause}`).get(...vals).n;
  const rows = db.prepare(`SELECT * FROM op_logs${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(
    ...vals,
    Math.max(1, Math.min(200, Number(filter.limit) || 50)),
    Math.max(0, Number(filter.offset) || 0)
  );
  return { rows, total };
}

/** 操作类型下拉（去重后按字母序；空表返回空数组） */
function listOpLogOps() {
  open();
  return db.prepare("SELECT DISTINCT op FROM op_logs ORDER BY op").all().map((r) => r.op).filter(Boolean);
}

/** 导出全集（与列表同一套筛选，无分页；2 万行上限防一次性拉爆） */
function exportOpLogRows(filter) {
  open();
  const { clause, vals } = opLogWhere(filter || {});
  return db.prepare(`SELECT * FROM op_logs${clause} ORDER BY ts DESC, id DESC LIMIT 20000`).all(...vals);
}

/** 记录账号一次消耗的滚动计数（跨天自动清零） */
function bumpAccountUsage(id, tokens) {
  open();
  const cur = getAccount(id);
  if (!cur) return;
  const today = dayStr();
  const sameDay = cur.today_day === today;
  db.prepare("UPDATE accounts SET today_day=?, today_req=?, today_tokens=?, last_used=? WHERE id=?").run(
    today,
    sameDay ? cur.today_req + 1 : 1,
    sameDay ? cur.today_tokens + (tokens || 0) : (tokens || 0),
    Date.now(),
    id
  );
}

function removeAccount(id) {
  open();
  db.prepare("DELETE FROM credits_history WHERE account_id = ?").run(String(id));
  db.prepare("DELETE FROM model_cooldowns WHERE acc_id = ?").run(String(id));
  db.prepare("DELETE FROM credit_packages WHERE account_id = ?").run(String(id));
  return db.prepare("DELETE FROM accounts WHERE id = ?").run(String(id)).changes > 0;
}

// ===== 余额日快照（趋势图数据源） =====

function snapshotCredits(channel, accountId, credits, expiresAt) {
  open();
  db.prepare(
    `INSERT INTO credits_history (channel, account_id, day, credits, expires_at) VALUES (?,?,?,?,?)
     ON CONFLICT(channel, account_id, day) DO UPDATE SET credits=excluded.credits, expires_at=excluded.expires_at`
    // 两位小数口径与 updateAccount 一致（Qoder 浮点 Credits；整数渠道不受影响）
  ).run(String(channel), String(accountId), dayStr(), Math.max(0, Math.round((Number(credits) || 0) * 100) / 100), Math.max(0, Number(expiresAt) || 0));
}

// ===== 积分包明细（按账号整体替换的包集：到期总览与账号级额度的单一事实源） =====

/** 归一单个包对象为落库行：字段宽容、-1 保留为「不限」哨兵、负值归 0 */
function normPackageRow(p, i) {
  const n = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return 0;
    return x < -1 ? 0 : Math.round(x);
  };
  return {
    code: String((p && p.code) || "").slice(0, 128),
    name: String((p && p.name) || "").slice(0, 128),
    total: n(p && p.total),
    used: n(p && p.used),
    remaining: n(p && p.remaining),
    expiresAt: Math.max(0, Number(p && p.expiresAt) || 0),
    ord: Number.isFinite(Number(p && p.ord)) ? Math.round(Number(p.ord)) : i,
  };
}

/** 整体替换某账号的包集（DELETE + 批量 INSERT，一个事务内原子完成）。
 *  传空数组 = 清空该账号包集。刷新链路与号池同步合并都走这一个入口，语义唯一。 */
function setCreditPackages(accountId, channel, packages) {
  open();
  const id = String(accountId || "");
  if (!id) return;
  const list = Array.isArray(packages) ? packages : [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM credit_packages WHERE account_id = ?").run(id);
    const ins = db.prepare(
      `INSERT INTO credit_packages (account_id, channel, code, name, total, used, remaining, expires_at, ord)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    list.forEach((p, i) => {
      const r = normPackageRow(p, i);
      ins.run(id, String(channel || ""), r.code, r.name, r.total, r.used, r.remaining, r.expiresAt, r.ord);
    });
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}

/** credit_packages 行 → 对外包对象（列名 snake_case 收敛在这里，别让每个调用方各翻一遍） */
function packageView(r) {
  return { code: r.code, name: r.name, total: r.total, used: r.used, remaining: r.remaining, expiresAt: r.expires_at };
}

/** 列出某账号的包集（按 ord 升序；展示/派生/导出共用）。
 *  expired/expiringSoon 是时间派生量，不落库，出视图时现算。 */
function listCreditPackages(accountId) {
  open();
  const rows = db.prepare("SELECT * FROM credit_packages WHERE account_id = ? ORDER BY ord, rowid").all(String(accountId || ""));
  return rows.map(packageView);
}

/**
 * 全池逐包：一次查出所有账号的包并按 accountId 分桶（号池视图用）。
 * 不给每账号一次 listCreditPackages()——那是 200 账号 17ms 的 N+1；
 * 本文件 listKeys() 统计每把 Key 的今日用量走的也是「一次全量 + Map join」同一形态。
 * 只按 ord,rowid 排序：分桶后各桶内部天然有序，跨账号的相对顺序没人看（变异验证过，加 account_id 不承重）。
 */
function listAllCreditPackages() {
  open();
  const rows = db.prepare("SELECT * FROM credit_packages ORDER BY ord, rowid").all();
  const byAccount = new Map();
  for (const r of rows) {
    const list = byAccount.get(r.account_id);
    if (list) list.push(packageView(r));
    else byAccount.set(r.account_id, [packageView(r)]);
  }
  return byAccount;
}

// ===== 请求流水与统计 =====

function insertUsage(row) {
  open();
  db.prepare(
    `INSERT INTO usage_requests (ts, req_id, key_id, key_name, channel, account_id, account_name, model, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens, ttft_ms, latency_ms, status, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.ts || Date.now(),
    row.reqId || "",
    row.keyId || "",
    row.keyName || "",
    row.channel || "",
    row.accountId || "",
    row.accountName || "",
    row.model || "",
    row.promptTokens || 0,
    row.completionTokens || 0,
    row.cacheReadTokens || 0,
    row.cacheCreationTokens || 0,
    row.ttftMs || 0,
    row.latencyMs || 0,
    row.status || 0,
    String(row.error || "").slice(0, 300)
  );
}

/** 总览指标：今日请求/token/成功率/TTFT 均值 */
function statsToday() {
  open();
  const r = db.prepare(
    `SELECT COUNT(*) AS req, SUM(prompt_tokens + completion_tokens) AS tokens,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
            AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms END) AS ttft
     FROM usage_requests WHERE ts >= ?`
  ).get(dayStartMs());
  return {
    req: r.req || 0,
    tokens: r.tokens || 0,
    successRate: r.req ? Math.round(((r.ok || 0) / r.req) * 1000) / 10 : 100,
    ttftAvg: Math.round(r.ttft || 0),
  };
}

/** 近 N 日趋势（按天聚合请求/token，SQL 下推聚合防 OOM） */
function statsTrend(days) {
  open();
  const n = Math.min(90, Math.max(1, days || 7));
  const from = dayStartMs() - (n - 1) * 86400000;
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
            COUNT(*) AS req,
            SUM(prompt_tokens + completion_tokens) AS tokens
     FROM usage_requests
     WHERE ts >= ?
     GROUP BY day`
  ).all(from);
  const buckets = new Map();
  for (let i = 0; i < n; i++) buckets.set(dayStr(from + i * 86400000), { req: 0, tokens: 0 });
  for (const r of rows) {
    if (r && r.day && buckets.has(r.day)) {
      buckets.set(r.day, { req: Number(r.req) || 0, tokens: Number(r.tokens) || 0 });
    }
  }
  return [...buckets.entries()].map(([day, v]) => ({ day, req: v.req, tokens: v.tokens }));
}

/** TOP 排行：按 channel / model / key / account 分组（近 N 日）。
 *  与 statsTopRich 同口径：key/account 按 id 分组——名字可改，按名分组会把改名前后的流水
 *  拆成两行，用量数值被拆散；名字透出时映射当前名。返回值形状 {name, req, tokens} 保持不变
 *  （容器形态的只读 RPC 直接吃它） */
function statsTop(dim, days) {
  open();
  const g = TOP_GROUP[dim] || TOP_GROUP.channel;
  const from = dayStartMs() - (Math.min(90, Math.max(1, days || 7)) - 1) * 86400000;
  const rows = db.prepare(
    `SELECT ${g.col} AS gid, MAX(ts) AS last_ts, ${g.nameCol || g.col} AS name,
            COUNT(*) AS req, SUM(prompt_tokens + completion_tokens) AS tokens
     FROM usage_requests WHERE ts >= ? AND ${g.col} != ''
     GROUP BY ${g.col} ORDER BY req DESC LIMIT 10`
  ).all(from);
  const names = dimNameMap(g);
  return rows.map((r) => ({ name: (names && names.get(r.gid)) || r.name || "", req: r.req, tokens: r.tokens }));
}

// ===== 用量统计增强：区间化聚合（方案《反代网关-用量统计增强方案.md》§5） =====
// 口径统一：from/to 为毫秒闭区间；全部 SELECT ... GROUP BY 直查，不建冗余表。
// 注意 tokens 只算 prompt + completion：缓存读/写是 prompt 的子集（见 server.cjs 记账口径，
// Anthropic 的 cache_read/creation 已合计进 prompt_tokens），再加一遍会重复计数。

const DAY_MS = 86400000;
const MAX_RANGE_DAYS = 366;

/** 区间归一：缺省 / 颠倒 / 超长都在这里收口，调用方不必各自判 */
function normRange(from, to) {
  const now = Date.now();
  let f = Number(from);
  let t = Number(to);
  if (!Number.isFinite(t) || t <= 0) t = now;
  if (!Number.isFinite(f) || f <= 0) f = t - 7 * DAY_MS;
  if (t < f) { const tmp = f; f = t; t = tmp; }
  if (t - f > MAX_RANGE_DAYS * DAY_MS) f = t - MAX_RANGE_DAYS * DAY_MS;
  return { from: Math.round(f), to: Math.round(t) };
}

/** 粒度决策：auto 时跨度 ≤ 2 天走小时，否则走天；显式要小时但跨度 > 7 天时回落按天（防桶爆炸） */
function pickGranularity(from, to, g) {
  const span = to - from;
  if (g === "day") return "day";
  if (g === "hour") return span <= 7 * DAY_MS ? "hour" : "day";
  return span <= 2 * DAY_MS ? "hour" : "day";
}

function hourStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`;
}

/** 聚合列模板：所有分组/汇总查询共用，避免各处手抄漏列 */
const AGG_COLS = `
  COUNT(*) AS req,
  SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
  SUM(prompt_tokens) AS prompt_tokens,
  SUM(completion_tokens) AS completion_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens,
  AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms END) AS ttft,
  AVG(CASE WHEN latency_ms > 0 THEN latency_ms END) AS latency`;

/** 聚合行 → 前端字段（SUM/AVG 的原始列摊平，空区间回全 0 而不是 null） */
function shapeAgg(r) {
  const req = Number(r && r.req) || 0;
  const ok = Number(r && r.ok) || 0;
  const p = Number(r && r.prompt_tokens) || 0;
  const c = Number(r && r.completion_tokens) || 0;
  return {
    req, ok, err: req - ok,
    successRate: req ? Math.round((ok / req) * 1000) / 10 : 0,
    promptTokens: p,
    completionTokens: c,
    cacheReadTokens: Number(r && r.cache_read_tokens) || 0,
    cacheCreationTokens: Number(r && r.cache_creation_tokens) || 0,
    tokens: p + c,
    ttftAvg: Math.round(Number(r && r.ttft) || 0),
    latencyAvg: Math.round(Number(r && r.latency) || 0),
  };
}

/** TTFT 中位数：SQLite 无 percentile，按「先数总数、再 OFFSET 取中位那一行」两步取 */
function statsTtftP50(from, to) {
  const c = db.prepare("SELECT COUNT(*) AS c FROM usage_requests WHERE ts >= ? AND ts <= ? AND ttft_ms > 0").get(from, to).c || 0;
  if (!c) return 0;
  const row = db.prepare(
    "SELECT ttft_ms AS v FROM usage_requests WHERE ts >= ? AND ts <= ? AND ttft_ms > 0 ORDER BY ttft_ms LIMIT 1 OFFSET ?"
  ).get(from, to, Math.floor((c - 1) / 2));
  return Math.round((row && row.v) || 0);
}

/** 区间 KPI：请求 / 成功 / 四类 token / 平均与 P50 TTFT / 平均耗时 / 覆盖的去重维度数 */
function statsSummary(from, to) {
  open();
  const r = db.prepare(
    `SELECT ${AGG_COLS},
            COUNT(DISTINCT NULLIF(channel, '')) AS channels,
            COUNT(DISTINCT NULLIF(model, '')) AS models,
            COUNT(DISTINCT NULLIF(key_id, '')) AS keys,
            COUNT(DISTINCT NULLIF(account_id, '')) AS accounts
     FROM usage_requests WHERE ts >= ? AND ts <= ?`
  ).get(from, to);
  const s = shapeAgg(r);
  return {
    req: s.req, ok: s.ok, err: s.err,
    // 空区间成功率给 100（没有失败请求），与旧 statsToday 的兜底口径一致
    successRate: s.req ? s.successRate : 100,
    promptTokens: s.promptTokens, completionTokens: s.completionTokens,
    cacheReadTokens: s.cacheReadTokens, cacheCreationTokens: s.cacheCreationTokens,
    totalTokens: s.tokens,
    ttftAvg: s.ttftAvg, ttftP50: statsTtftP50(from, to), latencyAvg: s.latencyAvg,
    channels: Number(r.channels) || 0, models: Number(r.models) || 0,
    keys: Number(r.keys) || 0, accounts: Number(r.accounts) || 0,
  };
}

/** 时间序列：按天 / 按小时聚合，缺桶补零（图表 x 轴连续，最右为区间终点） */
function statsSeries(from, to, granularity) {
  open();
  const fmt = granularity === "hour" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
  const rows = db.prepare(
    `SELECT strftime('${fmt}', ts / 1000, 'unixepoch', 'localtime') AS k, ${AGG_COLS}
     FROM usage_requests WHERE ts >= ? AND ts <= ?
     GROUP BY k`
  ).all(from, to);
  const map = new Map();
  for (const r of rows) if (r && r.k) map.set(r.k, r);
  const out = [];
  if (granularity === "hour") {
    const start = new Date(from);
    start.setMinutes(0, 0, 0);
    for (let t = start.getTime(); t <= to; t += 3600000) {
      const k = hourStr(t);
      out.push({ t, label: k, ...shapeAgg(map.get(k)) });
    }
  } else {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= to; t += DAY_MS) {
      const k = dayStr(t);
      out.push({ t, label: k, ...shapeAgg(map.get(k)) });
    }
  }
  return out;
}

/** TOP 排行的分组列：channel / model 本身就是身份，按值分组；
 *  key / account 的名字可改（改名前后的流水若按名分组会分裂成两行），按 id 分组、
 *  名字透出时映射当前名（Key/账号已删则回退「最后一次请求时」的快照名——
 *  裸列随唯一聚合 MAX(ts) 所在行取值，是 SQLite 的文档化行为） */
const TOP_GROUP = {
  channel: {col: "channel"},
  model: {col: "model"},
  key: {col: "key_id", nameCol: "key_name"},
  account: {col: "account_id", nameCol: "account_name"},
};

/** 维度的名字映射表：key / account 需要「当前名优先」（实体已删就查不到 → 调用方回退快照名）；
 *  channel / model 的 name 就是分组值本身，不需要映射 */
function dimNameMap(g) {
  if (g.nameCol === "key_name") return currentKeyNames();
  if (g.nameCol === "account_name") return currentAccountNames();
  return null;
}

/** TOP 排行（富字段）：按 dim 分组，请求数倒序取前 N（前端本地切排序口径再截前 10） */
function statsTopRich(dim, from, to, limit) {
  open();
  const g = TOP_GROUP[dim] || TOP_GROUP.channel;
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = db.prepare(
    `SELECT ${g.col} AS gid, MAX(ts) AS last_ts, ${g.nameCol || g.col} AS name, ${AGG_COLS}
     FROM usage_requests
     WHERE ts >= ?
       AND ts <= ?
       AND ${g.col} != ''
     GROUP BY ${g.col}
     ORDER BY req DESC LIMIT ?`
  ).all(from, to, n);
  const names = dimNameMap(g);
  return rows.map((r) => ({id: r.gid, name: (names && names.get(r.gid)) || r.name || "", ...shapeAgg(r)}));
}

/** 各 Key 用量：按 key_id 分组（Key 名可改，id 才是身份），带最近使用时间。
 *  Key 名透出以当前名优先（Key 已删/未命名回退最后一次请求时的快照名） */
function statsKeys(from, to) {
  open();
  const rows = db.prepare(
    `SELECT key_id, MAX(ts) AS last_ts, key_name AS name, ${AGG_COLS}
     FROM usage_requests WHERE ts >= ? AND ts <= ? AND key_id != ''
     GROUP BY key_id ORDER BY req DESC LIMIT 100`
  ).all(from, to);
  const keyNames = currentKeyNames();
  return rows.map((r) => ({
    keyId: r.key_id,
    id: r.key_id,
    name: keyNames.get(r.key_id) || r.name || "",
    lastTs: Number(r.last_ts) || 0, ...shapeAgg(r)
  }));
}

/** 全部 Key 的 id + 当前名（含区间内没用的），供明细筛选下拉选人。
 *  刻意不走 listKeys()：那个要做当日用量聚合、还要解密 secret，建下拉选项用不着 */
function statsKeyOptions() {
  open();
  return db.prepare("SELECT id, name FROM keys ORDER BY name, created_at").all()
    .map((r) => ({ id: r.id, name: r.name || "" }));
}

/** 状态码分桶：2xx / 4xx / 5xx / 无响应（status=0 或 3xx 等归「无响应」桶） */
function statsStatus(from, to) {
  open();
  const rows = db.prepare(
    `SELECT CASE
              WHEN status >= 200 AND status < 300 THEN 'ok'
              WHEN status >= 400 AND status < 500 THEN '4xx'
              WHEN status >= 500 THEN '5xx'
              ELSE 'other' END AS b,
            COUNT(*) AS c
     FROM usage_requests WHERE ts >= ? AND ts <= ? GROUP BY b`
  ).all(from, to);
  const m = { ok: 0, "4xx": 0, "5xx": 0, other: 0 };
  for (const r of rows) if (r && Object.prototype.hasOwnProperty.call(m, r.b)) m[r.b] = Number(r.c) || 0;
  return [
    { name: "成功 2xx", key: "ok", value: m.ok },
    { name: "客户端 4xx", key: "4xx", value: m["4xx"] },
    { name: "服务端 5xx", key: "5xx", value: m["5xx"] },
    { name: "无响应", key: "other", value: m.other },
  ];
}

/** Token 构成：输入 / 输出两个互斥分量（合计 = totalTokens，可直接画环形图） */
function statsTokenMix(from, to) {
  open();
  const r = db.prepare(
    "SELECT SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c FROM usage_requests WHERE ts >= ? AND ts <= ?"
  ).get(from, to);
  return [
    { name: "输入 Token", key: "prompt", value: Number(r.p) || 0 },
    { name: "输出 Token", key: "completion", value: Number(r.c) || 0 },
  ];
}

/** LIKE 参数转义：用户输入里的 \ % _ 必须当字面量，否则搜一个 "%" 会命中全表 */
function likeArg(s) {
  return "%" + String(s).replace(/[\\%_]/g, (m) => "\\" + m) + "%";
}

/** 状态分桶 → SQL 片段（与 statsStatus 的分桶口径保持一致） */
function statusWhere(status) {
  if (status === "ok") return "status >= 200 AND status < 300";
  if (status === "4xx") return "status >= 400 AND status < 500";
  if (status === "5xx") return "status >= 500";
  if (status === "other") return "(status < 200 OR (status >= 300 AND status < 400))";
  return "";
}

/** 统计总览：一次返回 KPI / 序列 / 四维排行 / 各 Key / 状态分布 / Token 构成。
 *  四维排行一次给全，前端切维度零延迟、少 3 次 IPC。 */
function statsOverview(opts) {
  const o = opts || {};
  const { from, to } = normRange(o.from, o.to);
  const granularity = pickGranularity(from, to, o.granularity);
  return {
    range: { from, to, granularity },
    summary: statsSummary(from, to),
    series: statsSeries(from, to, granularity),
    tops: {
      channel: statsTopRich("channel", from, to),
      model: statsTopRich("model", from, to),
      key: statsTopRich("key", from, to),
      account: statsTopRich("account", from, to),
    },
    keys: statsKeys(from, to),
    // 明细筛选下拉要「全部 Key」，不是区间内用量前 100 把：keys 表才是实体的唯一事实源，
    // 而且它带当前名（与上面 keys 行的名字映射同口径）。只取 id + name，不解密 secret
    allKeys: statsKeyOptions(),
    status: statsStatus(from, to),
    tokenMix: statsTokenMix(from, to),
  };
}

/** 明细分页：区间 + 渠道/状态精确 + Key/模型模糊搜索；同时回筛选命中的 token 汇总。
 *  区间缺省 = 不限（保留期自测等旧调用方按「全表」用；统计页总是显式传 from/to）。 */
function statsDetail(opts) {
  open();
  const o = opts || {};
  const size = Math.min(100, Math.max(5, o.pageSize || 20));
  const p = Math.max(1, o.page || 1);
  const where = [];
  const vals = [];
  const from = Number(o.from);
  const to = Number(o.to);
  if (Number.isFinite(from) && from > 0) { where.push("ts >= ?"); vals.push(Math.round(from)); }
  if (Number.isFinite(to) && to > 0) { where.push("ts <= ?"); vals.push(Math.round(to)); }
  if (o.channel) { where.push("channel = ?"); vals.push(o.channel); }
  if (o.keyId) { where.push("key_id = ?"); vals.push(o.keyId); }
  if (o.key) { where.push("(key_name LIKE ? ESCAPE '\\' OR key_id LIKE ? ESCAPE '\\')"); vals.push(likeArg(o.key), likeArg(o.key)); }
  if (o.model) { where.push("model LIKE ? ESCAPE '\\'"); vals.push(likeArg(o.model)); }
  const sw = statusWhere(o.status);
  if (sw) where.push(sw);
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM usage_requests ${w}`).get(...vals).c;
  const agg = shapeAgg(db.prepare(`SELECT ${AGG_COLS} FROM usage_requests ${w}`).get(...vals));
  const rows = db.prepare(
    `SELECT * FROM usage_requests ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...vals, size, (p - 1) * size);
  const accNames = currentAccountNames();
  const keyNames = currentKeyNames();
  return {
    total, page: p, pageSize: size,
    agg: {
      req: agg.req, promptTokens: agg.promptTokens, completionTokens: agg.completionTokens,
      cacheReadTokens: agg.cacheReadTokens, cacheCreationTokens: agg.cacheCreationTokens, tokens: agg.tokens,
    },
    rows: rows.map((r) => usageView(r, accNames, keyNames)),
  };
}

/** 手动清理流水：删保留线之前的记录，返回删除条数（设置页保留期与统计页「清理」按钮共用）。
 *  all=true 时清空整表（忽略保留线）。注意：删完文件不会立刻变小——SQLite 只是把页标成空闲复用，
 *  真要还磁盘得 VACUUM，而那会长时间持写锁，这里刻意不做。 */
function cleanupUsage(days, all) {
  open();
  if (all) {
    const r = db.prepare("DELETE FROM usage_requests").run();
    return { deleted: r.changes, cutoff: 0 };
  }
  const raw = Number(days);
  // 传进来的是垃圾时按默认 90 天，不按 1 天：这条路径删的是不可恢复的历史，宁可少删不能多删。
  // （调用方是 index.cjs 的 IPC 处理器，已经先用设置值兜过一层，这里是第二道闸）
  const n = Math.min(3650, Math.max(1, Math.round(Number.isFinite(raw) && raw > 0 ? raw : 90)));
  const cutoff = Date.now() - n * 86400000;
  const r = db.prepare("DELETE FROM usage_requests WHERE ts < ?").run(cutoff);
  return { deleted: r.changes, cutoff };
}

function recentRequests(limit) {
  open();
  const rows = db.prepare("SELECT * FROM usage_requests ORDER BY ts DESC LIMIT ?").all(Math.min(50, limit || 10));
  const accNames = currentAccountNames();
  const keyNames = currentKeyNames();
  return rows.map((r) => usageView(r, accNames, keyNames));
}

function usageView(r, accNames, keyNames) {
  return {
    id: r.id, ts: r.ts, reqId: r.req_id, keyId: r.key_id,
    // key_name 同 account_name：流水快照，Key 重命名后旧流水仍是老名字，
    // 透出时当前名优先（Key 已删/未命名回退快照）——与各 Key 用量表的展示口径一致
    keyName: (keyNames && keyNames.get(r.key_id)) || r.key_name,
    channel: r.channel, accountId: r.account_id,
    // 流水里的 account_name 是落库快照：号池重命名后旧流水仍存着老名字。
    // 透出时以当前账号名优先（账号已删/未命名则回退快照），明细与最近请求口径一致
    accountName: (accNames && accNames.get(r.account_id)) || r.account_name,
    model: r.model,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    cacheReadTokens: r.cache_read_tokens || 0, cacheCreationTokens: r.cache_creation_tokens || 0,
    ttftMs: r.ttft_ms, latencyMs: r.latency_ms, status: r.status, error: r.error,
  };
}

/** 账号 id → 当前名 的一次性映射（每页构建一次，账号量级几十，代价可忽略）。
 *  刻意不回填流水表：历史流水保留「请求发生时」的原始记录。 */
function currentAccountNames() {
  const m = new Map();
  for (const r of db.prepare("SELECT id, name FROM accounts").all()) m.set(r.id, r.name);
  return m;
}

/** Key id → 当前名 的一次性映射：直接查 keys 表两列（不走 listKeys——那会做当日用量
 *  聚合还解密 secret，建名字映射用不着）。与账号映射同一套「当前名优先、快照兜底」口径 */
function currentKeyNames() {
  const m = new Map();
  for (const r of db.prepare("SELECT id, name FROM keys").all()) m.set(r.id, r.name);
  return m;
}

/** 关闭数据库句柄（应用退出/热重启时调用；重复调用安全） */
function close() {
  if (db) {
    try { db.close(); } catch { /* 已关 */ }
    db = null;
  }
}

/** 模型级冷却负缓存（账号×模型，pool.cjs 写穿）：6004 墙钟可达数小时、11102 封顶 24h，
    重启丢失会导致重新白撞一次上游 429，故落库；model 统一存小写（与内存 key 同口径） */
function listModelCooldowns() {
  open();
  db.prepare("DELETE FROM model_cooldowns WHERE until <= ?").run(Date.now()); // 顺手清理过期行
  return db.prepare("SELECT acc_id AS accId, model, until, reason FROM model_cooldowns").all();
}

function upsertModelCooldown(accId, model, until, reason) {
  open();
  db.prepare(
    "INSERT INTO model_cooldowns (acc_id, model, until, reason) VALUES (?,?,?,?) ON CONFLICT(acc_id, model) DO UPDATE SET until = excluded.until, reason = excluded.reason"
  ).run(String(accId), String(model).toLowerCase(), Math.max(0, Number(until) || 0), String(reason || "").slice(0, 200));
}

function deleteModelCooldowns(accId, model) {
  open();
  if (model) db.prepare("DELETE FROM model_cooldowns WHERE acc_id = ? AND model = ?").run(String(accId), String(model).toLowerCase());
  else db.prepare("DELETE FROM model_cooldowns WHERE acc_id = ?").run(String(accId));
}

/** 一致性快照导出：VACUUM INTO 生成单文件干净库（含 WAL 里未 checkpoint 的事务）。
 *  在线备份用——直接拷 stats.db 会丢掉 WAL 中的最近写入 */
function vacuumInto(target) {
  open();
  db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
}

module.exports = {
  vacuumInto,
  open, close, proxyDir, dayStr, dayStartMs,
  driver: () => driver,
  CHANNELS,
  QODER_INTL_ENABLED,
  AUTOCLAW_INTL_ENABLED,
  isBuiltinChannel,
  channelList, invalidateChannels,
  channelDisplay,
  listProviders, getProvider, saveProvider, deleteProvider, accountRows,
  createKey, importKey, listKeys, findKeyBySecret, updateKey, deleteKey, keyTodayReq,
  validateKeyParams,
  listAgents, setPoolStrategy, setAgentCostTier,
  listAccounts, getAccount, accountSecrets, addAccount, updateAccount, bumpAccountUsage, removeAccount, noteError, clearError, noteCheckin, noteOnboardingGrant, noteAccount,
  setCreditPackages, listCreditPackages, listAllCreditPackages,
  insertOpLog, listOpLogs, listOpLogOps, exportOpLogRows,
  listModelCooldowns, upsertModelCooldown, deleteModelCooldowns,
  snapshotCredits,
  insertUsage, statsToday, statsTrend, statsTop, statsDetail, recentRequests,
  normRange, pickGranularity, statsOverview, statsSummary, statsSeries, statsTopRich,
  statsKeys, statsStatus, statsTokenMix,
  cleanupUsage, setUsageRetention,
};
