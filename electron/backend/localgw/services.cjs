"use strict";
// Explicit execution sources. No provider protocols, account management or
// process ownership: the existing plugin manager and original pool are injected.
const config = require("../config.cjs");
const lgwConfig = require("./config.cjs");
const store = require("../proxy/store.cjs");
const { authority } = require("../extensions/authority-watch.cjs");

function unavailable() {
  return Object.assign(new Error("模型执行插件未绑定、未就绪或未授权"), {
    code: "FORWARD_PLUGIN_UNAVAILABLE", status: 503, scope: "service", replay: "safe"
  });
}
function validateRef(ref, channel) {
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f]/.test(value);
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw unavailable();
  const fields = ref.kind === "custom" ? ["kind", "providerId"]
    : ref.kind === "extension" ? ["kind", "pluginId", "publisherId", "providerId", "channel"] : [];
  if (!fields.length || Object.keys(ref).some(key => !fields.includes(key))
    || fields.some(key => !identifier(ref[key]))
    || (ref.kind === "custom" ? ref.providerId !== channel : ref.channel !== channel)) throw unavailable();
  return Object.freeze(Object.fromEntries(fields.map(key => [key, ref[key]])));
}

function createExecutionServices({ providers = store, settings = lgwConfig, configuration = config } = {}) {
  let runtime;
  function configure(value) {
    if (!value || typeof value.host?.providerSessions !== "function" || typeof value.poolService?.capture !== "function"
      || typeof value.executor?.execute !== "function") throw new TypeError("Execution services require the existing manager, scoped pool and executor");
    if (runtime && runtime !== value) throw new Error("Execution services already configured");
    runtime = value;
  }
  function refFor(channel) {
    const pins = settings.get().models.serviceBindings;
    if (pins !== undefined && (!pins || typeof pins !== "object" || Array.isArray(pins))) throw unavailable();
    // A broken or removed explicit source must never become an implicit default.
    if (pins && Object.hasOwn(pins, channel)) return validateRef(pins[channel], channel);
    return providers.getProvider(channel) ? validateRef({ kind: "custom", providerId: channel }, channel) : null;
  }
  function capture(ref, channel, authorize) {
    const pin = validateRef(ref, channel);
    if (typeof authorize !== "function" || authorize() !== true) throw unavailable();
    if (pin.kind === "custom") {
      const provider = providers.getProvider(pin.providerId);
      if (!provider?.enabled || provider.kind !== "openai_compat") throw unavailable();
      return { ref: pin, provider, assertCurrent() {
        const current = providers.getProvider(pin.providerId);
        if (authorize() !== true || !current?.enabled || current.kind !== "openai_compat"
          || JSON.stringify(current) !== JSON.stringify(provider)) throw unavailable();
      } };
    }
    if (!runtime || providers.getProvider(channel)) throw unavailable();
    const captured = runtime.poolService.capture(pin, authorize);
    const live = runtime.host.providerSessions().find(item => item.session === captured.session);
    const declaration = live?.manifest.contributes.providers.find(item => item.id === pin.providerId && item.channels.includes(channel));
    if (!declaration) throw unavailable();
    return { ...captured, ref: pin, executor: runtime.executor, catalogMode: declaration.catalogMode || "account", version: live.manifest.version };
  }
  function check(channel, authorize, explicitRef) {
    return capture(explicitRef === undefined ? refFor(channel) : explicitRef, channel, authorize);
  }
  function setBinding(channel, ref) {
    if (typeof channel !== "string" || !channel.trim() || channel !== channel.trim()) throw unavailable();
    const value = validateRef(ref, channel);
    if (value.kind === "extension" && providers.getProvider(channel)) throw unavailable();
    const current = configuration.loadConfig();
    if (!current || typeof current !== "object") throw new Error("配置读取失败，未写入执行来源");
    const local = current.localgw || {}, models = local.models || {};
    current.localgw = settings.normalize(settings.mergeDeep(settings.LOCALGW_DEFAULTS, {
      ...local, models: { ...models, serviceBindings: { ...(models.serviceBindings || {}), [channel]: value } }
    }));
    configuration.saveConfig(current);
    authority.recheck({ channel });
    return { ok: true, ref: value };
  }
  function list() {
    const pins = settings.get().models.serviceBindings || {};
    const result = providers.listProviders().map(provider => ({
      channel: provider.id, ref: { kind: "custom", providerId: provider.id }, ready: !!provider.enabled
    }));
    for (const live of runtime?.host.providerSessions() || []) {
      for (const declaration of live.manifest.contributes.providers) for (const channel of declaration.channels) {
        const ref = { kind: "extension", pluginId: live.id, publisherId: live.identity.publisherId, providerId: declaration.id, channel };
        let ready = false;
        try { capture(ref, channel, () => true); ready = true; } catch { /* Show unavailable candidates without touching accounts. */ }
        const bound = Object.hasOwn(pins, channel) && JSON.stringify(validateSafely(pins[channel], channel)) === JSON.stringify(validateRef(ref, channel));
        result.push({ channel, ref, ready, bound, modelRefresh: declaration.modelRefresh !== false });
      }
    }
    // Retain historical pins after uninstall/crash, including malformed pins.
    for (const [channel, ref] of Object.entries(pins)) {
      if (!result.some(item => item.channel === channel && JSON.stringify(validateSafely(item.ref, channel)) === JSON.stringify(validateSafely(ref, channel)))) {
        result.push({ channel, ref: validateSafely(ref, channel), ready: false, bound: true, code: "FORWARD_PLUGIN_UNAVAILABLE" });
      }
    }
    return result;
  }
  function validateSafely(ref, channel) { try { return validateRef(ref, channel); } catch { return null; } }
  return Object.freeze({ configure, refFor, capture, check, setBinding, list });
}
const services = createExecutionServices();
module.exports = { ...services, createExecutionServices, validateRef, unavailable };
