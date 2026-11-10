"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { signingPayload, verifyManifest, packagePath } = require("../electron/backend/extensions/manifest.cjs");
const { inspectPackage, stagePackage, verifyDirectory } = require("../electron/backend/extensions/package.cjs");

// Minimal fixture ZIP writer, including hostile paths/attributes which normal
// archivers refuse to create. Fixtures never execute a package entry point.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.data || "");
    const compressed = file.deflate ? zlib.deflateRawSync(data) : data;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800 | (file.flags || 0), 6); header.writeUInt16LE(file.deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.declaredSize ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(file.attributes ?? ((0x81a4 << 16) >>> 0), 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, table, end]);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-package-test-"));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const source = 'throw new Error("Inspection must never execute the entry");\n';
  const hash = data => crypto.createHash("sha256").update(data).digest("hex");
  const original = {
    schema: 2, id: "test.example-provider", name: "测试插件", publisher: "test-publisher", version: "1.2.3",
    host: { api: ">=1.0.0 <2.0.0" }, transport: { kind: "stdio-jsonrpc", version: 1 },
    runtime: { kind: "node", entry: "dist/main.cjs", node: ">=22", platforms: [{ os: "win32", arch: "x64" }, { os: "linux", arch: "x64", libc: "glibc" }] },
    capabilities: ["ai.provider@1"], permissions: { required: ["pool.forward-scoped", "network.outbound"], optional: ["storage.private"] },
    contributes: { providers: [{ id: "example", channels: ["test-channel"] }] }, dataSchema: 1,
    files: { "dist/main.cjs": hash(source), "assets/说明.txt": hash("说明") },
  };
  const sign = manifest => ({ ...manifest, signature: { algorithm: "ed25519", keyId: "test-key", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") } });
  const trust = { publisher: "test-publisher", pluginIds: [original.id], publicKey: publicKey.export({ type: "spki", format: "pem" }) };
  const verification = { trustStore: new Map([["test-key", trust]]), hostApi: "1.0.0", nodeVersion: "22.16.0", platform: "win32", arch: "x64" };
  const signed = sign(original);
  const resources = [{ name: "dist/main.cjs", data: source, deflate: true }, { name: "assets/说明.txt", data: "说明" }];
  let cases = 0;
  const rejectManifest = (mutate, pattern, options = verification, resign = true) => {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => verifyManifest(resign ? sign(value) : { ...value, signature: signed.signature }, options), pattern); cases++;
  };
  try {
    assert.equal(verifyManifest(signed, verification).publisherId, trust.publisher); cases++;
    const reordered = Object.fromEntries(Object.entries(signed).reverse());
    assert.deepEqual(signingPayload(reordered), signingPayload(signed)); cases++;
    verifyManifest(signed, { ...verification, platform: "linux", libc: "glibc" }); cases++;
    rejectManifest(value => { value.name = "tampered"; }, /signature verification/, verification, false);
    assert.throws(() => verifyManifest(original, verification), /signature/); cases++;
    rejectManifest(value => { value.publisher = "impostor"; }, /Untrusted/);
    rejectManifest(value => { value.id = "another-plugin"; }, /not authorized/);
    rejectManifest(() => {}, /Untrusted/, { ...verification, trustStore: new Map() });
    rejectManifest(() => {}, /Untrusted/, { ...verification, trustStore: new Map([["test-key", { ...trust, revoked: true }]]) });
    rejectManifest(() => {}, /trust validity/, { ...verification, trustStore: new Map([["test-key", { ...trust, notAfter: 1 }]]) });
    rejectManifest(value => { value.version = "1.2"; }, /version/);
    rejectManifest(value => { value.version = "1.2.3-beta.1"; value.host.api = ">=1.1.0"; }, /host API/);
    rejectManifest(() => {}, /host API/, { ...verification, hostApi: "2.0.0-beta.1" });
    rejectManifest(() => {}, /Node runtime/, { ...verification, nodeVersion: "16.20.2" });
    rejectManifest(() => {}, /platform/, { ...verification, platform: "linux", libc: "musl" });
    rejectManifest(() => {}, /platform/, { ...verification, arch: "arm64" });
    rejectManifest(value => { value.runtime.platforms[0].abi = "999"; }, /platform/);
    rejectManifest(value => { value.runtime.platforms[1].libc = undefined; }, /Invalid metadata/);
    rejectManifest(value => { value.capabilities.push("pool.provider@1"); }, /capability/);
    rejectManifest(value => { value.runtime.env = { NODE_OPTIONS: "--require malicious" }; }, /unsupported/);
    rejectManifest(value => { value.permissions.optional.push("network.outbound"); }, /both/);
    const withHeaders = structuredClone(original);
    withHeaders.permissions.optional.push("request.headers.read");
    withHeaders.contributes.providers[0].requestHeaders = ["x-session-id", "x-agent-id"];
    verifyManifest(sign(withHeaders), verification); cases++;
    const fixedCatalog = structuredClone(original);
    fixedCatalog.contributes.providers[0].modelRefresh = false;
    verifyManifest(sign(fixedCatalog), verification); cases++;
    rejectManifest(value => { value.contributes.providers[0].modelRefresh = "sometimes"; }, /model refresh/);
    rejectManifest(value => { value.contributes.providers[0].requestHeaders = ["x-session-id"]; }, /explicit permission/);
    for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token", "x-client-secret", "X-Session-Id", "x-session_id", "x-" + "a".repeat(99)]) {
      rejectManifest(value => { value.permissions.optional.push("request.headers.read"); value.contributes.providers[0].requestHeaders = [name]; }, /header/);
    }
    rejectManifest(value => { value.permissions.optional.push("request.headers.read"); value.contributes.providers[0].requestHeaders = ["x-session-id", "x-session-id"]; }, /Duplicate/);
    rejectManifest(value => { value.permissions.optional.push("request.headers.read"); value.contributes.providers[0].requestHeaders = Array.from({ length: 17 }, (_, index) => `x-session-${index}`); }, /header/);
    rejectManifest(value => { value.runtime.entry = "missing.cjs"; }, /not signed/);
    rejectManifest(value => { value.files["DIST/main.cjs"] = hash(source); }, /colliding/);
    rejectManifest(value => { value.files.dist = hash(source); }, /collision/);
    rejectManifest(value => { value.files["manifest.json"] = hash(source); }, /digest/);
    for (const bad of ["../escape", "/absolute", "C:/drive", "a\\b", "a:stream", "a//b", "a/./b", "a/../b", "CON", "aux.txt", "a/nul.json", "COM1.cjs", "com¹.txt", "trailing.", "trailing ", "control\u0000", "wild*card", "decomposed-e\u0301.txt"]) {
      assert.throws(() => packagePath(bad), /path/); cases++;
    }
    const filename = path.join(directory, "plugin.zip"), staging = path.join(directory, "stage-parent");
    const write = (manifest = signed, files = resources) => fs.writeFileSync(filename, zip([{ name: "manifest.json", data: JSON.stringify(manifest) }, ...files]));
    write();
    const inspected = await inspectPackage(filename, { verification });
    assert.equal(inspected.identity.pluginId, original.id); assert.equal(fs.existsSync(staging), false); cases++;
    const staged = await stagePackage(filename, { parentDir: staging, verification });
    assert.equal(fs.readFileSync(path.join(staged.stageDir, "dist/main.cjs"), "utf8"), source);
    assert.equal(fs.readFileSync(path.join(staged.stageDir, "assets/说明.txt"), "utf8"), "说明"); cases++;
    await verifyDirectory(staged.stageDir, verification); cases++;
    fs.writeFileSync(path.join(staged.stageDir, "dist/main.cjs"), "tampered");
    await assert.rejects(verifyDirectory(staged.stageDir, verification), /digest mismatch/); cases++;
    fs.writeFileSync(path.join(staged.stageDir, "dist/main.cjs"), source);
    fs.writeFileSync(path.join(staged.stageDir, "unsigned.cjs"), "extra");
    await assert.rejects(verifyDirectory(staged.stageDir, verification), /Unsigned/); cases++;
    fs.rmSync(staging, { recursive: true });
    const rejectZip = async (manifest, files, pattern, extra = {}) => {
      write(manifest, files);
      await assert.rejects(stagePackage(filename, { parentDir: staging, verification, ...extra }), pattern);
      assert.equal(fs.existsSync(staging), false, "Rejected archive must not write even a staging directory"); cases++;
    };
    await rejectZip(signed, [...resources, { name: "extra.cjs", data: "unsigned" }], /list mismatch|Unsigned/);
    await rejectZip(signed, resources.slice(0, 1), /list mismatch/);
    await rejectZip(signed, [{ ...resources[0], data: "tampered" }, resources[1]], /digest/);
    await rejectZip({ ...signed, name: "forged" }, resources, /signature/);
    await rejectZip(signed, [...resources, { name: "../escape", data: "outside" }], /invalid relative path|path/);
    await rejectZip(signed, [...resources, { name: "DIST/main.cjs", data: source }], /colliding/);
    await rejectZip(signed, [...resources, { name: "dist", data: "collision" }], /collision/);
    await rejectZip(signed, [{ ...resources[0], attributes: (0xa1ff << 16) >>> 0 }, resources[1]], /links/);
    await rejectZip(signed, [{ ...resources[0], flags: 1 }, resources[1]], /encrypted/);
    await rejectZip(signed, [...resources, { name: "unused/", attributes: (0x41ed << 16) >>> 0 }], /empty/);
    const bomb = "0".repeat(1024 * 1024);
    await rejectZip(sign({ ...original, files: { ...original.files, "bomb.txt": hash(bomb) } }), [...resources, { name: "bomb.txt", data: bomb, deflate: true }], /ratio/);
    await rejectZip(signed, resources, /Too many/, { limits: { entries: 2 } });
    await rejectZip(signed, resources, /exceeds limit/, { limits: { archiveBytes: 10 } });
    await rejectZip(signed, resources, /Manifest exceeds limit/, { limits: { manifestBytes: 100 } });
    await rejectZip(signed, [{ ...resources[0], declaredSize: 99999 }, resources[1]], /size|byte|ratio/i);
    fs.writeFileSync(filename, zip([{ name: "wrapped/manifest.json", data: JSON.stringify(signed) }, ...resources]));
    await assert.rejects(inspectPackage(filename, { verification }), /root manifest/); cases++;
    console.log(`PASS extension package: ${cases} contract/signature/archive cases; no code execution or writes before validation`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { zip };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
