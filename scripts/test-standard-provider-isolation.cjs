"use strict";
// A standard supplier must execute without loading a proprietary forwarding adapter.
// Use an ephemeral data directory and loopback HTTP only; never access user accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-standard-isolation-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  if (typeof filename === "string" && /[\\/]proxy[\\/](?:adapters\.cjs|(?:catpaw|monkeycode|autoclaw|cline|loomy|accio|codearts)[\\/]|qoderAdapter\.cjs|zcodeAnthropic\.cjs)/.test(filename)) {
    throw new Error(`Standard execution attempted to load forwarding code: ${filename}`);
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { makeOpenaiCompat } = require("../electron/backend/localgw/standard/openai-compat.cjs");
const transport = require("../electron/backend/proxy/transport-context.cjs");
let mode = "stream";
let received;
const upstream = http.createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  received = { url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "upstream-model" }] }));
    return;
  }
  if (mode === "wait") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    return;
  }
  if (mode === "json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "whole" }, finish_reason: "stop" }], usage: { input_tokens: 4, output_tokens: 2 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (mode === "rate") {
    res.end('data: {"error":{"message":"rate limit quota exceeded","code":429}}\n\n');
    return;
  }
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  res.write(frame({ choices: [{ delta: { role: "assistant", content: "你" } }] }));
  res.write(frame({ choices: [{ delta: { content: "好", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
  res.end(frame({ usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } } }) + "data: [DONE]\n\n");
});

async function main() {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const adapter = makeOpenaiCompat({
    id: "custom", baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    models: [{ model: "visible", upstream: "upstream-model", aliases: ["alias"] }],
    extraHeaders: { "x-custom": "yes" }, extraBody: { temperature: 0.25 }
  });
  const events = [];
  const invoke = () => adapter.chat({ secrets: { token: "test-key" }, model: "custom/alias", body: { messages: [{ role: "user", content: "test" }], extraBody: { parallel_tool_calls: false } }, emit: event => events.push(event) });
  try {
    await invoke();
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.headers.authorization, "Bearer test-key");
    assert.equal(received.headers["x-custom"], "yes");
    assert.equal(received.body.model, "upstream-model");
    assert.equal(received.body.temperature, 0.25);
    assert.equal(received.body.parallel_tool_calls, false);
    assert.equal(received.body.extraBody, undefined);
    assert.equal(events.filter(e => e.type === "delta").map(e => e.delta.content || "").join(""), "你好");
    assert.equal(events.find(e => e.delta?.tool_calls)?.delta.tool_calls[0].function.name, "lookup");
    assert.equal(events.find(e => e.type === "usage").usage.prompt_tokens_details.cached_tokens, 1);

    mode = "json";
    events.length = 0;
    await invoke();
    assert.equal(events.find(e => e.type === "delta").delta.content, "whole");
    assert.equal(events.find(e => e.type === "usage").usage.total_tokens, 6);
    mode = "rate";
    events.length = 0;
    const result = await invoke();
    assert.equal(events.find(e => e.type === "error").status, 429);
    assert.equal(result.planLimit, false, "rate errors must not become billing failures");

    const models = await adapter.fetchModels(null, { token: "test-key" });
    assert.deepEqual(models.models, ["upstream-model"]);
    mode = "wait";
    const cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(), 100);
    try { await assert.rejects(transport.run(cancel.signal, invoke)); }
    finally { clearTimeout(timer); }
    console.log("PASS standard supplier isolation: streaming, tools, aliases, headers, JSON, usage, rate errors, models, cancellation");
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    Module._load = originalLoad;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
