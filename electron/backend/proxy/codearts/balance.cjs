/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21（2026-11 优化重构版）
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · CodeArts 余额：订阅统计（套餐积分）+ 限时福利池（opengw 网关）
//
// 上游现网真实结构（2026 现网实证，与 Agent2Providers 对齐）：
//   1. 订阅统计（/snap-manager/v1/statistics/plugin）：
//      - 响应键为 metrics（数组），包含：
//        usageTotalPackageCredit（套餐积分，汇总口径）、usageBasicPackageCredit（基础包积分）、
//        usageBonusPackageCredit（赠送积分）、usageOnDemandPackageCredit（按需积分）、
//        usageTokenChatMessages（对话 token 用量）、usageDataCodeCompletions、usageDataChatMessages 等。
//      - 指标内核心字段：package_credit_remain（剩余积分）、package_credit_amount（总积分）、
//        usage_token_num（已用 token 数）、package_token_amount（总 token 数）、value（百分比）。
//      - show:false 是上游退役/隐藏指令，必须跳过。
//   2. 汇总防翻倍：
//      - usageTotalPackageCredit 等于分项（基础包+赠送+按需）之和；命中包含关系时只计分项，避免总积分翻倍。
//   3. 福利网关余额（/api/v1/user/tokens/balance）：
//      - 必须请求福利网关 https://opengw.developer.huaweicloud.com，只有 error_code=="0000" 才算成功。
"use strict";

const models = require("./models.cjs");

const METER_LABELS = {
  usageDataCodeCompletions: "代码补全额度",
  usageDataChatMessages: "对话消息额度",
  usageTokenChatMessages: "对话 token 额度",
  usageTotalPackageCredit: "套餐积分",
  usageBasicPackageCredit: "基础包积分",
  usageOnDemandPackageCredit: "按需付费积分",
  usageBonusPackageCredit: "赠送积分",
};

function compact(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return String(num ?? "");
  if (num === Math.trunc(num) && Math.abs(num) < 1e15) {
    return String(Math.trunc(num));
  }
  return String(num);
}

function meterView(meter) {
  if (meter.creditRemaining != null && meter.creditTotal != null) {
    return `剩 ${compact(meter.creditRemaining)} / ${compact(meter.creditTotal)} 积分`;
  }
  if (meter.allowanceTokens > 1) {
    const pct = meter.usedPercent != null ? `（${compact(meter.usedPercent)}%）` : "";
    return `已用 ${compact(meter.usedTokens)} / ${compact(meter.allowanceTokens)} token${pct}`;
  }
  if (meter.usedTokens > 0) {
    return `已用 ${compact(meter.usedTokens)} token`;
  }
  if (meter.usedPercent != null) {
    return `已用 ${compact(meter.usedPercent)}%`;
  }
  return null;
}

// 福利网关余额：只有 error_code=="0000" 才算成功
async function benefitBalance(credential, benefitUrl) {
  const target = String(benefitUrl || "https://opengw.developer.huaweicloud.com").replace(/\/+$/, "");
  const resp = await models.signedJson(
    credential,
    target,
    "GET",
    "/api/v1/user/tokens/balance",
    undefined,
    undefined,
    { hostSigned: true, domainless: true }
  );
  const data = resp.data;
  const ok = resp.ok && data && String(data.error_code || "") === "0000";
  if (!ok) return null;
  const tokens = data.data && typeof data.data === "object" ? data.data : (data.result && typeof data.result === "object" ? data.result : {});
  const bal = Number(tokens.balance ?? tokens.remain ?? tokens.tokens ?? 0) || 0;
  return {
    type: "benefit_tokens",
    displayName: "福利 Token 池",
    balance: bal,
    balanceView: `剩 ${compact(bal)} Tokens`,
    unit: "Tokens",
  };
}

/**
 * 查两份账并归一。
 * 返回 { available, unit, wallets[], subscription, credits }；401/403 走调用方的「刷新后重试」链路。
 */
async function queryBalance(base, credential, options = {}) {
  const wallets = [];
  let available = 0;
  let sawAuthError = false;
  let statisticsDoc = null;

  // ① 订阅统计（付费套餐计量表）
  try {
    const resp = await models.signedJson(
      credential,
      base,
      "GET",
      "/snap-manager/v1/statistics/plugin",
      undefined,
      undefined,
      { statistics: true, language: options.language, pluginVersion: options.pluginVersion }
    );
    if (resp.status === 401 || resp.status === 403) sawAuthError = true;
    if (resp.ok && resp.data && typeof resp.data === "object") {
      const parsed = resp.data;
      const rawMetrics = Array.isArray(parsed.metrics) ? parsed.metrics
        : Array.isArray(parsed.meters) ? parsed.meters
        : Array.isArray(parsed.statistics) ? parsed.statistics : [];

      const meters = [];
      for (const m of rawMetrics) {
        if (!m) continue;
        const name = String(m.name || m.metric || "").trim();
        if (m.show === false || !name) continue;

        const usedTokens = Number(m.usage_token_num ?? m.used_tokens ?? m.used ?? 0) || 0;
        const allowanceTokens = Number(m.package_token_amount ?? m.allowance_tokens ?? m.limit ?? m.total ?? 0) || 0;
        const creditTotal = m.package_credit_amount != null ? Number(m.package_credit_amount) : null;
        const creditUsed = m.package_credit_used != null ? Number(m.package_credit_used) : null;
        const creditRemaining = m.package_credit_remain != null ? Number(m.package_credit_remain) : null;

        let usedPercent = null;
        if (m.value != null && Number(m.value) >= 0) {
          usedPercent = Number(m.value);
        } else if (allowanceTokens > 0) {
          usedPercent = Math.round((usedTokens / allowanceTokens) * 100);
        }

        const meter = {
          name,
          label: METER_LABELS[name] || String(m.label || m.displayName || name),
          usedTokens,
          allowanceTokens,
          creditTotal,
          creditUsed,
          creditRemaining,
          usedPercent,
        };
        meter.view = meterView(meter);

        // 丢弃全空行
        if (meter.usedPercent == null && meter.usedTokens === 0 && meter.allowanceTokens === 0 && meter.creditTotal == null && meter.creditRemaining == null) {
          continue;
        }
        meters.push(meter);
      }

      const pkg = parsed.package && typeof parsed.package === "object" ? parsed.package : null;
      statisticsDoc = {
        resetDate: String(parsed.end_date || parsed.endDate || ""),
        plan: pkg ? String(pkg.spec_code || pkg.code || "") : "",
        planName: pkg ? String(pkg.package_name_cn || pkg.package_name_en || pkg.name || "") : "",
        planUrl: pkg ? String(pkg.package_url || "") : "",
        meters,
      };

      // 聚合计算：识别 usageTotalPackageCredit 汇总行与分项行的包含关系
      let partsSum = 0;
      let hasParts = false;
      for (const m of meters) {
        if (m.name !== "usageTotalPackageCredit" && m.creditRemaining != null) {
          partsSum += m.creditRemaining;
          hasParts = true;
        }
      }

      let creditLeft = 0;
      let hasCredit = false;

      for (const m of meters) {
        wallets.push({
          type: m.creditRemaining != null ? "credit" : "token_meter",
          displayName: m.label,
          balance: m.creditRemaining != null ? m.creditRemaining : (m.allowanceTokens > 0 ? Math.max(0, m.allowanceTokens - m.usedTokens) : m.usedTokens),
          balanceView: m.view,
          usedPercent: m.usedPercent,
          unit: m.creditRemaining != null ? "积分" : "Token",
        });

        if (m.creditRemaining != null) {
          const isTotal = m.name === "usageTotalPackageCredit";
          const duplicated = isTotal && hasParts && Math.abs(partsSum - m.creditRemaining) <= 0.01;
          if (!duplicated) {
            creditLeft += m.creditRemaining;
            hasCredit = true;
          }
        }
      }

      if (hasCredit) {
        available = creditLeft;
      }
    }
  } catch { /* 区域统计 API 失败不阻断福利池那一半 */ }

  // ② 福利池（opengw 网关）
  try {
    const benefit = await benefitBalance(credential, options.benefitGatewayUrl);
    if (benefit) {
      wallets.push(benefit);
      if (!available) available += benefit.balance;
    }
  } catch { /* 福利池失败不阻断 */ }

  if (sawAuthError && !wallets.length) {
    return { authError: true, message: "CodeArts 凭证已失效，请重新登录" };
  }

  const out = {
    available,
    unit: "积分",
    wallets,
    subscription: statisticsDoc ? {
      planName: statisticsDoc.planName,
      planCode: statisticsDoc.plan,
      planUrl: statisticsDoc.planUrl,
      resetDate: statisticsDoc.resetDate,
    } : null,
  };
  if (wallets.length) out.credits = available;
  return out;
}

module.exports = { queryBalance, benefitBalance };
