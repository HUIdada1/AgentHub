"use strict";
// Versioned, provider-neutral package contract. Trust is supplied by the host;
// package metadata and an update server can never grant themselves trust.
const crypto = require("node:crypto");
const semver = require("semver");

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DOMAIN = "AgentHub plugin package\u0000schema2\u0000sorted-json-v1\u0000";
const MAX_FILES = 4096;
function check(condition, message) { if (!condition) throw new Error(message); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed, name) {
  check(record(value), `${name} must be an object`);
  check(Object.keys(value).every(key => allowed.includes(key)), `${name} contains unsupported fields`);
}
function identifier(value, name) {
  check(typeof value === "string" && value.length <= 128 && ID.test(value), `Invalid ${name}`);
}
function packagePath(value, { directory = false } = {}) {
  check(typeof value === "string" && value.length > 0 && value.length <= 240, "Invalid package path length");
  check(value.normalize("NFC") === value && !/[\\:\x00-\x1f\x7f]/.test(value), "Invalid package path characters");
  const normalized = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  check(parts.every(part => part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/[<>"|?*]/.test(part)), "Unsafe package path");
  check(parts.every(part => !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)), "Reserved package path");
  return normalized;
}
function json(value, depth = 0) {
  check(depth <= 32, "Package metadata is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    check(value.length <= 32768 && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value), "Invalid metadata string");
    return;
  }
  if (typeof value === "number") { check(Number.isFinite(value), "Invalid metadata number"); return; }
  check(Array.isArray(value) || record(value), "Invalid metadata value");
  for (const key of Object.keys(value)) {
    check(!["__proto__", "prototype", "constructor"].includes(key), "Forbidden metadata key");
    json(value[key], depth + 1);
  }
}
function canonical(value) {
  json(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function signingPayload(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.signature;
  return Buffer.from(DOMAIN + canonical(unsigned), "utf8");
}
function uniqueStrings(items, name, { nonempty = true } = {}) {
  check(Array.isArray(items) && items.length <= 256 && (!nonempty || items.length > 0), `Invalid ${name}`);
  check(items.every(value => typeof value === "string" && value.length > 0 && value.length <= 128), `Invalid ${name}`);
  check(new Set(items).size === items.length, `Duplicate ${name}`);
}

function validateManifest(manifest) {
  json(manifest);
  check(Buffer.byteLength(canonical(manifest)) <= 1024 * 1024, "Manifest exceeds limit");
  keys(manifest, ["schema", "id", "name", "publisher", "version", "host", "transport", "runtime", "capabilities", "permissions", "contributes", "dataSchema", "files", "signature"], "manifest");
  check(manifest.schema === 2, "Unsupported plugin schema");
  identifier(manifest.id, "plugin ID"); identifier(manifest.publisher, "publisher");
  check(typeof manifest.name === "string" && manifest.name.trim().length > 0 && manifest.name.length <= 128, "Invalid plugin name");
  check(typeof manifest.version === "string" && semver.valid(manifest.version) === manifest.version, "Invalid plugin version");
  keys(manifest.host, ["api"], "host");
  check(typeof manifest.host.api === "string" && !!semver.validRange(manifest.host.api), "Invalid host API range");
  keys(manifest.transport, ["kind", "version"], "transport");
  check(manifest.transport.kind === "stdio-jsonrpc" && manifest.transport.version === 1, "Unsupported plugin transport");
  keys(manifest.runtime, ["kind", "entry", "node", "platforms"], "runtime");
  check(["node", "native"].includes(manifest.runtime.kind), "Unsupported plugin runtime");
  packagePath(manifest.runtime.entry);
  if (manifest.runtime.kind === "node") check(typeof manifest.runtime.node === "string" && !!semver.validRange(manifest.runtime.node), "Missing Node feature range");
  else check(manifest.runtime.node === undefined, "Native runtime cannot declare Node range");
  check(Array.isArray(manifest.runtime.platforms) && manifest.runtime.platforms.length > 0 && manifest.runtime.platforms.length <= 32, "Missing platform declarations");
  const seenPlatforms = new Set();
  for (const target of manifest.runtime.platforms) {
    keys(target, ["os", "arch", "libc", "abi"], "platform");
    check(["win32", "linux", "darwin"].includes(target.os) && ["x64", "arm64"].includes(target.arch), "Unsupported platform");
    check(target.libc === undefined || target.os === "linux" && ["glibc", "musl"].includes(target.libc), "Invalid libc declaration");
    check(target.os !== "linux" || !!target.libc, "Linux packages must declare libc");
    check(target.abi === undefined || typeof target.abi === "string" && /^[0-9]{1,4}$/.test(target.abi), "Invalid module ABI");
    const serialized = canonical(target);
    check(!seenPlatforms.has(serialized), "Duplicate platform"); seenPlatforms.add(serialized);
  }
  check(Number.isSafeInteger(manifest.dataSchema) && manifest.dataSchema >= 1, "Invalid private data schema");
  uniqueStrings(manifest.capabilities, "capabilities");
  check(manifest.capabilities.every(value => /^[a-z][a-z0-9.-]*@[1-9][0-9]*$/.test(value)), "Unversioned capability");
  keys(manifest.permissions, ["required", "optional"], "permissions");
  uniqueStrings(manifest.permissions.required, "required permissions", { nonempty: false });
  uniqueStrings(manifest.permissions.optional, "optional permissions", { nonempty: false });
  check(!manifest.permissions.required.some(value => manifest.permissions.optional.includes(value)), "Permission is both required and optional");
  check(manifest.permissions.required.every(value => ["pool.forward-scoped", "network.outbound", "storage.private", "request.headers.read"].includes(value)), "Unsupported required permission");
  keys(manifest.contributes, ["providers"], "contributes");
  // Other extension points are added with their own schema, never a catch-all execute hook.
  check(manifest.capabilities.length === 1 && manifest.capabilities[0] === "ai.provider@1", "Unsupported required capability");
  const providers = manifest.contributes.providers;
  check(Array.isArray(providers) && providers.length > 0 && providers.length <= 128, "Invalid providers");
  const providerIds = new Set();
  for (const provider of providers) {
    keys(provider, ["id", "channels", "catalogMode", "modelRefresh", "requestHeaders"], "provider"); identifier(provider.id, "provider ID");
    if (provider.requestHeaders !== undefined) {
      uniqueStrings(provider.requestHeaders, "requested client headers");
      check(provider.requestHeaders.length <= 16 && provider.requestHeaders.every(require("./provider-protocol.cjs").requestHeaderName), "Invalid requested client header declaration");
      check([...manifest.permissions.required, ...manifest.permissions.optional].includes("request.headers.read"), "Client headers require an explicit permission declaration");
    }
    check(provider.catalogMode === undefined || ["public", "account"].includes(provider.catalogMode), "Invalid provider catalog mode");
    check(provider.modelRefresh === undefined || typeof provider.modelRefresh === "boolean", "Invalid model refresh declaration");
    check(!providerIds.has(provider.id), "Duplicate provider ID"); providerIds.add(provider.id);
    uniqueStrings(provider.channels, "provider channels"); provider.channels.forEach(channel => identifier(channel, "channel"));
  }
  check(record(manifest.files) && Object.keys(manifest.files).length > 0 && Object.keys(manifest.files).length <= MAX_FILES, "Invalid package resource list");
  const paths = new Map();
  for (const [filename, hash] of Object.entries(manifest.files)) {
    packagePath(filename);
    check(filename.toLowerCase() !== "manifest.json" && SHA256.test(hash), "Invalid package resource digest");
    const folded = filename.toLowerCase();
    check(!paths.has(folded), "Case-colliding package resources"); paths.set(folded, filename);
  }
  for (const filename of paths.keys()) {
    const parts = filename.split("/"); parts.pop();
    while (parts.length) { check(!paths.has(parts.join("/")), "File/directory resource collision"); parts.pop(); }
  }
  check(Object.hasOwn(manifest.files, manifest.runtime.entry), "Runtime entry is not signed");
  keys(manifest.signature, ["algorithm", "keyId", "value"], "signature");
  check(manifest.signature.algorithm === "ed25519", "Unsupported signature algorithm");
  identifier(manifest.signature.keyId, "signing key ID");
  check(typeof manifest.signature.value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(manifest.signature.value), "Invalid signature encoding");
  check(Buffer.from(manifest.signature.value, "base64").toString("base64") === manifest.signature.value, "Non-canonical signature encoding");
  return manifest;
}

function verifyManifest(manifest, { trustStore, hostApi, nodeVersion = process.versions.node, platform = process.platform, arch = process.arch, libc, abi = process.versions.modules, now = Date.now() } = {}) {
  validateManifest(manifest);
  const trusted = trustStore instanceof Map ? trustStore.get(manifest.signature.keyId) : undefined;
  check(trusted && trusted.publisher === manifest.publisher && trusted.revoked !== true, "Untrusted plugin publisher");
  check((trusted.notBefore === undefined || now >= trusted.notBefore) && (trusted.notAfter === undefined || now < trusted.notAfter), "Signing key is outside trust validity");
  check(Array.isArray(trusted.pluginIds) && trusted.pluginIds.includes(manifest.id), "Signing key is not authorized for this plugin ID");
  const publicKey = trusted.publicKey instanceof crypto.KeyObject && trusted.publicKey.type === "public" ? trusted.publicKey : crypto.createPublicKey(trusted.publicKey);
  check(publicKey.asymmetricKeyType === "ed25519", "Trust root must be Ed25519");
  check(crypto.verify(null, signingPayload(manifest), publicKey, Buffer.from(manifest.signature.value, "base64")), "Plugin signature verification failed");
  check(!!semver.valid(hostApi) && semver.satisfies(hostApi, manifest.host.api), "Plugin host API incompatible");
  if (manifest.runtime.kind === "node") check(semver.satisfies(nodeVersion, manifest.runtime.node), "Plugin Node runtime incompatible");
  check(manifest.runtime.platforms.some(target => target.os === platform && target.arch === arch && (target.libc === undefined || target.libc === libc) && (target.abi === undefined || target.abi === abi)), "Plugin platform/libc/ABI incompatible");
  return Object.freeze({ pluginId: manifest.id, publisherId: trusted.publisher, keyId: manifest.signature.keyId, version: manifest.version });
}

module.exports = { MAX_FILES, packagePath, canonical, signingPayload, validateManifest, verifyManifest };
