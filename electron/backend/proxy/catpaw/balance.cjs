// CatPaw 余额 / 积分查询（移植来源：参照实现 catpaw/balance.rs）。
//
// 上游形态（客户端自己的网关 API，实测坐实）：
//   GET https://catx.nocode.cn/api/gateway/credit/balance
//   X-Auth-Token: <auth.json 的 auth.accessToken>
//   响应 {code, message, data:{availableCredits, userPlan{…}}, errorCode}
// `availableCredits` 是**数字字符串**（如 "0.00"）。
//
// 为什么不用 credit.catpaw.meituan.com：参照实现的本地实测（2026-09，逐条复现）表明
// 网页积分中心那套「另配 token2 网页会话凭证」的归因是错的——真正生效的 cookie 是 mt_c_token，
// 而它的值就是转发用的同一个 accessToken；catx.nocode.cn 这个网关 API 只认 X-Auth-Token 头，
// 凭证同样是那个 accessToken。于是本模块**不需要任何额外配置**，凭证直接复用转发那条链。
//
// 401 / 业务码 4010（没带 token）/ 4011（token 无效）统一按「凭证失效」上报，
// 由账号层标 relogin（CatPaw 没有刷新接口，恢复路径是在客户端重新登录后重新导入）。
"use strict";
const CatPawError = require("./errors.cjs");
const { resolveCredentials } = require("./credentials.cjs");

const BALANCE_URL = "https://catx.nocode.cn/api/gateway/credit/balance";
const REQUEST_TIMEOUT_MS = 15000;
/** 鉴权头名：**只认这一个**（实测 X-Passport-Token / Cookie / Authorization 在这个域名下全部 401） */
const AUTH_HEADER = "X-Auth-Token";

/** 数值字段透传（缺失/非数字给 null —— 前端显示成「—」而不是 0）。
 *  上游把 availableCredits 给成字符串，因此必须同时接受字符串与数字两种形态 */
function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
}

/** 积分接口地址：`CATPAW_BALANCE_URL` 可覆盖（与转发的 CATPAW_UPSTREAM_BASE_URL 同一用途——
 *  本地联调与自测要把请求指到假上游上，硬编码地址等于这条链路测不到） */
function balanceUrl() {
  const raw = String(process.env.CATPAW_BALANCE_URL || "").trim();
  return raw || BALANCE_URL;
}

/** `userPlan` → 前端已认得的订阅形状（null = 这个账号没有套餐信息） */
function subscriptionOf(userPlan) {
  if (!userPlan || typeof userPlan !== "object") return null;
  const name = [userPlan.planName, userPlan.planId].find((value) => typeof value === "string" && value) || "";
  return {
    name,
    expireAt: userPlan.expireTime === undefined ? null : userPlan.expireTime,
    // 上游字段名照实带上（前端若要区分「专业版」都够用，不必在这里改名）
    autoRenew: userPlan.autoRenew === undefined ? null : userPlan.autoRenew,
    pro: userPlan.pro === undefined ? null : userPlan.pro,
  };
}

/** 查余额：返回 credits.refreshAccount 认的形态（{credits, expiresAt} / {authError} / {unavailable}） */
async function queryCredits(account, secrets) {
  let credentials;
  try {
    credentials = resolveCredentials(account, secrets);
  } catch (e) {
    return { unavailable: true, message: String((e && e.message) || e) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(balanceUrl(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        [AUTH_HEADER]: credentials.token,
        "gray-set": "new-agent-sdk",
      },
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new CatPawError(504, "CatPaw 积分查询超时");
    throw new CatPawError(502, `CatPaw 积分查询请求失败: ${String((e && e.message) || e)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const code = payload && Number.isFinite(Number(payload.code)) ? Number(payload.code) : null;
  // 两条凭证失效路径（实测）：4010 = 没带 token，4011 = token 无效；HTTP 401 同样处理
  if (response.status === 401 || code === 4010 || code === 4011) {
    return { authError: true, message: "CatPaw 登录凭证已失效，请在客户端重新登录后重新导入登录态" };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CatPawError(502, `CatPaw 积分查询返回 HTTP ${response.status}`);
  }
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : null;
  if (code !== 0 || !data) {
    const message = String((payload && payload.message) || "").trim()
      || `CatPaw 积分查询返回异常${code !== null ? ` code=${code}` : ""}`;
    throw new CatPawError(502, message);
  }
  const available = numberOrNull(data.availableCredits);
  if (available === null) {
    // 上游没给可用积分：**不能当 0**——号池把 credits===0 当「余额不足」标 exhausted 自动切号，
    // 一个字段形态变化就能把好号全打光。如实报「未配置/未返回」，账号保持可用
    return { unavailable: true, message: "CatPaw 积分接口未返回可用积分" };
  }
  const userPlan = data.userPlan && typeof data.userPlan === "object" ? data.userPlan : null;
  const expireAt = userPlan && userPlan.expireTime ? Date.parse(userPlan.expireTime) : NaN;
  return {
    // 只有「可用」一个数：没有钱包概念，不给 total/frozen/expired 造零值
    credits: available,
    expiresAt: Number.isFinite(expireAt) ? expireAt : 0,
    raw: { balance: data, subscription: subscriptionOf(userPlan) },
  };
}

module.exports = { queryCredits, balanceUrl };
