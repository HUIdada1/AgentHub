"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");

// Local administrator-managed trust, separate from packages/update indexes.
// No implicit TOFU: installing a package never writes this registry.
function loadTrustStore(filename) {
  if (!fs.existsSync(filename)) return new Map();
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Invalid plugin trust registry");
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (value?.schema !== 1 || !Array.isArray(value.keys) || value.keys.length > 128) throw new Error("Unsupported plugin trust registry");
  const result = new Map();
  for (const key of value.keys) {
    if (!key || typeof key.keyId !== "string" || result.has(key.keyId) || typeof key.publisher !== "string" || !Array.isArray(key.pluginIds) || !key.pluginIds.length || key.pluginIds.some(id => typeof id !== "string")) throw new Error("Invalid publisher trust declaration");
    if (key.revoked !== undefined && typeof key.revoked !== "boolean") throw new Error("Invalid key revocation");
    for (const field of ["notBefore", "notAfter"]) if (key[field] !== undefined && (!Number.isSafeInteger(key[field]) || key[field] < 0)) throw new Error("Invalid key validity");
    const publicKey = crypto.createPublicKey(key.publicKey);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Plugin trust root must be Ed25519");
    result.set(key.keyId, Object.freeze({ publisher: key.publisher, pluginIds: [...key.pluginIds], publicKey, revoked: key.revoked, notBefore: key.notBefore, notAfter: key.notAfter }));
  }
  return result;
}

module.exports = { loadTrustStore };
