"use strict";
// Host-authenticated, opaque execution-state partition; never an authorization.
const crypto = require("node:crypto");
const { assert, identifier, object } = require("./provider-protocol.cjs");
function fact(value) {
  assert(typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4096
    && !/[\x00-\x1f\x7f]/.test(value), "Invalid authenticated state scope fact");
  return value;
}
function names(values) {
  assert(Array.isArray(values) && values.length <= 4096 && values.every(identifier), "Invalid state scope authority");
  return [...new Set(values)].sort();
}
function createStateScopeFactory() {
  const processKey = crypto.randomBytes(32);
  return function derive({ context, ref, identity, permissions, channels }) {
    assert(object(context) && ref?.kind === "extension", "Missing authenticated state scope context");
    const tuple = ["agenthub-state-scope-v1", fact(context.audience), fact(context.authorizationVersion),
      ...["publisherId", "pluginId", "providerId", "channel"].map(key => fact(ref[key])),
      fact(identity?.sessionId), fact(String(identity?.generation || "")),
      names(permissions), names(channels), "invoke"];
    return crypto.createHmac("sha256", processKey).update(JSON.stringify(tuple), "utf8").digest("hex");
  };
}
module.exports = { createStateScopeFactory };
