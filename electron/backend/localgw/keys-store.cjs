/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · API Key 持久化层
// 决策 3：存号池 SQL（stats.db），与号池共用一份备份、一份加密——不再开第二套密钥文件。
// key_hash 用 HMAC-SHA256(raw, secretKey) 而非裸 sha256（防彩虹表）。
// 展示侧：列表只回 key_prefix；完整 rawKey 只在 create() 响应里出现一次。
//
// 【签名密钥来源修正（2026-10-27 审查）】：原实现 require("../config.cjs").secretKey()，
// 但 framework config.cjs 并没有 secretKey 导出（只有 encryptSecret/decryptSecret），
// 于是每次都会静默落到硬编码 fallback 常量——HMAC 等于没有密钥。
// 现改为：localgw.security.secret（首次使用时生成 32 字节随机串，经框架 DPAPI 加密后落 config.json）。
"use strict";
const crypto = require("node:crypto");
const proxyStore = require("../proxy/store.cjs");
const lgwConfig = require("./config.cjs");

// 借号池的 db 句柄（open 幂等）；如果 proxy 还没起来，这里会顺带把表建出来
function db() {
  return proxyStore.open();
}

/** 表：localgw_keys（独立的命名空间，与号池 keys 表互不干扰） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS localgw_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '["*"]',
  expires_at INTEGER,
  concurrency INTEGER NOT NULL DEFAULT 8,
  rate_per_min INTEGER NOT NULL DEFAULT 120,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_localgw_keys_hash ON localgw_keys(key_hash);
`;

/** 拿/建 db（懒加载，避免 IPC 注册阶段就 IO） */
let ready = false;
function ensure() {
  if (ready) return;
  db().exec(SCHEMA);
  ready = true;
}

/** HMAC 密钥缓存：键为 config.json 里存的密文串，换密钥/轮转后自动失效，
 *  避免每个请求都走一次 DPAPI 解密（decryptSecret 在 Windows 上是有成本的系统调用）。 */
let hmacMemo = { stored: null, key: null };

/** 取签名密钥明文：已配置则解出，未配置则生成并加密落盘（只发生一次） */
function hmacKey() {
  let stored = "";
  try {
    stored = (lgwConfig.get().security || {}).secret || "";
  } catch { stored = ""; }
  if (stored && hmacMemo.stored === stored && hmacMemo.key) return hmacMemo.key;
  let key;
  try {
    key = stored ? lgwConfig.revealSecret(stored) : lgwConfig.ensureSecret();
  } catch {
    // 配置层彻底不可用时的最后兜底：仍给出稳定密钥（宁可哈希弱一点也不让鉴权整体不可用）
    key = "agenthub-localgw-fallback";
  }
  if (!key) key = stored || "agenthub-localgw-fallback";
  hmacMemo = { stored, key };
  return key;
}

/** HMAC-SHA256(raw, 签名密钥) → hex */
function hashRaw(raw) {
  return crypto.createHmac("sha256", hmacKey()).update(String(raw)).digest("hex");
}

/** 生成 24 字节的 API Key（sk-lgw- 前缀 + base64url 体） */
function genRawKey() {
  const body = crypto.randomBytes(24).toString("base64url");
  return `sk-lgw-${body}`;
}

/** 整数钳制：非法值一律回落到默认值（与 config.cjs 的 clampInt 同语义） */
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function rowToApi(r) {
  let scopes = ["*"];
  try { scopes = JSON.parse(r.scopes || '["*"]'); } catch { /* 默认 */ }
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    scopes,
    expiresAt: r.expires_at,
    concurrency: r.concurrency,
    ratePerMin: r.rate_per_min,
    status: r.status === "revoked" ? "revoked" : "active",
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    totalRequests: r.total_requests,
    totalTokens: r.total_tokens,
  };
}

/** 创建密钥：rawKey 只在返回值里出现一次；落库只存 HMAC + 前缀。
 *  入参一律钳制：渲染层传来 -5 / "abc" / NaN 都不能写进库（否则限流与并发闸门会失效）。 */
function create({ name, scopes, expiresAt, concurrency, ratePerMin } = {}) {
  ensure();
  const raw = genRawKey();
  const id = crypto.randomUUID();
  const now = Date.now();
  const keyHash = hashRaw(raw);
  const prefix = raw.slice(0, 12); // 展示用前缀（sk-lgw-xxxxx）
  const scopeList = Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string" && s) : [];
  const scopesJson = JSON.stringify(scopeList.length ? scopeList : ["*"]);
  const exp = Number(expiresAt);
  const expAt = Number.isFinite(exp) && exp > 0 ? Math.round(exp) : null;
  const conc = clampInt(concurrency, 8, 1, 64);
  const rpm = clampInt(ratePerMin, 120, 1, 100000);
  db().prepare(
    `INSERT INTO localgw_keys (id, name, key_hash, key_prefix, scopes, expires_at, concurrency, rate_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(id, String(name || "").trim().slice(0, 64) || "未命名", keyHash, prefix, scopesJson, expAt, conc, rpm, now);
  const apiKey = getById(id);
  return { rawKey: raw, apiKey };
}

/** 按 id 取单行（create 回填用；避免 list() 全表扫描 + find） */
function getById(id) {
  ensure();
  if (!id) return null;
  const r = db().prepare(`SELECT * FROM localgw_keys WHERE id=?`).get(String(id));
  return r ? rowToApi(r) : null;
}

/** 列表：只回前缀，永不回明文 */
function list() {
  ensure();
  return db().prepare(`SELECT * FROM localgw_keys ORDER BY created_at DESC`).all().map(rowToApi);
}

/** 吊销：status → revoked，后续请求会 401。
 *  幂等：不存在的 id 也返回 ok（调用方重试/重复点击不该报错），changed 表示是否真的改了行。 */
function revoke(id) {
  ensure();
  if (!id) return { ok: false, message: "缺少密钥 id" };
  const r = db().prepare(`UPDATE localgw_keys SET status='revoked' WHERE id=?`).run(String(id));
  return { ok: true, changed: !!(r && r.changes) };
}

/** 改名：id 必须存在，否则明确回失败（静默成功会让用户以为改好了） */
function rename(id, name) {
  ensure();
  if (!id) return { ok: false, message: "缺少密钥 id" };
  const r = db().prepare(`UPDATE localgw_keys SET name=? WHERE id=?`).run(String(name || "").trim().slice(0, 64) || "未命名", String(id));
  if (!r || !r.changes) return { ok: false, message: "密钥不存在" };
  return { ok: true };
}

/** 鉴权中间件：根据 Bearer rawKey 找到 key 行（比对 HMAC），同时检查过期与吊销。
 *  返回 { ok, key?, reason? }：reason ∈ not_found | revoked | expired。
 *  查询按 key_hash 等值命中（HMAC 摘要不可逆，无需再做明文比较），
 *  过期判定用 unix ms 与 Date.now() 直接比较，不受时区影响。
 *  库不可用时返回 not_found 而不是抛错：网关应回 401，不该回 500 并把栈暴露给调用方。 */
function authenticate(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return { ok: false, reason: "not_found" };
  let r = null;
  try {
    ensure();
    r = db().prepare(`SELECT * FROM localgw_keys WHERE key_hash=?`).get(hashRaw(rawKey));
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!r) return { ok: false, reason: "not_found" };
  const api = rowToApi(r);
  if (api.status === "revoked") return { ok: false, reason: "revoked" };
  if (api.expiresAt && Date.now() > api.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, key: api };
}

/** 请求计数 +1，更新 last_used_at 与 token 累计（usagehook 调用）。
 *  失败静默：计数写不进去绝不能影响已经成功返回给用户的转发结果。 */
function touch(id, promptTokens, completionTokens) {
  if (!id) return { ok: false, message: "缺少密钥 id" };
  try {
    ensure();
    const n = Math.max(0, Math.round(Number(promptTokens) || 0)) + Math.max(0, Math.round(Number(completionTokens) || 0));
    db().prepare(
      `UPDATE localgw_keys
       SET last_used_at=?, total_requests=total_requests+1, total_tokens=total_tokens+?
       WHERE id=?`
    ).run(Date.now(), n, String(id));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 有效密钥数（sidebar 卡片与 status IPC 用）；库不可用时回 0 而不是抛错 */
function countActive() {
  try {
    ensure();
    const r = db().prepare(`SELECT COUNT(*) AS n FROM localgw_keys WHERE status='active'`).get();
    return r ? r.n : 0;
  } catch {
    return 0;
  }
}

module.exports = { create, list, getById, revoke, rename, authenticate, touch, countActive };
