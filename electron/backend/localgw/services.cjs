"use strict";
// Explicit execution sources. No provider protocols, account management or
// process ownership: the existing plugin manager and original pool are injected.
const config = require("../config.cjs");
const lgwConfig = require("./config.cjs");
const store = require("../proxy/store.cjs");
const { authority } = require("../extensions/authority-watch.cjs");

function unavailable() {
  return Object.assign(new Error("执行插件未启用、未就绪或未打开该渠道"), {
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
  /** 显式绑定表；形状坏掉时整表视为不可用，绝不退化成隐式来源 */
  function pinTable() {
    const pins = settings.get()?.models?.serviceBindings;
    if (pins === undefined) return {};
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw unavailable();
    return pins;
  }
  const refKey = ref => JSON.stringify([ref.kind, ref.providerId, ref.pluginId, ref.publisherId, ref.channel]);
  const sameRef = (a, b) => !!a && !!b && refKey(a) === refKey(b);
  function extensionRef(live, declaration, channel) {
    return { kind: "extension", pluginId: live.id, publisherId: live.identity.publisherId, providerId: declaration.id, channel };
  }
  /** 当前可执行的插件来源（按引用稳定排序）。
   *
   *  与参考实现（Agent2API / Agent2Providers）同口径：已安装、已授权、已启用且
   *  运行中的插件声明了某个渠道，就默认由它执行该渠道 —— 不再要求用户为 33 个
   *  渠道逐个点「使用此插件」。显式 serviceBindings 仍然优先，是多个插件争同一
   *  渠道时唯一的选择手段；这里仅在「没有显式绑定、也没有自定义提供商」时接管。 */
  function extensionCandidates(channel) {
    const out = [];
    for (const live of runtime?.host.providerSessions() || []) {
      const declared = live.session?.providers;
      for (const declaration of live.manifest.contributes.providers) {
        if (!declaration.channels.includes(channel)) continue;
        // 签名清单说明「可以服务哪些渠道」，握手结果说明「这次真的注册了哪些」。
        // 两者都有时必须同时命中，避免自动选中一个实际没实现的声明。
        if (Array.isArray(declared) && !declared.some(item => item.id === declaration.id
          && Array.isArray(item.channels) && item.channels.includes(channel))) continue;
        out.push({ ref: extensionRef(live, declaration, channel), modelRefresh: declaration.modelRefresh !== false,
          catalogMode: declaration.catalogMode || "account" });
      }
    }
    return out.sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)));
  }
  /** 一个渠道当前生效的执行来源：显式绑定 > 自定义提供商 > 自动插件来源。
   *  多个插件声明同一渠道时优先选「当前真的能 capture」的那个；都不可用则
   *  仍返回排序第一个，让模型目录诊断如实显示该来源不可用（而不是假装没有）。 */
  function selectionFor(channel) {
    const pins = pinTable();
    if (Object.hasOwn(pins, channel)) return { mode: "explicit", ref: validateSafely(pins[channel], channel) };
    if (providers.getProvider(channel)) return { mode: "custom" };
    const candidates = extensionCandidates(channel);
    if (!candidates.length) return { mode: "none" };
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        try { capture(candidate.ref, channel, () => true); return { mode: "auto", ref: candidate.ref }; } catch { /* 试下一个 */ }
      }
    }
    return { mode: "auto", ref: candidates[0].ref };
  }
  function refFor(channel) {
    const selection = selectionFor(channel);
    // A broken or removed explicit source must never become an implicit default.
    if (selection.mode === "explicit") {
      if (!selection.ref) throw unavailable();
      return selection.ref;
    }
    if (selection.mode === "custom") return validateRef({ kind: "custom", providerId: channel }, channel);
    return selection.ref || null;
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
  /** 取消显式绑定：回落到自定义提供商；没有自定义提供商时由可用插件自动接管，
   *  两者都没有则该渠道不可用。
   *  绑定表在配置层是加性合并，删键必须在原始配置上动手术（同 models.removeRule）。 */
  function clearBinding(channel) {
    if (typeof channel !== "string" || !channel.trim() || channel !== channel.trim()) throw unavailable();
    const current = configuration.loadConfig();
    if (!current || typeof current !== "object") throw new Error("配置读取失败，未写入执行来源");
    const local = current.localgw || {}, models = local.models || {};
    const bindings = { ...(models.serviceBindings || {}) };
    if (!Object.hasOwn(bindings, channel)) return { ok: true }; // 幂等：本来就没绑
    delete bindings[channel];
    current.localgw = settings.normalize(settings.mergeDeep(settings.LOCALGW_DEFAULTS, {
      ...local, models: { ...models, serviceBindings: bindings }
    }));
    configuration.saveConfig(current);
    authority.recheck({ channel });
    return { ok: true };
  }
  function list() {
    let pins;
    try { pins = pinTable(); } catch { pins = null; }
    const selections = new Map();
    function selectionOf(channel) {
      if (!selections.has(channel)) {
        let value;
        try { value = selectionFor(channel); } catch { value = { mode: "error" }; }
        selections.set(channel, value);
      }
      return selections.get(channel);
    }
    function isBound(channel, ref) {
      if (!pins || !Object.hasOwn(pins, channel)) return false;
      return sameRef(validateSafely(pins[channel], channel), ref);
    }
    function isSelected(selection, ref) {
      return (selection.mode === "explicit" || selection.mode === "auto") && sameRef(selection.ref, ref);
    }
    const result = providers.listProviders().map(provider => ({
      channel: provider.id, ref: { kind: "custom", providerId: provider.id }, ready: !!provider.enabled,
      selected: selectionOf(provider.id).mode === "custom"
    }));
    for (const live of runtime?.host.providerSessions() || []) {
      for (const declaration of live.manifest.contributes.providers) for (const channel of declaration.channels) {
        const ref = extensionRef(live, declaration, channel);
        let ready = false;
        try { capture(ref, channel, () => true); ready = true; } catch { /* Show unavailable candidates without touching accounts. */ }
        const bound = isBound(channel, ref);
        const active = isSelected(selectionOf(channel), ref);
        result.push({ channel, ref, ready, bound, selected: active, auto: active && !bound,
          modelRefresh: declaration.modelRefresh !== false, catalogMode: declaration.catalogMode || "account" });
      }
    }
    // Retain historical pins after uninstall/crash, including malformed pins.
    for (const [channel, ref] of Object.entries(pins || {})) {
      if (!result.some(item => item.channel === channel && sameRef(item.ref, validateSafely(ref, channel)))) {
        const selection = selectionOf(channel);
        result.push({ channel, ref: validateSafely(ref, channel), ready: false, bound: true,
          selected: selection.mode === "explicit" && sameRef(selection.ref, ref), code: "FORWARD_PLUGIN_UNAVAILABLE" });
      }
    }
    return result;
  }
  function validateSafely(ref, channel) { try { return validateRef(ref, channel); } catch { return null; } }
  return Object.freeze({ configure, refFor, capture, check, setBinding, clearBinding, list });
}
const services = createExecutionServices();
module.exports = { ...services, createExecutionServices, validateRef, unavailable };
