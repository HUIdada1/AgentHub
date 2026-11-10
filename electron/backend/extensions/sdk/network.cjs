"use strict";
const { assert } = require("../provider-protocol.cjs");
const { ReadableStream } = require("node:stream/web");
const ResponseCtor = globalThis.Response || class ResponseFallback {
  constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.ok = this.status >= 200 && this.status < 300; this.headers = new Map(Object.entries(init.headers || {})); }
};

function responseFrom(pool, opened, signal) {
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await pool.close(opened.requestId); } };
  const stream = opened.done ? null : new ReadableStream({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const part = await pool.read(opened.requestId);
        if (part.done) { closed = true; controller.close(); return; }
        controller.enqueue(Buffer.from(part.chunk, "base64"));
      } catch (error) { await close(); controller.error(error); }
    },
    async cancel() { await close(); },
  });
  return new ResponseCtor(stream, { status: opened.status, headers: opened.headers });
}

function createNetwork(pool, signal) {
  assert(typeof pool.invocationId === "string" && pool.invocationId.length > 0, "Network capability requires an invocation");
  return Object.freeze({
    async fetch(url, options = {}) {
      signal.throwIfAborted();
      const headers = options.headers || {};
      const body = options.body === undefined ? undefined : Buffer.from(String(options.body)).toString("base64");
      const opened = await pool.open({ url: String(url), method: options.method || "GET", headers, body, invocationId: pool.invocationId });
      return responseFrom(pool, opened, signal);
    },
    async webSocket(url, options = {}) {
      signal.throwIfAborted();
      const opened = await pool.open({ kind: "websocket", url: String(url), method: "GET", headers: options.headers || {}, invocationId: pool.invocationId });
      const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3, onopen: null, onmessage: null, onerror: null, onclose: null };
      socket.addEventListener = (type, handler) => { socket[`on${type}`] = handler; if (type === "open") queueMicrotask(() => handler({})); };
      socket.send = data => pool.send(opened.requestId, Buffer.from(data).toString("base64"));
      socket.close = async () => { if (socket.readyState === 3) return; socket.readyState = 3; await pool.close(opened.requestId); socket.onclose?.({}); };
      const abort = () => { void socket.close(); };
      signal.addEventListener("abort", abort, { once: true });
      (async () => {
        try {
          while (socket.readyState === 1) {
            const event = await pool.read(opened.requestId);
            if (event.type === "message") socket.onmessage?.({ data: Buffer.from(event.data, "base64") });
            else break;
          }
        } catch (error) { if (!signal.aborted) socket.onerror?.(error); }
        finally { signal.removeEventListener("abort", abort); if (socket.readyState !== 3) { socket.readyState = 3; socket.onclose?.({}); } }
      })();
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    },
  });
}
module.exports = { createNetwork };
