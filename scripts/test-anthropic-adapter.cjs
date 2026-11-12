/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *     此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 标准自定义供应商 · 两档新协议的出站闸：node scripts/test-anthropic-adapter.cjs
//
// 为什么必须有一条独立闸：这两档的正确性**全部**体现在「线上字节」上——请求体的字段名、
// 鉴权头、SSE 事件的映射。任何一处写错，本地都不会报错，只会在真机上表现成
// 「400 参数错误」「401 未授权」或「200 但一个字都没吐」。用环回假上游把这层钉死，
// 不联网、不碰真实账号、不产生计费。
//
// 覆盖面（与方案 §5 的验收项对齐）：
//   ① Anthropic 请求体：system 提升 / max_tokens 兜底优先级 / tool_use 往返 / thinking 回放
//   ② Anthropic 鉴权：bearer / x-api-key / auto（官方域名例外）
//   ③ Anthropic SSE：text + thinking + tool_use 增量 + usage（含缓存读）+ finish
//   ④ Anthropic 非流式整包（部分中转站无视 stream:true）
//   ⑤ Responses 请求体：instructions / input items / tools 摊平 / max_output_tokens / 内部字段不外泄
//   ⑥ Responses SSE：文本 + function_call 头与参数增量 + usage + finish=tool_calls
//   ⑦ 未知 kind 回落 openai_compat（存量行不炸）
"use strict";
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { makeAdapter } = require(path.join(ROOT, "electron/backend/localgw/standard/factory.cjs"));

let pass = 0;
let failed = 0;
function ok(cond, name, got) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}` + (got === undefined ? "" : ` → got ${JSON.stringify(got).slice(0, 300)}`));
  }
}

/** 假上游：按请求路径回不同的响应形态；received 记最后一次请求，供逐字段断言 */
let received = null;
let mode = "sse"; // sse | json
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  received = { url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  if (req.url.endsWith("/v1/messages")) {
    if (mode === "json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: [{ type: "thinking", thinking: "想一想" }, { type: "text", text: "你好" },
          { type: "tool_use", id: "tu_1", name: "lookup", input: { a: 1 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame("message_start", { type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 3 } } }));
    res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }));
    res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }));
    res.write(frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "lookup", input: {} } }));
    res.write(frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }));
    res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }));
    res.end(frame("message_stop", { type: "message_stop" }));
    return;
  }

  if (req.url.endsWith("/v1/responses")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "看" }));
    res.write(frame("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" } }));
    res.write(frame("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"a":1}' }));
    res.end(frame("response.completed", { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } } }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});

const budget = { firstByteBudgetMs: () => 5000 };
const contentOf = (events) => events.filter((e) => e.type === "delta" && e.delta && e.delta.content).map((e) => e.delta.content).join("");
const reasoningOf = (events) => events.filter((e) => e.type === "delta" && e.delta && e.delta.reasoning_content).map((e) => e.delta.reasoning_content).join("");
const toolHeads = (events) => events.filter((e) => e.type === "delta" && e.delta && e.delta.tool_calls && e.delta.tool_calls[0].function && e.delta.tool_calls[0].function.name);
const toolArgs = (events) => events.filter((e) => e.type === "delta" && e.delta && e.delta.tool_calls && e.delta.tool_calls[0].function && e.delta.tool_calls[0].function.arguments).map((e) => e.delta.tool_calls[0].function.arguments).join("");

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ===== ① 请求体：字段口径 =====
  console.log("① Anthropic 请求体（字段写错＝上游 400，本地不会报）");
  {
    const ad = makeAdapter({ id: "zai-api", kind: "anthropic_messages", baseUrl: base, auth: "bearer", defaultMaxTokens: 64000, models: [{ model: "GLM-5.3" }] }, budget);
    const events = [];
    await ad.chat({
      secrets: { token: "k-1" }, model: "zai-api/GLM-5.3",
      body: {
        model: "GLM-5.3",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "查一下" },
          { role: "assistant", content: "", reasoning_content: "先想", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "结果" },
        ],
        tools: [{ type: "function", function: { name: "lookup", description: "d", parameters: { type: "object", properties: {} } } }],
        max_tokens: undefined,
      },
      emit: (e) => events.push(e),
    });
    ok(received.url === "/v1/messages", "端点 = {base}/v1/messages", received.url);
    ok(received.body.system === "你是助手", "system 提升到顶层（不是留在 messages 里）", received.body.system);
    ok(received.body.max_tokens === 64000, "缺省 max_tokens 取模型行/预设兜底，不是 8192", received.body.max_tokens);
    ok(received.body.stream === true, "恒流式打上游", received.body.stream);
    const asst = received.body.messages.find((m) => m.role === "assistant");
    ok(!!asst && asst.content.some((b) => b.type === "thinking" && b.thinking === "先想"), "assistant 的 reasoning_content 回放成 thinking 块（GLM 系多轮必需）", asst && asst.content);
    ok(!!asst && asst.content.some((b) => b.type === "tool_use" && b.id === "call_1" && b.input && b.input.q === "x"), "tool_calls → tool_use 块（arguments 解析成对象）", asst && asst.content);
    const userTool = received.body.messages.filter((m) => m.role === "user").pop();
    ok(!!userTool && userTool.content.some((b) => b.type === "tool_result" && b.tool_use_id === "call_1"), "tool 角色 → user 回合里的 tool_result 块", userTool && userTool.content);
    ok(Array.isArray(received.body.tools) && received.body.tools[0].name === "lookup" && !!received.body.tools[0].input_schema, "tools 摊平成 Anthropic 的 name/input_schema", received.body.tools);
  }

  // ===== ② 鉴权：三档 =====
  console.log("\n② 鉴权风格（国内 Coding Plan 全是 Bearer，官方只认 x-api-key）");
  {
    const bearer = makeAdapter({ id: "x", kind: "anthropic_messages", baseUrl: base, auth: "bearer", models: [] }, budget);
    await bearer.chat({ secrets: { token: "k-b" }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {} });
    ok(received.headers.authorization === "Bearer k-b" && received.headers["x-api-key"] === undefined, "auth=bearer → 只发 Authorization", received.headers);
    ok(received.headers["anthropic-version"] === "2023-06-01", "必带 anthropic-version", received.headers["anthropic-version"]);

    const xkey = makeAdapter({ id: "x", kind: "anthropic_messages", baseUrl: base, auth: "x-api-key", models: [] }, budget);
    await xkey.chat({ secrets: { token: "k-x" }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {} });
    ok(received.headers["x-api-key"] === "k-x" && received.headers.authorization === undefined, "auth=x-api-key → 只发 x-api-key", received.headers);

    const autoLocal = makeAdapter({ id: "x", kind: "anthropic_messages", baseUrl: base, auth: "", models: [] }, budget);
    await autoLocal.chat({ secrets: { token: "k-a" }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {} });
    ok(received.headers.authorization === "Bearer k-a", "auto + 非官方域名 → Bearer（国内套餐的实际口径）", received.headers);

    const official = makeAdapter({ id: "x", kind: "anthropic_messages", baseUrl: "https://api.anthropic.com", auth: "", models: [] }, budget);
    ok(official.headers({ token: "k-o" })["x-api-key"] === "k-o", "auto + api.anthropic.com → x-api-key（唯一的例外）", official.headers({ token: "k-o" }));
  }

  // ===== ③ SSE 映射 =====
  console.log("\n③ Anthropic SSE → 统一 emit 事件");
  {
    const ad = makeAdapter({ id: "x", kind: "anthropic_messages", baseUrl: base, auth: "bearer", models: [{ model: "m" }] }, budget);
    const events = [];
    const r = await ad.chat({ secrets: { token: "k" }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: (e) => events.push(e) });
    ok(contentOf(events) === "你好", "text_delta → delta.content", contentOf(events));
    ok(reasoningOf(events) === "想", "thinking_delta → delta.reasoning_content", reasoningOf(events));
    ok(toolHeads(events).length === 1 && toolHeads(events)[0].delta.tool_calls[0].function.name === "lookup", "content_block_start(tool_use) → tool_calls 头", toolHeads(events));
    ok(toolArgs(events) === '{"a":1}', "input_json_delta → tool_calls 参数增量", toolArgs(events));
    const usage = events.find((e) => e.type === "usage");
    ok(!!usage && usage.usage.prompt_tokens === 10 && usage.usage.completion_tokens === 5 && usage.usage.total_tokens === 15, "usage 归一：prompt 含缓存读（7+3），total 自补", usage && usage.usage);
    ok(!!usage && usage.usage.prompt_tokens_details.cached_tokens === 3, "缓存命中另放 prompt_tokens_details.cached_tokens", usage && usage.usage.prompt_tokens_details);
    ok(events.find((e) => e.type === "finish").reason === "tool_calls", "stop_reason=tool_use → finish=tool_calls", events.find((e) => e.type === "finish"));
    ok(r.planLimit === false, "正常响应不置 planLimit", r.planLimit);
  }

  // ===== ④ 非流式整包 =====
  console.log("\n④ 非流式整包（少数中转站无视 stream:true）");
  {
    mode = "json";
    const ad = makeAdapter({ id: "x", kind: "anthropic_messages", baseUrl: base, auth: "bearer", models: [{ model: "m" }] }, budget);
    const events = [];
    await ad.chat({ secrets: { token: "k" }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: (e) => events.push(e) });
    mode = "sse";
    ok(contentOf(events) === "你好", "content[].text → delta.content", contentOf(events));
    ok(reasoningOf(events) === "想一想", "content[].thinking → reasoning_content", reasoningOf(events));
    const head = toolHeads(events)[0];
    ok(!!head && head.delta.tool_calls[0].function.arguments === '{"a":1}', "content[].tool_use → 一次性 tool_calls（参数 JSON 化）", head && head.delta.tool_calls);
    ok(events.find((e) => e.type === "finish").reason === "tool_calls", "stop_reason 映射到 finish", events.find((e) => e.type === "finish"));
    const usage = events.find((e) => e.type === "usage");
    ok(!!usage && usage.usage.prompt_tokens === 11, "非流式 usage 与流式同口径（9+2）", usage && usage.usage);
  }

  // ===== ⑤ Responses 请求体 =====
  console.log("\n⑤ Responses 请求体（chat 形状 → input items）");
  {
    const ad = makeAdapter({ id: "openai", kind: "openai_responses", baseUrl: base, models: [{ model: "gpt", upstream: "gpt-up" }] }, budget);
    const events = [];
    await ad.chat({
      secrets: { token: "k-4" }, model: "openai/gpt",
      body: {
        model: "gpt", conversation_id: "internal", prompt_cache_key: "x", stream_options: { include_usage: true },
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"a":1}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "结果" },
        ],
        tools: [{ type: "function", function: { name: "lookup", description: "d", parameters: { type: "object" } } }],
        max_tokens: 123, reasoning_effort: "low",
      },
      emit: (e) => events.push(e),
    });
    ok(received.url === "/v1/responses", "端点 = {base}/v1/responses", received.url);
    ok(received.body.model === "gpt-up", "模型名按 upstream 映射（客户端名不外泄）", received.body.model);
    ok(received.body.instructions === "sys", "system → 顶层 instructions", received.body.instructions);
    const input = Array.isArray(received.body.input) ? received.body.input : [];
    ok(input.some((i) => i.type === "message" && i.role === "user" && i.content[0].type === "input_text"), "user → message/input_text item", input);
    ok(input.some((i) => i.type === "function_call" && i.call_id === "call_1" && i.name === "lookup"), "assistant.tool_calls → function_call item", input);
    ok(input.some((i) => i.type === "function_call_output" && i.call_id === "call_1"), "tool 角色 → function_call_output item", input);
    ok(Array.isArray(received.body.tools) && received.body.tools[0].name === "lookup" && received.body.tools[0].type === "function", "tools 摊平（不是 chat 的 {type,function} 双层）", received.body.tools);
    ok(received.body.max_output_tokens === 123, "max_tokens → max_output_tokens", received.body.max_output_tokens);
    ok(received.body.reasoning && received.body.reasoning.effort === "low", "reasoning_effort → reasoning.effort", received.body.reasoning);
    ok(received.body.store === false, "store=false（不把会话留在上游）", received.body.store);
    const leaked = ["conversation_id", "prompt_cache_key", "stream_options", "messages", "max_tokens", "reasoning_effort"].filter((k) => received.body[k] !== undefined);
    ok(leaked.length === 0, "网关内部字段不外泄（上游对未知字段可能直接 400）", leaked);
  }

  // ===== ⑥ Responses SSE =====
  console.log("\n⑥ Responses SSE → 统一 emit 事件");
  {
    const ad = makeAdapter({ id: "x", kind: "openai_responses", baseUrl: base, models: [] }, budget);
    const events = [];
    const r = await ad.chat({ secrets: { token: "k" }, model: "m", body: { messages: [{ role: "user", content: "hi" }] }, emit: (e) => events.push(e) });
    ok(contentOf(events) === "看", "response.output_text.delta → delta.content", contentOf(events));
    ok(toolHeads(events).length === 1 && toolHeads(events)[0].delta.tool_calls[0].id === "call_1", "output_item.added(function_call) → tool_calls 头（带 call_id）", toolHeads(events));
    ok(toolArgs(events) === '{"a":1}', "function_call_arguments.delta → 参数增量", toolArgs(events));
    const usage = events.find((e) => e.type === "usage");
    ok(!!usage && usage.usage.prompt_tokens === 11 && usage.usage.completion_tokens === 4 && usage.usage.total_tokens === 15, "usage 按 input/output_tokens 归一", usage && usage.usage);
    ok(events.find((e) => e.type === "finish").reason === "tool_calls", "有工具调用 → finish=tool_calls", events.find((e) => e.type === "finish"));
    ok(r.planLimit === false, "正常响应不置 planLimit", r.planLimit);
  }

  // ===== ⑦ 未知 kind =====
  console.log("\n⑦ 存量行与未知档");
  {
    const legacy = makeAdapter({ id: "relay", kind: "openai_compat", baseUrl: base, models: [] });
    ok(typeof legacy.chat === "function" && typeof legacy.rewriteBody === "function", "openai_compat 仍走原适配器");
    const unknown = makeAdapter({ id: "relay", kind: "made_up", baseUrl: base, models: [] });
    ok(typeof unknown.chat === "function", "未知 kind 回落 openai_compat（不抛、不白屏）");
  }

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
