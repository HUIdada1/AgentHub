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
// 反代网关 · ZCode 地区表：地区 → 站点身份的**唯一事实来源**
//
// 与 Qoder/AutoClaw/MonkeyCode 双区同口径：同套协议、两个地区，做成两个渠道 id
// 而不是「一家的一个选项」——账号池、模型清单、目录缓存都按地区分份，
// 合成一格会让两地同名模型互相覆盖、界面启停键冲突。
//
// 地区差异（依据 Agent2Providers zcode/region.rs，逐条有据）：
//   · zcode 平面（登录/领取/配置/OAuth）两地相同：zcode.z.ai；
//   · 推理平面不同：CN = open.bigmodel.cn / api.z.ai 两路并存，INTL = 只有 api.z.ai；
//   · OAuth provider 字段：CN = bigmodel，INTL = zai（/oauth/cli/init 的 provider 入参）；
//   · monitor 平面（额度窗口）：CN = open.bigmodel.cn，INTL = api.z.ai；
//   · biz_host（coding-plan API key 换取）：CN = https://bigmodel.cn，INTL = https://api.z.ai。
"use strict";

const REGIONS = {
  cn: {
    key: "cn",
    channel: "zcode",
    label: "国内版",
    // OAuth 登录的 provider（/oauth/cli/init 的 provider 入参，/oauth/cli/poll 响应的分支键）
    oauthProvider: "bigmodel",
    // 推理平面（coding-plan Anthropic 基址）：CN 有 zai 与 bigmodel 两路并存
    zaiAnthropicBase: "https://api.z.ai/api/anthropic",
    bigmodelAnthropicBase: "https://open.bigmodel.cn/api/anthropic",
    // monitor 平面（coding-plan key 额度窗口）
    monitorQuotaUrl: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    subscriptionUrl: "https://open.bigmodel.cn/api/biz/subscription/list",
    // biz_host（coding-plan API key 换取链：getCustomerInfo / api_keys）
    bizBase: "https://bigmodel.cn",
    envPrefix: "ZCODE_",
  },
  intl: {
    key: "intl",
    channel: "zcode_intl",
    label: "国际版",
    oauthProvider: "zai",
    // INTL 只有 zai 一路推理平面（无 bigmodel 并存域）
    zaiAnthropicBase: "https://api.z.ai/api/anthropic",
    bigmodelAnthropicBase: "",
    monitorQuotaUrl: "https://api.z.ai/api/monitor/usage/quota/limit",
    subscriptionUrl: "https://api.z.ai/api/biz/subscription/list",
    bizBase: "https://api.z.ai",
    envPrefix: "ZCODE_INTL_",
  },
};

/** 顺序即优先级：同名模型归给先出现的站点，所以国内版在前 */
const ORDER = [REGIONS.cn, REGIONS.intl];

/** 索引按**渠道 id** 建（号池与适配器手里拿到的都是渠道 id），同时保留 `cn`/`intl` 短键 */
const BY_CHANNEL = new Map();
for (const item of ORDER) {
  BY_CHANNEL.set(item.channel, item);
  BY_CHANNEL.set(item.key, item);
}

function byChannel(channel) {
  return BY_CHANNEL.get(String(channel || "")) || null;
}

function envValue(region, name) {
  return String(process.env[`${region.envPrefix}${name}`] || "").trim().replace(/\/+$/, "");
}

/** 规则文件段（headers.json 的 zcode / zcode_intl）优先于环境变量 */
function resolve(region, section, key) {
  const fromRules = String((section && section[key]) || "").trim();
  if (fromRules) return fromRules;
  return envValue(region, key) || region[key] || "";
}

module.exports = { REGIONS, ORDER, byChannel, resolve };
