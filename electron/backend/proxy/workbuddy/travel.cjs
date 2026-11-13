/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-13
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · WorkBuddy 腾讯猫猫旅行（Buddy Travel）成长体系
//
// 业务状态机（与 Agent2Providers travel.rs 对齐）：
//   1. 无猫 (buddy == null / {})  → 同意协议 + 领养第一只猫（POST /activity/growth/buddy/first，+300c+8e）
//   2. idle (空闲)                → 派出旅行（POST /activity/growth/buddy/travel/depart，固定地点 4 古镇客栈）
//   3. traveling (旅行中)          → 在途，跳过等待下一次巡检
//   4. arrived (已到站)           → 领奖（POST /activity/growth/buddy/travel/claim，带 record_id）
//
// 纪律与防抖：
//   - 领养门槛未达（400 "first_buddy task not completed yet"）属于预期正常态（今日活跃对话量不足），
//     记入当日防抖，当天不再重复请求上游，次日自动重试。
//   - 仅限 WorkBuddy 国内版个人账号（企业版无成长体系，国际版无 CN 任务中心）。
"use strict";

const CHAT_BASE = "https://copilot.tencent.com";
const TRAVEL_LOCATION_ID = 4; // 固定 4：古镇客栈（各地点收益与时长区间相同）
const BUDDY_TASK_INCOMPLETE_MARKER = "first_buddy task not completed";

// 当日防抖表：uid -> CST 日期（YYYY-MM-DD）
const adoptTriedMap = new Map();

function todayCst() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function adoptTriedToday(uid) {
  if (!uid) return false;
  return adoptTriedMap.get(String(uid)) === todayCst();
}

function markAdoptTried(uid) {
  if (!uid) return;
  adoptTriedMap.set(String(uid), todayCst());
}

async function requestJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 20000);
  try {
    const resp = await globalThis.fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || undefined,
      signal: ctrl.signal,
    });
    const status = resp.status;
    let data = null;
    try { data = await resp.json(); } catch { /* 非 JSON */ }
    return { ok: resp.ok, status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 查询猫档案：返回 { id, name } 或 null（无猫） */
async function buddyInfo(account, secrets, headersFn) {
  const headers = headersFn ? headersFn(account, secrets) : {};
  const res = await requestJson(`${CHAT_BASE}/activity/growth/buddy/info`, { method: "GET", headers });
  if (!res.ok) {
    const msg = (res.data && (res.data.msg || res.data.message)) || `HTTP ${res.status}`;
    throw new Error(`猫档案查询失败：${msg}`);
  }
  const buddy = res.data && res.data.data && res.data.data.buddy;
  if (!buddy || typeof buddy !== "object" || Object.keys(buddy).length === 0) {
    return null;
  }
  return {
    id: Number(buddy.id) || 0,
    name: String(buddy.name || "小猫"),
  };
}

/** 领养第一只猫：协议同意 + 首次领养 */
async function adoptBuddy(account, secrets, headersFn) {
  const headers = headersFn ? headersFn(account, secrets) : {};

  // ① 同意协议（幂等）
  try {
    await requestJson(`${CHAT_BASE}/activity/growth/buddy/agreement`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agree: true }),
    });
  } catch { /* 忽略协议非致命错误 */ }

  // ② 领养
  const res = await requestJson(`${CHAT_BASE}/activity/growth/buddy/first`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });

  const msg = String((res.data && (res.data.msg || res.data.message)) || "");
  if (res.ok && res.data && (res.data.code === 0 || res.data.code === 200)) {
    const d = res.data.data || res.data;
    const credit = Number(d.credit ?? 300) || 300;
    const energy = Number(d.energy ?? 8) || 8;
    return { ok: true, credit, energy, message: `领养成功（积分+${credit} 能量+${energy}）` };
  }

  if (msg.toLowerCase().includes(BUDDY_TASK_INCOMPLETE_MARKER) || msg.includes("未达") || res.status === 400) {
    markAdoptTried(account.uid);
    return { ok: false, thresholdNotMet: true, message: "领养门槛未达（今日活跃对话量不足），明天自动重试" };
  }

  return { ok: false, thresholdNotMet: false, message: `领养失败（HTTP ${res.status} ${msg}）` };
}

/** 查询旅行状态 */
async function travelStatus(account, secrets, headersFn) {
  const headers = headersFn ? headersFn(account, secrets) : {};
  const res = await requestJson(`${CHAT_BASE}/activity/growth/buddy/travel/status`, { method: "GET", headers });
  if (!res.ok) {
    const msg = (res.data && (res.data.msg || res.data.message)) || `HTTP ${res.status}`;
    throw new Error(`旅行状态查询失败：${msg}`);
  }
  const d = (res.data && res.data.data) || {};
  return {
    state: String(d.state || "idle"), // idle / traveling / arrived
    dailyLimitReached: !!(d.daily_limit_reached ?? d.dailyLimitReached),
    recordId: Number(d.record_id ?? d.recordId ?? 0) || 0,
    rewardCredit: Number(d.reward_credit ?? d.rewardCredit ?? 0) || 0,
  };
}

/** 派出旅行（固定地点 4） */
async function travelDepart(account, secrets, headersFn) {
  const headers = headersFn ? headersFn(account, secrets) : {};
  const res = await requestJson(`${CHAT_BASE}/activity/growth/buddy/travel/depart`, {
    method: "POST",
    headers,
    body: JSON.stringify({ location_id: TRAVEL_LOCATION_ID }),
  });
  if (!res.ok || (res.data && res.data.code !== 0 && res.data.code !== 200)) {
    const msg = (res.data && (res.data.msg || res.data.message)) || `HTTP ${res.status}`;
    throw new Error(`派出失败：${msg}`);
  }
  return true;
}

/** 领奖 */
async function travelClaim(account, secrets, recordId, headersFn) {
  const headers = headersFn ? headersFn(account, secrets) : {};
  const res = await requestJson(`${CHAT_BASE}/activity/growth/buddy/travel/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ record_id: Number(recordId) }),
  });
  if (!res.ok || (res.data && res.data.code !== 0 && res.data.code !== 200)) {
    const msg = (res.data && (res.data.msg || res.data.message)) || `HTTP ${res.status}`;
    throw new Error(`领奖失败：${msg}`);
  }
  const d = (res.data && res.data.data) || {};
  return Number(d.reward_credit ?? d.rewardCredit ?? 0) || 0;
}

/**
 * 单账号单次巡检状态机：查猫档案 → 查状态 → 推进一步动作
 * 返回 { ok, outcome, message, credit }
 * outcome 包含：'adopt' | 'depart' | 'claim' | 'skip' | 'failed'
 */
async function runOnce(account, secrets, headersFn) {
  // 门控：企业账号无个人成长体系
  if (account.enterpriseId) {
    return { ok: true, outcome: "skip", message: "企业账号无个人成长体系，跳过", credit: 0 };
  }

  let buddy;
  try {
    buddy = await buddyInfo(account, secrets, headersFn);
  } catch (err) {
    return { ok: false, outcome: "failed", message: String((err && err.message) || err), credit: 0 };
  }

  // 1. 无猫：走领养流程
  if (!buddy) {
    if (adoptTriedToday(account.uid)) {
      return { ok: true, outcome: "skip", message: "领养门槛今日已判定未达（对话量不足），明天自动重试", credit: 0 };
    }
    const adoptRes = await adoptBuddy(account, secrets, headersFn);
    if (adoptRes.ok) {
      return { ok: true, outcome: "adopt", message: adoptRes.message, credit: adoptRes.credit || 300 };
    }
    if (adoptRes.thresholdNotMet) {
      return { ok: true, outcome: "skip", message: adoptRes.message, credit: 0 };
    }
    return { ok: false, outcome: "failed", message: adoptRes.message, credit: 0 };
  }

  // 2. 查旅行状态
  let status;
  try {
    status = await travelStatus(account, secrets, headersFn);
  } catch (err) {
    return { ok: false, outcome: "failed", message: String((err && err.message) || err), credit: 0 };
  }

  // 3. 状态机分发
  if (status.state === "arrived") {
    if (!status.recordId) {
      return { ok: true, outcome: "skip", message: `猫猫（${buddy.name}）已到站但缺失记录 ID，跳过`, credit: 0 };
    }
    try {
      const reward = await travelClaim(account, secrets, status.recordId, headersFn);
      return { ok: true, outcome: "claim", message: `猫猫（${buddy.name}）旅行归来，到站领奖成功：积分 +${reward}`, credit: reward };
    } catch (err) {
      return { ok: false, outcome: "failed", message: String((err && err.message) || err), credit: 0 };
    }
  }

  if (status.state === "idle") {
    if (status.dailyLimitReached) {
      return { ok: true, outcome: "skip", message: `猫猫（${buddy.name}）今日已派出过，明日再来`, credit: 0 };
    }
    try {
      await travelDepart(account, secrets, headersFn);
      return { ok: true, outcome: "depart", message: `猫猫（${buddy.name}）已派出旅行（目的地：古镇客栈）`, credit: 0 };
    } catch (err) {
      return { ok: false, outcome: "failed", message: String((err && err.message) || err), credit: 0 };
    }
  }

  if (status.state === "traveling") {
    return { ok: true, outcome: "skip", message: `猫猫（${buddy.name}）在旅行途中（记录 ${status.recordId}），等待下一趟`, credit: 0 };
  }

  return { ok: true, outcome: "skip", message: `未知状态「${status.state}」，保守跳过`, credit: 0 };
}

module.exports = {
  buddyInfo,
  adoptBuddy,
  travelStatus,
  travelDepart,
  travelClaim,
  runOnce,
  adoptTriedToday,
};
