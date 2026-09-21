// 反代网关 · 额度查询（方案 §6.4）：三软件独立，逐账号批量查询（每渠道并发 ≤2）
// 401 先就地刷新凭证重试一次，仍 401 标 relogin；单账号失败不影响其余账号；成功写日快照
"use strict";
const store = require("./store.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const util = require("./util.cjs");
const events = require("./events.cjs");

let timer = null;
let refreshing = false;

/** 单账号额度刷新：成功回写余额缓存 + credits_history 日快照 */
async function refreshAccount(id) {
  const acc = store.getAccount(id);
  if (!acc) throw new Error("账号不存在");
  const adapter = adapters.get(acc.channel);
  if (!adapter) throw new Error(`未知渠道 ${acc.channel}`);
  let secrets = store.accountSecrets(acc);
  if (!secrets.token) throw new Error("该账号没有凭据");

  let r = await adapter.queryCredits(acc, secrets).catch((e) => ({ error: String((e && e.message) || e) }));
  // 临期预刷新（参考项目 RefreshSkew 语义）：JWT 到期前窗口内先刷 token，避免下次对话首请求吃 401。
  // 窗口按渠道取：默认 24h；小浣熊 access 仅 3h（会话1 §2），用 24h 会把每轮额度刷新都变成
  // 一次刷新——与桌面端抢同一个 refresh_token 互相作废（掉登录根因），故贴官方 300s 惰性语义
  const windowSec = Number(adapter.refreshWindowSec) > 0 ? Number(adapter.refreshWindowSec) : 86400;
  const dec = util.jwtDecode(secrets.token);
  if (dec.exp && dec.exp * 1000 < Date.now() + windowSec * 1000 && secrets.refreshToken) {
    const rr = await adapters.refreshTokenLocked(acc.channel, acc, secrets).catch(() => ({ ok: false }));
    if (rr.ok) {
      store.updateAccount(acc.id, { token: rr.token, refreshToken: rr.refreshToken });
      secrets = { token: rr.token, refreshToken: rr.refreshToken };
    }
  }
  if (r.unavailable) {
    // 积分服务对该账号不开放（实测 Trae pay/ug 域 code 1001，但同一 token 对话域正常）：
    // 不是凭证失效，账号保持可用，余额不动，只把原因带回去展示。
    // 顺手治好旧版误判：曾经因此被打成 relogin 的账号回到 online（token 本身没问题）
    const cur = store.getAccount(acc.id) || acc;
    if (cur.status === "relogin") {
      store.updateAccount(acc.id, { status: "online", coolUntil: 0, coolReason: "" });
    }
    return {
      id: acc.id,
      credits: cur.credits,
      expiresAt: cur.expires_at || 0,
      ok: true,
      unavailable: true,
      message: r.message || "积分服务未对该账号开放",
    };
  }
  if (r.authError) {
    // 401 → 先刷新凭证重试一次（single-flight，与 chat 链路共享互斥）
    const rr = await adapters.refreshTokenLocked(acc.channel, acc, secrets).catch(() => ({ ok: false }));
    if (rr.ok) {
      store.updateAccount(acc.id, { token: rr.token, refreshToken: rr.refreshToken });
      secrets = { token: rr.token, refreshToken: rr.refreshToken };
      r = await adapter.queryCredits(acc, secrets).catch((e) => ({ error: String((e && e.message) || e) }));
    }
    if (r.authError) {
      pool.coolAccount(acc.id, "relogin");
      store.noteError(acc.id, String(r.message || "凭证失效，请重新登录该账号"));
      throw new Error("凭证失效，请重新登录该账号");
    }
  }
  if (r.error) {
    store.noteError(acc.id, r.error);
    throw new Error(r.error);
  }

  // 复活逻辑：拿到新余额后，relogin / exhausted（余额不足或到期被自动切走的）账号回 online。
  // 注意 acc 是本次刷新开始前的旧快照，中间隔了上游网络请求（数秒）——期间请求链路可能刚把
  // 该号冷却（429 → cooling），必须用最新状态判定复活，不然会把新冷却无条件覆盖回 online
  const cur = store.getAccount(acc.id) || acc;
  const revive =
    cur.status === "relogin" || (cur.status === "exhausted" && (r.credits > 0 || (r.expiresAt || 0) > Date.now()));
  store.updateAccount(acc.id, {
    credits: r.credits,
    creditsAt: Date.now(),
    expiresAt: r.expiresAt || cur.expires_at,
    ...(revive ? { status: "online", coolUntil: 0, coolReason: "" } : {}),
  });
  store.snapshotCredits(acc.channel, acc.id, r.credits, r.expiresAt || 0);
  return { id: acc.id, credits: r.credits, expiresAt: r.expiresAt || 0 };
}

/** 单渠道逐账号批量刷新（号池页「刷新当前渠道」用），每渠道并发 ≤2；单账号失败不影响其余 */
async function refreshChannel(channel) {
  if (refreshing) return { ok: false, message: "刷新进行中" };
  refreshing = true;
  try {
    const ids = store
      .listAccounts(channel)
      .filter((a) => a.status !== "disabled" && a.hasToken)
      .map((a) => a.id);
    const results = [];
    for (let i = 0; i < ids.length; i += 2) {
      const batch = await Promise.allSettled(ids.slice(i, i + 2).map((id) => refreshAccount(id)));
      for (const b of batch) results.push(b.status === "fulfilled" ? b.value : { ok: false, message: String((b.reason && b.reason.message) || b.reason) });
    }
    events.emit({ type: "credits" });
    const failed = results.filter((x) => !x.ok);
    return { ok: true, total: results.length, failed: failed.length, results };
  } finally {
    refreshing = false;
  }
}

/** 全量刷新：逐账号批量查询，每渠道并发 ≤2（方案 §6.4）；单账号失败不影响其余 */
async function refreshAll() {
  if (refreshing) return { ok: false, message: "刷新进行中" };
  refreshing = true;
  try {
    const byChannel = new Map();
    for (const acc of store.listAccounts()) {
      if (acc.status === "disabled" || !acc.hasToken) continue;
      if (!byChannel.has(acc.channel)) byChannel.set(acc.channel, []);
      byChannel.get(acc.channel).push(acc.id);
    }
    const results = [];
    for (const ids of byChannel.values()) {
      // 渠道内两两并发
      for (let i = 0; i < ids.length; i += 2) {
        const batch = await Promise.allSettled(ids.slice(i, i + 2).map((id) => refreshAccount(id)));
        for (const b of batch) results.push(b.status === "fulfilled" ? { ok: true, ...b.value } : { ok: false, message: String((b.reason && b.reason.message) || b.reason) });
      }
    }
    events.emit({ type: "credits" });
    const failed = results.filter((r) => !r.ok);
    return { ok: true, total: results.length, failed: failed.length, results };
  } finally {
    refreshing = false;
  }
}

/** 定时刷新（周期可配，默认 30min；设置改动经 restartScheduler 生效） */
function startScheduler(getIntervalMin) {
  stopScheduler();
  const tick = () => {
    refreshAll().catch(() => {});
    timer = setTimeout(tick, Math.max(1, getIntervalMin() || 30) * 60000);
  };
  timer = setTimeout(tick, Math.max(1, getIntervalMin() || 30) * 60000);
}

function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { refreshAccount, refreshChannel, refreshAll, startScheduler, stopScheduler, isRefreshing: () => refreshing };
