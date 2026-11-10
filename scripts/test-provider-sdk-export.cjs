"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { exportSdk } = require("../tools/provider-sdk.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sdk-export-"));
try {
  assert.equal(exportSdk(directory).written, 6);
  assert.equal(exportSdk(directory, { check: true }).checked, 6);
  const lock = fs.readFileSync(path.join(directory, "sdk/source-lock.json"), "utf8");
  assert.doesNotMatch(lock, /E:\\|C:\\|AgentHub-forwarding-plugin|AgentHub_skill/);
  fs.appendFileSync(path.join(directory, "sdk/rpc.cjs"), "\n// drift");
  assert.throws(() => exportSdk(directory, { check: true }), /differs/);
  assert.equal(exportSdk(directory).written, 6);
  assert.equal(fs.readFileSync(path.join(directory, "sdk/source-lock.json"), "utf8"), lock, "same inputs produce byte-identical export and lock");
  assert.equal(exportSdk(directory, { check: true }).checked, 6);
  assert.throws(() => exportSdk(path.resolve(__dirname, "..")), /outside/);
  console.log("PASS provider SDK export: reproducible runtime/testkit, source hashes, drift fails verification and no core-tree targets");
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
