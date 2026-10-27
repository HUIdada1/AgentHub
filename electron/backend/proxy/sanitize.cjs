/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 出站请求体脱敏（"敏感判断"）：剥离上游内容审核黑名单指纹。
//
// ── 背景 ────────────────────────────────────────────────────
// 客户端（Claude Code / Codex 这类 CLI）会在 system 提示词里注入若干固定模板句，
// 上游内容审核按**逐字精确匹配**拦截（不是语义审核），一字之差即可绕过。
// 策略：键值 / 表头型指纹整段剥离；承载语义的模板句最小改写（换一个词），语义不变。
//
// ── 规则集的顺序不能换 ──────────────────────────────────────
//   ① 改写层（要求原串完整，表头剥离会动到同一段文本的其它位置）
//   ② 表头键值整段删除
//   ③ cc_ 键值循环清理（一次替换可能因相邻键值的新边界又暴露出下一个）
//   ④ 残留裸键名最小缩写（键值形态已被删掉，只剩引用/示例文本里的裸键名）
//   ⑤ 去首尾空白
// ③ 必须在 ④ 之前：缩写会把键名改掉，之后再也认不出 cc_ 键值。
//
// ── 为什么不用「词表 + 零宽空格」那套 ────────────────────────
// 常见做法是「可维护词表 + 命中处插零宽空格(U+200B)」，本模块不采用，理由是实测口径：
//   · 零宽空格对数字类指纹无效（上游会归一化），`11128` 必须真的改成 `11-128`；
//   · 通用安全词表（malware / phishing 等）与真正触发拦截的**具体模板串**是两码事
//     —— 覆盖面看着大、命中率反而低。
// 于是规则集收敛成「7 条特征串 + 3 条正则 + 5 条改写」，全部可离线断言。
//
// ── 本模块只做纯文本变换 ─────────────────────────────────────
// 开关（localgw.fingerprintObfuscation）与调用时机都不在本模块：转发层每次出站前问一次配置，
// 开着才调 sanitizeBody()。本模块无状态、无 IO、不读配置，因此没有初始化顺序问题。
"use strict";

/** 特征预检：任一命中才进入净化（快速路径，普通请求全不中 → 原样返回、零拷贝）。
 *  匹配**大小写敏感**：
 *  这里列的都是小写 / 原样形态，混合大小写变体由 BARE_HDR_RE 兜底。 */
const FEATURES = [
  "x-anthropic-billing-header", // 表头键值段的键名
  "cc_entrypoint=", // 尾随裸键值（截断前缀即可命中）
  "You are Claude Code", // 身份句（截断前缀即可命中）
  "Main branch (", // 注入指令句（截断前缀即可命中）
  "You are a coding agent running in the Codex CLI", // Codex instructions 首段
  "github.com/anthropics/", // 反馈句里的 Anthropic 仓库链接
  "11128", // 上游反探测：裸数字错误码
];

/** 改写层：模板句逐字替换（每句只改一个词，语义不变）。
 *  身份句的匹配串**不带结尾标点**：CLI 版以句号收尾、桌面版（claude-desktop-3p /
 *  Agent SDK）以逗号接后继内容；带句号的整句只匹配前者，桌面版会漏网 → 400 code=11128。
 *  替换串同样不带标点，让原有标点原样保留。 */
const REWRITES = [
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)",
  ],
  [
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
  ],
  [
    // 反馈句：整句带 Anthropic 仓库链接，上游按整句拦截（只留链接或只留半边都不拦）。
    // give→provide 一词之差即可绕过，语义不变。
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  [
    // 上游反探测：请求体里出现裸数字 11128 就整单拦截（与上下文无关：
    // "code=11128" / 裸 "11128" / "错误码 11128" 全部命中；11148 / 11101 / 11115 / 99999 均放行）。
    // 11128 正是这类拦截自身的错误码，上游据此识别"在讨论 / 回显其内部错误码"的请求。
    // 代价：用户对话里任何 11128 都会被改写 —— 但这串数字出现在请求里本身就是拦截条件。
    // 插连字符保留可读性与指代（零宽空格无效，上游会归一化）。
    "11128",
    "11-128",
  ],
];

/** 命中标签：11128 与表头类指纹在界面上要有个短名字
 *  （完整模板句太长，请求日志的悬停面板里会糊成一片）。 */
const LABEL_BARE_HDR = "x-anthropic-billing-header";
const LABEL_KV = "cc_*=";

// ─── 正则（模块级编译一次，无状态）──────────────────────────
// 剥离层：表头键名即触发（与值无关），整段删除。
const HDR_RE = /x-anthropic-billing-header:[^;\n]*;?[\t\n\f\r ]*/gi;
// 兜底层：裸键名（无冒号无值）同样是指纹 —— 实测证实 assistant 消息里反引号引用裸键名
// 即触发 11128，而剥离层要求冒号、对裸串无效。
const BARE_HDR_RE = /x-anthropic-billing-header/gi;
// 剥离层：尾随裸键值（cc_xxx=...;）循环清理。
// \b 在 JS 里本就是 ASCII 语义（与 Go 的 (?-u:\b) 同口径），不需要额外处理。
const KV_RE = /\bcc_[a-z0-9_]+=[^;\n]*;?[\t\n\f\r ]*/gi;
// 预检用的 cc_ 键值探测：比 KV_RE 宽松（不消费值），只回答"这里有没有 cc_ 键值"。
// 最初只列了 `cc_entrypoint=` 一条 —— 那假设真实报文的尾随键值块里必然含这一项。
// 但本项目的界面承诺是「剥离 cc_* 自定义键」，只认一条会漏掉键值块里没有 cc_entrypoint
// 的形态，所以这里把预检放宽到任意 cc_ 键值；净化本身仍走 KV_RE（放宽的只是"要不要进净化"这道门）。
const KV_FEATURE_RE = /\bcc_[a-z0-9_]+=/;

/** 特征预检：先走 includes 快速路径；表头键名有大小写变体（X-Anthropic-…）
 *  且可能以裸键名形态出现（无冒号），includes 大小写敏感、HDR_RE 要求冒号 ——
 *  两者都会漏掉「混合大小写 + 裸键名」，必须再用不要求冒号的 BARE_HDR_RE 兜底。
 *  BARE_HDR_RE 是 HDR_RE 的超集，故无需再单独匹配后者。 */
function hasFingerprint(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return false;
  for (const f of FEATURES) if (s.includes(f)) return true;
  if (KV_FEATURE_RE.test(s)) return true;
  BARE_HDR_RE.lastIndex = 0; // 带 g 的正则有 lastIndex 状态，跨调用复用前必须归零
  return BARE_HDR_RE.test(s);
}

/** 单段文本净化。预检不中 → 原样返回（零分配）；命中时把规则标签记进 hits。
 *  hits 是 Map<label, count>，由调用方创建并最终转成可落库的数组。 */
function sanitizeText(text, hits) {
  if (typeof text !== "string" || !hasFingerprint(text)) return text;
  let out = text;
  for (const [from, to] of REWRITES) {
    if (out.includes(from)) {
      bump(hits, from);
      out = out.split(from).join(to);
    }
  }
  if (HDR_RE.test(out)) {
    HDR_RE.lastIndex = 0;
    bump(hits, LABEL_BARE_HDR);
    out = out.replace(HDR_RE, "");
  }
  HDR_RE.lastIndex = 0;
  if (out.includes("cc_")) {
    let prev = "";
    // 清尾随裸键值：一次替换可能因相邻键值的新边界又暴露出下一个，循环到不动为止
    while (prev !== out) {
      prev = out;
      KV_RE.lastIndex = 0;
      const next = out.replace(KV_RE, "");
      if (next !== out) bump(hits, LABEL_KV);
      out = next;
    }
  }
  KV_RE.lastIndex = 0;
  // 兜底：键值形态已在上面整段删除，这里只剩裸键名（引用 / 示例文本形态），做最小缩写
  BARE_HDR_RE.lastIndex = 0;
  if (BARE_HDR_RE.test(out)) {
    BARE_HDR_RE.lastIndex = 0;
    bump(hits, LABEL_BARE_HDR);
    out = out.replace(BARE_HDR_RE, "x-anthropic-billing-hdr");
  }
  BARE_HDR_RE.lastIndex = 0;
  return out.trim();
}

function bump(hits, label) {
  if (!hits) return;
  hits.set(label, (hits.get(label) || 0) + 1);
}

/** 净化 content：字符串，或多模态数组（只动带 `text` 字符串字段的分片）。
 *  **不判 type**：任何带 `text` 字符串的分片都过一遍。返回是否变化。 */
function sanitizeContent(value, hits) {
  if (typeof value === "string") {
    const next = sanitizeText(value, hits);
    return next !== value ? { changed: true, value: next } : { changed: false, value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      if (typeof part.text !== "string") return part;
      const next = sanitizeText(part.text, hits);
      if (next === part.text) return part;
      changed = true;
      return { ...part, text: next };
    });
    return { changed, value: changed ? out : value };
  }
  return { changed: false, value };
}

/** 净化 assistant.tool_calls[].function.arguments。
 *  arguments 是**字符串化的 JSON**（不是对象），按文本走 sanitizeText 即可。
 *  这块长期是盲区：工具调用消息的 content 通常是 null，早期实现在 content 缺失时
 *  直接跳过整条消息，于是历史里任何写进工具参数的被拦字符串（文件名、命令、写入内容）
 *  都会原样漏出。 */
function sanitizeToolCalls(value, hits) {
  if (!Array.isArray(value)) return { changed: false, value };
  let changed = false;
  const out = value.map((call) => {
    if (!call || typeof call !== "object") return call;
    const fn = call.function;
    if (!fn || typeof fn !== "object" || typeof fn.arguments !== "string") return call;
    const next = sanitizeText(fn.arguments, hits);
    if (next === fn.arguments) return call;
    changed = true;
    return { ...call, function: { ...fn, arguments: next } };
  });
  return { changed, value: changed ? out : value };
}

/** 净化 messages 中的 content、reasoning_content 与 tool_calls；任一命中返回 true。 */
function sanitizeMessages(messages, hits) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    // content 与 tool_calls 各自独立判断：content 可以为 null（工具调用轮），
    // 早期实现在这里跳过整条消息，导致这类消息的 tool_calls 完全不被净化。
    if (msg.content !== undefined) {
      const r = sanitizeContent(msg.content, hits);
      if (r.changed) { msg.content = r.value; changed = true; }
    }
    // reasoning_content（思维链回填字段）实测同样携带指纹，与 content 同等净化
    if (typeof msg.reasoning_content === "string") {
      const next = sanitizeText(msg.reasoning_content, hits);
      if (next !== msg.reasoning_content) { msg.reasoning_content = next; changed = true; }
    }
    if (msg.tool_calls !== undefined) {
      const r = sanitizeToolCalls(msg.tool_calls, hits);
      if (r.changed) { msg.tool_calls = r.value; changed = true; }
    }
  }
  return changed;
}

/** 净化整个请求体（浅拷贝一份再改 —— 不改调用方传进来的对象）。
 *  返回 null = **一个字节都没改**（调用方据此零拷贝沿用原始 body）；
 *  返回 { body, hits } = 改过的副本 + 命中的规则标签（按命中次数降序，同次数保持首次命中顺序）。
 *  无 messages 数组时原样返回 null：上游只认 messages 形态，别处（顶层 system、input 等）
 *  不是本规则集的作用面。 */
function sanitizeBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!Array.isArray(body.messages)) return null;
  let next;
  try {
    next = JSON.parse(JSON.stringify(body));
  } catch {
    return null; // 循环引用等异常形态：宁可不动，也不能把请求搞坏
  }
  const hits = new Map();
  let changed = false;
  try {
    changed = sanitizeMessages(next.messages, hits);
  } catch {
    return null;
  }
  if (!changed) return null;
  const list = [...hits.entries()].map(([label, count]) => ({ label, count }));
  // 按命中次数降序；同次数保持首次命中顺序（稳定排序，先命中的规则排在前面）
  list.sort((a, b) => b.count - a.count);
  return { body: next, hits: list };
}

/** 只判断不修改：请求体里是否存在指纹（用于"想知道会不会被拦但先不动它"的场景）。 */
function hasBodyFingerprint(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return false;
  try {
    return sanitizeMessages(JSON.parse(JSON.stringify(body)).messages, new Map());
  } catch {
    return false;
  }
}

/** 命中标签 → 一行摘要（落进请求日志的「敏」列，前端悬停展示）。
 *  例：`11-128×2 · x-anthropic-billing-header×1`；无命中返回空串。 */
function formatHits(hits) {
  if (!Array.isArray(hits) || !hits.length) return "";
  return hits
    .map((h) => (h && h.count > 1 ? `${h.label}×${h.count}` : String((h && h.label) || "")))
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);
}

module.exports = {
  hasFingerprint,
  hasBodyFingerprint,
  sanitizeText,
  sanitizeBody,
  formatHits,
  FEATURES,
  REWRITES,
};
