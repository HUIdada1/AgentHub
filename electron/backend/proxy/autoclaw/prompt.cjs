// 反代网关 · AutoClaw 出站 body 规范化（参照实现 providers/autoclaw/prompt.rs + adapter.rs）
//
// 上游三道闸门里的两道在 body 上，必须出站前处理：
//   ① system 提示词白名单——system/developer 首句必须以 OpenClaw 身份句开头且带 ## Tooling 段，
//      含外来 harness 身份句（ZCode/Claude Code/Codex/DeepSeek…）一律 406 空响应体；
//      身份句放进 user 消息不拦（闸门只看 system/developer）。
//   ② max_tokens 归一——30~8192 的小正整数一律 406；不传或 ≥10000 则 200（下界在 8192 与 10000 之间）。
// 三道闸门的第三道在请求头上（LLM 域禁发 X-Harness-Type / 禁发 X-Tm: linux），见 headers.cjs。
"use strict";

/** 身份句（上游逐字指纹）；IDENTITY_PREFIX 是保证过闸的最小 system 前缀 */
const IDENTITY_LINE = "You are a personal assistant running inside OpenClaw.";
const IDENTITY_PREFIX =
  "You are a personal assistant running inside OpenClaw.\n\n" +
  "## Tooling\n" +
  "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n";

/**
 * 外来 harness 身份句改写表。三条纪律（照参照实现，顺序不能乱）：
 *   · 长的在前——短串在前会把长匹配切碎，改写后仍残留产品名；
 *   · 替换串都不得含任何产品名（插词不够用，必须整名去掉）；
 *   · 匹配忽略 ASCII 大小写（用逐字符小写比较，不能用 toLowerCase 整串折叠——
 *     Unicode 折叠会改变串长导致错位）。
 */
const FOREIGN_IDENTITIES = [
  ["You are CodeBuddy Code", "You are an interactive coding assistant"],
  ["You are CodeBuddy", "You are a coding assistant"],
  ["You are an interactive agent in TraeCode", "You are an interactive coding agent"],
  ["You are ZCode, an interactive coding agent", "You are an interactive coding agent"],
  ["You are a coding agent running in the Codex CLI tool", "You are a coding agent running in a terminal CLI tool"],
  ["You are a coding agent running in the Codex CLI", "You are a coding agent running in a terminal CLI"],
  ["You are running as a coding agent in the Codex CLI", "You are running as a coding agent in a terminal CLI"],
  ["You are Claude Code", "You are a coding assistant"],
  ["You are ZCode", "You are an interactive coding agent"],
  ["You are an AI agent powered by DeepSeek Harness", "You are an AI agent powered by a local coding harness"],
  ["You are Codex", "You are a coding agent"],
];

/** ASCII 折叠（单字符）：只折叠 A-Z，非 ASCII 字符原样返回——
 *  Unicode 折叠（toLowerCase）会改变串长（如 İ U+0130 折叠成 2 字符），导致下标错位 */
function asciiFoldChar(c) {
  return c >= "A" && c <= "Z" ? String.fromCharCode(c.charCodeAt(0) + 32) : c;
}

function asciiFold(s) {
  let r = "";
  for (let i = 0; i < s.length; i++) r += asciiFoldChar(s[i]);
  return r;
}

/** ASCII 大小写不敏感的子串替换：命中全部替换，替换产物不再被检查（从匹配处之后继续，无死循环）。
 *  逐字符滑窗 + ASCII 折叠比较（对齐注释纪律与参照实现 eq_ignore_ascii_case）：
 *  needle 是纯 ASCII（长度稳定），haystack 含 Unicode 扩展字符时下标仍与原文对齐 */
function replaceIgnoringCase(text, needle, replacement) {
  const n = needle.length;
  if (!n || n > text.length) return text;
  const target = asciiFold(needle);
  const first = target[0];
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (asciiFoldChar(text[i]) === first) {
      const slice = text.slice(i, i + n);
      if (slice.length === n && asciiFold(slice) === target) {
        out += replacement;
        i += n;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** 对一段文本做外来身份句改写（未命中返回原串引用，不新分配） */
function rewriteForeignIdentities(text) {
  let out = text;
  for (const [needle, replacement] of FOREIGN_IDENTITIES) {
    const next = replaceIgnoringCase(out, needle, replacement);
    if (next !== out) out = next;
  }
  return out;
}

/** system/developer 消息的 content 三形态统一改写（字符串 / parts 数组 / 其它原样） */
function rewriteMessageContent(content) {
  if (typeof content === "string") return rewriteForeignIdentities(content);
  if (Array.isArray(content)) {
    let changed = false;
    const out = content.map((part) => {
      if (part && typeof part === "object" && typeof part.text === "string") {
        const next = rewriteForeignIdentities(part.text);
        if (next !== part.text) changed = true;
        return next === part.text ? part : {...part, text: next};
      }
      return part;
    });
    return changed ? out : content;
  }
  return content;
}

/** 给一条 system 消息前置身份前缀（幂等判据：content 首句已是 IDENTITY_LINE 则不动） */
function prependPrefixToMessage(msg) {
  const content = msg.content;
  if (typeof content === "string") {
    if (content.startsWith(IDENTITY_LINE)) return;
    msg.content = IDENTITY_PREFIX + "\n" + content;
    return;
  }
  if (Array.isArray(content)) {
    const idx = content.findIndex((p) => p && typeof p === "object" && typeof p.text === "string");
    if (idx >= 0) {
      if (content[idx].text.startsWith(IDENTITY_LINE)) return;
      content[idx] = {...content[idx], text: IDENTITY_PREFIX + "\n" + content[idx].text};
    } else {
      // 数组里没有任何文本 part：头部插入一个（前缀必须落在文本位上才被闸门读到）
      content.unshift({type: "text", text: IDENTITY_PREFIX});
    }
    return;
  }
  msg.content = IDENTITY_PREFIX;
}

/**
 * system 提示词规范化（就地修改 body.messages；只动 system/developer，其余角色一字不动）：
 *   第一遍：全部 system/developer 消息做外来身份句改写；
 *   第二遍：首条消息是 system/developer → 对它前置身份前缀；
 *           否则在 messages[0] 位置插入一条 {"role":"system","content":IDENTITY_PREFIX}。
 * 幂等：重复调用（降级重试/同渠道重发）不会写两遍前缀。
 */
function normalizeSystemMessages(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return body;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") m.content = rewriteMessageContent(m.content);
  }
  const first = messages[0];
  if (first && typeof first === "object" && (first.role === "system" || first.role === "developer")) {
    prependPrefixToMessage(first);
  } else {
    messages.unshift({role: "system", content: IDENTITY_PREFIX});
  }
  return body;
}

/** max_tokens 归一门槛：0 < v < 10000 的 JSON 整数才改写为 10000 */
const MAX_TOKENS_FLOOR = 10000;

/**
 * max_tokens 归一（就地改写）：
 *   · 改：max_tokens 是 JSON number、有限整数、且 0 < v < 10000 → 原地写 10000；
 *   · 不改：字段缺失（**不注入**——上游对缺省 200，凭空注入反而改变行为）、
 *     ≥10000、0/负数/null/字符串/浮点一律原样（参照实现只认 JSON number 类型，
 *     不做 Number() 强转——字符串 "4096" 改写反而是行为变更）；max_completion_tokens 不参与。
 */
function normalizeMaxTokens(body) {
  if (!body || typeof body !== "object") return body;
  const v = body.max_tokens;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v >= MAX_TOKENS_FLOOR) return body;
  body.max_tokens = MAX_TOKENS_FLOOR;
  return body;
}

module.exports = {
  IDENTITY_LINE,
  IDENTITY_PREFIX,
  FOREIGN_IDENTITIES,
  MAX_TOKENS_FLOOR,
  normalizeSystemMessages,
  normalizeMaxTokens,
  replaceIgnoringCase,
};
