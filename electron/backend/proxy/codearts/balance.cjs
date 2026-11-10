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
// 反代网关 · CodeArts 余额：两份互相不知道对方存在的账，只读一处 = 显示一个假「还有额度」
//
//   1. 订阅统计（/snap-manager/v1/statistics/plugin）：只报付费套餐那几个计量表；
//   2. 限时福利池（福利网关 /api/v1/user/tokens/balance）：另一个网关记账，福利模型额度耗尽时
//      每一个套餐计量表都还是 0。
//
// 三个哨兵值（照实翻，不美化）：
//   * limit <= 0 表示该维度无上限（不是耗尽）→ 剩余量与百分比给 -1，界面显示「无上限」；
//   * 用量超过上限时如实报大于 100%；
//   * 计量表行的 show:false 是上游「这行别显示」的指令 → 跳过它。
//
// 成功判据分两家：区域 API 看 HTTP 状态；福利网关把失败塞在 200 的响应体里，只有 envelope 的
// error_code == "0000" 才算成功。
"use strict";

const models = require("./models.cjs");

// 福利网关余额：只有 error_code=="0000" 才算成功（失败塞在 200 体里）
async function benefitBalance(base, credential) {
  const resp = await models.signedJson(credential, base, "GET", "/api/v1/user/tokens/balance");
  const data = resp.data;
  const ok = resp.ok && data && String(data.error_code || "") === "0000";
  if (!ok) return null;
  const tokens = data.data && typeof data.data === "object" ? data.data : {};
  return {
    type: "benefit_tokens",
    displayName: "福利 Token 池",
    balance: Number(tokens.balance ?? tokens.remain ?? 0) || 0,
    unit: "Tokens",
  };
}

/**
 * 查两份账并归一。
 * 返回 { available, unit, wallets[], credits?[] }；401 走调用方的「刷新后重试」链路。
 */
async function queryBalance(base, credential) {
  const wallets = [];
  let available = 0;
  let sawAuthError = false;

  // ① 订阅统计（套餐计量表）
  try {
    const resp = await models.signedJson(credential, base, "GET", "/snap-manager/v1/statistics/plugin");
    if (resp.status === 401 || resp.status === 403) sawAuthError = true;
    if (resp.ok && resp.data && typeof resp.data === "object") {
      const meters = Array.isArray(resp.data.meters) ? resp.data.meters
        : Array.isArray(resp.data.statistics) ? resp.data.statistics : [];
      for (const m of meters) {
        if (m && m.show === false) continue; // 上游「这行别显示」指令 → 跳过
        const limit = Number(m.limit ?? m.total ?? 0) || 0;
        const used = Number(m.used ?? m.consumed ?? 0) || 0;
        let remain;
        let percent;
        if (limit <= 0) {
          remain = -1; // 无上限
          percent = -1;
        } else {
          remain = limit - used;
          percent = Math.round((used / limit) * 100);
        }
        wallets.push({
          type: "subscription",
          displayName: String(m.name || m.metric || "套餐计量"),
          balance: remain,
          usedPercent: percent,
          unit: String(m.unit || "次"),
        });
      }
    }
  } catch { /* 区域 API 失败不阻断福利池那一半 */ }

  // ② 福利池（另一网关）
  try {
    const benefit = await benefitBalance(base, credential);
    if (benefit) wallets.push(benefit);
  } catch { /* 福利池失败不阻断 */ }

  if (sawAuthError && !wallets.length) {
    return { authError: true, message: "CodeArts 凭证已失效，请重新登录" };
  }
  for (const w of wallets) {
    if (typeof w.balance === "number" && w.balance >= 0) available += w.balance;
  }
  // 契约要求 credits 为数字：refreshAccount 直接落库、参与选号。
  // 只给 available 会让账号级余额停在 0（Number(undefined) 的旧链路），
  // 与「有额度却显示零」同义（#180）。两份账都没读到时不写 credits，
  // 让调用方保留上一次有效读数，而不是把故障回合清成 0。
  const out = { available, unit: "", wallets };
  if (wallets.length) out.credits = available;
  return out;
}

module.exports = { queryBalance };
