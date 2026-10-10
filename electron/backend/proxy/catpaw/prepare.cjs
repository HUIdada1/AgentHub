// CatPaw 入站准备层：原始 OpenAI 请求体 → 本轮执行所需的归一化素材
// （移植来源：参照实现 catpaw/prepare.rs）。
//
// 一个客户端请求进来是「无状态 OpenAI 形态」（完整历史 + tools + 各种参数），
// 而上游 round/turn 要的是它自己的消息块与字段。本文件把前者翻译成后者，并在出网之前完成：
//   ① 参数解析：model → modelType、reasoning_effort → effort、context_window → context；
//   ② 工具归一化：tools / tool_choice → toolConfigs / 选中集；
//   ③ 消息归一化：messages → 上游消息块（含内联图片压缩——>60KB 的 base64 是 round 请求体超限的主因）。
//
// 与 conversation.js 的分工：本文件只产出「素材」，不碰会话注册表、不认识轮次模式。
"use strict";
const CatPawError = require("./errors.cjs");
const { normalizeMessages } = require("./messages.cjs");
const { compressMessages } = require("./imageCompress.cjs");
const { resolveModelRequest, resolveEffort, resolveContextWindow } = require("./models.cjs");
const { normalizeTools, selectTools, toolChoiceMode } = require("./tools.cjs");
const catalog = require("./catalog.cjs");

/** 归一化 + 参数解析。校验优先级照抄参照实现：消息 → effort → tools → tool_choice */
function prepare(body) {
  const source = body || {};
  const resolution = resolveModelRequest(source.model, { find: catalog.findRemote, knownIds: catalog.knownIds });
  const effort = resolveEffort(source);
  const context = resolveContextWindow(source, resolution);
  const choice = toolChoiceMode(source.tool_choice);
  const allTools = normalizeTools(source.tools);
  // 工具集裁剪同时是入参校验（required 没给工具、指定的工具不存在都报 400）：
  // 放在这里是为了让这类错误**不经过 round**（不留下一个刚创建就被判失败的 conversation）
  const selectedTools = selectTools(allTools, choice);
  // `parallel_tool_calls` 只做类型校验：上游 turn 请求体里没有对应字段，原实现也是「收了但不用」
  // （校验失败报 400，避免客户端以为它生效了）
  if (source.parallel_tool_calls !== undefined && source.parallel_tool_calls !== null) {
    if (typeof source.parallel_tool_calls !== "boolean") {
      throw CatPawError.badRequest("parallel_tool_calls 必须是布尔值");
    }
  }

  if (!Array.isArray(source.messages)) throw CatPawError.badRequest("messages 必须是非空数组");
  // 不允许多余的尾部 tool_call（allowTrailingToolCalls 只对「工具续接」那条路径有意义，
  // 而那条路径由 conversation.js 自己从原始消息里切片段）
  const normalized = normalizeMessages(source.messages, {});
  const messages = compressMessages(normalized.messages);
  const finalMessage = messages.length ? messages[messages.length - 1] : null;
  if (!finalMessage) throw CatPawError.badRequest("system/developer 之外至少需要一条对话消息");

  return {
    resolution,
    messages,
    finalMessage,
    systemPrompt: normalized.systemPrompt,
    rulesMessage: normalized.rulesMessage,
    effort,
    context,
    choice,
    selectedTools,
  };
}

module.exports = { prepare };
