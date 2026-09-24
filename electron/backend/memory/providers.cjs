/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 供应商与模型管理：CRUD、API Key 加密落盘、拉取模型、能力/标签自动猜测、兼容性日志。
// Key 只经 safeStorage 信封进出（复用框架 config.cjs 的 encryptSecret/decryptSecret），
// 渲染层拿到的一律是掩码；导出配置时不带 Key（修正清单 §27.3.2 / §27.7）。
"use strict";

const crypto = require("crypto");

const frameworkConfig = require("../config.cjs");
const { API_FORMATS } = require("./config-schema.cjs");
const { LlmClient } = require("./llm/client.cjs");

const KEY_MASK = "••••••••";

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

function guessTags(modelId) {
  const id = String(modelId || "").toLowerCase();
  const tags = [];
  const lightish = /(mini|flash|haiku|small|lite|turbo|8b|7b|instant)/.test(id);
  const heavyish = /(opus|sonnet|pro|max|70b|72b|large|gpt-5|gpt-4o(?!-mini)|claude-3\.5)/.test(id);
  if (lightish) tags.push("light", "dedup", "classify", "tag", "extract");
  if (heavyish || !lightish) tags.push("heavy", "summarize", "distill", "profile");
  return [...new Set(tags)];
}

function guessReasoning(modelId) {
  const id = String(modelId || "").toLowerCase();
  const thinking = /(o1|o3|o4|r1|reason|thinking|qwq|deepseek-r)/.test(id);
  return { enabled: thinking, effort: thinking ? "medium" : "minimal", customBudget: null, visible: false };
}

function guessCaps(modelId) {
  const id = String(modelId || "").toLowerCase();
  return {
    vision: /(vision|vl|gpt-4o|gemini|claude-3|claude-4|qwen-vl)/.test(id),
    tools: !/(embedding|tts|whisper|dall)/.test(id),
    stream: true,
    jsonMode: !/(claude|anthropic)/.test(id),
    contextWindow: /(gemini|1m|200k)/.test(id) ? 1000000 : 128000,
  };
}

// API Key 会随请求明文发往 baseUrl——只允许 https（本机回环放行 http，网关即 127.0.0.1:9527），
// 其余形态（http 远端、无协议、file:// 等）一律拒绝
function validateBaseUrl(url) {
  const u = String(url || "").trim();
  if (/^https:\/\//i.test(u)) return "";
  if (/^http:\/\//i.test(u)) {
    try {
      const host = new URL(u).hostname;
      if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") return "";
    } catch { /* 落到统一报错 */ }
    return "非本机回环地址必须使用 https://（API Key 会随请求发往该地址）";
  }
  return "Base URL 需以 https:// 开头（本机回环可 http://）";
}

class ProviderStore {
  constructor(opts) {
    this.memCfg = opts.memCfg;
    this.service = opts.service;
    this.emit = opts.emit || (() => {});
    this.client = new LlmClient({
      service: this.service,
      getConfig: () => this.flat(),
      emit: this.emit,
      gatewayResolver: opts.gatewayResolver,
    });
    /** 兼容性修正日志（内存 + 落盘到 llm_call 之外的轻量文件） */
    this.quirkLog = [];
  }

  flat() {
    return this.service.flat();
  }

  _saveProviders(list) {
    this.memCfg.set({ "models.providers": list }, { local: true });
    this.emit({ type: "provider-status", detail: "供应商配置已更新" });
  }

  _saveModels(list) {
    this.memCfg.set({ "models.models": list }, { local: true });
    this.emit({ type: "model-changed" });
  }

  list() {
    const providers = this.flat()["models.providers"] || [];
    return providers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind || "custom",
      baseUrl: p.baseUrl,
      apiFormat: p.apiFormat || "chat_completions",
      apiKeyMasked: p.apiKeyRef ? KEY_MASK + this._keyTail(p) : "",
      hasKey: !!p.apiKeyRef,
      enabled: p.enabled !== false,
      headers: p.headers || {},
      quirks: p.quirks || {},
      note: p.note || "",
      status: p.status || "unknown",
      lastCheck: p.lastCheck || null,
      modelCount: (this.flat()["models.models"] || []).filter((m) => m.providerId === p.id).length,
      enabledModelCount: (this.flat()["models.models"] || []).filter((m) => m.providerId === p.id && m.enabled !== false).length,
      isGateway: p.kind === "gateway",
    }));
  }

  /** 新增/编辑供应商；apiKey 为掩码或空时保留原值（防掩码被当 Key 存盘） */
  save(input) {
    if (!input || !input.name || !input.baseUrl) return { ok: false, message: "名称与 Base URL 必填" };
    if (input.apiFormat && !API_FORMATS.includes(input.apiFormat)) return { ok: false, message: "API 格式非法" };
    const urlErr = validateBaseUrl(input.baseUrl);
    if (urlErr) return { ok: false, message: urlErr };
    const list = [...(this.flat()["models.providers"] || [])];
    const idx = input.id ? list.findIndex((p) => p.id === input.id) : -1;
    const prev = idx >= 0 ? list[idx] : null;
    const newBase = String(input.baseUrl).trim().replace(/\/+$/, "");
    const hasNewKey = !!(input.apiKey && input.apiKey !== KEY_MASK && !String(input.apiKey).includes(KEY_MASK));
    // 改道防护：baseUrl 变更而 Key 留空/掩码时若保留旧 Key，主进程会携带真 Key 请求新地址
    // （渲染层可控 baseUrl → Key 外泄），所以改地址必须重填 Key
    if (prev && prev.apiKeyRef && prev.baseUrl !== newBase && !hasNewKey) {
      return { ok: false, message: "修改 Base URL 后必须重新填写 API Key（防止旧 Key 被发往新地址）" };
    }
    let apiKeyRef = prev ? prev.apiKeyRef : "";
    if (hasNewKey) {
      apiKeyRef = frameworkConfig.encryptSecret(String(input.apiKey));
    }
    const entry = {
      id: prev ? prev.id : newId("prov"),
      name: input.name.trim(),
      kind: input.kind || "custom",
      baseUrl: newBase,
      apiFormat: input.apiFormat || "chat_completions",
      apiKeyRef,
      headers: input.headers && typeof input.headers === "object" ? input.headers : (prev ? prev.headers : {}),
      quirks: { dropUnsupportedParams: true, maxTokensField: "max_tokens", supportsSystemRole: true, streamUsage: true, ...(prev ? prev.quirks : {}), ...(input.quirks || {}) },
      enabled: input.enabled !== false,
      status: prev ? prev.status : "unknown",
      lastCheck: prev ? prev.lastCheck : null,
      note: input.note || "",
      createdAt: prev ? prev.createdAt : Date.now(),
    };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this._saveProviders(list);
    return { ok: true, id: entry.id };
  }

  remove(id) {
    const models = (this.flat()["models.models"] || []).filter((m) => m.providerId !== id);
    this._saveModels(models);
    this._saveProviders((this.flat()["models.providers"] || []).filter((p) => p.id !== id));
    return { ok: true, removedModels: models.length };
  }

  /** 掩码尾巴取明文 Key 末 4 位（密文尾巴对用户没有意义） */
  _keyTail(provider) {
    const key = this._apiKeyOf(provider);
    return key ? String(key).slice(-4) : "";
  }

  /** 解密后的 Key（只在主进程内部使用，不进 IPC 返回） */
  _apiKeyOf(provider) {
    if (!provider.apiKeyRef) return "";
    return frameworkConfig.decryptSecret(provider.apiKeyRef) || "";
  }

  listModels(providerId) {
    const all = this.flat()["models.models"] || [];
    return (providerId ? all.filter((m) => m.providerId === providerId) : all).map((m) => ({
      ...m,
      reasoning: m.reasoning || { enabled: false, effort: "minimal", customBudget: null },
      tags: m.tags || [],
      enabled: m.enabled !== false,
    }));
  }

  saveModel(input) {
    if (!input || !input.modelId) return { ok: false, message: "modelId 必填" };
    const list = [...(this.flat()["models.models"] || [])];
    const idx = input.id ? list.findIndex((m) => m.id === input.id) : -1;
    if (!input.providerId && idx < 0) return { ok: false, message: "缺少供应商" };
    const prev = idx >= 0 ? list[idx] : null;
    const entry = {
      id: prev ? prev.id : newId("mod"),
      providerId: input.providerId || prev.providerId,
      modelId: String(input.modelId).trim(),
      displayName: (input.displayName || input.modelId).toString().trim(),
      enabled: input.enabled !== false,
      reasoning: {
        enabled: !!(input.reasoning && input.reasoning.enabled),
        effort: (input.reasoning && input.reasoning.effort) || "minimal",
        customBudget: input.reasoning && input.reasoning.customBudget != null ? Number(input.reasoning.customBudget) : null,
        visible: !!(input.reasoning && input.reasoning.visible),
      },
      caps: input.caps || guessCaps(input.modelId),
      tags: Array.isArray(input.tags) && input.tags.length ? input.tags : guessTags(input.modelId),
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 10,
      temperature: Number.isFinite(Number(input.temperature)) ? Number(input.temperature) : 0.2,
      maxTokens: Number.isFinite(Number(input.maxTokens)) ? Number(input.maxTokens) : 2048,
      note: input.note || "",
      enabledAt: Date.now(),
    };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this._saveModels(list);
    return { ok: true, id: entry.id };
  }

  deleteModel(id) {
    this._saveModels((this.flat()["models.models"] || []).filter((m) => m.id !== id));
    return { ok: true };
  }

  toggleModel(id, enabled) {
    const list = [...(this.flat()["models.models"] || [])];
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return { ok: false, message: "模型不存在" };
    list[idx] = { ...list[idx], enabled: enabled !== false };
    this._saveModels(list);
    return { ok: true, enabled: list[idx].enabled };
  }

  /** 批量操作：enable / disable / setTags / setEffort */
  batchModel(ids, op, value) {
    const list = [...(this.flat()["models.models"] || [])];
    let changed = 0;
    for (let i = 0; i < list.length; i++) {
      if (!ids.includes(list[i].id)) continue;
      if (op === "enable") list[i] = { ...list[i], enabled: true };
      else if (op === "disable") list[i] = { ...list[i], enabled: false };
      else if (op === "setTags") list[i] = { ...list[i], tags: Array.isArray(value) ? value : list[i].tags };
      else if (op === "setEffort") {
        list[i] = { ...list[i], reasoning: { ...(list[i].reasoning || {}), enabled: value !== "off", effort: value } };
      } else continue;
      changed++;
    }
    this._saveModels(list);
    return { ok: true, changed };
  }

  /** 探测单模型能力（保存到 caps） */
  async probeModel(id) {
    const model = this.listModels().find((m) => m.id === id);
    if (!model) return { ok: false, message: "模型不存在" };
    const provider = this._providerWithKey(model.providerId);
    if (!provider) return { ok: false, message: "供应商不存在" };
    const caps = { ...(model.caps || {}), ...guessCaps(model.modelId) };
    try {
      const r = await this.client.call({
        task: "classify",
        system: "只回答一个字符。",
        messages: [{ role: "user", content: "回答 ok" }],
        effort: "off",
        maxTokens: 8,
        timeoutSec: 20,
        preferModelId: model.modelId,
      });
      caps.stream = true;
      caps.tools = (model.caps && model.caps.tools) !== false;
      caps.lastProbe = { at: Date.now(), ok: true, sample: r.text.slice(0, 20) };
    } catch (e) {
      caps.lastProbe = { at: Date.now(), ok: false, message: String(e.message || e) };
    }
    const list = [...(this.flat()["models.models"] || [])];
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], caps };
      this._saveModels(list);
    }
    return { ok: true, caps };
  }

  _providerWithKey(id) {
    const p = (this.flat()["models.providers"] || []).find((x) => x.id === id);
    if (!p) return null;
    return { ...p, apiKeyRef: this._apiKeyOf(p) };
  }

  async test(providerId, modelId) {
    const provider = this._providerWithKey(providerId);
    if (!provider) return { ok: false, message: "供应商不存在" };
    const result = await this.client.testProvider(provider, modelId);
    const list = [...(this.flat()["models.providers"] || [])];
    const idx = list.findIndex((p) => p.id === providerId);
    if (idx >= 0) {
      const status = result.l1.ok && result.l2.ok && result.l3.ok ? "online" : result.l3.ok || result.l2.ok ? "rate_limited" : "offline";
      list[idx] = { ...list[idx], status, lastCheck: { at: Date.now(), ok: !!result.l3.ok, latencyMs: result.l1.latencyMs, models: result.l2.models || 0 } };
      this._saveProviders(list);
    }
    this.emit({ type: "provider-status", providerId, status: result.l3.ok ? "online" : "offline" });
    return { ok: true, ...result };
  }

  async fetchModels(providerId) {
    const provider = this._providerWithKey(providerId);
    if (!provider) return { ok: false, message: "供应商不存在" };
    const list = await this.client.fetchModels(provider);
    return { ok: true, models: list.map((m) => ({ id: m.id, tags: guessTags(m.id), reasoning: guessReasoning(m.id), caps: guessCaps(m.id) })) };
  }

  async testCall(providerId, modelId, effort) {
    const provider = this._providerWithKey(providerId);
    if (!provider) return { ok: false, message: "供应商不存在" };
    if (!modelId) return { ok: false, message: "请指定模型" };
    const t0 = Date.now();
    try {
      const r = await this.client.call({
        task: "classify",
        system: "你是连通性测试探针，只回一个词。",
        messages: [{ role: "user", content: "ping" }],
        effort: effort || "off",
        maxTokens: 24,
        timeoutSec: 30,
        preferModelId: modelId,
      });
      return { ok: true, latencyMs: Date.now() - t0, text: r.text.slice(0, 200), modelId: r.modelId, providerId: r.providerId, effort: r.effort, usage: r.usage };
    } catch (e) {
      return { ok: false, message: String(e.message || e), tried: e.tried || [] };
    }
  }

  quirks(providerId) {
    const memo = providerId ? this.client.quirksMemo[providerId] : this.client.quirksMemo;
    return { memo: memo || {}, log: this.quirkLog.slice(-100) };
  }

  sources() {
    const cfg = this.flat();
    const order = cfg["models.sourceOrder"] || ["gateway", "custom", "degrade"];
    const providers = (cfg["models.providers"] || []).filter((p) => p.enabled !== false);
    return {
      order,
      tagDefs: cfg["models.tagDefs"] || [],
      sources: order.map((key) => {
        if (key === "gateway") {
          return { key, available: false, detail: "本机网关状态由 proxy 模块提供（见「反代网关」页）" };
        }
        if (key === "custom") {
          return { key, available: providers.length > 0, detail: `${providers.length} 个已启用供应商` };
        }
        return { key, available: !!cfg["models.degrade"]?.enabled, detail: "全部失败时的兜底" };
      }),
      routing: cfg["models.routing"] || [],
      taskEffort: cfg["models.taskEffort"] || {},
    };
  }

  saveSources(payload) {
    const entries = {};
    if (Array.isArray(payload.order)) entries["models.sourceOrder"] = payload.order;
    if (Array.isArray(payload.routing)) entries["models.routing"] = payload.routing;
    if (payload.taskEffort && typeof payload.taskEffort === "object") entries["models.taskEffort"] = payload.taskEffort;
    if (Array.isArray(payload.tagDefs)) entries["models.tagDefs"] = payload.tagDefs;
    if (payload.degrade && typeof payload.degrade === "object") entries["models.degrade"] = payload.degrade;
    if (!Object.keys(entries).length) return { ok: false, message: "没有要保存的内容" };
    this.memCfg.set(entries, { local: true });
    this.emit({ type: "model-changed", detail: "路由与来源配置已更新" });
    return { ok: true };
  }

  /** 给任务用的模型路由预览（按标签展开降级链，UI 展示用） */
  routingPreview() {
    const cfg = this.flat();
    const routes = cfg["models.routing"] || [];
    const tagDefs = cfg["models.tagDefs"] || [];
    const tasks = ["extract", "summarize", "tag", "classify", "supersede", "distill", "consolidate", "profile", "dedup"];
    return tasks.map((task) => {
      const route = routes.find((r) => r.task === task);
      const tags = (route && route.tags) || [task];
      const chain = this.client.resolveCandidates(task, {}).map((c) => ({
        providerId: c.provider.id,
        providerName: c.provider.name || c.provider.id,
        modelId: c.model.modelId,
        priority: c.model.priority || 10,
        source: c.source,
      }));
      return { task, tags, effort: (cfg["models.taskEffort"] || {})[task] || "", chain, tagDefs };
    });
  }

  usage(days) {
    return this.service.index.llmUsageByProvider(days || 30);
  }
}

module.exports = { ProviderStore, KEY_MASK, guessTags, guessReasoning, guessCaps };
