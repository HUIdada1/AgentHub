"use strict";
// Non-secret execution fences only. No account store, credentials, management
// cache, scheduler or provider-specific conversation state belongs here.
const { randomBytes } = require("node:crypto");
function denied() {
  return Object.assign(new Error("Account execution state unavailable"), {
    code: "FORWARD_PLUGIN_UNAVAILABLE", status: 503, scope: "service", replay: "safe"
  });
}
function createAccountExecution({ maxEntries = 4096, random = () => randomBytes(16).toString("hex") } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || typeof random !== "function") throw new TypeError("Invalid execution fence limits");
  const entries = new Map();
  let failed = false;
  function notify(entry) {
    for (const cancel of [...entry.holders]) {
      try { cancel(); } catch { failed = true; }
    }
  }
  function failClosed() {
    failed = true;
    for (const entry of entries.values()) notify(entry);
  }
  function version() {
    try {
      const value = random();
      if (typeof value !== "string" || value.length !== 32 || !/^[a-f0-9]{32}$/.test(value)) throw denied();
      return value;
    } catch { failClosed(); throw denied(); }
  }
  function validId(id) {
    if (typeof id !== "string" || !id || id.length > 4096) throw denied();
  }
  return Object.freeze({
    acquire(id, cancel) {
      validId(id);
      if (failed || typeof cancel !== "function") throw denied();
      let entry = entries.get(id);
      if (!entry) {
        if (entries.size >= maxEntries) {
          const victim = [...entries].find(([, row]) => row.holders.size === 0);
          if (!victim) throw denied();
          entries.delete(victim[0]);
        }
        entry = { epoch: version(), holders: new Set() };
      }
      // Map insertion order is the admission LRU, not a clock that can roll back.
      entries.delete(id); entries.set(id, entry);
      const epoch = entry.epoch;
      // Distinct wrapper per lease, even if callers use the same cancel callback.
      const holder = () => cancel();
      entry.holders.add(holder);
      let released = false;
      return Object.freeze({ epoch,
        assertCurrent() {
          if (failed || released || entries.get(id) !== entry || entry.epoch !== epoch) throw denied();
        },
        release() { if (!released) { released = true; entry.holders.delete(holder); } }
      });
    },
    invalidateAccountExecution(id) {
      validId(id);
      if (failed) throw denied();
      const entry = entries.get(id);
      if (!entry) return; // No unbounded tombstones for management-only accounts.
      const next = version();
      if (next === entry.epoch) { failClosed(); throw denied(); }
      entry.epoch = next; // Fence before notifying; no await or plugin ACK.
      notify(entry);
      if (failed) { failClosed(); throw denied(); }
    },
    get size() { return entries.size; },
    get active() { return [...entries.values()].reduce((n, row) => n + row.holders.size, 0); },
    get failed() { return failed; }
  });
}
const accountExecution = createAccountExecution();
module.exports = { createAccountExecution, accountExecution };
