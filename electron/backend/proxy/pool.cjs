// 反代网关 · 号池服务（方案 §6.10）：账号状态机 + 池内调度 + 错误分类冷却
// 状态机五态：online / cooling / exhausted / relogin / disabled；调度只挑 online
"use strict";
const store = require("./store.cjs");

/** 派生有效状态：cooling 到期自动回 online；exhausted 到次日 04:00 后给复活机会 */
function effectiveStatus(acc, now) {
  now = now || Date.now();
  if (acc.status === "cooling" && acc.cool_until && acc.cool_until <= now) {
    store.updateAccount(acc.id, { status: "online", coolUntil: 0, coolReason: "" });
    return "online";
  }
  if (acc.status === "exhausted" && acc.cool_until && acc.cool_until <= now) return "online";
  return acc.status;
}

/** 渠道号池视图（账号明细 + 派生状态） */
function poolAccounts(channel) {
  return store.listAccounts(channel).map((a) => {
    const before = a.status;
    const eff = effectiveStatus(a);
    // 派生复活（cooling/exhausted 到期）必须落库，否则调度/健康检查读原始行永不复活
    if (before !== eff) store.updateAccount(a.id, { status: eff, coolUntil: 0, coolReason: "" });
    return { ...a, status: eff };
  });
}

/**
 * 池内选号：expire_first（默认，积分先到期先用）/ credit_first / round_robin
 * 两种自动切换（不发请求、调度期前置生效）：
 *  ① 余额不足自动切换——已查到余额为 0 的账号直接标记耗尽并跳过，不再浪费一次上游 402；
 *  ② 余额到期自动切换——到期时间已过的账号余额视为失效，标记并跳过；
 *     搭配默认 expire_first 策略：快到期账号永远排在最前优先消耗（到期前榨干），过期即自动切走。
 * 被跳过的账号等下次额度刷新拿到新余额/新到期时间后自动复活（credits.cjs）。
 */
function pickAccount(channel, strategy, excludeIds) {
  const now = Date.now();
  const exclude = new Set(excludeIds || []);
  const candidates = [];
  for (const a of poolAccounts(channel)) {
    if (a.status !== "online" || !a.hasToken || exclude.has(a.id)) continue;
    if (a.creditsAt > 0 && a.credits <= 0) {
      // ① 已知余额不足：标记耗尽（次日 04:00 给复活机会），自动切换下一账号
      store.updateAccount(a.id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: "余额不足，已自动切换" });
      continue;
    }
    if (a.expiresAt > 0 && a.expiresAt <= now) {
      // ② 余额已到期：标记失效（靠额度刷新复活），自动切换下一账号
      store.updateAccount(a.id, { status: "exhausted", coolUntil: 0, coolReason: "余额已到期，已自动切换" });
      continue;
    }
    candidates.push(a);
  }
  if (!candidates.length) return null;
  switch (strategy) {
    case "credit_first":
      candidates.sort((a, b) => b.credits - a.credits);
      break;
    case "round_robin":
      candidates.sort((a, b) => a.lastUsed - b.lastUsed);
      break;
    case "expire_first":
    default:
      // 先到期的先用；没查过到期时间的排最后（不失效优先消耗快过期的）
      candidates.sort((a, b) => (a.expiresAt || Number.MAX_SAFE_INTEGER) - (b.expiresAt || Number.MAX_SAFE_INTEGER));
      break;
  }
  return candidates[0];
}

/** 次日 04:00（402 积分耗尽的长冷却点，对齐参考项目 HardCredit） */
function nextDay4AM() {
  const d = new Date();
  d.setHours(4, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 错误分类冷却（方案 §6.10）：402→exhausted 至次日 04:00；429→60s；5xx→10min；401→relogin */
function coolAccount(id, kind, detail) {
  const now = Date.now();
  switch (kind) {
    case "credit": // 402 积分耗尽
      store.updateAccount(id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: detail || "积分耗尽" });
      break;
    case "rate": // 429 限流
      store.updateAccount(id, { status: "cooling", coolUntil: now + 60000, coolReason: detail || "上游限流" });
      break;
    case "server": // 5xx / 网络异常
      store.updateAccount(id, { status: "cooling", coolUntil: now + 600000, coolReason: detail || "上游异常" });
      break;
    case "relogin": // 401 刷新失败
      store.updateAccount(id, { status: "relogin", coolUntil: 0, coolReason: detail || "凭证失效，需重新登录" });
      break;
    default:
      store.updateAccount(id, { status: "cooling", coolUntil: now + 60000, coolReason: detail || "" });
  }
}

/** 号池聚合视图（号池卡片顶部：总余额/账号数/可用/最早到期/今日消耗，单一数据源实时推导） */
function poolSummary(channel) {
  const accs = poolAccounts(channel);
  const now = Date.now();
  const online = accs.filter((a) => a.status === "online" && a.hasToken);
  const expires = accs.map((a) => a.expiresAt).filter((t) => t > 0);
  return {
    channel,
    totalCredits: online.reduce((s, a) => s + (a.credits || 0), 0),
    accountCount: accs.length,
    onlineCount: online.length,
    earliestExpire: expires.length ? Math.min(...expires) : 0,
    expiringSoon: accs.some((a) => a.expiresAt > 0 && a.expiresAt - now < 86400000),
    todayReq: accs.reduce((s, a) => s + a.todayReq, 0),
    todayTokens: accs.reduce((s, a) => s + a.todayTokens, 0),
    lastCreditsAt: accs.reduce((m, a) => Math.max(m, a.creditsAt || 0), 0),
  };
}

module.exports = { effectiveStatus, poolAccounts, pickAccount, coolAccount, poolSummary, nextDay4AM };
