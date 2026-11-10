"use strict";
// Shared desktop/headless assembly. require() reuses the original management
// singleton; never instantiate a second registry/cache while production is active.
let runtime;
let owner;
function getPoolRuntime(host) {
  if (runtime) {
    if (owner !== host) throw new Error("Pool runtime already bound to another manager");
    return runtime;
  }
  const store = require("../proxy/store.cjs");
  const management = require("../proxy/management-adapters.cjs");
  const { ensureFreshSecrets } = require("../proxy/credits.cjs");
  const { createForwardAccess } = require("../proxy/forward-access.cjs");
  const { createPoolService } = require("./pool-service.cjs");
  runtime = createPoolService({ host, getAccount: store.getAccount, access: createForwardAccess({ store, management, ensureFreshSecrets }) });
  owner = host;
  return runtime;
}
module.exports = { getPoolRuntime };
