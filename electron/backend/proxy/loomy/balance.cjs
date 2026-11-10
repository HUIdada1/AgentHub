/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Loomy 积分 / 余额查询：GET {集成网关}/api/v2/points/records 的摘要字段
//
// 为什么余额藏在流水接口里（客户端就是这么读的）：Loomy 没有独立的余额接口。
// 客户端积分详情页读 V2 流水接口 —— 它的响应 data 里同时带账户摘要：
//   GET /api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat
//   → {code:"000000", data:{ balance(永久积分), dailyBalance(每日赠送), dailyLimitPoints,
//                            dailyConsumedPoints, dailyRemainingPoints, list, total }}
// 客户端的两张卡片（永久 5000 / 每日赠送 5000）读的就是 balance 与 dailyBalance。
// 归一成账号页统一形状 {available, unit, wallets, credits}：两个钱包各一行，available 取两者之和。
"use strict";

const client = require("./client.cjs");

const RECORDS_PATH = "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat";

// 从 data.data 里取一个非负数字（字段缺失 / 非法时给 null）；上游有把数字序列化成字符串的形态（如 "5000"）
function pickNumber(data, key) {
  const value = data && data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 查询某 Loomy 账号的双账户余额。
 * env = { session }；返回统一形状，401 由调用方走「刷新后重试」链路（本家无续期，最终如实报重登）。
 */
async function queryBalance(env, fetchImpl) {
  const session = String((env && env.session) || "").trim();
  if (!session) return { authError: true, message: "Loomy 账号缺少 session" };
  let payload;
  try {
    payload = await client.tokenRequest("GET", RECORDS_PATH, session, null, "积分查询", fetchImpl);
  } catch (e) {
    if (e && e.status === 401) return { authError: true, message: e.message };
    return { error: String((e && e.message) || e) };
  }
  const code = client.businessCode(payload);
  if (client.isAuthErrorCode(code)) return { authError: true, message: "Loomy 登录态已失效，无法查询积分（请重新登录）" };
  if (code !== client.SUCCESS_CODE) {
    const msg = client.upstreamMessage(payload);
    return { error: msg ? `积分查询失败：${msg}` : `积分查询失败（上游 code=${code}）` };
  }
  // 摘要可能在 data 或 data.data 两层（V2 接口在不同版本出现过两种形态）
  const outer = (payload && payload.data) || {};
  const data = outer && typeof outer.data === "object" && outer.data ? outer.data : outer;
  const permanent = pickNumber(data, "balance") ?? 0;
  const daily = pickNumber(data, "dailyBalance") ?? 0;
  const dailyRemaining = pickNumber(data, "dailyRemainingPoints");
  const dailyLimit = pickNumber(data, "dailyLimitPoints");

  const wallets = [
    { type: "permanent_points", displayName: "永久积分", balance: permanent },
    { type: "daily_points", displayName: "每日赠送积分", balance: daily },
  ];
  // 赠送额度的「剩余 / 上限」是独立展示口径（客户端团队卡片用），有就带上，没有不编造
  if (dailyRemaining != null && dailyLimit != null) {
    wallets[1].remaining = dailyRemaining;
    wallets[1].limit = dailyLimit;
  }
  // credits 固定两行（与 wallets 同序同口径）：永久在前、每日在后；daily:true 是界面「每日重置」判据
  const creditDetails = [
    { name: "永久积分", remain: permanent },
    { name: "每日赠送积分", remain: daily, daily: true },
  ];
  return {
    // 适配器契约：credits 必须是**数字**（refreshAccount 直接落库并参与选号）。
    // 逐钱包明细放 wallets / creditDetails，不能占用 credits——数组经 Number() 会变 NaN→0，
    // 正是「积分明明有、号池一直显示 0」的根因（#180）。
    credits: permanent + daily,
    expiresAt: 0,
    available: permanent + daily,
    unit: "积分",
    wallets,
    creditDetails,
    raw: payload,
  };
}

module.exports = { queryBalance };
