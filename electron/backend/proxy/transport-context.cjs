"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();

function run(signal, fn) {
  return storage.run({ signal, egress: undefined }, fn);
}

function current() { return storage.getStore(); }

function signalFor(signal) {
  const external = current()?.signal;
  if (!external || external === signal) return signal || external;
  return signal ? AbortSignal.any([external, signal]) : external;
}

async function readText(response, maxBytes = 65536, timeoutMs = 10000) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("上游响应体读取超时"), { idleTimeout: true })), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Object.assign(new Error("上游响应体超过读取限制"), { status: 502 });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

module.exports = { run, current, signalFor, readText };
