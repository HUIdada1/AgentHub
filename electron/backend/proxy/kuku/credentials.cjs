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
// 反代网关 · KukuAI 凭证：Cookie 解析 / 序列化 / 出站请求头
//
// 认证只需要 Cookie，没有 Bearer、没有签名、没有续期：
//   BDUSS   百度通行证登录态，**必填**
//   STOKEN  业务会话令牌，必须是「按产品签发」的那一份（见 engine.cjs）
//   gfprotpl=genflowpro  恒定值，不入库，拼 Cookie 头时固定附加
// 同一登录会话里的其它 Cookie（BAIDUID / BAIDUID_BFESS / PTOKEN …）收在 extras 里一并保留。
//
// extras 为什么必须留：
//   1. 对话类业务接口校验的是完整浏览器会话，只带上面三件会被判「未登录」；
//   2. 通行证级 STOKEN 过不了业务门，而换发产品级 STOKEN 的必要材料正是 extras 里的 PTOKEN。
// 也就是说：症状是「余额查得到、模型拉不下来」（余额类接口只看 BDUSS），根因在会话作用域。
//
// 落库形态：账号的 token 字段存**整段 Cookie 头串**（含 extras），解析时再拆回三件套 + extras。
// 这样 extras 随凭据一起进出加密存储，不需要第二份字段，也不会出现「凭据更新了但会话材料是旧的」。
"use strict";

const endpoints = require("./endpoints.cjs");

/** BDUSS 最短长度：只拦明显残缺的粘贴（真值远长于此），不做格式校验 */
const MIN_BDUSS_LENGTH = 8;

/** 恒附加项与主字段：任何解析路径都要把它们从 extras 里剔掉，否则会重复出现 */
const RESERVED_COOKIES = ["bduss", "stoken", "gfprotpl"];
function isReserved(name) {
  const lower = String(name || "").toLowerCase();
  return RESERVED_COOKIES.indexOf(lower) >= 0;
}

function pushExtra(extras, name, value) {
  if (isReserved(name)) return;
  // 按名去重（大小写不敏感）：同一份 Cookie 里出现两次同名时，先出现的为准
  for (const [existing] of extras) {
    if (existing.toLowerCase() === String(name).toLowerCase()) return;
  }
  extras.push([String(name), String(value)]);
}

/** 消化一对 name=value：值里允许再出现 '='，只在第一个 '=' 处切 */
function takePair(extras, name, value) {
  const n = String(name || "").trim();
  const v = String(value || "").trim();
  if (!n || !v) return;
  if (n.toLowerCase() === "bduss") {
    if (!extras.bduss) extras.bduss = v;
  } else if (n.toLowerCase() === "stoken") {
    if (!extras.stoken) extras.stoken = v;
  } else {
    pushExtra(extras.list, n, v);
  }
}

function blankResult() {
  return { bduss: "", stoken: "", list: [] };
}

/** 形态一：整段 Cookie 头 `BDUSS=…; STOKEN=…; …` */
function fromCookieText(text) {
  const out = blankResult();
  for (const segment of String(text || "").split(";")) {
    const at = segment.indexOf("=");
    if (at < 0) continue;
    takePair(out, segment.slice(0, at), segment.slice(at + 1));
  }
  return out;
}

/** 形态二：Cookie 编辑器导出的 `[{name, value}, …]` */
function fromCookieArray(items) {
  const out = blankResult();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    takePair(out, item.name, item.value);
  }
  return out;
}

/** 形态三：平铺对象 `{BDUSS, STOKEN, …}`（值只认字符串，数字/嵌套跳过） */
function fromCookieObject(object) {
  const out = blankResult();
  for (const [key, value] of Object.entries(object)) {
    if (typeof value !== "string") continue;
    takePair(out, key, value);
  }
  return out;
}

/** 对象形态里的嵌套兜底键：按顺序试，第一个拿到 BDUSS 或 STOKEN 的为准 */
const NESTED_KEYS = ["auth", "cookie", "cookies", "credentials", "bduss_list"];

function credentialsFromPayload(payload) {
  let parts = blankResult();
  if (typeof payload === "string") {
    parts = fromCookieText(payload);
  } else if (Array.isArray(payload)) {
    parts = fromCookieArray(payload);
  } else if (payload && typeof payload === "object") {
    parts = fromCookieObject(payload);
    if (!parts.bduss && !parts.stoken) {
      for (const key of NESTED_KEYS) {
        const inner = payload[key];
        if (typeof inner === "string") parts = fromCookieText(inner);
        else if (Array.isArray(inner)) parts = fromCookieArray(inner);
        else if (inner && typeof inner === "object") parts = fromCookieObject(inner);
        else continue;
        if (parts.bduss || parts.stoken) break;
      }
    }
  }
  if (String(parts.bduss || "").trim().length < MIN_BDUSS_LENGTH) {
    throw new Error("缺少有效的 BDUSS（可粘贴 Cookie 头、Cookie 编辑器导出的 JSON 数组，或 {BDUSS, STOKEN} 对象）");
  }
  return {
    bduss: String(parts.bduss).trim(),
    stoken: String(parts.stoken || "").trim(),
    extras: parts.list,
  };
}

/** 反序列化账号里存的 Cookie 头串；解析不出有效 BDUSS 时返回 null（调用方给重新登录的文案） */
function parseCookieHeader(text) {
  try {
    return credentialsFromPayload(text);
  } catch {
    return null;
  }
}

/** 拼出站 Cookie 头：核心两件 → extras → 恒附加项。顺序与客户端一致，别改成字典序 */
function cookieHeader(cred) {
  const parts = [`BDUSS=${cred.bduss}`];
  if (cred.stoken) parts.push(`STOKEN=${cred.stoken}`);
  for (const [name, value] of cred.extras || []) parts.push(`${name}=${value}`);
  parts.push("gfprotpl=genflowpro");
  return parts.join("; ");
}

/** 展示用尾段：BDUSS 末 8 位；过短就不给（避免把整值当尾秀出去） */
function tokenTail(cred) {
  const bduss = String((cred && cred.bduss) || "");
  if (bduss.length <= MIN_BDUSS_LENGTH) return "";
  return bduss.slice(-8);
}

/** extras 里取 PTOKEN（通行证换发业务令牌的必要材料），影子项 PTOKEN_BFESS 兜底 */
function ptokenOf(extras) {
  const pick = (want) => {
    for (const [name, value] of extras || []) {
      if (name.toLowerCase() === want && String(value).trim()) return String(value).trim();
    }
    return "";
  };
  return pick("ptoken") || pick("ptoken_bfess");
}

/**
 * 出站通用请求头：Cookie + UA + 同源 Referer/Origin + 中文 Accept-Language。
 * 刻意**不**补 sec-fetch-* / sec-ch-ua 那一套：上游不读它们，多写反而与真实客户端的头部集合不一致。
 * app_id / clienttype / web / channel / version 一律走 query 与请求体里的 client_added，不作为头发出。
 */
function requestHeaders(cred, accept) {
  const headers = {
    Cookie: cookieHeader(cred),
    "User-Agent": endpoints.USER_AGENT,
    Referer: endpoints.referer(),
    Origin: endpoints.baseUrl(),
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (accept) headers.Accept = accept;
  return headers;
}

module.exports = {
  MIN_BDUSS_LENGTH,
  credentialsFromPayload,
  parseCookieHeader,
  cookieHeader,
  tokenTail,
  ptokenOf,
  requestHeaders,
};
