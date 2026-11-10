"use strict";
const assert = require("node:assert/strict");
const { PassThrough, Writable } = require("node:stream");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { RpcPeer } = require("../electron/backend/extensions/rpc.cjs");

function pair(options = {}) {
  const toPlugin = new PassThrough();
  const toHost = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:", ...options });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:", ...options });
  return { host, plugin, toPlugin, toHost, close() { host.close(); plugin.close(); toPlugin.destroy(); toHost.destroy(); } };
}

async function main() {
  // Control frames are serialized ahead of queued data, without interrupting
  // the frame already being written. Data cannot consume the control reserve.
  const stalledInput = new PassThrough();
  const controlledOutput = new EventEmitter();
  const writes = [];
  const callbacks = [];
  controlledOutput.write = (buffer, callback) => {
    writes.push(JSON.parse(buffer.toString("utf8")));
    callbacks.push(callback);
    return false;
  };
  const prioritised = new RpcPeer({ input: stalledInput, output: controlledOutput, prefix: "h:", remotePrefix: "p:", maxQueueBytes: 1024, controlReserveBytes: 256 });
  try {
    const first = prioritised.notify("data1", { value: "x".repeat(160) }, { lane: "data" });
    const second = prioritised.notify("data2", { value: "x".repeat(160) }, { lane: "data" });
    const control = prioritised.notify("credit", { bytes: 10 });
    callbacks.shift()(); controlledOutput.emit("drain");
    assert.deepEqual(writes.map(frame => frame.method), ["data1", "credit"]);
    callbacks.shift()(); controlledOutput.emit("drain");
    callbacks.shift()(); controlledOutput.emit("drain");
    await Promise.all([first, second, control]);
    assert.deepEqual(writes.map(frame => frame.method), ["data1", "credit", "data2"]);
    assert.equal(prioritised.dataQueuedBytes, 0);
    assert.equal(prioritised.queuedBytes, 0);
  } finally { prioritised.close(); stalledInput.destroy(); }

  let peers = pair();
  try {
    let notifications = 0;
    peers.host.handleNotification("credited-event", () => { notifications++; });
    peers.toHost.write(Array.from({ length: 500 }, () => '{"jsonrpc":"2.0","method":"credited-event","params":{}}\n').join(""));
    assert.equal(notifications, 500);
    assert.equal(peers.host.closed, false, "bounded synchronous event enqueue must not consume async callback slots");
    const wire = [];
    peers.toHost.on("data", data => wire.push(...data.toString("utf8").trim().split("\n").map(JSON.parse)));
    peers.plugin.handle("register-stream", (_params, ctx) => {
      ctx.afterReply(() => peers.plugin.notify("registered-event", {}));
      return { accepted: true };
    });
    await peers.host.call("register-stream", {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wire[0].result.accepted, true);
    assert.equal(wire[1].method, "registered-event");
    peers.host.handle("credentials", ({ grant }) => ({ token: `scoped:${grant}` }));
    peers.plugin.handle("invoke", async ({ grant }) => {
      const credentials = await peers.plugin.call("credentials", { grant });
      return { content: credentials.token };
    });
    assert.deepEqual(await peers.host.call("invoke", { grant: "one" }), { content: "scoped:one" });
    peers.plugin.handle("null", () => null);
    assert.equal(await peers.host.call("null", {}), null);
    await assert.rejects(peers.host.call("unknown", {}), error => error.code === -32601);
    peers.plugin.handle("failure", () => { throw Object.assign(new Error("controlled failure"), { code: -32099 }); });
    await assert.rejects(peers.host.call("failure", {}), error => error.code === -32099);

    let aborted;
    const cancelled = new Promise(resolve => { aborted = resolve; });
    peers.plugin.handle("wait", (_, { signal }) => new Promise(resolve => signal.addEventListener("abort", () => { aborted(); resolve(null); }, { once: true })));
    await assert.rejects(peers.host.call("wait", {}, { timeoutMs: 30 }), error => error.code === -32003);
    await cancelled;
    assert.equal(peers.host.pending.size, 0);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(peers.host.call("wait", {}, { signal: ac.signal }));
    assert.equal(peers.host.closed, false);
    console.log("PASS RPC nested callbacks, null result, remote error, timeout and cancellation");
  } finally { peers.close(); }

  peers = pair({ maxConcurrent: 2 });
  try {
    peers.host.maxConcurrent = 8;
    const release = [];
    peers.plugin.handle("blocked", () => new Promise(resolve => release.push(resolve)));
    const blocked = [peers.host.call("blocked", {}), peers.host.call("blocked", {})];
    while (release.length < 2) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(peers.host.call("blocked", {}), error => error.code === -32002 && /handler limit/.test(error.message));
    for (const resolve of release) resolve(null);
    await Promise.all(blocked);
    peers.host.handle("credential", () => ({ value: "scoped" }));
    peers.plugin.handle("exchange", () => peers.plugin.call("credential", {}));
    for (let i = 0; i < 200; i++) assert.deepEqual(await peers.host.call("exchange", {}), { value: "scoped" });
    assert.equal(peers.plugin.running.size, 0, "completed replies cannot accumulate business concurrency slots");
    console.log("PASS RPC true handler saturation and 200 fast sequential nested exchanges without false saturation");
  } finally { peers.close(); }

  peers = pair({ maxFrameBytes: 128 });
  try {
    peers.plugin.handle("echo", value => value);
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => peers.host.call("echo", { n })));
    assert.deepEqual(results.map(r => r.n), [0, 1, 2, 3, 4, 5, 6, 7]);
    let unicodeResult;
    peers.host.handle("unicode", value => { unicodeResult = value; });
    const unicode = Buffer.from('{"jsonrpc":"2.0","method":"unicode","params":"你好😀"}\n');
    for (const byte of unicode) peers.toHost.write(Buffer.from([byte]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unicodeResult, "你好😀");
    // A coalesced read may be larger than maxFrameBytes; only individual lines are limited.
    const lines = Array.from({ length: 6 }, () => '{"jsonrpc":"2.0","method":"unused"}\n').join("");
    peers.toHost.write(lines);
    assert.equal(peers.host.closed, false);
    peers.toHost.write(Buffer.from('{"jsonrpc":"2.0","method":"unused","params":"你"}\n').subarray(0, 45));
    // End in a partial frame must fail the connection, never silently discard data.
    peers.toHost.end();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(peers.host.closed, true);
    console.log("PASS RPC coalesced framing and partial EOF");
  } finally { peers.close(); }

  for (const payload of [
    Buffer.from('{"jsonrpc":"2.0","id":"h:1","result":null,"error":{"code":1,"message":"x"}}\n'),
    Buffer.from([0xff, 10]),
    Buffer.alloc(130, 65)
  ]) {
    peers = pair({ maxFrameBytes: 128 });
    try { peers.toHost.write(payload); assert.equal(peers.host.closed, true); }
    finally { peers.close(); }
  }

  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { /* Deliberately stalled writer. */ } });
  const host = new RpcPeer({ input, output, prefix: "h:", remotePrefix: "p:", maxFrameBytes: 128, maxQueueBytes: 128 });
  try {
    const first = assert.rejects(host.notify("one", { text: "x".repeat(20) }));
    const second = assert.rejects(host.notify("two", { text: "x".repeat(20) }));
    await Promise.all([first, second]);
    assert.equal(host.closed, true);
    assert.equal(host.queuedBytes, 0);
    console.log("PASS RPC invalid responses, invalid UTF-8, oversized frame and bounded blocked writer cleanup");
  } finally { host.close(); input.destroy(); output.destroy(); }

  // Exercise real child stdio and a nested callback, not only in-memory streams.
  const rpcPath = require.resolve("../electron/backend/extensions/rpc.cjs");
  const childSource = `
    const { RpcPeer } = require(process.argv[1]);
    const peer = new RpcPeer({input:process.stdin,output:process.stdout,prefix:'p:',remotePrefix:'h:'});
    peer.on('closed', () => process.exit(0));
    peer.handle('invoke', async ({grant}) => {
      const credentials = await peer.call('credentials', {grant});
      return {model:'mock', tokenLength:credentials.token.length};
    });
  `;
  const child = spawn(process.execPath, ["-e", childSource, rpcPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const processPeer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:" });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    processPeer.handle("credentials", ({ grant }) => { assert.equal(grant, "authorized"); return { token: "scoped-value" }; });
    assert.deepEqual(await processPeer.call("invoke", { grant: "authorized" }), { model: "mock", tokenLength: 12 });
    child.stdin.end();
    await exited;
    console.log("PASS real child stdio round-trip with credential callback");
  } finally { processPeer.close(); child.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
