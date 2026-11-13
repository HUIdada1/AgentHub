/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-09
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 号池管家 · 签到中心：聚合快照 + 三块福利的动作入口
//
// ── 为什么单独一个文件 ────────────────────────────────────────
// 签到动作（checkinBatch）在 index.cjs 里已经很长了，那套是「逐账号串行 + 互斥 + 自动签到」的
// 执行器；本文件是**只读视图 + 三个一次性动作**，两者生命周期不同：快照不发上游请求，
// 动作要打上游。混在 index.cjs 里会让那个文件继续膨胀，也让「哪些渠道支持哪块」无处安放。
//
// ── 三块的真实数据源（不臆造）──────────────────────────────────
//   新手福利 onboarding：小浣熊 raccoon 的 claimOnboarding（桌面端 / 手机端首登奖励各一次）。
//     台账落在账号 meta.onboardingGrants（key → 结算时刻；-1 = 端点已下线不再重试）。
//     上游接口本身就是幂等的「探测即领取」，所以本文件不区分 query / claim —— 都走同一个调用。
//   活动福利 plans：ZCode 的 billing/preview（可领套餐）+ billing/claim（领取，需滑块验证码）。
//     滑块由 Electron 侧 platform.solveCaptcha 弹官方 SDK 完成；容器形态诚实拒绝（见 platform/node.cjs）。
//   成长任务 growth：**当前没有任何渠道申报**。WorkBuddy 的 /activity/growth/streak 在 5.6.2
//     已不存在（见 docs/号池签到核对-20261028/12 §5 与 15 §2.2 W5），故能力表里刻意不列。
//     页面按 adminPanels 决定显不显示这一节 —— 列了才渲染，避免给用户一个永远空的区块。
//
// ── 快照为什么不打上游 ────────────────────────────────────────
// 一个渠道几十个账号，进页面就打上游等于把「看一眼」变成一次批量探测。快照只读本机台账与
// meta.checkin；要看真实明细必须用户显式点「查询任务」。
"use strict";

const store = require("./store.cjs");
// 管理账号面与转发链路分离：checkin-center 只读账号台账与签到状态，
// 属于「账号管理」语义，因此消费 management-adapters.cjs（与 index/discovery/credits 同一注册表）。
// 其余渠道的模型执行全部由外部插件提供，主程序不含渠道协议实现；
// 不存在于 ADAPTERS 的渠道走 management-adapters.get()。
const adapters = require("./management-adapters.cjs");
const oplog = require("./oplog.cjs");
const platform = require("./platform/index.cjs");

/**
 * 渠道能力表：**只有真实实现了的才列进来**。
 * 新增一块能力 = 在这里加一行 + 在下方 switch 里实现动作，页面自动跟着出现。
 */
const CAPABILITIES = {
  raccoon: {
    onboarding: true,
    /** 展示用副标题：说明这块在这个渠道是什么形态 */
    onboardingNote: "桌面端 / 手机端首登奖励，各一次",
  },
  zcode: {
    plans: true,
    plansNote: "限时体验套餐，领取需滑块验证码",
  },
  workbuddy: {
    growth: true,
    growthNote: "腾讯小猫猫猫旅行 · 每日派出与到站领奖",
  },
};

/** 渠道能力（未知渠道返回空对象，调用方据此判「这块没有」） */
function capabilityOf(channel) {
  return CAPABILITIES[channel] || {};
}

/** 北京时间自然日（与号池签到口径一致：跨天判定用 CST，不用机器本地时区） */
function cstDay(ts) {
  const t = Number(ts) || 0;
  if (!t) return "";
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}

function todayCst() {
  return cstDay(Date.now());
}

/**
 * 新手福利台账视图。
 * 台账形状见 store.noteOnboardingGrant：{ [key]: 结算时刻 }，-1 是「端点已下线」哨兵。
 * unclaimed = 还没落台账的条数（含 -1 之外的所有未结算键）。
 */
function onboardingView(account) {
  const ledger = account.onboardingGrants && typeof account.onboardingGrants === "object" ? account.onboardingGrants : {};
  const keys = Object.keys(ledger);
  const settledAt = keys.reduce((max, k) => Math.max(max, Number(ledger[k]) > 0 ? Number(ledger[k]) : 0), 0);
  return {
    settled: keys.length > 0,
    settledAt,
    ledger,
    /** 已结算条数（-1 也算已定论：端点没了，重试无意义） */
    settledCount: keys.length,
  };
}

/**
 * 活动福利视图：今天领了几份。
 * 数据源是 meta.checkin（noteCheckin 写的当天一条），跨天按 cstDay 判过期。
 * 为什么不用 checkin_history：那张表是「每次动作一行」，同一账号同日多次会有多行，
 * 而这里要的是「今天有没有领到」——meta.checkin 的语义正好是「当天最新一次结果」。
 */
function plansView(account) {
  const c = account.checkin && typeof account.checkin === "object" ? account.checkin : null;
  const sameDay = !!(c && c.at && cstDay(c.at) === todayCst());
  return {
    claimAt: sameDay ? Number(c.at) || 0 : 0,
    claimOk: sameDay ? c.ok !== false && !c.unavailable : false,
    claimMessage: sameDay ? String(c.message || "") : "",
  };
}

/**
 * 聚合快照（只读，不发上游请求）。
 * 结构对齐示例项目 Agent2Providers 的 /api/checkin-center：daily / extras / adminPanels。
 */
function snapshot() {
  const accounts = store.listAccounts();
  const byChannel = new Map();
  for (const acc of accounts) {
    if (!byChannel.has(acc.channel)) byChannel.set(acc.channel, []);
    byChannel.get(acc.channel).push(acc);
  }

  const daily = [];
  const onboarding = [];
  const plans = [];
  const growth = [];
  let todayDone = 0;
  let todayEligible = 0;

  for (const [channel, list] of byChannel) {
    const cap = capabilityOf(channel);
    const usable = list.filter((a) => a.hasToken && a.status !== "disabled");
    const rows = usable.map((a) => {
      const c = a.checkin && typeof a.checkin === "object" ? a.checkin : null;
      const sameDay = !!(c && c.at && cstDay(c.at) === todayCst());
      const done = sameDay && c.ok !== false && !c.unavailable;
      if (done) todayDone++;
      if (!c || !c.unavailable) todayEligible++;
      return {
        id: a.id,
        name: a.name,
        uid: a.uid,
        status: a.status,
        checkedInToday: done,
        checkinAt: sameDay ? Number(c.at) || 0 : 0,
        streakDays: sameDay ? Number(c.streakDays) || 0 : 0,
        message: sameDay ? String(c.message || "") : "",
        /** 上游明确说不开放签到（如 zcode 没有活动）——界面显示「不开放」而不是「待签」 */
        unavailable: sameDay ? !!c.unavailable : false,
      };
    });
    if (rows.length) {
      daily.push({
        channel,
        label: store.channelDisplay(channel),
        accounts: rows,
        doneCount: rows.filter((r) => r.checkedInToday).length,
        totalCount: rows.length,
      });
    }

    if (cap.onboarding) {
      for (const a of usable) {
        const v = onboardingView(a);
        onboarding.push({
          id: a.id,
          name: a.name,
          uid: a.uid,
          channel,
          note: cap.onboardingNote || "",
          settled: v.settled,
          settledAt: v.settledAt,
          settledCount: v.settledCount,
          ledger: v.ledger,
        });
      }
    }

    if (cap.plans) {
      for (const a of usable) {
        const v = plansView(a);
        plans.push({
          id: a.id,
          name: a.name,
          uid: a.uid,
          channel,
          note: cap.plansNote || "",
          claimAt: v.claimAt,
          claimOk: v.claimOk,
          claimMessage: v.claimMessage,
        });
      }
    }

    if (cap.growth) {
      for (const a of usable) growth.push({ id: a.id, name: a.name, uid: a.uid, channel });
    }
  }

  // 管理面板：页面按这个数组决定渲染哪几节（空数组 = 整节不出现）
  const adminPanels = [];
  if (onboarding.length) adminPanels.push("onboarding");
  if (plans.length) adminPanels.push("plans");
  if (growth.length) adminPanels.push("growth");

  return {
    generatedAt: Date.now(),
    today: todayCst(),
    daily: { providers: daily, todayDone, todayEligible },
    extras: { onboarding, plans, growth },
    adminPanels,
    capabilities: CAPABILITIES,
  };
}

/**
 * 取账号 + 适配器 + 已解密凭据。
 *
 * ⚠ 必须用 store.getAccount 的**原始行**（不是 listAccounts 的脱敏视图）：
 * 适配器要读 account.meta（Cookie / 台账），而脱敏视图里的 meta 是投影过的字段，
 * 而且原始行的 meta 是 JSON 字符串 —— 所以这里按 index.cjs 的 checkinBatch 同款做法，
 * 把 secrets.meta（已 parse + 解密）拼回去。少了这一步，raccoon 的 onboardingGrants
 * 台账永远是空的，表现为「每次点都重新领」。
 */
function pickAccount(accountId) {
  const live = accountId ? store.getAccount(String(accountId)) : null;
  if (!live) return { ok: false, message: "账号不存在（可能已被删除）" };
  if (live.status === "disabled") return { ok: false, message: "账号已停用，请先在号池启用" };
  const secrets = store.accountSecrets(live);
  if (!secrets || !secrets.token) return { ok: false, message: "该账号没有可用凭据，请先登录" };
  const account = { ...live, meta: secrets.meta || {} };
  const adapter = adapters.get(account.channel);
  if (!adapter) return { ok: false, message: `渠道 ${account.channel} 的适配器未就绪` };
  return { ok: true, account, secrets, adapter };
}

/**
 * 新手福利：查询即领取（上游接口幂等）。
 *
 * 为什么 query 和 claim 合成一个：小浣熊的两个首登端点本身就是「POST 一次，granted 真假都算落定」，
 * 不存在「先只读预览、再写」的两段式。硬拆成两个 IPC 只会让前端多一次无意义的往返。
 *
 * 失败不落台账（下次点还会重试）；404/410 落 -1 哨兵（端点下线，不再白打）。
 */
async function onboardingClaim(accountId) {
  const picked = pickAccount(accountId);
  if (!picked.ok) return picked;
  const { account, secrets, adapter } = picked;
  if (!capabilityOf(account.channel).onboarding) {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 没有新手福利` };
  }
  if (typeof adapter.claimOnboarding !== "function") {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 适配器未实现新手福利` };
  }

  let result;
  try {
    result = await adapter.claimOnboarding(account, secrets);
  } catch (e) {
    const message = String((e && e.message) || e);
    oplog.log("error", "签到中心", `${account.name} 新手福利领取异常：${message}`, { channel: account.channel });
    return { ok: false, message };
  }

  // 成功（含幂等已领）的 key 落台账；失败不落，下次重试
  if (result && result.settled && Object.keys(result.settled).length) {
    try {
      store.noteOnboardingGrant(account.id, result.settled);
    } catch (e) {
      oplog.log("warn", "签到中心", `${account.name} 新手福利台账写入失败：${String((e && e.message) || e)}`, { channel: account.channel });
    }
  }

  const rows = Array.isArray(result && result.results) ? result.results : [];
  const okCount = rows.filter((r) => r.ok).length;
  const failCount = rows.filter((r) => !r.ok).length;
  if (failCount) {
    oplog.log("warn", "签到中心", `${account.name} 新手福利 ${okCount} 项成功 / ${failCount} 项失败`, { channel: account.channel });
  } else {
    oplog.log("info", "签到中心", `${account.name} 新手福利已结清（${okCount} 项）`, { channel: account.channel });
  }

  return {
    ok: !!(result && result.ok),
    message: (result && result.message) || (failCount ? `${failCount} 项领取失败，可重试` : "新手福利已结清"),
    tasks: rows.map((r) => ({
      key: r.key || "",
      title: r.title || r.key || "",
      ok: !!r.ok,
      already: !!r.already,
      gone: !!r.gone,
      points: Number(r.points) || 0,
      error: r.error || "",
    })),
    claimed: Number(result && result.claimed) || 0,
    already: Number(result && result.already) || 0,
    failed: failCount,
    points: Number(result && result.claimedPoints) || 0,
    settled: !!(result && result.settled && Object.keys(result.settled).length),
  };
}

/** 活动福利：可领套餐预览（只读，不打 claim） */
async function plansPreview(accountId) {
  const picked = pickAccount(accountId);
  if (!picked.ok) return picked;
  const { account, secrets, adapter } = picked;
  if (!capabilityOf(account.channel).plans) {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 没有活动福利` };
  }
  if (typeof adapter.checkinStatus !== "function") {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 适配器未实现活动福利查询` };
  }
  try {
    const r = await adapter.checkinStatus(account, secrets);
    if (!r || r.ok === false) {
      const message = String((r && r.message) || "查询失败");
      oplog.log("warn", "签到中心", `${account.name} 活动福利查询失败：${message}`, { channel: account.channel });
      return { ok: false, message };
    }
    return {
      ok: true,
      unavailable: !!r.unavailable,
      message: String(r.message || ""),
      plans: (Array.isArray(r.plans) ? r.plans : []).map((p) => ({
        planId: String(p.planId || ""),
        name: String(p.name || ""),
        description: String(p.description || ""),
        priority: Number(p.priority) || 0,
        endsAt: Number(p.endsAt) || 0,
      })),
    };
  } catch (e) {
    const message = String((e && e.message) || e);
    oplog.log("error", "签到中心", `${account.name} 活动福利查询异常：${message}`, { channel: account.channel });
    return { ok: false, message };
  }
}

/**
 * 活动福利：领取指定套餐。
 *
 * 滑块二段流：首次调用不带 captcha，上游启用验证码时适配器回 {needCaptcha, captcha}，
 * 这里用 platform.solveCaptcha 弹官方 SDK 拿 verifyParam，再带 captcha 重调一次。
 * 容器形态 platform.solveCaptcha 会诚实拒绝（node.cjs），于是返回 needCaptcha 让界面提示
 * 「请到桌面版领取」——不假装能过码。
 */
async function plansClaim(accountId, { planId, captcha } = {}) {
  const picked = pickAccount(accountId);
  if (!picked.ok) return picked;
  const { account, secrets, adapter } = picked;
  if (!capabilityOf(account.channel).plans) {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 没有活动福利` };
  }
  if (typeof adapter.checkin !== "function") {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 适配器未实现活动福利领取` };
  }

  const opts = { planId: String(planId || "") };
  if (captcha && captcha.verifyParam) opts.captcha = captcha;

  let r;
  try {
    r = await adapter.checkin(account, secrets, opts);
  } catch (e) {
    const message = String((e && e.message) || e);
    oplog.log("error", "签到中心", `${account.name} 活动福利领取异常：${message}`, { channel: account.channel });
    return { ok: false, message };
  }

  // 需要过码：交互形态下弹 SDK；容器形态诚实拒绝
  if (r && r.needCaptcha && r.captcha && r.captcha.sceneId && !opts.captcha) {
    const cap = await platform.solveCaptcha(r.captcha);
    if (!cap || !cap.ok) {
      const message = String((cap && cap.message) || "人机校验未完成");
      oplog.log("warn", "签到中心", `${account.name} 活动福利需人工过码：${message}`, { channel: account.channel });
      return { ok: false, needCaptcha: true, message };
    }
    try {
      r = await adapter.checkin(account, secrets, {
        planId: r.planId || opts.planId,
        captcha: { verifyParam: cap.verifyParam, region: cap.region || r.captcha.region, sceneId: r.captcha.sceneId },
      });
    } catch (e) {
      const message = String((e && e.message) || e);
      oplog.log("error", "签到中心", `${account.name} 过码后领取异常：${message}`, { channel: account.channel });
      return { ok: false, message };
    }
  }

  if (r && r.ok === false && r.needCaptcha) {
    oplog.log("warn", "签到中心", `${account.name} 活动福利仍需人工过码`, { channel: account.channel });
    return { ok: false, needCaptcha: true, message: String(r.message || "领取需要完成一次人机校验") };
  }

  if (r && r.ok) {
    oplog.log("info", "签到中心", `${account.name} 活动福利领取成功${r.message ? `：${r.message}` : ""}`, { channel: account.channel });
  } else {
    oplog.log("warn", "签到中心", `${account.name} 活动福利领取失败：${String((r && r.message) || "未知错误")}`, { channel: account.channel });
  }

  return {
    ok: !!(r && r.ok),
    already: !!(r && r.already),
    message: String((r && r.message) || (r && r.ok ? "领取成功" : "领取失败")),
    planId: String((r && r.planId) || opts.planId || ""),
    credit: Number(r && r.credit) || 0,
  };
}

/**
 * 成长任务：查询（目前已支持腾讯 WorkBuddy 猫猫旅行）。
 */
async function growthQuery(accountId) {
  const picked = pickAccount(accountId);
  if (!picked.ok) return picked;
  const { account, secrets, adapter } = picked;
  if (!capabilityOf(account.channel).growth) {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 没有成长任务（当前版本无渠道支持）` };
  }
  if (typeof adapter.travelStatus !== "function") {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 适配器未实现猫猫旅行查询` };
  }
  try {
    const res = await adapter.travelStatus(account, secrets);
    return res;
  } catch (e) {
    const message = String((e && e.message) || e);
    oplog.log("error", "签到中心", `${account.name} 猫猫旅行查询异常：${message}`, { channel: account.channel });
    return { ok: false, message };
  }
}

/** 成长任务：执行（腾讯 WorkBuddy 猫猫旅行单趟巡检：领养 / 派出 / 领奖）。 */
async function growthRun(accountId) {
  const picked = pickAccount(accountId);
  if (!picked.ok) return picked;
  const { account, secrets, adapter } = picked;
  if (!capabilityOf(account.channel).growth) {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 没有成长任务（当前版本无渠道支持）` };
  }
  if (typeof adapter.travelRun !== "function") {
    return { ok: false, message: `${store.channelDisplay(account.channel)} 适配器未实现猫猫旅行巡检` };
  }
  try {
    const res = await adapter.travelRun(account, secrets);
    if (res && res.ok) {
      oplog.log("info", "签到中心", `${account.name} 猫猫旅行：${res.message}`, { channel: account.channel });
    } else {
      oplog.log("warn", "签到中心", `${account.name} 猫猫旅行：${res.message || "执行未完成"}`, { channel: account.channel });
    }
    return res;
  } catch (e) {
    const message = String((e && e.message) || e);
    oplog.log("error", "签到中心", `${account.name} 猫猫旅行执行异常：${message}`, { channel: account.channel });
    return { ok: false, message };
  }
}

/** 签到记录（复用 store 的 checkin_history，页面「签到记录」一节用） */
function records({ limit, offset, channel, accountId } = {}) {
  return store.listCheckinHistory({
    limit: Math.min(200, Math.max(1, Number(limit) || 50)),
    offset: Math.max(0, Number(offset) || 0),
    channel: channel || undefined,
    accountId: accountId || undefined,
  });
}

module.exports = {
  CAPABILITIES,
  capabilityOf,
  snapshot,
  onboardingClaim,
  plansPreview,
  plansClaim,
  growthQuery,
  growthRun,
  records,
};
