"use strict";
// Awaited, bounded SSE reader for model execution only. Original management
// parsers are deliberately untouched. No producer queue hides downstream pressure.
async function pumpSseAwaited(response, onEvent, { signal, idleMs = 300000, maxEventBytes = 16 * 1024 * 1024 } = {}) {
  if (!response.body) throw new Error("Missing event stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", event = "", data = [], bytes = 0, timer;
  const oversized = () => Object.assign(new Error("上游 SSE 事件超过读取限制"), { status: 502 });
  async function line(text) {
    if (!text) {
      if (data.length) await onEvent(event, data.join("\n"));
      event = ""; data = []; bytes = 0;
      return;
    }
    bytes += Buffer.byteLength(text);
    if (bytes > maxEventBytes) throw oversized();
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const key = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (key === "event") event = value;
    else if (key === "data") data.push(value);
  }
  async function consume(final) {
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const position = match.index;
      if (!final && buffer[position] === "\r" && position === buffer.length - 1) break;
      const text = buffer.slice(0, position);
      const width = buffer[position] === "\r" && buffer[position + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(position + width);
      signal?.throwIfAborted();
      await line(text);
    }
    if (bytes + Buffer.byteLength(buffer) > maxEventBytes) throw oversized();
    if (final) { if (buffer) await line(buffer); buffer = ""; await line(""); }
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason || new Error("Stream cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Observe immediately even if cancellation occurs while onEvent is draining.
  aborted.catch(() => {});
  try {
    signal?.throwIfAborted();
    for (;;) {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("流中读超时"), { idleTimeout: true })), idleMs);
      });
      let read;
      try { read = await Promise.race([reader.read(), timeout, aborted]); }
      finally { clearTimeout(timer); }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      await consume(false);
    }
    buffer += decoder.decode();
    await consume(true);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* Upstream already closed/aborted. */ }
    reader.releaseLock();
  }
}
module.exports = { pumpSseAwaited };
