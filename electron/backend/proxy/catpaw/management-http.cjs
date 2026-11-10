/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Short management requests only; no model task, turn, SSE or stop implementation.
"use strict";
const CatPawError = require("./errors.cjs");
const { unwrapApiData } = require("./api-envelope.cjs");
const util = require("../util.cjs");
const outboundHook = require("../outbound-hook.cjs");
const DEFAULT_CFG = { baseUrl: "https://ai.catpaw.meituan.com", agentVersion: "1.0.1", appKey: "fe_com.sankuai.catpaw.external.front", requestTimeoutMs: 30000 };


/** 合并配置（rules 不可用时回落默认值——协议层绝不能因为配置读不出来就崩） */
function settings() {
  let raw = null;
  try {
    const wb = require("../rules.cjs").get("headers.json") || {};
    raw = wb.catpaw && typeof wb.catpaw === "object" ? wb.catpaw : null;
  } catch {
    raw = null;
  }
  const merged = { ...DEFAULT_CFG };
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
  }
  return merged;
}


/** 上游 base URL（CATPAW_UPSTREAM_BASE_URL 可覆盖——本地联调用） */
function upstreamBaseUrl() {
  const raw = String(process.env.CATPAW_UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
  return raw || String(settings().baseUrl).replace(/\/+$/, "");
}


/** 上游请求头集合（createHeaders）：M-TRACEID 每请求新随机 UUID（去连字符） */
function requestHeaders(credentials, accept) {
  const cfg = settings();
  const headers = {
    Accept: accept,
    "Content-Type": "application/json",
    "M-TRACEID": util.uuid().replace(/-/g, ""),
    "M-APPKEY": String(cfg.appKey),
    "gray-set": "new-agent-sdk",
    enableHeartBeat: "true",
    "X-Agent-Version": String(cfg.agentVersion),
  };
  const token = String((credentials && credentials.token) || "").trim();
  if (token) headers.Cookie = `X-Passport-Token=${token}`;
  const uid = String((credentials && credentials.uid) || "").trim();
  if (uid) headers["user-uid"] = uid;
  // 出站头覆盖的唯一落点：postJson / turnRequest 都从这里取头，挂一处即全覆盖。
  // 无 ALS 上下文时 applyHeaders 原样返回，故号池自身调用 CatPaw 的行为不变。
  return outboundHook.applyHeaders(headers);
}


/** 带超时的 fetch（短请求用；turn 的流式读取在 turnRequest 里另设总预算） */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await require("../netproxy.cjs").fetchThrough(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw CatPawError.upstream(`上游请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw CatPawError.upstream(`上游请求失败: ${String((e && e.message) || e)}`);
  } finally {
    clearTimeout(timer);
  }
}


/** 一次「一问一答」类型的上游 POST：发请求 → 读体 → 校验 HTTP → unwrapApiData */
async function postJson(baseUrl, path, credentials, body, timeoutMs) {
  const url = `${String(baseUrl || DEFAULT_CFG.baseUrl).replace(/\/+$/, "")}${path}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: requestHeaders(credentials, "application/json"),
    body: JSON.stringify(body),
  }, timeoutMs || settings().requestTimeoutMs);
  const status = response.status;
  const text = await require("../transport-context.cjs").readText(response, 8 * 1024 * 1024, timeoutMs || settings().requestTimeoutMs);
  if (status < 200 || status >= 300) {
    const detail = String(text || "").trim().slice(0, 500);
    throw CatPawError.http(status, detail ? `上游 ${path} HTTP ${status}: ${detail}` : `上游 ${path} HTTP ${status}`);
  }
  if (!text.trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return unwrapApiData(parsed);
}
module.exports = { settings, upstreamBaseUrl, requestHeaders, postJson };
