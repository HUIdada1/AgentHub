"use strict";
const assert = require("node:assert/strict");
const { pumpSseAwaited } = require("../electron/backend/network/sse-reader.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  let release, received = [], reads = 0;
  const first = new Promise(resolve => { release = resolve; });
  const chunks = [Buffer.from("data: first\r"), Buffer.from("\n\r\ndata: second\n\n"), Buffer.from("event: end\ndata: final")];
  const stream = new ReadableStream({ pull(controller) { reads++; if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); } }, { highWaterMark: 0 });
  const pending = pumpSseAwaited({ body: stream }, async (event, data) => {
    received.push([event, data]);
    if (data === "first") await first;
  });
  while (!received.length) await tick();
  assert.deepEqual(received, [["", "first"]]);
  assert.equal(reads, 2, "no further upstream reads while the consumer holds the event");
  release(); await pending;
  assert.deepEqual(received, [["", "first"], ["", "second"], ["end", "final"]]);
  const bytes = Buffer.from("data: 中文\n\n");
  const split = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const unicode = [];
  await pumpSseAwaited({ body: split }, (_event, data) => unicode.push(data));
  assert.deepEqual(unicode, ["中文"]);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("data: 123456789")); controller.close(); } });
  await assert.rejects(pumpSseAwaited({ body: oversized }, () => {}, { maxEventBytes: 8 }), /超过/);
  let cancelled = false;
  const hung = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  const controller = new AbortController();
  const waiting = pumpSseAwaited({ body: hung }, () => {}, { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(waiting, /stop/); assert.equal(cancelled, true);
  console.log("PASS awaited SSE: consumer pressure, CRLF fragmentation, UTF-8 bytes, EOF tail, event bound and cancellation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
