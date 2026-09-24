/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 模型调用统一入口：来源优先级（gateway → custom → degrade）、标签路由、
// 三级思考强度合并、失败降级与重试、兼容性自动修正、用量记账。
// 上层任务（抽取/摘要/去重/蒸馏/画像）只调 call()，不关心走哪条来源、哪种协议。
"use strict";

const { makeRequest, normalizeResult, detectUnsupportedParam, guessFormatFromFailure } = require("./ir.cjs");
const frameworkConfig = require("../../config.cjs");

const FORMATS = {
  anthropic_messages: require("./format/anthropic.cjs"),
  chat_completions: require("./format/chatcompletions.cjs"),
  responses: require("./format/responses.cjs"),
};

const GATEWAY_DEFAULT = "http://127.0.0.1:9527/v1";

function addPathHint(baseUrl, apiFormat) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return base;
  if (apiFormat === "anthropic_messages") return /\/v1$/.test(base) ? base : base + "/v1";
  if (/\/v1$/.test(base) || /\/chat\/completions$/.test(base) || /\/responses$/.test(base)) return base;
  return base + "/v1";
}

// L1 连通测试的目标：只打到域名/前缀，不要求业务路径存在
function baseHealthUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return base;
  try {
    const u = new URL(/^https?:\/\//i.test(base) ? base : "https://" + base);
    return `${u.protocol}//${u.host}`;
  } catch {
    return base;
  }
}

class LlmClient {
  constructor(opts) {
    this.service = opts.service;
    this.getConfig = opts.getConfig;
    this.emit = opts.emit || (() => {});
    /** 运行时探测到的上游怪癖：{ [providerId]: { unsupported: Set-like object, maxTokensField } } */
    this.quirksMemo = {};
    this.gatewayResolver = opts.gatewayResolver || (() => null);
  }

  formats() {
    return FORMATS;
  }

  /** 组装可用模型池（按来源优先级 + 标签过滤 + priority 排序） */
  resolveCandidates(taskTag, opts = {}) {
    const cfg = this.getConfig();
    const tagDefs = cfg["models.tagDefs"] || [];
    const routes = cfg["models.routing"] || [];
    const sourceOrder = cfg["models.sourceOrder"] || ["gateway", "custom", "degrade"];
    const providers = (cfg["models.providers"] || []).filter((p) => p.enabled !== false);
    const models = (cfg["models.models"] || []).filter((m) => m.enabled !== false);
    const route = routes.find((r) => r.task === taskTag);
    const wantedTags = (route && route.tags && route.tags.length ? route.tags : [taskTag]).filter(Boolean);
    void tagDefs;

    const tagSet = new Set(wantedTags);
    const out = [];
    for (const source of sourceOrder) {
      if (source === "gateway") {
        const gw = this.gatewayResolver();
        if (!gw || !gw.available) continue;
        const gwModels = models.filter((m) => m.providerId === "gw-local" && m.tags.some((t) => tagSet.has(t)));
        for (const m of gwModels) out.push({ source: "gateway", provider: gwProvider(cfg, gw), model: m });
        if (!gwModels.length && gw.fallbackModel) {
          out.push({
            source: "gateway",
            provider: gwProvider(cfg, gw),
            model: { id: "gw-fallback", providerId: "gw-local", modelId: gw.fallbackModel, enabled: true, reasoning: { enabled: false, effort: "minimal" }, tags: [], priority: 99 },
          });
        }
      } else if (source === "custom") {
        for (const p of providers) {
          for (const m of models.filter((m) => m.providerId === p.id && m.tags.some((t) => tagSet.has(t)))) {
            out.push({ source: "custom", provider: p, model: m });
          }
        }
      } else if (source === "degrade") {
        const d = cfg["models.degrade"];
        if (!d || d.enabled === false) continue;
        const p = providers.find((x) => x.id === d.providerId);
        const m = models.find((x) => x.modelId === d.modelId && (!d.providerId || x.providerId === d.providerId));
        if (p && m) out.push({ source: "degrade", provider: p, model: { ...m, reasoning: { enabled: d.effort && d.effort !== "off", effort: d.effort || "minimal" }, priority: 999 } });
      }
    }
    if (opts.preferModelId) {
      out.sort((a, b) => (a.model.modelId === opts.preferModelId ? -1 : b.model.modelId === opts.preferModelId ? 1 : 0));
    }
    // 同来源内按 priority 升序；来源顺序由 sourceOrder 的循环顺序天然保证
    return out.sort((a, b) => (a.model.priority || 10) - (b.model.priority || 10));
  }

  /** 三层思考强度合并：单次调用 > 任务覆盖 > 模型默认 */
  effortFor(taskTag, model, override) {
    if (override) return override;
    const cfg = this.getConfig();
    const taskEffort = cfg["models.taskEffort"] || {};
    if (taskEffort[taskTag]) return taskEffort[taskTag];
    if (model.reasoning && model.reasoning.effort) return model.reasoning.effort;
    return "minimal";
  }

  /**
   * 调用模型（统一入口）。
   * @param {object} input { task, system, messages, jsonMode, effort, maxTokens, timeoutSec }
   */
  async call(input) {
    const cfg = this.getConfig();
    const task = input.task || "summarize";
    const candidates = this.resolveCandidates(task, { preferModelId: input.preferModelId });
    if (!candidates.length) {
      const err = new Error(`没有可用于任务「${task}」的模型：请到「模型与网关」添加供应商与模型，或开启本机网关`);
      err.code = "no_model";
      this.emit({ type: "llm-fallback", reason: "no_model", task });
      throw err;
    }
    const maxRetries = Number(cfg["models.maxRetries"] ?? 3);
    const timeoutSec = Number(input.timeoutSec || cfg["models.timeout"] || 60);
    let lastError = null;
    const tried = [];

    for (let ci = 0; ci < candidates.length; ci++) {
      const cand = candidates[ci];
      const effort = this.effortFor(task, cand.model, input.effort);
      const apiFormat = cand.provider.apiFormat || "chat_completions";
      const fmt = FORMATS[apiFormat] || FORMATS.chat_completions;
      // apiKeyRef 是 safeStorage 密文（enc:v1:...），不解密直接发 Bearer 必然 401——
      // 此前只有「测试供应商」路径解密，任务路径全用密文，生产环境任务全灭
      const apiKey = cand.provider.apiKeyRef
        ? frameworkConfig.decryptSecret(cand.provider.apiKeyRef) || ""
        : cand.provider.apiKey || "";
      // 把「上次被上游拒绝过」的参数翻译成能力位，让 encoder 这次就不发它（否则第二次调用必然再失败）
      const memo = this.quirksMemo[cand.provider.id] || {};
      const dropped = memo.dropped || {};
      const providerWithQuirks = {
        ...cand.provider,
        quirks: {
          ...(cand.provider.quirks || {}),
          ...memo,
          supportsReasoningEffort: memo.supportsReasoningEffort !== false && !dropped.reasoning_effort && !dropped.reasoning,
          supportsThinking: memo.supportsThinking !== false && !dropped.thinking && !dropped.reasoning,
          supportsSystemRole: memo.supportsSystemRole !== false && !dropped.system,
          supportsJsonMode: memo.supportsJsonMode !== false && !dropped.response_format,
          streamUsage: memo.streamUsage !== false && !dropped.stream_options,
          dropTemperature: !!dropped.temperature,
        },
      };
      const base = addPathHint(cand.provider.baseUrl || (cand.source === "gateway" ? GATEWAY_DEFAULT : ""), apiFormat);

      const attempt = async (dropParam) => {
        const req = makeRequest({
          system: input.system,
          messages: input.messages,
          model: cand.model.modelId,
          maxTokens: input.maxTokens || cand.model.maxTokens || 2048,
          temperature: input.temperature ?? cand.model.temperature ?? 0.2,
          effort,
          reasoningEnabled: cand.model.reasoning ? cand.model.reasoning.enabled !== false && effort !== "off" : effort !== "off",
          customBudget: cand.model.reasoning ? cand.model.reasoning.customBudget : null,
          stream: false,
          jsonMode: !!input.jsonMode,
        });
        let body = fmt.encode(req, providerWithQuirks);
        if (dropParam) body = stripParam(body, dropParam);
        const url = fmt.buildUrl(base);
        const t0 = Date.now();
        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: fmt.headers(providerWithQuirks, apiKey),
          body: JSON.stringify(body),
        }, timeoutSec * 1000);
        const text = await res.text();
        return { status: res.status, text, latencyMs: Date.now() - t0, url };
      };

      for (let attemptIdx = 0; attemptIdx <= maxRetries; attemptIdx++) {
        try {
          const r = await attempt(null);
          if (r.status >= 200 && r.status < 300) {
            let parsed;
            try {
              parsed = JSON.parse(r.text);
            } catch {
              throw new Error("上游返回了非 JSON 响应");
            }
            const result = normalizeResult(fmt.decode(parsed));
            this._log({ provider: cand.provider.id, model: cand.model.modelId, task, tokensIn: result.usage.input, tokensOut: result.usage.output, ok: true, latencyMs: r.latencyMs });
            if (ci > 0) this.emit({ type: "llm-fallback", task, from: tried[0], to: `${cand.provider.name || cand.provider.id}/${cand.model.modelId}`, reason: lastError && lastError.message });
            return { ...result, providerId: cand.provider.id, modelId: cand.model.modelId, effort, source: cand.source };
          }

          // 兼容性自动修正：400/422 抱怨某参数 → 剥离该参数重试一次
          const offending = detectUnsupportedParam(r.status, r.text);
          if (offending && !(this.quirksMemo[cand.provider.id]?.dropped || {})[offending]) {
            const memo = (this.quirksMemo[cand.provider.id] = this.quirksMemo[cand.provider.id] || { dropped: {} });
            memo.dropped = memo.dropped || {};
            memo.dropped[offending] = true;
            if (offending === "reasoning_effort" || offending === "reasoning" || offending === "thinking") {
              memo.supportsReasoningEffort = false;
              memo.supportsThinking = false;
            }
            if (offending === "max_tokens" || offending === "max_completion_tokens") {
              memo.maxTokensField = offending === "max_tokens" ? "max_completion_tokens" : "max_tokens";
            }
            this.emit({ type: "provider-quirk", providerId: cand.provider.id, detail: `自动剥离上游不认的参数：${offending}` });
            const retry = await attempt(offending);
            if (retry.status >= 200 && retry.status < 300) {
              let parsed;
              try {
                parsed = JSON.parse(retry.text);
              } catch {
                throw new Error("上游返回了非 JSON 响应");
              }
              const result = normalizeResult(fmt.decode(parsed));
              this._log({ provider: cand.provider.id, model: cand.model.modelId, task, tokensIn: result.usage.input, tokensOut: result.usage.output, ok: true, latencyMs: retry.latencyMs });
              return { ...result, providerId: cand.provider.id, modelId: cand.model.modelId, effort, source: cand.source, quirk: `已剥离 ${offending}` };
            }
          }

          // 401/403：该供应商不可用，直接换下一个
          if (r.status === 401 || r.status === 403) {
            lastError = new Error(`鉴权失败（${r.status}）：检查 ${cand.provider.name || cand.provider.id} 的 API Key`);
            this.emit({ type: "provider-status", providerId: cand.provider.id, status: "offline", detail: lastError.message });
            break;
          }
          // 404/400：可能是格式选错，给出建议
          const hint = guessFormatFromFailure(r.status, r.text);
          lastError = new Error(
            `HTTP ${r.status}${hint ? `：疑似不是「${apiFormat}」格式，建议改用「${hint.guess}」（${hint.reason}）` : `：${r.text.slice(0, 160)}`}`,
          );
          if (r.status === 404 || r.status === 400) break;
          // 429/5xx：退避重试
          if (attemptIdx < maxRetries) {
            await sleep([2000, 10000, 30000][Math.min(attemptIdx, 2)]);
            continue;
          }
          break;
        } catch (e) {
          lastError = e;
          if (attemptIdx < maxRetries) {
            await sleep([2000, 10000, 30000][Math.min(attemptIdx, 2)]);
            continue;
          }
          break;
        }
      }
      tried.push(`${cand.provider.name || cand.provider.id}/${cand.model.modelId}`);
      this._log({ provider: cand.provider.id, model: cand.model.modelId, task, ok: false, detail: lastError && lastError.message });
    }

    const err = lastError || new Error("所有来源都不可用");
    err.tried = tried;
    throw err;
  }

  _log(entry) {
    try {
      this.service.index.llmLog(entry);
    } catch { /* 记账失败不影响调用结果 */ }
  }

  /** 三级连接测试：连通 → 鉴权 → 格式能力 */
  async testProvider(provider, modelId) {
    const apiFormat = provider.apiFormat || "chat_completions";
    const fmt = FORMATS[apiFormat] || FORMATS.chat_completions;
    const out = { l1: { ok: false }, l2: { ok: false }, l3: { ok: false }, suggestion: null };
    const base = addPathHint(provider.baseUrl, apiFormat);
    const apiKey = provider.apiKeyRef
      ? frameworkConfig.decryptSecret(provider.apiKeyRef) || ""
      : provider.apiKey || "";

    // L1 连通（打到域名，允许 401/404：能收到 HTTP 响应即连通）
    try {
      const t0 = Date.now();
      const res = await fetchWithTimeout(baseHealthUrl(provider.baseUrl), { method: "GET" }, 15000);
      out.l1 = { ok: true, latencyMs: Date.now() - t0, status: res.status };
    } catch (e) {
      out.l1 = { ok: false, message: `网络不可达：${e && e.message ? e.message : e}` };
      return out;
    }

    // L2 鉴权（OpenAI 系走 /models；Anthropic 系发一个最小请求）
    try {
      if (apiFormat === "chat_completions") {
        const res = await fetchWithTimeout(`${addPathHint(provider.baseUrl, apiFormat)}/models`, {
          method: "GET",
          headers: fmt.headers(provider, apiKey),
        }, 20000);
        const text = await res.text();
        if (res.status === 200) {
          let count = 0;
          try {
            const parsed = JSON.parse(text);
            count = Array.isArray(parsed.data) ? parsed.data.length : Array.isArray(parsed.models) ? parsed.models.length : 0;
          } catch { /* 非 JSON 也算鉴权通过（有响应即可） */ }
          out.l2 = { ok: true, models: count, message: count ? `已识别 ${count} 个模型` : "鉴权通过" };
        } else if (res.status === 401 || res.status === 403) {
          out.l2 = { ok: false, message: `鉴权失败（${res.status}）：API Key 无效或权限不足` };
        } else {
          out.l2 = { ok: true, models: 0, message: `端点返回 ${res.status}，跳过模型列表（不影响调用）` };
        }
      } else {
        out.l2 = { ok: true, message: "该协议无 /models 端点，鉴权在 L3 的最小请求中一并验证" };
      }
    } catch (e) {
      out.l2 = { ok: false, message: `鉴权阶段失败：${e && e.message ? e.message : e}` };
    }

    // L3 格式能力：用配置的格式发一次真实小请求
    const testModel = modelId || (this.getConfig()["models.models"] || []).find((m) => m.providerId === provider.id && m.enabled !== false)?.modelId;
    if (!testModel) {
      out.l3 = { ok: false, message: "该供应商下没有启用的模型，先「拉取模型」或手动添加一个再测" };
      return out;
    }
    try {
      const req = makeRequest({
        system: "你是一个测试探针，只回一个词。",
        messages: [{ role: "user", content: "ping" }],
        model: testModel,
        maxTokens: 16,
        temperature: 0,
        effort: "off",
        reasoningEnabled: false,
      });
      const url = fmt.buildUrl(base);
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: fmt.headers(provider, apiKey),
        body: JSON.stringify(fmt.encode(req, provider)),
      }, 30000);
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        out.l3 = { ok: true, message: `格式可用（${apiFormat}），模型 ${testModel} 正常响应` };
      } else {
        const hint = guessFormatFromFailure(res.status, text);
        out.l3 = { ok: false, status: res.status, message: `HTTP ${res.status}：${text.slice(0, 200)}` };
        if (hint) out.suggestion = { apiFormat: hint.guess, reason: hint.reason };
      }
    } catch (e) {
      out.l3 = { ok: false, message: `请求失败：${e && e.message ? e.message : e}` };
    }
    return out;
  }

  /** 拉取上游模型列表（OpenAI 系） */
  async fetchModels(provider) {
    const fmt = FORMATS.chat_completions;
    const url = `${addPathHint(provider.baseUrl, "chat_completions")}/models`;
    const res = await fetchWithTimeout(url, { method: "GET", headers: fmt.headers(provider, provider.apiKeyRef ? frameworkConfig.decryptSecret(provider.apiKeyRef) || "" : provider.apiKey || "") }, 30000);
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("上游 /models 返回了非 JSON 内容");
    }
    const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
    return list.map((m) => (typeof m === "string" ? { id: m } : { id: m.id || m.name, owned: m.owned_by })).filter((m) => m.id);
  }
}

function gwProvider(cfg, gw) {
  return {
    id: "gw-local",
    name: "本机网关（AgentHub 反代）",
    kind: "gateway",
    baseUrl: cfg["models.gatewayUrl"] || gw.baseUrl || GATEWAY_DEFAULT,
    apiFormat: "chat_completions",
    apiKeyRef: "",
    quirks: {},
    enabled: true,
  };
}

function stripParam(body, param) {
  const out = { ...body };
  if (param === "reasoning_effort") delete out.reasoning_effort;
  else if (param === "reasoning") delete out.reasoning;
  else if (param === "thinking") delete out.thinking;
  else if (param === "response_format") delete out.response_format;
  else if (param === "stream_options") delete out.stream_options;
  else if (param === "temperature") delete out.temperature;
  else if (param === "max_tokens") {
    out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
  } else if (param === "max_completion_tokens") {
    out.max_tokens = out.max_completion_tokens;
    delete out.max_completion_tokens;
  } else delete out[param];
  return out;
}

function fetchWithTimeout(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal })
    .catch((e) => {
      if (e && e.name === "AbortError") throw new Error(`请求超时（${Math.round(ms / 1000)}s）`);
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { LlmClient, FORMATS, addPathHint, baseHealthUrl, GATEWAY_DEFAULT, gwProvider };
