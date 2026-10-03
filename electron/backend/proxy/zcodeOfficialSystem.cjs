"use strict";
/**
 * ZCode 官方客户端 system 提示词前缀（官方客户端检测，防 405/3012）
 *
 * 背景：zcode 的 start-plan 出线 https://zcode.z.ai/api/v1/zcode-plan/anthropic 对 system
 * 不以官方 ZCode 智能体提示词开头的请求，一律返回 HTTP 405 + code 3012
 * "request has been blocked due to unusual activity"。二分实测：
 *   · 门禁是**真文本前缀匹配**，不是长度启发式——官方块1 + 1300 字纯填充、纯填充 1300 字均被拦；
 *   · 官方正文前 1257 字可过、前 1200 字被拦；本文件的 A 常量（块1+Agent Identity，1253 字）实测可过；
 *   · 与 system 的形状（string / 数组块）、max_tokens、metadata、device_id 及传输层均无关。
 *
 * 前缀来源与优先级：
 *   B（优先）运行时从本机 ZCode 客户端 bundle 提取——按**内容锚点**（不依赖压缩后的变量名）复原
 *     官方客户端自己的拼装规则：块1 = CLI Prefix；块2 开头 = Agent Identity
 *     = [["", 句子, "", 安全声明].join("\n"), "", Harness].join("\n")
 *     客户端升级后自动跟随，仓库无需内嵌厂商文本。
 *   A（兜底）内置常量，B 不可用时（未安装客户端 / bundle 结构变化 / 读取失败）使用。
 *
 * 注意：注入会把官方提示词拼在 system 最前面，下游客户端自己的 system 追加在其后。
 * 代价是每次请求多出约 1253 字符（≈358 token），且模型会先读到官方
 * 「You are ZCode…」人设，回复风格可能略有变化——这是换取该渠道可用的代价。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

// ===== A：内置兜底常量（官方 块1 + Agent Identity，实采自官方客户端 3.14.4 并逐字校验）=====
const FALLBACK_PREFIX = "You are ZCode, an interactive coding agent\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";

// ===== B：运行时从本机客户端 bundle 提取 =====
const ANCHOR_BLOCK1 = "You are ZCode, an interactive coding agent";
const ANCHOR_SENTENCE = "You are an interactive ZCode agent that helps users";
const ANCHOR_NOTICE = "IMPORTANT: Assist with authorized security testing";
const ANCHOR_HARNESS = "# Harness";
const MIN_VALID_LENGTH = 1240;   // 实测门禁阈值在 1200~1253 之间，低于此值视为提取失败

/** 候选 bundle 路径（按平台给出常见安装位置；ZCODE_BUNDLE_PATH 显式指定时只用它） */
function bundleCandidates() {
  const env = process.env.ZCODE_BUNDLE_PATH;
  if (env) return [env];
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  const la = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env["ProgramFiles(x86)"];
  if (la) push(path.join(la, "Programs", "ZCode", "resources", "glm", "zcode.cjs"));
  if (pf) push(path.join(pf, "ZCode", "resources", "glm", "zcode.cjs"));
  if (pf86) push(path.join(pf86, "ZCode", "resources", "glm", "zcode.cjs"));
  push(path.join(os.homedir(), ".zcode", "cli", "zcode.cjs"));
  return out;
}

/** 从 anchor 处（必须是字面量起始）读一个 JS 字符串字面量并解码 */
function readLiteralAt(s, idx) {
  let i = idx;
  const out = [];
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { out.push(c, s[i + 1]); i += 2; continue; }
    if (c === '"') break;
    if (c === "\n") throw new Error("literal not closed");
    out.push(c); i++;
  }
  return JSON.parse('"' + out.join("") + '"');
}

/** 字符串感知的括号匹配：从 start（'['）取到配对的 ']'（元素里可能含 [label](url) 这类中括号） */
function readArrayAt(s, start) {
  let depth = 0, i = start, inStr = false, q = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
}

/** 求值纯字符串数组（元素可能混用单/双引号，JSON.parse 会失败） */
function evalStringArray(text) {
  const arr = vm.runInNewContext("(" + text + ")", Object.create(null), { timeout: 2000 });
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) throw new Error("not a string array");
  return arr;
}

/** 从客户端 bundle 文本中按官方拼装规则复原前缀；失败返回 "" */
function extractFromBundle(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  const i1 = text.indexOf(ANCHOR_BLOCK1);
  const i2 = text.indexOf(ANCHOR_SENTENCE);
  const i3 = text.indexOf(ANCHOR_NOTICE);
  const i4 = text.indexOf(ANCHOR_HARNESS);
  if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0) return "";
  const block1 = readLiteralAt(text, i1);
  const sentence = readLiteralAt(text, i2);
  const notice = readLiteralAt(text, i3);
  // Harness 段：离 "# Harness" 最近的数组起点即该数组（元素为各文本行）
  const arrStart = text.lastIndexOf("[", i4);
  if (arrStart < 0) return "";
  const harness = evalStringArray(readArrayAt(text, arrStart)).join("\n");
  // 复刻官方 CJs()：[[ "", 句子, "", 安全声明 ].join("\n"), "", Harness].join("\n")
  const identity = [["", sentence, "", notice].join("\n"), "", harness].join("\n");
  return block1 + identity;
}

const looksValid = (p) => typeof p === "string" && p.startsWith(ANCHOR_BLOCK1) && p.length >= MIN_VALID_LENGTH;

let cache = { file: "", mtimeMs: 0, prefix: "" };
let warned = false;
let lastSource = "unknown";

/** 解析要注入的前缀：B 优先，失败回落 A */
function resolveOfficialSystemPrefix() {
  for (const file of bundleCandidates()) {
    try {
      const st = fs.statSync(file);
      if (cache.prefix && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.prefix;
      const p = extractFromBundle(fs.readFileSync(file, "utf8"));
      if (looksValid(p)) {
        cache = { file, mtimeMs: st.mtimeMs, prefix: p };
        lastSource = "client-bundle:" + file;
        return p;
      }
    } catch (e) { /* 试下一个候选 */ }
  }
  if (!warned) {
    warned = true;
    lastSource = "builtin-fallback";
    try {
      console.warn("[zcode] 未能从本机客户端 bundle 提取官方 system 前缀，回落内置常量（" + FALLBACK_PREFIX.length + " 字）");
    } catch (e) { /* ignore */ }
  }
  return FALLBACK_PREFIX;
}

/** 供诊断：本次前缀来自哪里 */
function officialSystemPrefixSource() {
  return lastSource;
}

/** 让 system 以官方前缀开头：已是官方形式则原样返回；否则前置拼接（数组块同样支持） */
function injectOfficialZcodeSystem(system) {
  const prefix = resolveOfficialSystemPrefix();
  if (!prefix) return system;
  const flatten = (s) => (Array.isArray(s) ? s.map((b) => (b && b.text) || "").join("") : String(s == null ? "" : s));
  if (flatten(system).startsWith(prefix)) return system;
  if (Array.isArray(system)) return [{ type: "text", text: prefix }, ...system];
  return system ? prefix + "\n\n" + system : prefix;
}

module.exports = {
  FALLBACK_PREFIX,
  MIN_VALID_LENGTH,
  extractFromBundle,
  resolveOfficialSystemPrefix,
  officialSystemPrefixSource,
  injectOfficialZcodeSystem,
};
