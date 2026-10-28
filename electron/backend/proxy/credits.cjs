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
// 反代网关 · 额度查询：三软件独立，逐账号批量查询（每渠道并发 ≤2）
// 401 先就地刷新凭证重试一次，仍 401 标 relogin；单账号失败不影响其余账号；成功写日快照
"use strict";
const store = require("./store.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const util = require("./util.cjs");
const events = require("./events.cjs");
// 休眠唤醒守卫：唤醒后静默窗内跳过本轮（见 backend/wakeGuard.cjs）
const wakeGuard = require("../wakeGuard.cjs");

let timer = null;
let refreshing = false;

/** 该渠道有没有「余额」这个概念：自定义提供商是 API Key 直连，通用适配器刻意不定义 queryCredits
 *  （见 adapters.cjs 的 makeOpenaiCompat）。缺这个方法还去刷，等于拿用户的第三方 Key 打一个
 *  不存在的余额接口。三条刷新入口（单账号 / 单渠道 / 定时全量）全部先过这道判断。 */
function creditsCapable(channel) {
  const ad = adapters.get(channel);
  return !!(ad && typeof ad.queryCredits === "function");
}

function noCreditsMessage(channel) {
  return store.isBuiltinChannel(channel) ? "该渠道不提供额度查询（官方无对外余额接口）" : "该渠道为 API Key 直连，无余额概念";
}

/** 临期预刷新（RefreshSkew 语义）：JWT 到期前窗口内先刷 token，返回可直接用于
 *  本次/下次请求的 secrets（刷新失败原样返回，绝不因刷新失败把调用方拖进错误分支）。
 *
 *  窗口按渠道取：默认 24h；小浣熊 access 仅 3h（会话1 §2），用 24h 会把每轮刷新都变成一次
 *  刷新——与桌面端抢同一个 refresh_token 互相作废（掉登录根因），故贴官方 300s 惰性语义。
 *
 *  抽成公共函数而不是各链路各写一份：余额与签到面对的是同一个「手上 token 已过期」问题，
 *  口径一旦分叉就会出现「余额正常、签到报登录态已过期」这类只在一处暴露的缺陷。
 *  noPersist 渠道（AutoClaw）：新凭证只进适配器进程缓存、不落库——服务端轮换
 *  refresh_token，落库会与桌面端自己的刷新互相顶掉。 */
async function ensureFreshSecrets(acc, secrets) {
  const adapter = adapters.get(acc && acc.channel);
  if (!adapter || !secrets || !secrets.token || !secrets.refreshToken) return secrets;
  const windowSec = Number(adapter.refreshWindowSec) > 0 ? Number(adapter.refreshWindowSec) : 86400;
  const dec = util.jwtDecode(secrets.token);
  if (!(dec.exp && dec.exp * 1000 < Date.now() + windowSec * 1000)) return secrets;
  const rr = await adapters.refreshTokenLocked(acc.channel, acc, secrets).catch(() => ({ ok: false }));
  if (!rr.ok) return secrets;
  if (!rr.noPersist) store.updateAccount(acc.id, { token: rr.token, refreshToken: rr.refreshToken });
  return { ...secrets, token: rr.token, refreshToken: rr.refreshToken };
}

/** 单账号额度刷新：成功回写余额缓存 + credits_history 日快照 */
async function refreshAccount(id) {
  const acc = store.getAccount(id);
  if (!acc) throw new Error("账号不存在");
  const adapter = adapters.get(acc.channel);
  if (!adapter) throw new Error(`未知渠道 ${acc.channel}`);
  if (!creditsCapable(acc.channel)) throw new Error(noCreditsMessage(acc.channel));
  let secrets = store.accountSecrets(acc);
  if (!secrets.token) throw new Error("该账号没有凭据");

  let r = await adapter.queryCredits(acc, secrets).catch((e) => ({ error: String((e && e.message) || e) }));
  // 临期预刷新（RefreshSkew 语义）：JWT 到期前窗口内先刷 token，避免下次对话首请求吃 401
  secrets = await ensureFreshSecrets(acc, secrets);
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
      if (!rr.noPersist) store.updateAccount(acc.id, { token: rr.token, refreshToken: rr.refreshToken });
      // 换新凭据时保留 meta（Cookie/deviceId 等会话元数据）：只重建 token/refreshToken 会把
      // 它们丢掉，与 ensureFreshSecrets / 签到链路的 `{...secrets, ...}` 口径分叉——
      // 凡 queryCredits 里读 secrets.meta 的渠道（如魔搭的 Cookie 族）都会在 401 重试那次静默降级
      secrets = { ...secrets, token: rr.token, refreshToken: rr.refreshToken };
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

  // 逐包明细：adapter 返回 packages 时落库，并以包集为单一事实源派生账号级 credits/expiresAt——
  // 剩余 = Σ未过期包剩余，最近到期 = min(剩余>0 且未过期 的包到期)。返回里没有 packages 的渠道
  // （上游接口就不拆包）走原口径，账号级聚合值不受影响。
  let credits = r.credits;
  // adapter 明确返回的 expiresAt（含 0 = 无到期/长期有效）要信；只有字段缺省（undefined/null）
  // 才沿用库里旧值。0 被 || 当成缺省会把旧到期时间永久回填——AutoClaw 积分无到期、接口恒回 0，
  // 登录写入的 token 有效期（约 24h）因此清不掉，被 pickAccount 判「余额已到期」锁死（#152）
  const hasExpiry = r.expiresAt !== undefined && r.expiresAt !== null;
  let expiresAt = hasExpiry ? (Number(r.expiresAt) || 0) : 0;
  // 派生成功就整体信派生值：expiresAt=0 是「长期/没有在用到期」，不得回填旧账号级到期——
  // 否则混合包场景（有限包过期 + 不限量包）下，pickAccount 的「余额已到期」会把不限量号
  // 永久标死，跟下面的复活判据打乒乓。回填只属于无包集的原口径（adapter 没给就沿用旧值）。
  let fromPackages = false;
  if (Array.isArray(r.packages)) {
    store.setCreditPackages(acc.id, acc.channel, r.packages);
    const derived = pool.deriveAccountCredits(r.packages);
    if (derived) {
      credits = derived.credits;
      expiresAt = derived.expiresAt;
      fromPackages = true;
      // 全部过期（F19）：包集给出 allExpired=true 时，把账号级 expiresAt 强制写为「刚刚过期」
      // 让 pickAccount 的「余额已到期」判据（expiresAt <= now）能抓住它，而不是被 expiresAt=0
      // 的「长期有效」语义放过——否则「所有包都过期」的账号会一直被当有效余额调度。
      if (derived.allExpired && credits === 0) expiresAt = Date.now() - 1;
    }
  }

  // 复活逻辑：拿到新余额后，relogin / exhausted（余额不足或到期被自动切走的）账号回 online。
  // 注意 acc 是本次刷新开始前的旧快照，中间隔了上游网络请求（数秒）——期间请求链路可能刚把
  // 该号冷却（429 → cooling），必须用最新状态判定复活，不然会把新冷却无条件覆盖回 online
  const cur = store.getAccount(acc.id) || acc;
  // credits === -1 = 「不限额度」哨兵（pool.cjs 选号、server.cjs 扣减都按这个念法豁免）。
  // 本条之前它只是防御性写法、没有 producer 真产得出 -1；逐包链路里一个 remaining=-1 的包
  // 经上面派生就会让 credits 变成 -1。而 exhausted 不只由余额判据产生——错误分类走 pool.cjs 的
  // coolAccount("exhausted") 也会打进来，于是「无限额度的号被误标耗尽」再也刷不回来：
  // 拿不到有限余额就无法证伪「余额不足」，按可用复活。
  const revive =
    cur.status === "relogin" || (cur.status === "exhausted" && (credits > 0 || credits === -1 || (expiresAt || 0) > Date.now()));
  store.updateAccount(acc.id, {
    credits,
    creditsAt: Date.now(),
    expiresAt: fromPackages ? expiresAt : hasExpiry ? expiresAt : cur.expires_at,
    ...(revive ? { status: "online", coolUntil: 0, coolReason: "" } : {}),
  });
  store.snapshotCredits(acc.channel, acc.id, credits, expiresAt || 0);
  return { id: acc.id, credits, expiresAt: expiresAt || 0 };
}

/** 逐账号批量刷新的共享内核：每批 2 并发、Promise.allSettled 容错、结果统一补 ok。
 *  refreshChannel 与 refreshAll 只在「收集哪些账号 id」上分家，批量节奏与结果组装收敛到这一处 */
async function refreshBatch(ids) {
  const results = [];
  for (let i = 0; i < ids.length; i += 2) {
    const batch = await Promise.allSettled(ids.slice(i, i + 2).map((id) => refreshAccount(id)));
    // 成功必须补 ok:true：refreshAccount 正常返回不带 ok，直接推入会被 failed 统计全判成失败
    for (const b of batch) {
      results.push(b.status === "fulfilled" ? { ok: true, ...b.value } : { ok: false, message: String((b.reason && b.reason.message) || b.reason) });
    }
  }
  return results;
}

/** 单渠道逐账号批量刷新（号池页「刷新当前渠道」用），每渠道并发 ≤2；单账号失败不影响其余 */
async function refreshChannel(channel) {
  if (refreshing) return { ok: false, message: "刷新进行中" };
  // 关闭的渠道不刷（上游启闭：调用类操作对它一律不存在）
  if (!adapters.channelOn(channel)) return { ok: false, message: "该渠道已关闭" };
  if (!creditsCapable(channel)) return { ok: false, message: noCreditsMessage(channel) };
  refreshing = true;
  try {
    const ids = store
      .listAccounts(channel)
      .filter((a) => a.status !== "disabled" && a.hasToken)
      .map((a) => a.id);
    const results = await refreshBatch(ids);
    events.emit({ type: "credits" });
    const failed = results.filter((x) => !x.ok);
    return { ok: true, total: results.length, failed: failed.length, results };
  } finally {
    refreshing = false;
  }
}

/** 全量刷新：逐账号批量查询，每渠道并发 ≤2；单账号失败不影响其余 */
async function refreshAll() {
  if (refreshing) return { ok: false, message: "刷新进行中" };
  refreshing = true;
  try {
    const byChannel = new Map();
    for (const acc of store.listAccounts()) {
      if (acc.status === "disabled" || !acc.hasToken) continue;
      // relogin = 凭证已判废（上游吊销/刷新失败，需人工重新导入或 OAuth）：定时刷新它只会
      // 得到注定失败的 401 余额查询 + 凭证刷新重试，每轮 2 次无效请求永续循环——上游风控
      // 视角正是「失效凭证反复试探」的机器行为特征。等用户重新登录（状态回 online）后自然恢复
      if (acc.status === "relogin") continue;
      if (!creditsCapable(acc.channel)) continue; // 提供商不参与额度刷新（见 creditsCapable 注释）
      // 关闭的渠道不刷（上游启闭：定时全量刷新不碰它，避免无谓的上游请求）
      if (!adapters.channelOn(acc.channel)) continue;
      if (!byChannel.has(acc.channel)) byChannel.set(acc.channel, []);
      byChannel.get(acc.channel).push(acc.id);
    }
    const results = [];
    for (const ids of byChannel.values()) {
      results.push(...await refreshBatch(ids));
    }
    events.emit({ type: "credits" });
    const failed = results.filter((r) => !r.ok);
    return { ok: true, total: results.length, failed: failed.length, results };
  } finally {
    refreshing = false;
  }
}

/** 定时刷新（周期可配，默认 30min；设置改动经 restartScheduler 生效）
 *
 *  R-11（2026-10-28）：额度轮询加**独立开关 + 周期下限**。
 *   · `getIntervalMin()` 返回 `null`（或 0 / 负数）= **关闭轮询**：不再排下一轮，也不再空转；
 *     手动刷新（refreshAll / 号池页刷新按钮）完全不受影响。
 *   · 周期**下限 15 分钟**：防止被配成高频对外轮询（额度查询是主动出站请求）。
 *  依据：docs/号池签到核对-20261028/05-pool-probing-audit.md R-11。 */
function startScheduler(getIntervalMin) {
  stopScheduler();
  const intervalMs = () => {
    const v = getIntervalMin();
    if (v == null || Number(v) <= 0) return null;      // 显式关闭
    return Math.max(15, Number(v) || 30) * 60000;      // 下限 15 分钟
  };
  const scheduleNext = () => {
    const ms = intervalMs();
    if (ms == null) return;                            // 已关闭：不排下一轮
    timer = setTimeout(tick, ms);
  };
  const tick = () => {
    // 唤醒守卫（见 backend/wakeGuard.cjs）：
    //   B. 先做时间跳跃检测——不依赖电源事件的兜底（必须**先于** A 判定调用）
    //   A. 静默窗内跳过本轮：睡眠期间 setTimeout 不触发，唤醒后本 tick 立刻到期；
    //      若此时开跑，会与签到、记忆中枢任务在同一刻收敛。
    // 跳过的仅是**本轮**——照常排下一轮，不影响正常节奏。
    wakeGuard.noteTick("credits-refresh", intervalMs() || 30 * 60000);
    if (!wakeGuard.periodicAllowed()) {
      scheduleNext();
      return;
    }
    refreshAll().catch(() => {});
    scheduleNext();
  };
  scheduleNext();
}

function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { refreshAccount, refreshChannel, refreshAll, startScheduler, stopScheduler, isRefreshing: () => refreshing, ensureFreshSecrets };
