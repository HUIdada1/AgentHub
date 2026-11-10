"use strict";
// No shell/archive subprocesses. Validate the complete immutable archive before
// creating a staging directory; no plugin code is executed during inspection.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const yauzl = require("yauzl");
const { MAX_FILES, packagePath, verifyManifest } = require("./manifest.cjs");

const LIMITS = Object.freeze({ archiveBytes: 200 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, manifestBytes: 1024 * 1024, entries: MAX_FILES * 2, ratio: 200 });
const check = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function open(buffer) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
    if (error) return reject(error);
    // Individual metadata/stream operations install rejecting listeners too.
    // Retain a listener between operations so I/O faults cannot escape as an
    // unhandled EventEmitter error in the application process.
    zip.on("error", () => {});
    resolve(zip);
  }));
}
function entries(zip, limits) {
  return new Promise((resolve, reject) => {
    const result = [], names = new Map();
    let total = 0;
    const fail = error => { cleanup(); reject(error); };
    const cleanup = () => { zip.removeListener("error", fail); zip.removeListener("entry", received); zip.removeListener("end", ended); };
    const ended = () => { cleanup(); resolve(result); };
    const received = entry => {
      try {
        check(result.length < limits.entries, "Too many archive entries");
        check(!entry.isEncrypted() && [0, 8].includes(entry.compressionMethod), "Unsupported encrypted/compressed archive entry");
        check(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 && entry.uncompressedSize <= limits.fileBytes, "Archive file exceeds limit");
        check(entry.uncompressedSize <= Math.max(1, entry.compressedSize) * limits.ratio, "Archive compression ratio exceeds limit");
        total += entry.uncompressedSize;
        check(total <= limits.expandedBytes, "Expanded archive exceeds limit");
        const isDirectory = entry.fileName.endsWith("/");
        const filename = packagePath(entry.fileName, { directory: isDirectory });
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const type = mode & 0xf000;
        // Reject links, sockets, devices, and inconsistent directory metadata.
        check(type === 0 || type === (isDirectory ? 0x4000 : 0x8000), "Archive links and special files are forbidden");
        check(!(entry.externalFileAttributes & 0x10) || isDirectory, "Inconsistent archive directory attributes");
        check(!isDirectory || entry.uncompressedSize === 0, "Archive directory contains data");
        const folded = filename.toLowerCase();
        check(!names.has(folded), "Duplicate/case-colliding archive entry");
        names.set(folded, isDirectory);
        result.push({ entry, filename, isDirectory });
        zip.readEntry();
      } catch (error) { fail(error); }
    };
    zip.on("error", fail); zip.on("entry", received); zip.once("end", ended);
    zip.readEntry();
  }).then(result => {
    const files = new Set(result.filter(item => !item.isDirectory).map(item => item.filename.toLowerCase()));
    for (const item of result) {
      const parts = item.filename.toLowerCase().split("/"); parts.pop();
      while (parts.length) { check(!files.has(parts.join("/")), "Archive file/directory collision"); parts.pop(); }
    }
    return result;
  });
}

function readEntry(zip, entry, maxBytes, expectedHash) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const hash = crypto.createHash("sha256"), chunks = [];
      let bytes = 0, crc = 0xffffffff;
      stream.on("error", reject);
      stream.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes || bytes > entry.uncompressedSize) { stream.destroy(new Error("Archive data exceeds declared limit")); return; }
        hash.update(chunk);
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        // Only callers reading the bounded manifest need a returned Buffer.
        if (expectedHash === undefined) chunks.push(chunk);
      });
      stream.on("end", () => {
        try {
          check(bytes === entry.uncompressedSize, "Archive size mismatch");
          check(((crc ^ 0xffffffff) >>> 0) === entry.crc32, "Archive CRC mismatch");
          if (typeof expectedHash === "string") check(hash.digest("hex") === expectedHash, "Package resource digest mismatch");
          resolve(expectedHash === undefined ? Buffer.concat(chunks, bytes) : null);
        } catch (failure) { reject(failure); }
      });
    });
  });
}

function packageLimits(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) check(Object.hasOwn(LIMITS, key) && Number.isSafeInteger(value) && value > 0 && value <= LIMITS[key], "Package limits may only be lowered");
  return { ...LIMITS, ...overrides };
}

async function snapshotArchive(filename, maxBytes) {
  const file = await fs.promises.open(filename, "r");
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, "Plugin archive exceeds limit or is not a file");
    // Bounded read even if the source file grows concurrently. All later passes
    // use this private Buffer, not a mutable filesystem path.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      check(bytesRead > 0, "Plugin archive changed while reading"); offset += bytesRead;
    }
    const after = await file.stat();
    check(after.size === stat.size && after.mtimeMs === stat.mtimeMs, "Plugin archive changed while reading");
    return buffer;
  } finally { await file.close(); }
}

async function inspectBuffer(buffer, verification, limits) {
  const zip = await open(buffer);
  try {
    const list = await entries(zip, limits);
    const manifests = list.filter(item => !item.isDirectory && item.filename === "manifest.json");
    check(manifests.length === 1, "Package must contain one root manifest.json");
    const manifestEntry = manifests[0];
    check(manifestEntry.entry.uncompressedSize <= limits.manifestBytes, "Manifest exceeds limit");
    const manifestBytes = await readEntry(zip, manifestEntry.entry, limits.manifestBytes);
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    const identity = verifyManifest(manifest, verification);
    const resources = list.filter(item => !item.isDirectory && item !== manifestEntry);
    check(resources.length === Object.keys(manifest.files).length, "Package resource list mismatch");
    for (const resource of resources) {
      check(Object.hasOwn(manifest.files, resource.filename), "Unsigned package resource");
      await readEntry(zip, resource.entry, limits.fileBytes, manifest.files[resource.filename]);
    }
    // Empty directories are unnecessary; reject hidden directories not related
    // to any signed resource, instead of retaining unsigned filesystem content.
    for (const directory of list.filter(item => item.isDirectory)) check(resources.some(item => item.filename.startsWith(directory.filename + "/")), "Unsigned empty package directory");
    return { manifest, identity, archiveHash: sha256(buffer), totalBytes: resources.reduce((sum, item) => sum + item.entry.uncompressedSize, manifestBytes.length) };
  } finally { zip.close(); }
}

async function inspectPackage(filename, { verification, limits: overrides } = {}) {
  const limits = packageLimits(overrides);
  const buffer = await snapshotArchive(filename, limits.archiveBytes);
  return inspectBuffer(buffer, verification, limits);
}

async function packageSchema(filename) {
  const buffer = await snapshotArchive(filename, LIMITS.archiveBytes);
  const zip = await open(buffer);
  try {
    const list = await entries(zip, LIMITS);
    const candidates = list.filter(item => !item.isDirectory && (item.filename === "manifest.json" || /^[^/]+\/manifest\.json$/.test(item.filename)));
    check(candidates.length === 1 && candidates[0].entry.uncompressedSize <= LIMITS.manifestBytes, "Missing or ambiguous manifest");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readEntry(zip, candidates[0].entry, LIMITS.manifestBytes)));
    return value.schema ?? 1;
  } finally { zip.close(); }
}

async function stageLegacyPackage(filename, { parentDir } = {}) {
  // Explicit compatibility for existing service/UI packages. They gain no
  // provider capabilities, signed-package status, or scoped pool callbacks.
  check(typeof parentDir === "string" && path.isAbsolute(parentDir), "An absolute private staging parent is required");
  const buffer = await snapshotArchive(filename, LIMITS.archiveBytes), zip = await open(buffer);
  let stage;
  try {
    const list = await entries(zip, LIMITS);
    const manifests = list.filter(item => !item.isDirectory && (item.filename === "manifest.json" || /^[^/]+\/manifest\.json$/.test(item.filename)));
    check(manifests.length === 1 && manifests[0].entry.uncompressedSize <= LIMITS.manifestBytes, "Missing or ambiguous legacy manifest");
    const root = manifests[0].filename.slice(0, -"manifest.json".length);
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readEntry(zip, manifests[0].entry, LIMITS.manifestBytes)));
    check(manifest && typeof manifest === "object" && !Array.isArray(manifest) && (manifest.schema === undefined || manifest.schema === 1), "Not a legacy plugin");
    check(["capabilities", "contributes", "runtime", "transport"].every(key => manifest[key] === undefined), "Legacy package cannot declare provider capabilities");
    check(list.every(item => item.filename === root.slice(0, -1) && item.isDirectory || item.filename.startsWith(root)), "Legacy archive contains files outside its root");
    // Validate/decompress every file before the first filesystem write, so even
    // the unsigned compatibility path cannot extract a ZIP bomb or truncated file.
    for (const item of list.filter(item => !item.isDirectory)) await readEntry(zip, item.entry, LIMITS.fileBytes, null);
    await fs.promises.mkdir(parentDir, { recursive: true, mode: 0o700 });
    stage = await fs.promises.mkdtemp(path.join(await fs.promises.realpath(parentDir), ".incoming-"));
    for (const item of list.filter(item => !item.isDirectory)) {
      const relative = item.filename.slice(root.length);
      packagePath(relative);
      const destination = path.resolve(stage, ...relative.split("/"));
      check(destination.startsWith(stage + path.sep), "Legacy destination escaped staging");
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(destination, await readEntry(zip, item.entry, LIMITS.fileBytes), { flag: "wx", mode: 0o600 });
    }
    return { manifest, stageDir: stage, archiveHash: sha256(buffer) };
  } catch (error) {
    if (stage) await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { zip.close(); }
}

async function stagePackage(filename, { parentDir, verification, limits: overrides } = {}) {
  const limits = packageLimits(overrides);
  check(typeof parentDir === "string" && path.isAbsolute(parentDir), "An absolute private staging parent is required");
  const buffer = await snapshotArchive(filename, limits.archiveBytes);
  const inspected = await inspectBuffer(buffer, verification, limits);
  // No writes above this line. Parent belongs to the host, not to the package.
  await fs.promises.mkdir(parentDir, { recursive: true, mode: 0o700 });
  const parent = await fs.promises.realpath(parentDir);
  const stage = await fs.promises.mkdtemp(path.join(parent, ".incoming-"));
  let zip;
  try {
    zip = await open(buffer);
    const list = await entries(zip, limits);
    for (const item of list.filter(entry => !entry.isDirectory)) {
      const destination = path.resolve(stage, ...item.filename.split("/"));
      check(destination.startsWith(stage + path.sep), "Package destination escaped staging");
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      // Each file has already been authenticated against this same Buffer.
      const bytes = await readEntry(zip, item.entry, item.filename === "manifest.json" ? limits.manifestBytes : limits.fileBytes);
      const handle = await fs.promises.open(destination, "wx", inspected.manifest.runtime.kind === "native" && inspected.manifest.runtime.entry === item.filename ? 0o700 : 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    return { ...inspected, stageDir: stage };
  } catch (error) {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { zip?.close(); }
}

async function verifyDirectory(directory, verification) {
  // Reauthenticate installed resources before every process launch. This is
  // integrity checking, not protection against a malicious same-user process.
  const root = await fs.promises.realpath(directory);
  const manifestFile = path.join(root, "manifest.json");
  const manifestStat = await fs.promises.lstat(manifestFile);
  check(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= LIMITS.manifestBytes, "Invalid installed manifest");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.promises.readFile(manifestFile)));
  const identity = verifyManifest(manifest, verification);
  const expected = new Set(["manifest.json", ...Object.keys(manifest.files)]);
  let total = 0;
  async function walk(dir, prefix = "") {
    for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const relative = prefix + item.name;
      packagePath(relative);
      const filename = path.join(dir, item.name), stat = await fs.promises.lstat(filename);
      check(!stat.isSymbolicLink(), "Installed package links are forbidden");
      if (stat.isDirectory()) {
        check([...expected].some(name => name.startsWith(relative + "/")), "Unsigned installed directory");
        await walk(filename, relative + "/");
      } else {
        check(stat.isFile() && stat.nlink === 1 && expected.delete(relative), "Unsigned, linked, or special installed file");
        total += stat.size;
        check(stat.size <= LIMITS.fileBytes && total <= LIMITS.expandedBytes, "Installed package exceeds limit");
        if (relative !== "manifest.json") {
          const digest = crypto.createHash("sha256");
          for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
          check(digest.digest("hex") === manifest.files[relative], "Installed resource digest mismatch");
        }
      }
    }
  }
  await walk(root);
  check(expected.size === 0, "Missing installed package resource");
  return { manifest, identity, root };
}

module.exports = { LIMITS, inspectPackage, stagePackage, stageLegacyPackage, packageSchema, verifyDirectory };
