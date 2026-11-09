/**
 * 画像「手改保留」自反馈回归自测：自动生成的提示行不能被当成 [pinned] 手改内容回灌
 * 运行：node scripts/test-memory-profile-pinned.cjs
 * 纯函数 + 临时目录，不调模型、不碰真实记忆。
 *
 * 背景：profile/*.md 重新生成时会把用户手改并打了 [pinned] 的行带到新版本，判定用
 * includes("[pinned]") —— 但自动生成的提示行本身就含 "[pinned]"：
 *   <!-- 本文件由 AgentHub 记忆中枢生成；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->
 * 于是每重新生成一次，就把上一版的提示行再追加一份：正文尾部逐次堆积重复注释
 * （实测 6 天 2 行 → 17 行），memory_core 取画像时被这些行占满 token 预算并被截断。
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { isPinnedLine, parsePinnedLines, mergePinned, GENERATED_HINT } =
  require("../electron/backend/memory/pinned.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

const HINT_LINE = `<!-- ${GENERATED_HINT}；手改内容请加 [pinned] 前缀，下次生成不会覆盖 -->`;
const TITLE_LINE = `title: "${HINT_LINE}"`;

function countHint(text) {
  return String(text).split("\n").filter((l) => l.includes(GENERATED_HINT)).length;
}

console.log("① 行级判定");
ok(isPinnedLine(HINT_LINE) === false, "自动生成的提示行不算手改行");
ok(isPinnedLine(TITLE_LINE) === false, "frontmatter 里被写成提示语的 title 也不算");
ok(isPinnedLine("- 变更前先备份，不接受跳过备份 [pinned]") === true, "用户手写的 [pinned] 行仍然保留");
ok(isPinnedLine("- 普通条目") === false, "没打标记的行不保留");

console.log("\n② 一份被污染的真实形态文件");
const polluted = [
  "---",
  TITLE_LINE,
  "---",
  "",
  HINT_LINE,
  "- 对系统级变更风险厌恶",
  "- 工程决策偏保守 [pinned]",
  "",
  "",
  TITLE_LINE,
  HINT_LINE,
  HINT_LINE,
  HINT_LINE,
].join("\n");
const kept = parsePinnedLines(polluted);
ok(kept.length === 1, `只取到 1 条真正的手改行（实得 ${kept.length} 条）`);
ok(kept[0].includes("工程决策偏保守"), "取到的正是用户手写那条");

console.log("\n③ 连续重新生成：提示行不再累积");
let file = HINT_LINE + "\n- 第一版画像\n";
const counts = [];
for (let i = 0; i < 5; i++) {
  const content = HINT_LINE + `\n- 第 ${i + 1} 版画像\n`;
  file = mergePinned(content, parsePinnedLines(file));
  counts.push(countHint(file));
}
ok(counts.every((n) => n === 1), `5 次重新生成后提示行恒为 1（各次：${counts.join(",")}）`);

console.log("\n④ 已污染的历史文件会在下一次重新生成时自愈");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ah-pinned-"));
try {
  const abs = path.join(tmp, "persona.md");
  fs.writeFileSync(abs, polluted, "utf8");
  const before = countHint(fs.readFileSync(abs, "utf8"));
  const content = HINT_LINE + "\n- 新一版画像\n";
  const next = mergePinned(content, parsePinnedLines(fs.readFileSync(abs, "utf8")));
  fs.writeFileSync(abs, next, "utf8");
  const after = fs.readFileSync(abs, "utf8");
  ok(before === 6, `造出的历史文件含 6 行提示（实得 ${before}）`);
  ok(countHint(after) === 1, `重新生成后只剩 1 行提示（实得 ${countHint(after)}）`);
  ok(after.includes("工程决策偏保守 [pinned]"), "用户手改行在重写后仍在");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n⑤ 置顶条目的证据行跟随保留（逐行 filter 会把它丢掉）");
const withEvidence = [
  HINT_LINE,
  "- 普通条目",
  "  证据 [2]：mem_1, mem_2",
  "- 用户置顶的条目 [pinned]",
  "  证据 [2]：mem_3, mem_4",
  "- 另一条置顶 [pinned]",
].join("\r\n"); // 顺带覆盖 CRLF：Windows 上编辑过的文件行尾带 \r
const evKept = parsePinnedLines(withEvidence);
ok(evKept.length === 3, `保留置顶条目 + 其证据行（实得 ${evKept.length} 行）`);
ok(evKept[1].trim() === "证据 [2]：mem_3, mem_4", "证据行紧跟在置顶条目后面");
ok(evKept.every((l) => !l.includes("\r")), "CRLF 行尾的 \\r 已被去掉");
ok(!evKept.some((l) => l.includes("mem_1")), "普通条目的证据行没有被误收");
const mergedEv = mergePinned(HINT_LINE + "\n- 新一版画像\n", evKept);
ok(!/\n{3,}/.test(mergedEv), "合并后没有连续 3 个以上换行");
ok(mergedEv.endsWith("\n"), "合并结果以单个换行收尾");

console.log(`\n${pass} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
