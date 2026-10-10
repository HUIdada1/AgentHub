// CatPaw 入站消息归一化（移植来源：参照实现 catpaw/messages.rs，上游为
// catpaw-upstream-messages.mjs 与 proxy-chat-utils.mjs）。**纯函数：不发网络、不读盘。**
//
// 上游 round/turn 不接受 OpenAI 的 messages，只接受它自己的消息块数组：
//   user:      { type:"user",      messageId, content:[text | image_url], finished }
//   assistant: { type:"assistant", messageId, content:[text | tool_use],  finished }
//   tool:      { type:"tool",      messageId, content:[tool_result],      finished }
// 两条不属于 messages 的东西被抽离成 round 请求体的独立字段：
//   system 消息 → systemPromptContext.systemPromptOverride；developer 消息 → rulesMessage。
//
// 归一化规则总览（改前先读参照实现）：
//   1. system/developer 抽离且必须位于所有对话消息之前；
//   2. 连续多条 tool 消息（OpenAI 并行工具调用）合并为单条 tool 消息的多个 tool_result 块
//      —— 上游明确拒绝 tool 消息连续出现；
//   3. 相邻 assistant 合并（两条都带 tool_use 时无法安全合并，保留原样交给配对校验报错）；
//   4. assistant tool_call 与随后的 tool 结果做配对校验，并用 assistant 侧 toolName 补齐
//      tool 消息缺失的 toolName —— 这个补齐必须写回消息对象，因为 toolName 是指纹的一部分；
//   5. 客户端打断未完成工具调用后直接发新 user 消息：补一条合成 tool 消息保持配对；
//   6. 每条消息 messageId 必须非空（客户端没给就生成随机 UUID，上游 2026-09 起逐条校验）。
"use strict";
const { jsTruthy } = require("./fingerprint.cjs");
const CatPawError = require("./errors.cjs");
const { messageContent, normalizeToolCalls, toolResultContent } = require("./blocks.cjs");
const util = require("../util.cjs");

/** 打断未完成工具调用时补的合成 tool_result 文案（原实现逐字如此，会提交给上游，冻结不改） */
const INTERRUPTED_TOOL_RESULT = "[工具调用被用户中断]";

/** 单条消息归一化（阶段一）：返回 { directive: {role,text} } 或 { message } */
function normalizeMessage(message, index) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw CatPawError.badRequest(`messages[${index}] 必须是对象`);
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "system" || role === "developer") return normalizeDirective(message, index, role);
  if (role === "user") return normalizeUser(message, index);
  if (role === "assistant") return normalizeAssistant(message, index);
  if (role === "tool") return normalizeTool(message, index);
  throw CatPawError.badRequest(`不支持的消息角色: ${role}`);
}

/** 是否携带工具字段（system/developer/user 都不允许）。
 *  真值判定：空数组 `tool_calls: []` 在 JS 里是真值，也会被拒——保持这个口径 */
function hasToolFields(message) {
  return ["tool_calls", "toolCalls", "tool_call_id"].some((key) => jsTruthy(message[key]));
}

/** `messageId` 取值：非空字符串用它（**原样，不 trim**），否则生成随机 UUID。
 *  上游 2026-09 起在 round 阶段逐条校验（errorCode=400 / unifyCode=1005010001 / messageId 不能为空），
 *  空串与缺失一样被拒。随机 UUID 不影响增量会话：指纹不读 messageId */
function messageId(message) {
  return typeof message.id === "string" && message.id.trim() ? message.id : util.uuid();
}

/** `finished: message.finished !== false`（只有显式 false 才是未完成） */
function finishedFlag(message) {
  return message.finished !== false;
}

function normalizeDirective(message, index, role) {
  if (hasToolFields(message)) {
    throw CatPawError.badRequest(`messages[${index}] 的 ${role} 不允许携带工具字段`);
  }
  const content = messageContent(message);
  const text = content.filter((b) => typeof b.text === "string").map((b) => b.text).join("\n");
  const onlyText = content.every((b) => b.type === "text");
  if (!onlyText || !text.trim()) {
    throw CatPawError.badRequest(`messages[${index}] 的 ${role} 只允许非空文本内容`);
  }
  return { directive: { role, text } };
}

function normalizeUser(message, index) {
  if (hasToolFields(message)) {
    throw CatPawError.badRequest(`messages[${index}] 的 user 不允许携带工具字段`);
  }
  const content = messageContent(message);
  if (!content.length) throw CatPawError.badRequest(`messages[${index}] 的 user 内容不能为空`);
  return { message: { type: "user", messageId: messageId(message), content, finished: finishedFlag(message) } };
}

function normalizeAssistant(message, index) {
  const content = messageContent(message);
  if (content.some((b) => b.type !== "text")) {
    throw CatPawError.badRequest(`messages[${index}] 的 assistant 只允许文本与 tool_calls`);
  }
  // `reasoning_content ?? reasoningContent`（空值合并）：null 会继续看驼峰；
  // 两者非空时必须是字符串
  let reasoning = message.reasoning_content !== undefined && message.reasoning_content !== null
    ? message.reasoning_content
    : message.reasoningContent;
  if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") {
    throw CatPawError.badRequest(`messages[${index}].reasoning_content 必须是字符串`);
  }
  // `if (reasoning)`：非空串才挂载
  if (jsTruthy(reasoning)) {
    const target = content.find((b) => b.type === "text");
    if (target) target.reasoningContent = reasoning;
    else content.push({ type: "text", text: "", reasoningContent: reasoning });
  }
  for (const call of normalizeToolCalls(message)) {
    content.push({ type: "tool_use", toolCallId: call.id, toolName: call.name, toolParams: call.arguments });
  }
  return { message: { type: "assistant", messageId: messageId(message), content, finished: finishedFlag(message) } };
}

function normalizeTool(message, index) {
  const rawId = message.tool_call_id ?? message.toolCallId;
  const id = typeof rawId === "string" && rawId.trim() ? rawId : "";
  if (!id) throw CatPawError.badRequest(`messages[${index}] tool_call_id 缺失`);
  // 这里**是** trim 过的（与 id 不同，照抄原实现）
  const name = typeof message.name === "string" && message.name.trim() ? message.name.trim() : undefined;
  const result = toolResultContent(message, index);
  const block = { type: "tool_result", toolCallId: id };
  if (name) block.toolName = name;
  block.toolResult = result;
  const out = { type: "tool", messageId: messageId(message), content: [block], finished: finishedFlag(message) };
  // requestedToolName 不进上游也不进指纹，保留只为与归一化产物逐字段对齐，方便对照排障
  if (name) out.requestedToolName = name;
  return { message: out };
}

function messageType(message) {
  return message && typeof message.type === "string" ? message.type : undefined;
}

/** 消息是否含 tool_use 块 */
function hasToolUse(message) {
  return Array.isArray(message.content) && message.content.some((b) => b.type === "tool_use");
}

/** 收集 assistant 的 tool_use 块为 [toolCallId, toolName]（按出现顺序） */
function collectToolUse(message) {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((b) => b.type === "tool_use")
    .map((b) => [String(b.toolCallId || ""), String(b.toolName || "")]);
}

/** `previous.content.push(...message.content)`（两处合并共用） */
function appendContent(target, extra) {
  if (!Array.isArray(target.content) || !Array.isArray(extra.content)) return;
  target.content.push(...extra.content);
}

/** 相邻消息合并：连续 tool 合并；相邻 assistant 且至少一条没有 tool_use 才合并 */
function mergeAdjacent(stage) {
  const merged = [];
  for (const item of stage) {
    if (!item.message) {
      merged.push(item);
      continue;
    }
    const previous = merged.length && merged[merged.length - 1].message ? merged[merged.length - 1].message : null;
    if (!previous) {
      merged.push(item);
      continue;
    }
    const currentType = messageType(item.message);
    const previousType = messageType(previous);
    let mergeable = false;
    if (currentType === "tool" && previousType === "tool") mergeable = true;
    else if (currentType === "assistant" && previousType === "assistant") {
      mergeable = !hasToolUse(previous) || !hasToolUse(item.message);
    }
    if (mergeable) appendContent(previous, item.message);
    else merged.push(item);
  }
  return merged;
}

/** 合成「工具调用被用户中断」的 tool 消息（messageId 同样非空） */
function synthInterruptMessage(pending) {
  return {
    type: "tool",
    messageId: util.uuid(),
    content: pending.map(([callId, toolName]) => ({
      type: "tool_result",
      toolCallId: callId,
      toolName,
      toolResult: INTERRUPTED_TOOL_RESULT,
    })),
    finished: true,
  };
}

/** 一条 tool 消息的配对校验 + toolName 回填（回填必须写回消息对象：toolName 进指纹） */
function resolveToolMessage(message, index, pendingToolCalls) {
  if (!Array.isArray(message.content)) return message;
  const rewritten = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") {
      rewritten.push(block);
      continue;
    }
    const callId = String(block.toolCallId || "");
    const position = pendingToolCalls.findIndex(([pendingId]) => pendingId === callId);
    if (position < 0) {
      throw CatPawError.badRequest(`messages[${index}] 的 tool_call_id 没有待响应的 assistant tool_call`);
    }
    const [, expectedName] = pendingToolCalls[position];
    const actual = typeof block.toolName === "string" ? block.toolName : "";
    if (actual && actual !== expectedName) {
      throw CatPawError.badRequest(`messages[${index}] 的 tool name 与 assistant tool_call 不一致`);
    }
    rewritten.push({ ...block, toolName: expectedName });
    pendingToolCalls.splice(position, 1);
  }
  return { ...message, content: rewritten };
}

/** 抽离文本拼接：过滤空串后按 \n\n 连接，全空 → undefined（字段不出现） */
function joinDirectives(parts) {
  const joined = parts.filter(Boolean).join("\n\n");
  return joined || undefined;
}

/** 把 OpenAI messages 归一化成上游消息块（round 全量提交用）。
 *  options.allowTrailingToolCalls：允许历史以「待响应的 assistant tool_call」结尾
 *  （工具续接请求专用；全新会话/长会话新轮次一律 false，否则视为历史被截断报错） */
function normalizeMessages(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw CatPawError.badRequest("messages 必须是非空数组");
  }
  const stage = messages.map((message, index) => normalizeMessage(message, index));
  return assemble(mergeAdjacent(stage), options);
}

function assemble(merged, options) {
  const conversation = [];
  const systemParts = [];
  const developerParts = [];
  const knownToolCalls = [];
  let pendingToolCalls = [];
  let index = -1;
  for (const item of merged) {
    index += 1;
    if (item.directive) {
      if (conversation.length) {
        throw CatPawError.badRequest(`messages[${index}] 的 ${item.directive.role} 必须位于所有对话消息之前`);
      }
      if (item.directive.role === "system") systemParts.push(item.directive.text);
      else developerParts.push(item.directive.text);
      continue;
    }
    const message = item.message;
    const type = messageType(message);
    if (type === "assistant") {
      if (pendingToolCalls.length) {
        throw CatPawError.badRequest(`messages[${index}] 前缺少 assistant tool_call 对应的 tool 结果`);
      }
      const calls = collectToolUse(message);
      for (const [callId] of calls) {
        if (knownToolCalls.includes(callId)) {
          throw CatPawError.badRequest(`messages[${index}] 重复的 tool_call_id: ${callId}`);
        }
        knownToolCalls.push(callId);
      }
      pendingToolCalls = calls;
      conversation.push(message);
    } else if (type === "tool") {
      conversation.push(resolveToolMessage(message, index, pendingToolCalls));
    } else {
      if (pendingToolCalls.length) {
        if (type === "user") {
          conversation.push(synthInterruptMessage(pendingToolCalls));
          pendingToolCalls = [];
        } else {
          throw CatPawError.badRequest(`messages[${index}] 前缺少 assistant tool_call 对应的 tool 结果`);
        }
      }
      conversation.push(message);
    }
  }
  if (pendingToolCalls.length && !options.allowTrailingToolCalls) {
    throw CatPawError.badRequest("最后一条 assistant tool_call 缺少对应的 tool 结果");
  }
  return {
    messages: conversation,
    systemPrompt: joinDirectives(systemParts),
    rulesMessage: joinDirectives(developerParts),
  };
}

/** 工具结果续接请求的归一化：只做 normalizeMessage + tool 合并，
 *  不合并相邻 assistant、不抽离 system/developer、不做配对校验 */
function normalizeContinuationMessages(messages) {
  const normalized = [];
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    const item = normalizeMessage(message, index);
    if (item.directive) {
      throw CatPawError.badRequest(`messages[${index}] 的 ${item.directive.role} 必须位于所有对话消息之前`);
    }
    normalized.push(item.message);
  });
  const merged = [];
  for (const message of normalized) {
    if (messageType(message) === "tool" && merged.length && messageType(merged[merged.length - 1]) === "tool") {
      appendContent(merged[merged.length - 1], message);
      continue;
    }
    merged.push(message);
  }
  return merged;
}

module.exports = { normalizeMessages, normalizeContinuationMessages, INTERRUPTED_TOOL_RESULT };
