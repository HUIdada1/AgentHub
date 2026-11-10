"use strict";
const assert = require("node:assert/strict");
const { createNetwork } = require("../electron/backend/extensions/sdk/network.cjs");

async function main() {
  const calls = [];
  const controller = new AbortController();
  const pool = {
    invocationId: "invocation-1",
    async open(params) { calls.push(["open", params]); return { requestId: "socket-1", kind: "websocket", status: 101, headers: {}, done: false }; },
    async read() { return { type: "close" }; },
    async send(requestId, chunk) { calls.push(["send", requestId, chunk]); return { sent: true }; },
    async close(requestId) { calls.push(["close", requestId]); return { closed: true }; },
  };
  const network = createNetwork(pool, controller.signal);
  const socket = await network.webSocket("wss://provider.example/socket");
  await socket.send("hello");
  assert.deepEqual(calls[0], ["open", { kind: "websocket", url: "wss://provider.example/socket", method: "GET", headers: {}, invocationId: "invocation-1" }]);
  assert.deepEqual(calls[1], ["send", "socket-1", Buffer.from("hello").toString("base64")]);

  let closeCount = 0;
  const httpNetwork = createNetwork({ invocationId: "invocation-2", async open(params) {
    assert.equal(params.invocationId, "invocation-2");
    return { requestId: "http-1", status: 200, headers: {}, done: false };
  }, async read() { return { done: false, chunk: Buffer.from("body").toString("base64") }; },
  async close() { closeCount++; } }, controller.signal);
  const response = await httpNetwork.fetch("https://provider.example/chat");
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "body");
  await reader.cancel();
  assert.equal(closeCount, 1, "cancelling an HTTP response closes the host request");
  console.log("PASS provider SDK network capability: invocation binding, WebSocket send, streaming response cancellation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
