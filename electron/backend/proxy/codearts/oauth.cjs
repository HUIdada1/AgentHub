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
// 反代网关 · CodeArts OAuth 令牌端点：授权码换凭据、refresh token 续凭据
//
// 两次调用（首登与续期）打同一个端点、同一个 client_id，差别只在 grant_type 与 body 里那几个字段；
// 更要紧的是两次都要出示 DPoP proof 与 PKCE verifier —— 这正是「长期那一半」（OAuthContext：
// dpop 密钥对 + code_verifier）必须在手的原因。
//
// 请求形状三条都不能省：
//   * Content-Type: application/x-www-form-urlencoded，body 是表单不是 JSON；
//   * DPoP: <proof>，proof 的 htm / htu 必须与本次请求逐字一致；
//   * client_id = codearts-agent，code_verifier = 首次登录生成的那个。
//
// 续期为什么也要 verifier：上游把 refresh_token 绑在「当初那次授权的 PKCE 上下文」上，
// 只带 refresh token 会被拒，所以迁移凭据时少搬一半就是死的。
//
// 错误体里可能回显我们发过去的东西（refresh_token / PKCE verifier），这个端点的错误会一路冒到
// 客户端与日志，所以出站错误体先过一遍脱敏（把这次真的发出去的值逐个盖掉）。
"use strict";

const dpop = require("./dpop.cjs");
const redact = require("./redact.cjs");

const crypto = require("crypto");

// client_id 必须与授权页一致：2026-10 起旧版入口（/login + vscode-codebot）已 404 下线，
// 换成官方 IDE 扩展同款的新版门户流程（与 Magpie、CodeArts2API 两处实现交叉印证）
const CLIENT_ID = "codearts-agent";
const TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const AUTHORIZE_URL = "https://codearts.huaweicloud.com/portal/authorize";
const CALLBACK_PATH = "/oauth/callback";
// portal 只认这一种 challenge 方法名（不是 OAuth 标准的 S256）
const PKCE_METHOD = "SHA-256";
const REQUEST_TIMEOUT_MS = 30000;
// 登录上报的插件身份（与官方 IDE 扩展保持一致；换码/续期只认 CLIENT_ID）
const LOGIN_PLUGIN_NAME = "snap_AIIDE";
const LOGIN_PLUGIN_VERSION = "5.2.0";

function formEncode(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

// 上游错误体 → 人话（截断后原样带上便于排障；先脱敏再透出）
async function tokenErrorDetail(resp, secrets) {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const payload = JSON.parse(text);
    detail = String((payload && (payload.error_description || payload.error || payload.message)) || detail);
  } catch { /* 非 JSON（HTML 错误页）原样截断 */ }
  return redact.redactValues(detail, secrets || [], false);
}

// 解析令牌响应（credentials 是嵌套的一段，别拉平了读）；缺 refresh token 的凭据收下来就是死路，直接拒
async function parseTokenResponse(resp, context, previousRefreshToken) {
  if (!resp.ok) {
    const detail = await tokenErrorDetail(resp, [previousRefreshToken, context && context.code_verifier].filter(Boolean));
    const status = resp.status >= 400 && resp.status < 500 ? resp.status : 502;
    throw Object.assign(new Error(`CodeArts 令牌请求被拒（HTTP ${resp.status}）：${detail}`), { status });
  }
  let payload;
  try { payload = await resp.json(); } catch { payload = null; }
  const creds = payload && payload.credentials ? payload.credentials : payload;
  if (!creds || !creds.access_key_id || !creds.secret_access_key || !creds.security_token) {
    throw Object.assign(new Error("CodeArts 令牌响应缺少 access_key_id / secret_access_key / security_token"), { status: 502 });
  }
  if (!creds.refresh_token) {
    throw Object.assign(new Error("CodeArts 令牌响应没有 refresh token，该凭据无法续期，拒绝收下（请重新登录）"), { status: 502 });
  }
  return {
    access_key_id: String(creds.access_key_id),
    secret_access_key: String(creds.secret_access_key),
    security_token: String(creds.security_token),
    expires_at: String(creds.expiration || ""),
    refresh_token: String(creds.refresh_token),
  };
}

// 打一次令牌端点并按上游回复组装凭据（两个 grant 共用）
async function tokenRequest(formFields, context, previousRefreshToken, fetchImpl) {
  if (!context || !context.dpop_key_pair) {
    throw Object.assign(new Error("CodeArts 凭据缺少 OAuth 上下文（DPoP 密钥），请重新登录"), { status: 400 });
  }
  const proof = dpop.proof(context.dpop_key_pair, "POST", TOKEN_URL, Date.now());
  const body = formFields.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
  const fetchFn = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", DPoP: proof },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    throw Object.assign(new Error(`CodeArts 令牌请求失败：${(e && e.message) || e}`), { status: timedOut ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
  return parseTokenResponse(resp, context, previousRefreshToken);
}

// 用授权码换凭据（网页登录的最后一步）
async function exchangeAuthorizationCode(code, redirectUri, context, fetchImpl) {
  const form = [
    ["client_id", CLIENT_ID],
    ["code", String(code || "").trim()],
    ["code_verifier", context.code_verifier],
    ["grant_type", "authorization_code"],
    ["redirect_uri", redirectUri],
  ];
  const cred = await tokenRequest(form, context, "", fetchImpl);
  cred.login_type = "WEB";
  return cred;
}

// 用 refresh token 换一套新的临时 AK/SK/STS；身份从旧凭据继承（续期响应不带身份）
async function refreshCredential(existing, fetchImpl) {
  const context = existing && existing.oauth_context;
  if (!context) {
    throw Object.assign(new Error("CodeArts 凭据缺少 OAuth 上下文（PKCE/DPoP），请重新登录"), { status: 400 });
  }
  const refreshToken = String(existing.refresh_token || "").trim();
  if (!refreshToken) {
    throw Object.assign(new Error("CodeArts 凭据没有 refresh token，请重新登录"), { status: 400 });
  }
  const form = [
    ["client_id", CLIENT_ID],
    ["code_verifier", context.code_verifier],
    ["grant_type", "refresh_token"],
    ["refresh_token", refreshToken],
  ];
  const fresh = await tokenRequest(form, context, refreshToken, fetchImpl);
  return {
    ...fresh,
    domain_id: fresh.domain_id || existing.domain_id || "",
    user_id: fresh.user_id || existing.user_id || "",
    user_name: fresh.user_name || existing.user_name || "",
    login_type: existing.login_type || "WEB",
  };
}

// 授权页地址（新版门户）：不传完整 redirect_uri，只传 port，回调路径由门户自己拼成
// 127.0.0.1:<port>/oauth/callback；uri_scheme/ticket_id/plugin-name/plugin-version 与官方
// IDE 扩展一致。state 已不需要——门户不回传它，回调侧对缺省本就容忍（保留形参兼容旧调用）。
function buildAuthorizeUrl(port, _state, challenge, extraQuery) {
  const q = new URLSearchParams({
    theme: "2",
    locale: "zh-cn",
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(port),
    code_challenge: challenge,
    code_challenge_method: PKCE_METHOD,
    ticket_id: crypto.randomBytes(16).toString("hex"),
    "plugin-name": LOGIN_PLUGIN_NAME,
    "plugin-version": LOGIN_PLUGIN_VERSION,
  });
  if (extraQuery) for (const [k, v] of Object.entries(extraQuery)) q.append(k, v);
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

// 从 refresh token 的 JWT 载荷里解身份（domain/user/name），比多打一次 caller-identity 便宜
function identityFromRefreshToken(refreshToken) {
  try {
    const parts = String(refreshToken || "").split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      domain_id: String(payload.domain_id || ""),
      user_id: String(payload.user_id || payload.uid || ""),
      user_name: String(payload.user_name || payload.name || ""),
    };
  } catch {
    return null;
  }
}

module.exports = {
  CLIENT_ID, TOKEN_URL, AUTHORIZE_URL, CALLBACK_PATH, PKCE_METHOD,
  exchangeAuthorizationCode, refreshCredential, buildAuthorizeUrl, identityFromRefreshToken,
};
