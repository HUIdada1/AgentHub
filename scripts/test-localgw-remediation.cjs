"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-localgw-remediation-"));
const config = require("../electron/backend/config.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const localConfig = require("../electron/backend/localgw/config.cjs");
const keys = require("../electron/backend/localgw/keys-store.cjs");
const gateway = require("../electron/backend/localgw/server.cjs");
const transport = require("../electron/backend/proxy/transport-context.cjs");
const netproxy = require("../electron/backend/proxy/netproxy.cjs");
const { plan } = require("../electron/backend/proxy/account-plan.cjs");
const { Gate, BodyQueue } = require("../electron/backend/localgw/admission.cjs");
const { applyFailure } = require("../electron/backend/localgw/forwarder.cjs");
const degrade = require("../electron/backend/localgw/degrade.cjs");
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.close(r); server.closeAllConnections(); });
let mode = "ok", calls = [], held = [], cancelled = false;
const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  calls.push({ token: req.headers.authorization, body, inFlight: store.listAccounts().reduce((sum, a) => sum + pool.inFlightCount(a.id), 0) });
  const n = calls.length;
  if (mode === "hang") { res.on("close", () => { cancelled = true; }); held.push(res); return; }
  if (mode === "rate" && n === 1) { res.writeHead(429, { "Retry-After": "2" }); res.end("rate limited"); return; }
  // 内容策略拦截：只有 system 里带 CUSTOM_SYS 的请求会被拦（用来验证「换成中性提示词即通过」）
  const sysText = (body.messages || []).filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("\n");
  if (mode === "content-block" && sysText.includes("CUSTOM_SYS")) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "content_policy_violation: your request was blocked by review" } }));
    return;
  }
  if (mode === "fail-a" && req.headers.authorization.includes("fixture_a")) { res.writeHead(503); res.end("unavailable"); return; }
  if (mode === "delayed") await pause(5200);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (mode === "empty-error" && n === 1) {
    frame({ choices: [{ delta: { role: "assistant", content: "" } }] });
    frame({ error: { message: "temporary", code: 502 } }); res.end(); return;
  }
  if ((mode === "partial" || mode === "partial-nonstream") && n === 1) {
    frame({ choices: [{ delta: { content: "PARTIAL" } }] });
    frame({ error: { message: "temporary", code: 502 } }); res.end(); return;
  }
  if (mode === "tools") {
    frame({ choices: [{ delta: { content: "text", tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "one", arguments: "{}" } },
      { index: 1, id: "call_2", type: "function", function: { name: "two", arguments: "{}" } },
    ] } }] });
    frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else {
    frame({ choices: [{ delta: { content: "SUCCESS" } }] });
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  frame({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  res.end("data: [DONE]\n\n");
});

async function main() {
  check("过期无限包不产生可用无限额度", () => {
    const d = pool.deriveAccountCredits([{ remaining: -1, expiresAt: 1 }, { remaining: 5, expiresAt: 0 }]);
    assert.equal(d.credits, 5);
    assert.equal(pool.deriveAccountCredits([{ remaining: -1, expiresAt: 1 }]).allExpired, true);
  });
  check("最优分类、无限排序、未知不当永久", () => {
    const acc = (id, credits, kind, expiry = 0) => ({ id, status: "online", hasToken: true, credits, creditsAt: 1, expiresAt: expiry, meta: { gateway: { billingKind: kind } } });
    const rows = [acc("unknown", 10000, "unknown"), acc("permanent", -1, "permanent"), acc("expire-low", 2, "paid", Date.now() + 10000), acc("expire-high", 9, "paid", Date.now() + 20000), acc("free", 1, "free")];
    assert.deepEqual(plan(rows).map((r) => r.account.id), ["free", "expire-high", "expire-low", "permanent", "unknown"]);
    assert.equal(plan(rows, { strategy: "credit_first" })[0].account.id, "permanent");
    assert.equal(plan(rows, { maxInFlight: 1, inFlightCount: () => 1 }).some((r) => r.eligible), false);
  });
  const gate = new Gate(1, 1), controller = new AbortController();
  const release = await gate.acquire();
  const pending = gate.acquire(1000, controller.signal);
  await assert.rejects(gate.acquire(), /QUEUE_FULL/);
  controller.abort(); await assert.rejects(pending); release();
  check("有界队列取消释放", () => { assert.equal(gate.inFlight, 0); assert.equal(gate.queue.length, 0); });
  const bodies = new BodyQueue();
  const r1 = await bodies.acquire("identity-a:body", 1000);
  const r2 = await bodies.acquire("identity-b:body", 1000);
  let waiting = false;
  const pendingBody = bodies.acquire("identity-a:body", 1000).then((r) => { waiting = true; return r; });
  await pause(10); assert.equal(waiting, false); r1(); (await pendingBody)(); r2();
  check("同体按身份隔离且结束清理", () => assert.equal(bodies.entries.size, 0));

  const port = await listen(upstream);
  for (const id of ["fixture_a", "fixture_b"]) {
    store.saveProvider({ id, kind: "openai_compat", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ model: "wire", upstream: "wire", rate: 0 }] });
    for (let n = 0; n < 2; n++) store.addAccount({ channel: id, uid: `${id}-${n}`, name: `${id}-${n}`, token: `${id}-${n}`, source: "paste" });
  }
  const c = config.loadConfig();
  c.proxy.modelReverseAliases = { shared: { fixture_a: "wire", fixture_b: "wire" } };
  c.localgw = localConfig.normalize({ ...c.localgw, port: 18527, portCandidates: [18527, 18528], concurrency: 2, requestTimeoutMs: 10000, injectPrompt: false,
    routing: { strategy: "smart", preferChannels: ["fixture_a"], failover: true, maxRetriesPerRequest: 4 },
    outbound: { defaults: { mode: "passthrough", jitter: false } } });
  config.saveConfig(c);
  const started = await gateway.start(); assert.equal(started.ok, true);
  const fullKey = keys.create({ scopes: ["*"], concurrency: 8, ratePerMin: 1000 }).rawKey;
  const bKey = keys.create({ scopes: ["fixture_b"], concurrency: 8, ratePerMin: 1000 }).rawKey;
  const url = `http://127.0.0.1:${started.port}`;
  const reset = () => {
    calls = [];
    for (const id of ["fixture_a", "fixture_b"]) require("../electron/backend/localgw/routing.cjs").markSucceeded(id);
    for (const a of store.listAccounts()) pool.updateStatus(a.id, { status: "online", coolUntil: 0, coolReason: "" });
  };
  const post = async (options = {}, key = fullKey, endpoint = "/v1/chat/completions") => {
    const response = await fetch(url + endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "shared", messages: [{ role: "user", content: "hello" }], ...options }) });
    return { status: response.status, text: await response.text() };
  };
  reset(); mode = "ok";
  const probe = await require("../electron/backend/localgw/routing.cjs").testChannel("fixture_a");
  check("真实对话探测占用并归还账号租约", () => {
    assert.equal(probe.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].inFlight, 1);
    for (const a of store.listAccounts()) assert.equal(pool.inFlightCount(a.id), 0);
  });
  reset();
  const scoped = await post({}, bKey);
  check("实际转发渠道保持 key scopes", () => { assert.equal(scoped.status, 200); assert.equal(calls.length, 1); assert.match(calls[0].token, /fixture_b/); });
  check("成功落账与尝试记录", () => { const rows = require("../electron/backend/localgw/oplog.cjs").list().rows; assert.equal(rows[0].promptTokens, 7); assert.equal(rows[0].attempts.length, 1); });
  reset(); mode = "rate";
  const retry = await post({ stream: true });
  check("同渠换号且 Retry-After 生效", () => {
    assert.equal(retry.status, 200); assert.equal(calls.length, 2); assert.match(calls[0].token, /fixture_a/); assert.match(calls[1].token, /fixture_a/);
    assert.notEqual(calls[0].token, calls[1].token); assert.match(retry.text, /SUCCESS/); assert.doesNotMatch(retry.text, /error/);
    assert.ok(store.listAccounts().some((a) => a.coolUntil > Date.now() + 1000));
  });
  reset(); mode = "fail-a";
  const crossChannel = await post();
  check("同渠账号耗尽后换渠并隔离异常渠道", () => {
    assert.equal(crossChannel.status, 200); assert.equal(calls.length, 3);
    assert.match(calls[2].token, /fixture_b/);
    assert.equal(require("../electron/backend/localgw/routing.cjs").isCooling("fixture_a"), true);
  });
  reset(); mode = "empty-error";
  const emptyRetry = await post({ stream: true });
  check("空帧失败不污染后续成功流", () => { assert.equal(calls.length, 2); assert.match(emptyRetry.text, /SUCCESS/); assert.doesNotMatch(emptyRetry.text, /error/); });
  reset(); mode = "partial";
  const partial = await post({ stream: true });
  check("流式已提交内容后禁止重放", () => { assert.equal(calls.length, 1); assert.match(partial.text, /PARTIAL/); assert.match(partial.text, /error/); assert.doesNotMatch(partial.text, /SUCCESS/); });
  reset(); mode = "partial-nonstream";
  const replay = await post();
  check("非流式失败内容不混入成功正文", () => { assert.equal(calls.length, 2); assert.equal(JSON.parse(replay.text).choices[0].message.content, "SUCCESS"); });
  reset(); mode = "tools";
  const tools = await post({ max_tokens: 16 }, fullKey, "/v1/messages");
  check("Anthropic 非流式保留多工具及正文", () => { const body = JSON.parse(tools.text); assert.equal(body.content.filter((b) => b.type === "tool_use").length, 2); assert.equal(body.content[0].type, "text"); assert.equal(body.stop_reason, "tool_use"); });
  reset(); mode = "ok";
  const anthro = await post({ max_tokens: 16, stream: true }, fullKey, "/v1/messages");
  check("Anthropic 流只有一个开始和结束", () => { assert.equal((anthro.text.match(/event: message_start/g) || []).length, 1); assert.equal((anthro.text.match(/event: message_stop/g) || []).length, 1); });
  reset(); mode = "ok";
  const responses = await post({ input: "hello", stream: true }, fullKey, "/v1/responses");
  check("Responses 兼容入口输出唯一 completed", () => { assert.equal(responses.status, 200); assert.equal((responses.text.match(/event: response.completed/g) || []).length, 1); assert.match(responses.text, /SUCCESS/); });
  const unsupported = await post({ input: "hello", previous_response_id: "unavailable" }, fullKey, "/v1/responses");
  check("Responses 不伪造会话历史", () => assert.equal(unsupported.status, 400));
  const cfg = config.loadConfig(); cfg.proxy.disabledModels = ["shared"]; config.saveConfig(cfg);
  reset();
  const disabled = await post();
  check("关闭模型禁止转发", () => { assert.equal(disabled.status, 404); assert.equal(calls.length, 0); });
  cfg.proxy.disabledModels = []; config.saveConfig(cfg);
  const models = await fetch(url + "/v1/models", { headers: { authorization: `Bearer ${fullKey}` } }).then((r) => r.json());
  check("动态目录含统一映射名且不重复", () => assert.equal(models.data.filter((m) => m.id === "shared").length, 1));
  const modelRows = require("../electron/backend/localgw/models.cjs").list();
  check("绑定倍率保留零值及事实来源", () => { const row = modelRows.find((m) => m.id === "shared" && m.channel === "fixture_a"); assert.equal(row.rate, 0); assert.equal(row.rateSource, "provider-config"); });
  localConfig.patch({ models: { aliases: { alias: "shared" }, disabledAliases: ["alias"] } });
  check("停用别名保留配置但不能解析", () => { assert.equal(localConfig.get().models.aliases.alias, "shared"); assert.equal(require("../electron/backend/localgw/models.cjs").bindings("alias").length, 0); });
  localConfig.patch({ models: { disabledAliases: [], custom: { scoped: { channel: "fixture_a", real_model: "wire" } } } });
  reset();
  const forbidden = await post({ model: "scoped" }, bKey);
  check("显式模型绑定不能覆盖 scopes 过滤", () => { assert.equal(forbidden.status, 403); assert.equal(calls.length, 0); });
  const policy = require("../electron/backend/localgw/account-policy.cjs");
  const ids = store.listAccounts("fixture_a").map((a) => a.id);
  check("人工队列拒绝不完整或重复列表", () => { assert.equal(policy.reorder("fixture_a", [ids[0], ids[0]]).ok, false); assert.equal(policy.reorder("fixture_a", [ids[0]]).ok, false); });
  policy.reorder("fixture_a", ids.slice().reverse());
  check("人工排序和实际选号共用计划", () => { assert.equal(pool.pickAccount("fixture_a").id, ids[1]); assert.equal(store.listAgents().find((a) => a.id === "fixture_a").poolStrategy, "manual"); });
  store.setPoolStrategy("fixture_a", "optimal");
  const first = store.listAccounts("fixture_a")[0];
  applyFailure(first.id, "wire", { kind: "slow" }, "slow");
  check("慢响应不罚号", () => assert.equal(store.getAccount(first.id).status, "online"));
  applyFailure(first.id, "wire", { kind: "account_blocked" }, "blocked");
  check("封禁隔离到账号", () => assert.equal(store.getAccount(first.id).status, "cooling"));
  reset(); mode = "hang"; cancelled = false;
  const cancel = new AbortController();
  const hanging = fetch(url + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${fullKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "shared", messages: [{ role: "user", content: "cancel" }] }), signal: cancel.signal });
  while (!calls.length) await pause(5);
  cancel.abort(); await assert.rejects(hanging);
  for (let n = 0; n < 100 && !cancelled; n++) await pause(10);
  check("客户端取消关闭真实 HTTP 连接并归还租约", () => { assert.equal(cancelled, true); for (const a of store.listAccounts()) assert.equal(pool.inFlightCount(a.id), 0); });
  reset(); mode = "hang"; cancelled = false;
  const manualCancel = post();
  while (!calls.length) await pause(5);
  const active = require("../electron/backend/localgw/requests.cjs");
  const current = active.list()[0];
  assert.equal(current.phase, "等待上游");
  assert.equal(active.cancel(current.id).ok, true);
  const cancelledResponse = await manualCancel;
  check("人工取消真实请求并清理当前列表", () => { assert.equal(cancelledResponse.status, 499); assert.equal(active.list().length, 0); });
  reset(); mode = "delayed";
  localConfig.patch({ requestTimeoutMs: 5000, streamTotalTimeoutMs: 0 });
  const longStream = await post({ stream: true });
  check("流式不沿用非流式总时限", () => { assert.equal(longStream.status, 200); assert.match(longStream.text, /SUCCESS/); assert.doesNotMatch(longStream.text, /error/); });
  reset(); mode = "hang";
  localConfig.patch({ streamTotalTimeoutMs: 50 });
  const expiredStream = await post({ stream: true });
  check("显式流式总时限返回 504 且不罚账号", () => { assert.equal(expiredStream.status, 504); for (const a of store.listAccounts()) assert.equal(a.status, "online"); });
  localConfig.patch({ streamTotalTimeoutMs: 0 });
  const packageId = store.listAccounts("fixture_a")[0].id;
  store.setCreditPackages(packageId, "fixture_a", [{ code: "expired", remaining: -1, expiresAt: 1 }, { code: "valid", remaining: 9, expiresAt: 0 }]);
  check("调度按包的当前时间态读取，过期无限包不遮蔽剩余有效包", () => assert.equal(pool.accountPlan("fixture_a").find((r) => r.account.id === packageId).account.credits, 9));
  // ===== 内容拦截自动降级（v1.96.0 重写执行链时漏接，本版补回）=====
  degrade.clear(); reset(); mode = "content-block";
  const sysOf = (c) => (c.body.messages || []).filter((m) => m && m.role === "system").map((m) => String(m.content || "")).join("|");
  const custom = [{ role: "system", content: "CUSTOM_SYS: 请始终用中文回答" }, { role: "user", content: "hello" }];
  const eased = await post({ messages: custom });
  check("内容拦截：同账号换中性提示词原地重发一次即成功", () => {
    assert.equal(eased.status, 200);
    assert.equal(calls.length, 2);
    assert.match(sysOf(calls[0]), /CUSTOM_SYS/);
    assert.equal(sysOf(calls[1]), "You are a helpful assistant.");
    assert.equal(calls[0].token, calls[1].token, "必须同账号重发，不换号");
    assert.equal(degrade.active(), true);
    assert.ok(store.listAccounts().every((a) => a.status === "online" && !(a.coolUntil > Date.now())), "内容问题不罚号");
  });
  reset(); mode = "ok";
  const easedNext = await post({ messages: custom });
  check("降级期内新请求直接带中性提示词出门（不再先撞一次）", () => {
    assert.equal(easedNext.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(sysOf(calls[0]), "You are a helpful assistant.");
  });
  degrade.clear(); mode = "ok";
  for (const r of held) r.destroy(); held = [];
  const proxy = netproxy.save({ name: "local-unavailable", host: "127.0.0.1", port: 1, protocol: "http" }).item;
  netproxy.saveSettings({ mode: "fixed", fixedId: proxy.id }); netproxy.toggle({ id: proxy.id, enabled: false });
  await assert.rejects(transport.run(new AbortController().signal, () => netproxy.fetchThrough(`http://127.0.0.1:${port}/v1`)), /代理不可用/);
  check("代理不可用不静默直连", () => assert.equal(calls.length, 1));
  netproxy.saveSettings({ mode: "off" });
  console.log(`${passed} remediation checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  for (const r of held) r.destroy();
  await gateway.stop();
  if (upstream.listening) await close(upstream);
  netproxy.closeAll(); store.close();
});
