"use strict";
// Bounded observation of current authority. This owns no model/account state,
// credentials, management jobs or refreshes. Callers retain their lifecycle.
function revoked() {
  return Object.assign(new Error("调用授权已失效"), { code: "AUTHORIZATION_REVOKED", status: 403, scope: "service", replay: "unsafe" });
}
function createAuthorityWatch({ intervalMs = 250, limit = 4096 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || !Number.isInteger(limit) || limit < 1) throw new TypeError("Invalid authority watch limits");
  const entries = new Set();
  let timer;
  function arm() {
    if (!entries.size || timer) return;
    timer = setTimeout(() => { timer = undefined; recheck(); arm(); }, intervalMs);
    timer.unref?.();
  }
  function check(entry) {
    if (!entries.has(entry)) return;
    let valid = false;
    try {
      const result = entry.check();
      valid = result === true;
      // An accidentally async policy is denied; also observe a rejection so it
      // cannot become an unhandled process error after this call is cancelled.
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
    } catch { /* Fail closed, without exposing source errors. */ }
    if (!valid) {
      entry.dispose();
      entry.controller.abort(revoked());
    }
  }
  function recheck(tags = {}) {
    for (const entry of [...entries]) {
      if (Object.entries(tags).every(([key, value]) => entry.tags[key] === value)) check(entry);
    }
  }
  function watch({ controller, check: assertCurrent, tags = {} }) {
    if (!(controller instanceof AbortController) || typeof assertCurrent !== "function"
      || !tags || typeof tags !== "object" || Array.isArray(tags)) throw new TypeError("Invalid authority watch");
    if (controller.signal.aborted) return () => {};
    if (entries.size >= limit) throw Object.assign(new Error("授权观察队列已满"), { code: "QUEUE_FULL", status: 429 });
    const entry = { controller, check: assertCurrent, tags: Object.freeze({ ...tags }) };
    function dispose() {
      entries.delete(entry);
      controller.signal.removeEventListener("abort", dispose);
      if (!entries.size) { clearTimeout(timer); timer = undefined; }
    }
    entry.dispose = dispose;
    entries.add(entry);
    controller.signal.addEventListener("abort", dispose, { once: true });
    check(entry);
    arm();
    return dispose;
  }
  function close() {
    for (const entry of [...entries]) { entry.dispose(); entry.controller.abort(revoked()); }
  }
  return Object.freeze({ watch, recheck, close, get size() { return entries.size; } });
}
const authority = createAuthorityWatch();
module.exports = { createAuthorityWatch, authority, revoked };
