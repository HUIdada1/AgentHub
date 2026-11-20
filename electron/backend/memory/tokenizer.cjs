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
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (MUHUIX)
 * https://github.com/MUHUIX/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 分词器：CJK bigram 预分词 + 英文整词小写 + 单字 CJK run 保留自身。
// 依据实测：trigram 中文 2 字词召回 0%、全局 unigram 召回反降至 77.4%；
// 单字 run 保留 script_run_grams（孤立单字可查，不污染多字 run）。
"use strict";

function isCJK(ch) {
  const x = ch.codePointAt(0);
  return (x >= 0x3400 && x <= 0x9fff) || (x >= 0xf900 && x <= 0xfaff) || (x >= 0x20000 && x <= 0x2a6df);
}

function isWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function tokenizeList(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  // 按 Unicode 码点切分：补充平面 CJK（0x20000+）在 UTF-16 里是代理对，
  // 用 s[i] 逐「码元」遍历会让 isCJK 永远拿到高位代理，0x20000 分支形同死代码
  const chars = Array.from(s);
  let i = 0;
  const n = chars.length;
  while (i < n) {
    const c = chars[i];
    if (isCJK(c)) {
      let j = i;
      while (j < n && isCJK(chars[j])) j++;
      if (j - i === 1) out.push(chars[i]);
      else for (let k = i; k + 1 < j; k++) out.push(chars.slice(k, k + 2).join(""));
      i = j;
    } else if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(chars[j])) j++;
      out.push(chars.slice(i, j).join("").toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function tokenize(text) {
  return tokenizeList(text).join(" ");
}

// 写侧加权：标题分词串重复 boost 次
function weightedTitle(title, boost) {
  const t = tokenize(title);
  if (!t) return "";
  const n = Math.max(1, Math.round(boost || 3));
  return Array.from({ length: n }, () => t).join(" ");
}

// FTS5 MATCH 短语：bigram 串加引号 → 相邻有序 = 原 CJK 子串语义
function phraseQuery(text) {
  const t = Array.isArray(text) ? text : tokenizeList(text);
  return t.length ? '"' + t.map((x) => String(x).replace(/"/g, '""')).join(" ") + '"' : "";
}

// 多词 AND：收敛命中集（真实查询主力形态）
function andQuery(text) {
  const t = Array.isArray(text) ? text : tokenizeList(text);
  return t.length ? t.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(" AND ") : "";
}
module.exports = { isCJK, tokenize, tokenizeList, weightedTitle, phraseQuery, andQuery };
