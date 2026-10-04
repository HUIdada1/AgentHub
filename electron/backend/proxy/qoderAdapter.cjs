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

/** 静态兜底模型表（catalog 不可用时的最小可用集，全部实测 format=openai） */
const STATIC_MODELS = [
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
];

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

    /** 静态 + 目录缓存并集（同步；管理页/路由用） */
    models() {
      const ids = new Set(STATIC_MODELS.map((m) => m.id));
      for (const k of catalogIndex().byKey.keys()) ids.add(k);
      return [...ids];
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
      let session;
      try {
        session = await signer.createSession({ product, token: secrets.token, uid, machineId: (account.meta && account.meta.machineId) || account.machineId });
      } catch (e) {
        return { ok: false, message: `签名器不可用：${String((e && e.message) || e).slice(0, 120)}` };
      }
      let json;
      try {
        json = JSON.parse(session.modelCacheDecrypt(blob, uid));
      } catch (e) {
        return { ok: false, message: `目录解密失败：${String((e && e.message) || e).slice(0, 120)}` };
      } finally {
        session.free && session.free();
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

      let session;
      try {
        session = await signer.createSession({ product, token: secrets.token, uid, machineId });
      } catch (e) {
        // 客户端未安装/结构变更：渠道级故障，不罚账号
        throw Object.assign(new Error(`Qoder 签名器不可用：${String((e && e.message) || e).slice(0, 160)}`), {
          status: 503,
          qoderSignerDown: true,
        });
      }

      const req = this.rewriteBody(key, body, account, meta);
      const signed = session.prepareInferRequest(gateway, JSON.stringify(req), key, "system");
      const headers = { ...signed.headers };
      const payloadLen = signed.body.length;

      let resp = null;
      let cancelTimer = () => {};
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
        // session 需要在流读完后释放，这里先不 free
      }

      const result = { status: 200, planLimit: false };
      let settled = false;
      let sentDelta = false;
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
        try { session.free && session.free(); } catch { /* 忽略 */ }
      }
      return result;
    },

    /**
     * 额度查询：GET {gateway}/api/v2/quota/usage?requestId=<uuid>（纯 Bearer，无需签名）。
     * 口径：可用额度 = userQuota.remaining + addOnQuota.remaining（FIFO：先扣套餐再扣每日领取）。
     */
    async queryCredits(account, secrets) {
      const c = cfg();
      const gateway = c.gateway || auth.PRODUCTS[product].gateway;
      const url = `${gateway}/api/v2/quota/usage?requestId=${newId()}`;
      const r = await httpJson(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${secrets.token}`, Accept: "application/json", "user-agent": c.userAgent || "qoder/0.4.3" },
      });
      if (r.status === 401) return { authError: true, message: "凭证失效（token is not active）" };
      if (!r.ok || !r.data) return { error: `额度查询失败 HTTP ${r.status}` };
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
      // 形态兜底：上游若改成扁平结构
      if (Number.isFinite(Number(d.credits))) return { credits: Number(d.credits), expiresAt };
      return { unavailable: true, message: "额度结构未识别（接口可能已变更）" };
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
