"use strict";
const assert = require("node:assert/strict");
const credentials = require("../electron/backend/proxy/codearts/credentials.cjs");
const models = require("../electron/backend/proxy/codearts/models.cjs");
const { makeCodeArts } = require("../electron/backend/proxy/codearts/management.cjs");
async function main() {
  const originalFresh = credentials.ensureFresh, originalFetch = global.fetch;
  const calls = [], credential = { access_key_id: "test-ak", secret_access_key: "test-sk", security_token: "test-sts", domain_id: "test-domain" };
  let builtinFail = false;
  credentials.ensureFresh = async () => ({ ok: true, credential });
  global.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    let payload;
    if (url.includes("/useragents?")) payload = { agents: [{ original_id: "agent-one" }] };
    else if (url.includes("/agents/detail?")) payload = { gpts: { models: [
      { model_alias: "alias", model_name: "Nested model", model_parameters: { model_id: "Exact-ID", context_window: 120000, max_tokens: 8192, supports_images: true } },
      { model_id: "disabled", model_parameters: { enabled: false } },
    ] } };
    else if (url.endsWith("/model/builtin")) {
      if (builtinFail) throw new Error("offline");
      payload = { builtinModels: [{ model_id: "Exact-ID" }, { model_id: "Vision", supports_images: true, context_window: 1000000 }, { model_id: "Off", enable: false }] };
      assert.equal(options.headers["Agent-Type"], "PromptCenter");
    } else if (url.endsWith("/benefit-gateway-config")) payload = { enabled: true };
    else if (url.endsWith("/gateway/config")) {
      assert.equal(new URL(url).origin, "https://benefit.test");
      assert.ok(Object.keys(options.headers).some(key => key.toLowerCase() === "host"));
      assert.ok(!Object.keys(options.headers).some(key => key.toLowerCase() === "x-domain-id"));
      payload = { error_code: "0000", result: { models: [{ model_id: "Benefit", model_name: "Benefit model", max_tokens: 3000 }] } };
    } else throw new Error("unexpected URL");
    return { ok: true, status: 200, json: async () => payload };
  };
  try {
    const adapter = makeCodeArts({ rules: { get: () => ({ codearts: { base: "https://regional.test", benefitGatewayUrl: "https://benefit.test" } }) }, store: {} });
    const result = await adapter.fetchModels({ id: "account" }, {});
    assert.equal(result.ok, true); assert.equal(result.partial, false);
    assert.deepEqual(result.models.map(m => m.id), ["Exact-ID", "Vision", "Benefit"]);
    assert.equal(result.models[0].source, "agent"); assert.equal(result.models[0].contextLength, 120000);
    assert.equal(result.models[0].maxOutputTokens, 8192); assert.equal(result.models[0].capabilities.images, true);
    assert.equal(result.models[1].capabilities.images, true); assert.equal(result.models[1].contextLength, 1000000);
    assert.equal(result.models[2].source, "benefit"); assert.equal(result.models[2].maxOutputTokens, 3000);
    builtinFail = true;
    const partial = await adapter.fetchModels({ id: "account" }, {});
    assert.equal(partial.partial, true); assert.deepEqual(partial.warnings, ["builtin"]);
    assert.equal(models.resolveModelId(result.models, "exact-id"), "Exact-ID");
    assert.equal(models.isBenefitId(result.models, "benefit"), true);
    console.log("PASS CodeArts catalog: nested agent parameters, builtinModels/images, disabled filtering, source precedence, exact model IDs, separate benefit host/signature/envelope, metadata and partial-source diagnostics");
  } finally { credentials.ensureFresh = originalFresh; global.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
