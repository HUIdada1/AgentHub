// 反代网关 · 渠道适配器（方案 §6.3 IR 内核 + §2 协议事实基线）
// 进线 OpenAI body → 归一 → 渠道改写 → 上游 fetch → SSE 事件流转换 → 统一 OpenAI 输出
// 三渠道（trae / workbuddy / workbuddy_ai）差异收敛为「配置（rules/headers.json）+ 改写函数」，
// WorkBuddy CN 与国际版共享适配器核心，配置层隔离、代码零复制（方案 §2.3）
"use strict";
const crypto = require("node:crypto");
const rules = require("./rules.cjs");
const util = require("./util.cjs");

const FIRST_BYTE_MS = 10000; // 首字节 10s 超时判失败（方案 §2.2 联调坑）
const STREAM_IDLE_MS = 300000; // 流中读超时 300s

// ===== HTTP 基础 =====

/** 流式请求：首字节超时内必须拿到响应头并开始产出，否则 abort 判失败（可故障转移） */
async function fetchStream(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_MS);
  let resp;
  try {
    resp = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    throw Object.assign(new Error(e.name === "AbortError" ? "上游首字节超时（10s）" : `网络错误：${e.message}`), { network: true });
  }
  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text().catch(() => "");
    const err = Object.assign(new Error(`上游 HTTP ${resp.status}：${text.slice(0, 200)}`), { status: resp.status, body: text });
    throw err;
  }
  return { resp, cancelTimer: () => clearTimeout(timer) };
}

/** 普通 JSON 请求（额度查询 / token 刷新），15s 总超时 */
async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应留原文 */ }
    return { status: resp.status, ok: resp.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 逐块读 SSE：web stream 异步迭代 + 空闲 300s 判死；客户端断连后继续消费至 EOF（保 usage 完整） */
async function pumpSse(resp, onEvent) {
  const scanner = new util.SseScanner(onEvent);
  const decoder = new TextDecoder();
  const reader = resp.body.getReader();
  for (;;) {
    const read = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("流中读超时（300s）"), { idleTimeout: true })), STREAM_IDLE_MS)),
    ]);
    if (read.done) break;
    scanner.feed(decoder.decode(read.value, { stream: true }));
  }
  scanner.feed(decoder.decode());
  scanner.flush();
}

/** 账号级稳定指纹：device_id（15 位数字）/ machine_id（64 hex），同账号多次请求保持一致 */
function deviceIds(account) {
  const h = crypto.createHash("sha256").update(String(account.id || account.uid || "anon")).digest("hex");
  const digits = h.replace(/[a-f]/g, "").padEnd(15, "0").slice(0, 15);
  return { deviceId: digits, machineId: h };
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ===== Trae SOLO CN（方案 §2.1） =====

const trae = {
  id: "trae",

  cfg() {
    return rules.get("headers.json").trae;
  },

  /** 模型显示名 → (config_name, model_name)；映射表外置热加载，未命中原样透传 */
  mapModel(model) {
    const map = rules.get("model_map.json") || {};
    const hit = map[model];
    if (Array.isArray(hit) && hit.length >= 2) return { configName: String(hit[0]), modelName: String(hit[1]) };
    return { configName: model, modelName: model };
  },

  models() {
    return Object.keys(rules.get("model_map.json") || {});
  },

  /** 完整请求头指纹（逐字段对齐参考项目实证抓包，缺任何一项都可能被上游风控识别为非官方客户端） */
  headers(account, secrets) {
    const c = this.cfg();
    const { deviceId, machineId } = deviceIds(account);
    const tid = util.traceId(); // "00-<hex32>-<hex32>-01"
    return {
      "content-type": "application/json",
      "accept": "*/*",
      "accept-language": "zh-CN,zh;q=0.9",
      "user-agent": c.userAgent,
      "authorization": `Cloud-IDE-JWT ${secrets.token}`,
      "x-ide-token": secrets.token,
      "x-cloudide-token": secrets.token,
      "x-app-id": c.appId,
      "x-app-version": "default",
      "x-app-version-code": c.ideVersionCode,
      "x-ide-version": c.ideVersion,
      "x-ide-version-code": c.ideVersionCode,
      "x-ide-version-type": "stable",
      "x-device-type": "windows",
      "x-device-brand": "CREFG-XX",
      "x-device-cpu": "Intel",
      "x-device-id": deviceId,
      "x-machine-id": machineId,
      "x-os-version": "Windows 11 Home China",
      "request-traffic-type": "prod",
      "package-type": "stable_cn",
      "x-lgw-req-sdk-type": "3",
      "x-lscbd-aid": "787976",
      "x-lscbd-platform": "windows",
      "x-ss-dp": "787976",
      "app-version": c.ideVersion,
      "x-custom-trace-id": tid.slice(3, 19),
      "x-flow-traceparent": `04-${tid.slice(3, 35)}-${crypto.randomBytes(16).toString("hex")}-01`,
      "x-tt-trace-id": tid,
      "x-request-id": `req_${crypto.randomUUID().replace(/-/g, "")}`,
      // referer 在 chat() 里按实际请求 URL 覆盖（同源伪装）
    };
  },

  /** OpenAI body → llm_utils_chat 改写（对齐参考项目 prepare_llm_chat_body） */
  rewriteBody(model, body, account) {
    const c = this.cfg();
    const { configName, modelName } = this.mapModel(model);
    const { deviceId, machineId } = deviceIds(account);
    const out = { ...body };
    // 消息内容数组化：content string → [{type:text,text:...}]
    out.messages = (body.messages || []).map((m) => {
      const msg = { ...m };
      if (typeof msg.content === "string") msg.content = [{ type: "text", text: msg.content }];
      // assistant tool_calls：function → function_call，空 name 条目剔除
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        msg.tool_calls = msg.tool_calls
          .filter((tc) => tc && tc.function && tc.function.name)
          .map((tc) => ({
            id: tc.id,
            type: "function",
            function_call: { name: tc.function.name, arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}) },
          }));
        if (!msg.tool_calls.length) delete msg.tool_calls;
      }
      return msg;
    });
    // tools[].function.parameters object → JSON string
    if (Array.isArray(out.tools)) {
      out.tools = out.tools.map((t) => {
        if (t && t.function && t.function.parameters && typeof t.function.parameters === "object") {
          return { ...t, function: { ...t.function, parameters: JSON.stringify(t.function.parameters) } };
        }
        return t;
      });
    }
    // tool_choice 归一化（对齐参考项目）："none"（字符串或对象）→ 同时删除 tools/functions；
    // {type:function} → name 字符串；{type:auto/required} → 字符串
    const tc = out.tool_choice;
    const tcType = typeof tc === "string" ? tc : tc && typeof tc === "object" ? tc.type : "";
    if (tcType === "none") {
      delete out.tools;
      delete out.functions;
      out.tool_choice = "none";
    } else if (tc && typeof tc === "object") {
      out.tool_choice = (tc.function && tc.function.name) || tcType || "auto";
    }
    // 必填注入字段（方案 §2.1，18 项）
    out.config_name = configName;
    out.model_name = modelName;
    out.stream = true; // 强制流式，非流式本地聚合
    out.function = "solo_work_lite";
    out.max_tokens = 4096;
    out.conversation_id = util.uuid();
    out.user_id = account.uid || "";
    out.session_id = util.uuid();
    out.device_id = deviceId;
    out.machine_id = machineId;
    out.project_id = util.uuid();
    out.workspace_id = "e04cdd";
    out.prompt_max_tokens = 168000;
    out.mode = "FunctionCall";
    out.ide_version = c.ideVersion;
    out.ide_version_code = c.ideVersionCode;
    out.app_id = c.appId;
    out.package_type = "stable_cn";
    delete out.model;
    return out;
  },

  /**
   * 对话主流程：emit 结构化事件（delta/usage/finish/error），返回上游级结果供换号决策
   * 官方域优先，网络层失败回退社区镜像域（方案 §2.1 镜像兜底）
   */
  async chat({ account, secrets, model, body, emit }) {
    const c = this.cfg();
    const payload = JSON.stringify(this.rewriteBody(model, body, account));
    const base = this.headers(account, secrets);
    let lastErr = null;
    for (const url of [c.chatUrl, c.mirrorChatUrl]) {
      if (!url) continue;
      try {
        // referer 与请求 URL 同源（参考项目实证：伪装成同源请求，恒为 <host>/api/agent/v3/llm_utils_chat）
        return await this.chatOnce(url, { ...base, referer: url }, payload, model, emit);
      } catch (e) {
        lastErr = e;
        // HTTP 状态类错误（4xx/5xx）不换镜像，直接交给上层分类；网络错误才回退镜像
        if (!e.network) throw e;
      }
    }
    throw lastErr || new Error("上游不可达");
  },

  async chatOnce(url, headers, payload, model, emit) {
    const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: payload });
    let settled = false;
    const result = { status: 200, planLimit: false };
    try {
      await pumpSse(resp, (event, raw) => {
        if (!settled) {
          settled = true;
          cancelTimer(); // 首个 SSE 事件到达 = 首字节达标
        }
        const data = parseJson(raw);
        if (!data) return;
        const ev = event || data.event || data.type || "";
        if (ev === "output" || ev === "thought") {
          const delta = {};
          if (typeof data.response === "string") delta.content = data.response;
          else if (typeof data.content === "string") delta.content = data.content;
          if (typeof data.reasoning_content === "string") delta.reasoning_content = data.reasoning_content;
          // 工具调用差量：function_call → function，剥 namespace / partial_arguments
          if (Array.isArray(data.tool_calls)) {
            delta.tool_calls = data.tool_calls.map((tc, i) => {
              const fc = tc.function_call || tc.function || {};
              return {
                index: tc.index != null ? tc.index : i,
                id: tc.id,
                type: "function",
                function: { name: fc.name || "", arguments: fc.arguments || "" },
              };
            });
          }
          if (Object.keys(delta).length) emit({ type: "delta", delta });
        } else if (ev === "token_usage") {
          const usage = {
            prompt_tokens: Number(data.prompt_tokens ?? data.prompt ?? 0) || 0,
            completion_tokens: Number(data.completion_tokens ?? data.completion ?? 0) || 0,
            total_tokens: Number(data.total_tokens ?? data.total ?? 0) || 0,
          };
          if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          emit({ type: "usage", usage });
        } else if (ev === "done") {
          emit({ type: "finish", reason: data.finish_reason || data.finishReason || "stop" });
        } else if (ev === "error") {
          // code:1005 = 积分不足 PlanLimit（方案 §2.1）
          const code = Number(data.code) || 0;
          if (code === 1005) result.planLimit = true;
          emit({ type: "error", status: code === 1005 ? 402 : 502, code, message: data.message || data.msg || `上游错误 ${code}` });
        }
        // metadata / timing_cost / extra_info 忽略
      });
    } finally {
      cancelTimer();
    }
    return result;
  },

  /** 额度查询：ide_user_ent_usage（208/209 分包），宽容解析余额与到期 */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    const r = await httpJson(c.creditsUrl, {
      method: "POST",
      headers: this.headers(account, secrets),
      body: JSON.stringify({ product_ids: [208, 209] }),
    });
    if (r.status === 401) return { authError: true };
    if (!r.ok || !r.data) throw new Error(`额度查询失败 HTTP ${r.status}`);
    const credits = Number(util.dig(r.data, /remain|balance|left|available|total_credit|credits|quota/i)) || 0;
    const expiresAt = util.toMs(util.dig(r.data, /expire|end_time|deadline|valid_until/i));
    return { credits, expiresAt };
  },

  /** Token 刷新：ExchangeToken（对齐参考项目：ClientID + RefreshToken + ClientSecret "-"，x-cloudide-token 空串） */
  async refreshToken(account, secrets) {
    const c = this.cfg();
    if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
    const r = await httpJson(c.exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": c.userAgent,
        "x-cloudide-token": "",
      },
      body: JSON.stringify({ ClientID: c.clientId, RefreshToken: secrets.refreshToken, ClientSecret: "-", UserID: "" }),
    });
    const d = r.data && (r.data.data || r.data);
    if (r.ok && d && (r.data.code === 0 || r.data.code == null) && (d.access_token || d.accessToken)) {
      let token = String(d.access_token || d.accessToken);
      token = token.replace(/^Cloud-IDE-JWT\s+/i, "");
      return {
        ok: true,
        token,
        refreshToken: d.refresh_token || d.refreshToken ? String(d.refresh_token || d.refreshToken) : secrets.refreshToken,
      };
    }
    return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || `刷新失败 HTTP ${r.status}` };
  },

  /** 用户信息（OAuth 回调后补全 uid/昵称） */
  async userInfo(token) {
    const c = this.cfg();
    const r = await httpJson(c.userInfoUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Cloud-IDE-JWT ${token}`, "user-agent": c.userAgent },
      body: "{}",
    });
    const d = r.data && (r.data.data || r.data);
    if (r.ok && d) {
      return {
        uid: String(d.id || d.user_id || d.uid || util.jwtDecode(token).uid || ""),
        name: String(d.name || d.nickname || d.user_name || ""),
      };
    }
    const dec = util.jwtDecode(token);
    return { uid: dec.uid, name: "" };
  },
};

// ===== WorkBuddy CN / AI 双实例（方案 §2.2/§2.3，共享适配器核心） =====

function makeWorkBuddy(channelId) {
  return {
    id: channelId,

    cfg() {
      return rules.get("headers.json")[channelId];
    },

    models() {
      const m = rules.get("wb_models.json") || {};
      return Array.isArray(m[channelId]) ? m[channelId] : [];
    },

    /** 头部三铁律：① Origin/Referer 按区域必带且与请求 URL 同源（参考项目实证：CN = copilot.tencent.com
     *  本体 + /v2/chat/completions，国际 = www.workbuddy.ai 同路径）；② 缺省字段显式 X-No-* 占位
     *  （X-Domain 有值才发、无值改发 X-No-Department-Info，二者不并存）；③ UA 伪装。
     *  红线：chat 请求绝不携带 X-Refresh-Token（仅允许出现在刷新端点，否则触发安全拦截） */
    headers(account, secrets) {
      const c = this.cfg();
      const origin = new URL(c.chatUrl).origin;
      const h = {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": c.userAgent,
        "origin": origin,
        "referer": c.chatUrl,
        "x-requested-with": "XMLHttpRequest",
        "authorization": `Bearer ${secrets.token}`,
        "x-product": "SaaS",
        "x-request-trace-id": util.uuid(),
        "x-request-id": crypto.randomBytes(16).toString("hex"),
      };
      if (account.uid) h["x-user-id"] = account.uid;
      else h["x-no-user-id"] = "1";
      const ent = account.enterpriseId || "";
      if (ent) h["x-enterprise-id"] = ent;
      else h["x-no-enterprise-id"] = "1";
      const domain = account.domain || "";
      if (domain) h["x-domain"] = domain;
      else h["x-no-department-info"] = "1";
      return h;
    },

    /** OpenAI body → WB 改写：强制流式 + tool_choice 归一 + 指纹清洗 + 连续同角色合并（对齐参考项目 wb_payload） */
    rewriteBody(model, body) {
      const tpl = rules.get("wb_template_map.json") || {};
      const out = { ...body };
      out.model = model;
      out.stream = true; // WB 只支持 SSE，非流式本地聚合模拟（方案 §2.2）
      // tool_choice 归一（对象报 400 code 11101）：{type:function} → name；none→none；any/required→required；其余→auto
      if (out.tool_choice && typeof out.tool_choice === "object") {
        const tc = out.tool_choice;
        if (tc.function && tc.function.name) out.tool_choice = tc.function.name;
        else if (tc.type === "none") out.tool_choice = "none";
        else if (tc.type === "any" || tc.type === "required") out.tool_choice = "required";
        else out.tool_choice = "auto";
      }
      // reasoning_effort 为空显式删除（参考项目唯一删字段）；档位降级依赖官方目录，未同步时透传
      if (out.reasoning_effort != null && !out.reasoning_effort) delete out.reasoning_effort;
      const applyTpl = (s) => {
        let t = String(s);
        for (const [from, to] of Object.entries(tpl)) {
          if (from) t = t.split(from).join(to);
        }
        return t;
      };
      const cleanText = (s) => applyTpl(s); // cc_*/x-anthropic-* 键级剥离在下方做，文本层套模板表
      const merged = [];
      for (const m of body.messages || []) {
        const msg = { ...m };
        // 指纹清洗：cc_* 键值 / x-anthropic-* 引用剥离
        for (const k of Object.keys(msg)) {
          if (/^cc_|^x-anthropic-/i.test(k)) delete msg[k];
        }
        if (typeof msg.content === "string") msg.content = cleanText(msg.content);
        else if (Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) =>
            part && part.type === "text" && typeof part.text === "string" ? { ...part, text: cleanText(part.text) } : part
          );
        }
        // tool_calls 的 arguments 只套模板表（不做键剥离，防破坏 JSON）
        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls = msg.tool_calls.map((tc) =>
            tc && tc.function && typeof tc.function.arguments === "string"
              ? { ...tc, function: { ...tc.function, arguments: applyTpl(tc.function.arguments) } }
              : tc
          );
        }
        // 连续同角色自动合并（role:tool 例外，tool_call_id 必须逐条保留）；string↔string 用 \n\n 拼接
        const prev = merged[merged.length - 1];
        if (prev && prev.role === msg.role && msg.role !== "tool" && !msg.tool_calls && !prev.tool_calls) {
          const toText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p && p.type === "text").map((p) => p.text).join("\n") : "");
          prev.content = [toText(prev.content), toText(msg.content)].filter(Boolean).join("\n\n");
          continue;
        }
        merged.push(msg);
      }
      out.messages = merged;
      // 会话 id 注入（官方客户端恒带；客户端已传则保留）
      if (!out.conversation_id) out.conversation_id = util.uuid();
      return out;
    },

    /** 对话主流程：WB 上游已近似 OpenAI 形态，透传归一（方案 §6.3 SSE 转换 WB） */
    async chat({ account, secrets, model, body, emit }) {
      const c = this.cfg();
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const { resp, cancelTimer } = await fetchStream(c.chatUrl, { method: "POST", headers: this.headers(account, secrets), body: payload });
      let settled = false;
      const result = { status: 200 };
      try {
        await pumpSse(resp, (_event, raw) => {
          if (!settled) {
            settled = true;
            cancelTimer();
          }
          if (raw === "[DONE]") {
            emit({ type: "finish", reason: "" }); // 空 reason = 上游已收尾，沿用已记录的 finish_reason
            return;
          }
          const data = parseJson(raw);
          if (!data) return;
          // 402 积分耗尽（insufficient credits）以错误体形式出现
          if (data.error) {
            emit({ type: "error", status: 402, code: data.error.code || 0, message: data.error.message || "insufficient credits" });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({
              type: "usage",
              usage: {
                prompt_tokens: Number(data.usage.prompt_tokens) || 0,
                completion_tokens: Number(data.usage.completion_tokens) || 0,
                total_tokens: Number(data.usage.total_tokens) || 0,
              },
            });
          }
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    /** 额度查询：billing get-user-resource（p_tcaca），宽容解析 */
    async queryCredits(account, secrets) {
      const c = this.cfg();
      const billOrigin = new URL(c.billingBase).origin;
      const r = await httpJson(`${c.billingBase}/billing/meter/get-user-resource`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": c.userAgent,
          "authorization": `Bearer ${secrets.token}`,
          "x-client-platform": "web",
          "origin": billOrigin,
          "referer": billOrigin + "/",
        },
        body: JSON.stringify({ ProductCode: "p_tcaca", Status: [0, 3] }),
      });
      if (r.status === 401) return { authError: true };
      if (!r.ok || !r.data) throw new Error(`额度查询失败 HTTP ${r.status}`);
      const credits = Number(util.dig(r.data, /remain|balance|left|available|total|quota|credits/i)) || 0;
      const expiresAt = util.toMs(util.dig(r.data, /expire|end_time|deadline|valid_until/i));
      return { credits, expiresAt };
    },

    /** Token 刷新：X-Refresh-Token 头 + 空体 {}（该头只允许出现在此端点） */
    async refreshToken(account, secrets) {
      const c = this.cfg();
      if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新扫描或粘贴" };
      const r = await httpJson(`${c.billingBase}/v2/plugin/auth/token/refresh`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer",
          "user-agent": "WorkBuddy",
          "x-refresh-token": secrets.refreshToken,
          "x-auth-refresh-source": "workbuddy",
        },
        body: "{}",
      });
      const d = r.data && (r.data.data || r.data);
      if (r.ok && d && (d.accessToken || d.access_token)) {
        return {
          ok: true,
          token: String(d.accessToken || d.access_token),
          refreshToken: d.refreshToken || d.refresh_token ? String(d.refreshToken || d.refresh_token) : secrets.refreshToken,
        };
      }
      return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || `刷新失败 HTTP ${r.status}` };
    },
  };
}

const workbuddy = makeWorkBuddy("workbuddy");
const workbuddy_ai = makeWorkBuddy("workbuddy_ai");

const ADAPTERS = { trae, workbuddy, workbuddy_ai };

function get(channel) {
  return ADAPTERS[channel] || null;
}

/** 合并模型目录（/v1/models）：canonical id 归并 + 来源标记 */
function mergedModels() {
  const seen = new Map();
  for (const [channel, ad] of Object.entries(ADAPTERS)) {
    for (const m of ad.models()) {
      const id = String(m);
      const cur = seen.get(id.toLowerCase());
      if (cur) {
        if (!cur.sources.includes(channel)) cur.sources.push(channel);
      } else {
        seen.set(id.toLowerCase(), { id, object: "model", created: 0, owned_by: channel, sources: [channel] });
      }
    }
  }
  return [...seen.values()];
}

/** 模型 → 渠道归属：返回拥有该模型的渠道列表（模型完全不存在 → 空数组） */
function modelOwners(model) {
  const id = String(model || "").toLowerCase();
  const owners = [];
  for (const [channel, ad] of Object.entries(ADAPTERS)) {
    if (ad.models().some((m) => String(m).toLowerCase() === id)) owners.push(channel);
  }
  return owners;
}

module.exports = { get, ADAPTERS, mergedModels, modelOwners, httpJson };
