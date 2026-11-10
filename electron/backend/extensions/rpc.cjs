"use strict";
// Transport only: no provider, account, network or Electron-specific behavior.
const { EventEmitter } = require("node:events");
const { TextDecoder } = require("node:util");

function rpcError(code, message) { return Object.assign(new Error(message), { code }); }
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 160;

class RpcPeer extends EventEmitter {
  constructor({ input, output, prefix, remotePrefix, maxFrameBytes = 1024 * 1024, maxQueueBytes = 16 * 1024 * 1024, controlReserveBytes = Math.min(128 * 1024, Math.floor(maxQueueBytes / 8)), maxConcurrent = 32, timeoutMs = 10000 }) {
    super();
    if (!prefix || !remotePrefix || prefix === remotePrefix) throw new Error("Distinct RPC ID prefixes are required");
    if (!Number.isSafeInteger(controlReserveBytes) || controlReserveBytes < 0 || controlReserveBytes >= maxQueueBytes) throw new Error("Invalid RPC control reserve");
    Object.assign(this, { input, output, prefix, remotePrefix, maxFrameBytes, maxQueueBytes, controlReserveBytes, maxConcurrent, timeoutMs });
    this.closed = false;
    this.nextId = 0;
    this.pending = new Map();
    this.running = new Map();
    this.handlers = new Map();
    this.notificationHandlers = new Map();
    this.queue = [];
    this.controlQueue = [];
    this.writes = new Set();
    this.queuedBytes = 0;
    this.dataQueuedBytes = 0;
    this.parts = [];
    this.lineBytes = 0;
    this.writing = false;
    this.notificationCount = 0;
    this.onData = data => this.read(data);
    this.onInputError = error => this.close(error);
    this.onOutputError = error => this.close(error);
    this.onEnd = () => this.close(rpcError(-32001, this.lineBytes ? "RPC EOF in partial frame" : "RPC connection ended"));
    this.onOutputClose = () => this.close(rpcError(-32001, "RPC writer closed"));
    this.onDrain = () => { this.writing = false; this.flush(); };
    input.on("data", this.onData);
    input.on("error", this.onInputError);
    input.on("end", this.onEnd);
    output.on("error", this.onOutputError);
    output.on("close", this.onOutputClose);
  }

  handle(method, handler) {
    if (method === "$/cancelRequest" || typeof handler !== "function" || this.handlers.has(method) || this.notificationHandlers.has(method)) throw new Error("Invalid or duplicate RPC handler");
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  // Only for synchronous validation/enqueue of bounded protocol notifications.
  // Business work runs outside the reader. Large credited bursts must not exhaust
  // the asynchronous request-handler count before its microtasks can settle.
  handleNotification(method, handler) {
    if (method === "$/cancelRequest" || typeof handler !== "function" || this.handlers.has(method) || this.notificationHandlers.has(method)) throw new Error("Invalid or duplicate RPC handler");
    this.notificationHandlers.set(method, handler);
    return () => this.notificationHandlers.delete(method);
  }

  call(method, params, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(rpcError(-32001, "RPC connection closed"));
    if (signal?.aborted) return Promise.reject(signal.reason || rpcError(-32800, "RPC cancelled"));
    if (this.pending.size >= this.maxConcurrent) return Promise.reject(rpcError(-32002, "RPC pending limit reached"));
    const id = `${this.prefix}${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, cleanup: () => signal?.removeEventListener("abort", onAbort) };
      const cancel = error => {
        if (!this.pending.has(id)) return;
        this.settle(id, error);
        this.notify("$/cancelRequest", { id }).catch(() => {});
      };
      const onAbort = () => cancel(signal.reason || rpcError(-32800, "RPC cancelled"));
      this.pending.set(id, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) entry.timer = setTimeout(() => cancel(rpcError(-32003, `RPC ${method} timed out`)), timeoutMs);
      this.send({ jsonrpc: "2.0", id, method, params }).catch(error => this.settle(id, error));
    });
  }

  notify(method, params, options) { return this.send({ jsonrpc: "2.0", method, params }, options); }

  settle(id, error, result) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    if (error) entry.reject(error); else entry.resolve(result);
  }

  send(frame, { lane = "control" } = {}) {
    if (this.closed) return Promise.reject(rpcError(-32001, "RPC connection closed"));
    if (lane !== "data" && lane !== "control") return Promise.reject(rpcError(-32602, "Invalid RPC writer lane"));
    let buffer;
    try { buffer = Buffer.from(JSON.stringify(frame) + "\n", "utf8"); }
    catch (error) { return Promise.reject(error); }
    if (buffer.length - 1 > this.maxFrameBytes) return Promise.reject(rpcError(-32004, "RPC frame too large"));
    if (this.queuedBytes + buffer.length > this.maxQueueBytes || (lane === "data" && this.dataQueuedBytes + buffer.length > this.maxQueueBytes - this.controlReserveBytes)) {
      const error = rpcError(-32002, "RPC writer queue exhausted");
      this.close(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      (lane === "data" ? this.queue : this.controlQueue).push({ buffer, resolve, reject, lane });
      this.queuedBytes += buffer.length;
      if (lane === "data") this.dataQueuedBytes += buffer.length;
      this.flush();
    });
  }

  flush() {
    if (this.closed || this.writing) return;
    while ((this.controlQueue.length || this.queue.length) && !this.closed) {
      const item = this.controlQueue.length ? this.controlQueue.shift() : this.queue.shift();
      this.writes.add(item);
      item.finish = error => {
        if (!this.writes.delete(item)) return;
        this.queuedBytes -= item.buffer.length;
        if (item.lane === "data") this.dataQueuedBytes -= item.buffer.length;
        if (error) item.reject(error); else item.resolve();
      };
      // Include the stream's own buffered bytes until its write callback completes.
      let accepted;
      try {
        accepted = this.output.write(item.buffer, error => {
          item.finish(error);
          if (error) this.close(error);
        });
      } catch (error) {
        item.finish(error);
        this.close(error);
        return;
      }
      if (!accepted) {
        this.writing = true;
        this.output.once("drain", this.onDrain);
        return;
      }
    }
  }

  read(data) {
    if (this.closed) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let start = 0;
    while (start < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.lineBytes += part.length;
      if (this.lineBytes > this.maxFrameBytes) { this.close(rpcError(-32004, "RPC frame too large")); return; }
      if (part.length) this.parts.push(part);
      // Bound per-fragment bookkeeping as well as payload bytes on byte-at-a-time input.
      if (this.parts.length >= 256) this.parts = [Buffer.concat(this.parts, this.lineBytes)];
      if (newline === -1) return;
      const bytes = Buffer.concat(this.parts, this.lineBytes);
      this.parts = [];
      this.lineBytes = 0;
      if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 13)) { start = newline + 1; continue; }
      try {
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        this.dispatch(frame, { wireBytes: bytes.length + 1 });
      } catch { this.close(rpcError(-32700, "Invalid RPC frame")); }
      start = newline + 1;
    }
  }

  dispatch(frame, metadata = {}) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.jsonrpc !== "2.0") throw new Error("Expected JSON-RPC 2.0 object");
    if (!has(frame, "method")) {
      if (!validId(frame.id) || !frame.id.startsWith(this.prefix) || has(frame, "result") === has(frame, "error")) throw new Error("Malformed RPC response");
      if (has(frame, "error")) {
        const error = frame.error;
        if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") throw new Error("Malformed RPC error");
        this.settle(frame.id, rpcError(error.code, error.message));
      } else this.settle(frame.id, null, frame.result);
      return;
    }
    if (typeof frame.method !== "string" || !frame.method || frame.method.length > 128 || has(frame, "result") || has(frame, "error")) throw new Error("Malformed RPC request");
    const request = has(frame, "id");
    if (request && (!validId(frame.id) || !frame.id.startsWith(this.remotePrefix) || this.running.has(frame.id))) throw new Error("Invalid or duplicate remote RPC ID");
    if (frame.method === "$/cancelRequest") {
      if (request || !validId(frame.params?.id) || !frame.params.id.startsWith(this.remotePrefix)) throw new Error("Invalid RPC cancellation");
      this.running.get(frame.params.id)?.abort(rpcError(-32800, "Remote RPC cancelled"));
      return;
    }
    const synchronous = !request && this.notificationHandlers.get(frame.method);
    if (synchronous) {
      const result = synchronous(frame.params, metadata);
      if (result && typeof result.then === "function") throw new Error("Synchronous RPC notification cannot await business work");
      return;
    }
    const replyError = error => request ? this.send({ jsonrpc: "2.0", id: frame.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: String(error.message || "RPC handler failed").slice(0, 512) } }) : Promise.resolve();
    const handler = this.handlers.get(frame.method);
    if (!handler) { replyError(rpcError(-32601, "RPC method not found")).catch(error => this.close(error)); return; }
    if (this.running.size + this.notificationCount >= this.maxConcurrent) {
      if (!request) { this.close(rpcError(-32002, "RPC notification limit reached")); return; }
      replyError(rpcError(-32002, "RPC handler limit reached")).catch(error => this.close(error));
      return;
    }
    const controller = new AbortController();
    let deferred = null, finished = false;
    if (request) this.running.set(frame.id, controller); else this.notificationCount++;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (request) this.running.delete(frame.id); else this.notificationCount--;
    };
    // Never await business logic in the reader: it may call back through this peer.
    Promise.resolve().then(() => handler(frame.params, {
      signal: controller.signal, id: frame.id,
      afterReply: callback => {
        if (!request || deferred || typeof callback !== "function") throw new Error("Invalid RPC afterReply callback");
        deferred = callback;
      },
    }))
      .then(async result => {
        // Business work has finished. A fast peer can issue its next request as
        // soon as reply bytes arrive, before our write callback/microtasks run.
        // Keeping that completed handler in running produces false saturation
        // over a long sequential exchange. Writer bytes remain separately bounded.
        finish();
        if (request) await this.send({ jsonrpc: "2.0", id: frame.id, result: result === undefined ? null : result });
        if (deferred && !this.closed) Promise.resolve().then(deferred).catch(error => this.close(error));
      }, error => { finish(); return replyError(error); })
      .catch(error => this.close(error))
      .finally(finish);
  }

  close(reason = rpcError(-32001, "RPC connection closed")) {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.output.off("drain", this.onDrain);
    for (const id of this.pending.keys()) this.settle(id, reason);
    for (const controller of this.running.values()) controller.abort(reason);
    this.running.clear();
    for (const item of [...this.controlQueue.splice(0), ...this.queue.splice(0)]) {
      this.queuedBytes -= item.buffer.length;
      if (item.lane === "data") this.dataQueuedBytes -= item.buffer.length;
      item.reject(reason);
    }
    for (const item of this.writes) item.finish(reason);
    this.parts = [];
    this.lineBytes = 0;
    this.emit("closed", reason);
  }
}

module.exports = { RpcPeer, rpcError };
