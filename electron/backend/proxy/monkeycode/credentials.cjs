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
// 反代网关 · MonkeyCode 凭据：粘贴 session + 建任务所需的身份材料
//
// 登录形态只有「粘贴 session」一条，这是有意取舍：上游的密码登录要验证码，OAuth 要滑块 + 短信
// —— 两条都不适合网关代跑，而从浏览器复制 session cookie 是最省事也最可靠的一路。因此本渠道
// 不需要登录窗口，也就没有登录回调域名白名单这回事。
//
// session 30 天硬上限、上游没有续期接口，过期只能重新粘贴；凭据里的 imageId（任务容器镜像 UUID）
// 与 userId 存在账号 meta 上：imageId 由「查最近任务」自动发现，新号一个任务都没跑过时取不到，
// 需要用户在浏览器 DevTools 的建任务请求里抄一份填进来。
"use strict";

const endpoints = require("./endpoints.cjs");

/** session 是 JWT 形态的长串；超过这个长度基本是把整行甚至整段贴进来了 */
const MAX_SESSION_LENGTH = 8000;

/** 过长的值一律当「贴错了东西」拒掉：session 是 JWT 形态，超过这个长度基本是把整段 Cookie 表
 *  甚至文件内容粘进来了。宁可在这里判无效（转发时给「缺少 session」的可读文案），
 *  也不把超长值发给上游换回一个看不懂的 401。 */
function bounded(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_SESSION_LENGTH) return "";
  return text;
}

/** 从各种粘贴形态里剥出裸值：`monkeycode_ai_session=<v>` / `Cookie: a=1; …` / JSON 对象 / 纯值。
 *  统一剥裸值的理由写在口径里：把整行当 cookie 值发给上游会稳定 401，而且报错看不出是格式问题。 */
function normalizeSession(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return "";
  // 形态一：JSON 对象（含常见键名别名）
  if (raw.startsWith("{") || raw.startsWith("[")) {
    const found = bounded(pickSessionFromJson(parseJsonLoose(raw)));
    if (found) return found;
  }
  // 形态二：带 cookie 名前缀（可能前面还有 "Cookie:"）
  const text = raw.replace(/^cookie\s*:\s*/i, "");
  const wanted = endpoints.SESSION_COOKIE_NAME.toLowerCase();
  for (const segment of text.split(";")) {
    const at = segment.indexOf("=");
    if (at < 0) continue;
    const name = segment.slice(0, at).trim().toLowerCase();
    const value = segment.slice(at + 1).trim();
    if (name === wanted && value) return bounded(value.replace(/^"|"$/g, ""));
  }
  // 形态三：裸值（含 '=' 但不是本渠道的 cookie 名 → 视为贴错了东西，不发出去）
  if (text.includes("=")) return "";
  return bounded(text);
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** JSON 形态里的 session 键位别名；数组按 Cookie 编辑器导出的 [{name,value}] 处理 */
function pickSessionFromJson(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const name = String((item && item.name) || "").trim().toLowerCase();
      if (name === endpoints.SESSION_COOKIE_NAME && item && item.value) return String(item.value).trim();
    }
    return "";
  }
  if (!node || typeof node !== "object") return "";
  for (const key of ["session", "accessToken", "token", "monkeycode_ai_session"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (node.data && typeof node.data === "object") return pickSessionFromJson(node.data);
  return "";
}

/**
 * 从账号凭据（secrets = { token, refreshToken, meta }）取本渠道需要的三件东西。
 * session 落在 token 字段；imageId / userId 落在 meta（不是凭据本体，是建任务参数与展示身份）。
 */
function snapshot(secrets) {
  const session = normalizeSession(secrets && secrets.token);
  const meta = (secrets && secrets.meta) || {};
  return {
    session,
    imageId: String(meta.imageId || meta.image_id || "").trim(),
    userId: String(meta.userId || meta.user_id || "").trim(),
    accountId: String((secrets && secrets.accountId) || meta.accountId || "").trim(),
  };
}

/** 展示用尾段：session 末 4 位（够辨认是哪个号，不够冒用） */
function tokenTail(session) {
  const text = String(session || "");
  return text.length <= 4 ? "" : text.slice(-4);
}

module.exports = { normalizeSession, snapshot, tokenTail, MAX_SESSION_LENGTH, pickSessionFromJson };
