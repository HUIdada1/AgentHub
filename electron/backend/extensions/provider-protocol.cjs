"use strict";
// Versioned, provider-neutral wire rules shared by the host and packaged SDK.
const PROTOCOL = 1;
// Optional, explicitly negotiated protocol-1 extensions. An older runtime keeps
// finite invocation support but cannot silently accept different deadline rules.
const FEATURES = Object.freeze(["unbounded-deadline@1", "scoped-grant-rotation@1", "attempt-reservation@1", "explicit-retry-policy@1", "execution-facts@1", "request-headers@1", "state-scope@1", "account-execution-epoch@1"]);
const EVENT_METHOD = "provider.event";
const LIMITS = Object.freeze({ frameBytes: 16 * 1024 * 1024, eventBytes: 64 * 1024, windowBytes: 512 * 1024, queueBytes: 16 * 1024 * 1024, concurrent: 32 });
const categories = new Set(["auth", "rate", "quota", "account", "model", "network", "upstream", "cancelled", "protocol"]);
const scopes = new Set(["invocation", "account", "account-model", "service"]);
const replayStates = new Set(["safe", "unsafe", "unknown"]);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function failure(code, message, fields = {}) { return Object.assign(new Error(message), { code, ...fields }); }
function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function identifier(value) { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f]/.test(value); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function validateStateScope(value) {
  assert(typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value), "Invalid execution state scope");
}
function validateAccountExecutionEpoch(value) {
  assert(typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value), "Invalid account execution epoch");
}
function requestHeaderName(value) {
  return typeof value === "string" && /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 100
    && !/(?:^|-)(?:auth|authorization|authentication|token|key|secret|cookie|credential|credentials)(?:-|$)/.test(value);
}
function validateRequestHeaders(headers) {
  assert(object(headers) && Object.keys(headers).length <= 16, "Invalid requested client headers");
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    assert(requestHeaderName(name) && typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value)
      && Buffer.byteLength(value, "utf8") <= 4096, "Invalid requested client header value");
    bytes += Buffer.byteLength(name + value, "utf8");
  }
  assert(bytes <= 16384, "Requested client headers exceed limit");
}
function assert(condition, message) { if (!condition) throw failure("PLUGIN_PROTOCOL", message, { category: "protocol", scope: "service", replay: "unknown" }); }
function jsonValue(value, depth = 0) {
  assert(depth <= 32, "Plugin JSON nesting exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") { assert(Number.isFinite(value), "Non-finite plugin number"); return; }
  assert(typeof value === "object", "Non-JSON plugin value");
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    assert(!forbidden.has(key), "Unsafe plugin object key");
    jsonValue(item, depth + 1);
  }
}
function terminal(event) { return event.type === "finish" || event.type === "error"; }
function hasContent(delta) {
  if (!object(delta)) return false;
  const legacy = delta.function_call;
  return !!delta.content || !!delta.reasoning_content
    || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
    || (!!legacy && typeof legacy === "object" && (!!legacy.name || !!legacy.arguments));
}
function validateError(error) {
  assert(object(error) && identifier(error.code), "Invalid plugin error code");
  assert(typeof error.message === "string" && error.message.length <= 1024, "Invalid plugin error message");
  assert(categories.has(error.category) && scopes.has(error.scope) && replayStates.has(error.replay), "Invalid plugin error classification");
  if (error.retryable !== undefined) assert(typeof error.retryable === "boolean", "Invalid plugin retry policy");
  if (error.retryAfterMs !== undefined) assert(integer(error.retryAfterMs, 0, 86400000), "Invalid plugin retry delay");
  if (error.status !== undefined) assert(integer(error.status, 400, 599), "Invalid plugin error status");
}
// Diagnostic facts are plugin reports, never routing, account eligibility or a
// claim that an upstream accepted/charged a request. No arbitrary metadata bag.
function validateExecutionFacts(facts) {
  const model = value => typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 1024 && !/[\s\x00-\x1f\x7f]/u.test(value);
  assert(object(facts) && Object.keys(facts).every(key => ["state", "actualModel", "upstreamReportedModel"].includes(key)), "Invalid execution facts fields");
  assert(["planned", "responded"].includes(facts.state) && model(facts.actualModel), "Invalid execution model facts");
  assert(facts.upstreamReportedModel === undefined || facts.state === "responded" && model(facts.upstreamReportedModel), "Invalid upstream model fact");
}
function validateEvent(event) {
  assert(object(event) && identifier(event.invocationId) && integer(event.generation, 1, Number.MAX_SAFE_INTEGER) && integer(event.seq, 1, Number.MAX_SAFE_INTEGER), "Invalid plugin event identity");
  jsonValue(event);
  switch (event.type) {
    case "delta": assert(object(event.delta), "Invalid plugin delta"); break;
    case "usage":
      assert(object(event.usage) && ["snapshot", "delta"].includes(event.mode), "Invalid plugin usage");
      for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"]) {
        if (event.usage[field] !== undefined) assert(typeof event.usage[field] === "number" && Number.isFinite(event.usage[field]) && event.usage[field] >= 0, "Invalid plugin token usage");
      }
      break;
    case "checkpoint": assert(replayStates.has(event.replay) && (event.taskRef === undefined || identifier(event.taskRef)), "Invalid plugin checkpoint"); break;
    case "finish": assert(typeof event.reason === "string" && event.reason.length <= 128, "Invalid plugin finish reason"); break;
    case "error": validateError(event.error); break;
    default: assert(false, "Unknown plugin model event");
  }
}
function eventFrame(event) { return { jsonrpc: "2.0", method: EVENT_METHOD, params: event }; }
function eventBytes(event) { return Buffer.byteLength(JSON.stringify(eventFrame(event)) + "\n", "utf8"); }
function publicError(error) {
  if (error?.forwardError) { validateError(error.forwardError); return error.forwardError; }
  // Arbitrary upstream exceptions may contain tokens, URLs or request bodies.
  return { code: error?.name === "AbortError" ? "CANCELLED" : "UPSTREAM_FAILED", message: error?.name === "AbortError" ? "模型调用已取消" : "插件模型调用失败，请查看脱敏诊断", category: error?.name === "AbortError" ? "cancelled" : "upstream", scope: "invocation", replay: "unknown" };
}
function forwardError(fields) { validateError(fields); return failure(fields.code, fields.message, { ...fields, forwardError: fields }); }
module.exports = { PROTOCOL, FEATURES, EVENT_METHOD, LIMITS, failure, object, identifier, integer, validateStateScope, validateAccountExecutionEpoch, requestHeaderName, validateRequestHeaders, assert, jsonValue, terminal, hasContent, validateError, validateExecutionFacts, validateEvent, eventBytes, publicError, forwardError };
