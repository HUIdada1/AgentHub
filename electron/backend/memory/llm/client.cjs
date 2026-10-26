/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 模型调用统一入口：来源优先级（custom → degrade，默认序见 DEFAULT_SOURCE_ORDER）、
// 标签路由、三级思考强度合并、失败降级与重试、兼容性自动修正、用量记账。
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

/* 模型调用并发闸门：同一时刻最多 N 个请求在飞（默认 1，即顺序执行）。
   现网所有调用方（调度器任务队列一次只跑一个任务、任务内部也是串行循环）本就是顺序的；
   这里把「顺序」固化成进程级不变式——将来新增调用方误用并发时，请求在入口排队，
   不会同时打到上游（避免上游限流、连接堆积与主进程内存抬升）。
   获取/释放成对出现在 call() 的 try/finally 里，内部不存在递归调用 call 的路径，不会自等待。 */
const MAX_INFLIGHT = Math.max(1, Number(process.env.AGENTHUB_LLM_MAX_INFLIGHT || 0) || 1);
let inflight = 0;
const inflightWaiters = [];
async function acquireInflightSlot() {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return;
  }
  await new Promise((resolve) => inflightWaiters.push(resolve));
  inflight++;
}
function releaseInflightSlot() {
  if (inflight > 0) inflight--;
  const next = inflightWaiters.shift();
  if (next) next();
}

// 默认来源序（v1.83.0 起）：自定义供应商 → 降级档（内置托底）。
// 网关档（gateway / gw-local）随「反代网关」一起下线：设置页不再暴露，也不再参与解析。
const DEFAULT_SOURCE_ORDER = ["custom", "degrade"];
// 历史默认序（必须用集合，不能只认一个）：
//   v1.22.x 及之前：["gateway","custom","degrade"]
//   v1.23.0 ~ v1.82.2：["custom","gateway","degrade"]
//   v1.82.3 ~ v1.82.x：["custom","degrade","gateway"]
// 这些与「用户手动调过」在值上无法区分，只有把它们都列为历史默认，这批存量用户才会被归一化；
// 漏掉任何一条，对应的用户会永远停在旧顺序（改了默认序却毫无感知）。
const LEGACY_SOURCE_ORDERS = [
  ["gateway", "custom", "degrade"],
  ["custom", "gateway", "degrade"],
  ["custom", "degrade", "gateway"],
];

// 429/5xx 的退避梯度（毫秒）：第 3 次及以后固定走最后一档，避免退避无限增长
const RETRY_BACKOFF_MS = [2000, 10000, 30000];

/** 来源序归一：未存 / 存的还是任一历史默认序 → 新默认序；用户手动调过的顺序原样保留
 *  （展示与运行时共用，避免两套口径）。判断用「全等」而不是「包含」：
 *  包含式判断会把 ["gateway","degrade","custom"] 这类手动序悄悄重置掉。 */
function normalizeSourceOrder(stored) {
  if (!Array.isArray(stored) || !stored.length) return [...DEFAULT_SOURCE_ORDER];
  const legacy = LEGACY_SOURCE_ORDERS.some(
    (old) => old.length === stored.length && old.every((v, i) => v === stored[i]),
  );
  return legacy ? [...DEFAULT_SOURCE_ORDER] : stored;
}

// 任务未显式配路由时的默认标签。supersede（失效判定）/consolidate（去重合并）没有专属自动打标
//（guessTags 只产 light/dedup/classify/tag/extract/heavy/summarize/distill/profile），
// 默认借道同类任务标签，否则这两个任务无论模型池怎么配都「无可用模型」
const DEFAULT_TASK_TAGS = {
  extract: ["extract"],
  summarize: ["summarize"],
  tag: ["tag"],
  classify: ["classify"],
  supersede: ["supersede", "classify"],
  distill: ["distill"],
  consolidate: ["consolidate", "summarize", "distill"],
  profile: ["profile"],
  dedup: ["dedup"],
  // 提示词库的「优化提示词」：专属标签；用户没给任何模型打该标签时，
  // resolveCandidates 会走「全部启用模型兜底」，因此不会出现「无可用模型」
  optimize: ["optimize"],
};

/** 任务标签 → 中文名：错误提示是给用户看的，不能露 "distill" 这类英文标识
    （与自动化任务注册表的措辞保持一致，用户在两处看到的是同一套名字） */
const TASK_ZH = {
  extract: "抽取结构化信息",
  summarize: "生成摘要",
  tag: "自动打标签",
  classify: "项目归类建议",
  supersede: "失效判定",
  distill: "L2 蒸馏",
  consolidate: "去重合并",
  profile: "人格 / 偏好画像",
  dedup: "去重判定",
  optimize: "提示词优化",
};

function addPathHint(baseUrl, apiFormat) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return base;
  // 用户/导入配置里已带完整业务路径时原样保留，避免二次拼接出 /messages/v1 这类非法路径
  if (/\/messages$/.test(base)) return base;
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

  /** 按模型 id 取候选（任务级「指定模型」与单次调用的 preferModelId 共用）：
   *  找到返回 { source, provider, model }，找不到（模型被删/被禁、供应商被禁、网关未运行）返回 null。
   *  includeDisabled 只给试调/探测用——用户就是在那一行点了「真实调用」，禁用态也照他指的调。 */
  candidateByModelId(cfg, modelId, { pinProviderId = "", includeDisabled = false } = {}) {
    const providers = (cfg["models.providers"] || []).filter((p) => p.enabled !== false);
    const models = (cfg["models.models"] || []).filter((m) => includeDisabled || m.enabled !== false);
    const model = models.find((m) => m.modelId === modelId && (!pinProviderId || m.providerId === pinProviderId));
    if (!model) return null;
    if (model.providerId === "gw-local") {
      const gw = this.gatewayResolver();
      if (!gw || !gw.available) return null;
      return { source: "gateway", provider: gwProvider(cfg, gw), model };
    }
    const provider = providers.find((p) => p.id === model.providerId);
    return provider ? { source: "custom", provider, model } : null;
  }

  /** 组装可用模型池（来源序优先 + 任务级绑定 + 标签过滤 + 同来源内 priority 排序） */
  resolveCandidates(taskTag, opts = {}) {
    const cfg = this.getConfig();
    const routes = cfg["models.routing"] || [];
    const sourceOrder = normalizeSourceOrder(cfg["models.sourceOrder"]);
    const providers = (cfg["models.providers"] || []).filter((p) => p.enabled !== false);
    const models = (cfg["models.models"] || []).filter((m) => m.enabled !== false);
    const route = routes.find((r) => r.task === taskTag);
    const wantedTags = (route && Array.isArray(route.tags) && route.tags.length ? route.tags : DEFAULT_TASK_TAGS[taskTag] || [taskTag]).filter(Boolean);

    const tagSet = new Set(wantedTags);
    /** 按来源序组候选（网关 + 自定义 + degrade）：matchTags 传 null 表示不过滤标签（标签空链兜底用） */
    const collect = (matchTags, markFallback) => {
      const list = [];
      for (const source of sourceOrder) {
        if (source === "gateway") {
          const gw = this.gatewayResolver();
          if (!gw || !gw.available) continue;
          // tags 兜底空数组：config 导入只校验 models 是数组，条目缺 tags 字段时裸 .some 会 TypeError，
          // 所有 AI 任务随之全灭
          const gwModels = models.filter((m) => m.providerId === "gw-local" && (!matchTags || (m.tags || []).some((t) => matchTags.has(t))));
          for (const m of gwModels) list.push({ source: "gateway", provider: gwProvider(cfg, gw), model: m });
          if (!gwModels.length && gw.fallbackModel) {
            list.push(gwFallbackCandidate(cfg, gw));
          }
        } else if (source === "custom") {
          for (const p of providers) {
            for (const m of models.filter((m) => m.providerId === p.id && (!matchTags || (m.tags || []).some((t) => matchTags.has(t))))) {
              list.push({ source: "custom", provider: p, model: m });
            }
          }
        } else if (source === "degrade") {
          const d = cfg["models.degrade"];
          if (!d || d.enabled === false) continue;
          const p = providers.find((x) => x.id === d.providerId);
          const m = models.find((x) => x.modelId === d.modelId && (!d.providerId || x.providerId === d.providerId));
          if (p && m) list.push({ source: "degrade", provider: p, model: { ...m, reasoning: { enabled: d.effort && d.effort !== "off", effort: d.effort || "minimal" }, priority: 999 } });
        }
      }
      return markFallback ? list.map((c) => ({ ...c, model: { ...c.model, fallback: true } })) : list;
    };
    let out = collect(tagSet, false);
    // 标签只是默认匹配约定：没有带匹配标签的启用模型时，用全部启用模型兜底直接跑（degrade 不算标签匹配），
    // 候选打 fallback 标记供界面提示「换更强模型效果更好」，任务不再因标签缺失被跳过
    if (!out.some((c) => c.source !== "degrade")) {
      out = collect(null, true);
    }

    // 任务级绑定（route.providerId）：把候选限制到指定供应商（本机网关 = gw-local）。
    // 试调/能力探测带着 preferModelId 指名要某个模型，这里必须让路，否则测试的就不是用户点的那个模型。
    let pool = out;
    const pinProviderId = !opts.preferModelId && route && route.providerId ? String(route.providerId) : "";
    if (pinProviderId) {
      const fromPin = out.filter((c) => c.provider.id === pinProviderId);
      if (fromPin.length) {
        pool = fromPin;
      } else {
        // 指定了供应商但它名下没有带匹配标签的模型 → 用它全部启用模型兜底（用户指定了就用它，标签只是默认匹配约定）
        pool = [];
        if (pinProviderId === "gw-local") {
          const gw = this.gatewayResolver();
          if (gw && gw.available) {
            for (const m of models.filter((m) => m.providerId === "gw-local")) pool.push({ source: "gateway", provider: gwProvider(cfg, gw), model: m });
            if (!pool.length && gw.fallbackModel) {
              pool.push(gwFallbackCandidate(cfg, gw));
            }
          }
        } else {
          const p = providers.find((x) => x.id === pinProviderId);
          if (p) for (const m of models.filter((m) => m.providerId === p.id)) pool.push({ source: "custom", provider: p, model: m });
        }
      }
    }

    // 任务级绑定（route.modelId）：显式指定就是显式指定——标签只决定「没指定时挑谁」。
    // 此前这里只做置顶，而池子已被标签过滤清空（模型标签没打全/没打对）→ 置顶无从下手，
    // 于是「指定模型」成了一个选了不生效的空旋钮（蒸馏这类任务照样报「无可用模型」）。
    // 现在：指定的模型不在池里就补进来（仍尊重供应商绑定），再由下面的置顶挪到链首，其余候选留作降级。
    const pinModelId = !opts.preferModelId && route && route.modelId ? String(route.modelId) : "";
    if (pinModelId && !pool.some((c) => c.model.modelId === pinModelId)) {
      const cand = this.candidateByModelId(cfg, pinModelId, { pinProviderId });
      if (cand) pool = [...pool, cand];
    }
    // 单次调用指名模型（试调/真实调用）：同理补进池子，否则「测 A 模型」实际调的是链首的别的模型
    if (opts.preferModelId && !pool.some((c) => c.model.modelId === opts.preferModelId)) {
      const cand = this.candidateByModelId(cfg, String(opts.preferModelId), { includeDisabled: true });
      if (cand) pool = [...pool, cand];
    }

    // 排序：来源顺序优先（sourceOrder 循环序），同来源内按 priority 升序——
    // 此前全局按 priority 排，「来源优先级」只在数字撞车时才真正生效，与界面的承诺不符
    const srcIdx = new Map(sourceOrder.map((s, i) => [s, i]));
    pool.sort((a, b) => (srcIdx.get(a.source) ?? 9) - (srcIdx.get(b.source) ?? 9) || (a.model.priority || 10) - (b.model.priority || 10));
    // 指定模型置顶：任务路由的 modelId 或单次调用的 preferModelId（试调/探测）。
    // 置顶必须放在最后一排在排序之后做，否则会被 priority 排序重新冲掉
    const prefer = opts.preferModelId || (route && route.modelId) || "";
    if (prefer) {
      const i = pool.findIndex((c) => c.model.modelId === prefer);
      if (i > 0) pool.unshift(...pool.splice(i, 1));
    }
    return pool;
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
   * 调用模型（统一入口）：外层过并发闸门，内层 _callOnce 是原调用逻辑。
   * @param {object} input { task, system, messages, jsonMode, effort, maxTokens, timeoutSec }
   */
  async call(input) {
    await acquireInflightSlot();
    try {
      return await this._callOnce(input);
    } finally {
      releaseInflightSlot();
    }
  }

  async _callOnce(input) {
    const cfg = this.getConfig();
    const task = input.task || "summarize";
    const candidates = this.resolveCandidates(task, { preferModelId: input.preferModelId });
    if (!candidates.length) {
      const err = new Error(`没有可用于「${TASK_ZH[task] || task}」的模型：请到「设置 · 模型与网关」添加供应商与模型，或开启本机网关`);
      err.code = "no_model";
      this.emit({ type: "llm-fallback", reason: "no_model", task });
      throw err;
    }
    // 首选候选来自标签空链兜底时留痕：调用统计/时间线可归因「用了非标签匹配的模型」
    if (candidates.some((c) => c.model.fallback)) {
      this.emit({ type: "llm-fallback", reason: "tag_fallback", task });
    }
    const maxRetries = Math.max(0, Number(cfg["models.maxRetries"] ?? 3) || 0);
    const timeoutSec = Number(input.timeoutSec || cfg["models.timeout"] || 60);
    let lastError = null;
    const tried = [];

    for (let ci = 0; ci < candidates.length; ci++) {
      const cand = candidates[ci];
      const effort = this.effortFor(task, cand.model, input.effort);
      const apiFormat = cand.provider.apiFormat || "chat_completions";
      const fmt = FORMATS[apiFormat] || FORMATS.chat_completions;
      // Key 统一走 decryptSecret（明文直通、旧密文解密），不解密直接发 Bearer 必然 401——
      // 此前只有「测试供应商」路径解密，任务路径全用密文，生产环境任务全灭
      const apiKey = cand.provider.apiKeyRef
        ? frameworkConfig.decryptSecret(cand.provider.apiKeyRef) || ""
        : cand.provider.apiKey || "";
      const base = addPathHint(cand.provider.baseUrl || (cand.source === "gateway" ? GATEWAY_DEFAULT : ""), apiFormat);

      /* 把「上次被上游拒绝过」的参数翻译成能力位，让 encoder 这次就不发它（否则第二次调用必然再失败）。
         每次尝试都按最新怪癖记忆重建供应商视图：命中怪癖后重试必须真的换一种编码方式发出去。
         此前只在候选循环开头构建一次，剥离 system/reasoning 这类需要改走编码分支的怪癖时，
         重试请求体与原请求完全一致（stripParam 只删顶层字段，而 system 已被 encoder 合进 messages），必然再次失败。 */
      const buildProvider = () => {
        const memo = this.quirksMemo[cand.provider.id] || {};
        const dropped = memo.dropped || {};
        return {
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
      };

      const attempt = async (dropParam) => {
        const providerWithQuirks = buildProvider();
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
        }, timeoutSec * 1000, input.signal);
        const text = await res.text();
        return { status: res.status, text, latencyMs: Date.now() - t0, url };
      };

      for (let attemptIdx = 0; attemptIdx <= maxRetries; attemptIdx++) {
        try {
          let r = await attempt(null);
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
            // 顶层 system 不被接受：记成能力位，重试时 encoder 会改把 system 合进首条 user 消息
            if (offending === "system") memo.supportsSystemRole = false;
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
            // 剥离重试仍失败：后续的 401/403/404/400 判定与 lastError 必须基于
            // 重试后的真实状态，否则会把重试的 500 当成首次请求的状态来处理，
            // 换源/提示信息全部错乱
            r = retry;
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
            await sleep(RETRY_BACKOFF_MS[Math.min(attemptIdx, RETRY_BACKOFF_MS.length - 1)]);
            continue;
          }
          break;
        } catch (e) {
          lastError = e;
          if (attemptIdx < maxRetries) {
            await sleep(RETRY_BACKOFF_MS[Math.min(attemptIdx, RETRY_BACKOFF_MS.length - 1)]);
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

  /**
   * 流式调用：成功时逐段回调 onDelta(text)，结束时返回拼好的全文与用量。
   * 与 call() 的关系是「并列」而不是「替换」——call() 承载记忆中枢全部任务，
   * 为流式去重构它风险收益比不划算，这里只新增一条独立路径。
   *
   * 降级：_callOnceStream 判定上游不支持流式时抛 code:"stream_unsupported"，
   * 这里**先让出并发位**再走 call()（MAX_INFLIGHT=1，持有槽位再调 call 会死锁）。
   */
  async callStream(input, onDelta) {
    await acquireInflightSlot();
    let released = false;
    const release = () => { if (!released) { released = true; releaseInflightSlot(); } };
    try {
      return await this._callOnceStream(input, onDelta);
    } catch (e) {
      if (e && e.code === "stream_unsupported") {
        release();
        const r = await this.call(input);
        return { ...r, streamed: false };
      }
      throw e;
    } finally {
      release();
    }
  }

  async _callOnceStream(input, onDelta) {
    const cfg = this.getConfig();
    const task = input.task || "summarize";
    const candidates = this.resolveCandidates(task, { preferModelId: input.preferModelId });
    if (!candidates.length) {
      const err = new Error(`没有可用于「${TASK_ZH[task] || task}」的模型：请到「设置 · 模型与网关」添加供应商与模型，或开启本机网关`);
      err.code = "no_model";
      this.emit({ type: "llm-fallback", reason: "no_model", task });
      throw err;
    }
    const timeoutSec = Number(input.timeoutSec || cfg["models.timeout"] || 60);
    const tried = [];
    let lastError = null;
    let skipped = 0;

    for (const cand of candidates) {
      const memo = this.quirksMemo[cand.provider.id] || {};
      // 上次已经确认不支持流式：直接跳过，不浪费一次失败往返
      if (memo.noStream) { skipped++; continue; }

      const effort = this.effortFor(task, cand.model, input.effort);
      const apiFormat = cand.provider.apiFormat || "chat_completions";
      const fmt = FORMATS[apiFormat] || FORMATS.chat_completions;
      const apiKey = cand.provider.apiKeyRef
        ? frameworkConfig.decryptSecret(cand.provider.apiKeyRef) || ""
        : cand.provider.apiKey || "";
      const base = addPathHint(cand.provider.baseUrl || (cand.source === "gateway" ? GATEWAY_DEFAULT : ""), apiFormat);
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

      const req = makeRequest({
        system: input.system,
        messages: input.messages,
        model: cand.model.modelId,
        maxTokens: input.maxTokens || cand.model.maxTokens || 2048,
        temperature: input.temperature ?? cand.model.temperature ?? 0.2,
        effort,
        reasoningEnabled: cand.model.reasoning ? cand.model.reasoning.enabled !== false && effort !== "off" : effort !== "off",
        customBudget: cand.model.reasoning ? cand.model.reasoning.customBudget : null,
        stream: true,
        jsonMode: !!input.jsonMode,
      });
      const body = fmt.encode(req, providerWithQuirks);
      const url = fmt.buildUrl(base);

      const controller = new AbortController();
      let abortReason = "";
      const headerTimer = setTimeout(() => {
        abortReason = "timeout";
        try { controller.abort(); } catch { /* 已中止 */ }
      }, timeoutSec * 1000);
      const onExternal = () => {
        abortReason = "cancelled";
        try { controller.abort(); } catch { /* 已中止 */ }
      };
      if (input.signal) {
        if (input.signal.aborted) { abortReason = "cancelled"; controller.abort(); }
        else input.signal.addEventListener("abort", onExternal, { once: true });
      }

      let res;
      const t0 = Date.now();
      // 外部取消的监听必须一直挂到「读完整个流」：只在拿响应头期间挂，
      // 用户点取消时 controller 已经没人管了，流会继续读到天荒地老。
      let emitted = 0;
      try {
        try {
          res = await fetch(url, {
            method: "POST",
            headers: fmt.headers(providerWithQuirks, apiKey),
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (e) {
          if (abortReason === "cancelled") { const err = new Error("已取消"); err.code = "cancelled"; throw err; }
          if (e && e.name === "AbortError") { const err = new Error(`请求超时（${timeoutSec}s）`); err.code = "timeout"; throw err; }
          lastError = e;
          tried.push(`${cand.provider.name || cand.provider.id}/${cand.model.modelId}`);
          continue;
        } finally {
          // 首字节到了就撤掉「等响应头」的定时器；读流阶段的超时由 pumpSse 的 stall 定时器负责
          clearTimeout(headerTimer);
        }

        if (res.status < 200 || res.status >= 300) {
          let text = "";
          try { text = await res.text(); } catch { /* 读不出就算了 */ }
          // 上游抱怨 stream / stream_options：记成「该供应商不支持流式」，交给 callStream 回退非流式
          const offending = detectUnsupportedParam(res.status, text);
          const complainsStream = offending === "stream_options"
            || (res.status === 400 || res.status === 422) && /stream/i.test(text) && /unknown|unsupported|not support|invalid|unexpected|不支持/i.test(text);
          if (complainsStream) {
            this.quirksMemo[cand.provider.id] = { ...(this.quirksMemo[cand.provider.id] || {}), noStream: true };
            this.emit({ type: "provider-quirk", providerId: cand.provider.id, detail: "上游不支持流式输出，已自动回退非流式" });
            throw streamUnsupported(`HTTP ${res.status}：上游不接受 stream 参数`);
          }
          if (res.status === 401 || res.status === 403) {
            lastError = new Error(`鉴权失败（${res.status}）：检查 ${cand.provider.name || cand.provider.id} 的 API Key`);
            this.emit({ type: "provider-status", providerId: cand.provider.id, status: "offline", detail: lastError.message });
            break;
          }
          lastError = new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
          tried.push(`${cand.provider.name || cand.provider.id}/${cand.model.modelId}`);
          continue;
        }

        // 200 但回的是整包 JSON（部分反代无视 stream 参数）：不是流式，回退
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          this.quirksMemo[cand.provider.id] = { ...(this.quirksMemo[cand.provider.id] || {}), noStream: true };
          throw streamUnsupported("上游忽略了 stream 参数，返回的是整包 JSON");
        }

        try {
          const out = await pumpSse(res, apiFormat, (t) => { emitted++; if (onDelta) onDelta(t); });
          this._log({ provider: cand.provider.id, model: cand.model.modelId, task, tokensIn: out.usage.input, tokensOut: out.usage.output, ok: true, latencyMs: Date.now() - t0 });
          return {
            text: out.text,
            reasoning: "",
            usage: out.usage,
            finishReason: "stop",
            providerId: cand.provider.id,
            modelId: cand.model.modelId,
            effort,
            source: cand.source,
            streamed: true,
          };
        } catch (e) {
          // 用户主动取消 / 首字节超时：这两种必须在换源之前拦住，
          // 否则取消会被当成「流式中断」抛出去，界面显示成错误提示。
          if (abortReason === "cancelled") { const err = new Error("已取消"); err.code = "cancelled"; throw err; }
          if (abortReason === "timeout") { const err = new Error(`请求超时（${timeoutSec}s）`); err.code = "timeout"; throw err; }
          // 已经吐过字了：不能静默换源重来（界面里已有半截内容），交给上层清空后回退
          if (emitted > 0) {
            const err = new Error((e && e.message) || "流式中断");
            err.code = (e && e.code) || "stream_partial";
            err.partial = true;
            throw err;
          }
          lastError = e;
          tried.push(`${cand.provider.name || cand.provider.id}/${cand.model.modelId}`);
          continue;
        }
      } finally {
        if (input.signal) input.signal.removeEventListener("abort", onExternal);
      }
    }

    if (skipped > 0 && skipped === candidates.length) {
      throw streamUnsupported("已记忆的供应商都不支持流式输出");
    }
    const err = lastError || streamUnsupported("没有可用的流式来源");
    err.tried = tried;
    throw err;
  }

  _log(entry) {    try {
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

/** 网关未配置模型时的兜底候选（resolveCandidates 两处共用，避免字面量漂移） */
function gwFallbackCandidate(cfg, gw) {
  return {
    source: "gateway",
    provider: gwProvider(cfg, gw),
    model: {
      id: "gw-fallback",
      providerId: "gw-local",
      modelId: gw.fallbackModel,
      enabled: true,
      reasoning: { enabled: false, effort: "minimal" },
      tags: [],
      priority: 99,
    },
  };
}

function stripParam(body, param) {
  const out = { ...body };
  if (param === "reasoning_effort") delete out.reasoning_effort;
  else if (param === "reasoning") delete out.reasoning;
  else if (param === "thinking") delete out.thinking;
  else if (param === "response_format") delete out.response_format;
  else if (param === "stream_options") delete out.stream_options;
  // 剥离 stream 时必须连 stream_options 一起删：留着 include_usage 但没开流，上游会报参数非法
  else if (param === "stream") { delete out.stream; delete out.stream_options; }
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

// ===== 流式（SSE）=====
//
// 三套上游格式的增量字段与结束信号各不相同，且都夹着必须跳过的噪声帧。
// 差异集中在这几个纯函数里，读帧逻辑（pumpSse）与协议无关，调用方只认 { text, usage }。
//
// 为什么不做成 format 层的 decodeStream：format 层是「整包 encode/decode」的形状，
// 流式是「一帧一条」的事件流，两者共用同一份字段知识反而会把 format 层搞乱。
// 这里刻意与 proxy 的 SSE 实现「同源不同文件」——不抽共享层，避免动到网关转发路径。

/** 读间隔超过这个时间就判上游卡住。fetchWithTimeout 的定时器在**响应头到达时**就被清掉了，
 *  流式 body 完全没有超时保护，必须自己盯「多久没来新数据」。 */
const STREAM_STALL_MS = Math.max(5000, Number(process.env.AGENTHUB_LLM_STALL_MS || 0) || 20000);

function streamUnsupported(reason) {
  const e = new Error(reason || "该上游不支持流式输出");
  e.code = "stream_unsupported";
  return e;
}

/** 一帧的正文增量。思考/签名/工具参数帧一律不进正文。 */
function streamTextOf(apiFormat, obj) {
  if (!obj || typeof obj !== "object") return "";
  if (apiFormat === "anthropic") {
    if (obj.type === "content_block_delta" && obj.delta && obj.delta.type === "text_delta") {
      return typeof obj.delta.text === "string" ? obj.delta.text : "";
    }
    return "";
  }
  if (apiFormat === "responses") {
    // 注意：response.output_text.delta 是**事件类型名**，文本在 obj.delta
    if (obj.type === "response.output_text.delta") return typeof obj.delta === "string" ? obj.delta : "";
    return "";
  }
  // chat_completions：choices 可能是空数组（include_usage 的最后一帧），不能当异常
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const delta = choice && choice.delta;
  if (!delta) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/** 用量：三种格式各自的取法，累加进 acc */
function streamUsageOf(apiFormat, obj, acc) {
  if (!obj || typeof obj !== "object") return;
  if (apiFormat === "anthropic") {
    if (obj.type === "message_start" && obj.message && obj.message.usage) {
      const n = Number(obj.message.usage.input_tokens);
      if (Number.isFinite(n) && n > 0) acc.input = n;
    }
    if (obj.type === "message_delta" && obj.usage) {
      const n = Number(obj.usage.output_tokens);
      if (Number.isFinite(n) && n > 0) acc.output = n;
    }
    return;
  }
  if (apiFormat === "responses") {
    if (obj.type === "response.completed" && obj.response && obj.response.usage) {
      const u = obj.response.usage;
      const i = Number(u.input_tokens);
      const o = Number(u.output_tokens);
      if (Number.isFinite(i) && i > 0) acc.input = i;
      if (Number.isFinite(o) && o > 0) acc.output = o;
    }
    return;
  }
  if (obj.usage) {
    const i = Number(obj.usage.prompt_tokens);
    const o = Number(obj.usage.completion_tokens);
    if (Number.isFinite(i) && i > 0) acc.input = i;
    if (Number.isFinite(o) && o > 0) acc.output = o;
  }
}

/** 该帧是否表示流结束（chat_completions 另由 data:[DONE] 判定） */
function streamDoneOf(apiFormat, obj) {
  if (!obj || typeof obj !== "object") return false;
  if (apiFormat === "anthropic") return obj.type === "message_stop";
  if (apiFormat === "responses") return obj.type === "response.completed" || obj.type === "response.failed";
  return false;
}

/**
 * 读 SSE 响应体。按 \n 分帧（不要求 \n\n：不少反代把空行吞掉），跨 chunk 的半行留在 buf 里。
 * onText 每收到一段正文增量就调一次；返回值是拼好的全文与用量。
 */
async function pumpSse(res, apiFormat, onText) {
  if (!res.body || typeof res.body.getReader !== "function") throw streamUnsupported("上游没有返回可读的流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const usage = { input: 0, output: 0 };
  let buf = "";
  let full = "";
  let done = false;
  let stalled = false;
  let stallTimer = null;
  const touch = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      try { reader.cancel(); } catch { /* 已关闭 */ }
    }, STREAM_STALL_MS);
  };
  touch();
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      touch();
      buf += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, cut).replace(/\r$/, "");
        buf = buf.slice(cut + 1);
        if (!line || line.startsWith(":")) continue;        // 空行 / 心跳注释
        if (!line.startsWith("data:")) continue;            // event: / id: / retry: 一律忽略
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") { done = true; break; }
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        // 上游把错误写在帧里（HTTP 常是 200）：必须抛出去，否则会当成「模型返回空」
        if (obj && obj.type === "error") {
          const msg = (obj.error && (obj.error.message || obj.error.type)) || "上游在流中返回错误";
          const e = new Error(String(msg));
          e.code = "model_error";
          throw e;
        }
        const t = streamTextOf(apiFormat, obj);
        if (t) { full += t; try { onText(t); } catch { /* 回调异常不影响收流 */ } }
        streamUsageOf(apiFormat, obj, usage);
        if (streamDoneOf(apiFormat, obj)) { done = true; break; }
      }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    try { await reader.cancel(); } catch { /* 已关闭 */ }
  }
  if (stalled) {
    const e = new Error(`上游超过 ${Math.round(STREAM_STALL_MS / 1000)}s 没有返回新内容，已中断`);
    e.code = "stream_stall";
    throw e;
  }
  return { text: full, usage };
}

/**
 * 带超时的 fetch。
 * @param externalSignal 调用方（如「取消」）传入的中断信号。传了就要能区分「谁中断的」：
 *   外部取消必须抛 code:"cancelled"，否则会被上层当成「请求超时」，用户点取消却看到超时提示。
 */
function fetchWithTimeout(url, init, ms, externalSignal) {
  const controller = new AbortController();
  let abortedBy = "";
  const timer = setTimeout(() => { abortedBy = "timeout"; controller.abort(); }, ms);
  const onExternal = () => { abortedBy = "external"; controller.abort(); };
  if (externalSignal) {
    if (externalSignal.aborted) { abortedBy = "external"; controller.abort(); }
    else externalSignal.addEventListener("abort", onExternal, { once: true });
  }
  return fetch(url, { ...init, signal: controller.signal })
    .catch((e) => {
      if (abortedBy === "external") {
        const err = new Error("已取消");
        err.code = "cancelled";
        throw err;
      }
      if (e && e.name === "AbortError") throw new Error(`请求超时（${Math.round(ms / 1000)}s）`);
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternal);
    });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  LlmClient, FORMATS, addPathHint, baseHealthUrl, GATEWAY_DEFAULT, gwProvider,
  DEFAULT_TASK_TAGS, DEFAULT_SOURCE_ORDER, LEGACY_SOURCE_ORDERS, normalizeSourceOrder,
  // 流式解码的纯函数与读帧器：自测脚本要能单独验三种格式的增量字段、噪声帧与跨 chunk 分帧
  streamTextOf, streamUsageOf, streamDoneOf, pumpSse, STREAM_STALL_MS,
};
