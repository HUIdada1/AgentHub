/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · KukuAI 每日签到（「免费领积分」活动的每日任务领取）
//
// 语义澄清：本家没有「打卡」接口。所谓签到 = 把活动面板里每日可自助完成的两项任务领掉
// （每日登录、完成一次对话）。领取接口是**幂等**的：今天已领过会返回成功但奖励为 0，
// 因此「没有新增」不是失败，界面要说的是「今日积分已领过」，不要弹红色错误。
//
// 两条口径不能想当然：
//   1. 面板里的 claimable_point 恒为 0，UNFINISHED 的任务照样能领到奖励——所以**绝不能拿面板
//      数值当领取门槛**，否则会「明明能领却跳过」；
//   2. 邀请类任务要有真实受邀人，接口上强领只会失败，因此不进领取清单。
//
// 会话前提：freepoint 与对话链走同一道业务会话门，所以领取前先尽力把令牌换成产品级的那一份。
// 单个任务失败只记一条继续下一个：一个任务被风控不该拖垮另一个。
"use strict";

const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");
const session = require("./session.cjs");

/** 每日可自助完成的任务：类型 + 展示名（展示名进结果文案） */
const DAILY_TASKS = [
  ["LOGIN", "每日登录"],
  ["CHAT", "完成一次对话"],
];

function messageOf(payload, fallback) {
  return String((payload && (payload.show_msg || payload.errmsg || payload.message)) || fallback || "未知错误");
}

/** 表单 POST：上游按 x-www-form-urlencoded 收 task_type，值都是常量，按 k=v 直接拼（不做百分号编码，与客户端一致） */
async function postForm(deps, cred, path, form) {
  const url = `${endpoints.baseUrl()}${path}?${endpoints.WEB_QUERY}`;
  const headers = credentials.requestHeaders(cred, "application/json, text/plain, */*");
  headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  const r = await deps.httpJson(url, { method: "POST", headers, body: form });
  if (!r || !r.ok) {
    const status = Number(r && r.status) || 502;
    if (status === 401 || status === 403) {
      throw Object.assign(new Error(`KukuAI 登录态已失效（HTTP ${status}），请重新登录该账号`), { status: 401 });
    }
    throw Object.assign(new Error(`KukuAI 返回 HTTP ${status}（${url}）`), { status });
  }
  return r.data;
}

async function checkin(cred, deps) {
  // 尽力换发业务令牌：换不到也继续（下面面板那一探会给出准确失败原因）
  await session.reissueStoken(cred, deps).catch(() => false);

  const panelUrl = `${endpoints.baseUrl()}${endpoints.PATHS.checkinPanel}?${endpoints.WEB_QUERY}`;
  const panel = await deps
    .httpJson(panelUrl, { method: "GET", headers: credentials.requestHeaders(cred, "application/json, text/plain, */*") })
    .catch(() => null);
  if (!panel || !panel.ok) {
    const status = Number(panel && panel.status) || 502;
    return { ok: false, message: `KukuAI 签到失败：活动面板返回 HTTP ${status}` };
  }
  if (Number(panel.data && panel.data.errno) !== 0) {
    return {
      ok: false,
      authError: true,
      message: `KukuAI 签到失败（活动面板 errno=${panel.data && panel.data.errno}：${messageOf(panel.data, "未知错误")}）——请重新登录该账号`,
    };
  }

  const gained = [];
  let alreadyClaimed = false;
  let total = 0;
  for (const [taskType, label] of DAILY_TASKS) {
    let value = null;
    try {
      value = await postForm(deps, cred, endpoints.PATHS.checkinTask, `task_type=${taskType}`);
    } catch (e) {
      deps.verbose && deps.verbose(`[Kuku] 「${label}」领取失败：${e.message}`);
      continue;
    }
    if (Number(value && value.errno) !== 0) {
      deps.verbose && deps.verbose(`[Kuku] 「${label}」领取被拒（errno=${value && value.errno}：${messageOf(value, "未知错误")}）`);
      continue;
    }
    const data = (value && value.data) || {};
    const statusText = String(data.complete_status || "");
    const reward = Number(data.reward_point) || 0;
    if (statusText.toUpperCase() === "SUCCESS" && reward > 0) {
      gained.push(`${label}+${reward}`);
      total += reward;
    } else {
      // 成功但奖励为 0，或非 SUCCESS 的「已领」标记：都是今天已经领过，不算失败
      alreadyClaimed = true;
    }
  }

  if (gained.length) return { ok: true, message: `签到完成：${gained.join("、")}（共 +${total}）` };
  if (alreadyClaimed) return { ok: true, message: "今日积分已领过（领取接口幂等，本次无新增）" };
  return { ok: true, message: "本次没有可领取的每日任务（活动可能未开始或已结束）" };
}

/** 上游没有可信的「今日是否已签」判据（面板数值不能当门槛），照实说明，不假装查到了状态 */
function checkinStatus() {
  return {
    ok: true,
    checkedIn: false,
    unavailable: true,
    message: "KukuAI 没有独立的签到状态查询接口：签到即每日任务领取（登录 / 对话），领取动作幂等",
  };
}

module.exports = { checkin, checkinStatus, DAILY_TASKS };
