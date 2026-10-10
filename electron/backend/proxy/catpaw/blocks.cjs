// CatPaw 内容块与工具字段归一化（messages.js 的下半层；移植来源：参照实现 catpaw/blocks.rs，
// 其上游是 catpaw-upstream-messages.mjs 的 stringifyToolData / normalizeImageBlock /
// normalizeContentBlock / messageContent / validateToolArguments / normalizeToolCalls / toolResultContent）。
//
// 字段名映射（上游协议为唯一权威）：
//   image_url:{url,detail} → imageUrl:{url,detail}（蛇形→驼峰）
//   function.name / toolName / name → toolName
//   function.arguments / toolParams / arguments → toolParams（JSON 文本）
//   tool_call_id / toolCallId → toolCallId
//   reasoning_content / reasoningContent → 挂在 text 块上的 reasoningContent
//
// 每个取值都按原实现的运算符语义照抄（`||` 真值 vs `??` 空值合并）：
// `arguments: ""` 对 `||` 会继续往后找、对 `??` 会命中空串；`tool_calls: []` 空数组对 `||` 是真值。
"use strict";
const { jsTruthy } = require("./fingerprint.cjs");
const CatPawError = require("./errors.cjs");

/** 图片 URL / Data URL 长度上限（8MB）。在归一化阶段就挡掉超大图片，
 *  避免把几十 MB 的 base64 搬进内存（真正的压缩在 imageCompress.js） */
const MAX_IMAGE_URL_LENGTH = 8 * 1024 * 1024;
const IMAGE_DETAILS = ["auto", "low", "high"];

/** 消息 content → 上游内容块数组：字符串（整条变一个 text 块）、null/缺失（空数组）、数组（逐块归一化） */
function messageContent(message) {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === undefined || content === null) return [];
  if (Array.isArray(content)) return content.map(normalizeContentBlock);
  throw CatPawError.badRequest("消息 content 必须是字符串、数组或 null");
}

/** 单个内容块归一化：字符串 → text 块；text/output_text → text 块；image_url → 驼峰 imageUrl */
function normalizeContentBlock(block) {
  if (typeof block === "string") return { type: "text", text: block };
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw CatPawError.badRequest("消息 content block 必须是对象或字符串");
  }
  if (block.type === "text" || block.type === "output_text") {
    if (typeof block.text !== "string") throw CatPawError.badRequest("文本消息缺少 text");
    const normalized = { type: "text", text: block.text };
    // 对象展开、先驼峰后蛇形：两者都在时蛇形覆盖驼峰（照抄原实现顺序）
    if (typeof block.reasoningContent === "string") normalized.reasoningContent = block.reasoningContent;
    if (typeof block.reasoning_content === "string") normalized.reasoningContent = block.reasoning_content;
    return normalized;
  }
  if (block.type === "image_url") return normalizeImageBlock(block);
  throw CatPawError.badRequest(`不支持的消息内容类型: ${block.type || ""}`);
}

/** `data:image/(png|jpeg|jpg|gif|webp|bmp);base64,<正文>` 判定（类型大小写不敏感，正文非空且只含 base64 字符集与空白） */
function isBase64ImageDataUrl(value) {
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const header = value.slice(0, comma).toLowerCase();
  const body = value.slice(comma + 1);
  if (!header.startsWith("data:")) return false;
  if (!header.endsWith(";base64")) return false;
  const meta = header.slice("data:".length, -";base64".length);
  if (!meta.startsWith("image/")) return false;
  const subtype = meta.slice("image/".length);
  if (!["png", "jpeg", "jpg", "gif", "webp", "bmp"].includes(subtype)) return false;
  return body.length > 0 && /^[a-z0-9+/=\s]+$/i.test(body);
}

/** 图片块：{type:"image_url", image_url:{url,detail}} → {type:"image_url", imageUrl:{url,detail}} */
function normalizeImageBlock(block) {
  // `block.image_url || block.imageUrl`（真值判定，先蛇形后驼峰）
  const source = jsTruthy(block.image_url) ? block.image_url : (jsTruthy(block.imageUrl) ? block.imageUrl : undefined);
  let url = "";
  if (typeof source === "string") url = source;
  else if (source && typeof source === "object" && typeof source.url === "string") url = source.url;
  if (!url) throw CatPawError.badRequest("图片消息缺少 image_url.url");
  const trimmed = url.trim();
  if (!trimmed) throw CatPawError.badRequest("图片消息缺少 image_url.url");
  if (trimmed.length > MAX_IMAGE_URL_LENGTH) throw CatPawError.badRequest("图片 URL 或 Data URL 超过大小上限");
  // 前缀判定大小写敏感（原实现 `trimmed.startsWith('data:')`）：DATA: 会落到 URL 分支被拒
  if (trimmed.startsWith("data:")) {
    if (!isBase64ImageDataUrl(trimmed)) {
      throw CatPawError.badRequest("图片 Data URL 仅支持 png、jpeg、gif、webp、bmp 的 Base64 格式");
    }
  } else {
    let parsed = null;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw CatPawError.badRequest("图片 URL 格式无效");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw CatPawError.badRequest("图片 URL 仅支持 http/https 协议");
    }
  }
  let detail = "auto";
  if (source && typeof source === "object" && IMAGE_DETAILS.includes(source.detail)) detail = source.detail;
  return { type: "image_url", imageUrl: { url: trimmed, detail } };
}

/** 递归校验 JSON 值（原实现 validateJsonValue）：嵌套深度 ≤12，不含危险键（原型污染面） */
function validateJsonValue(value, path, depth, makeError) {
  const fail = makeError || ((msg) => CatPawError.badRequest(msg));
  if (depth > 12) throw fail(`${path} 嵌套过深`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, depth + 1, makeError));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw fail(`${path} 包含不允许的字段 ${key}`);
      }
      validateJsonValue(item, `${path}.${key}`, depth + 1, makeError);
    }
  }
}

/** 工具参数规范化：必须是 JSON 对象（字符串形态要先能 JSON.parse 成对象）。
 *  字符串输入**原样返回**（保留客户端空白与键序——它进 toolParams 也进指纹，重序列化会让两条本该相同的消息指纹不同） */
function validateToolArguments(value, index) {
  const invalid = () => CatPawError.badRequest(`assistant.tool_calls[${index}].function.arguments 必须是 JSON 对象字符串`);
  if (typeof value === "string") {
    let parsed;
    try {
      parsed = JSON.parse(value === "" ? "{}" : value);
    } catch {
      throw invalid();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
    // 嵌套/危险键的具体原因被这条统一文案吃掉——照抄原实现口径，避免同一输入两种报错
    try {
      validateJsonValue(parsed, `assistant.tool_calls[${index}].function.arguments`, 0);
    } catch {
      throw invalid();
    }
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    validateJsonValue(value, `assistant.tool_calls[${index}].function.arguments`, 0);
    return JSON.stringify(value);
  }
  if (value === null || value === undefined) return "{}";
  throw CatPawError.badRequest(`assistant.tool_calls[${index}].function.arguments 必须是 JSON 对象`);
}

/** assistant 的 tool_calls 归一化：兼容 tool_calls/toolCalls 两字段与三种调用形态
 *  （OpenAI 形态 / 上游回显形态 / 简写）。type 只支持 function（缺失放行） */
function normalizeToolCalls(message) {
  // `message.tool_calls || message.toolCalls`（真值判定：空数组是真值 → 走数组分支）
  const calls = jsTruthy(message.tool_calls) ? message.tool_calls : (jsTruthy(message.toolCalls) ? message.toolCalls : undefined);
  if (calls === undefined) return [];
  if (!Array.isArray(calls)) throw CatPawError.badRequest("assistant.tool_calls 必须是数组");
  return calls.map((call, index) => {
    const obj = call && typeof call === "object" ? call : {};
    // 只有字符串且不等于 function 才报错（null 视为未给）
    if (typeof obj.type === "string" && obj.type !== "function") {
      throw CatPawError.badRequest(`assistant.tool_calls[${index}].type 只支持 function`);
    }
    const rawId = jsTruthy(obj.id) ? obj.id : (jsTruthy(obj.toolCallId) ? obj.toolCallId : undefined);
    const id = typeof rawId === "string" ? rawId : "";
    if (!id.trim()) throw CatPawError.badRequest("tool_call 缺少 id");
    const fn = obj.function && typeof obj.function === "object" ? obj.function : null;
    const rawName = (fn && jsTruthy(fn.name) ? fn.name : undefined)
      ?? (jsTruthy(obj.toolName) ? obj.toolName : undefined)
      ?? (jsTruthy(obj.name) ? obj.name : undefined);
    const name = typeof rawName === "string" ? rawName : "";
    if (!name.trim()) throw CatPawError.badRequest("tool_call 缺少 function.name");
    // `call?.function?.arguments ?? call?.toolParams ?? call?.arguments ?? ''`（空值合并：空串命中，null 跳过）
    const rawArgs = (fn && fn.arguments !== undefined && fn.arguments !== null) ? fn.arguments
      : (obj.toolParams !== undefined && obj.toolParams !== null) ? obj.toolParams
        : (obj.arguments !== undefined && obj.arguments !== null) ? obj.arguments
          : "";
    return { id, name, arguments: validateToolArguments(rawArgs, index) };
  });
}

/** tool 消息的结果文本：content → toolResult → result（`??` 语义）。
 *  数组形态：空数组→空串；全字符串→\n 连接；全是 text/output_text 块→取各块 text 后 \n 连接；其余→整段 JSON */
function toolResultContent(message, index) {
  let value;
  for (const key of ["content", "toolResult", "result"]) {
    if (message[key] !== undefined && message[key] !== null) {
      value = message[key];
      break;
    }
  }
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.length) return "";
    if (value.every((item) => typeof item === "string")) return value.join("\n");
    const allTextBlocks = value.every((item) => item && typeof item === "object"
      && (item.type === "text" || item.type === "output_text") && typeof item.text === "string");
    if (allTextBlocks) return value.map((item) => item.text).join("\n");
    validateJsonValue(value, `messages[${index}].content`, 0, (msg) => CatPawError.badRequest(msg));
    return JSON.stringify(value);
  }
  throw CatPawError.badRequest(`messages[${index}].content 必须是字符串或 JSON 结构`);
}

module.exports = {
  messageContent,
  normalizeContentBlock,
  normalizeImageBlock,
  normalizeToolCalls,
  validateToolArguments,
  validateJsonValue,
  toolResultContent,
  MAX_IMAGE_URL_LENGTH,
};
