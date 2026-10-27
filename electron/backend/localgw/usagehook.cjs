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
// 本地网关 · 请求落账钩子
// 方案 §4.2：只产生明细，写入目标是 sync 模块的 usage 库（不另开独立库）。
// 落账失败必须静默——统计丢一条远好过让用户的请求因此失败。
"use strict";
const keysStore = require("./keys-store.cjs");

/** 落账：把一次成功请求写进用量统计 + 累加密钥计数
 *  row: { apiKeyId, channel, model, ms, promptTokens, completionTokens }
 *  row 为 undefined / null 时直接返回：本函数在请求尾部无条件调用，不能因为调用方漏传而炸。 */
function afterRequest(row) {
  if (!row || typeof row !== "object") return;
  // 1) 密钥计数（本地网关自己的表）
  try {
    if (row.apiKeyId) keysStore.touch(row.apiKeyId, row.promptTokens, row.completionTokens);
  } catch { /* 静默 */ }

  // 2) 用量统计模块：通过 app:event 广播让渲染层与 sync store 感知
  //    真实落库由 sync 侧的 usage hook 完成（接线时注入），本期只广播事件
  try {
    broadcast(row);
  } catch { /* 静默 */ }
}

/** 事件广播器：由 index.cjs 在 boot 时注入（避免本模块直接依赖 electron） */
let broadcaster = null;
function setBroadcaster(fn) {
  broadcaster = typeof fn === "function" ? fn : null;
}

function broadcast(row) {
  if (!broadcaster) return;
  const payload = {
    event: "localgw",
    type: "request",
    channel: row.channel,
    model: row.model,
    ms: row.ms,
    tokens: (row.promptTokens || 0) + (row.completionTokens || 0),
    ts: Date.now(),
  };
  // 广播器可能返回 Promise（webContents.send 一般不是，但注入方不保证）：
  // 不接住 rejection 会变成 unhandledRejection，主进程可能直接退出。
  try {
    const r = broadcaster(payload);
    if (r && typeof r.then === "function") r.then(undefined, () => { /* 广播失败只影响 UI 刷新 */ });
  } catch { /* 静默 */ }
}

module.exports = { afterRequest, setBroadcaster };
