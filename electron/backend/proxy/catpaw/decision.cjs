// CatPaw 轮次判定：三条规则决定这次请求怎么走上游（移植来源：参照实现 catpaw/decision.rs）。
//
// 三规则的顺序不可交换：
//   1. 历史末尾是 assistant(tool_calls) + 全部 tool 结果，且 tool_call_id 命中注册表
//      → 工具续接：turn 直接提交那条 tool 消息，不 round；
//   2. 请求带会话 id 且注册表存在映射 → 长会话新轮次：复用 conversationId，round 只提交增量；
//   3. 其余 → 全新会话：新 conversationId，round 提交全量历史。
//
// 为什么顺序不能换：规则 1 判「这一轮是不是上一轮的延续」，规则 2 判「有没有可复用的 conversationId」。
// 工具续接请求**同样带**会话 id，若先判规则 2 就会走成「往同一 conversation 再 round 一条 user 消息」——
// 而上游此时还在等 tool 结果，round 与 turn 的历史就串了。
//
// 指纹不匹配是「重建」而不是「报错」：客户端压缩/改写历史是正常行为（上下文过长时客户端会自行删旧消息），
// 那时旧 conversation 无法增量续接，但用户的问题本身没问题——作废映射、全量重开一轮，用户无感。
"use strict";
const CatPawError = require("./errors.cjs");
const log = require("./log.cjs");
const { registry, REASONS, shortId } = require("./registry.cjs");
const { locateIncrement, fingerprintsFor, messageFingerprint } = require("./fingerprint.cjs");
const { normalizeContinuationMessages } = require("./messages.cjs");
const util = require("../util.cjs");

/** 历史末尾那段「待响应的 assistant tool_call」的起点下标。
 *  从后往前走，找最近一条「带非空 tool_calls 的 assistant」，再要求它之后的消息**全是 tool 且覆盖每个 tool_call_id**：
 *    覆盖完整 → 待响应集合（返回下标）；全是 tool 但没覆盖完 → 本轮不是工具续接（返回 null）；
 *    中间混了别的角色 → 继续往前找 */
function pendingToolCallStart(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index];
    if (!message || message.role !== "assistant") continue;
    const calls = message.tool_calls;
    if (!Array.isArray(calls) || !calls.length) continue;
    const remaining = calls
      .map((call) => (call && typeof call.id === "string" ? call.id : ""))
      .filter((id) => id);
    let valid = true;
    for (const item of list.slice(index + 1)) {
      if (!item || item.role !== "tool") {
        valid = false;
        break;
      }
      const callId = String(item.tool_call_id || item.toolCallId || "");
      const position = remaining.indexOf(callId);
      if (position >= 0) remaining.splice(position, 1);
    }
    if (!valid) continue;
    return remaining.length === 0 ? index : null;
  }
  return null;
}

/** 历史末尾待响应工具调用的 id 列表 */
function pendingCallIds(messages) {
  const start = pendingToolCallStart(messages);
  if (start === null) return [];
  const calls = Array.isArray(messages[start].tool_calls) ? messages[start].tool_calls : [];
  return calls
    .map((call) => (call && typeof call.id === "string" ? call.id : ""))
    .filter((id) => id.trim())
    .map((id) => id.trim());
}

/** 工具续接要提交的那条 tool 消息。
 *
 *  与参照实现的一处差异：原实现用会话里存的 toolCalls 回填 toolName，这里改成从**本次请求历史**里
 *  那条 assistant 消息的 tool_calls 取——两者是同一批数据（会话里那份就是上一轮上游返回、被客户端回显的），
 *  而本次请求的值不会过期。回填是必需的：toolName 进指纹，缺了会让客户端下一轮回显的 tool 消息
 *  与注册表指纹对不上，误判「历史被改写」而全量重建 */
function continuationMessage(rawMessages, session) {
  const start = pendingToolCallStart(rawMessages);
  if (start === null) throw CatPawError.badRequest("工具结果续接请求缺少对应的 assistant tool_calls");
  const calls = Array.isArray(rawMessages[start].tool_calls) ? rawMessages[start].tool_calls : [];
  const names = calls.map((call) => [
    String((call && call.id) || ""),
    String((call && call.function && call.function.name) || ""),
  ]);
  const continuation = normalizeContinuationMessages(rawMessages.slice(start + 1));
  const isSingleTool = continuation.length === 1 && continuation[0].type === "tool";
  if (!isSingleTool) {
    throw CatPawError.badRequest("工具结果续接请求只能包含当前 tool_call 对应的 tool 结果");
  }
  const message = continuation[0];
  const blocks = Array.isArray(message.content) ? message.content : [];
  const seen = [];
  const rewritten = blocks.map((block) => {
    if (!block || block.type !== "tool_result") return block;
    const callId = String(block.toolCallId || "");
    seen.push(callId);
    const hit = names.find(([id]) => id === callId);
    if (hit && hit[1]) return { ...block, toolName: hit[1] };
    return block;
  });
  // 待响应集合必须与实际提交的 tool_result 完全一致
  if (session.pendingCallIds.length !== seen.length || session.pendingCallIds.some((id) => !seen.includes(id))) {
    throw CatPawError.badRequest("tool_result 与待处理的 assistant tool_calls 不一致");
  }
  return { ...message, content: rewritten };
}

/** 轮次判定（参照实现 streamRequest 开头那一段，**顺序照抄**）。
 *  persistent = 本次请求占用了长会话（无状态辅助请求 / 并发冲突走原判定但关掉长会话映射那一读） */
function decide({ rawMessages, sessionId, modelType, accountId, prepared, persistent }) {
  // ── 规则 1：工具续接（按 tool_call_id 命中注册表）──
  // 无状态 / 并发冲突时**仍然**走这条判定（只是关掉「长会话映射」那一读，call 索引那一路照常命中）
  const hits = [];
  for (const callId of pendingCallIds(rawMessages)) {
    const record = registry.lookupByCallId(callId);
    if (record && !hits.some((hit) => hit.conversationId === record.conversationId)) hits.push(record);
  }
  if (hits.length > 1) {
    // 同一批 tool_call_id 命中了两条不同的 conversation：客户端把两轮工具调用的结果混在一起了
    throw CatPawError.badRequest("tool_call_id 命中多个待处理工具会话");
  }
  if (hits.length === 1) {
    const session = hits[0];
    return {
      mode: "tool-continuation",
      conversationId: session.conversationId,
      roundMessages: null,
      session,
      continuation: continuationMessage(rawMessages, session),
    };
  }

  // ── 规则 2：长会话新轮次（会话 id 命中注册表）──
  if (persistent) {
    const resolution = registry.resolve(sessionId, modelType, accountId);
    if (resolution.kind === "reuse") {
      const session = resolution.record;
      const position = locateIncrement(prepared.messages, session.fingerprints);
      if (position.kind === "incremental") {
        const increment = prepared.messages.slice(position.start);
        if (!increment.length) increment.push(prepared.finalMessage); // 重发同一轮：只提交末尾那条
        return {
          mode: "session-round",
          conversationId: session.conversationId,
          roundMessages: increment,
          session,
          continuation: null,
        };
      }
      // 指纹不匹配：客户端压缩/改写了历史，作废后按规则 3 全量重建
      log.verbose(`会话 ${shortId(session.conversationId)} 指纹不匹配（sync-mismatch），作废后全量重建`);
      registry.invalidate(sessionId, REASONS.SyncMismatch);
    } else if (resolution.reason) {
      log.verbose(`会话重建 reason=${resolution.reason}`);
    }
  }

  // ── 规则 3：全新会话（全量 round）──
  return {
    mode: "new-round",
    conversationId: util.uuid(),
    roundMessages: prepared.messages.slice(),
    session: null,
    continuation: null,
  };
}

/** 本轮「实际提交给上游」的消息指纹（写回指纹链用）。
 *  长会话只提交增量、工具续接只提交那条 tool 消息——必须与实际发出去的一致，
 *  否则下一次 locateIncrement 会在客户端历史里定位到错误的位置 */
function submittedFingerprints(decision) {
  const submitted = decision.roundMessages ? fingerprintsFor(decision.roundMessages) : [];
  if (decision.continuation) submitted.push(messageFingerprint(decision.continuation));
  return submitted;
}

module.exports = { decide, pendingCallIds, pendingToolCallStart, continuationMessage, submittedFingerprints };
