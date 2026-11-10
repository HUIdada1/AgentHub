"use strict";
// Diagnostic names and explicit source identities only. Never used as catalog
// entitlements, execution metadata, account selection or credential authority.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const text = value => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f]/.test(value);
const namespace = context => createHash("sha256").update(JSON.stringify([context.audience, context.authorizationVersion])).digest("hex");
function validRef(ref) {
  return ref && ref.kind === "extension" && Object.keys(ref).length === 5
    && [ref.pluginId, ref.publisherId, ref.providerId, ref.channel].every(text);
}
function createCatalogHistory({ filename, now = Date.now, maxBytes = 4 * 1024 * 1024, maxRecords = 4096,
  maxModels = 32768, ttlMs = 30 * 86400000 } = {}) {
  if (typeof filename !== "function" || maxBytes < 64 || [maxBytes, maxRecords, maxModels, ttlMs].some(v => !Number.isSafeInteger(v) || v < 1)) throw new TypeError("Invalid catalog history limits");
  const records = new Map();
  const sizes = new Map();
  let bytes = 32, models = 0;
  let loaded = false, dirty = false, failure = null, limited = false;
  const keyFor = row => JSON.stringify([row.namespace, row.ref, row.accountId]);
  function project(row) {
    if (!row || !/^[a-f0-9]{64}$/.test(row.namespace) || !validRef(row.ref)
      || row.accountId !== null && !text(row.accountId) || !Number.isSafeInteger(row.seenAt)
      || row.seenAt > now() || now() - row.seenAt >= ttlMs || !Array.isArray(row.models)
      || row.models.length > 4096 || row.models.some(id => !text(id))) return null;
    const ref = Object.fromEntries(["kind", "pluginId", "publisherId", "providerId", "channel"].map(k => [k, row.ref[k]]));
    return { namespace: row.namespace, ref, accountId: row.accountId, seenAt: row.seenAt, models: [...new Set(row.models)] };
  }
  function remove(key) {
    const row = records.get(key);
    if (!row) return;
    bytes -= sizes.get(key); models -= row.models.length;
    records.delete(key); sizes.delete(key);
  }
  function insert(row) {
    const key = keyFor(row), size = Buffer.byteLength(JSON.stringify(row)) + 1;
    remove(key); records.set(key, row); sizes.set(key, size);
    bytes += size; models += row.models.length;
  }
  function prune(ages = true) {
    if (ages) for (const [key, row] of records) if (row.seenAt > now() || now() - row.seenAt >= ttlMs) { remove(key); dirty = true; }
    while (records.size > maxRecords || bytes > maxBytes || models > maxModels) {
      remove(records.keys().next().value); dirty = true; limited = true;
    }
  }
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const name = filename();
      if (!fs.existsSync(name)) return;
      const stat = fs.lstatSync(name);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Invalid history file");
      const disk = JSON.parse(fs.readFileSync(name, "utf8"));
      if (disk?.schema !== 1 || !Array.isArray(disk.records) || disk.records.length > maxRecords) throw new Error("Invalid history schema");
      for (const candidate of disk.records) {
        const row = project(candidate);
        if (row) insert(row);
      }
      prune();
    } catch { records.clear(); sizes.clear(); bytes = 32; models = 0; failure = "CATALOG_HISTORY_READ_FAILED"; }
  }
  function remember(entry) {
    load();
    const row = project({ namespace: namespace(entry), ref: entry.ref, accountId: entry.accountId || null,
      seenAt: now(), models: entry.models.map(model => model.id) });
    if (!row) return;
    insert(row); dirty = true;
    // Bound memory during a large preparation, not only at its end.
    prune(false);
  }
  function flush() {
    load(); prune();
    // Preserve a corrupt/unreadable file for diagnosis; do not silently replace it.
    if (!dirty || failure === "CATALOG_HISTORY_READ_FAILED") return;
    let temporary;
    try {
      const name = filename();
      fs.mkdirSync(path.dirname(name), { recursive: true });
      if (fs.existsSync(name) && !fs.lstatSync(name).isFile()) throw new Error("Invalid history target");
      temporary = name + "." + randomUUID() + ".tmp";
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, records: [...records.values()] })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, name); dirty = false; failure = null;
    } catch { failure = "CATALOG_HISTORY_WRITE_FAILED"; }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  }
  return Object.freeze({ remember, flush,
    entries(context) { load(); prune(); const scope = namespace(context); return [...records.values()].filter(row => row.namespace === scope).map(row => ({ ...row, ref: { ...row.ref }, models: row.models.map(id => ({ id })) })); },
    diagnostics() { load(); return failure || (limited ? "CATALOG_HISTORY_LIMIT" : null); }
  });
}
module.exports = { createCatalogHistory };
