// 反代网关 · Qoder 渠道适配器（qoder / qoder_intl 双区共用工厂）
//
// 与其它渠道最大的形状差异：**签名是每请求的**（见 qoderSigner.cjs），
// 因此 headers() 只返回非签名基础头，真正的签名发生在 chat() 内部、按账号现场完成。
// 绝不能照 WorkBuddy 的「静态头组」写法，也绝不能缓存签名结果（COSY 令牌含 requestId，每请求独立）。
//
// 上行协议：POST {gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?…&Encode=1
//   body  = Encode=1 自定义编码（wasm 产出，不可手工构造）
// 下行协议：SSE，每帧 data:{"headers":{…},"body":"<内层 JSON>","statusCode":"OK"}
//   内层即标准 OpenAI chat.completion.chunk（含 usage.credits）；收尾帧 body:"[DONE]"
//
// 依赖注入（fetchStream/pumpSse/httpJson/util 由 adapters.cjs 传入）避免循环 require。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

/**
 * Cosy-MachineOS 的取值口径：客户端用 Windows 内核版本号（实测 "10.0.26200.0"）。
 * os.release() 直接给这个值；非 Windows 平台回落到 platform+arch（服务端只做存在性校验）。
 */
function osVersion() {
  try {
    return process.platform === "win32" ? os.release() : `${process.platform}-${os.arch()}`;
  } catch {
    return "";
  }
}

/** 静态兜底模型表（catalog 不可用时的最小可用集，全部实测 format=openai）。
 *
 *  ⚠️ 按 product 隔离：这两个产品的模型 key 并不通用（CN 与 intl 是两套上游目录，
 *  同一个 key 往往只在一边存在）。此前是模块级单表、两个 product 共用，于是
 *  「没拉取过目录的一侧」会凭空宣称拥有另一侧的全部模型——modelOwners 据此把请求
 *  failover 到该侧，上游回 400 code=11102「model [x] service info not found」，
 *  表现为「模型明明在列表里、本机也能用，却时不时报当前模型不可用」（issue #74）。
 *  故兜底集也必须分产品；未列出的产品不给静态兜底（宁缺勿错，靠拉取目录）。 */
const STATIC_MODELS_BY_PRODUCT = {
  qoder: [
    { id: "auto", name: "Auto" },
    { id: "qfmodel", name: "Qwen3.8-Flash" },
    { id: "qmodel_38max", name: "Qwen3.8-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "q37fmodel", name: "Qwen3.7-Flash" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "dfmodel", name: "DeepSeek-Flash" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "gfmodel", name: "GLM-5.3-Flash" },
    { id: "gmodel", name: "GLM-5.3" },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "kmodel", name: "Kimi-K2.8-Preview" },
    { id: "kmodel_latest", name: "Kimi-K3" },
    { id: "mmodel", name: "MiniMax-M2.7" },
  ],
  // qoder_intl：无静态兜底（未实测过其目录；一旦误兜底就会把请求导向不存在的模型）
};

/** 兼容导出：默认（CN）静态表，供自测/外部引用 */
const STATIC_MODELS = STATIC_MODELS_BY_PRODUCT.qoder;

/** 按 product 取静态兜底集（未列出的产品为空——不跨产品借模型） */
function staticModelsOf(product) {
  return STATIC_MODELS_BY_PRODUCT[product] || [];
}

/** 请求侧默认场景（签名头 Cosy-Scene 由 wasm 置为 assistant；目录按场景分组） */
const DEFAULT_SCENE = "assistant";

/** 单个会话/请求 id：Qoder 要求 request_id 唯一（重复会被 code 103 拒绝） */
const newId = () => crypto.randomUUID();

/** 把 OpenAI messages 转成 Qoder 的 content 数组格式 */
function toQoderMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "user");
    if (!["system", "user", "assistant", "tool"].includes(role)) continue;
    let content = m.content;
    if (typeof content === "string") {
      content = [{ type: "text", text: content }];
    } else if (Array.isArray(content)) {
      content = content
        .map((part) => {
          if (!part || typeof part !== "object") return null;
          if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
          // 图片等多模态：Qoder 侧形态未验证，先原样透传 type/url 字段
          if (part.type === "image_url") return { type: "image_url", image_url: part.image_url };
          return null;
        })
        .filter(Boolean);
    } else {
      content = [];
    }
    const item = { role, content };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) item.tool_calls = m.tool_calls;
    if (m.tool_call_id) item.tool_call_id = m.tool_call_id;
    if (m.name) item.name = m.name;
    // 丢弃「无内容且无工具调用」的消息：空 content 数组对上游无意义，
    // 且部分模型会因空 content 报参数错误（自测发现：未知部件归一后即为空数组）
    const hasContent = Array.isArray(content) && content.length > 0;
    const hasTools = Array.isArray(item.tool_calls) && item.tool_calls.length > 0;
    if (!hasContent && !hasTools) continue;
    out.push(item);
  }
  return out;
}

/** tools 透传：OpenAI 形态 {type:"function", function:{…}} 实测可被上游接受 */
function toQoderTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t === "object" && t.type === "function" && t.function && t.function.name)
    .map((t) => ({ type: "function", function: t.function }));
}

/**
 * 工厂：deps = { fetchStream, pumpSse, httpJson, rules, auth, signer, store }
 * product：qoder（CN）/ qoder_intl（国际版）
 */
function makeQoder(product, deps) {
  const { fetchStream, pumpSse, httpJson, rules, auth, signer, store, util } = deps;
  // util 为必填：用于 hasConsumableDelta（流中断时的本地出线判定）。
  // 缺省时退回 require（生产环境由 adapters.cjs 注入；单测可直接传 util）
  const U = util || require("./util.cjs");
  const cfg = () => (rules.get("headers.json") || {})[product] || {};

  // ===== 签名会话池 =====
  // 为什么需要池（两个动机）：
  //   1) 根治泄漏——原先 chat() 每请求 createSession 且**从不 free**（代码注释自己写着
  //      "先不 free"却没有后续释放路径），wasm 内存只能靠 FinalizationRegistry 靠 GC 兜底，
  //      长驻进程不可靠；fetchModels 虽有 free 但每请求实例化本身也是浪费。
  //   2) 省延迟——免掉每请求的 generate_runtime_auth_fields + QoderContext wasm 实例化。
  // 设计要点：
  //   · 键 = uid|machineId|token：refresh 轮换出新 token 后自然换新会话，旧条目按 LRU 淘汰
  //   · 容量淘汰只挑 inUse=0 的空闲条目——流式响应可持续数分钟，绝不 free 正在流式使用的实例
  //   · 全忙时允许暂超容量（本轮不淘汰），下轮 acquire 再收——宁多勿崩
  const sessionPool = new Map(); // key -> { session, at, inUse }
  const SESSION_POOL_MAX = 12;

  /**
   * 从池里取（或新建）签名会话，返回 { session, release }。
   * 调用方在用完后（流读完/解密完）必须调 release()——它只递减 inUse，不销毁实例；
   * 销毁只发生在容量淘汰时。签名器不可用抛出的错误带 503/qoderSignerDown 标记（渠道级故障，不罚账号）。
   */
  async function acquireSession(account, secrets) {
    const uid = (account && account.uid) || "";
    const machineId = (account && account.meta && account.meta.machineId) || account.machineId || "";
    const token = (secrets && secrets.token) || "";
    const k = `${uid}|${machineId}|${token}`;
    let entry = sessionPool.get(k);
    if (!entry) {
      let session;
      try {
        session = await signer.createSession({ product, token, uid, machineId });
      } catch (e) {
        throw Object.assign(new Error(`Qoder 签名器不可用：${String((e && e.message) || e).slice(0, 160)}`), {
          status: 503,
          qoderSignerDown: true,
        });
      }
      entry = { session, at: Date.now(), inUse: 0 };
      sessionPool.set(k, entry);
      while (sessionPool.size > SESSION_POOL_MAX) {
        let evictKey = null;
        let oldest = Infinity;
        for (const [ek, ev] of sessionPool) {
          if (ev.inUse > 0) continue;
          if (ev.at < oldest) { oldest = ev.at; evictKey = ek; }
        }
        if (!evictKey) break; // 全忙：暂超容量
        const ev = sessionPool.get(evictKey);
        sessionPool.delete(evictKey);
        try { ev.session.free && ev.session.free(); } catch { /* 已释放 */ }
      }
    }
    entry.inUse += 1;
    entry.at = Date.now();
    return {
      session: entry.session,
      release() {
        entry.inUse = Math.max(0, entry.inUse - 1);
        entry.at = Date.now();
      },
    };
  }

  /** 目录索引：从 rules/catalog.json 读（fetchModels 写入），带缓存 */
  let catalogCache = { at: 0, byKey: new Map(), raw: null };
  function catalogIndex() {
    const file = path.join(rules.rulesDir(), "catalog.json");
    let st = 0;
    try { st = fs.statSync(file).mtimeMs; } catch { /* 无缓存 */ }
    if (catalogCache.raw && catalogCache.at === st) return catalogCache;
    const all = (() => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
    })();
    const entry = all[product];
    const byKey = new Map();
    for (const m of (entry && Array.isArray(entry.models) ? entry.models : [])) {
      if (m && m.id) byKey.set(String(m.id).toLowerCase(), m);
    }
    catalogCache = { at: st, byKey, raw: entry || null };
    return catalogCache;
  }

  /** 单个模型的目录元数据（缺失时给保守默认，绝不编造能力） */
  function modelMeta(key) {
    const hit = catalogIndex().byKey.get(String(key || "").toLowerCase());
    return hit || { id: key, name: key, capabilities: { reasoning: false, tools: true }, contextLength: 0, maxOutputTokens: 0 };
  }

  return {
    id: product,
    refreshWindowSec: 86400, // token 30 天；提前 24h 预刷新（dt- 非 JWT，靠落库的 expiresAt 判断）

    cfg,

    /**
     * 模型 id 清单（同步；管理页/路由用）：
     *   · 已拉取过目录 → **只认目录**。目录是该产品上游的真实清单，静态兜底表只是历史快照，
     *     并集会重新引入「上游已下架/本产品根本没有的 key」（issue #74 的幽灵模型）；
     *   · 未拉取过目录（目录为空）→ 才退回本 product 的静态兜底，保证首次可用性。
     */
    models() {
      // 注意用 Map 本身取 size：Map.keys() 返回的是迭代器，迭代器没有 size
      // （写成 `catalogIndex().byKey.keys()` 再判 .size 会恒为 undefined → 永远走兜底）
      const byKey = catalogIndex().byKey;
      if (byKey.size) return [...byKey.keys()];
      return staticModelsOf(product).map((m) => m.id);
    },

    /**
     * 拉取官方目录：解密本机 catalog-v6（零网络、绑定 uid）→ 整形为统一模型对象。
     * 对齐既有约定：拉取失败不写空（保留旧目录）；本实现无网络失败面，仅解密可能失败。
     */
    async fetchModels(account, secrets) {
      const uid = (account && account.uid) || "";
      if (!uid) return { ok: false, message: "缺少 uid，无法定位模型目录缓存" };
      const blob = auth.readCatalogBlob(product, uid);
      if (!blob) return { ok: false, message: "本机无模型目录缓存（该客户端尚未登录使用过）" };
      let entry;
      try {
        entry = await acquireSession(account, secrets);
      } catch (e) {
        return { ok: false, message: `签名器不可用：${String((e && e.message) || e).slice(0, 120)}` };
      }
      let json;
      try {
        json = JSON.parse(entry.session.modelCacheDecrypt(blob, uid));
      } catch (e) {
        return { ok: false, message: `目录解密失败：${String((e && e.message) || e).slice(0, 120)}` };
      } finally {
        entry.release();
      }
      const scene = json[DEFAULT_SCENE] || json.chat || [];
      const seen = new Map();
      // 目录按场景分组，同一 key 在不同场景可能重复：chat/assistant 优先，其余补漏
      const order = [DEFAULT_SCENE, "chat", "quest", "developer", ...Object.keys(json)];
      for (const sc of order) {
        const arr = json[sc];
        if (!Array.isArray(arr)) continue;
        for (const m of arr) {
          if (!m || !m.key || seen.has(m.key)) continue;
          if (m.enable === false) continue;
          const ctxTiers = m.context_config && typeof m.context_config === "object" ? Object.values(m.context_config) : [];
          const ctxMax = ctxTiers.reduce((n, t) => Math.max(n, Number((t && t.token_count) || 0)), 0);
          const efforts = (() => {
            const e = m.thinking_config && m.thinking_config.enabled && m.thinking_config.enabled.efforts;
            return e && typeof e === "object" ? Object.keys(e) : [];
          })();
          seen.set(m.key, {
            id: String(m.key),
            name: String(m.display_name || m.key),
            rate: m.price_factor != null ? Number(m.price_factor) : null,
            capabilities: { reasoning: !!m.is_reasoning, tools: true, images: !!m.is_vl },
            reasoning: efforts.length
              ? { effort: null, defaultEffort: "", supportedEfforts: efforts }
              : null,
            contextLength: ctxMax || Number(m.max_input_tokens) || 0,
            maxOutputTokens: 0,
            // 附加展示字段（管理页可用；不影响既有契约）
            isFree: m.is_free === true || Number(m.price_factor) === 0,
            scene: sc,
          });
        }
      }
      const models = [...seen.values()];
      if (!models.length) return { ok: false, message: "目录为空（结构可能已变更）" };
      return { ok: true, models, scene: DEFAULT_SCENE, modelCount: Object.keys(seen).length };
    },

    /** 非签名基础头（签名头由 chat() 内 wasm 产出，禁止在此构造） */
    headers() {
      const c = cfg();
      return {
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": c.userAgent || "qoder/0.4.3",
      };
    },

    /** OpenAI body → QoderInferRequest（明文结构；Encode=1 由 wasm 编码） */
    rewriteBody(model, body, account, meta) {
      const key = String(model || "").toLowerCase();
      const m = modelMeta(key);
      const requestId = (meta && meta.requestId) || newId();
      const sessionId = (meta && meta.sessionId) || newId();
      return {
        session_id: sessionId,
        source_session_id: "",
        request_id: requestId,
        request_set_id: requestId,
        model_config: {
          key,
          display_name: m.name || key,
          model: "",
          format: "openai",
          is_vl: !!(m.capabilities && m.capabilities.images),
          is_reasoning: !!(m.capabilities && m.capabilities.reasoning),
          api_key: "",
          url: "",
          source: "system",
          max_input_tokens: m.contextLength || 180000,
        },
        messages: toQoderMessages(body && body.messages),
        tools: toQoderTools(body && body.tools),
        business: {},
        // 透传可选采样参数（上游为 OpenAI 形态，实测接受）
        ...(body && body.temperature != null ? { temperature: body.temperature } : {}),
        ...(body && body.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
        ...(body && body.stop != null ? { stop: body.stop } : {}),
        ...(body && body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
      };
    },

    /**
     * 对话主流程：按账号现场签名 → POST → SSE 信封解包 → 内层 OpenAI chunk 直通 emit。
     * 错误分两类：
     *   · HTTP 层（fetchStream 抛，带 status）→ 交给 server 的分类器
     *   · 信封层（HTTP 200 但 statusCode≠OK）→ 在此识别，返回 planLimit 或抛带 status 的错误
     */
    async chat({ account, secrets, model, body, emit, meta }) {
      const c = cfg();
      const gateway = c.gateway || auth.PRODUCTS[product].gateway;
      const machineId = (account.meta && account.meta.machineId) || account.machineId || "";
      const uid = account.uid || "";
      const key = String(model || "").toLowerCase();

      // rewriteBody 不依赖签名会话，先做——签名器不可用（503）时不必白跑一遍改写
      const req = this.rewriteBody(key, body, account, meta);

      // 客户端未安装/结构变更：渠道级故障，不罚账号（acquireSession 已带 503 标记）
      const entry = await acquireSession(account, secrets);
      const session = entry.session;

      // prepareInferRequest 抛错必须归还 inUse：池语义下该条目若卡在 inUse>0，
      // LRU 淘汰永远挑不到它，等效于池容量永久缩水
      let signed;
      try {
        signed = session.prepareInferRequest(gateway, JSON.stringify(req), key, "system");
      } catch (e) {
        entry.release();
        throw e;
      }
      const headers = { ...signed.headers };
      const payloadLen = signed.body.length;

      let resp = null;
      let cancelTimer = () => {};
      const result = { status: 200, planLimit: false };
      let settled = false;
      let sentDelta = false;
      try {
        const r = await fetchStream(signed.url, {
          method: "POST",
          headers,
          body: signed.body,
          // 签名覆盖 path+query：重定向会让签名失效，必须报错而非跟随（qoder 客户端同款做法）
          redirect: "error",
          firstByteMs: c.firstByteMs || 30000,
        });
        resp = r.resp;
        cancelTimer = r.cancelTimer;
      } finally {
        // release 必须覆盖 fetchStream 抛错路径：429/超时/HTTP 错误时流程在
        // 到达流读取之前就中断，旧实现（free 只在 pump finally）会漏掉这类会话
        entry.release();
      }
      try {
        await pumpSse(resp, (_event, raw) => {
          if (!settled) { settled = true; cancelTimer(); }
          if (!raw) return;
          let env = null;
          try { env = JSON.parse(raw); } catch { return; }
          // 信封层错误：HTTP 200 但 statusCode 非 OK
          const code = String(env.statusCode || "");
          if (code && code !== "OK") {
            const inner = (() => { try { return JSON.parse(env.body); } catch { return null; } })();
            const innerCode = inner && (inner.code || inner.errorCode);
            const msg = (inner && (inner.message || inner.error)) || code;
            if (String(innerCode) === "101" || /Signature invalid/i.test(String(msg))) {
              // 版本漂移：既非账号故障也非 WAF，零冷却 + 渠道级告警
              emit({ type: "error", status: 403, code: "signature_invalid", message: "Qoder 签名被拒（客户端版本可能已变更，请更新适配器）" });
              return;
            }
            if (String(innerCode) === "116" || /quota exceeded/i.test(String(msg))) {
              result.planLimit = true;
              emit({ type: "error", status: 402, code: 116, message: msg });
              return;
            }
            const st = code === "UNAUTHORIZED" || /token|unauthor/i.test(String(msg)) ? 401 : 502;
            emit({ type: "error", status: st, code: innerCode || code, message: String(msg) });
            return;
          }
          const text = env.body;
          if (typeof text !== "string") return;
          if (text === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          let chunk = null;
          try { chunk = JSON.parse(text); } catch { return; }
          // 实测：上游会在流中间夹一帧 body:"null"（原样字面量，不是空串），
          // JSON.parse 得到 null —— 不加守卫会在 chunk.choices 抛 TypeError，
          // 表现为整条流以内部异常中断（而非可读错误）。这类帧无内容，直接跳过。
          if (!chunk || typeof chunk !== "object") return;
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) {
              // 只发原始 delta：噪声字段剥离与「已出线」判定（server 侧的 sentDelta/ttftMs）
              // 由 server.cjs 的统一 emit 包装负责（见 server.cjs:428-447），此处不重复剥离。
              // 本适配器内的 sentDelta 仅用于「流中断时能否如实上报」的本地决策（见下方 catch），
              // 判据用 util.hasConsumableDelta（正文/思考/工具调用三类真实可消费字段），
              // 避免只带 role 或私有扩展字段的噪声帧误判为"已出内容"而封死换号自救。
              if (U.hasConsumableDelta(choice.delta)) sentDelta = true;
              emit({ type: "delta", delta: choice.delta });
            }
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (chunk.usage) {
            emit({
              type: "usage",
              usage: {
                ...chunk.usage,
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              },
            });
          }
        });
      } catch (e) {
        // 流中断：已出内容则如实上报，未出内容交给外层换号
        if (sentDelta) {
          emit({ type: "error", status: 502, message: `流中断：${String((e && e.message) || e).slice(0, 120)}` });
          return result;
        }
        throw e;
      } finally {
        cancelTimer();
        // 会话不在这里 free：它已归还池（fetch 完成即 release），销毁只在池淘汰时发生
      }
      return result;
    },

    /**
     * 额度查询：GET {quotaBase}/api/v2/quota/usage?requestId=<uuid>（纯 Bearer，无需签名）。
     * ⚠ 两区端点域不同（实测）：CN 走 gateway 亦可，**INTL 只在 openapi**（gateway 返回 404）。
     *   故由 cfg.quotaBase 显式指定，回退顺序 gateway → openApi。
     * 口径：可用额度 = userQuota.remaining + addOnQuota.remaining（FIFO：先扣套餐再扣每日领取）。
     */
    async queryCredits(account, secrets) {
      const c = cfg();
      const bases = [c.quotaBase, c.gateway, c.openApi].filter(Boolean).filter((b, i, arr) => arr.indexOf(b) === i);
      let last = null;
      for (const base of bases) {
        const url = `${String(base).replace(/\/+$/, "")}${c.quotaPath || "/api/v2/quota/usage"}?requestId=${newId()}`;
        const r = await httpJson(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${secrets.token}`, Accept: "application/json", "user-agent": c.userAgent || "qoder/0.4.3" },
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401) return { authError: true, message: "凭证失效（token is not active）" };
        if (r.ok && r.data) {
          const d = r.data;
          const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
          const remaining = num(d.userQuota && d.userQuota.remaining) + num(d.addOnQuota && d.addOnQuota.remaining);
          const expiresAt = num(d.expiresAt);
          if (d.userQuota || d.addOnQuota) {
            return {
              credits: Math.round(remaining * 100) / 100,
              expiresAt,
              userType: d.userType || "",
              detail: { userQuota: d.userQuota || null, addOnQuota: d.addOnQuota || null },
            };
          }
          if (Number.isFinite(Number(d.credits))) return { credits: Number(d.credits), expiresAt };
          return { unavailable: true, message: "额度结构未识别（接口可能已变更）" };
        }
        last = r;
      }
      return { error: `额度查询失败 HTTP ${(last && last.status) || 0}（已试 ${bases.length} 个域）` };
    },

    /**
     * 每日领取 100 Credits（每日 10:00 UTC+8 刷新，领取后 30 天有效）。
     *
     * 实测打通的两步（2026-10-04 验证成功：addOnQuota 100→200，campaign CLAIMABLE→CLAIMED）：
     *   ① GET  {openApi}/sash/api/v1/me/campaigns
     *        → campaigns[] 里筛 actionType=CLAIM_BENEFIT && claimStatus=CLAIMABLE
     *   ② POST {openApi}/sash/api/v1/me/campaigns/{campaignId}/claim   body={}
     *        → {grantId, status:"CLAIMED", replayed:bool, benefit:{kind,amount,validity}}
     *
     * ⚠ 三个必须做对的地方（都是实测踩出来的）：
     *   · 路径参数是 **campaignId（UUID）**，不是 campaignKey（用 key 会 400 FIELD_VALIDATION_FAILED）
     *   · 必须带 **Cosy-ClientType** 这一组头，否则服务端**静默**返回 claimable:false
     *     （表现为"今天没有可领活动"，实际是鉴权降级——极易误判为无活动）
     *   · Cosy-Machine{Token,Type,Code} 由客户端自带 runtime-info.exe 生成（见 qoderAuth.readRiskIdentity）
     *
     * 幂等性：重复领取返回 replayed:true 且 status:"CLAIMED" —— 这是**成功**语义（已领过），
     * 必须按 already 处理，不能报错，否则每天第二次调用会误报失败。
     */
    async checkin(account, secrets) {
      const c = this.cfg();
      const base = c.openApi || c.quotaBase || "https://openapi.qoder.com.cn";
      const uid = (account && account.uid) || "";
      const risk = auth.readRiskIdentity ? auth.readRiskIdentity(product, uid) : null;
      if (!risk) {
        // 风控身份拿不到（客户端未装/已卸载）→ 如实回报，不降级尝试（降级必然 401/静默 false）
        return { ok: false, unavailable: true, message: "需安装 Qoder 客户端（领取接口要求其风控身份 runtime-info.exe）" };
      }
      const hdrs = {
        Authorization: `Bearer ${secrets.token}`,
        Accept: "application/json",
        "User-Agent": c.userAgent || "Qoder",
        "Cosy-ClientType": "10",
        "Cosy-Version": c.cosyVersion || "0.4.3",
        "Cosy-MachineId": (account.meta && account.meta.machineId) || account.machineId || "",
        "Cosy-MachineOS": osVersion(),
        "Cosy-MachineHostname": os.hostname(),
        "Cosy-MachineToken": risk.machineToken,
        "Cosy-MachineType": risk.machineType,
        "Cosy-MachineCode": risk.machineCode,
      };
      const listUrl = `${String(base).replace(/\/+$/, "")}/sash/api/v1/me/campaigns`;
      let list;
      try {
        list = await httpJson(listUrl, { method: "GET", headers: hdrs });
      } catch (e) {
        return { ok: false, message: `活动列表请求失败：${(e && e.message) || e}` };
      }
      if (list.status === 401 || list.status === 403) return { authError: true, message: "凭证失效（活动接口不接受该 token）" };
      if (!list.ok || !list.data) return { ok: false, message: `活动列表 HTTP ${list.status}` };
      const campaigns = Array.isArray(list.data.campaigns) ? list.data.campaigns : [];
      const claimable = campaigns.filter((x) => x && x.actionType === "CLAIM_BENEFIT" && x.claimStatus === "CLAIMABLE" && x.campaignId);
      if (!claimable.length) {
        // 无 CLAIMABLE：先判「窗口未开」再判「已领完」。
        // 每日 Credits 的领取窗口每天 10:00（UTC+8）重置：10:00 前昨日实例仍显示 CLAIMED，
        // 此时若自动签到照常标记"今日已完成"，就会错过 10:05 起的新窗口（一天只跑一次的设计）。
        // 判据：存在与可领活动同类型（CLAIM_BENEFIT）且 endAt 在未来的已领实例
        //   → 返回 deferred + retryAt（= endAt + 5 分钟抖动），调度器据此延后重试。
        // 取**最早**的未来 endAt：列表混有其它活动的远期实例时，取错会把重试时刻
        // 带偏到几天后，连累其它渠道的每日签到一起停摆。
        const claimed = campaigns.filter((x) => x && x.claimStatus === "CLAIMED");
        const nowSec = Math.floor(Date.now() / 1000);
        let nextWindowSec = Infinity;
        for (const x of campaigns) {
          if (!x || x.claimStatus !== "CLAIMED" || x.actionType !== "CLAIM_BENEFIT") continue;
          const end = Number(x.endAt);
          if (end > nowSec && end < nextWindowSec) nextWindowSec = end;
        }
        if (Number.isFinite(nextWindowSec)) {
          const retryAt = nextWindowSec * 1000 + 5 * 60000;
          return {
            ok: true,
            already: true,
            deferred: true,
            retryAt,
            message: `当前窗口已领取；下一窗口开放后（每日 10:00 UTC+8）自动重试`,
          };
        }
        return {
          ok: true,
          already: true,
          message: claimed.length ? "今日已领取" : "当前没有可领取的活动",
        };
      }
      let claimedAny = 0;
      let replayedAny = 0;
      let lastMsg = "";
      for (const cmp of claimable) {
        const url = `${String(base).replace(/\/+$/, "")}/sash/api/v1/me/campaigns/${encodeURIComponent(cmp.campaignId)}/claim`;
        let r;
        try {
          r = await httpJson(url, { method: "POST", headers: { ...hdrs, "Content-Type": "application/json" }, body: "{}" });
        } catch (e) {
          lastMsg = `领取请求失败：${(e && e.message) || e}`;
          continue;
        }
        if (r.status === 401 || r.status === 403) return { authError: true, message: "凭证失效" };
        if (!r.ok || !r.data) {
          const code = r.data && r.data.errorCode;
          // GRANT_NOT_FOUND 是活动页预期的可重试分支（服务端状态未就绪），非致命
          lastMsg = code === "GRANT_NOT_FOUND" ? "活动尚未就绪（GRANT_NOT_FOUND），请稍后重试" : `领取失败 HTTP ${r.status}${code ? ` ${code}` : ""}`;
          continue;
        }
        if (r.data.replayed === true) {
          // 幂等重复：服务端说"这次没发新额度"。必须标 already —— 否则上层会把"已领过"
          // 当成"刚领到"，UI 每次点击都报"领取成功"。
          replayedAny += 1;
          lastMsg = "今日已领取";
          continue;
        }
        if (r.data.status === "CLAIMED") {
          claimedAny += 1;
          const amt = r.data.benefit && Number(r.data.benefit.amount);
          lastMsg = Number.isFinite(amt) ? `领取成功 +${amt} Credits` : "领取成功";
        } else {
          lastMsg = `领取未生效（status=${r.data.status || "unknown"}）`;
        }
      }
      if (claimedAny > 0) return { ok: true, message: lastMsg || "领取成功" };
      // 全部命中 replayed：视为"今日已领取"（ok=true + already=true，UI 按幂等展示）
      if (replayedAny > 0) return { ok: true, already: true, message: lastMsg || "今日已领取" };
      return { ok: false, message: lastMsg || "领取失败" };
    },

    /**
     * 签到状态探测：读活动列表（与 checkin 同一接口），只判断有无可领，不触发领取。
     * 供号池页「一键签到」在真正领取前展示状态。
     */
    async checkinStatus(account, secrets) {
      const c = this.cfg();
      const base = c.openApi || "https://openapi.qoder.com.cn";
      const uid = (account && account.uid) || "";
      const risk = auth.readRiskIdentity ? auth.readRiskIdentity(product, uid) : null;
      if (!risk) return { unavailable: true, message: "需安装 Qoder 客户端（风控身份不可用）" };
      const hdrs = {
        Authorization: `Bearer ${secrets.token}`,
        Accept: "application/json",
        "User-Agent": c.userAgent || "Qoder",
        "Cosy-ClientType": "10",
        "Cosy-Version": c.cosyVersion || "0.4.3",
        "Cosy-MachineId": (account.meta && account.meta.machineId) || account.machineId || "",
        "Cosy-MachineOS": osVersion(),
        "Cosy-MachineHostname": os.hostname(),
        "Cosy-MachineToken": risk.machineToken,
        "Cosy-MachineType": risk.machineType,
        "Cosy-MachineCode": risk.machineCode,
      };
      try {
        const list = await httpJson(`${String(base).replace(/\/+$/, "")}/sash/api/v1/me/campaigns`, { method: "GET", headers: hdrs });
        if (list.status === 401 || list.status === 403) return { authError: true, message: "凭证失效" };
        if (!list.ok || !list.data) return { unavailable: true, message: `活动列表 HTTP ${list.status}` };
        const campaigns = Array.isArray(list.data.campaigns) ? list.data.campaigns : [];
        const n = campaigns.filter((x) => x && x.actionType === "CLAIM_BENEFIT" && x.claimStatus === "CLAIMABLE").length;
        if (n > 0) return { ok: true, claimable: n, message: `有 ${n} 个活动可领取` };
        const claimed = campaigns.filter((x) => x && x.claimStatus === "CLAIMED").length;
        return { ok: true, already: true, message: claimed ? "今日已领取" : "当前无可领取活动" };
      } catch (e) {
        return { unavailable: true, message: `活动列表请求失败：${(e && e.message) || e}` };
      }
    },

    /**
     * 续期：POST {openApi}/api/v1/deviceToken/refresh（见 qoderAuth.refreshDeviceToken）。
     * refresh_token 轮换制：新旧两个 token 必须同时返回并落库。
     */
    async refreshToken(account, secrets) {
      if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请从本机重新导入" };
      const machineId = (account.meta && account.meta.machineId) || account.machineId || "";
      const r = await auth.refreshDeviceToken(product, secrets.refreshToken, machineId);
      if (!r.ok) return { ok: false, message: r.message || `刷新失败 HTTP ${r.status}` };
      return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt, refreshTokenExpiresAt: r.refreshTokenExpiresAt };
    },
  };
}

module.exports = { makeQoder, STATIC_MODELS, DEFAULT_SCENE, toQoderMessages, toQoderTools };
