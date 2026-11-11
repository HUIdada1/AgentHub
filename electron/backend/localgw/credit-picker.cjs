/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 跨渠道「积分优先」选号（把账号提到第一决策单位）
//
// ── 和既有两步的差别 ─────────────────────────────────────────
// routing.cjs 的 pick() 只选渠道（prefer / score / costTier），账号由执行器在
// **单渠道内**再选（extension-executor.cjs / standard/executor.cjs → pool.pickAccount）；
// 两条链路从不跨渠道比较账号额度。这里补上「一次定号」：给一批 (渠道, 真实模型)
// 绑定，在每个渠道里取当前最该用的账号，跨渠道按同一把键挑出唯一一个，返回
// `{ binding, row }`；调用方随后把 `row.account.id` 钉进执行器，执行器不再换号。
//
// ── 排序键（固定，产品需求原文）────────────────────────────────
//   ① 免费（account-plan 的 rank 0）
//   ② 有效到期（rank 1），按 expiresAt 升序：先到期先用
//   ③ 永久 / 期限未知（rank 2/3 合并垫底）
// 只比「档位 + 到期」；积分数额只在**同一渠道内**兜底——不同渠道的积分数额
// 不互相折算，与账号调度页的既有口径一致。
//
// ── 为什么账号候选必须来自 accountPlan ────────────────────────
// 资格判定（在线 / 有凭据 / 余额未耗尽 / 未过期 / 账号×模型未冷却 / 并发未满）
// 全部在 account-plan.cjs 里，这里只负责把它已经算好的 rank/eligible 再做
// 跨渠道排序，不复制任何一条资格规则（否则两套口径迟早分叉）。
//
// ── 只读 ─────────────────────────────────────────────────────
// 本模块只调 pool.accountPlan（内部 poolAccounts(channel, true)），不写库、
// 不改 lastUsed；真正的占号/并发租约仍由执行器里的 pool.pickAccount +
// acquireAccount 完成（保持既有语义与回滚路径）。
"use strict";
const pool = require("../proxy/pool.cjs");
const routing = require("./routing.cjs");

/** 账号余额排序值：-1 是「不限」哨兵，按无限大参与（与 account-plan.creditRank 同口径） */
function creditRank(account) {
  const credits = account && account.credits;
  return credits === -1 ? Infinity : Number(credits) || 0;
}

/** 三档归并：免费 0 / 有效到期 1 / 永久+未知 2 */
function bucketOf(row) {
  const rank = Number(row && row.rank);
  if (rank === 1) return 1;
  if (rank >= 2) return 2;
  return 0;
}

/** 到期时刻：0 / 缺省 = 长期有效或未知，排在同一档的最后 */
function expiryOf(row) {
  const value = Number(row && row.account && row.account.expiresAt) || 0;
  return value > 0 ? value : Infinity;
}

/** 同渠道内的账号排序：档位 → 到期 → 余额多 → 最久未用 → id 稳定。
 *  Math.min/区间比较代替减法：expiryOf 可能是 Infinity，Infinity-Infinity 会变成 NaN，
 *  而 Array.sort 遇到 NaN 视为 0 —— 那会让同档永久号之间退化成随机顺序。 */
function compareAccounts(a, b) {
  const ba = bucketOf(a), bb = bucketOf(b);
  if (ba !== bb) return ba - bb;
  const ea = expiryOf(a), eb = expiryOf(b);
  if (ea !== eb) return ea < eb ? -1 : 1;
  const ca = creditRank(a.account), cb = creditRank(b.account);
  if (ca !== cb) return ca > cb ? -1 : 1;
  const ua = Number(a.account && a.account.lastUsed) || 0;
  const ub = Number(b.account && b.account.lastUsed) || 0;
  if (ua !== ub) return ua - ub;
  return String(a.account && a.account.id).localeCompare(String(b.account && b.account.id));
}

/** 跨绑定排序：档位 → 到期 → 绑定声明顺序（模型组成员顺序 / 渠道目录顺序）。
 *  跨渠道刻意**不比积分数额**（不同渠道积分不可折算），完全同档同到期时
 *  由用户可见的顺序兜底，结果稳定且可预期。 */
function compareBindings(a, b) {
  const ba = bucketOf(a.row), bb = bucketOf(b.row);
  if (ba !== bb) return ba - bb;
  const ea = expiryOf(a.row), eb = expiryOf(b.row);
  if (ea !== eb) return ea < eb ? -1 : 1;
  return a.index - b.index;
}

/** 集合入参归一：允许 undefined / 数组 / Set / Map，避免调用方各自兜底。 */
function normalize(options) {
  const source = options || {};
  return {
    excludedChannels: source.excludeChannels instanceof Set ? source.excludeChannels : new Set(source.excludeChannels || []),
    excludedMembers: source.excludeMembers instanceof Set ? source.excludeMembers : new Set(source.excludeMembers || []),
    triedAccounts: source.triedAccounts instanceof Map ? source.triedAccounts : new Map(source.triedAccounts || []),
    catalogExcludeAccounts: typeof source.catalogExcludeAccounts === "function" ? source.catalogExcludeAccounts : null,
    scopeOf: typeof source.scopeOf === "function" ? source.scopeOf : null,
  };
}

/** 该绑定本轮已试过的账号集合：组按「渠道+实际模型」分键，普通按渠道分键，
 *  与 server.cjs 的 accountScope / triedAccounts 同口径。 */
function triedScopeOf(binding, ctx) {
  if (ctx.scopeOf) {
    try { return ctx.scopeOf(binding); } catch { return binding.channel; }
  }
  return binding.groupName ? routing.groupMemberKey(binding) : binding.channel;
}

/** 评估一个绑定：返回 { binding, index, row } 或 { binding, index, reason } */
function evaluate(binding, index, ctx) {
  const base = { binding, index };
  if (!binding || typeof binding.channel !== "string" || !binding.channel
    || typeof binding.realModel !== "string" || !binding.realModel) {
    return { ...base, reason: "缺少渠道或实际模型名" };
  }
  if (ctx.excludedChannels.has(binding.channel)) return { ...base, reason: "本轮已排除（渠道或密钥范围）" };
  if (ctx.excludedMembers.has(routing.groupMemberKey(binding))) return { ...base, reason: "本轮该成员已判死" };
  try {
    if (!routing.isChannelEnabled(binding.channel)) return { ...base, reason: "渠道已关闭" };
    if (routing.isCooling(binding.channel)) return { ...base, reason: "渠道冷却中" };
  } catch {
    return { ...base, reason: "渠道状态不可读" };
  }
  const excludeIds = [...(ctx.triedAccounts.get(triedScopeOf(binding, ctx)) || [])];
  if (ctx.catalogExcludeAccounts) {
    // 账号级目录白名单（插件声明某模型只有部分账号可用）：不排除掉就可能在
    // 这里选中一个执行器随后会跳过的号，白白多一次换号。
    try {
      const extra = ctx.catalogExcludeAccounts(binding.channel, binding.realModel);
      if (Array.isArray(extra)) excludeIds.push(...extra);
    } catch { /* 目录不可读不参与排除，不影响选号本身 */ }
  }
  let rows;
  try {
    rows = pool.accountPlan(binding.channel, undefined, excludeIds, 0, String(binding.realModel));
  } catch {
    return { ...base, reason: "号池不可用" };
  }
  const eligible = (Array.isArray(rows) ? rows : []).filter((row) => row && row.eligible && row.account);
  if (!eligible.length) {
    const firstReason = (Array.isArray(rows) ? rows : []).find((row) => row && row.reason);
    return { ...base, reason: firstReason ? String(firstReason.reason) : "没有可用账号" };
  }
  eligible.sort(compareAccounts);
  return { ...base, row: eligible[0], reason: "" };
}

/** 候选排序：返回按全局键升序的 [{ binding, index, row }]（只含至少有一个可用账号的绑定）。 */
function rank(options) {
  const ctx = normalize(options);
  const out = [];
  const bindings = Array.isArray(options && options.bindings) ? options.bindings : [];
  bindings.forEach((binding, index) => {
    const result = evaluate(binding, index, ctx);
    if (result.row) out.push(result);
  });
  out.sort(compareBindings);
  return out;
}

/** 选一个：返回 { binding, index, row }；没有可用候选回 null。 */
function pick(options) {
  const ranked = rank(options);
  return ranked.length ? ranked[0] : null;
}

/** 只读预览：可用候选在前（同排序规则），不可用的在后并带原因。
 *  给「输入 abc 看它会落到哪些渠道/真实模型/账号」的排障口径使用，不产生任何副作用。 */
function preview(options) {
  const ctx = normalize(options);
  const bindings = Array.isArray(options && options.bindings) ? options.bindings : [];
  const all = bindings.map((binding, index) => evaluate(binding, index, ctx));
  const usable = all.filter((item) => item.row).sort(compareBindings);
  const blocked = all.filter((item) => !item.row);
  return [...usable, ...blocked];
}

/** 带「显式指定优先」的选号：模型改名覆盖 / 渠道锁定命中时，先只在那个渠道里挑；
 *  挑不到且开了故障转移，才回落到全部候选（与 routing.pick 的「尽力锁」同语义）。
 *  显式指定是用户对单个模型的硬意图，不能被全局策略悄悄绕过。 */
function pickWithExplicit(options) {
  const source = options || {};
  const explicitChannel = String(source.explicitChannel || "");
  if (!explicitChannel) return pick(source);
  const bindings = Array.isArray(source.bindings) ? source.bindings : [];
  const only = bindings.filter((binding) => binding && binding.channel === explicitChannel);
  if (only.length) {
    const hit = pick({ ...source, bindings: only });
    if (hit) return hit;
  }
  if (source.failover === false) return null;
  return pick(source);
}

module.exports = {
  pick,
  rank,
  preview,
  pickWithExplicit,
  compareAccounts,
  compareBindings,
  bucketOf,
  expiryOf,
  creditRank,
};
