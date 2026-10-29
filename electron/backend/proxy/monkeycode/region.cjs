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
// 反代网关 · MonkeyCode（长亭科技）地区表：地区 → 站点身份的**唯一事实来源**
//
// 国内站与国际站是同套协议、两个站点，因此是两个渠道而不是一个渠道的开关项：账号池、模型清单、
// 目录缓存都按站点分份，合成一格会让两站同名模型互相覆盖、界面启停键冲突（与 Qoder / AutoClaw 双区同口径）。
// 两个渠道 id 一旦落进账号库就是落盘契约，不要再改。
//
// 站点身份与「网关打到哪个地址」是两件事：base URL 可以被环境变量或规则文件改到自建/测试站点，
// 但 Origin/Referer 始终按站点真身发（上游按 Origin 判来源，改基址不改 Origin 是有意为之的排障姿势）。
"use strict";

const REGIONS = {
  cn: {
    key: "cn",
    channel: "monkeycode",
    label: "国内版",
    siteOrigin: "https://monkeycode-ai.com",
    envPrefix: "MONKEYCODE_",
  },
  intl: {
    key: "intl",
    channel: "monkeycode_intl",
    label: "国际版",
    siteOrigin: "https://monkeycode-ai.net",
    envPrefix: "MONKEYCODE_INTL_",
  },
};

/** 顺序即优先级：同名模型归给先出现的站点，所以国内版在前 */
const ORDER = [REGIONS.cn, REGIONS.intl];

/** 索引按**渠道 id** 建（号池与适配器手里拿到的都是渠道 id），同时保留 `cn` / `intl` 两个短键，
 *  避免调用方混用两种写法时静默取到 undefined。 */
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

/** 规则文件段（headers.json 的 monkeycode / monkeycode_intl）优先于环境变量 */
function baseUrl(region, section) {
  const fromRules = String((section && section.baseUrl) || "").trim().replace(/\/+$/, "");
  return fromRules || envValue(region, "BASE_URL") || region.siteOrigin;
}

/** http/https → ws/wss；其它 scheme 原样留下，由连接层报错，不在这里猜 */
function toWsScheme(base) {
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
}

module.exports = { REGIONS, ORDER, byChannel, baseUrl, toWsScheme };
