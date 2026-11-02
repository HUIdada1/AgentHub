"use strict";

function creditRank(a) {
  return a.credits === -1 ? Infinity : Number(a.credits) || 0;
}

function bucket(a, costTier, now) {
  const kind = a.meta?.gateway?.billingKind;
  if (kind === "free" || ((!kind || kind === "unknown") && costTier === "free")) return { rank: 0, label: "免费" };
  if (a.expiresAt > now) return { rank: 1, label: "有效到期" };
  if (kind === "permanent") return { rank: 2, label: "确认永久" };
  return { rank: 3, label: "期限未知" };
}

function plan(accounts, { strategy = "optimal", costTier = "", excludeIds = [], model = "", isModelCooled = () => false, inFlightCount = () => 0, zeroBalanceUsable = false, maxInFlight = 0, now = Date.now() } = {}) {
  const excluded = new Set(excludeIds);
  const rows = accounts.map((a) => {
    const group = bucket(a, costTier, now);
    const inFlight = inFlightCount(a.id);
    const configured = Number(a.meta?.gateway?.maxInFlight);
    const limit = configured > 0 ? configured : Number(maxInFlight) || 0;
    let reason = "";
    if (a.status !== "online") reason = "账号非在线状态";
    else if (!a.hasToken) reason = "缺少凭据";
    else if (excluded.has(a.id)) reason = "本轮已尝试";
    else if ((a.creditsKnown || a.creditsAt > 0) && a.credits === 0 && !zeroBalanceUsable) reason = "余额耗尽";
    else if (a.expiresAt > 0 && a.expiresAt <= now) reason = "余额已过期";
    else if (model && isModelCooled(a.id, model)) reason = "该账号模型冷却中";
    else if (limit > 0 && inFlight >= limit) reason = "账号并发已满";
    return { account: a, eligible: !reason, reason, bucket: group.label, rank: group.rank, inFlight, limit };
  });
  rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    let diff = 0;
    const credits = () => {
      const ac = creditRank(a.account), bc = creditRank(b.account);
      return ac === bc ? 0 : ac > bc ? -1 : 1;
    };
    if (strategy === "manual") diff = (Number(a.account.meta?.gateway?.priority) || 0) - (Number(b.account.meta?.gateway?.priority) || 0);
    else if (strategy === "round_robin") diff = (a.account.lastUsed || 0) - (b.account.lastUsed || 0);
    else if (strategy === "credit_first") diff = credits();
    else if (strategy === "expire_first") diff = (a.account.expiresAt || Infinity) - (b.account.expiresAt || Infinity) || credits();
    else diff = a.rank - b.rank || credits() || (a.account.expiresAt || Infinity) - (b.account.expiresAt || Infinity);
    return diff || (a.account.lastUsed || 0) - (b.account.lastUsed || 0) || String(a.account.id).localeCompare(String(b.account.id));
  });
  return rows;
}

module.exports = { plan, bucket, creditRank };
