"use strict";
const assert = require("node:assert/strict");
const { createAuthorityWatch } = require("../electron/backend/extensions/authority-watch.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const watch = createAuthorityWatch({ intervalMs: 10, limit: 3 });
  try {
    let allowed = true, otherAllowed = true;
    const first = new AbortController(), other = new AbortController();
    watch.watch({ controller: first, tags: { keyId: "a" }, check: () => allowed });
    const dispose = watch.watch({ controller: other, tags: { keyId: "b" }, check: () => otherAllowed });
    allowed = false;
    watch.recheck({ keyId: "a" });
    assert.equal(first.signal.reason.code, "AUTHORIZATION_REVOKED");
    assert.equal(other.signal.aborted, false, "targeted mutations leave unrelated Key active");
    otherAllowed = false;
    await delay(35);
    assert.equal(other.signal.aborted, true, "idle authority changes are observed without output or mutation events");
    dispose(); dispose(); assert.equal(watch.size, 0);

    for (const check of [() => undefined, () => { throw new Error("private detail"); }, async () => { throw new Error("async policy"); }]) {
      const controller = new AbortController();
      watch.watch({ controller, check });
      assert.equal(controller.signal.aborted, true);
      assert.equal(controller.signal.reason.message.includes("private"), false);
    }
    const expiry = Date.now() + 15, expiring = new AbortController();
    watch.watch({ controller: expiring, check: () => Date.now() < expiry });
    await delay(40); assert.equal(expiring.signal.aborted, true, "expiration needs no next callback");
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    for (const controller of controllers) watch.watch({ controller, check: () => true });
    assert.throws(() => watch.watch({ controller: new AbortController(), check: () => true }), error => error.code === "QUEUE_FULL");
    controllers[0].abort(); assert.equal(watch.size, 2, "caller cancellation removes observation");
    watch.close(); assert.equal(watch.size, 0);
    assert.equal(controllers[1].signal.aborted, true);
    await delay(20); assert.equal(watch.size, 0);
    console.log("PASS authority observation: bounded, targeted, idle expiry, strict synchronous policy, cancellation and cleanup");
  } finally { watch.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
