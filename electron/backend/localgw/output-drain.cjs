"use strict";
// Await the actual HTTP writer, not merely the IPC event reader. Works with a
// ServerResponse and ordinary Node Writable streams; no upstream knowledge.
function waitForDrain(writer, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Output cancelled"));
  if (writer.destroyed || writer.writableEnded) return Promise.reject(new Error("Output closed"));
  if (!writer.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      writer.removeListener("drain", drained);
      writer.removeListener("close", closed);
      writer.removeListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const done = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const drained = () => done();
    const closed = () => done(new Error("Output closed while waiting for drain"));
    const failed = error => done(error);
    const aborted = () => done(signal.reason || new Error("Output cancelled"));
    writer.once("drain", drained);
    writer.once("close", closed);
    writer.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    // Recheck after registration so an already drained/closed writer cannot
    // leave a retained credit and its account lease waiting forever.
    if (signal?.aborted) aborted();
    else if (writer.destroyed || writer.writableEnded) closed();
    else if (!writer.writableNeedDrain) drained();
  });
}
module.exports = { waitForDrain };
