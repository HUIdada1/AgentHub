"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-management-refresh-"));
process.env.AGENTHUB_DATA_DIR = directory;
const store = require("../electron/backend/proxy/store.cjs");
const management = require("../electron/backend/proxy/management-adapters.cjs");
const credits = require("../electron/backend/proxy/credits.cjs");
const original = management.ADAPTERS.cline_free;
const jwt = ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) })).toString("base64url"), "test"].join(".");
async function main() {
  try {
    store.addAccount({ channel: "cline_free", uid: "fixture", token: jwt, refreshToken: "original-rt" });
    const account = store.listAccounts("cline_free")[0], id = account.id;
    let queryToken, refreshCalls = 0;
    management.ADAPTERS.cline_free = {
      refreshWindowSec: 1,
      async refreshToken() { refreshCalls++; return { ok: true, token: "renewed", refreshToken: "renewed-rt" }; },
      async queryCredits(acc, secrets) { assert.equal(typeof acc.meta, "object"); queryToken = secrets.token; return { credits: 8, expiresAt: 0 }; },
    };
    await credits.refreshAccount(id);
    assert.equal(queryToken, "renewed", "refresh credentials BEFORE querying balance");
    assert.equal(refreshCalls, 1); assert.equal(store.getAccount(id).credits, 8);
    let release;
    management.ADAPTERS.cline_free.queryCredits = async () => { await new Promise(resolve => { release = resolve; }); return { credits: 999, packages: [{ remaining: 999 }] }; };
    const pending = credits.refreshAccount(id);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    store.updateAccount(id, { token: "replacement-login", refreshToken: "replacement-rt" });
    release(); await assert.rejects(pending, error => error.code === "ACCOUNT_CHANGED");
    assert.equal(store.getAccount(id).credits, 8, "old response cannot write balance or packages for a replacement login");
    management.ADAPTERS.cline_free.refreshToken = async () => { await new Promise(resolve => { release = resolve; }); return { ok: true, token: "old-response", refreshToken: "old-response-rt" }; };
    const current = store.getAccount(id), secrets = store.accountSecrets(current);
    release = null;
    const rotating = credits.refreshSecrets(current, secrets);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    store.removeAccount(id); release();
    await assert.rejects(rotating, error => error.code === "ACCOUNT_CHANGED");
    assert.equal(store.getAccount(id), null);
    console.log("PASS management refresh: preflight-before-balance, parsed metadata, persisted rotation, replacement-login result rejection, deleted-account rotation rejection");
  } finally { management.ADAPTERS.cline_free = original; store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
