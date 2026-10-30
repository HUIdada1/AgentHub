/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 内容拦截降级状态机（机制对齐 Agent2API 的 `core/degrade.rs`，按 Node 形态重写）。
//
// ── 它解决什么 ───────────────────────────────────────────────
// 出站伪装 mimic / passthrough 模式下，请求体被上游内容策略逐字命中（HTTP 400 + 审核
// 文案，或上游网关带 SENSITIVE / blocked 关键词的 400/403）时，绝大多数是指纹误报：
// 客户端注入的 system 模板句被逐字匹配拦下，而账号本身健康（余额够、没限流、session
// 没死）。此时的动作是：
//
//   ① 本次请求立刻换最小中性提示词（NEUTRAL_PROMPT）同账号重发一次；
//   ② 同时触发降级：之后一段时间里，mimic / passthrough 模式的请求直接带着中性提示词
//      出门，不再先撞一次 400 再补救。
//
// ── 降级期到**次日 00:00（UTC+8）**结束 ──────────────────────
// 与官方案例同一个重置口径：内容拦截窗口通常与「当天」绑定（上游侧的风控按天统计），
// 次日零点是一次天然的重置点 —— 「无限期降级」会让用户在问题早就消失之后仍然拿不到
// 自己的 system 提示词。
//
// ── 状态放内存、重启清零 ──────────────────────────────────────
// 它是运行期状态而不是配置：进程重启等于一次人工介入（用户多半正是因为撞了 400 才
// 重启），把降级带过去没有意义。落盘还会引入「什么时候该清」的第二套判据（跨天？
// 跨版本？），得不偿失。
//
// ── 触发不续期 ───────────────────────────────────────────────
// 降级期内再次触发**不延长**截止时间（保持最早那个零点）：否则一条持续报错的客户端
// 会把降级期无限推后，等于永久降级。
//
// ── 接入点 ─────────────────────────────────────────────────
//   · forwarder.forward()：发送前问 `applyPrompt`（要换就换）、撞内容拦截后问
//     `trigger()` + 用 `neutralPrompt()` 重发一次；
//   · 没有「撤销」按钮：aligned 官方案例没有（重启即恢复），保持语义一致。
"use strict";

/** UTC+8 的固定偏移（毫秒）。中国标准时间没有夏令时，Asia/Shanghai 恒为 +08:00。 */
const CST_OFFSET_MS = 8 * 3600 * 1000;
/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/** 降级截止时刻（UTC 毫秒）；0 = 未触发、或已到点自动恢复 */
let untilMs = 0;

/** 最小中性提示词：内容降级时把原本的 system 提示词整体替换为它。
 *  保持短、不携带任何指纹特征，正文本身不参与风控字面匹配。 */
const NEUTRAL_PROMPT = "You are a helpful assistant.";

/** 处于降级期返回 true；不在降级期或已到点自动恢复返回 false */
function active() {
  return untilMs > Date.now();
}

/** 降级截止时刻（毫秒）；不在降级期返回 0 */
function until() {
  return active() ? untilMs : 0;
}

/** 触发降级：返回本次生效的截止时刻。
 *  已在降级期内**不续期**：保持最早那个零点，直接返回原值 */
function trigger() {
  const now = Date.now();
  if (untilMs > now) return untilMs;
  untilMs = nextMidnightCst(now);
  return untilMs;
}

/** 手动解除降级（设置页「立即恢复」用；非官方配套，但语义上合理 —— 用户当场改提示词后
 *  不该还要等到零点）。重启同样的恢复效果，所以只是交互上的便利。 */
function clear() {
  untilMs = 0;
}

/** `now` 之后最近的 UTC+8 零点（毫秒）。
 *  边界语义与官方逐条一致：
 *    · 23:59 → 次日 00:00；
 *    · 恰好 00:00 → **次日** 00:00（刚过零点，下个零点是明天）。
 *  实现：平移到 CST 视角（+8h），当天零点 = floor(shifted / DAY) * DAY，再加一天。 */
function nextMidnightCst(nowMs) {
  const shifted = nowMs + CST_OFFSET_MS;
  // floor 用 Math.floor 而非 Math.trunc：负数时刻也要落在正确整天边界上（1970 前不重要，
  // 但语义还是要对）
  const startOfToday = Math.floor(shifted / DAY_MS) * DAY_MS;
  return startOfToday + DAY_MS - CST_OFFSET_MS;
}

/** 命中这条文案即按「内容拦截」处理。
 *  摘自官方判定来源：上游对 system / user 正文做逐字匹配，命中即 400 / 403 + 审核文案；
 *  措辞不固定，但必含 SENSITIVE / blocked / review / 审核 之一。
 *  注意：只认 upstream 4xx（400/403/451）上的错误文案；其它错误的英文文本里若凑巧出现
 *  这些词不触发 —— 调用方先判 status 再进这里。 */
const BLOCK_MARKERS = [
  "content_policy",
  "content policy",
  "content_policy_violation",
  /sensitive_word|敏感词/,
  /content.*(review|审核|moderat|filter)/i,
  /unsafe.*content|content.*unsafe/i,
  /policy.*(violation|breach)|violate.*policy/i,
  /content.*(blocked|拒绝|违规)/i,
  /review.*(flag|触发)/i,
  // 中文审核直词（上游中文网关常见：您的请求包含违规内容 / 内容审核不通过 / 触发安全规则）
  /违规|审[核察]不通过|触发安全|安全.*(规则|策略)|内容.*(违规|不通过|审核)/,
  // 英文字面拒绝（policy / moderation）在「上游 4xx 分类文案」里带得广，
  // 但配额 / credit / 429 不会被这条链命中（调用方先判 status === 400/403/451）
  /moderation|request.?refus|disallowed/,
];

/** 判定错误文案是否属于内容拦截（status 在外层判过，这里只看文案关键词） */
function isContentBlock(errText) {
  const s = String(errText || "");
  if (!s) return false;
  for (const m of BLOCK_MARKERS) {
    if (typeof m === "string") {
      if (s.includes(m)) return true;
    } else if (m.test(s)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  active,
  until,
  trigger,
  clear,
  isContentBlock,
  NEUTRAL_PROMPT,
};
