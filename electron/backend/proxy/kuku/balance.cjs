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
// 反代网关 · KukuAI 积分查询
//
// 这个接口只看 BDUSS，不吃会话三件套，所以「会话没建立 / 模型拉不下」的时候积分照样能查——
// 也正因如此，积分查到不能当作「这个号能用」的证据。
//
// query 用桌面形态的子集：该接口**不认 app_id**，带上会被拒（与对话链的形态不同，见 endpoints.cjs）。
// 响应是 {status, data} 顶层包络：判据在 status.code。data.list 是各类资产（积分 / 时长 / 定时任务…），
// 按 assetName 取「token」那一项，取不到才回落第一项——上游会加新的资产类型，写死下标会读错。
// totalPoint 上游给的是字符串（"1100"），数字形态也一并接受。
"use strict";

const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");

/** 取不到积分时的返回口径：**绝不返回 0**。号池把 `credits === 0` 判成额度耗尽并自动切号，
 *  一次响应结构变化就会把整池账号打成空号。这里回 unavailable，让账号保持可用、余额不动。 */
function unavailable(message) {
  return { unavailable: true, message };
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function queryCredits(cred, deps) {
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.balance}?${endpoints.POINTS_QUERY}`;
  const r = await deps.httpJson(url, {
    method: "GET",
    headers: credentials.requestHeaders(cred, "application/json, text/plain, */*"),
  });
  if (!r || !r.ok) {
    const status = Number(r && r.status) || 502;
    if (status === 401 || status === 403) {
      return { authError: true, message: `KukuAI 登录态已失效（HTTP ${status}），请重新登录或重新粘贴 Cookie` };
    }
    return { error: `KukuAI 积分查询返回 HTTP ${status}` };
  }
  const payload = r.data;
  if (!payload || typeof payload !== "object") return unavailable("KukuAI 积分查询返回非 JSON 响应");
  const status = payload.status || {};
  if (Number(status.code) !== 0) {
    // 与转发链同一口径：该接口给出非 0 的 status.code 实际含义是登录态问题（它不需要会话三件套，
    // 所以剩下的失败原因就是 Cookie 失效）
    return {
      authError: true,
      message: `KukuAI 积分查询失败（status.code=${status.code ?? "缺失"}：${String(status.msg || "未知错误")}）`,
    };
  }
  const list = (payload.data && Array.isArray(payload.data.list) && payload.data.list) || [];
  if (!list.length) return unavailable("KukuAI 积分响应里没有资产清单（上游结构变化）");
  const item = list.find((row) => row && row.assetName === "token") || list[0];
  const credits = toNumber(item && item.totalPoint);
  if (credits === null) return unavailable("KukuAI 积分响应里的 totalPoint 读不出数值（上游结构变化）");
  // expiresAt 恒 0 = 「这份额度不过期」：本家积分没有到期时间概念，回填一个假到期会把账号锁成「余额已到期」
  return { credits, expiresAt: 0, raw: { assetName: item && item.assetName, vipRemain: list } };
}

module.exports = { queryCredits };
