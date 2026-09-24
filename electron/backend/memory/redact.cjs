/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 敏感信息脱敏：写入前按可配正则扫描，命中替换为 {{REDACTED:type}}。
// 规则本身也可被用户改（privacy.redactRules），这里只提供内置默认与执行逻辑。
"use strict";

const crypto = require("crypto");

const BUILTIN = [
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{8,}/g },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._\-]{8,}/g },
  { name: "aws-ak", re: /AKIA[0-9A-Z]{16}/g },
  { name: "password", re: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi },
  { name: "phone-cn", re: /\b1[3-9]\d{9}\b/g },
  { name: "id-cn", re: /\b\d{17}[\dXx]\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g },
];

function compile(rules) {
  const custom = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (typeof r === "string") {
      try { custom.push({ name: "custom", re: new RegExp(r, "g") }); } catch { /* 非法正则跳过 */ }
    } else if (r && typeof r.re === "string") {
      try { custom.push({ name: r.name || "custom", re: new RegExp(r.re, "g") }); } catch { /* 非法正则跳过 */ }
    } else if (r && r.re instanceof RegExp) {
      custom.push(r);
    }
  }
  // 内置规则永远生效，用户自定义只追加不顶替（原逻辑：给一条自定义就关停全部内置脱敏）
  return BUILTIN.concat(custom);
}

// 命中样本不外泄原文（密钥前 12 字符也是密钥），只回内容指纹供用户区分多条命中
function fingerprint(s) {
  return "#" + crypto.createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 10);
}

/**
 * 扫描文本，返回命中列表与替换后的文本。
 * @param {string} text
 * @param {Array} rules privacy.redactRules（字符串正则或 {name,re}）
 * @param {"skip"|"mask"|"ask"} action 命中后的动作（skip 由调用方决定是否丢弃）
 */
function redact(text, rules, action) {
  const src = String(text == null ? "" : text);
  const list = compile(rules);
  const hits = [];
  let out = src;
  for (const { name, re } of list) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      hits.push({ type: name, sample: fingerprint(m) });
      return `{{REDACTED:${name}}}`;
    });
  }
  const mode = action || "mask";
  if (mode === "skip" && hits.length) return { text, hits, blocked: true };
  return { text: out, hits, blocked: false };
}

function detect(text, rules) {
  const list = compile(rules);
  const hits = [];
  for (const { name, re } of list) {
    re.lastIndex = 0;
    const m = re.exec(String(text == null ? "" : text));
    if (m) hits.push({ type: name, sample: fingerprint(m[0]) });
  }
  return hits;
}

module.exports = { redact, detect, BUILTIN };
