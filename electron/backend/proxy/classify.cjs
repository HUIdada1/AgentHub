/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 通用错误分类（纯函数模块）：渠道私有业务码先走适配器 classifyError 扩展点，
// 未命中走跨渠道共用的通用码族（4008/6004/11102/11115/11101 等为多家共用）。
// 分类结果仅决定「冷却档位与是否换号」，不直接发请求/不操作账号——所有副作用由调用方按 kind 落地。
// 该模块从已下线的 server.cjs 提取：原实现与「废弃代码（禁止git提交推送）/electron/backend/proxy/server.cjs」
// 保持一致，且成为 scripts/test-retry-after-cooldown.cjs 等回归测试可直接 import 的单一事实源。
"use strict";
const adapters = require("./adapters.cjs");
const util = require("./util.cjs");

const isInputTooLargeMsg = util.isInputTooLargeMsg;

/** 上游报错文本里「YYYY-MM-DD HH:mm[:ss]」→ 毫秒时间戳；过去的时间返回 0（不算重置依据） */
function parseRateResetMs(text) {
  const m = /([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?/.exec(String(text || ""));
  if (!m) return 0;
  const p2 = (n) => String(n).padStart(2, "0");
  const t = Date.parse(`${m[1]}-${p2(m[2])}-${p2(m[3])}T${p2(m[4])}:${m[5]}:${m[6] || "00"}+08:00`);
  return Number.isFinite(t) && t > Date.now() ? t : 0;
}

/**
 * 通用错误分类（对齐 handler.applyErrorPolicy 全表 + SOLO 专项）：
 *  - channel 先问适配器渠道级 classifyError（返回非空即走渠道级分类）
 *  - planLimit（402 语义）与 e.status === 402 归 credit（换号）
 *  - 6004 模型级限流：模型×账号负缓存；11102 模型不支持：6h 指数负缓存；11115/11101/4001 零动作
 *  - 429：resetMs 对齐上游明示时间（墙钟优先，Retry-After 换算成绝对时刻）
 *  - 5xx / 网络 / 首字节/流中空闲超时归 server（熔断由 pool.noteServerError 计数阈值决定）
 */
function classifyUpstream(e, planLimit, channel) {
  if (channel) {
    const ad = adapters.get(channel);
    if (ad && typeof ad.classifyError === "function") {
      const r = ad.classifyError(e);
      if (r) return r;
    }
  }
  if (planLimit || (e && e.status === 402)) return { kind: "credit", switchable: true, status: 402 };
  const msg = String((e && e.message) || "");
  const code = Number(e && e.code) || 0;
  if (code === 4001 || /model config is empty|config.*is empty/i.test(msg)) {
    return { kind: "model_config", switchable: true, status: 502 }; // 模型/配置问题：不罚号
  }
  if (code === 4008 || /\b4008\b/.test(msg)) return { kind: "rate", switchable: true, status: 429 };
  // 6004 模型级限流：code 字段与消息文本双通道判定——WB 流内 6004 的文案
  // （「您的使用量已超出频率限制，将在 XXX 重置」）不含数字码，只测文本会漏
  if (code === 6004 || /\b6004\b/.test(msg)) {
    // 重置时间优先取正文（英文 reset at / 中文「…重置」都能解析）；
    // 正文没给时再用上游的 Retry-After 头族——WB 的 6004 有时只在头里带等待时长
    return {
      kind: "model_rate", switchable: true, status: 429,
      resetMs: parseRateResetMs(msg) || (e.retryAfterMs ? Date.now() + e.retryAfterMs : 0),
    };
  }
  if (/\b11102\b/.test(msg) || /service info not found/i.test(msg)) return { kind: "model_blocked", switchable: true, status: 404 };
  // 输入过大（413 / 上游的「too long」族文案）：同一份 body 换任何账号都同错，
  // 归 prompt_too_long 走零动作透传，绝不能冷却账号——否则一次超大 prompt 会把整条池逐个罚掉。
  // 词表对齐 trae 的 INPUT_TOO_LARGE_MARKERS（大小写不敏感、中文原样匹配），
  // 那里同时钉住了「413 排在最前」的顺序理由：body 恰好带 "1005…plan" 时不能被 plan 匹配劫持成硬冷却。
  // 顺序：11115 与 402/429 等已有判定在前（它们更具体），本条只兜「其它 4xx 的过大文案」。
  if (code === 413 || (e && e.status === 413) || isInputTooLargeMsg(msg)) {
    return { kind: "prompt_too_long", switchable: false, status: 413 };
  }
  if (/\b11115\b/.test(msg) || /prompt is too long|prompt_too_long/i.test(msg)) {
    return { kind: "prompt_too_long", switchable: false, status: 400 }; // 请求本身超限：零动作透传
  }
  if (/\b11101\b/.test(msg)) return { kind: "bad_params", switchable: true, status: 400 };
  if (e && e.status === 429) {
    // resetMs 统一为绝对时刻：parseRateResetMs 本就返回墙钟；retryAfterMs 是剩余时长，必须换算。
    // 二者混装会让 coolAccountMs 把时长当时刻，Retry-After: 7200 被 Math.max(now+1s) 兜成 1s 冷却（墙钟对齐失效）
    return { kind: "rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) || (e.retryAfterMs ? Date.now() + e.retryAfterMs : 0) };
  }
  if (e && e.status === 401) return { kind: "relogin", switchable: true, status: 401 };
  if (e && e.status === 404) return { kind: "not_found", switchable: true, status: 404 }; // 短冷却不累计，防雪崩
  if (e && e.status === 400) return { kind: "fatal", switchable: false, status: 400 };
  // 首字节超时（上游迟迟不吐第一个 token）：多为"这次 prompt 太大 / 上游这一刻忙"，
  // 不是账号故障——单独分类，只换号不冷却、也不计入 5xx/网络熔断
  if (e && e.firstByteTimeout) return { kind: "slow", switchable: true, status: 504 };
  // 流中空闲超时（相邻两块数据之间超过 streamIdleMs 没有任何字节）：与首字节超时同一性质——
  // 保护性判定，不是账号故障。上游把连接挂住（风控软拦截、后端卡死）与下游网络抖动都长这样，
  // 罚号只会把整池逐个冻掉（实测：连续 3 次 idle 即触发 5xx 熔断 30 分钟）。
  // 归 slow：换号重试、不冷却、不进熔断；文案已由 pumpSse 给出「流中读超时（Ns）」，无需改写
  if (e && e.idleTimeout) return { kind: "slow", switchable: true, status: 504 };
  return { kind: "server", switchable: true, status: 502 }; // 5xx / 网络 / 超时
}

/** 可触发渠道降级的错误类别：上游/余额/限流/凭证类。400 参数 / 11101 参数 / 11115 超长 /
 *  4001 模型配置类不降级——换渠道也救不了，罚渠道是冤枉 */
const DEGRADABLE = new Set(["credit", "rate", "server", "relogin", "model_rate", "model_blocked", "not_found"]);

module.exports = { classifyUpstream, parseRateResetMs, DEGRADABLE };
