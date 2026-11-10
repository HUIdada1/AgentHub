"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ActivationTransaction, recoverActivation, atomicJson } = require("../electron/backend/extensions/activation.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-activation-test-"));
  const id = "fixture-plugin", accountFile = path.join(root, "account-db-sentinel");
  fs.writeFileSync(accountFile, "newest token; never restore this file");
  let index = 0;
  function prepare(hadOld = true) {
    const dir = path.join(root, `case-${++index}`); fs.mkdirSync(dir);
    const dest = path.join(dir, id), stage = path.join(dir, ".incoming-fixture");
    if (hadOld) { fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, "manifest.json"), "old version"); }
    fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, "manifest.json"), "new version");
    return new ActivationTransaction({ root: dir, id, stageDir: stage, priorEnabled: hadOld });
  }
  const version = tx => fs.readFileSync(path.join(tx.loc.destination, "manifest.json"), "utf8");
  const states = [];
  const restore = (key, enabled) => states.push([key, enabled]);
  try {
    let tx = prepare();
    atomicJson(tx.loc.journal, tx.record); // Power loss before any rename.
    recoverActivation(tx.root, restore); assert.equal(version(tx), "old version");
    tx = prepare();
    atomicJson(tx.loc.journal, tx.record); fs.renameSync(tx.loc.destination, tx.loc.backup); // Loss between renames.
    recoverActivation(tx.root, restore); assert.equal(version(tx), "old version");
    tx = prepare(); await tx.activate(); // Loss after candidate activation, before commit.
    assert.equal(version(tx), "new version"); recoverActivation(tx.root, restore); assert.equal(version(tx), "old version");
    assert.equal(fs.readdirSync(tx.root).some(name => name.startsWith(".failed-")), true, "Failed candidate retained for diagnosis");
    assert.equal(recoverActivation(tx.root).recovered, false, "Recovery is idempotent");
    tx = prepare(); await tx.activate();
    tx.record.phase = "committed"; atomicJson(tx.loc.journal, tx.record); // Loss before backup cleanup.
    recoverActivation(tx.root, restore); assert.equal(version(tx), "new version"); assert.equal(fs.existsSync(tx.loc.backup), false);
    tx = prepare(false); await tx.activate();
    recoverActivation(tx.root, restore); assert.equal(fs.existsSync(tx.loc.destination), false, "Uncommitted first install is not activated on reboot");
    tx = prepare(false); atomicJson(tx.loc.journal, tx.record);
    recoverActivation(tx.root, restore); assert.equal(fs.existsSync(tx.loc.stage), false);
    tx = prepare(); await tx.activate(); tx.commit();
    assert.equal(version(tx), "new version"); assert.equal(fs.existsSync(tx.loc.journal), false);
    assert.throws(() => tx.rollback(), /committed/);
    tx = prepare(); await tx.activate();
    assert.throws(() => tx.rollback(() => { throw new Error("State persistence failed"); }), /State persistence/);
    assert.equal(version(tx), "old version");
    recoverActivation(tx.root, restore); assert.equal(version(tx), "old version");
    tx = prepare(); await tx.activate();
    // Recovery also recognizes a completed filesystem rollback if power was
    // lost before persisting rolledBack in the journal.
    fs.renameSync(tx.loc.destination, path.join(tx.root, ".failed-manual")); fs.renameSync(tx.loc.backup, tx.loc.destination);
    recoverActivation(tx.root, restore); assert.equal(version(tx), "old version");
    tx = prepare();
    atomicJson(tx.loc.journal, { ...tx.record, backup: "../outside" });
    assert.throws(() => recoverActivation(tx.root), /backup path/);
    assert.equal(fs.existsSync(tx.loc.stage), true, "Bad journals preserve evidence and do not delete paths");
    assert.equal(fs.readFileSync(accountFile, "utf8"), "newest token; never restore this file");
    assert.equal(states.some(([key, enabled]) => key === id && enabled === false), true);
    console.log("PASS extension activation: interrupted rename/commit/rollback recovery, idempotency, journal path rejection, account-storage isolation");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
