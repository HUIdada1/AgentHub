/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 标准执行层 · 协议档分派。executor.cjs 与 provider.probe() 都只认这个入口，
// 不再各自 new 一个具体适配器（否则加一档就要改两处，漏一处是静默走错协议）。
"use strict";
const { makeOpenaiCompat } = require("./openai-compat.cjs");
const { makeAnthropicMessages } = require("./anthropic-messages.cjs");
const { makeOpenaiResponses } = require("./openai-responses.cjs");

const MAKERS = {
  openai_compat: makeOpenaiCompat,
  anthropic_messages: makeAnthropicMessages,
  openai_responses: makeOpenaiResponses,
};

/** 未知 kind 回落 openai_compat：存量行的 kind 一定是 openai_compat，
 *  而新档在写入侧已由 provider.validate 拦下，这里兜的是「库被手改脏」也不炸。 */
function makeAdapter(row, opts) {
  const kind = String((row && row.kind) || "openai_compat");
  return (MAKERS[kind] || makeOpenaiCompat)(row, opts);
}

module.exports = { makeAdapter };
