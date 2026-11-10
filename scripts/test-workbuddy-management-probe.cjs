"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-wb-management-probe-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
process.env.LOCALAPPDATA = path.join(temporary, "local");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });
const network = require("../electron/backend/network/http.cjs");
const originalNetwork = { ...network };
let fixture;
let calls;
let timerStops;
network.fetchStream = async (url, options) => {
  calls.push({ url, options: { ...options, headers: { ...options.headers } } });
  const error = fixture.errors && fixture.errors[calls.length - 1];
  if (error) throw error;
  return { resp: {}, cancelTimer: () => { timerStops++; } };
};
network.pumpSse = async (_response, onEvent) => {
  for (const raw of fixture.events || []) onEvent("message", typeof raw === "string" ? raw : JSON.stringify(raw));
  if (fixture.readError) throw fixture.readError;
};
const management = require("../electron/backend/proxy/management-adapters.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const rulesGet = rules.get;
let templates = {};
rules.get = name => name === "wb_template_map.json" ? templates : rulesGet(name);
const samples = [
  { name: "normal", events: [{ choices: [{ delta: { content: "private-model-output" }, finish_reason: "stop" }], usage: { total_tokens: 3 } }, "[DONE]"] },
  { name: "blocked-http-code", errors: [{ status: 403, body: '{"code":11140}', message: "http blocked" }] },
  { name: "blocked-http-text", errors: [{ status: 403, message: "request illegal" }] },
  { name: "ordinary-http-error", errors: [{ status: 403, message: "forbidden" }] },
  { name: "network-timeout", errors: [new Error("timeout")] },
  { name: "stream-blocked", events: [{ error: { code: "11140", message: "safety review" } }] },
  { name: "stream-text-blocked", events: [{ error: { message: "request illegal" } }] },
  { name: "stream-other-error", events: [{ error: { code: 6004, message: "rate limit" } }] },
  { name: "last-stream-error", events: [{ error: { code: 11140, message: "blocked first" } }, { error: { code: 6004, message: "last" } }] },
  { name: "malformed-events", events: ["not-json", "null", "[DONE]"] },
  { name: "read-failure", events: [{ error: { code: 11140, message: "blocked" } }], readError: new Error("read broke") },
  { name: "404-fallback", errors: [{ status: 404, message: "missing" }], events: ["[DONE]"] },
  { name: "405-fallback", errors: [{ status: 405, message: "method" }], events: [{ error: { code: 11140, message: "blocked fallback" } }] },
  { name: "no-third-candidate", errors: [{ status: 404 }, { status: 405 }] },
];

function normalize(requests) {
  return requests.map(({ url, options }) => {
    const headers = { ...options.headers };
    const request = headers["x-conversation-request-id"], message = headers["x-conversation-message-id"];
    assert.match(request, /^[a-f0-9]{32}$/);
    assert.match(message, /^[a-f0-9]{32}$/);
    for (const key of ["x-root-request-id", "x-trace-id", "x-b3-traceid"]) assert.equal(headers[key], request);
    assert.equal(headers["x-request-id"], message);
    assert.equal(headers["x-b3-spanid"], message.slice(0, 16));
    assert.equal(headers["x-b3-sampled"], "1");
    assert.equal(headers["x-conversation-id"], undefined);
    for (const key of ["x-conversation-request-id", "x-root-request-id", "x-trace-id", "x-b3-traceid"]) headers[key] = "REQUEST";
    for (const key of ["x-conversation-message-id", "x-request-id"]) headers[key] = "MESSAGE";
    headers["x-b3-spanid"] = "SPAN";
    return { url, ...options, headers, body: JSON.parse(options.body) };
  });
}

async function run(adapter, selected, account) {
  fixture = selected; calls = []; timerStops = 0;
  const cfg = adapter.cfg;
  adapter.cfg = () => ({ ...cfg.call(adapter), chatUrl: "http://management.test/primary", consoleChatUrl: "http://management.test/fallback" });
  try {
    const result = await adapter.probeChat(account, { token: "fixed-probe-token" });
    assert.ok(!JSON.stringify(result).includes("private-model-output"), "probe cannot expose model output");
    if (calls.length && !(selected.errors && selected.errors.length >= calls.length)) assert.ok(timerStops >= 1);
    return { result, requests: normalize(calls) };
  } finally { adapter.cfg = cfg; }
}

async function main() {
  let comparisons = 0;
  try {
    for (const template of [{}, { CodeBuddy: "ManagedClient", hi: "hello" }, { CodeBuddy: "x-anthropic-billing-header: value; cc_probe=1; Client" }]) {
      templates = template;
      for (const channel of ["workbuddy", "workbuddy_ai"]) {
        const account = { id: "fixed", channel, uid: "existing-uid", enterpriseId: "existing-enterprise", domain: "existing-domain", deviceToken: "existing-device" };
        for (const sample of samples) {
          const current = await run(management.get(channel), sample, account);
          const result = current.result;
          if (["blocked-http-code", "blocked-http-text", "stream-blocked", "stream-text-blocked", "405-fallback"].includes(sample.name)) {
            assert.equal(result.blocked, true, `${channel}/${sample.name}`);
          } else if (["normal", "404-fallback", "malformed-events", "stream-other-error", "last-stream-error"].includes(sample.name)) {
            assert.deepEqual(result, { ok: true }, `${channel}/${sample.name}`);
          } else {
            assert.equal(result.inconclusive, true, `${channel}/${sample.name}`);
          }
          if (channel === "workbuddy_ai") {
            const cnAccount = { ...account, channel: "workbuddy" };
            const cn = await run(management.get("workbuddy"), sample, cnAccount);
            assert.deepEqual(current.result, cn.result, `${sample.name} management result parity`);
          }
          comparisons++;
        }
      }
    }

    // Exercise the unmodified switch function against the new probe. All
    // process access is replaced by a sentinel; all filesystem paths are temp.
    templates = {};
    let processTouches = 0;
    let account;
    const filename = path.resolve(__dirname, "../electron/backend/proxy/ideswitch.cjs");
    const localRequire = Module.createRequire(filename);
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = module.paths;
    isolated.require = request => {
      if (request === "./management-adapters.cjs") return management;
      if (request === "./store.cjs") return { getAccount: () => account, accountSecrets: () => ({ token: "probe-token" }) };
      if (request === "./discovery.cjs") return { wbAuthDir: () => path.join(temporary, "auth") };
      if (request === "./wbClient.cjs") return { isWorkbuddyRunning: () => { processTouches++; throw new Error("reached-original-writer"); } };
      return localRequire(request);
    };
    isolated._compile(fs.readFileSync(filename, "utf8"), filename);
    for (const channel of ["workbuddy", "workbuddy_ai"]) {
      account = { id: "fixed", channel, uid: "existing" };
      for (const sample of [samples[1], samples[5]]) {
        const touchesBefore = processTouches;
        fixture = sample; calls = []; timerStops = 0;
        const adapter = management.get(channel), cfg = adapter.cfg;
        adapter.cfg = () => ({ ...cfg.call(adapter), chatUrl: "http://management.test/primary", consoleChatUrl: "" });
        try {
          const result = await isolated.exports.switchIdeAccount(account.id, { confirmAck: true });
          assert.equal(result.ok, false);
          assert.match(result.message, /11140/);
          assert.equal(processTouches, touchesBefore, "blocked probe must precede process operations");
          assert.equal(fs.existsSync(path.join(temporary, "auth")), false, "blocked switch must not create auth files");
        } finally { adapter.cfg = cfg; }
      }
      for (const sample of [samples[0], samples[4], samples[3]]) {
        fixture = sample; calls = []; timerStops = 0;
        await assert.rejects(isolated.exports.switchIdeAccount(account.id, { confirmAck: true }), /reached-original-writer/, "normal/inconclusive must retain original switch continuation");
      }
    }
    assert.equal(processTouches, 6);

    // Real loopback: management probe can execute without the old adapter.
    Object.assign(network, originalNetwork);
    const probePath = require.resolve("../electron/backend/proxy/workbuddy-switch-probe.cjs");
    delete require.cache[probePath];
    const { createSwitchProbe } = require(probePath);
    let responseMode = "blocked";
    const server = http.createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      assert.equal(body.model, "default-model");
      assert.equal(body.max_tokens, 1);
      assert.equal(body.messages[0].role, "system");
      if (responseMode === "blocked") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end('{"code":11140,"msg":"request illegal"}');
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"must-not-escape"}}]}\n\ndata: [DONE]\n\n');
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const probe = createSwitchProbe({ getConfig: () => ({ chatUrl: `http://127.0.0.1:${server.address().port}` }), readHeaders: () => ({ authorization: "Bearer test" }) });
      assert.equal((await probe({}, {})).blocked, true);
      responseMode = "normal";
      assert.deepEqual(await probe({}, {}, { messages: ["injected"], model: "injected" }), { ok: true });
    } finally { await new Promise(resolve => server.close(resolve)); }
    console.log(`PASS ${comparisons} original/new probe comparisons, CN/international blocked-before-write and inconclusive continuation, real loopback without output exposure`);
  } finally {
    rules.get = rulesGet;
    Object.assign(network, originalNetwork);
    require("../electron/backend/proxy/store.cjs").close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
