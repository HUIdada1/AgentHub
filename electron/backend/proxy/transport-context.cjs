"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();

/**
 * 建一次请求的上下文。
 *
 * 两种调用形态（都支持，避免改所有老调用点）：
 *   run(signal, fn)                    —— 只带取消信号（老形态）
 *   run({ signal, accountId }, fn)     —— 再带账号，用于账号级出口绑定
 *
 * accountId 必须在**转发层**给出：出口选择发生在 netproxy，它只认这个上下文，
 * 拿不到账号就只能走全局策略（「A 账号走美国、B 账号走日本」就无从实现）。
 */
function run(signalOrOptions, fn) {
  const options = signalOrOptions && typeof signalOrOptions === "object" && !(signalOrOptions instanceof AbortSignal)
    ? signalOrOptions
    : { signal: signalOrOptions };
  return storage.run({ signal: options.signal, accountId: options.accountId || "", egress: undefined }, fn);
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
