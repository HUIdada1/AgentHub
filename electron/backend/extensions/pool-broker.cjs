"use strict";
const { randomUUID } = require("node:crypto");

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function identityKey(identity) {
  const fields = [identity?.pluginId, identity?.publisherId, identity?.sessionId, identity?.generation];
  if (fields.some(value => value === undefined || value === null || value === "")) throw failure("GRANT_DENIED", "Missing plugin connection identity");
  return JSON.stringify(fields);
}
function scopeOf(grant) {
  return Object.freeze({ invocationId: grant.invocationId, accountId: grant.accountId,
    channel: grant.channel, purpose: grant.purpose, expiresAt: grant.expiresAt });
}
function project(source, paths) {
  const result = {};
  for (const path of paths) {
    const keys = path.split(".");
    if (!keys.length || keys.some(key => !key || forbidden.has(key))) throw failure("GRANT_POLICY", "Invalid credential field policy");
    let value = source;
    for (const key of keys) value = value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    if (value === undefined) continue;
    if (keys.length === 1 && keys[0] === "extras") {
      if (!Array.isArray(value) || value.length > 4096 || !value.every(pair => Array.isArray(pair) && pair.length === 2
        && pair.every(item => typeof item === "string" && Buffer.byteLength(item) <= 1024 * 1024))) {
        throw failure("GRANT_POLICY", "Invalid scoped credential collection");
      }
      result[keys[0]] = structuredClone(value);
      continue;
    }
    let target = result;
    for (const key of keys.slice(0, -1)) target = target[key] || (target[key] = {});
    target[keys[keys.length - 1]] = structuredClone(value);
  }
  return result;
}

// The host injects existing pool operations. This module never imports adapters, writes
// credentials, runs account management actions, selects accounts, or executes HTTP.
class PoolBroker {
  constructor({ getAccount, readCredentials, ensureCredentials, readContext, policyFor, authorize, getExecutionEpoch, getModelCatalog, networkOpen, networkRead, networkSend, networkClose, maxGrants = 256, maxLifetimeMs = 300000 }) {
    for (const callback of [getAccount, readCredentials, ensureCredentials, policyFor, authorize]) if (typeof callback !== "function") throw new TypeError("Pool broker requires host services");
    if (getExecutionEpoch !== undefined && typeof getExecutionEpoch !== "function") throw new TypeError("Invalid execution epoch reader");
    Object.assign(this, { getAccount, readCredentials, ensureCredentials, readContext, policyFor, authorize, getExecutionEpoch, getModelCatalog, networkOpen, networkRead, networkSend, networkClose, maxGrants, maxLifetimeMs });
    this.grants = new Map();
  }

  // Only host code calls issue. RPC callbacks receive a connection identity from the
  // manager, never from request params supplied by the plugin.
  issue({ identity, invocationId, accountId, channel, deadlineAt, purpose = "invoke", refreshBudget = { used: 0 } }) {
    if (!refreshBudget || !Number.isSafeInteger(refreshBudget.used) || refreshBudget.used < 0 || refreshBudget.used > 1) throw failure("GRANT_POLICY", "Invalid invocation refresh budget");
    if (this.grants.size >= this.maxGrants) throw failure("GRANT_LIMIT", "Too many active account grants");
    const connection = identityKey(identity);
    const account = this.getAccount(accountId);
    if (!account || account.channel !== channel || account.status === "disabled") throw failure("GRANT_DENIED", "Account unavailable");
    if (!invocationId || !["invoke", "catalog"].includes(purpose) || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw failure("GRANT_DENIED", "Invalid grant request");
    if (this.authorize(identity, { invocationId, accountId, channel, purpose }) !== true) throw failure("GRANT_DENIED", "Account access not authorized");
    const policy = this.policyFor(channel, purpose);
    if (!policy || !Array.isArray(policy.credentials) || !Array.isArray(policy.context || [])) throw failure("GRANT_POLICY", "Missing account field policy");
    const grantId = randomUUID();
    const expiresAt = Math.min(deadlineAt, Date.now() + this.maxLifetimeMs);
    const grant = { grantId, connection, invocationId, accountId, channel, purpose, expiresAt, policy: structuredClone(policy), refreshBudget, active: true };
    grant.timer = setTimeout(() => this.revoke(grantId), Math.max(1, expiresAt - Date.now()));
    grant.timer.unref?.();
    this.grants.set(grantId, grant);
    return { grantId, expiresAt };
  }

  validate(identity, grantId) {
    const grant = this.grants.get(grantId);
    if (!grant || !grant.active || grant.connection !== identityKey(identity)) throw failure("GRANT_DENIED", "Invalid account grant");
    if (Date.now() >= grant.expiresAt) { this.revoke(grantId); throw failure("GRANT_EXPIRED", "Account grant expired"); }
    const account = this.getAccount(grant.accountId);
    if (!account || account.channel !== grant.channel || account.status === "disabled" || this.authorize(identity, grant) !== true) {
      this.revoke(grantId);
      throw failure("GRANT_DENIED", "Account authorization revoked");
    }
    return { grant, account };
  }

  // Host-only rotation after the SDK has drained its outstanding callbacks.
  // Keep the invocation's refresh counter even though the opaque token changes.
  rotate(identity, grantId, deadlineAt) {
    const { grant } = this.validate(identity, grantId);
    this.grants.delete(grantId); // Reuse its capacity even at maxGrants.
    let next;
    try { next = this.issue({ identity, invocationId: grant.invocationId, accountId: grant.accountId,
      channel: grant.channel, purpose: grant.purpose, deadlineAt, refreshBudget: grant.refreshBudget }); }
    catch (error) { this.grants.set(grantId, grant); throw error; }
    grant.active = false;
    clearTimeout(grant.timer);
    return next;
  }

  async credentials(identity, grantId) {
    const { grant, account } = this.validate(identity, grantId);
    const secrets = await this.readCredentials(account, scopeOf(grant));
    this.validate(identity, grantId);
    return project(secrets, grant.policy.credentials);
  }

  async ensure(identity, grantId, reason) {
    const { grant, account } = this.validate(identity, grantId);
    if (grant.purpose !== "invoke" || !["upstream-auth-expired", "preflight"].includes(reason)) throw failure("GRANT_DENIED", "Credential refresh not authorized");
    if (grant.refreshBudget.used >= 1) throw failure("GRANT_LIMIT", "Invocation credential refresh exhausted");
    grant.refreshBudget.used++;
    const current = await this.readCredentials(account, scopeOf(grant));
    this.validate(identity, grantId);
    // The existing management service owns single-flight, persistence and noPersist.
    // Use its effective result; re-reading the DB here could resurrect an old token.
    const effective = await this.ensureCredentials(account, current, reason, scopeOf(grant));
    this.validate(identity, grantId);
    if (!effective) throw failure("CREDENTIALS_UNAVAILABLE", "No effective credentials available");
    return project(effective, grant.policy.credentials);
  }

  async context(identity, grantId) {
    const { grant, account } = this.validate(identity, grantId);
    const context = this.readContext ? await this.readContext(account, scopeOf(grant)) : {};
    this.validate(identity, grantId);
    const result = project(context, grant.policy.context || []);
    // Current invocation facts come from the same account-scoped executable
    // directory used by routing. They cannot be supplied by the RPC caller.
    const models = this.getModelCatalog?.(identity, grant);
    if (models !== undefined) result.models = structuredClone(models);
    this.validate(identity, grantId);
    // Reserved host metadata, independent of per-channel account field policies.
    // An account adapter or plugin cannot supply/override this fence.
    delete result.accountExecutionEpoch;
    const epoch = this.getExecutionEpoch?.(identity, grant);
    if (epoch !== undefined) {
      require("./provider-protocol.cjs").validateAccountExecutionEpoch(epoch);
      result.accountExecutionEpoch = epoch;
    }
    return result;
  }

  attach(peer, identity) {
    const bound = Object.freeze({ ...identity });
    identityKey(bound);
    const disposers = [
      peer.handle("pool.readForwardCredentials", params => this.credentials(bound, params?.grantId)),
      peer.handle("pool.ensureForwardCredentials", params => this.ensure(bound, params?.grantId, params?.reason)),
      peer.handle("pool.readForwardContext", params => this.context(bound, params?.grantId)),
      peer.handle("pool.network.open", (params, context) => this.networkOpen?.(bound, params, context) || Promise.reject(failure("NETWORK_UNAVAILABLE", "Host network capability unavailable"))),
      peer.handle("pool.network.read", params => this.networkRead?.(bound, params) || Promise.reject(failure("NETWORK_UNAVAILABLE", "Host network capability unavailable"))),
      peer.handle("pool.network.send", params => this.networkSend?.(bound, params) || Promise.reject(failure("NETWORK_UNAVAILABLE", "Host network capability unavailable"))),
      peer.handle("pool.network.close", params => this.networkClose?.(bound, params) || Promise.resolve({ closed: true }))
    ];
    const detach = () => { for (const dispose of disposers) dispose(); this.revokeConnection(bound); peer.off("closed", detach); };
    peer.once("closed", detach);
    return detach;
  }

  revoke(grantId) {
    const grant = this.grants.get(grantId);
    if (!grant) return;
    grant.active = false;
    clearTimeout(grant.timer);
    this.grants.delete(grantId);
  }
  revokeInvocation(invocationId) { for (const grant of this.grants.values()) if (grant.invocationId === invocationId) this.revoke(grant.grantId); }
  revokeAccount(accountId) { for (const grant of this.grants.values()) if (grant.accountId === accountId) this.revoke(grant.grantId); }
  revokeConnection(identity) { const connection = identityKey(identity); for (const grant of this.grants.values()) if (grant.connection === connection) this.revoke(grant.grantId); }
  close() { for (const id of this.grants.keys()) this.revoke(id); }
}

module.exports = { PoolBroker };
