"use strict";
// Reproducible SDK export. This is a build-time operation only: plugins never
// require the AgentHub checkout at runtime. The lock contains hashes, not paths
// to the developer's machine or a fabricated release version.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PROTOCOL, FEATURES } = require("../electron/backend/extensions/provider-protocol.cjs");
const SOURCE = path.resolve(__dirname, "../electron/backend/extensions");
const REPO = path.resolve(__dirname, "..");
const FILES = Object.freeze({
  "runtime/provider.cjs": "sdk/provider.cjs",
  "runtime/network.cjs": "sdk/network.cjs",
  "rpc.cjs": "rpc.cjs",
  "provider-protocol.cjs": "provider-protocol.cjs",
  "provider-session.cjs": "provider-session.cjs"
});
function below(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function noLink(filename) {
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error("SDK export cannot follow links");
}
function expected() {
  const content = new Map(Object.entries(FILES).map(([target, source]) => [target, fs.readFileSync(path.join(SOURCE, source))]));
  const lock = { schema: 1, protocol: PROTOCOL, features: [...FEATURES],
    files: Object.fromEntries([...content].map(([name, bytes]) => [name, crypto.createHash("sha256").update(bytes).digest("hex")])) };
  content.set("source-lock.json", Buffer.from(JSON.stringify(lock, null, 2) + "\n"));
  return content;
}
function exportSdk(project, { check = false } = {}) {
  const root = fs.realpathSync(path.resolve(project));
  if (root === REPO || below(REPO, root)) throw new Error("Provider SDK target must be outside the core repository");
  const sdk = path.join(root, "sdk");
  const content = expected();
  noLink(sdk);
  if (fs.existsSync(sdk) && !fs.statSync(sdk).isDirectory()) throw new Error("SDK target is not a directory");
  // Check every destination before mutating any file, including directory links.
  for (const name of content.keys()) {
    noLink(path.dirname(path.join(sdk, name)));
    noLink(path.join(sdk, name));
  }
  if (check) {
    for (const [name, bytes] of content) {
      const file = path.join(sdk, name);
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) throw new Error(`Provider SDK differs from the locked source: ${name}`);
    }
    return { checked: content.size, protocol: PROTOCOL };
  }
  // Each rename is atomic. source-lock is written LAST; interruption before it
  // leaves --check failing instead of silently distributing a mixed SDK.
  for (const [name, bytes] of content) {
    const file = path.join(sdk, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try { fs.writeFileSync(temp, bytes, { flag: "wx" }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { written: content.size, protocol: PROTOCOL };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || !["--check", "--write"].includes(args[0]) || args[1] !== "--target") throw new Error("Usage: node tools/provider-sdk.cjs --check|--write --target <external-plugin-project>");
    console.log(JSON.stringify(exportSdk(args[2], { check: args[0] === "--check" })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { exportSdk };
