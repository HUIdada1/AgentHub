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
// 本地网关 · 选路计划（纯函数）
//
// ── 这个模块解决什么 ────────────────────────────────────────
// 把「这条请求会先落到哪个账号、为什么」算成一份完整清单：可用的按位次排好，
// 不可用的带原因列在后面。转发路径按清单从头取人，界面把同一份清单画出来 ——
// 两边调的是同一个函数，所以「界面标的顺序」与「实际走的顺序」不可能分叉。
//
// ── 输入 ────────────────────────────────────────────────────
// accounts  账号公开形态（adaptAccount 可从号池记录直接映射）
// strategy  order（位次）| rotate（每条请求环绕）| provider（家序固定、家内环绕）
// counts    账号 id → 当前在途数（缺省按 0 算）
// cooling   账号 id → 该模型的冷却恢复时刻（毫秒）；判定必须用**上游真名**的键
// excluded  本轮已试过的账号 id
// limiter   被限制器拦下的账号 id（余额不足 / 周期用量到顶）
// needs     本次请求的能力需求 { tools, images, video }
// state     route-state.snapshot() 的结果：backoff / sunk / open / sticky
//
// ── 排序链（顺序固定，不要调换）─────────────────────────────
// 策略基础序 → 粘性置顶 → 垫底 → 休息 → 熔断（后三步用稳定分层，不重排同层）
"use strict";

const STRATEGIES = new Set(["order", "rotate", "provider"]);

function normalizeStrategy(value) {
  const text = String(value || "").toLowerCase();
  return STRATEGIES.has(text) ? text : "order";
}

/** 号池记录 → 计划可用的公开形态。字段缺失一律给安全缺省，不让脏数据把账号整条丢掉。 */
function adaptAccount(account, extras = {}) {
  const meta = account && typeof account.meta === "object" && account.meta ? account.meta : {};
  const gateway = meta.gateway && typeof meta.gateway === "object" ? meta.gateway : {};
  const priority = Number(gateway.priority);
  const added = Number(account && (account.addedAt ?? account.createdAt ?? account.created_at));
  const limit = Number(gateway.maxInFlight);
  return {
    raw: account,
    id: String((account && account.id) || ""),
    name: String((account && account.name) || (account && account.id) || ""),
    provider: String((account && (account.channel || account.provider)) || ""),
    status: String((account && account.status) || "online"),
    hasCredentials: !(account && (account.hasToken === false || account.hasCredentials === false)),
    priority: Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER,
    addedAt: Number.isFinite(added) && added > 0 ? added : 0,
    lastUsed: Number(account && account.lastUsed) || 0,
    maxConcurrent: Number.isFinite(limit) && limit > 0 ? limit : 0,
    capabilities: (account && account.capabilities) || meta.capabilities || {},
    inFlight: Number(extras.inFlight) || 0,
  };
}

/** 位次比较：priority 小者先；并列按加入时间；再并列按 id 保证稳定。 */
function comparePriority(a, b) {
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.id.localeCompare(b.id);
}

/** 时间戳 → 「HH:MM」，跨天补「明天」/「N 天后」。与请求统计同一口径（操作者本机时区）。 */
function clockText(resetAt, now) {
  const date = new Date(Number(resetAt) || 0);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.max(0, Math.floor((resetAt - now) / 86400000));
  const prefix = days === 0 ? "" : days === 1 ? "明天 " : `${days} 天后 `;
  return `${prefix}${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 能力不满足的原因；满足返回空串。未声明(false 或缺省)按具体文案区分「不支持」与「未声明」。 */
function capabilityReason(account, needs) {
  if (!needs) return "";
  for (const [key, label] of [["tools", "工具调用"], ["images", "图片输入"], ["video", "视频输入"]]) {
    if (!needs[key]) continue;
    const value = account.capabilities && account.capabilities[key];
    if (value === true) continue;
    return value === false
      ? `该模型不支持${label}，已跳过`
      : `该模型的${label}能力未声明，请先在模型目录确认`;
  }
  return "";
}

/** 当前在途数：运行时快照优先，缺省回落到账号行上的 inFlight（单测/预览可只传行）。 */
function activeOf(account, counts) {
  const fromSnapshot = counts[account.id];
  const value = fromSnapshot === undefined ? account.inFlight : fromSnapshot;
  return Number(value) || 0;
}

/** 并发是否已满（maxConcurrent = 0 表示不限）。 */
function atConcurrencyLimit(account, counts) {
  const limit = account.maxConcurrent;
  if (!(limit > 0)) return false;
  return activeOf(account, counts) >= limit;
}

/**
 * 生成选路计划。
 * 返回 { ordered, blocked, stickyHit, stickyCandidate, strategy, cursor }：
 *   ordered  可用候选（已按最终位次排好）
 *   blocked  被跳过的候选（各带 state/reason/resetAt）
 *   stickyHit 粘性命中的账号是否真的排到了第一位（决定调用方要不要推进轮转）
 */
function buildPlan(options) {
  const source = options || {};
  const now = Number(source.now) || Date.now();
  const strategy = normalizeStrategy(source.strategy);
  const counts = source.counts && typeof source.counts === "object" ? source.counts : {};
  const cooling = source.cooling && typeof source.cooling === "object" ? source.cooling : {};
  const excluded = new Set(source.excluded || []);
  const limiterBlocked = new Set(source.limiter || []);
  const needs = source.needs || null;
  const state = source.state && typeof source.state === "object" ? source.state : {};
  const backoff = state.backoff || {};
  const sunk = state.sunk || {};
  const open = new Set(state.open || []);
  const stickyAccount = String((state.sticky && source.stickyKey && state.sticky[source.stickyKey]) || "");
  const cursor = Number(source.cursor) || 0;
  const providerCursors = source.providerCursors && typeof source.providerCursors === "object" ? source.providerCursors : {};

  const accounts = (Array.isArray(source.accounts) ? source.accounts : []).filter((account) => account && account.id);

  const usable = [];
  const blocked = [];
  const entry = (account, stateCode, reason, resetAt = 0) => ({
    id: account.id, name: account.name, provider: account.provider,
    account: account.raw || account, state: stateCode, reason, resetAt,
  });

  for (const account of accounts) {
    if (excluded.has(account.id)) { blocked.push(entry(account, "tried", "本轮已试过，不再回试")); continue; }
    if (account.status === "disabled") { blocked.push(entry(account, "disabled", "账号已禁用，不参与转发")); continue; }
    if (limiterBlocked.has(account.id)) { blocked.push(entry(account, "limiter", "被限制器拦下（余额不足或周期用量到顶）")); continue; }
    const resetAt = Number(cooling[account.id]) || 0;
    if (resetAt > now) { blocked.push(entry(account, "cooldown", `对该模型冷却中，${clockText(resetAt, now)} 恢复`, resetAt)); continue; }
    if (atConcurrencyLimit(account, counts)) {
      blocked.push(entry(account, "concurrency", `并发已满（${activeOf(account, counts)}/${account.maxConcurrent}），等一个在途回落`));
      continue;
    }
    if (!account.hasCredentials) { blocked.push(entry(account, "no-credentials", "没有可用凭据，登录后才能接请求")); continue; }
    const capReason = capabilityReason(account, needs);
    if (capReason) { blocked.push(entry(account, "capability", capReason)); continue; }
    if (account.status !== "online") { blocked.push(entry(account, "offline", "账号非在线状态")); continue; }
    usable.push(account);
  }

  let arranged = baseOrder(usable, strategy, cursor, providerCursors, source.preserveOrder === true);

  // 粘性置顶必须发生在基础序之后：基础序一开头就按优先级排，置顶放在前面会被冲回原位。
  let stickyCandidate = false;
  let stickyHit = false;
  if (stickyAccount) {
    const index = arranged.findIndex((account) => account.id === stickyAccount);
    if (index >= 0) {
      stickyCandidate = true;
      if (index !== 0) {
        const [hit] = arranged.splice(index, 1);
        arranged.unshift(hit);
      }
    }
  }

  // 三层修饰：稳定分层，同层保持基础序。顺序不能换 —— 最后应用的那层约束最强。
  arranged = stablePartition(arranged, (account) => Boolean(sunk[account.id]));
  arranged = stablePartition(arranged, (account) => Boolean(backoff[account.id] && backoff[account.id] > now));
  arranged = stablePartition(arranged, (account) => open.has(account.id));
  if (stickyCandidate) stickyHit = arranged.length > 0 && arranged[0].id === stickyAccount;

  return {
    strategy,
    cursor,
    stickyHit,
    stickyCandidate,
    ordered: arranged.map((account) => {
      const reasons = [];
      if (backoff[account.id] > now) reasons.push("退避中，排在后面");
      if (sunk[account.id]) reasons.push("限流垫底，排在后面");
      if (open.has(account.id)) reasons.push("熔断打开，全场无号时才试它");
      return {
        id: account.id, name: account.name, provider: account.provider,
        account: account.raw || account, state: "usable",
        reason: reasons.length ? reasons.join("；") : "按位次可用",
        resetAt: Number(cooling[account.id]) || 0,
      };
    }),
    blocked,
  };
}

/** 基础序：三种策略只影响这一步，后面的修饰对所有策略一视同仁。
 *  preserveOrder = 调用方已用号池自己的策略（poolStrategy）排好序，这里只做粘性与修饰，
 *  不再按 priority 重排 —— 否则「号池页拖拽的顺序」会被计划悄悄改掉。 */
function baseOrder(rows, strategy, cursor, providerCursors, preserveOrder) {
  const sorted = preserveOrder ? rows.slice() : rows.slice().sort(comparePriority);
  const len = sorted.length;
  if (len <= 1 || strategy === "order") return sorted;

  if (strategy === "rotate") {
    const start = ((Number(cursor) || 0) % len + len) % len;
    return sorted.map((_, index) => sorted[(start + index) % len]);
  }

  // provider：先按家分段（段序 = 各家最优账号首次出现的位置），段内各自环绕。
  const groups = [];
  for (const row of sorted) {
    const hit = groups.find((group) => group.key === row.provider);
    if (hit) hit.rows.push(row);
    else groups.push({ key: row.provider, rows: [row] });
  }
  const out = [];
  for (const group of groups) {
    const size = group.rows.length;
    const start = size <= 1 ? 0 : ((Number(providerCursors[group.key]) || 0) % size + size) % size;
    for (let index = 0; index < size; index++) out.push(group.rows[(start + index) % size]);
  }
  return out;
}

/** 稳定分层：满足 predicate 的移到后面，其余保持原相对顺序。 */
function stablePartition(rows, predicate) {
  const head = [];
  const tail = [];
  for (const row of rows) (predicate(row) ? tail : head).push(row);
  return head.concat(tail);
}

module.exports = { buildPlan, adaptAccount, comparePriority, normalizeStrategy, clockText, STRATEGIES };
