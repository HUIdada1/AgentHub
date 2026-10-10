// CatPaw 工具字段归一化：OpenAI `tools` / `tool_choice` → 上游 `toolConfigs`
// （移植来源：参照实现 catpaw/tools.rs，上游为 catpaw-upstream-messages.mjs 的
// normalizeTools / toolChoiceMode）。
//
// 字段映射（上游协议为唯一权威）：
//   function.name → name；function.description → description（截 8000 字符）；
//   function.parameters → inputSchema（缺省 {"type":"object","properties":{}}）；
//   常量 enable:true / fromClient:true（客户端工具一律启用）。
//
// strict 一律拒绝：上游没有「强制按 schema 输出」的开关，声称支持等于骗客户端
// （客户端以为拿到结构性保证，实际没有）。strict:false 是默认行为，放行。
"use strict";
const CatPawError = require("./errors.cjs");
const { validateJsonValue } = require("./blocks.cjs");

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** 解析 tool_choice：undefined/null/"auto" → auto；对象形态只认 {type:"function", function:{name}} */
function toolChoiceMode(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return { kind: "auto" };
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { kind: "auto" };
    if (toolChoice === "none") return { kind: "none" };
    if (toolChoice === "required") return { kind: "required" };
    throw invalidChoice();
  }
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const name = toolChoice.function && toolChoice.function.name;
    if (toolChoice.type === "function" && typeof name === "string" && name) {
      return { kind: "function", name };
    }
    throw invalidChoice();
  }
  throw invalidChoice();
}

function invalidChoice() {
  return CatPawError.badRequest("tool_choice 只支持 auto、none、required 或指定 function");
}

/** `tools` → 上游 `toolConfigs`。未给 tools 返回空数组（不带工具的纯对话正常）；
 *  给了但形态不对（非数组、非 function 类型）才报 400 */
function normalizeTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw CatPawError.badRequest("tools 必须是数组");
  const names = [];
  const out = [];
  tools.forEach((tool, index) => {
    const functionDef = tool && typeof tool === "object" && tool.type === "function" && tool.function && typeof tool.function === "object"
      ? tool.function
      : null;
    if (!functionDef) throw CatPawError.badRequest(`tools[${index}] 只支持 type=function`);
    if (functionDef.strict !== undefined && functionDef.strict !== null) {
      if (typeof functionDef.strict !== "boolean") {
        throw CatPawError.badRequest(`tools[${index}].function.strict 必须是布尔值`);
      }
      if (functionDef.strict === true) {
        throw CatPawError.badRequest(`tools[${index}].function.strict=true 暂不支持`);
      }
    }
    const name = typeof functionDef.name === "string" ? functionDef.name : "";
    if (!name || name.length > 128 || !TOOL_NAME_RE.test(name)) {
      throw CatPawError.badRequest(`tools[${index}].function.name 无效`);
    }
    if (names.includes(name)) throw CatPawError.badRequest(`tools[${index}] 重复的工具名称: ${name}`);
    names.push(name);
    // `fn.parameters ?? {type:'object',properties:{}}`（空值合并；空对象是合法 schema，原样用）
    const schema = functionDef.parameters !== undefined && functionDef.parameters !== null
      ? functionDef.parameters
      : { type: "object", properties: {} };
    if (typeof schema !== "object" || Array.isArray(schema)) {
      throw CatPawError.badRequest(`tools[${index}].function.parameters 必须是 JSON Schema 对象`);
    }
    validateJsonValue(schema, `tools[${index}].function.parameters`, 0, (msg) => CatPawError.badRequest(msg));
    const config = { name, enable: true };
    if (typeof functionDef.description === "string") config.description = functionDef.description.slice(0, 8000);
    config.inputSchema = schema;
    config.fromClient = true;
    out.push(config);
  });
  return out;
}

/** 按 tool_choice 选本轮实际下发给上游的工具集：
 *  none → 空；auto/required → 全部（required 且一个都没给报 400）；指定函数 → 只含那一个（不存在报 400） */
function selectTools(all, choice) {
  if (choice.kind === "none") return [];
  if (choice.kind === "auto") return all.slice();
  if (choice.kind === "required") {
    if (!all.length) throw CatPawError.badRequest("tool_choice 要求至少提供一个 function 工具");
    return all.slice();
  }
  const selected = all.filter((tool) => tool.name === choice.name);
  if (!selected.length) {
    throw CatPawError.badRequest(`tool_choice 指定的工具不存在: ${choice.name}`);
  }
  return selected;
}

module.exports = { toolChoiceMode, normalizeTools, selectTools };
