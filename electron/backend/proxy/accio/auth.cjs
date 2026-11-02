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
// 反代网关 · Accio 请求封装与用户资料查询
//
// 与另外几家的差别：token 不进请求头。桌面端业务接口不走 Authorization ——
// GET 把 accessToken 拼进 query（GET /api/entitlement/quota?accessToken=…），
// POST 放进 JSON body（POST /api/auth/refresh_token {accessToken, refreshToken}）。
// 本模块把这个约定收在两处构造里（getWithToken / postJson），别处不再各写。
//
// 请求超时：业务接口（非转发）与另外几家同量级取 15s。
"use strict";

const endpoints = require("./endpoints.cjs");

const REQUEST_TIMEOUT_MS = 15000;

async function request(method, url, body, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await require("../netproxy.cjs").fetchThrough(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    throw Object.assign(
      new Error(timedOut ? "Accio 请求超时，请检查网络后重试" : "无法连接 Accio，请检查网络或账号代理设置"),
      { status: timedOut ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { ok: resp.ok, status: resp.status, data, text };
}

// GET + token 进 query（业务接口的约定之一）
async function getWithToken(channel, path, token, query) {
  const region = endpoints.regionOf(channel);
  const url = new URL(`${endpoints.gatewayBase()}${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.append(k, v);
  if (token) url.searchParams.append("accessToken", token);
  return request("GET", url.toString(), null, endpoints.apiHeaders(region));
}

// POST + JSON body（业务接口的约定之二）
async function postJson(channel, path, body) {
  const region = endpoints.regionOf(channel);
  return request("POST", `${endpoints.gatewayBase()}${path}`, body, endpoints.apiHeaders(region));
}

// 上游响应常见两层信封（{success, data:{…}}）；取内层
function unwrapData(payload) {
  const d = payload && payload.data;
  return d && typeof d === "object" && !Array.isArray(d) ? d : payload;
}

// 查用户资料（GET /api/auth/userinfo?accessToken=…）；资料在 data 里还是顶层两种形态都接受
async function fetchProfile(channel, token) {
  const response = await getWithToken(channel, endpoints.USER_INFO_PATH, token, {});
  if (!response.ok) {
    throw Object.assign(new Error(`Accio 用户信息查询失败（HTTP ${response.status}）`), { status: response.status });
  }
  return unwrapData(response.data);
}

// 把资料里的身份/名字取出来（宽键名）
function profileIdentity(profile) {
  const p = profile || {};
  const pick = (keys) => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return "";
  };
  return {
    userId: pick(["id", "userId", "user_id", "uid"]),
    name: pick(["nickname", "name", "displayName", "userName"]),
    email: pick(["email", "emailAddress"]),
    deviceId: pick(["deviceId", "device_id"]),
  };
}

module.exports = { request, getWithToken, postJson, unwrapData, fetchProfile, profileIdentity, REQUEST_TIMEOUT_MS };
