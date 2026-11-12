/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 号池 · MiniMax Code 协议基元（纯函数，零网络，离线可测）
//
// 为什么单独一层：MiniMax 的每个请求都要带一套「公共 query + x-timestamp + x-signature」，
// 而签名依赖 **body 原文**——只有真正发请求的那一层能算对。把基元收敛在这里，
// 适配器（额度/签到）与将来的自测共用同一份实现，避免两处各写一份签名后悄悄分叉。
//
// 事实基线（2026-11-12 本机 3.1.14 实测，见 docs/号池MiniMaxCode渠道接入方案-20261112.md §1.5）：
//   POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages   → 200，Anthropic Messages + SSE
//   GET  https://agent.minimax.cn/minimax-cloud/api/v1/signin/status → 200
//   鉴权只需 Authorization: Bearer <mmoat_…>；`yy` 是设备指纹，实测不带也 200，故不实现。
"use strict";

const crypto = require("node:crypto");

/** 区域表：区域是**凭据属性**，不是运行时开关（CN/INTL 两套账号体系互不通用）。
 *  国际版的登录态目录名尚未取证（方案 §6 不确定项 #1），因此调用方按 region 传值，
 *  目录到区域的映射由 discovery 侧枚举 auth/prod/* 决定，不在这里硬编码。 */
const ENDPOINTS = Object.freeze({
  cn: Object.freeze({
    base: "https://agent.minimax.cn",
    account: "https://account.minimax.cn",
    region: "cn",
  }),
  en: Object.freeze({
    base: "https://agent.minimax.io",
    account: "https://account.minimax.io",
    region: "en",
  }),
});

/** OAuth 常量：与客户端 `@mavis/oauth-core/dist/contracts.js` 逐字一致（client_id/scope/audience）。 */
const OAUTH = Object.freeze({
  clientId: "mcode-public",
  scope: "agent.default",
  audience: "agent-backend",
  grantType: "urn:ietf:params:oauth:grant-type:device_code",
  deviceCodePath: "/oauth2/device/code",
  tokenPath: "/oauth2/token",
  revokePath: "/oauth2/revoke",
});

/** 签名盐：上游客户端硬编码值。放参数而不是常量，是为了让规则文件（rules/headers.json）
 *  在换盐时能覆盖——上游一改盐，用户改文件即生效，不必等发版。 */
const DEFAULT_SIGN_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";

/** 客户端版本与 UA：上游按 UA/桌面版本做能力判定（与 3.1.14 实测一致）。 */
const CLIENT_DEFAULTS = Object.freeze({
  appVersion: "3.1.14",
  desktopVersion: "3.1.14",
  userAgent:
    "MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMax/3.1.14 Chrome/148.0.7778.280 Safari/537.36",
});

/**
 * 签名：`md5(秒级时间戳 + 盐 + body原文)`，小写 hex。
 * body 为 GET 时是空串；POST 必须是**实际发送的那一份字符串**（先 stringify 再签，签完不得再改）。
 */
function sign(tsSec, bodyString, salt = DEFAULT_SIGN_SALT) {
  const t = String(Math.floor(Number(tsSec) || 0));
  const body = bodyString == null ? "" : String(bodyString);
  return crypto.createHash("md5").update(t + (salt || DEFAULT_SIGN_SALT) + body).digest("hex");
}

/**
 * 账号级设备号：上游不校验 device_id 与账号的绑定（实测换任意值均 200），
 * 但号池里**每个账号一枚稳定值**是更安全的多账号姿势（共用一枚是典型风控特征）。
 * 取值：8 位十进制，由 uid 派生，确定性可复现（重装号池不会漂移）。
 */
function deviceIdOf(uid) {
  const seed = String(uid || "anon");
  const hex = crypto.createHash("sha256").update(`agenthub:minimax:${seed}`).digest("hex");
  // 取前 8 位 hex 转十进制再截断：避免出现前导 0 导致的 7 位
  return String(parseInt(hex.slice(0, 8), 16) % 90000000 + 10000000);
}

/**
 * 公共 query 参数（实测照抄客户端；缺字段会被上游按「非桌面端」降级处理）。
 * unix 是毫秒时间戳、uuid 每次请求随机——两者都不参与签名，可自由变化。
 */
function commonQuery(deviceId, opts = {}) {
  return {
    device_platform: "web",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    unix: String(opts.now || Date.now()),
    timezone_offset: "28800",
    is_desktop: "1",
    desktop_version: opts.desktopVersion || CLIENT_DEFAULTS.desktopVersion,
    sys_language: "zh",
    lang: "zh",
    uuid: opts.uuid || crypto.randomUUID(),
    device_id: String(deviceId || deviceIdOf("anon")),
    os_name: "Windows",
    browser_name: "Chrome",
    device_memory: "32",
    cpu_core_num: "20",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    user_id: "0",
    screen_width: "1920",
    screen_height: "1080",
    client: "desktop",
  };
}

/** query 对象 → URLSearchParams 串（按键名排序不稳，保持插入序，与客户端一致）。 */
function queryString(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) sp.set(k, String(v));
  return sp.toString();
}

/**
 * 控制面请求头（额度 / 签到 / 用户信息）：GET 无 body，签名用空串。
 * 与 chatHeaders 的差别只有 accept 与 content-type，签名口径完全一致。
 */
function apiHeaders({ token, ts, salt, userAgent, origin, extra } = {}) {
  const t = Math.floor(Number(ts) || Date.now() / 1000);
  return {
    authorization: `Bearer ${token}`,
    token: String(token || ""),
    "x-timestamp": String(t),
    "x-signature": sign(t, "", salt),
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": userAgent || CLIENT_DEFAULTS.userAgent,
    origin: origin || ENDPOINTS.cn.base,
    referer: `${(origin || ENDPOINTS.cn.base).replace(/\/+$/, "")}/`,
    ...(extra || {}),
  };
}

/**
 * 对话请求头。⚠️ `bodyString` 必须与 fetch 的 body **逐字节相同**——
 * 用同一份字符串签名与发送，是本渠道唯一的硬约束。
 */
function chatHeaders({ token, bodyString, ts, salt, userAgent, origin, extra } = {}) {
  const t = Math.floor(Number(ts) || Date.now() / 1000);
  return {
    authorization: `Bearer ${token}`,
    token: String(token || ""),
    "x-timestamp": String(t),
    "x-signature": sign(t, bodyString, salt),
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": userAgent || CLIENT_DEFAULTS.userAgent,
    origin: origin || ENDPOINTS.cn.base,
    referer: `${(origin || ENDPOINTS.cn.base).replace(/\/+$/, "")}/`,
    ...(extra || {}),
  };
}

/** 推理基址（Anthropic Messages 挂在 `/mavis/api/v1/llm` 下，完整路径再加 `/v1/messages`）。 */
function llmBase(region = "cn") {
  return `${(ENDPOINTS[region] || ENDPOINTS.cn).base}/mavis/api/v1/llm`;
}

/** 账号域基址（OAuth 设备码 / 刷新 / 吊销）。 */
function accountBase(region = "cn") {
  return (ENDPOINTS[region] || ENDPOINTS.cn).account;
}

module.exports = {
  ENDPOINTS,
  OAUTH,
  DEFAULT_SIGN_SALT,
  CLIENT_DEFAULTS,
  sign,
  deviceIdOf,
  commonQuery,
  queryString,
  apiHeaders,
  chatHeaders,
  llmBase,
  accountBase,
};
