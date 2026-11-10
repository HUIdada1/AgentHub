"use strict";
// Small filesystem journal shared by the existing plugin manager. Recovery
// never touches account storage, credentials, or plugin private data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const JOURNAL = ".activation.json";
const nonce = () => crypto.randomBytes(8).toString("hex");
const manifestHash = directory => crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "manifest.json"))).digest("hex");
function check(condition, message) { if (!condition) throw new Error(message); }
function atomicJson(filename, value) {
  const temp = filename + `.tmp-${process.pid}-${nonce()}`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
    // Flush the directory where supported (Windows does not allow this open).
    let directory;
    try { directory = fs.openSync(path.dirname(filename), "r"); fs.fsyncSync(directory); }
    catch { /* File fsync + atomic rename still apply. */ }
    finally { if (directory !== undefined) fs.closeSync(directory); }
  } finally { try { fs.unlinkSync(temp); } catch { /* Already renamed. */ } }
}
function validate(record) {
  check(record?.schema === 1 && typeof record.id === "string" && record.id.length <= 128 && ID.test(record.id), "Invalid activation identity");
  check(typeof record.stage === "string" && /^\.incoming-[a-zA-Z0-9_-]+$/.test(record.stage), "Invalid activation staging path");
  check(typeof record.backup === "string" && /^\.backup-[a-zA-Z0-9._-]+$/.test(record.backup), "Invalid activation backup path");
  check(["prepared", "rolledBack", "committed"].includes(record.phase) && typeof record.hadOld === "boolean" && typeof record.priorEnabled === "boolean", "Invalid activation phase");
  check(record.hadOld ? typeof record.priorManifestHash === "string" && /^[a-f0-9]{64}$/.test(record.priorManifestHash) : record.priorManifestHash === null, "Invalid prior package identity");
}
function locations(root, record) {
  validate(record);
  return { destination: path.join(root, record.id), stage: path.join(root, record.stage), backup: path.join(root, record.backup), journal: path.join(root, JOURNAL) };
}

function rollback(root, record) {
  const loc = locations(root, record);
  const hasBackup = fs.existsSync(loc.backup), hasStage = fs.existsSync(loc.stage);
  if (hasBackup || !record.hadOld && !hasStage) {
    if (fs.existsSync(loc.destination)) fs.renameSync(loc.destination, path.join(root, `.failed-${record.id}-${nonce()}`));
    if (hasBackup) fs.renameSync(loc.backup, loc.destination);
  } else if (record.hadOld) {
    check(fs.existsSync(loc.destination) && (hasStage || manifestHash(loc.destination) === record.priorManifestHash), "Activation recovery cannot prove the previous version is intact");
  }
  // Stage is always a validated direct child. No computed recursive operation
  // is issued until locations() has checked all journal-controlled names.
  if (fs.existsSync(loc.stage)) fs.rmSync(loc.stage, { recursive: true, force: true });
}

function recoverActivation(root, restoreState = () => {}) {
  const filename = path.join(root, JOURNAL);
  if (!fs.existsSync(filename)) return { recovered: false };
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024, "Invalid activation journal");
  const record = JSON.parse(fs.readFileSync(filename, "utf8")), loc = locations(root, record);
  if (record.phase === "committed") {
    check(fs.existsSync(loc.destination), "Committed plugin directory is missing; preserving recovery evidence");
    if (fs.existsSync(loc.backup)) fs.rmSync(loc.backup, { recursive: true, force: true });
  } else {
    if (record.phase !== "rolledBack") {
      rollback(root, record);
      record.phase = "rolledBack";
      atomicJson(filename, record);
    }
    restoreState(record.id, record.priorEnabled);
  }
  fs.unlinkSync(filename);
  return { recovered: true, id: record.id, committed: record.phase === "committed" };
}

class ActivationTransaction {
  constructor({ root, id, stageDir, priorEnabled }) {
    check(path.isAbsolute(root) && path.dirname(stageDir) === root, "Activation staging must be a direct child of plugin root");
    this.root = root;
    const hadOld = fs.existsSync(path.join(root, id));
    this.record = { schema: 1, id, stage: path.basename(stageDir), backup: `.backup-${id}-${nonce()}`, hadOld, priorManifestHash: hadOld ? manifestHash(path.join(root, id)) : null, priorEnabled: !!priorEnabled, phase: "prepared" };
    this.loc = locations(root, this.record);
    check(!fs.existsSync(this.loc.journal), "Unresolved plugin activation journal");
  }
  async activate(rename = fs.promises.rename) {
    atomicJson(this.loc.journal, this.record);
    if (this.record.hadOld) await rename(this.loc.destination, this.loc.backup);
    await rename(this.loc.stage, this.loc.destination);
  }
  commit() {
    this.record.phase = "committed";
    atomicJson(this.loc.journal, this.record);
    this.committed = true;
    try {
      if (fs.existsSync(this.loc.backup)) fs.rmSync(this.loc.backup, { recursive: true, force: true });
      fs.unlinkSync(this.loc.journal);
    } catch { /* A committed journal finishes cleanup on the next startup. */ }
  }
  rollback(restoreState = () => {}) {
    check(!this.committed, "Cannot roll back a committed activation");
    if (this.record.phase !== "rolledBack") {
      rollback(this.root, this.record);
      this.record.phase = "rolledBack";
      atomicJson(this.loc.journal, this.record);
    }
    restoreState(this.record.id, this.record.priorEnabled);
    if (fs.existsSync(this.loc.journal)) fs.unlinkSync(this.loc.journal);
  }
}

module.exports = { ActivationTransaction, recoverActivation, atomicJson };
