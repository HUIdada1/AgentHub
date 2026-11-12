/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · OfficeAce（华为云果办）**自助 OAuth**：不需要桌面端，全链路在本机跑完。
//
// 依据 Agent2Providers `officeace/oauth.rs`（九步流程 + `dpop.rs`），逐条移植：
//   ① POST {cloud}/v1/claw/auth/state                  → state（无鉴权）
//   ② 本地生成 PKCE(S256) 与一对 P-256 DPoP 密钥
//   ③ 拼 authorizeUrl（外层 login.html?service=<内层 authorize>）
//   ④ GET  {cloud}/v1/claw/auth/code?state=<state>     ← 轮询取码（202 未完成 / 404 作废）
//   ⑤ POST {sts}/v1/oauth2/tokens（表单 + `DPoP:` 头） → 临时 AK/SK/STS
//   ⑥ GET  {cloud}/v1/claw/client-permission-validate（**SDK-HMAC** 签名）
//   ⑥a GET  {iam}/v3/projects（SDK-HMAC；project_id 空时按 region 名补）
//   ⑥b POST {cloud}/v1/claw/client-subscription（body `{}`；model_info 空时开通一次）
//   ⑦ 落库：网关 Basic 那对**不过期**，控制面临时凭据只用于额度/签到
//
// 为什么必须轮询：云端回调页是终点页，**不往本机跳**；桌面端就是靠轮询取码。
// 轮次状态只放进程内（登录的几分钟里有效），插件重启就丢 —— 那是正确行为。
"use strict";
const crypto = require("node:crypto");
const signer = require("./signer.cjs");

const CLOUD_BASE = "https://agentarts.cn-southwest-2.myhuaweicloud.com";
const AUTH_BASE = "https://auth.huaweicloud.com";
const CLIENT_ID = "pdp5_for_agentarts";
const REDIRECT_URI = `${CLOUD_BASE}/v1/claw/auth/callback`;
const TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const REGION = "cn-southwest-2";
const IAM_KEYSTONE_BASE = "https://iam.myhuaweicloud.com";
const SUBSCRIPTION_HEADER = ["x-subscription-type", "v2"];
const REQUEST_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 2500;

const flows = new Map();

/** RFC3986（授权地址里的参数必须逐字一致，`+` 不是空格） */
function urlEscape(input) {
  return String(input).replace(/[^A-Za-z0-9\-._~]/g, (ch) => {
    const bytes = Buffer.from(ch, "utf8");
    let out = "";
    for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    return out;
  });
}
function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

// ── DPoP（RFC 9449 的 `DPoP` 头：ES256 JWS，头部嵌公钥 JWK）────────
/** 新生成一把 P-256 密钥；落盘形状与参考实现逐字一致（private_key_jwk / public_key_jwk） */
function generateDpopKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const priv = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  return {
    private_key_jwk: { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d },
    public_key_jwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
  };
}
/** 从落盘的密钥对恢复（只读私钥那一半；公钥由它推出，落盘公钥不一致就拒绝） */
function dpopKeyOf(pair) {
  const priv = pair && (pair.private_key_jwk || pair.privateKeyJwk);
  if (!priv || priv.kty !== "EC" || priv.crv !== "P-256" || !priv.d) throw new Error("DPoP 私钥缺失或不是 P-256（dpopKeyPair.private_key_jwk）");
  const privateKey = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d }, format: "jwk" });
  const publicJwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  const stored = pair.public_key_jwk || pair.publicKeyJwk;
  if (stored && (stored.x || stored.y) && (stored.x !== publicJwk.x || stored.y !== publicJwk.y))
    throw new Error("DPoP 公私钥不一致，请重新登录");
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y } };
}
/** 现签一份 proof：htm/htu 必须与本次请求逐字一致（对不上就是 401） */
function dpopProof(key, method, endpoint, nowMs = Date.now()) {
  const header = { alg: "ES256", typ: "dpop+jwt", jwk: key.publicJwk };
  const payload = {
    htm: String(method).toUpperCase(), htu: endpoint,
    iat: Math.floor(nowMs / 1000), jti: crypto.randomBytes(32).toString("hex"),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

// ── HTTP ──────────────────────────────────────────────────
async function request(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
}
async function readJson(response) {
  const text = await response.text().catch(() => "");
  try { return JSON.parse(text); } catch { return null; }
}

// ── ①③④ 登录轮次 ──────────────────────────────────────────
async function fetchState() {
  const response = await request(`${CLOUD_BASE}/v1/claw/auth/state`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  const payload = await readJson(response);
  const state = String(payload?.state || "").trim();
  if (!state) throw new Error(`云端没给出 state（HTTP ${response.status}）`);
  return state;
}
function buildAuthorizeUrl(state, challenge) {
  const inner = `${AUTH_BASE}/authui/v1/oauth2/authorize?client_id=${CLIENT_ID}`
    + `&code_challenge=${urlEscape(challenge)}&code_challenge_method=SHA-256&state=${urlEscape(state)}`
    + `&scope=openid&redirect_uri=${urlEscape(REDIRECT_URI)}&response_type=code`;
  return `${AUTH_BASE}/authui/login.html?service=${urlEscape(inner)}`;
}

/** 发起一轮登录：返回 { flow, url, intervalMs }（flow 就是 state） */
async function startLogin() {
  const state = await fetchState();
  const codeVerifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const dpopKeyPair = generateDpopKey();
  flows.set(state, { codeVerifier, dpopKeyPair });
  return { flow: state, url: buildAuthorizeUrl(state, challenge), intervalMs: POLL_INTERVAL_MS };
}
function cancelLogin(flow) { flows.delete(String(flow || "")); }

/** 单次取码：null = 还没登完；字符串 = 授权码 */
async function pollCode(state) {
  const response = await request(`${CLOUD_BASE}/v1/claw/auth/code?state=${urlEscape(state)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 202) return null;
  if (response.status === 404) throw new Error("授权码已失效或 state 不认识，请重新发起登录");
  if (!response.ok) throw new Error(`取授权码返回 HTTP ${response.status}`);
  const payload = await readJson(response);
  if (payload?.error) throw new Error(`云端拒绝：${payload.error_msg || payload.error}`);
  const code = String(payload?.code || payload?.authorization_code || "").trim();
  if (!code) throw new Error("云端说好了，但没给授权码");
  return code;
}

/** 轮询一次：{ pending: true } 或 { done: true, credential } */
async function pollLogin(flow) {
  const pending = flows.get(String(flow || ""));
  if (!pending) throw Object.assign(new Error("登录任务不存在或已过期，请重新发起"), { status: 404 });
  let code;
  try { code = await pollCode(flow); }
  catch (error) { flows.delete(flow); throw Object.assign(error, { status: 400 }); }
  if (!code) return { pending: true };
  try {
    const credential = await finishLogin(code, pending.codeVerifier, pending.dpopKeyPair);
    return { done: true, credential };
  } finally {
    flows.delete(flow);
  }
}

// ── ⑤ 授权码 → 临时凭据 ───────────────────────────────────
function formEncode(fields) {
  return fields.map(([key, value]) => `${urlEscape(key)}=${urlEscape(value)}`).join("&");
}
async function tokenRequest(fields, dpopKeyPair) {
  const key = dpopKeyOf(dpopKeyPair);
  const proof = dpopProof(key, "POST", TOKEN_URL);
  const response = await request(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", DPoP: proof },
    body: formEncode(fields),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const detail = payload?.error_description || payload?.error_msg || payload?.error || `HTTP ${response.status}`;
    throw new Error(`令牌端点被拒：${detail}`);
  }
  const credentials = payload?.credentials || {};
  const accessKeyId = String(credentials.access_key_id || "");
  const secretAccessKey = String(credentials.secret_access_key || "");
  if (!accessKeyId || !secretAccessKey) throw new Error("令牌端点没返回临时凭据");
  const expiresAt = Date.parse(String(credentials.expiration || "")) || (Date.now() + 2 * 3600 * 1000);
  return {
    credential: {
      accessKeyId, secretAccessKey,
      securityToken: String(credentials.security_token || ""),
      projectId: String(credentials.project_id || ""),
    },
    expiresAt,
    identity: responseIdentity(payload),
    refreshToken: String(payload?.refresh_token || ""),
  };
}

// ── 身份（JWT claims；顶层优先、user_profile 兜底）────────────
function jwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try { return JSON.parse(b64urlDecode(parts[1])); } catch { return null; }
}
function decodeUserProfile(text) {
  try { return JSON.parse(b64urlDecode(text)); } catch {
    try { return JSON.parse(String(text)); } catch { return null; }
  }
}
function jwtIdentity(token) {
  const claims = jwtClaims(token);
  if (!claims) return { userName: "", principalId: "", accountId: "" };
  const profile = typeof claims.user_profile === "string" ? decodeUserProfile(claims.user_profile) : null;
  const pick = (key) => {
    const value = (profile && profile[key]) || claims[key];
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    userName: pick("preferred_username") || pick("name") || pick("account_name"),
    principalId: pick("principal_id"),
    accountId: pick("account_id"),
  };
}
/** id_token 优先（这次会话的身份快照），没名字再退 refresh_token */
function responseIdentity(payload) {
  let principalOnly = { userName: "", principalId: "", accountId: "" };
  for (const field of ["id_token", "refresh_token"]) {
    const identity = jwtIdentity(payload?.[field]);
    if (identity.userName) return identity;
    if (!principalOnly.principalId && identity.principalId) principalOnly = identity;
  }
  return principalOnly;
}

// ── ⑥⑥a⑥b 控制面 ─────────────────────────────────────────
async function sdkCall(credential, method, url, { body = "", headers = [] } = {}) {
  const signed = signer.signSdk({ method, url, headers, body, region: REGION, credential });
  // ⚠ signSdk() 返回的是**对象** `{ headers, canonicalRequest, stringToSign, signature, signedHeaders }`，
  // 只有它的 `.headers` 才是 entries 数组（对照 signer.cjs:196；而 sign()/signV11() 直接返回数组，
  // 所以 officeace/management.cjs 那种 `Object.fromEntries(signed)` 写法在那里是对的）。
  // 早期这里误把整对象喂给 Object.fromEntries → 登录第 ⑥ 步必抛
  // `TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))`，
  // 表现为「用华为云账号登录 OfficeAce（果办）失败」，且只有这一条链路会炸（额度/签到走 sign()，不受影响）。
  const response = await request(url, { method, headers: Object.fromEntries(signed.headers), body: body || undefined });
  return { response, payload: await readJson(response) };
}
async function fetchPermission(credential) {
  const url = `${CLOUD_BASE}/v1/claw/client-permission-validate`;
  const { response, payload } = await sdkCall(credential, "GET", url, {
    headers: [[SUBSCRIPTION_HEADER[0], SUBSCRIPTION_HEADER[1]], ["accept", "application/json"]],
  });
  if (!response.ok) throw new Error(`权限校验失败（HTTP ${response.status}）：${payload?.error_msg || payload?.error_code || ""}`);
  const modelInfo = [payload?.model_info, payload?.subscription?.model_info, payload?.modelInfo]
    .find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
  return {
    modelInfo,
    accountId: String(payload?.account_id || ""),
    principalId: String(payload?.principal_id || ""),
  };
}
async function resolveProjectId(credential) {
  const url = `${IAM_KEYSTONE_BASE}/v3/projects`;
  const { response, payload } = await sdkCall(credential, "GET", url, { headers: [["accept", "application/json"]] });
  if (!response.ok) return "";
  const projects = Array.isArray(payload?.projects) ? payload.projects : [];
  const hit = projects.find((project) => String(project?.name || "") === REGION
    && project?.enabled !== false && String(project?.id || "").trim());
  return hit ? String(hit.id) : "";
}
function promotionHint(code) {
  if (code === "AgentArts.11000008") return "邀请码无效";
  if (code === "AgentArts.11000009") return "邀请码不存在或今日配额已用完";
  if (code === "AgentArts.00000104" || code === "common.01010003") return "当前账号权限不足";
  if (code === "common.01010004") return "账号可能未实名认证或处于欠费状态";
  return "";
}
async function subscribeModelInfo(credential) {
  const url = `${CLOUD_BASE}/v1/claw/client-subscription`;
  const body = "{}";
  const { response, payload } = await sdkCall(credential, "POST", url, {
    body,
    headers: [
      ["Content-Type", "application/json;charset=utf8"],
      [SUBSCRIPTION_HEADER[0], SUBSCRIPTION_HEADER[1]],
      ["accept", "application/json"],
    ],
  });
  if (!response.ok) {
    const hint = promotionHint(String(payload?.error_code || ""));
    if (hint) throw new Error(`该账号尚未开通果办服务（${hint}）：请先在 OfficeAce 客户端完成开通，再回来重新登录`);
    throw new Error(`开通失败（HTTP ${response.status}）：${payload?.error_msg || payload?.error_message || payload?.error_code || ""}`);
  }
  const modelInfo = payload?.model_info;
  if (!modelInfo || typeof modelInfo !== "object") throw new Error("开通成功但云端仍未返回模型网关信息，请稍后重试");
  return modelInfo;
}
/** model_info → 网关三件套（基址规范到 `/v2`） */
function gatewayOf(modelInfo) {
  const auth = modelInfo?.model_auth_info || {};
  const appKey = String(auth.model_app_key || "");
  const appSecret = String(auth.model_app_secret || "");
  if (!appKey || !appSecret) throw new Error("云端返回了模型信息，但缺少模型网关凭据（model_app_key / model_app_secret）");
  const host = String(modelInfo?.model_api_url_base || "").trim()
    .replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) throw new Error("云端返回的模型网关基址为空");
  return { baseUrl: host.endsWith("/v2") ? `https://${host}` : `https://${host}/v2`, modelAppKey: appKey, modelAppSecret: appSecret };
}

async function finishLogin(code, codeVerifier, dpopKeyPair) {
  const temporary = await tokenRequest([
    ["client_id", CLIENT_ID], ["code", String(code).trim()], ["code_verifier", codeVerifier],
    ["grant_type", "authorization_code"], ["redirect_uri", REDIRECT_URI],
  ], dpopKeyPair);
  let { credential, expiresAt, identity, refreshToken } = temporary;
  if (!credential.projectId) {
    credential = { ...credential, projectId: await resolveProjectId(credential) };
  }
  const permission = await fetchPermission(credential);
  const modelInfo = permission.modelInfo || await subscribeModelInfo(credential);
  const gateway = gatewayOf(modelInfo);
  return {
    baseUrl: gateway.baseUrl,
    modelAppKey: gateway.modelAppKey,
    modelAppSecret: gateway.modelAppSecret,
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    securityToken: credential.securityToken,
    projectId: credential.projectId,
    expiresAt,
    refreshToken,
    dpopKeyPair,
    accountName: identity.userName || "",
    accountId: identity.accountId || permission.accountId || "",
    principalId: identity.principalId || permission.principalId || "",
  };
}

// ── 续期：一次性 refresh_token 换新临时凭据（必须用**登录那把** DPoP 私钥）──
async function refreshCredential({ dpopKeyPair, refreshToken }) {
  if (!String(refreshToken || "").trim()) throw new Error("OfficeAce 账号没有 refresh token，只能重新登录授权");
  const result = await tokenRequest([
    ["client_id", CLIENT_ID], ["grant_type", "refresh_token"], ["refresh_token", String(refreshToken).trim()],
  ], dpopKeyPair);
  if (!result.refreshToken) throw new Error("续期响应缺少新的 refresh_token，旧令牌可能已被消费，请重新登录授权");
  return {
    accessKeyId: result.credential.accessKeyId,
    secretAccessKey: result.credential.secretAccessKey,
    securityToken: result.credential.securityToken,
    projectId: result.credential.projectId,
    expiresAt: result.expiresAt,
    refreshToken: result.refreshToken,
    accountName: result.identity.userName,
  };
}

/** 登录结果 → 号池落库形态（token = base64 的 key:secret；控制面 in meta） */
function accountOf(credential) {
  const basic = Buffer.from(`${credential.modelAppKey}:${credential.modelAppSecret}`, "utf8").toString("base64");
  const uid = `oa_${crypto.createHash("sha256").update(`${credential.modelAppKey}:${credential.baseUrl}`).digest("hex").slice(0, 16)}`;
  return {
    uid,
    name: credential.accountName || `OfficeAce ${String(credential.modelAppKey).slice(-6)}`,
    token: basic,
    refreshToken: credential.refreshToken,
    meta: {
      baseUrl: credential.baseUrl,
      modelAppKey: credential.modelAppKey,
      modelAppSecret: credential.modelAppSecret,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
      projectId: credential.projectId,
      controlExpiresAt: credential.expiresAt,
      dpopKeyPair: credential.dpopKeyPair,
      accountId: credential.accountId,
      principalId: credential.principalId,
    },
  };
}

module.exports = {
  startLogin, pollLogin, cancelLogin, refreshCredential, accountOf,
  generateDpopKey, dpopProof, jwtIdentity, gatewayOf, buildAuthorizeUrl,
  CLOUD_BASE, AUTH_BASE, TOKEN_URL, CLIENT_ID, REDIRECT_URI, REGION, POLL_INTERVAL_MS,
};
