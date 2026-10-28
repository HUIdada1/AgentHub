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
// 反代网关 · AutoClaw 两域请求头（协议事实：signed_auth_headers + brandHeaders）
//
// LLM 对话域与 userapi 域是两个站点，头集合刻意不一致，三处最易踩：
//   ① X-Authorization（LLM 域认证头）不是 Authorization；userapi 域用小写 authorization。
//   ② X-Harness-Type: zcode —— LLM 域**禁发**（上游对它 403 pay-view code 810001 / 406），
//      userapi 域**必须发**（与 X-Auth-Sign 共同构成官方客户端指纹，删了有 400002 风险）。
//   ③ X-Tm —— LLM 域发 "win"（上游只拒恰好等于 "linux" 的值：被绑 Windows 的国际版账号
//      收到 X-Tm: linux 一律 403）；userapi 域按宿主平台如实发（win/linux）。
"use strict";
const crypto = require("node:crypto");

/** X-Auth-Sign：MD5(`${appId}&${秒级时间戳}&${appKey}`) 小写十六进制。时间戳单位是秒（毫秒会 400002） */
function authSign(appId, appKey, nowMs) {
  const ts = Math.max(0, Math.floor((nowMs || Date.now()) / 1000));
  return {
    ts: String(ts),
    sign: crypto.createHash("md5").update(`${appId}&${ts}&${appKey}`).digest("hex"),
  };
}

/** 平台值：恒不发 "linux"（LLM 域）——非 Windows 宿主回落 win，与 platform_tm 同口径 */
function llmPlatformTm() {
  return process.platform === "darwin" ? "mac" : "win";
}

/** LLM 对话请求头（POST {userapiBase}{llmProxyPath}/chat/completions）。
 *  sessionHeaders：客户端带的三个会话透传头（x-autoclaw-session-id 等），带了才发 */
function llmHeaders(cfg, token, routeModelId, sessionHeaders) {
  return {
    "content-type": "application/json",
    accept: "*/*",
    "x-product": "autoclaw",
    "x-client-type": "pc",
    "x-tm": llmPlatformTm(),
    // 版本对齐（12 §6.4）：客户端 X-Version = app.getVersion() = 2.2.0（原兜底 1.17.8 已过期）
    "x-version": cfg.llmVersion || "2.2.0",
    "x-lang": "zh-CN",
    "x-channel": "official",
    // brandHeaders 的原样字面量：小写 x + 下划线，值固定
    x_trace_id: "autoclaw-desktop",
    "x-authorization": `Bearer ${token}`,
    "x-request-id": crypto.randomUUID(),
    "x-request-model": routeModelId,
    ...(sessionHeaders && Object.keys(sessionHeaders).length ? sessionHeaders : {}),
  };
}

/** userapi 域签名头（刷新/签到/余额/目录/登录/资料共用）。token 为空串时不带 authorization（匿名形态） */
function signedAuthHeaders(cfg, token) {
  const { ts, sign } = authSign(cfg.authAppId || "100003", cfg.authAppKey || "", Date.now());
  return {
    "content-type": "application/json",
    accept: "*/*",
    // 版本对齐（12 §6.4）：两个域**共用同一个** gE() 头构造器，故 apiVersion 兜底同样是 2.2.0
    "x-version": cfg.apiVersion || "2.2.0",
    "x-product": "autoclaw",
    "x-client-type": "pc",
    "x-harness-type": "zcode",
    "x-tm": process.platform === "win32" ? "win" : "linux",
    "x-lang": "zh-CN",
    "x-channel": "official",
    "x-auth-appid": String(cfg.authAppId || "100003"),
    "x-auth-timestamp": ts,
    "x-auth-sign": sign,
    "x-trace-id": crypto.randomUUID(),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** 客户端会话透传头提取：OpenAI 兼容客户端的自定义头 → 上游三头（带了才透传，值为原值） */
const SESSION_HEADER_MAP = [
  ["x-autoclaw-session-id", "X-Session-Id"],
  ["x-autoclaw-agent-id", "X-Agent-Id"],
  ["x-autoclaw-zcode-invocation-id", "X-ZCode-Invocation-Id"],
];

function sessionPassthroughHeaders(clientHeaders) {
  const out = {};
  if (!clientHeaders || typeof clientHeaders !== "object") return out;
  for (const [from, to] of SESSION_HEADER_MAP) {
    for (const key of Object.keys(clientHeaders)) {
      if (key.toLowerCase() === from) {
        const v = String(clientHeaders[key] || "").trim();
        if (v) out[to] = v;
      }
    }
  }
  return out;
}

module.exports = { authSign, llmHeaders, signedAuthHeaders, sessionPassthroughHeaders, llmPlatformTm, SESSION_HEADER_MAP };
