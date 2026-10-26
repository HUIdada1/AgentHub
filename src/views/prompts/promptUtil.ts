/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 提示词库 · 前端纯函数工具（无状态、可单测；页面与 store 共用，避免各页各写一份口径）
import { sideBySideDiff } from "../../utils/diff";
import { toast as ElMessage } from "../../utils/toast";
import type { PromptVariable } from "./promptTypes";

/** 清掉零宽字符（\u200b-\u200d、\ufeff）。
 *  为什么必须在提交前清：从网页/Word 粘贴的提示词常夹带零宽字符，肉眼看不见，
 *  但会让模型把「一个词」看成两个 token，也会让「与原文完全相同」的判断失效（§8.1 第 6 条）。 */
export function stripZeroWidth(s: string): string {
  return s.replace(/[\u200b-\u200d\ufeff]/g, "");
}

/** 字符数口径：按 Unicode 码点算，避免 emoji / 生僻字被算成 2 个字符（用户看到的是「字」） */
export function charCount(s: string): number {
  return s ? Array.from(s).length : 0;
}

/**
 * token 粗估（仅用于界面上给个量级，不是精确分词）：
 *  - 汉字/假名等 CJK 字符：多数 BPE 词表约 0.5~0.7 token/字，取 0.5；
 *  - 其余非空白字符：约 3.5 字符/token（英文单词 + 标点的平均压缩比）。
 *  为什么不做精确分词：前端引一个 tokenizer 会显著增大包体，而这里只用于「超长预警」与展示，
 *  真正的上下文超限判定在后端调用模型时才有权威结果。
 */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = s.replace(/\s/g, "").length - cjk;
  return Math.ceil(cjk * 0.5 + Math.max(0, rest) / 3.5);
}

/** 列表项只显示原文首行：抽屉里一行放不下多行文本，首行最能让人认出「这是哪一次」 */
export function firstLine(s: string, max = 60): string {
  const line = (s || "").split("\n").find((l) => l.trim()) || "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** 中文字符占比：用于「返回语言与原文不符」的粗判（§8.1 第 20 条，只提示不自动重试） */
export function cjkRatio(s: string): number {
  const total = (s || "").replace(/\s/g, "").length;
  if (!total) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk / total;
}

/** 耗时展示：<1s 显示毫秒，其余显示秒（保留一位小数，避免 12.0000001s 这类噪声） */
export function formatElapsed(ms: number): string {
  if (!ms || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 生成条目/风格 id：ASCII 短 id（契约 §1 要求文件名一律用 id，名称与分类只存 frontmatter，
 *  所以 id 必须与显示名解耦，且不能含中文/空格） */
export function newId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

/** 简易内容哈希（djb2）：仅用于前端「结果是否被手改过」与同步状态点的本地比对，
 *  不参与后端乐观锁（那是后端对 frontmatter 全文算的 hash，口径不同不可混用）。 */
export function quickHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 解析正文里的变量占位符 `{{name}}`（契约 §3 的 PromptVariable.name） */
export function parseVariables(body: string): PromptVariable[] {
  const out: PromptVariable[] = [];
  const seen = new Set<string>();
  const re = /\{\{\s*([A-Za-z0-9_\u4e00-\u9fff.-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body || ""))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1] });
  }
  return out;
}

/** 未闭合的 `{{`（§8.2 第 6 条：保存前校验高亮，但允许用户忽略后照常保存） */
export function hasUnclosedVariable(body: string): boolean {
  return (body || "").split("{{").length !== (body || "").split("}}").length;
}

/** 模板占位符白名单校验（§8.1 第 32 条）：只允许 {input} {maxLength} {scenario} {extra}。
 *  返回非法占位符清单（不含 `{{变量}}`——那是用户条目正文的变量语法，不是风格模板占位符）。
 *  {extra} 是「本次额外要求」：值由后端拼成整块（自带前置空行与标题），为空时整段消失。 */
export function invalidPlaceholders(tpl: string): string[] {
  const allowed = new Set(["input", "maxLength", "scenario", "extra"]);
  const bad = new Set<string>();
  const re = /\{\s*([A-Za-z0-9_]+)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl || ""))) if (!allowed.has(m[1])) bad.add(m[1]);
  return [...bad];
}

/** 成品预览：把 `{{name}}` 替换为该变量的默认值（没填默认值就显示占位提示），
 *  让用户在详情页直接看到「这段提示词最终长什么样」。 */
export function applyVariables(body: string, vars: PromptVariable[]): string {
  const map = new Map(vars.map((v) => [v.name, v.def ?? ""]));
  return (body || "").replace(/\{\{\s*([A-Za-z0-9_\u4e00-\u9fff.-]+)\s*\}\}/g, (_all, name: string) => {
    const v = map.get(name);
    return v !== undefined && v !== "" ? v : `【${name}】`;
  });
}

/** 统一 diff：复用 utils/diff.ts 的 LCS 结果（并排行序列）再压成 -/+ 行，避免再写一份 LCS。
 *  context 为上下文行数，超出部分用「…」省略——提示词常常很长，全量输出反而看不清改动。 */
export function unifiedDiff(left: string, right: string, context = 3): { text: string; add: number; del: number } {
  const { left: L, right: R } = sideBySideDiff(left || "", right || "");
  type Row = { sign: "-" | "+" | " "; text: string };
  const rows: Row[] = [];
  let add = 0;
  let del = 0;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const r = R[i];
    if (l.kind === "ctx") rows.push({ sign: " ", text: l.text });
    else if (l.kind === "del") { rows.push({ sign: "-", text: l.text }); del++; }
    else if (r && r.kind === "add") { rows.push({ sign: "+", text: r.text }); add++; }
  }
  // 只保留有改动的段落前后 context 行
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.sign === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const lines: string[] = [];
  let skipped = false;
  rows.forEach((row, i) => {
    if (keep[i]) { lines.push(row.sign + row.text); skipped = false; }
    else if (!skipped) { lines.push("…"); skipped = true; }
  });
  return { text: lines.join("\n"), add, del };
}

/** 复制到剪贴板：统一给「已复制/复制失败」的反馈口径（各页不再各写一遍 try/catch） */
export async function copyText(text: string, label = "内容"): Promise<boolean> {
  if (!text) { ElMessage.warning(`没有可复制的${label}`); return false; }
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`${label}已复制`);
    return true;
  } catch {
    ElMessage.warning("复制失败，请手动选择复制");
    return false;
  }
}

/** 标签输入解析：允许中英文逗号、空格、顿号混用（用户不会为「标签」去研究分隔符规范） */
export function parseTags(input: string): string[] {
  return [...new Set((input || "").split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean))];
}

/** 分类「两级」拆解：`写作/邮件` → 父「写作」、子「邮件」；只有一级时父为空。
 *  方案 §3.2 要求分类做树形归档，但不引入独立的分类实体（分类只存在条目的 category 字段里），
 *  所以树是从条目的 category 字符串现算出来的，天然不会出现「空分类」。 */
export function splitCategory(category: string): { parent: string; child: string } {
  const parts = (category || "").split("/").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { parent: "未分类", child: "" };
  return parts.length === 1 ? { parent: parts[0], child: "" } : { parent: parts[0], child: parts.slice(1).join("/") };
}

/** 摘要：卡片上只放前 N 个字符（正文可能上千字，卡片必须固定高度） */
export function summaryOf(body: string, max = 90): string {
  const s = (body || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
