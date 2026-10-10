// CatPaw 上游 HTTP 传输层：请求头 / 短请求 / 状态回报 / 打断 / turn 建流
// （移植来源：参照实现 catpaw/upstream_http.rs）。
//
// 与其它渠道适配器的差别只有三点，都来自 CatPaw 的协议特性：
//   1. 请求头是 Cookie 形态（X-Passport-Token）而不是 Bearer；
//   2. 短响应要过 unwrapApiData（上游把业务码写在 code 字段里，HTTP 恒 200 也可能失败）；
//   3. turn 是 SSE：不读体、总超时 15 分钟。
//
// 客户端的 authorization / cookie **不透传**：代理凭证与客户端凭证是两套独立体系，
// 透传会把客户端的 key 泄露给上游。
"use strict";
const CatPawError = require("./errors.cjs");
const { unwrapApiData } = require("./openai.cjs");
const util = require("../util.cjs");

/** 上游「客户端身份」常量与端点（headers.json 的 catpaw 段可热改：客户端升级后改配置即生效，无需发版）。
 *  放配置而不是硬编码：toolVersion / X-Agent-Version 必须与真实客户端一致，上游按它们解释请求语义 */
const DEFAULT_CFG = {
  baseUrl: "https://ai.catpaw.meituan.com",
  source: "CatX",
  mode: "CATX_APP",
  toolVersion: "2.0.2",
  agentVersion: "1.0.1",
  appKey: "fe_com.sankuai.catpaw.external.front",
  permissionMode: "unsafeBypassPermissions",
  requestTimeoutMs: 30000,
  stopTimeoutMs: 3000,
  sseTimeoutMs: 15 * 60 * 1000,
};

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

/** 上游 base URL（CATPAW_UPSTREAM_BASE_URL 可覆盖——参照实现用它做本地联调） */
function upstreamBaseUrl() {
  const raw = String(process.env.CATPAW_UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
  return raw || String(settings().baseUrl).replace(/\/+$/, "");
}

/** 上游请求头集合（参照实现 createHeaders）：M-TRACEID 每请求新随机 UUID（去连字符） */
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
  return headers;
}

/** 带超时的 fetch（短请求用；turn 的流式读取在 turnRequest 里另设总预算） */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
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
  const text = await response.text().catch(() => "");
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

/** `event`：状态回报（running / completed / failed / canceled）；失败原因与业务码一起回报 */
async function reportStatus(baseUrl, credentials, conversationId, status, error) {
  const data = { status };
  if (error) {
    data.failReason = error.message;
    if (Number.isFinite(Number(error.code))) data.failCode = Number(error.code);
    if (Number.isFinite(Number(error.unifyCode))) data.unifyCode = Number(error.unifyCode);
  }
  const body = { conversationId, eventType: "conversation", data };
  return postJson(baseUrl, "/api/agent/conversation/event", credentials, body, settings().requestTimeoutMs);
}

/** 终态上报（**吞掉失败**）：终态上报失败不该把已经成功的轮次变成失败——
 *  客户端已经拿到完整回答了，它只影响上游侧状态机（下一轮 round 可能被拒，
 *  那条路径有 conversation.js 的「会话执行中自愈重试」兜底） */
async function reportTerminal(baseUrl, credentials, conversationId, status, error) {
  if (!conversationId) return;
  try {
    await reportStatus(baseUrl, credentials, conversationId, status, error);
  } catch (e) {
    require("./log.cjs").verbose(`终态 ${status} 上报失败: ${(e && e.message) || e}`);
  }
}

/** `turn/stop`：打断一个正在执行的轮次（尽力而为：失败只打日志，把它的失败报成请求失败会掩盖真正的错误） */
async function stopTurn(baseUrl, credentials, conversationId, turnRequestId) {
  if (!conversationId || !turnRequestId) return;
  const body = { conversationId, turnRequestId };
  try {
    await postJson(baseUrl, "/api/agent/conversation/turn/stop", credentials, body, settings().stopTimeoutMs);
  } catch (e) {
    require("./log.cjs").verbose(`turn/stop 失败: ${(e && e.message) || e}`);
  }
}

/** 发 turn 请求（SSE）：不读响应体（调用方逐 chunk 消费）；总超时 15 分钟。
 *  与 postJson 的差别：Accept 是 text/event-stream、不校验 body 内容、
 *  HTTP 非 2xx 在这里就失败（那时响应体是错误 JSON 而不是 SSE，读出来当文案比让执行层去解析更清楚） */
async function turnRequest(baseUrl, credentials, body) {
  const url = `${String(baseUrl || DEFAULT_CFG.baseUrl).replace(/\/+$/, "")}/api/agent/conversation/turn`;
  const timeoutMs = settings().sseTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: requestHeaders(credentials, "text/event-stream"),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") throw CatPawError.upstream(`上游 turn 超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw CatPawError.upstream(`上游请求失败: ${String((e && e.message) || e)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    clearTimeout(timer);
    const text = await response.text().catch(() => "");
    const detail = String(text || "").trim().slice(0, 500);
    throw CatPawError.http(response.status, detail ? `上游 turn HTTP ${response.status}: ${detail}` : `上游 turn HTTP ${response.status}`);
  }
  return { response, cancelTimer: () => clearTimeout(timer) };
}

module.exports = {
  settings,
  upstreamBaseUrl,
  requestHeaders,
  postJson,
  reportStatus,
  reportTerminal,
  stopTurn,
  turnRequest,
};
