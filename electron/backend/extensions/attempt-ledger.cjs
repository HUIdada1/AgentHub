"use strict";
// Host-owned per-request budget. Contains only bounded attempt metadata, never
// prompts, credentials, private classifiers, network operations or pool state.
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { validateExecutionFacts } = require("./provider-protocol.cjs");
const REASONS = new Set(["initial", "auth-retry", "content-remediation", "tool-continuation"]);
const fail = (code, message) => Object.assign(new Error(message), { code, status: 503, scope: "invocation", replay: "unknown" });
function createAttemptLedger({ limit = 1, deadlineAt = null, signal, now = () => performance.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())) throw new TypeError("Invalid model attempt budget");
  const end = deadlineAt === null ? Infinity : now() + Math.max(0, deadlineAt - Date.now());
  const attempts = new Map(), scopes = new Set();
  let closed = false, replay = "safe", blocked = false;
  function live() {
    signal?.throwIfAborted();
    if (closed || now() >= end) throw fail(-32041, "Model attempt budget expired or closed");
  }
  function assertAvailable() {
    live();
    if (replay !== "safe" || blocked) throw fail(-32042, "Model output or side effects prohibit replay");
    if (attempts.size >= limit) throw fail(-32040, "Model attempt budget exhausted");
  }
  function open({ invocationId, accountId, connection, authorize }) {
    live();
    if (![invocationId, accountId, connection].every(value => typeof value === "string" && value && value.length <= 2048) || typeof authorize !== "function") throw new TypeError("Invalid model attempt owner");
    let released = false, current;
    const scope = {};
    function assertCurrent() {
      live();
      if (released || authorize() !== true) throw fail(-32043, "Model attempt owner is no longer authorized");
    }
    function entry(id) {
      assertCurrent();
      const item = attempts.get(id);
      if (!item || item.owner !== scope) throw fail(-32043, "Model attempt owner mismatch");
      return item;
    }
    function complete(id, outcome) {
      if (!["safe", "unsafe", "unknown"].includes(outcome)) throw fail(-32602, "Invalid attempt replay state");
      const item = entry(id);
      if (item.state === "terminal") throw fail(-32043, "Model attempt already completed");
      item.state = "terminal"; item.replay = outcome;
      replay = blocked ? "unsafe" : outcome;
      return { completed: true };
    }
    Object.assign(scope, {
      reserve(reason) {
        assertCurrent();
        if (!REASONS.has(reason) || !current && reason !== "initial" || current && reason === "initial") throw fail(-32602, "Invalid model attempt reason");
        if (current && current.state !== "terminal") throw fail(-32043, "Previous model attempt is still active");
        assertAvailable();
        const id = randomUUID();
        current = { id, number: attempts.size + 1, owner: scope, invocationId, accountId, connection, reason, state: "reserved", replay: "unknown" };
        attempts.set(id, current);
        replay = "unknown"; // Reservation is consumed even if dispatch becomes uncertain.
        return { attemptId: id, number: attempts.size, remaining: limit - attempts.size };
      },
      start(id) {
        const item = entry(id);
        if (item.state !== "reserved") throw fail(-32043, "Model attempt cannot be started twice");
        item.state = "started";
        return { started: true };
      },
      complete,
      report(id, facts) {
        const item = entry(id);
        validateExecutionFacts(facts);
        if (item !== current || item.state !== "started") throw fail(-32043, "Model facts require the current started attempt");
        const prior = item.facts;
        if (!prior && facts.state !== "planned" || prior && (prior.actualModel !== facts.actualModel
          || prior.state === "responded" && (facts.state !== "responded" || prior.upstreamReportedModel !== facts.upstreamReportedModel))) {
          throw fail(-32043, "Conflicting or out-of-order model facts");
        }
        item.facts = { state: facts.state, actualModel: facts.actualModel,
          ...(facts.upstreamReportedModel === undefined ? {} : { upstreamReportedModel: facts.upstreamReportedModel }) };
        return { recorded: true };
      },
      close() {
        if (released) return;
        released = true;
        if (current && current.state !== "terminal") { current.state = "terminal"; current.replay = "unknown"; replay = blocked ? "unsafe" : "unknown"; }
        scopes.delete(scope);
      }
    });
    scopes.add(scope);
    return Object.freeze(scope);
  }
  return Object.freeze({ open, assertAvailable,
    preventReplay() { blocked = true; replay = "unsafe"; },
    close() { closed = true; for (const scope of [...scopes]) scope.close(); },
    get used() { return attempts.size; }, get remaining() { return limit - attempts.size; },
    snapshot() { return [...attempts.values()].map(({ owner, ...item }) => structuredClone(item)); }
  });
}
module.exports = { createAttemptLedger };
