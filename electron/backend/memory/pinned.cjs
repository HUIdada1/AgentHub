/**
 * 记忆中枢 · 人格画像的「手改保留」行解析
 *
 * 画像文件（profile/{persona,preferences,tech,habits}.md）每次重新生成都会重写整份正文，
 * 只把用户手写并打了 [pinned] 标记的行原样带到新版本。这里负责识别这些行。
 *
 * 关键约束：自动生成的提示语本身含 "[pinned]" 字样——
 *   <!-- 本文件由 AgentHub 记忆中枢生成；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->
 * 若按字面 includes("[pinned]") 取行，上一版自己的提示行也会被当成用户手改内容再追加一遍，
 * 于是每次重新生成都往正文尾部堆一份提示；实测六天从 2 行涨到 17 行，memory_core 读出来的
 * 画像被重复注释占满并触发 token 截断。因此凡是「自动生成」的行必须先排除。
 */
"use strict";

const PINNED_TAG = "[pinned]";
const GENERATED_HINT = "本文件由 AgentHub 记忆中枢生成";

/** 该行是否为需要保留的用户手改行（自动生成的提示行不算） */
function isPinnedLine(line) {
  const s = String(line == null ? "" : line);
  return s.includes(PINNED_TAG) && !s.includes(GENERATED_HINT);
}

/** 从整份文件文本里取出用户手改行（保持原顺序，不做去重） */
function parsePinnedLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isPinnedLine(lines[i])) continue;
    out.push(lines[i]);
    // 证据行本身不含 [pinned]，逐行 filter 会把它丢掉——置顶条目重新生成后证据凭空消失。
    // 只吞紧跟其后的缩进「证据 [N]：…」行，不扩大到其它缩进内容。
    // 注意别用 \b：中文字符不属于 \w，`证据` 后面接空格时两侧都是非单词字符，没有单词边界。
    while (i + 1 < lines.length && /^\s+证据\s*\[/.test(lines[i + 1])) {
      out.push(lines[++i]);
    }
  }
  return out;
}

/** 生成内容 + 保留行的合并：规范化尾部空行，避免每轮多留一份空行 */
function mergePinned(content, pinnedLines) {
  const kept = Array.isArray(pinnedLines) ? pinnedLines : [];
  const body = String(content == null ? "" : content).replace(/\s+$/, "");
  const tail = kept.join("\n");
  if (!body) return tail ? `${tail}\n` : "";
  if (!tail) return `${body}\n`;
  return `${body}\n\n${tail}\n`;
}

module.exports = { PINNED_TAG, GENERATED_HINT, isPinnedLine, parsePinnedLines, mergePinned };
