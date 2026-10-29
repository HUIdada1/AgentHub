/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MonkeyCode 上游端点与出站头
//
// 网页与 API 同域（站点自身的前端就是这些接口的调用方），所以 Origin/Referer 伪装成站点自身。
// UA 用可辨识的自定义值：上游对**陌生 UA** 加风控，而对这种"网关自报身份"的形态是有意的选择
// —— 冒充浏览器 UA 会让风控判定依赖指纹细节，一升级就整渠道失效。
//
// WebSocket 握手刻意**不发 Referer**、也**不手写 Sec-WebSocket-Key/Version/Extensions**：
// 那三件套由 WebSocket 库自己生成（手写的 key 若与库的掩码状态不一致，握手直接失败）。
"use strict";

const regionStore = require("./region.cjs");

/** 普通用户会话 Cookie；30 天硬限制、HttpOnly + Secure + SameSite=Lax、**不可续期** */
const SESSION_COOKIE_NAME = "monkeycode_ai_session";
/** 团队会话 Cookie：只是登记在册，本网关不接这一路（团队是另一套端点与账号体系）。
 *  写在这里是为了让人一眼看出"把它当普通 cookie 用"是错的 */
const TEAM_SESSION_COOKIE_NAME = "monkeycode_ai_team_session";

const USER_STATUS_PATH = "/api/v1/users/status";
const MODELS_PATH = "/api/v1/users/models";
const TASKS_PATH = "/api/v1/users/tasks";
const TASKS_DISCOVER_QUERY = "?page=1&size=5";
const TASK_STREAM_PATH = "/api/v1/users/tasks/stream";

/** 宿主机名：公共站点固定这一个值；自建/私有云的宿主名不同，用规则文件或环境变量覆盖 */
const DEFAULT_HOST_ID = "public_host";

const USER_AGENT = "monkeycode-local-proxy";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

// 只有 WebSocket 握手在这里定额：握手没完成时任务流的空闲计时还没开始走，必须有独立的兜底
// （上限取 forwarder 的外层超时之内，否则报错归属会含糊）。其余 HTTP 短请求走 adapters 的
// 共用超时（proxy.httpJsonTimeoutMs），任务流总时长与 resource.life 对齐，都见 stream.cjs。
const WS_CONNECT_TIMEOUT_MS = 30000;

function cookieHeader(session) {
  return `${SESSION_COOKIE_NAME}=${session}`;
}

/** 站内 JSON 请求的公共头（Cookie 由调用方补，因为 Origin/Referer 要按站点真身而不是基址） */
function jsonHeaders(region, section) {
  const origin = region.siteOrigin;
  return {
    "User-Agent": String((section && section.userAgent) || USER_AGENT),
    Origin: origin,
    Referer: `${origin}/`,
    Accept: "application/json",
  };
}

/** 任务流握手头：站点前端发起的形态，Cookie 放这里 */
function wsHeaders(region, session, section) {
  return {
    "User-Agent": String((section && section.userAgent) || USER_AGENT),
    "Accept-Language": ACCEPT_LANGUAGE,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Origin: region.siteOrigin,
    Cookie: cookieHeader(session),
  };
}

/** mode=new：本次请求新建一个任务轮次（上游另有 attach 语义，本渠道每次都用新会话，不做接续） */
function taskStreamUrl(region, section, taskId, mode) {
  const base = regionStore.toWsScheme(regionStore.baseUrl(region, section));
  return `${base}${TASK_STREAM_PATH}?id=${encodeURIComponent(taskId)}&mode=${mode || "new"}`;
}

/**
 * 目录里的 interface_type 决定任务容器里装哪个 coding agent，也就决定建任务的 cli_name。
 * 未知/缺失回落 opencode——那是最通用的一档，不是随手默认值。
 */
function cliNameFor(interfaceType) {
  const t = String(interfaceType || "").trim().toLowerCase();
  if (t === "openai_responses") return "codex";
  if (t === "anthropic") return "claude";
  return "opencode";
}

function hostId(region, section) {
  const fromRules = String((section && section.hostId) || "").trim();
  if (fromRules) return fromRules;
  return String(process.env[`${region.envPrefix}HOST_ID`] || "").trim() || DEFAULT_HOST_ID;
}

module.exports = {
  SESSION_COOKIE_NAME,
  TEAM_SESSION_COOKIE_NAME,
  USER_STATUS_PATH,
  MODELS_PATH,
  TASKS_PATH,
  TASKS_DISCOVER_QUERY,
  TASK_STREAM_PATH,
  DEFAULT_HOST_ID,
  USER_AGENT,
  WS_CONNECT_TIMEOUT_MS,
  cookieHeader,
  jsonHeaders,
  wsHeaders,
  taskStreamUrl,
  cliNameFor,
  hostId,
};
