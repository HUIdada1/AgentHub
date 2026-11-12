/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 标准自定义供应商执行器。禁止依赖混合 adapters 或供应商私有实现。
"use strict";
const util = require("../../proxy/util.cjs");
const transport = require("../../proxy/transport-context.cjs");
const { timeoutMs, firstByteBudgetMs, fetchStream, httpJson, pumpSse } = require("../../network/http.cjs");
const { pumpSseAwaited } = require("../../network/sse-reader.cjs");
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** extraBody 深合并：只递归普通对象，数组与标量整体替换。
 *  拼接语义会让用户写 {"stop":["a"]} 时拿到意外的并集，替换语义才可预测。 */
function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isPlainObj(base) || !isPlainObj(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}
function isPlainObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 用户 extraBody 里允许落到上游的键。这张白名单的存在理由不是「上游会忽略未知字段」——
 *  严格端点对未知参数回 400，那会把整条渠道打成不可用，而客户端只会看到"打不通"。
 *  后续每加一档协议形态都要在这里补它自己那一行，与出站互转模块同时补，缺一不可。 */
const NATIVE_KEYS_BY_KIND = {
  openai_compat: ["parallel_tool_calls"],
};

/** 覆盖权从低到高：上游请求形 < 用户在提供商里手填的 extraBody。
 *  最后一级必须最高，否则用户没法用配置把某个字段按住。
 *  被白名单挡下的键如实写日志——静默丢才是问题，语义损失本身是设计里认下的。 */
function withNative(request, body, kind, row) {
  const src = body && body.extraBody;
  const native = {};
  const dropped = [];
  if (isPlainObj(src)) {
    const allow = NATIVE_KEYS_BY_KIND[kind] || [];
    for (const [k, v] of Object.entries(src)) {
      if (allow.includes(k)) native[k] = v;
      else dropped.push(k);
    }
  }
  if (dropped.length) console.warn(`[gateway] ${kind} 形态上游没有这些协议原生字段，已丢弃: ${dropped.join("、")}`);
  const merged = Object.keys(native).length ? deepMerge(request, native) : request;
  return deepMerge(merged, row.extraBody || {});
}

/** models_json 条目归一：字符串 = 裸模型名（上游同名）；对象 = 带元数据与别名。
 *  {model(客户端裸名), upstream(上游真名，缺省=model), name/rate/capabilities/contextLength/maxOutputTokens} */
function compatModelEntries(row) {
  const out = [];
  for (const m of Array.isArray(row.models) ? row.models : []) {
    if (typeof m === "string") {
      if (m.trim()) out.push({ client: m.trim(), upstream: m.trim(), entry: null });
      continue;
    }
    if (!isPlainObj(m) || !m.model) continue;
    const client = String(m.model).trim();
    if (!client) continue;
    out.push({ client, upstream: String(m.upstream || client).trim(), entry: m });
  }
  return out;
}

/** 提供商模型的 catalog 形状（与内置渠道的 catalogMap 同构）：合并目录那一步按 `entry.id` 在
 *  `catMaps[entry.sources[0]]` 里查元数据，而提供商条目的 id 是带前缀的 `slug/client`，所以两种键
 *  都铺上（带前缀的给合并目录查，裸名给只知道自己模型清单的调用方用）。
 *  提供商因此走的是与内置渠道完全同一条富化路径，不第二套实现。 */
function providerCatalogMap(row) {
  const map = new Map();
  for (const e of compatModelEntries(row)) {
    const m = e.entry || {};
    const meta = {
      id: e.client,
      name: m.name || undefined,
      rate: m.rate != null ? m.rate : undefined,
      capabilities: m.capabilities || {},
      contextLength: Number(m.contextLength) || 0,
      maxOutputTokens: Number(m.maxOutputTokens) || 0,
    };
    map.set(e.client.toLowerCase(), meta);
    map.set(`${row.id}/${e.client}`.toLowerCase(), meta);
  }
  return map;
}

/** 限流措辞（429 语义：现在慢一点，短退避换号即可）。刻意**不含裸 quota**——
 *  中转站大量用 "rate limit quota exceeded" / "requests per minute quota exceeded" 报限流。 */
const RATE_LIMIT_HINT = /rate[_ ]?limit|too many requests|requests per (minute|second)|请求过于频繁|限流|\brpm\b|\btpm\b/i;
/** 欠费措辞（402 语义：这个号没钱了，才该 coolAccount("credit") 冷却到次日）。
 *  OpenAI 官方的 insufficient_quota 与「You exceeded your current quota」配的是 429 码，
 *  但语义确实是欠费，故按措辞收在这里——所以判序必须是「先限流措辞、再欠费措辞」。 */
const BILLING_HINT = /insufficient_quota|insufficient[_ ]?balance|quota[_ ]?exhausted|quota[_ ]?exceeded|exceeded[^.]{0,24}quota|out of credits|no credits|balance|exhausted|欠费|余额|积分不足|积分耗尽/i;

/** 上游错误 → HTTP 语义。中转站的错误体形状远比内置渠道散，这里只认 OpenAI 形状 + 常见措辞：
 *  余额/配额类判 402（换号）、鉴权类判 401（冷却该 Key）、其余按码透传，认不出的一律 502（可换号）。 */
function statusFromCompatError(errObj, data) {
  const raw = String((errObj && (errObj.type || errObj.code)) || "");
  const msg = String((errObj && errObj.message) || (data && data.message) || "");
  const text = `${raw} ${msg}`;
  // 限流必须排在欠费之前：原来只按裸 "quota" 判 402，把 "rate limit quota exceeded" 这类
  // 限流也算成欠费 → planLimit → pool.coolAccount("credit") 把账号冷却到次日 04:00，
  // 一个好号被按「没余额」静默跳过一整天，池子可用容量骤降（本 PR 复查发现）。
  // 两条正则互斥：限流那条不含裸 quota，欠费那条含 insufficient_quota
  if (RATE_LIMIT_HINT.test(text)) return 429;
  if (BILLING_HINT.test(text)) return 402;
  if (/auth|api[_ ]?key|invalid[_ ]?key|unauthorized/i.test(text)) return 401;
  const n = Number(errObj && errObj.code);
  if (n === 429 || n === 401 || n === 404 || n === 400 || n === 402 || (n >= 500 && n < 600)) return n;
  return 502;
}

/** 出站端点统一在这里拼：`base_url` 存的是**不含 /v1 的根**（归一化侧保证），所以 /v1 必须由这里补。
 *  真机实测（一家只开 /v1/messages 的中转站）：只拼 leaf 会打到它的前端页面——回 200 + text/html，
 *  比 404 更难归因。规则只写这一处：换协议只换 leaf。 */
function compatUrl(base, leaf) {
  // 完整端点形态（normalizeBaseUrl 不剥裸 /chat/completions）：该站点不挂 /v1 前缀，
  // chat 主链路直用 base；其余 leaf 无从推导，退回「剥掉叶子再补 /v1/leaf」——
  // 辅助端点（models 探测等）在纯根挂载站上本就常缺，可达性让位于对话主链路
  if (/\/chat\/completions$/i.test(base)) {
    if (leaf === "chat/completions") return base;
    return `${base.replace(/\/chat\/completions$/i, "")}/v1/${leaf}`;
  }
  // 基址已带版本段（智谱 /api/paas/v4、火山 /api/v3）时不再补 /v1：否则会拼成
  // /v4/v1/chat/completions 这类恒 404 的地址。/v1 不会走到这里（normalizeBaseUrl 已剥），
  // 所以这条规则只对 v2+ 生效。
  if (/\/v[2-9]\d*$/.test(base)) return `${base}/${leaf}`;
  return `${base}/v1/${leaf}`;
}

function makeOpenaiCompat(row, opts) {
  const entries = compatModelEntries(row);
  const chatUrl = compatUrl(row.baseUrl, "chat/completions");
  // 首字节预算函数可注入（opts.firstByteBudgetMs），只为自测能把 30s 缩短到秒级复现
  // 「首事件不解除预算 → 长回答被掐断」这条现场；生产路径一律用模块内那份口径。
  // 与 autoclawDeps 注入 firstByteBudgetMs 是同一个先例，不新造第二套预算算法
  const budgetOf = opts && typeof opts.firstByteBudgetMs === "function" ? opts.firstByteBudgetMs : firstByteBudgetMs;
  // 客户端名 → 上游真名 / → 条目。别名与模型名同等参与解析（别名不进 /v1/models，
  // 但客户端拿它发请求必须能命中），所以两张表都要把 aliases 铺进去。
  const upstreamByClient = new Map();
  const entryByClient = new Map();
  for (const e of entries) {
    upstreamByClient.set(e.client.toLowerCase(), e.upstream);
    entryByClient.set(e.client.toLowerCase(), e);
    for (const a of (e.entry && Array.isArray(e.entry.aliases) ? e.entry.aliases : [])) {
      const k = String(a || "").toLowerCase();
      if (!k) continue;
      upstreamByClient.set(k, e.upstream);
      entryByClient.set(k, e);
    }
  }
  /** 剥掉自家的 `slug/` 前缀（那是路由信息，上游听不懂） */
  const stripPrefix = (clientModel) => {
    const s = String(clientModel || "");
    return s.slice(0, row.id.length + 1).toLowerCase() === `${row.id}/`.toLowerCase() ? s.slice(row.id.length + 1) : s;
  };
  return {
    /** 提供商没有 rules/headers.json 那套 UA/指纹伪装：头 = 标准 JSON + Bearer + 用户自定义覆盖 */
    headers(secrets) {
      const h = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${secrets.token || ""}`,
      };
      for (const [k, v] of Object.entries(row.extraHeaders || {})) h[String(k)] = String(v);
      return h;
    },

    /** 客户端模型名 → 上游真名：先剥自家的 `slug/` 前缀，再查条目配的 upstream（模型名与别名同表）。
     *  目录外模型原样透传：用户显式点名了提供商，而中转站实际开放的模型常常领先于它的清单
     *  （内置渠道同款"透传试错"语义）。 */
    upstreamFor(clientModel) {
      const s = stripPrefix(clientModel);
      return upstreamByClient.get(s.toLowerCase()) || s;
    },

    /** 客户端模型名（或别名）→ 该条目的元数据；查不到回 null，调用方按"无目录元数据"处理 */
    entryFor(clientModel) {
      return entryByClient.get(stripPrefix(clientModel).toLowerCase()) || null;
    },

    models() {
      return entries.map((e) => e.client);
    },

    modelEntries() {
      return entries;
    },

    /** 拉上游自己的清单（GET {base}/v1/models）：中转站大多支持，失败如实回错，
     *  由 UI 引导手填——真没有模型目录接口的站是少数，替上游预判会拒掉有能力的那批。
     *  形参沿用本文件所有适配器同一条 fetchModels(account, secrets) 调用面，不另立一套。 */
    async fetchModels(account, secrets) {
      const r = await httpJson(compatUrl(row.baseUrl, "models"), { method: "GET", headers: this.headers(secrets || {}) })
        .catch((e) => ({ ok: false, status: 0, data: null, text: String((e && e.message) || e) }));
      if (!r.ok) {
        return {
          ok: false,
          message: `HTTP ${r.status || 0} ${(r.text || "").slice(0, 200)}` +
            (r.status === 404 ? "（该上游没有模型目录接口，请在模型清单里手填）" : ""),
        };
      }
      const list = (r.data && (Array.isArray(r.data) ? r.data : r.data.data)) || [];
      const models = list.map((m) => String((m && (m.id ?? m.model ?? m.name)) || "")).filter(Boolean);
      return { ok: true, models };
    },

    /** 思考档位按该模型声明的支持集降级（与内置渠道同一个 util，档位词表也同源）：
     *  客户端要 low 而上游只有 medium/high 时，透传过去是一个 400，降级才可用。 */
    applyReasoning(model, out) {
      const entry = this.entryFor(model);
      util.normalizeReasoningEffort(out, entry && entry.entry && entry.entry.reasoning);
      return out;
    },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      out.model = this.upstreamFor(model);
      out.stream = true; // 一律流式打上游，非流式由 server 侧 Aggregator 本地聚合（见 chat() 注释）
      if (!isPlainObj(out.stream_options)) out.stream_options = {};
      out.stream_options.include_usage = true;
      this.applyReasoning(model, out);
      // 网关自己注入的内部字段，上游不认（内置渠道同款剔除清单）
      delete out.conversation_id;
      delete out.conversationId;
      delete out.prompt_cache_key;
      // 内部载体不能外泄：跟着 {...body} 原样发给上游，上游会收到一个字面叫 extraBody 的未知字段
      delete out.extraBody;
      return withNative(out, body, "openai_compat", row);
    },

    async chat(ctx) {
      return this.chatOpenai(ctx);
    },

    async chatAwaited(ctx) {
      return this.chatOpenai({ ...ctx, awaitEvents: true });
    },

    /** OpenAI 协议 1:1 透传 */
    async chatOpenai({ secrets, model, body, emit, awaitEvents = false }) {
      const payload = JSON.stringify(this.rewriteBody(model, body));
      // 首字节预算按 prompt 规模给（与内置渠道同一条口径），不再吃 fetchStream 的固定 30s 缺省
      const { resp, cancelTimer } = await fetchStream(chatUrl, {
        method: "POST", headers: this.headers(secrets), body: payload,
        firstByteMs: budgetOf(payload),
      });
      const result = { status: 200, planLimit: false };
      // 首个字节达标即解除首字节预算计时器：漏这一步会让计时器在整个流期间一直武装，
      // 到点 abort 掉 resp.body，把一条正常的长回答掐成「HTTP 200 + 半截内容」——客户端与
      // 请求明细都显示 200，被误读成「上游只回了这一点」（issue #107 的根因）。
      // 本文件其余内置渠道（workbuddy / raccoon / zcode / qoder / autoclaw）都在首事件里这么做，
      // 这里是同一条纪律；finally 那次是「一个字节都没到时」的兜底。
      let settled = false;
      const settle = () => { if (!settled) { settled = true; cancelTimer(); } };
      try {
        // 少数中转站无视 stream:true、直接回一整个 JSON：SseScanner 找不到 data: 行会一条都不产出，
        // 客户端就拿到 200 空响应。这里按 content-type 单独走非流式分支，别让它静默变空。
        const ctype = String(resp.headers.get("content-type") || "");
        if (!ctype.includes("event-stream")) {
          settle(); // 非流式形态没有"首事件"，读到正文即达标；否则读大 body 期间同样会被 abort
          const text = await transport.readText(resp, 16 * 1024 * 1024, timeoutMs("httpJsonTimeoutMs", 60000));
          const data = parseJson(text);
          if (!data) throw Object.assign(new Error(`上游返回非 JSON（${text.slice(0, 200)}）`), { status: 502 });
          if (awaitEvents) {
            const events = [];
            this.emitWholeResponse(data, event => events.push(event), result);
            for (const event of events) await emit(event);
          } else this.emitWholeResponse(data, emit, result);
          return result;
        }
        if (awaitEvents) {
          await pumpSseAwaited(resp, async (_event, raw) => {
            settle();
            if (raw === "[DONE]") { await emit({ type: "finish", reason: "" }); return; }
            const data = parseJson(raw);
            if (!data) return;
            if (data.error) {
              const status = statusFromCompatError(data.error, data);
              if (status === 402) result.planLimit = true;
              await emit({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
              return;
            }
            const choice = Array.isArray(data.choices) && data.choices[0];
            if (choice?.delta && Object.keys(choice.delta).length) await emit({ type: "delta", delta: choice.delta });
            if (choice?.message && Object.keys(choice.message).length) await emit({ type: "delta", delta: choice.message });
            if (choice?.finish_reason) await emit({ type: "finish", reason: choice.finish_reason });
            if (data.usage) await emit({ type: "usage", usage: compatUsage(data.usage) });
          }, { signal: transport.current()?.signal, idleMs: timeoutMs("streamIdleMs", 300000) });
          return result;
        }
        await pumpSse(resp, (_event, raw) => {
          settle();
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          const data = parseJson(raw);
          if (!data) return;
          if (data.error) {
            const status = statusFromCompatError(data.error, data);
            if (status === 402) result.planLimit = true;
            emit({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.message && Object.keys(choice.message).length) emit({ type: "delta", delta: choice.message });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) emit({ type: "usage", usage: compatUsage(data.usage) });
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    /** 非流式上游响应 → 同一套 emit 词汇（role 帧 + 正文 + tool_calls + usage + finish） */
    emitWholeResponse(data, emit, result) {
      if (data.error) {
        const status = statusFromCompatError(data.error, data);
        if (status === 402) result.planLimit = true;
        emit({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
        return;
      }
      const choice = Array.isArray(data.choices) && data.choices[0];
      if (choice && choice.message && Object.keys(choice.message).length) emit({ type: "delta", delta: choice.message });
      if (choice && choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
      if (data.usage) emit({ type: "usage", usage: compatUsage(data.usage) });
    },

    // 提供商是 API Key 直连：没有刷新链路，也没有"余额"这个概念。
    // 刻意不定义 queryCredits —— credits 的三条刷新入口靠它缺席来跳过（见 credits.cjs 的 creditsCapable），
    // 补一个假的就会拿用户的第三方 Key 去打一个不存在的余额接口。
    async refreshToken() {
      return { ok: false, noRefresh: true, message: "该渠道为 API Key 直连，无自动刷新；Key 失效请换新" };
    },
    async userInfo() {
      return { uid: "", name: "" };
    },
  };
}

/** 中转站的 usage 归一：完整对象照旧透传（保留 prompt_tokens_details.cached_tokens 等扩展字段），
 *  三个计数按本项目口径落定，并认 input_tokens/output_tokens 那套别名——兼容站两套混用是实测，
 *  total 缺席时自己补，否则记账那边拿到 0 会把「上游没报」显示成「这次没花 token」。 */
function compatUsage(u) {
  const usage = {
    ...u,
    prompt_tokens: Number(u.prompt_tokens ?? u.input_tokens) || 0,
    completion_tokens: Number(u.completion_tokens ?? u.output_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
  };
  if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return usage;
}


module.exports = { makeOpenaiCompat, compatUrl, statusFromCompatError, compatModelEntries, providerCatalogMap };
