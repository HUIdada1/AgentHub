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
//
// 【口径修正（2026-11-03，恢复旧版反代网关的可用性）】：
//   早期实现把「完整 Key 只在 create 响应里出现一次」当安全优势，代价是：用户没存好就永久
//   拿不回来，只能删掉重建。实际上这是**自己给自己制造丢凭据的风险**，不是安全收益——
//   能读 stats.db 的人本来就能读 config.json 里的加密信封，多存一份密文不降低任何门槛。
//   现在按旧版（ProxyKeysView）口径恢复：raw 同时经框架加密链路（Windows DPAPI / AES-GCM）
//   落进 key_enc，列表和解密后回给渲染层，支持随时查看 / 复制 / 编辑。
//   · key_hash 仍是鉴权唯一入口（HMAC 等值命中），明文不参与比对；
//   · key_enc 解不开（换机 / 换用户 / 旧版本存量行）时回空串，页面据此提示「完整 Key 不可恢复」。
//
// 【签名密钥来源修正（2026-10-27 审查）】：原实现 require("../config.cjs").secretKey()，
// 但 framework config.cjs 并没有 secretKey 导出（只有 encryptSecret/decryptSecret），
// 于是每次都会静默落到硬编码 fallback 常量——HMAC 等于没有密钥。
// 现改为：localgw.security.secret（首次使用时生成 32 字节随机串，经框架 DPAPI 加密后落 config.json）。
"use strict";
const crypto = require("node:crypto");
const proxyStore = require("../proxy/store.cjs");
const frameworkConfig = require("../config.cjs");
const lgwConfig = require("./config.cjs");
const { recheckAuthority } = require("./requests.cjs");

// 借号池的 db 句柄（open 幂等）；如果 proxy 还没起来，这里会顺带把表建出来
function db() {
  return proxyStore.open();
}

/** 表：localgw_keys（独立的命名空间，与号池 keys 表互不干扰）
 *  key_enc = 完整 Key 的加密信封（框架 encryptSecret；无 safeStorage 时明文降级） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS localgw_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  key_enc TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '["*"]',
  expires_at INTEGER,
  concurrency INTEGER NOT NULL DEFAULT 8,
  rate_per_min INTEGER NOT NULL DEFAULT 120,
  status TEXT NOT NULL DEFAULT 'active',
  authority_revision INTEGER NOT NULL DEFAULT 0,
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
  const d = db();
  d.exec(SCHEMA);
  // 在线迁移：key_enc（完整 Key 的加密信封，供列表随时查看 / 复制）。
  // 存量行只能留空——旧口径压根没存过 raw，其完整 Key 在物理上已不存在，不能假装能恢复。
  try { d.exec("ALTER TABLE localgw_keys ADD COLUMN key_enc TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }
  if (!d.prepare("PRAGMA table_info(localgw_keys)").all().some(column => column.name === "authority_revision")) {
    d.exec("ALTER TABLE localgw_keys ADD COLUMN authority_revision INTEGER NOT NULL DEFAULT 0");
  }
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

/** 完整 Key → 加密信封。框架加密不可用时退化为明文（与 config.json 的降级口径一致，
 *  测试 / 无 safeStorage 环境仍能读回）；绝不让加密失败把创建流程整体搞挂。 */
function sealRaw(raw) {
  try {
    if (typeof frameworkConfig.encryptSecret === "function") {
      const enc = frameworkConfig.encryptSecret(raw);
      if (enc) return enc;
    }
  } catch { /* 落到明文降级 */ }
  return String(raw);
}

/** 加密信封 → 完整 Key。解不开（换机 / 换用户 / 旧版本存量空值）一律回空串：
 *  返回密文串本身会让页面显示一坨 "enc:v1:..." 并且复制出去也鉴权不通过，
 *  不如明确「不可恢复」，让用户知道该重建。 */
function revealRaw(stored) {
  const s = String(stored || "");
  if (!s) return "";
  try {
    if (typeof frameworkConfig.decryptSecret === "function") return frameworkConfig.decryptSecret(s) || "";
  } catch { /* 解密异常按不可恢复处理 */ }
  return "";
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

/** scopes 收敛：非数组 / 空 / 全非法一律回落 ["*"]（全部渠道） */
function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string" && s) : [];
  return list.length ? list : ["*"];
}

/** 到期时间收敛：<=0 / 非数字 → null（永不过期） */
function normalizeExpiry(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 行 → 页面口径。withSecret=true 时才解密完整 Key（列表 / 编辑回填用；
 *  鉴权热路径不进来，避免每个请求都走一次系统解密调用）。 */
function rowToApi(r, withSecret = false) {
  let scopes = ["*"];
  try { scopes = JSON.parse(r.scopes || '["*"]'); } catch { /* 默认 */ }
  const api = {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    scopes,
    expiresAt: r.expires_at,
    concurrency: r.concurrency,
    ratePerMin: r.rate_per_min,
    // 状态只有「启用 / 停用」两态：旧版的 revoked 是同一件事的不可逆叫法，
    // 读的时候归一化成 disabled（停用可再启用，删除才是不可逆），存量行因此能直接复活
    status: r.status === "active" ? "active" : "disabled",
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    totalRequests: r.total_requests,
    totalTokens: r.total_tokens,
  };
  if (withSecret) api.secret = revealRaw(r.key_enc);
  return api;
}

/** 创建密钥：返回 rawKey（本次也同时加密落库，列表随时可再取）。
 *  入参一律钳制：渲染层传来 -5 / "abc" / NaN 都不能写进库（否则限流与并发闸门会失效）。 */
function create({ name, scopes, expiresAt, concurrency, ratePerMin } = {}) {
  ensure();
  const raw = genRawKey();
  const id = crypto.randomUUID();
  const now = Date.now();
  const keyHash = hashRaw(raw);
  const prefix = raw.slice(0, 12); // 展示用前缀（sk-lgw-xxxxx）
  const scopesJson = JSON.stringify(normalizeScopes(scopes));
  const expAt = normalizeExpiry(expiresAt);
  const conc = clampInt(concurrency, 8, 1, 64);
  const rpm = clampInt(ratePerMin, 120, 1, 100000);
  db().prepare(
    `INSERT INTO localgw_keys (id, name, key_hash, key_enc, key_prefix, scopes, expires_at, concurrency, rate_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(id, String(name || "").trim().slice(0, 64) || "未命名", keyHash, sealRaw(raw), prefix, scopesJson, expAt, conc, rpm, now);
  const apiKey = getById(id, true);
  return { rawKey: raw, apiKey };
}

/** 按 id 取单行（create / update 回填用；避免 list() 全表扫描 + find） */
function getById(id, withSecret = false) {
  ensure();
  if (!id) return null;
  const r = db().prepare(`SELECT * FROM localgw_keys WHERE id=?`).get(String(id));
  return r ? rowToApi(r, withSecret) : null;
}

// Private state version, never a credential or a new public API field. Restoring
// identical permissions cannot revive old conversations. Usage/name/rate edits
// do not rotate it. Read directly without decrypting a gateway secret.
function authorizationVersion(id) {
  ensure();
  const row = id && db().prepare("SELECT status, expires_at, scopes, authority_revision FROM localgw_keys WHERE id=?").get(String(id));
  if (!row || row.status !== "active" || row.expires_at && row.expires_at <= Date.now()) return null;
  return crypto.createHash("sha256").update(JSON.stringify([row.authority_revision, row.status, row.expires_at, row.scopes])).digest("hex");
}

/** 列表：完整 Key 解密后一并返回（口径修正见文件头） */
function list() {
  ensure();
  return db().prepare(`SELECT * FROM localgw_keys ORDER BY created_at DESC`).all().map((r) => rowToApi(r, true));
}

/** 编辑：只改显式传入的字段，未传的保持原值（undefined 与 null 语义分开——
 *  expiresAt 传 null 表示「改成永不过期」，传 undefined 表示「别动有效期」）。
 *  返回更新后的整行，页面可直接回填，不必再拉一次列表。 */
function update(id, patch = {}) {
  ensure();
  if (!id) return { ok: false, message: "缺少密钥 id" };
  const row = db().prepare(`SELECT * FROM localgw_keys WHERE id=?`).get(String(id));
  if (!row) return { ok: false, message: "密钥不存在" };
  const p = patch && typeof patch === "object" ? patch : {};
  const name = p.name !== undefined ? String(p.name || "").trim().slice(0, 64) || "未命名" : row.name;
  const scopesJson = p.scopes !== undefined ? JSON.stringify(normalizeScopes(p.scopes)) : row.scopes;
  const expAt = p.expiresAt !== undefined ? normalizeExpiry(p.expiresAt) : row.expires_at;
  const conc = p.concurrency !== undefined ? clampInt(p.concurrency, row.concurrency, 1, 64) : row.concurrency;
  const rpm = p.ratePerMin !== undefined ? clampInt(p.ratePerMin, row.rate_per_min, 1, 100000) : row.rate_per_min;
  db().prepare(
    `UPDATE localgw_keys SET name=?, scopes=?, expires_at=?, concurrency=?, rate_per_min=?,
     authority_revision=authority_revision+? WHERE id=?`
  ).run(name, scopesJson, expAt, conc, rpm, scopesJson !== row.scopes || expAt !== row.expires_at ? 1 : 0, String(id));
  recheckAuthority({ keyId: String(id) });
  return { ok: true, apiKey: getById(id, true) };
}

/** 启 / 停：status ∈ active | disabled。停用即时生效（鉴权实时查库），可再启用。
 *  行不存在时明确回失败：页面点「停用」发现 Key 已被别处删掉，必须能说清原因，
 *  不能静默成功让用户以为切换生效了。 */
function setStatus(id, status) {
  ensure();
  if (!id) return { ok: false, message: "缺少密钥 id" };
  const next = status === "active" ? "active" : "disabled";
  const r = db().prepare(`UPDATE localgw_keys SET authority_revision=authority_revision+CASE WHEN status=? THEN 0 ELSE 1 END, status=? WHERE id=?`).run(next, next, String(id));
  if (!r || !r.changes) return { ok: false, changed: false, message: "密钥不存在" };
  recheckAuthority({ keyId: String(id) });
  return { ok: true, changed: true, status: next };
}

/** 删除：真删行（旧版「吊销」只是打标，用户要的是删干净）。
 *  幂等：行已不存在也回 ok，changed=false 让调用方知道「本来就没有」。 */
function remove(id) {
  ensure();
  if (!id) return { ok: false, message: "缺少密钥 id" };
  const r = db().prepare(`DELETE FROM localgw_keys WHERE id=?`).run(String(id));
  recheckAuthority({ keyId: String(id) });
  return { ok: true, changed: !!(r && r.changes) };
}

/** 兼容旧通道：吊销 = 停用（不可逆语义已废弃，页面改用删除） */
function revoke(id) {
  return setStatus(id, "disabled");
}

/** 改名：保留旧通道（只改名字时用它最省事）。走 update 复核存在性，
 *  静默成功会让用户以为改好了。 */
function rename(id, name) {
  const r = update(id, { name });
  return r.ok ? { ok: true } : r;
}

/** 鉴权中间件：根据 Bearer rawKey 找到 key 行（比对 HMAC），同时检查过期与停用。
 *  返回 { ok, key?, reason? }：reason ∈ not_found | disabled | expired。
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
  if (api.status !== "active") return { ok: false, reason: "disabled" };
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

module.exports = { create, list, getById, authorizationVersion, update, setStatus, remove, revoke, rename, authenticate, touch, countActive };
