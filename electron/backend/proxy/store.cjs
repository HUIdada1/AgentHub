// 反代网关 · 存储层：SQLite（WAL）+ DPAPI 加密凭据
// 表结构对齐方案 §5.1：keys / agents / accounts / credits_history / usage_requests
// 驱动优先 better-sqlite3（方案选型），ABI 不匹配等加载失败时回退 Node 22 内置 node:sqlite（接口对齐）
// 凭据（token/refreshToken）不落明文：复用 config.cjs 的 safeStorage(DPAPI) enc:v1: 信封，等效方案 vault.bin
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("../config.cjs");

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
  updated_at INTEGER NOT NULL DEFAULT 0
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
`;

/**
 * 渠道注册表（UI 列表 / 健康检查 / 池同步校验 / key 路由校验的单一事实源）。
 * Qoder 双区：CN 与 INTL 各自独立接入（账号与额度池互不相通）。
 * INTL 免费额度不含 DeepSeek-Flash / GLM-5.3-Flash 等（需充值/额度覆盖才有可用模型），
 * 界面提示已注明；其签名器依赖本机安装的国际版客户端。
 */
const QODER_INTL_ENABLED = true;

const CHANNELS = [
  { id: "trae", display: "Trae SOLO CN", domain: "api.trae.cn" },
  { id: "workbuddy", display: "WorkBuddy CN", domain: "copilot.tencent.com" },
  { id: "workbuddy_ai", display: "WorkBuddy AI", domain: "www.workbuddy.ai" },
  { id: "raccoon", display: "商汤小浣熊", domain: "xiaohuanxiong.com" },
  { id: "zcode", display: "ZCode（智谱）", domain: "zcode.z.ai" },
  // Qoder CN：账号与额度池与 INTL 互不相通，各自独立接入。
  // 注意：该渠道签名依赖本机安装的客户端（wasm 提取），凭据可导入但未装客户端时不可调用。
  { id: "qoder", display: "Qoder CN", domain: "gateway.qoder.com.cn" },
  ...(QODER_INTL_ENABLED ? [{ id: "qoder_intl", display: "Qoder International", domain: "api2.qoder.sh" }] : []),
];

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
  // 在线迁移：keys.key_enc（完整 Key 的 DPAPI 加密信封，供列表随时查看 / 复制）
  try {
    db.exec("ALTER TABLE keys ADD COLUMN key_enc TEXT NOT NULL DEFAULT ''");
  } catch { /* 已存在 */ }
  // 在线迁移：usage_requests 缓存 token（命中率统计；Anthropic 协议上游如 zcode 会回 cache_read/creation）
  try {
    db.exec("ALTER TABLE usage_requests ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  try {
    db.exec("ALTER TABLE usage_requests ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
  } catch { /* 已存在 */ }
  const ins = db.prepare("INSERT OR IGNORE INTO agents (id, display, domain, pool_strategy, updated_at) VALUES (?,?,?,?,?)");
  const updDisplay = db.prepare("UPDATE agents SET display = ? WHERE id = ?");
  for (const c of CHANNELS) {
    ins.run(c.id, c.display, c.domain, "expire_first", Date.now());
    updDisplay.run(c.display, c.id);
  }
  gc();
  return db;
}

/** 流水保留 90 天，启动时 GC；余额历史同步清理 */
function gc() {
  const cutoff = Date.now() - 90 * 86400000;
  db.prepare("DELETE FROM usage_requests WHERE ts < ?").run(cutoff);
  const dayCut = dayStr(cutoff);
  db.prepare("DELETE FROM credits_history WHERE day < ?").run(dayCut);
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

function createKey({ name, route, dailyQuota, rateLimit }) {
  open();
  const secret = "sk-" + crypto.randomBytes(24).toString("hex"); // 48 hex
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO keys (id, name, key_hash, key_enc, key_prefix, key_suffix, route, daily_quota, rate_limit, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)"
  ).run(
    id,
    String(name || "").slice(0, 64) || "未命名 Key",
    hashKey(secret),
    config.encryptSecret(secret),
    secret.slice(0, 7),
    secret.slice(-4),
    routeOk(route) ? route : "auto",
    Math.max(0, Number(dailyQuota) || 0),
    Math.max(0, Number(rateLimit) || 0),
    Date.now()
  );
  return { id, secret };
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
    dailyQuota: r.daily_quota,
    rateLimit: r.rate_limit,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    todayReq: (umap.get(r.id) || {}).req || 0,
    todayTokens: (umap.get(r.id) || {}).tokens || 0,
  }));
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
    id: r.id, name: r.name, route: r.route, dailyQuota: r.daily_quota,
    rateLimit: r.rate_limit, enabled: !!r.enabled,
  };
}

function updateKey(id, patch) {
  open();
  const cur = db.prepare("SELECT * FROM keys WHERE id = ?").get(String(id));
  if (!cur) return false;
  const name = patch.name != null ? String(patch.name).slice(0, 64) : cur.name;
  const route = patch.route != null && routeOk(patch.route) ? patch.route : cur.route;
  const quota = patch.dailyQuota != null ? Math.max(0, Number(patch.dailyQuota) || 0) : cur.daily_quota;
  const rate = patch.rateLimit != null ? Math.max(0, Number(patch.rateLimit) || 0) : cur.rate_limit;
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled;
  db.prepare("UPDATE keys SET name=?, route=?, daily_quota=?, rate_limit=?, enabled=? WHERE id=?")
    .run(name, route, quota, rate, enabled, cur.id);
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
  }));
}

function setPoolStrategy(channel, strategy) {
  open();
  if (!["expire_first", "credit_first", "round_robin"].includes(strategy)) return false;
  db.prepare("UPDATE agents SET pool_strategy=?, updated_at=? WHERE id=?").run(strategy, Date.now(), String(channel));
  return true;
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
    source: r.source,
    lastUsed: r.last_used,
    todayReq: r.today_day === dayStr() ? r.today_req : 0,
    todayTokens: r.today_day === dayStr() ? r.today_tokens : 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at || Math.max(r.credits_at || 0, r.last_used || 0, r.created_at || 0),
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

function getAccount(id) {
  open();
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(String(id));
  return r || null;
}

/** 取解密后的凭据（仅主进程内部使用，绝不外传渲染层） */
function accountSecrets(r) {
  return {
    token: config.decryptSecret(r.token_enc),
    refreshToken: config.decryptSecret(r.refresh_enc),
  };
}

function addAccount({ channel, uid, name, token, refreshToken, source, expiresAt, meta, updatedAt }) {
  open();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, channel, uid, name, token_enc, refresh_enc, status, credits, credits_at, expires_at, cool_until, source, last_used, today_day, today_req, today_tokens, created_at, updated_at, meta)
     VALUES (?,?,?,?,?,?, 'online', 0, 0, ?, 0, ?, 0, ?, 0, 0, ?, ?, ?)`
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
    meta && typeof meta === "object" ? JSON.stringify(meta) : ""
  );
  return id;
}

function updateAccount(id, patch) {
  open();
  const cur = getAccount(id);
  if (!cur) return false;
  const sets = [];
  const vals = [];
  const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
  if (patch.name != null) put("name", String(patch.name).slice(0, 64));
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
  if (patch.meta != null && typeof patch.meta === "object") put("meta", JSON.stringify(patch.meta));
  // 维护 updated_at：明确传入或当修改了重要字段时自动刷新
  const nextUpdatedAt = patch.updatedAt != null ? Number(patch.updatedAt) : Date.now();
  put("updated_at", nextUpdatedAt);
  if (!sets.length) return true;
  vals.push(cur.id);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

/** 记录账号最近一次上游错误（号池状态气泡展示用；只留最新一条，message 截 400 字）。
 *  渠道级拦截（11128/WAF）不冷却账号，这类错误只有落在这里才看得见 */
function noteError(id, message) {
  const msg = String(message || "").trim();
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

/** TOP 排行：按 channel / model / key / account 分组（近 N 日） */
function statsTop(dim, days) {
  open();
  const col = { channel: "channel", model: "model", key: "key_name", account: "account_name" }[dim] || "channel";
  const from = dayStartMs() - (Math.min(90, Math.max(1, days || 7)) - 1) * 86400000;
  return db.prepare(
    `SELECT ${col} AS name, COUNT(*) AS req, SUM(prompt_tokens + completion_tokens) AS tokens
     FROM usage_requests WHERE ts >= ? AND ${col} != '' GROUP BY ${col} ORDER BY req DESC LIMIT 10`
  ).all(from);
}

/** 明细分页（保留 90 天） */
function statsDetail({ page, pageSize, channel, keyId, model }) {
  open();
  const size = Math.min(100, Math.max(5, pageSize || 20));
  const p = Math.max(1, page || 1);
  const where = [];
  const vals = [];
  if (channel) { where.push("channel = ?"); vals.push(channel); }
  if (keyId) { where.push("key_id = ?"); vals.push(keyId); }
  if (model) { where.push("model = ?"); vals.push(model); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM usage_requests ${w}`).get(...vals).c;
  const rows = db.prepare(
    `SELECT * FROM usage_requests ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...vals, size, (p - 1) * size);
  return { total, page: p, pageSize: size, rows: rows.map(usageView) };
}

function recentRequests(limit) {
  open();
  const rows = db.prepare("SELECT * FROM usage_requests ORDER BY ts DESC LIMIT ?").all(Math.min(50, limit || 10));
  return rows.map(usageView);
}

function usageView(r) {
  return {
    id: r.id, ts: r.ts, reqId: r.req_id, keyId: r.key_id, keyName: r.key_name,
    channel: r.channel, accountId: r.account_id, accountName: r.account_name, model: r.model,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    cacheReadTokens: r.cache_read_tokens || 0, cacheCreationTokens: r.cache_creation_tokens || 0,
    ttftMs: r.ttft_ms, latencyMs: r.latency_ms, status: r.status, error: r.error,
  };
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

module.exports = {
  open, close, proxyDir, dayStr, dayStartMs,
  driver: () => driver,
  CHANNELS,
  QODER_INTL_ENABLED,
  channelDisplay: (id) => (CHANNELS.find((c) => c.id === id) || {}).display || String(id),
  createKey, listKeys, findKeyBySecret, updateKey, deleteKey, keyTodayReq,
  listAgents, setPoolStrategy,
  listAccounts, getAccount, accountSecrets, addAccount, updateAccount, bumpAccountUsage, removeAccount, noteError, clearError,
  listModelCooldowns, upsertModelCooldown, deleteModelCooldowns,
  snapshotCredits,
  insertUsage, statsToday, statsTrend, statsTop, statsDetail, recentRequests,
};
