// 反代网关 · 渠道适配器（方案 §6.3 IR 内核 + §2 协议事实基线）
// 进线 OpenAI body → 归一 → 渠道改写 → 上游 fetch → SSE 事件流转换 → 统一 OpenAI 输出
// 三渠道（trae / workbuddy / workbuddy_ai）差异收敛为「配置（rules/headers.json）+ 改写函数」，
// WorkBuddy CN 与国际版共享适配器核心，配置层隔离、代码零复制（方案 §2.3）
"use strict";
const crypto = require("node:crypto");
const rules = require("./rules.cjs");
const store = require("./store.cjs");
const util = require("./util.cjs");
const raccoonAuth = require("./raccoonAuth.cjs");

const FIRST_BYTE_MS = 30000; // 首 token 30s 超时判失败。实测成功请求 TTFT P99≈8.7s、最大 20.2s，
// 10s 会误杀慢模型/thinking 首包（参考项目无首字节总超时，读空闲容忍 300s，这里取全覆盖+余量的折中）
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
    const err = Object.assign(new Error(`上游 HTTP ${resp.status}：${text.slice(0, 200)}`), {
      status: resp.status,
      body: text,
      // 上游明示的限流等待（Retry-After 三头族，参考项目 P1-2），分类器据此对齐墙钟
      retryAfterMs: util.parseRetryAfterHeaders(resp.headers),
    });
    throw err;
  }
  return { resp, cancelTimer: () => clearTimeout(timer) };
}

/** 普通 JSON 请求（额度查询 / token 刷新），60s 总超时（参考项目 120s 口径的折中：含冷启动排队） */
async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
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
  // 单个 idle 定时器循环重置：原来每读一个 chunk 就新挂一个 300s 定时器且旧的不清，
  // 长流（几千 chunk）会同时挂几千个待触发定时器，高并发时随流量线性膨胀
  let idleTimer = null;
  const armIdle = () =>
    new Promise((_, rej) => {
      idleTimer = setTimeout(() => rej(Object.assign(new Error("流中读超时（300s）"), { idleTimeout: true })), STREAM_IDLE_MS);
    });
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), armIdle()]);
      clearTimeout(idleTimer);
      idleTimer = null;
      if (read.done) break;
      scanner.feed(decoder.decode(read.value, { stream: true }));
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
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

/** 权威目录（rules/catalog.json）：渠道 → Map(模型id小写 → 条目{id,name,rate,capabilities,contextLength,...}) */
function catalogMap(channel) {
  const cat = rules.get("catalog.json") || {};
  const sec = cat[channel] || {};
  const map = new Map();
  for (const m of Array.isArray(sec.models) ? sec.models : []) {
    if (m && m.id) map.set(String(m.id).toLowerCase(), m);
  }
  return map;
}

/** 目录 id 并集去重（大小写不敏感）：catalog 优先，旧文件兜底不丢 */
function unionIds(catalogIds, legacyIds) {
  const out = [];
  for (const id of [...catalogIds, ...legacyIds]) {
    const s = String(id);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 按 key 深度优先找数组（util.dig 只取标量，包列表这类结构要单独挖） */
function findList(node, key, depth) {
  if (!node || typeof node !== "object" || (depth || 0) > 5) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findList(v, key, (depth || 0) + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (Array.isArray(node[key])) return node[key];
  for (const v of Object.values(node)) {
    const hit = findList(v, key, (depth || 0) + 1);
    if (hit) return hit;
  }
  return null;
}

/** 渠道上游候选域：accountOrigins 优先，其次 creditsUrl / exchangeUrl 的 origin */
function candidateOrigins(c, extra) {
  const out = [];
  for (const o of Array.isArray(c.accountOrigins) ? c.accountOrigins : []) {
    const s = String(o || "").replace(/\/+$/, "");
    if (s && !out.includes(s)) out.push(s);
  }
  for (const u of [c.creditsUrl, c.exchangeUrl, extra]) {
    try {
      const o = new URL(String(u)).origin;
      if (!out.includes(o)) out.push(o);
    } catch { /* 配置缺项跳过 */ }
  }
  return out;
}

// ===== Trae SOLO CN（方案 §2.1） =====

/** 订阅包取余量：CN 档位优先级 100(CNExpress) > 6 > 5 > 4 > 1 > 9 > 8 > 0，命中即用 */
const TRAE_PACK_PRIORITY = [100, 6, 5, 4, 1, 9, 8, 0];

function pickEntitlementPack(packs) {
  const shaped = packs.map((p) => ({
    productType: Number(util.dig(p, /^product_type$/i)) || 0,
    credits: Number(util.dig(p, /remain|balance|left|available|total_credit|credits|quota/i)) || 0,
    expiresAt: util.toMs(util.dig(p, /end_time|expire|deadline|valid_until/i)),
  }));
  for (const want of TRAE_PACK_PRIORITY) {
    const hit = shaped.find((s) => s.productType === want);
    if (hit) return hit;
  }
  // 档位都不认识（上游加了新套餐）：退化成余量最大的那个包
  return shaped.reduce((a, b) => (b.credits > a.credits ? b : a), { productType: 0, credits: 0, expiresAt: 0 });
}

const trae = {
  id: "trae",

  cfg() {
    return rules.get("headers.json").trae;
  },

  /** 模型显示名 → (config_name, model_name)；映射表外置热加载。
   *  宽松归一化匹配（参考项目 normalizeModelName）：下划线↔横线、大小写不敏感，
   *  客户端传 deepseek_v4_pro / DeepSeek-V4-Pro 之类变体也能命中映射；未命中原样透传（上游接受裸 config_name） */
  mapModel(model) {
    const map = rules.get("model_map.json") || {};
    let hit = map[model];
    if (!hit) {
      const norm = (s) => String(s).toLowerCase().replace(/_/g, "-");
      const want = norm(model);
      for (const k of Object.keys(map)) {
        if (norm(k) === want) { hit = map[k]; break; }
      }
    }
    if (Array.isArray(hit) && hit.length >= 2) return { configName: String(hit[0]), modelName: String(hit[1]) };
    return { configName: model, modelName: model };
  },

  models() {
    const catalog = [...catalogMap("trae").values()].map((m) => String(m.id));
    return unionIds(catalog, Object.keys(rules.get("model_map.json") || {}));
  },

  /** 拉取官方模型目录：get_detail_param（参考项目实证：config_info_list[].config_name + display_config.display_name），
   *  镜像域优先（与对话出口同域），失败回退官方域 */
  async fetchModels(account, secrets) {
    const c = this.cfg();
    const body = JSON.stringify({
      function: "solo_work_lite",
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
    });
    let lastErr = "";
    for (const url of [c.modelsUrl, c.mirrorModelsUrl].filter(Boolean)) {
      const headers = { ...this.headers(account, secrets), referer: url };
      const r = await httpJson(url, { method: "POST", headers, body })
        .catch((e) => ({ ok: false, status: 0, message: String((e && e.message) || e) }));
      if (!r.ok || !r.data) {
        lastErr = r.status === 401 ? "账号登录态失效（401），请重新登录" : `HTTP ${r.status || 0} ${r.message || ""}`.trim();
        continue;
      }
      const list = findList(r.data, "config_info_list", 0) || [];
      const models = [];
      for (const it of list) {
        const id = it && (it.config_name || it.configName);
        if (typeof id !== "string" || !id) continue;
        const name = (it.display_config && (it.display_config.display_name || it.display_config.name)) || id;
        if (!models.some((m) => m.id === id)) {
          models.push({ id, name: String(name), rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0 });
        }
      }
      if (models.length) return { ok: true, models };
      lastErr = "官方目录解析为空（接口可能已变更）";
    }
    return { ok: false, message: lastErr || "目录拉取失败" };
  },

  /** 完整请求头指纹（逐字段对齐参考项目实证抓包，缺任何一项都可能被上游风控识别为非官方客户端） */
  headers(account, secrets) {
    const c = this.cfg();
    const { deviceId, machineId } = deviceIds(account);
    const tid = util.traceId(); // "00-<hex32>-<hex32>-01"
    const h = {
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
      "x-device-brand": c.deviceBrand || "CREFG-XX",
      "x-device-cpu": "Intel",
      "x-device-id": deviceId,
      "x-machine-id": machineId,
      "x-os-version": c.osVersion || "Windows 11 Home China",
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
    // X-Uid 官方客户端恒带（参考项目 SOLOHeaders 实证），缺了是风控识别点
    if (account && account.uid) h["x-uid"] = String(account.uid);
    return h;
  },

  /** function 字段按模型分发（TraeWorkAssistant models_sync.rs 实证：部分模型仅在
   *  solo_agent 下可用）；映射表外置 rules/function_map.json，未命中默认 solo_work_lite */
  functionForModel(model) {
    const map = rules.get("function_map.json") || {};
    const direct = map[String(model)];
    if (direct) return String(direct);
    const norm = (s) => String(s).toLowerCase().replace(/_/g, "-");
    const want = norm(model);
    for (const k of Object.keys(map)) {
      if (norm(k) === want) return String(map[k]);
    }
    return "solo_work_lite";
  },

  /** OpenAI body → llm_utils_chat 改写（对齐参考项目 prepare_llm_chat_body） */
  rewriteBody(model, body, account) {
    const c = this.cfg();
    const { configName } = this.mapModel(model);
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
    // tool_choice 归一化（对齐参考项目）："none"（字符串或对象）→ 删 tool_choice 并同时删除 tools/functions；
    // {type:function} → name 字符串；{type:auto/required} → 字符串
    const tc = out.tool_choice;
    const tcType = typeof tc === "string" ? tc : tc && typeof tc === "object" ? tc.type : "";
    if (tcType === "none") {
      delete out.tools;
      delete out.functions;
      delete out.tool_choice;
    } else if (tc && typeof tc === "object") {
      out.tool_choice = (tc.function && tc.function.name) || tcType || "auto";
    }
    // 必填注入字段（方案 §2.1）
    out.config_name = configName;
    // model 与 config_name 同值（traework2api payload.go 实证形态：上游认这两个键同值）。
    // model_map 第二列（__dev 内部名）保留备用：若上游报 "the model is unknown"，
    // 切换 TraeWorkAssistant 形态——把本行改为 out.model_name = modelName 并删掉 out.model
    out.model = configName;
    out.stream = true; // 强制流式，非流式本地聚合
    out.function = this.functionForModel(model);
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
        // 网络错误直接换镜像；404（TLB 整域下线/路径失效）也换——官方域随时可能停 agent 服务
        if (!e.network && !(e && e.status === 404)) throw e;
      }
    }
    throw lastErr || new Error("上游不可达");
  },

  async chatOnce(url, headers, payload, model, emit) {
    const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: payload });
    let settled = false;
    const result = { status: 200, planLimit: false };
    const seenToolIndex = new Set(); // 流式 tool_calls：每个 index 只在首片带 name（OpenAI 官方形态，issue #82）
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
          // 工具调用差量：function_call → function，剥 namespace / partial_arguments；
          // name 键首片保留、后续分片删除（键缺失比空串安全：覆盖型客户端 ?? 对空串会误清工具名）
          if (Array.isArray(data.tool_calls)) {
            delta.tool_calls = data.tool_calls.map((tc, i) => {
              const fc = tc.function_call || tc.function || {};
              const idx = tc.index != null ? tc.index : i;
              const fn = { arguments: fc.arguments || "" };
              if (!seenToolIndex.has(String(idx))) {
                seenToolIndex.add(String(idx));
                fn.name = fc.name || "";
              }
              return { index: idx, id: tc.id, type: "function", function: fn };
            });
          }
          if (Object.keys(delta).length) emit({ type: "delta", delta });
        } else if (ev === "token_usage") {
          // usage 透传完整对象（参考项目实证：含 reasoning_tokens / credit 等扩展字段），缺总数本地补
          const usage = {
            prompt_tokens: Number(data.prompt_tokens ?? data.prompt ?? 0) || 0,
            completion_tokens: Number(data.completion_tokens ?? data.completion ?? 0) || 0,
            total_tokens: Number(data.total_tokens ?? data.total ?? 0) || 0,
          };
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === "number" && !(k in usage)) usage[k] = v;
          }
          if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          emit({ type: "usage", usage });
        } else if (ev === "done" || ev === "turn_completion") {
          emit({ type: "finish", reason: data.finish_reason || data.finishReason || "stop" });
        } else if (ev === "error") {
          // code:1005 = 积分不足 PlanLimit；4008 = 限流；4001 = 模型配置问题（不罚号，交由分类器处理）
          const code = Number(data.code) || 0;
          if (code === 1005) result.planLimit = true;
          const status = code === 1005 ? 402 : code === 4008 ? 429 : 502;
          emit({ type: "error", status, code, message: data.message || data.msg || `上游错误 ${code}` });
        }
        // metadata / timing_cost / extra_info 忽略
      });
    } finally {
      cancelTimer();
    }
    return result;
  },

  /**
   * 额度查询：CN 现行口径是 v2 pay 接口（v1 兜底），空体请求（参考项目实测）；
   * 余额 = 全部订阅包 (credits_limit - usage.credits_amount) 求和（老实现只取单一档位包，口径错）。
   * 实测关键：pay/ug 域对部分账号（scope=marscode 等）整体拒绝，HTTP 401 + code 1001，
   * 但同一 token 在 GetUserInfo/对话域完全正常 —— 这是「积分服务不开放」，不是凭证失效，
   * 返回 unavailable 而不是 authError，避免把好号打成 relogin
   */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    const { deviceId } = deviceIds(account);
    const headers = { ...this.headers(account, secrets), "x-user-region": "CN", "x-device-id": deviceId };
    const body = "{}";
    let lastErr = "";
    for (const base of candidateOrigins(c)) {
      for (const path of ["/trae/api/v2/pay/ide_user_ent_usage", "/trae/api/v1/pay/ide_user_ent_usage"]) {
        const r = await httpJson(base + path, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const code = Number((r.data && r.data.code) || 0);
        if ((r.status === 401 || r.status === 403) && code === 1001) {
          return { credits: 0, unavailable: true, message: "积分服务未对该账号开放（官方接口 code 1001）" };
        }
        if (r.status === 401) return { authError: true };
        if (!r.ok || !r.data) {
          lastErr = `HTTP ${r.status}${r.message ? ` ${r.message}` : ""}`;
          continue;
        }
        const packs = findList(r.data, "user_entitlement_pack_list") || [];
        if (packs.length) {
          let credits = 0;
          let expiresAt = 0;
          for (const p of packs) {
            const limit = Number(util.dig(p, /^credits_limit$/i)) || 0;
            if (limit <= 0) continue;
            const used = Number(util.dig(p, /^credits_amount$/i)) || 0;
            credits += Math.max(limit - used, 0);
            const end = util.toMs(util.dig(p, /end_time|expire|deadline|valid_until/i));
            if (end && end > Date.now() && (!expiresAt || end < expiresAt)) expiresAt = end;
          }
          if (credits > 0) return { credits, expiresAt };
          // 新版字段缺失时退回旧档位口径（单一包 remain）
          const best = pickEntitlementPack(packs);
          if (best.credits > 0) return { credits: best.credits, expiresAt: best.expiresAt };
          return { credits: 0, expiresAt };
        }
        lastErr = "上游未返回订阅包";
      }
    }
    throw new Error(`额度查询失败：${lastErr || "上游无可用响应"}`);
  },

  /** 签到状态：GET+did（cockpit 现行）为主，POST+Cloud-IDE-JWT 兜底；code 1001 = 签到服务对该账号不开放 */
  async checkinStatus(account, secrets) {
    const c = this.cfg();
    const { deviceId } = deviceIds(account);
    const base = c.checkinBase || "https://api.trae.cn";
    const tries = [
      {
        url: `${base}/trae/api/v2/ug/checkin_credits/status?did=${encodeURIComponent(deviceId)}`,
        method: "GET",
        headers: {
          authorization: `Bearer ${secrets.token}`,
          origin: "https://www.trae.cn",
          referer: "https://www.trae.cn/",
          "x-app-type": "trae",
          "x-device-id": deviceId,
          "x-user-region": "CN",
        },
      },
      {
        url: `${base}/trae/api/v2/ug/checkin_credits/status`,
        method: "POST",
        headers: { authorization: `Cloud-IDE-JWT ${secrets.token}`, "x-user-region": "CN", "x-device-id": deviceId },
      },
    ];
    let lastMsg = "";
    for (const t of tries) {
      const opts = { method: t.method, headers: { "content-type": "application/json", accept: "application/json", ...t.headers } };
      if (t.method === "POST") opts.body = "{}";
      const r = await httpJson(t.url, opts).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const code = Number((r.data && r.data.code) ?? 0);
      const msg = String((r.data && r.data.message) || r.message || "");
      if (code === 1001) return { ok: true, unavailable: true, checkedIn: false, message: "签到服务未对该账号开放（官方接口 code 1001）" };
      if (code !== 0 && code !== 200) {
        lastMsg = msg || `HTTP ${r.status}`;
        continue;
      }
      if (!r.ok || !r.data) {
        lastMsg = `HTTP ${r.status}`;
        continue;
      }
      return {
        ok: true,
        checkedIn: !!(r.data.checked_in ?? r.data.checkedIn),
        enable: !!(r.data.enable),
        credits: Number((r.data.credits ?? r.data.total_credits) || 0),
        consecutiveDays: Number((r.data.consecutive_days ?? r.data.consecutiveDays) || 0),
        creditsEarnedToday: Number((r.data.credits_earned_today ?? r.data.creditsEarnedToday) || 0),
        checkinDate: String(r.data.checkin_date ?? r.data.checkinDate ?? ""),
        message: r.data.checked_in ? `今日已签到 · 共 ${r.data.credits ?? 0} 积分` : "今日未签到",
      };
    }
    return { ok: false, message: lastMsg || "查询签到状态失败" };
  },

  /** 签到领取：code 1001 = 服务不开放；「已签到」文案 = 幂等成功 */
  async checkin(account, secrets) {
    const c = this.cfg();
    const { deviceId } = deviceIds(account);
    const base = c.checkinBase || "https://api.trae.cn";
    const r = await httpJson(`${base}/trae/api/v2/ug/checkin_credits/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Cloud-IDE-JWT ${secrets.token}`,
        "x-user-region": "CN",
        "x-device-id": deviceId,
        origin: "https://www.trae.cn",
        referer: "https://www.trae.cn/",
        "x-app-type": "trae",
      },
      body: "{}",
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    const code = Number((r.data && r.data.code) ?? 0);
    const msg = String((r.data && r.data.message) || r.message || "");
    if (code === 1001) return { ok: true, unavailable: true, message: "签到服务未对该账号开放（官方接口 code 1001）" };
    if (code !== 0 && code !== 200) {
      const already = /已签到|已经签到|already/i.test(msg);
      return { ok: already, already, message: msg || `签到失败 HTTP ${r.status}` };
    }
    if (!r.ok || !r.data) return { ok: false, message: msg || `签到失败 HTTP ${r.status}` };
    // 领取后回查状态拿积分明细
    const st = await this.checkinStatus(account, secrets);
    return { ok: true, already: false, message: (r.data.message || "签到成功"), status: st.ok ? st : null };
  },

  /**
   * Token 刷新：ExchangeToken（对齐参考项目：ClientID + RefreshToken + ClientSecret "-"，x-cloudide-token 空串）。
   * 上游多域时依次尝试，避免某个域被墙/维护就整条链路失效；
   * extraOrigins（OAuth 回调 loginHost 的 origin）排最前——官方回调会指定换令牌的域
   */
  async refreshToken(account, secrets, extraOrigins) {
    const c = this.cfg();
    if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
    const headers = { "content-type": "application/json", "user-agent": c.userAgent, "x-cloudide-token": "" };
    const body = JSON.stringify({ ClientID: c.clientId, RefreshToken: secrets.refreshToken, ClientSecret: "-", UserID: "" });
    const bases = candidateOrigins(c);
    const candidates = [
      ...(Array.isArray(extraOrigins) ? extraOrigins.filter((x) => x && !bases.includes(x)) : []),
      ...bases,
    ];
    let lastErr = "";
    for (const base of candidates) {
      const r = await httpJson(`${base}/cloudide/api/v3/trae/oauth/ExchangeToken`, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      // 响应嵌套 Result.Token / Result.RefreshToken（参考项目实证），兼容扁平字段
      const d = (r.data && (r.data.Result || r.data.result || r.data.data || r.data)) || null;
      const rawToken = d && (d.Token || d.access_token || d.accessToken);
      if (r.ok && rawToken) {
        const token = String(rawToken).replace(/^Cloud-IDE-JWT\s+/i, "");
        const newRefresh = d.RefreshToken || d.refresh_token || d.refreshToken;
        return {
          ok: true,
          token,
          refreshToken: newRefresh ? String(newRefresh) : secrets.refreshToken,
        };
      }
      const errMsg = r.data && (r.data.ResponseMetadata && r.data.ResponseMetadata.Error && r.data.ResponseMetadata.Error.Message);
      lastErr = errMsg || (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
    }
    return { ok: false, message: lastErr };
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

/**
 * 计费响应 → { credits, expiresAt }。
 * 个人口径 get-user-resource 把额度拆成 Response.Data.Accounts[] 多个套餐包，
 * 正确余额 = 全部包的剩余求和（老实现只取第一个包，实测 CN 981 vs 129、AI 588 vs 527）。
 * 企业口径 get-enterprise-user-usage 返回 limit_num / used_num 一套（无 Accounts）。
 * credits = -1 表示企业无限额度哨兵（调用方与 UI 识别，不参与求和）。
 */
function parseWbResource(data, isEnterprise) {
  if (isEnterprise) {
    // 企业端点两层 data 都可能（data.data / data 直接挂字段），宽容取
    const d = (data && (data.data || data)) || data;
    const limit = Number(util.dig(d, /^limit_num$|^limitnum$/i));
    if (!Number.isFinite(limit)) return null;
    const used = Number(util.dig(d, /^used_num$|^usednum$|^credit$/i)) || 0;
    return {
      credits: limit < 0 ? -1 : Math.max(limit - used, 0),
      expiresAt: util.toMs(util.dig(d, /cycle_end_time|cycle_reset_time|end_time|expire/i)),
    };
  }
  const accounts = findList(data, "Accounts") || [];
  if (!accounts.length) return null;
  let remain = 0;
  let used = 0;
  let size = 0;
  let earliestEnd = 0;
  const num = (a, re) => Number(util.dig(a, re)) || 0;
  for (const a of accounts) {
    // 单包口径（参考项目 packageRemainUsed）：Cycle 期套餐优先，缺 Cycle 退回 Capacity 三字段
    let r, u, s;
    const cycSize = num(a, /^CycleCapacitySize(Precise)?$/i);
    if (cycSize > 0) {
      r = num(a, /^CycleCapacityRemain(Precise)?$/i);
      s = cycSize;
      r = Math.max(0, Math.min(r, s));
      u = Math.max(s - r, num(a, /^CycleCapacityUsed(Precise)?$/i));
    } else {
      r = num(a, /^CapacityRemain(Precise)?$/i);
      u = num(a, /^CapacityUsed(Precise)?$/i);
      s = num(a, /^CapacitySize(Precise)?$/i);
      if (!u && s > r) u = s - r;
    }
    remain += r;
    used += u;
    size += s;
    const end = util.toMs(util.dig(a, /^PackageEndTime$|^CycleEndTime$|^CycleResetTime$/i));
    // 只取未来的到期时间：响应里混着已过期的历史包（Status=3），取其到期会把账号误判成「余额已到期」
    if (end && end > Date.now() && (!earliestEnd || end < earliestEnd)) earliestEnd = end;
  }
  // TotalDosage 作 size 下限（已消耗的总量不该小于套餐总量）
  const dosage = Number(util.dig(data, /^TotalDosage$/i)) || 0;
  if (dosage > size) {
    size = dosage;
    if (size - remain > used) used = size - remain;
  } else if (size > 0 && size - remain > used) {
    used = size - remain;
  }
  return { credits: Math.max(remain, 0), expiresAt: earliestEnd };
}

/** 官方客户端会话头族（参考项目 ChatMeta 实证：后台按 X-Conversation-Request-ID 聚合请求，
 *  一次 user send 内的所有重试/换号必须复用同一个 ID）。meta 由 server 在轮转循环外生成一次，
 *  循环内换号沿用同值；B3 规范只认 16/32 hex TraceId，入站透传值非法时回落消息级 ID */
function wbConversationHeaders(body, meta) {
  const hex32 = () => crypto.randomBytes(16).toString("hex");
  const fromMeta = meta && typeof meta.conversationRequestId === "string" && /^[0-9a-fA-F]{16}([0-9a-fA-F]{16})?$/.test(meta.conversationRequestId)
    ? meta.conversationRequestId
    : "";
  const convReqId = fromMeta || hex32();
  const messageId = hex32();
  const h = {
    "x-conversation-request-id": convReqId, // 对话轮聚合主键，必发
    "x-conversation-message-id": messageId,
    "x-request-id": messageId,
    "x-root-request-id": convReqId,
    "x-trace-id": convReqId,
    "x-b3-traceid": convReqId,
    "x-b3-spanid": messageId.slice(0, 16),
    "x-b3-sampled": "1",
  };
  // X-Conversation-ID 透传客户端原值优先，没给就不伪造
  const convId = body && (body.conversation_id || body.conversationId);
  if (typeof convId === "string" && convId) h["x-conversation-id"] = convId;
  return h;
}

/** X-Device-Token 文件兜底（参考项目 device_token.go：≤1KB、5min 缓存） */
let deviceTokenCache = { at: 0, value: "" };
function readDeviceTokenFile() {
  if (deviceTokenCache.at && Date.now() - deviceTokenCache.at < 5 * 60000) return deviceTokenCache.value;
  try {
    const raw = require("node:fs").readFileSync(require("node:path").join(store.proxyDir(), "device_token.txt"), "utf8");
    deviceTokenCache.value = String(raw).trim().slice(0, 1024);
  } catch {
    deviceTokenCache.value = "";
  }
  deviceTokenCache.at = Date.now();
  return deviceTokenCache.value;
}

function makeWorkBuddy(channelId) {
  return {
    id: channelId,

    cfg() {
      return rules.get("headers.json")[channelId];
    },

    models() {
      const catalog = [...catalogMap(channelId).values()].map((m) => String(m.id));
      const legacy = (rules.get("wb_models.json") || {})[channelId];
      return unionIds(catalog, Array.isArray(legacy) ? legacy : []);
    },

    /** 拉取官方模型目录：v3/config 主路（三段式 CLI UA 否则 400 code 12403；含倍率 credits/能力/上下文）
     *  + console models 备路，两路结果按 id 合并、v3 权威；非对话模型（nes-/completion-/maxOutput≤256/文生图）剔除 */
    async fetchModels(account, secrets) {
      const c = this.cfg();
      const baseHeaders = this.headers(account, secrets);
      const parseRate = (v) => {
        const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(v ?? ""));
        return m ? Number(m[1]) : null;
      };
      const shape = (it) => {
        if (!it || typeof it !== "object") return null;
        const id = it.id || it.model || it.name;
        if (typeof id !== "string" || !id) return null;
        if (/^(nes-|completion-|codewise-)/i.test(id)) return null;
        const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
        const maxOut = Number(it.maxOutputTokens ?? it.max_output_tokens) || 0;
        if (maxOut && maxOut <= 256) return null;
        if (tags.some((t) => /text-to-image|image-gen|embedding/i.test(t))) return null;
        return {
          id,
          name: String(it.name || it.display_name || id),
          rate: parseRate(it.credits),
          capabilities: {
            images: !!(it.supportsImages ?? it.supports_images),
            reasoning: !!(it.supportsReasoning ?? it.supports_reasoning),
            tools: !!(it.supportsToolCall ?? it.supports_tool_call),
          },
          // reasoning 元数据（参考项目 effort 降级原料）：supportedEfforts/defaultEffort 必须随目录落盘，
          // 否则 deepseek 系 reasoning_effort 档位无法按模型收敛，只认 high 的模型请求 low 会 400
          reasoning: it.reasoning && typeof it.reasoning === "object"
            ? {
                effort: it.reasoning.effort ?? null,
                defaultEffort: String(it.reasoning.defaultEffort ?? it.reasoning.default_effort ?? ""),
                supportedEfforts: Array.isArray(it.reasoning.supportedEfforts ?? it.reasoning.supported_efforts)
                  ? (it.reasoning.supportedEfforts ?? it.reasoning.supported_efforts).map(String)
                  : [],
              }
            : null,
          contextLength: Number(it.maxInputTokens ?? it.max_input_tokens ?? it.context_length) || 0,
          maxOutputTokens: maxOut,
        };
      };
      const merged = new Map();
      const ingest = (data, authoritative) => {
        const list = findList(data, "models", 0);
        if (!Array.isArray(list)) return;
        for (const raw of list) {
          const m = shape(raw);
          if (!m) continue;
          const key = m.id.toLowerCase();
          if (!merged.has(key) || authoritative) merged.set(key, m);
        }
      };
      const [alt, v3] = await Promise.all([
        httpJson(c.modelsUrl, { method: "GET", headers: baseHeaders })
          .catch(() => ({ ok: false, status: 0 })),
        httpJson(c.modelsV3Url, {
          method: "GET",
          headers: { ...baseHeaders, "user-agent": c.catalogUA || baseHeaders["user-agent"], "x-codebuddy-request": "1" },
        }).catch(() => ({ ok: false, status: 0 })),
      ]);
      if (alt.ok && alt.data) ingest(alt.data, false); // 备路先入
      if (v3.ok && v3.data) ingest(v3.data, true); // 主路权威覆盖
      const models = [...merged.values()];
      if (!models.length) {
        return { ok: false, message: `目录拉取失败（v3 HTTP ${v3.status || 0} / console HTTP ${alt.status || 0}）` };
      }
      return { ok: true, models };
    },

    /** chat 出站头组：逐字段对齐官方 WorkBuddy 桌面端（参考项目逆向实证）。
     *  渠道白名单校验（400 code 11128 "unapproved channel"）按这套指纹认客户端：
     *  ① 三段式 UA（WorkBuddy/ver 平台/ver CLI/ver，AI 版平台段必须 WorkBuddy AI 否则 11140）；
     *  ② X-CodeBuddy-Request: 1 风控闸门头全请求必带；
     *  ③ 用量归属头组 X-Agent-Purpose/X-IDE-Name/Type/Version/X-Product（官方 banner 白名单同形，
     *     旧版 x-product=SaaS 就是"网关特征"，11128 的直接诱因）；
     *  ④ X-Machine-ID/X-Session-ID 按 uid 稳定派生（每账号一台固定虚拟设备）；
     *  ⑤ Origin/Referer 按域名（CN=codebuddy.cn，AI=workbuddy.ai）；
     *  ⑥ 缺省字段 X-No-* 占位（X-Domain 有值才发、无值改发 X-No-Department-Info，二者不并存）。
     *  红线：chat 请求绝不携带 X-Refresh-Token（仅允许出现在刷新端点） */
    headers(account, secrets) {
      const c = this.cfg();
      const origin = c.origin || (channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");
      const ideName = c.ideName || "WorkBuddy";
      const h = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
        "user-agent": c.userAgent,
        "origin": origin,
        "referer": origin + "/",
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1",
        "authorization": `Bearer ${secrets.token}`,
        // 用量归属头组：伪造官方桌面端，缺了就是上游用量统计里的「网关特征」
        "x-agent-purpose": "conversation",
        "x-ide-name": ideName,
        "x-ide-type": ideName,
        "x-ide-version": c.clientVersion || "5.5.4",
        "x-product": ideName,
      };
      // 设备风控头（参考项目：auth 每号 > config 全局 > 文件兜底），空则不注入
      const devToken = (account && account.deviceToken) || c.deviceToken || readDeviceTokenFile();
      if (account && account.uid) {
        h["x-user-id"] = account.uid;
        // 每账号一台固定虚拟设备：跨重启稳定、账号间互异（防设备指纹缺失/漂移关联风控）
        const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
        h["x-machine-id"] = stable("machine");
        h["x-session-id"] = stable("session");
      } else {
        h["x-no-user-id"] = "1";
      }
      if (devToken) h["x-device-token"] = devToken;
      if (channelId === "workbuddy_ai") {
        // 国际版个人号无企业 ID：显式声明 + 国际版域（对齐官方国际客户端形态）
        h["x-no-enterprise-id"] = "1";
        h["x-domain"] = "www.workbuddy.ai";
      } else {
        const ent = account.enterpriseId || "";
        if (ent) h["x-enterprise-id"] = ent;
        else h["x-no-enterprise-id"] = "1";
        const domain = account.domain || "";
        if (domain) h["x-domain"] = domain;
        else h["x-no-department-info"] = "1";
      }
      return h;
    },

    /** billing 域请求头（余额/签到/上报）：官方白名单头组 = 单段 UA WorkBuddy/<ver> + X-CodeBuddy-Request。
     *  UA 不能用三段式（官方计费/banner 接口显式覆写为单段形态，多带 CLI 段反而不像） */
    billingHeaders(account, secrets) {
      const c = this.cfg();
      const h = {
        "content-type": "application/json",
        "accept": "application/json",
        "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
        "user-agent": c.billingUA || `WorkBuddy/${c.clientVersion || "5.5.4"}`,
        "x-codebuddy-request": "1",
        "authorization": `Bearer ${secrets.token}`,
      };
      if (account.uid) h["x-user-id"] = account.uid;
      const ent = account.enterpriseId || "";
      if (ent) {
        h["x-enterprise-id"] = ent;
        h["x-tenant-id"] = ent;
      }
      const domain = account.domain || "";
      if (domain) h["x-domain"] = domain;
      const devToken = (account && account.deviceToken) || c.deviceToken || readDeviceTokenFile();
      if (devToken) h["x-device-token"] = devToken;
      return h;
    },

    /** OpenAI body → WB 改写（对齐参考项目 payload.go + sanitize.go + thinking.go + tool_pairing.go 全管线）。
     *  11128 的三类诱因都在这里拦截：role 白名单外的 developer、整句精确匹配的审核指纹、
     *  裸错误码数字（模板表 "11128"→"11-128"）与不成对的工具调用（上游对后续每条消息都 400） */
    rewriteBody(model, body, account) {
      const tpl = rules.get("wb_template_map.json") || {};
      const out = { ...body };
      out.model = model;
      out.stream = true; // WB 只支持 SSE，非流式本地聚合模拟（方案 §2.2）
      // 官方 CLI 流式必发：上游据此在末帧返回 usage
      if (!out.stream_options) out.stream_options = { include_usage: true };
      // max_completion_tokens → max_tokens 翻译（新版 OpenAI SDK/_codex_ 客户端发前者，上游不认）
      if (out.max_completion_tokens != null) {
        const mct = Number(out.max_completion_tokens);
        if (Number.isFinite(mct) && mct > 0 && out.max_tokens == null) out.max_tokens = mct;
        delete out.max_completion_tokens;
      }
      // tool_choice 归一（对象报 400 code 11101）：{type:function} → name；none→none；any/required→required；其余→auto
      if (out.tool_choice && typeof out.tool_choice === "object") {
        const tc = out.tool_choice;
        if (tc.function && tc.function.name) out.tool_choice = tc.function.name;
        else if (tc.type === "none") out.tool_choice = "none";
        else if (tc.type === "any" || tc.type === "required") out.tool_choice = "required";
        else out.tool_choice = "auto";
      }
      // reasoning_effort 的删除移到最后（thinking 注入/降级完成后再处理）
      const applyTpl = (s) => {
        let t = String(s);
        for (const [from, to] of Object.entries(tpl)) {
          if (from) t = t.split(from).join(to);
        }
        return t;
      };
      // 文本指纹清洗（对齐 sanitize.go）：模板表逐字替换 → header 键值段整段剥除 → cc_ 裸键值剥除 → 裸键名缩写
      const cleanText = (s) => {
        let t = applyTpl(s);
        t = t.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "");
        t = t.replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "");
        t = t.replace(/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr");
        return t;
      };
      // 孤儿 tool_call↔tool 配对清理（参考项目实证：不成对会让上游对之后每条消息都返 400）
      const rawMsgs = (Array.isArray(body.messages) ? body.messages : []).map((m) => ({ ...m }));
      // 工具结果组重排（参考项目 repackToolResultBlocks）：把插在 assistant.tool_calls 与 tool 结果
      // 之间的非 tool 消息挪到该组之后——Codex 类客户端会夹通知消息，不打散配对且语义顺序不变
      const repacked = [];
      let pendingAfterGroup = [];
      for (const m of rawMsgs) {
        if (m.role === "tool") { repacked.push(m); continue; }
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          if (pendingAfterGroup.length) { repacked.push(...pendingAfterGroup); pendingAfterGroup = []; }
          repacked.push(m);
          continue;
        }
        pendingAfterGroup.push(m);
      }
      if (pendingAfterGroup.length) repacked.push(...pendingAfterGroup);
      const validToolIds = new Set();
      for (const m of repacked) {
        if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) if (tc && tc.id) validToolIds.add(String(tc.id));
        }
      }
      const answeredIds = new Set();
      for (const m of repacked) {
        if (m && m.role === "tool" && m.tool_call_id) answeredIds.add(String(m.tool_call_id));
      }
      const merged = [];
      for (const m of repacked) {
        const msg = { ...m };
        // developer 角色归一（上游 role 白名单，命中即 400 code 11128）
        if (typeof msg.role === "string" && msg.role.trim().toLowerCase() === "developer") msg.role = "system";
        // 孤儿清理：无配对的 tool_calls / tool 结果整条剔除
        if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
          msg.tool_calls = msg.tool_calls.filter((tc) => tc && tc.id && answeredIds.has(String(tc.id)));
          if (!msg.tool_calls.length) delete msg.tool_calls;
        }
        if (msg.role === "tool" && !validToolIds.has(String(msg.tool_call_id || ""))) continue;
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
        // reasoning_content（思维链回填）实测同样携带指纹，与 content 同等清洗
        if (typeof msg.reasoning_content === "string") msg.reasoning_content = cleanText(msg.reasoning_content);
        // tool_calls 的 arguments 套同一套文本清洗（JSON 字符串按文本洗，不做键剥离防破坏结构）
        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls = msg.tool_calls.map((tc) =>
            tc && tc.function && typeof tc.function.arguments === "string"
              ? { ...tc, function: { ...tc.function, arguments: cleanText(tc.function.arguments) } }
              : tc
          );
        }
        // 连续同角色自动合并（role:tool 例外，tool_call_id 必须逐条保留）。
        // array↔array 直接拼接保多模态 part（压扁成文本会丢 image_url），string↔string 用 \n\n；
        // string 与 array 混态不合并（同样为不丢 part）
        const prev = merged[merged.length - 1];
        if (prev && prev.role === msg.role && msg.role !== "tool" && !msg.tool_calls && !prev.tool_calls) {
          if (typeof prev.content === "string" && typeof msg.content === "string") {
            prev.content = [prev.content, msg.content].filter(Boolean).join("\n\n");
            continue;
          }
          if (Array.isArray(prev.content) && Array.isArray(msg.content)) {
            prev.content = prev.content.concat(msg.content);
            continue;
          }
        }
        merged.push(msg);
      }
      out.messages = merged;
      // console 域（国际版官方客户端路径）要求首条消息必须是 system，否则 400 code 11128
      // "first message is not system prompt"（参考项目 ensureConsoleSystem 实证，吸收 PR #45）
      if (channelId === "workbuddy_ai" && out.messages.length) {
        const firstRole = String(out.messages[0].role || "").trim().toLowerCase();
        if (firstRole !== "system") {
          out.messages.unshift({ role: "system", content: "You are a helpful assistant." });
        }
      }
      // 会话 id：客户端已传则保留；否则按前 3 条消息指纹稳定派生——同一会话多轮复用，
      // 结合 prompt_cache_key 使上游前缀缓存可命中（参考项目实证：命中后 credit≈0.02 vs 0.34）
      if (!out.conversation_id) out.conversation_id = util.stableConvId(body.messages) || util.uuid();
      // deepseek 思维链管线（参考项目 thinking.go）：注入 thinking 开关 → effort 按目录档位
      // 降级 → 多轮 reasoning_content 回填（缺失会 400）。显式空 reasoning_effort 最后删除
      const catEntry = catalogMap(channelId).get(String(model).toLowerCase());
      if (util.isDeepSeekModel(model)) {
        util.injectThinking(out, (catEntry && catEntry.reasoning && catEntry.reasoning.defaultEffort) || "");
        util.backfillReasoningContent(out);
      }
      util.normalizeReasoningEffort(out, catEntry && catEntry.reasoning);
      if (out.reasoning_effort != null && !out.reasoning_effort) delete out.reasoning_effort;
      // prompt_cache_key（参考项目 cache_key.go：账号段硬隔离，跨账号绝不碰撞——防命中错账号前缀缓存）
      if (!out.prompt_cache_key) {
        out.prompt_cache_key = util.promptCacheKey((account && account.uid) || "", String(out.conversation_id || ""));
      }
      return out;
    },

    /** 对话主流程：WB 上游已近似 OpenAI 形态，透传归一（方案 §6.3 SSE 转换 WB）。
     *  国际版优先走 /console/chat/completions（官方国际客户端现行路径），404/405 回退 /v2（参考项目实证）。
     *  meta = 轮内会话元数据（server 在换号循环外生成一次，重试/换号复用同值） */
    async chat({ account, secrets, model, body, emit, meta }) {
      const c = this.cfg();
      const payload = JSON.stringify(this.rewriteBody(model, body, account));
      const headers = { ...this.headers(account, secrets), ...wbConversationHeaders(body, meta) };
      const urls = [c.consoleChatUrl, c.chatUrl].filter(Boolean);
      let resp = null;
      let cancelTimer = () => {};
      let lastErr = null;
      for (const url of urls) {
        try {
          const r = await fetchStream(url, { method: "POST", headers, body: payload });
          resp = r.resp;
          cancelTimer = r.cancelTimer;
          break;
        } catch (e) {
          lastErr = e;
          // 仅 404/405（路径不存在）换下一候选，其余错误直接上抛分类
          if (!e || (e.status !== 404 && e.status !== 405)) throw e;
        }
      }
      if (!resp) throw lastErr || new Error("上游不可达");
      let settled = false;
      const result = { status: 200, planLimit: false };
      const seenToolIndex = new Set(); // 流式 tool_calls：每个 index 只在首片带 name（issue #82）
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
          // 402 积分耗尽（insufficient credits）以错误体形式出现；4008 = 模型级限流。
          // 必须置 result.planLimit：只 emit error 的话 server 侧换号分支认不到，
          // 该账号既不冷却也不换号，请求被记 200 成功，下次还会继续选中这个已耗尽的号
          if (data.error) {
            const codeNum = Number(data.error.code) || 0;
            const msgStr = String(data.error.message || "");
            const status = codeNum === 402 || /insufficient|credit|quota|balance/i.test(msgStr) ? 402 : codeNum === 4008 ? 429 : 502;
            if (status === 402) result.planLimit = true;
            emit({ type: "error", status, code: codeNum, message: msgStr || "insufficient credits" });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) {
              // 归一：剥空串噪声字段；tool_calls 每个 index 首片带 name、后续分片删 name 键
              // （键缺失比空串安全：覆盖型客户端 ?? 对空串会误清工具名，累加型会拼成 name×帧数）
              const d = { ...choice.delta };
              if (d.content === "") delete d.content;
              if (d.reasoning_content === "") delete d.reasoning_content;
              if (Array.isArray(d.tool_calls)) {
                d.tool_calls = d.tool_calls.map((tc) => {
                  const idx = tc && tc.index != null ? Number(tc.index) : 0;
                  const key = String(idx);
                  if (tc && tc.function && seenToolIndex.has(key) && "name" in tc.function) {
                    const f = { ...tc.function };
                    delete f.name;
                    return { ...tc, function: f };
                  }
                  seenToolIndex.add(key);
                  return tc;
                });
              }
              if (Object.keys(d).length) emit({ type: "delta", delta: d });
            }
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

    /**
     * 额度查询：billing/meter 计费域。
     * 个人账号走 get-user-resource（p_tcaca，全部套餐包求和），企业成员的个人资源恒为空、
     * 必须走 get-enterprise-user-usage（空体 + X-Enterprise-Id 头，返回 limit_num/used_num）。
     * 计费域与对话域不同（CN 计费在 www.codebuddy.cn），主域失败时回退插件域
     */
    async queryCredits(account, secrets) {
      const c = this.cfg();
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      const ent = account.enterpriseId || "";
      const path = ent ? "/billing/meter/get-enterprise-user-usage" : "/billing/meter/get-user-resource";
      // 请求体对齐参考项目实证（workbuddy2api / cockpit-tools 同款）：分页 + p_tcaca + 有效期区间；
      // 企业版官方客户端发空体 {}
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const fmtTime = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      const body = ent
        ? "{}"
        : JSON.stringify({
            PageNumber: 1,
            PageSize: 100,
            ProductCode: "p_tcaca",
            Status: [0, 3],
            PackageEndTimeRangeBegin: fmtTime(now),
            PackageEndTimeRangeEnd: fmtTime(new Date(now.getTime() + 365 * 101 * 86400000)),
          });
      let lastErr = "";
      for (const base of bases) {
        for (const p of [path, "/v2" + path]) {
          const r = await httpJson(`${base}${p}`, {
            method: "POST",
            headers: this.billingHeaders(account, secrets),
            body,
          }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
          if (r.status === 401) return { authError: true };
          if (!r.ok || !r.data) {
            lastErr = `HTTP ${r.status}`;
            continue;
          }
          const shaped = parseWbResource(r.data, !!ent);
          if (shaped) return shaped;
          lastErr = "上游未返回可用额度字段";
        }
      }
      throw new Error(`额度查询失败：${lastErr || "上游无可用响应"}`);
    },

    /** 计费域 JSON 请求：paths 候选依次尝试（非 v2 优先、/v2 兜底），401 先换 token 再试一次 */
    async billingCall(account, secrets, paths, body) {
      const c = this.cfg();
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      let creds = secrets;
      for (let pass = 0; pass < 2; pass++) {
        for (const base of bases) {
          for (const p of paths) {
            const r = await httpJson(`${base}${p}`, {
              method: "POST",
              headers: this.billingHeaders(account, creds),
              body: body || "{}",
            }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            if (r.status === 401 && pass === 0) break; // 换 token 后重来
            return r;
          }
        }
        // 401 走单飞刷新（与 server/credits 侧共享互斥，防并发轮换互相践踏）
        const rr = await refreshTokenLocked(this.id, account, creds).catch(() => ({ ok: false }));
        if (!rr.ok) return { ok: false, status: 401, data: null, message: rr.message };
        creds = { token: rr.token, refreshToken: rr.refreshToken };
      }
      return { ok: false, status: 0, data: null, message: "上游无可用响应" };
    },

    /**
     * 每日签到状态：checkin-activity-status（新）→ checkin-status（旧）逐路径降级。
     * 参考 cockpit-tools 实测：code===0 为成功；code!=0 为业务失败（如已签到/未开放）
     */
    async checkinStatus(account, secrets) {
      const r = await this.billingCall(account, secrets, [
        "/billing/meter/checkin-activity-status",
        "/v2/billing/meter/checkin-activity-status",
        "/billing/meter/checkin-status",
        "/v2/billing/meter/checkin-status",
      ], "{}");
      const d = (r.data && (r.data.data || r.data)) || null;
      const code = Number((r.data && r.data.code) ?? 0);
      if (!r.ok || !d || (code !== 0 && code !== 200)) {
        return {
          ok: false,
          unavailable: /已签到|already|未开启|未开放|已过期/i.test(String((r.data && (r.data.message || r.data.msg)) || r.message || "")),
          message: String((r.data && (r.data.message || r.data.msg)) || r.message || `HTTP ${r.status}`),
        };
      }
      const b = (k1, k2) => {
        const v = d[k1] ?? d[k2];
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        return false;
      };
      return {
        ok: true,
        active: b("active", "Active"),
        checkedIn: b("today_checked_in", "todayCheckedIn"),
        streakDays: Number(d.streak_days ?? d.streakDays ?? 0) || 0,
        dailyCredit: Number(d.daily_credit ?? d.dailyCredit ?? 0) || 0,
        todayCredit: Number(d.today_credit ?? d.todayCredit ?? 0) || 0,
        checkinDates: Array.isArray(d.checkin_dates ?? d.checkinDates) ? (d.checkin_dates ?? d.checkinDates).map(String) : [],
        weekProgress: Array.isArray(d.week_progress) ? d.week_progress.map(Boolean) : [],
      };
    },

    /** 每日签到领取：daily-checkin（code!=0 且幂等码/「已签到」文案 → already，不算失败） */
    async checkin(account, secrets) {
      const r = await this.billingCall(account, secrets, [
        "/billing/meter/daily-checkin",
        "/v2/billing/meter/daily-checkin",
      ], "{}");
      const code = Number((r.data && r.data.code) ?? 0);
      const msg = String((r.data && (r.data.message || r.data.msg)) || r.message || "");
      const d = (r.data && (r.data.data || r.data)) || null;
      if (r.ok && (code === 0 || code === 200)) {
        return {
          ok: true,
          success: d && d.success != null ? !!d.success : true,
          message: (d && d.message) || "签到成功",
          credit: Number((d && (d.credit ?? d.today_credit ?? d.todayCredit)) ?? 0) || 0,
          streakDays: Number((d && (d.streak_days ?? d.streakDays)) ?? 0) || 0,
          reward: (d && d.reward) || null,
        };
      }
      const already = /\b(10001|14001)\b/.test(msg) || /已签到|今日已签到|already/i.test(msg);
      return { ok: already, already, message: msg || `签到失败 HTTP ${r.status}` };
    },

    /** 国际版一次性 trial 加油包（CN 无此端点）：幂等码 14051 = 已领过 */
    async trial(account, secrets) {
      const r = await this.billingCall(account, secrets, ["/billing/ide/trial", "/v2/billing/ide/trial"], "{}");
      const code = Number((r.data && r.data.code) ?? 0);
      const msg = String((r.data && (r.data.message || r.data.msg)) || r.message || "");
      if (r.ok && (code === 0 || code === 200)) return { ok: true, claimed: true, message: msg || "加油包领取成功" };
      if (/\b14051\b/.test(msg) || /已领取|已领过|already/i.test(msg)) return { ok: true, claimed: false, already: true, message: msg || "已领取过" };
      return { ok: false, message: msg || `领取失败 HTTP ${r.status}` };
    },

    /** Token 刷新：X-Refresh-Token 头 + 空体 {}（该头只允许出现在此端点）。
     *  头组对齐参考项目 RefreshHeaders：CommonHeaders 完整形态（origin/referer/风控闸门/机器指纹）
     *  + refresh 专属头；X-Auth-Refresh-Source 走 rules 配置（workbuddy2api="plugin"、TWA="workbuddy"） */
    async refreshToken(account, secrets) {
      const c = this.cfg();
      if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或从本机导入" };
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      const origin = c.origin || (channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");
      const headers = {
        "content-type": "application/json",
        accept: "application/json",
        origin,
        referer: origin + "/",
        "user-agent": c.userAgent,
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1",
        "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
        "x-refresh-token": secrets.refreshToken,
        "x-auth-refresh-source": c.refreshSource || "plugin",
      };
      if (account && account.uid) {
        const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
        headers["x-machine-id"] = stable("machine");
        headers["x-session-id"] = stable("session");
      }
      if (account && account.enterpriseId) headers["x-enterprise-id"] = account.enterpriseId;
      let lastErr = "";
      for (const base of bases) {
        const r = await httpJson(`${base}/v2/plugin/auth/token/refresh`, {
          method: "POST",
          headers,
          body: "{}",
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const d = r.data && (r.data.data || r.data);
        if (r.ok && d && (d.accessToken || d.access_token)) {
          return {
            ok: true,
            token: String(d.accessToken || d.access_token),
            refreshToken: d.refreshToken || d.refresh_token ? String(d.refreshToken || d.refresh_token) : secrets.refreshToken,
          };
        }
        lastErr = (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
      }
      return { ok: false, message: lastErr };
    },
  };
}

const workbuddy = makeWorkBuddy("workbuddy");
const workbuddy_ai = makeWorkBuddy("workbuddy_ai");

// ===== 商汤小浣熊（Raccoon AI 桌面端，渠道 id: raccoon） =====
// 协议事实基线见 docs/raccoon-反代/会话1~5（静态逆向，asar 解包 + PyInstaller 反汇编）。
// 防伪强度低：无请求签名/HMAC/证书 pinning/混淆。鉴权 = JWT Bearer + x-client-* 六头 + 受信设备绑定。
// 关键结论：
//   · 上行 LLM 是纯 OpenAI Chat Completions（上游疑似 LiteLLM 网关），1:1 透传即可；
//   · SenseNova 方言（XML 伪 tool_calls/reasoning_content）是客户端后处理，反代无需实现；
//   · 纯对话/积分调用不触发受信设备绑定（X-Client-Device-ID 大写头只出现在 bind/heartbeat），
//     LLM 只带小写 x-client-device-id（遥测性质）；号池每号独立指纹即可；
//   · 积分/配额查询全在渲染层（/points/v1、/office/v3/setting_info），主进程/box-agent 不参与。
// 指纹注入：x-client-* 六头按号隔离（会话2 §6），deviceId 每号一个随机 UUID 入池固定。

/** raccoon 账号级稳定指纹：复用 store.meta 里的画像，缺省时按 uid/id 派生随机 UUID 兜底（不编码序号/日期防风控识别） */
function raccoonIdentity(account) {
  const meta = (account && account.meta) || {};
  const seed = crypto.createHash("sha256").update(`agenthub:raccoon:${(account && (account.uid || account.id)) || "anon"}`).digest("hex");
  // 由 hash 派生一个合法 UUID v4 形态（8-4-4-4-12），账号内稳定、账号间互异
  const uuid = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
  return {
    deviceId: meta.deviceId || uuid,
    deviceName: meta.deviceName || "DESKTOP-" + seed.slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X"),
    osVersion: meta.osVersion || "10.0.26200",
    platform: meta.clientPlatform || "desktop-windows-x64",
    platformNoArch: String(meta.clientPlatform || "desktop-windows-x64").replace(/-(x64|arm64)$/i, ""),
    officeIdentity: String(meta.officeIdentity || "").trim(),
  };
}

/** LLM 请求头（box-agent 链路）：六头 + 会话关联头 + Bearer。仅 x-client-* 给官方域用 */
function raccoonChatHeaders(c, account, secrets, sessionId, turnId, title) {
  const idn = raccoonIdentity(account);
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${secrets.token}`,
    "x-client-name": c.clientName,
    "x-client-platform": idn.platform,
    "x-client-version": c.clientVersion,
    "x-client-os-version": idn.osVersion,
    "x-client-channel": c.clientChannel,
    "x-client-device-id": idn.deviceId,
    // 会话级关联头：request 内同 id（重试/换号复用），跨 request 不复用（会话2 §1.4）
    "X-RACCOON-Session-ID": sessionId,
    "X-RACCOON-Turn-ID": turnId,
    // 官方客户端取首条用户消息前 20 字符作标题；空串是异常信号（风控识别点）
    "X-RACCOON-Title": title || "",
    "X-RACCOON-Call-Kind": "chat",
  };
  // 团队版才带组织码（个人版 office_identity="personal"，不带）
  if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity;
  return h;
}

/** 浏览器域请求头（积分/配额/账号类）：渲染层 fetchWithAuth 形态（X-Client-* 大写、不带架构、版本带 v） */
function raccoonWebHeaders(c, account, secrets) {
  const idn = raccoonIdentity(account);
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${secrets.token}`,
    "X-Client-Platform": idn.platformNoArch,
    "X-Client-Version": c.webClientVersion || "v1.0.35",
    "X-Client-Device-ID": idn.deviceId,
  };
  if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity;
  return h;
}

/** 刷新端点专用头（会话1 §1.3：只凭 refresh_token，不带旧 access）。
 *  不复用 raccoonWebHeaders 再 delete authorization——那种写法依赖键名恰好小写，一旦头名风格
 *  变化 delete 会静默失效，把已过期的 access 一起发上去，服务端完全可能因此 401 */
function raccoonRefreshHeaders(c, account) {
  const idn = raccoonIdentity(account);
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    "X-Client-Platform": idn.platformNoArch,
    "X-Client-Version": c.webClientVersion || "v1.0.35",
    "X-Client-Device-ID": idn.deviceId,
  };
  if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity;
  return h;
}

const raccoon = {
  id: "raccoon",

  // 临期预刷新窗口（credits.cjs 用）：小浣熊 access 仅 3h（会话1 §2），若沿用默认 24h，
  // 每轮额度刷新（含定时 30min 一轮）都会触发一次刷新——与桌面端抢同一个 refresh_token
  // 互相作废（掉登录根因）。贴官方 300s 惰性语义，把主动轮换压到接近到期才发生
  refreshWindowSec: 300,

  cfg() {
    return rules.get("headers.json").raccoon;
  },

  /** 模型别名归一：raccoon-chat / raccoon-chat-ml → 官方默认模型（会话3 §4.1） */
  mapModel(model) {
    const m = String(model || "");
    if (/^raccoon-chat(-ml)?$/i.test(m)) return this.cfg().defaultModel;
    return m;
  },

  models() {
    const catalog = [...catalogMap("raccoon").values()].map((m) => String(m.id));
    return unionIds(catalog, [this.cfg().defaultModel]);
  },

  /** 拉取官方模型目录：GET /model_catalog，返回 {default_model, models:[{name,...,params:{context_window,max_tokens},points_multiplier}]}
   *  access 仅 3h，401 时就地刷新一次再重试（chat/额度链路都有，目录拉取原来没有） */
  async fetchModels(account, secrets) {
    let r = await this.fetchModelsOnce(account, secrets);
    if (r.authError) {
      const rr = await refreshTokenLocked(this.id, account, secrets).catch(() => ({ ok: false }));
      if (rr.ok) {
        if (account && account.id) {
          store.updateAccount(account.id, { token: rr.token, refreshToken: rr.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
        }
        r = await this.fetchModelsOnce(account, { token: rr.token, refreshToken: rr.refreshToken });
      }
    }
    if (r.authError) return { ok: false, message: "账号登录态失效（401），请重新登录" };
    return r;
  },

  async fetchModelsOnce(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    const r = await httpJson(c.modelsUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { ok: false, authError: true, message: "登录态已过期（HTTP 401）" };
    const list = findList(r.data, "models", 0);
    if (!r.ok || !Array.isArray(list) || !list.length) {
      return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）${r.message ? " " + r.message : ""}` };
    }
    const models = [];
    for (const raw of list) {
      const id = raw && (raw.name || raw.id || raw.model);
      if (typeof id !== "string" || !id || raw.visible === false) continue;
      const params = (raw && raw.params) || {};
      models.push({
        id,
        name: String(raw.display_name || raw.description || raw.name || id),
        rate: Number(raw.points_multiplier ?? raw.billing_effective_multiplier ?? raw.billing_multiplier) || null,
        capabilities: {
          images: (Array.isArray(raw.tags) ? raw.tags : []).some((t) => /image|vision/i.test(String(t))),
          reasoning: true,
          tools: true,
        },
        contextLength: Number(raw.context_window ?? params.context_window) || 0,
        maxOutputTokens: Number(raw.max_tokens ?? params.max_tokens) || 0,
      });
    }
    if (!models.length) return { ok: false, message: "目录为空或无可对话模型" };
    return { ok: true, models };
  },

  /** OpenAI body → raccoon 改写：模型别名归一 + 强制流式 usage；剥离 AgentHub 注入的内部字段，
   *  只留 OpenAI 标准字段（raccoon 上游疑似 LiteLLM，未知字段可能 400）；
   *  max_tokens 缺省时补 80000（官方 hosted 默认值，会话3 §1.3），客户端已发则尊重原值 */
  rewriteBody(model, body) {
    const out = { ...(body || {}) };
    out.model = this.mapModel(model);
    out.stream = true;
    if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
    out.stream_options.include_usage = true;
    // 官方客户端恒发 max_tokens=80000（hosted）；上游对缺失该字段的复杂请求（带 tools/长 prompt）
    // 会静默丢弃不返回字节——表现为 10s 首字节超时，而极简测试连接能过
    if (!out.max_tokens && !out.max_completion_tokens) out.max_tokens = 80000;
    // max_completion_tokens → max_tokens 翻译（新版 OpenAI SDK 客户端发前者）
    if (out.max_completion_tokens != null) {
      const mct = Number(out.max_completion_tokens);
      if (Number.isFinite(mct) && mct > 0 && out.max_tokens == null) out.max_tokens = mct;
      delete out.max_completion_tokens;
    }
    // 内部/非标准字段（不发给上游；其他标准字段如 temperature/top_p/tools 原样透传）
    delete out.conversation_id;
    delete out.conversationId;
    delete out.prompt_cache_key;
    return out;
  },

  /** 对话主流程：纯 OpenAI 协议透传（会话3 §7）。usage 在末尾 usage chunk；错误体 /error 或 顶层 code */
  async chat({ account, secrets, model, body, emit, meta }) {
    const c = this.cfg();
    const payload = JSON.stringify(this.rewriteBody(model, body));
    // 会话头稳定性：同一会话内 X-RACCOON-Session-ID 必须恒定（官方客户端行为）。
    // 原来每请求随机生成，多轮对话时上游看到"新 session 却带完整历史"的逻辑矛盾，
    // 触发风控静默丢弃（真实请求 10s 超时而测试连接通过的根因）。
    // sessionId = sha256(账号uid + 消息指纹)，跨请求稳定；turnId = sessionId + 消息数（第几轮）
    const convKey = (meta && meta.conversationId) || util.stableConvId(body && body.messages) || "";
    const uid = String((account && account.uid) || "anon");
    let sessionId, turnId;
    if (convKey) {
      const seed = crypto.createHash("sha256").update(`raccoon:sess:${uid}:${convKey}`).digest("hex");
      sessionId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
      const turnN = Array.isArray(body && body.messages) ? body.messages.length : 1;
      const tSeed = crypto.createHash("sha256").update(`${seed}:turn:${turnN}`).digest("hex");
      turnId = `${tSeed.slice(0, 8)}-${tSeed.slice(8, 12)}-4${tSeed.slice(13, 16)}-a${tSeed.slice(17, 20)}-${tSeed.slice(20, 32)}`;
    } else {
      sessionId = util.uuid();
      turnId = util.uuid();
    }
    // 官方客户端标题：首条用户消息前 20 字符（认证与令牌会话 §3.3）
    let title = "";
    const msgs = Array.isArray(body && body.messages) ? body.messages : [];
    const firstUser = msgs.find((m) => m && m.role === "user" && typeof m.content === "string");
    if (firstUser) title = String(firstUser.content).replace(/\s+/g, " ").trim().slice(0, 20);
    const headers = raccoonChatHeaders(c, account, secrets, sessionId, turnId, title);
    const { resp, cancelTimer } = await fetchStream(c.chatUrl, { method: "POST", headers, body: payload });
    const result = { status: 200, planLimit: false };
    try {
      await pumpSse(resp, (_event, raw) => {
        if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
        const data = parseJson(raw);
        if (!data) return;
        // 错误体：上游失败可能在流内返回 {error:{code,message}} 或 {code:1000007,...}（会话3 §6.1）
        const errObj = data.error || null;
        const codeNum = Number((errObj && errObj.code) ?? (data.choices ? 0 : data.code)) || 0;
        const msgStr = String((errObj && errObj.message) || data.message || "");
        if (errObj || (codeNum && codeNum !== 0 && codeNum !== 200)) {
          const isQuota = codeNum === 1000007 || /insufficient|credit|quota|balance|积分|余额|欠费/i.test(msgStr);
          const status = isQuota ? 402 : codeNum === 401 || codeNum === 200003 ? 401 : codeNum === 429 ? 429 : 502;
          if (isQuota) result.planLimit = true;
          emit({ type: "error", status, code: codeNum, message: msgStr || `上游错误 ${codeNum}` });
          return;
        }
        const choice = Array.isArray(data.choices) && data.choices[0];
        if (choice) {
          if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
          if (choice.message && Object.keys(choice.message).length) emit({ type: "delta", delta: choice.message }); // 非流式兜底
          if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
        }
        if (data.usage) {
          emit({
            type: "usage",
            usage: {
              prompt_tokens: Number(data.usage.prompt_tokens ?? data.usage.input_tokens) || 0,
              completion_tokens: Number(data.usage.completion_tokens ?? data.usage.output_tokens) || 0,
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

  /** 积分余额：GET /points/v1/balance。返回 {available_points,...}，号池取 available_points 作余额。
   *  顶层 code 非 0/200 或 HTTP 401 → authError（会话4 §1：统一 {code,data} 信封） */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    const r = await httpJson(c.balanceUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { authError: true };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (code === 200003 || /authorization_verify_error/i.test(String((r.data && r.data.message) || ""))) return { authError: true };
    if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
      throw new Error(`额度查询失败：HTTP ${r.status}${r.data && r.data.message ? " " + r.data.message : ""}${r.message ? " " + r.message : ""}`);
    }
    const d = r.data.data || r.data;
    const credits = Number(d.available_points ?? d.availablePoints) || 0;
    return { credits, raw: d };
  },

  /** 签到状态：小浣熊无独立"签到状态"接口，每日积分随登录自动发放，标 unavailable 说明查询不适用 */
  async checkinStatus(account, secrets) {
    try {
      const r = await this.queryCredits(account, secrets);
      if (r.authError) return { ok: false, message: "凭证失效，请重新登录" };
      return { ok: true, unavailable: true, checkedIn: false, credits: r.credits, message: `小浣熊无独立签到查询，每日登录自动发放（当前积分 ${r.credits}）` };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  },

  /** 每日签到 = 登录送积分：POST /login/points/grant（幂等，granted=true 才是本次新发放）。
   *  同时锁定当日积分 7 天（会话4 §7.5：当天登录延长） */
  async checkin(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    const r = await httpJson(c.grantUrl, { method: "POST", headers, body: "{}" }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { ok: false, message: "凭证失效，请重新登录" };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
      return { ok: false, message: (r.data && r.data.message) || r.message || `签到失败 HTTP ${r.status}` };
    }
    const granted = !!(r.data.data && r.data.data.granted);
    return { ok: true, already: !granted, claimed: granted, message: granted ? "已领取每日积分" : "今日已领取过" };
  },

  /** 加油包领取：raccoon 加油包为付费购买（无免费"领取"动作），不支持 → 返回不可用提示 */
  async trial() {
    return { ok: false, message: "小浣熊加油包为付费购买，无免费领取动作" };
  },

  /** Token 刷新：POST /auth/v1/refresh，body 仅 {refresh_token}（会话1 §1.3）。
   *  与桌面端共用 ~/.box-agent/config/auth.json：刷前以文件里的最新 refresh_token 为准
   *  （桌面端可能刚刷过并旋转，用号池快照里的旧值会吃 401 —— 掉登录根因），
   *  刷新成功后原子写回，让两边始终持同一份凭据；文件归属校验不过则绝不碰文件。
   *  旋转竞态兜底：401 可能是并发刷新已旋转 refresh——重读文件，值变了就用新值再试一次，
   *  仍 401 才判失效（方案文档 §2.3：/401 后重读文件再试一次） */
  async refreshToken(account, secrets) {
    const c = this.cfg();
    const uid = account && account.uid;
    const own0 = raccoonAuth.ownedTokens(uid, secrets && secrets.refreshToken);
    let refreshToken = (own0 && own0.refreshToken) || (secrets && secrets.refreshToken) || "";
    if (!refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
    let headers = raccoonRefreshHeaders(c, account);

    for (let attempt = 0; attempt < 2; attempt++) {
      const body = JSON.stringify({ refresh_token: refreshToken });
      const r = await httpJson(c.refreshUrl, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const d = (r.data && (r.data.data || r.data)) || null;
      const token = d && (d.access_token || d.accessToken || d.token);
      if (r.ok && token) {
        // 服务端旋转 refresh 就覆盖，不返回则保留旧的（会话1 §1.3；协议支持旋转但不强制）
        const nextRefresh = d.refresh_token || d.refreshToken ? String(d.refresh_token || d.refreshToken) : refreshToken;
        // 回写共用文件（仅当文件确属本号）：桌面端下次刷新读到新值，不再拿旧 refresh 撞 401
        const own = raccoonAuth.ownedTokens(uid, nextRefresh);
        if (own) raccoonAuth.writeTokens({ accessToken: String(token), refreshToken: nextRefresh });
        return { ok: true, token: String(token), refreshToken: nextRefresh };
      }
      if (r.status === 401) {
        // 401 可能是桌面端并发刷新旋转了 refresh——重读文件，值变了就用新值再试一次
        const own = raccoonAuth.ownedTokens(uid, refreshToken);
        const latest = (own && own.refreshToken) || "";
        if (latest && latest !== refreshToken) {
          refreshToken = latest;
          continue; // 值变了，再试一次
        }
        return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      }
      return { ok: false, message: (d && (d.message || d.msg)) || r.message || `刷新失败 HTTP ${r.status}` };
    }
    return { ok: false, expired: true, message: "登录态已过期（重试后仍 401），请重新登录" };
  },

  /** 用户信息（导入后补全 uid/昵称）：GET /auth/v1/user_info（会话4 §6）。
   *  兼容单参 userInfo(token)（discovery 签名）与双参 userInfo(token, account)（OAuth 上下文） */
  async userInfo(token, account) {
    const c = this.cfg();
    const acc = account || {};
    const headers = raccoonWebHeaders(c, acc, { token });
    const r = await httpJson(c.userInfoUrl, { method: "GET", headers }).catch(() => ({ ok: false, status: 0, data: null }));
    const d = r.data && (r.data.data || r.data);
    if (r.ok && d) {
      return {
        uid: String(d.id || d.user_id || d.uid || ""),
        name: String(d.name || d.nickname || d.user_name || ""),
      };
    }
    // 接口不可用时本地解码兜底：小浣熊 JWT 顶层是 iss（账户 ID）/ sid，util.jwtDecode 读不出，
    // 必须用 raccoon 自己的口径（与 discovery.scanRaccoon 一致），否则 uid 恒空、号池去重失效
    return { uid: raccoonAuth.tokenUid(token), name: "" };
  },
};

const ADAPTERS = { trae, workbuddy, workbuddy_ai, raccoon };

function get(channel) {
  return ADAPTERS[channel] || null;
}

// ===== 刷新并发互斥（single-flight） =====
// 上游 refreshToken 是轮换语义（参考项目实证：旧 refreshToken 可能一次性失效）：
// 并发 401 各自拿同一个旧 token 刷，后发者必然失败并把好号误判 relogin。
// 按账号收敛为单飞——并发调用共享同一个 promise，成功者写库，其余复用结果
const refreshInflight = new Map();

function refreshTokenLocked(channel, account, secrets, extraOrigins) {
  const ad = get(channel);
  if (!ad) return Promise.resolve({ ok: false, message: `未知渠道 ${channel}` });
  const key = `${channel}:${(account && (account.id || account.uid)) || ""}`;
  const inflight = refreshInflight.get(key);
  if (inflight) return inflight;
  const p = Promise.resolve()
    .then(() => ad.refreshToken(account, secrets, extraOrigins))
    .finally(() => refreshInflight.delete(key));
  refreshInflight.set(key, p);
  return p;
}

/** 合并模型目录（/v1/models）：canonical id 归并 + 来源标记 + 目录元数据（倍率/能力/上下文） */
function mergedModels() {
  const seen = new Map();
  const catMaps = {};
  for (const channel of Object.keys(ADAPTERS)) catMaps[channel] = catalogMap(channel);
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
  for (const entry of seen.values()) {
    entry.name = entry.id;
    entry.rate = null;
    entry.capabilities = {};
    entry.contextLength = 0;
    entry.maxOutputTokens = 0;
    // 多源模型按来源顺序取第一个有值条目（catalog 顺序即渠道优先级）
    for (const channel of entry.sources) {
      const meta = catMaps[channel].get(entry.id.toLowerCase());
      if (!meta) continue;
      if (meta.name && meta.name !== entry.id && entry.name === entry.id) entry.name = String(meta.name);
      if (entry.rate == null && meta.rate != null && !Number.isNaN(Number(meta.rate))) entry.rate = Number(meta.rate);
      entry.capabilities = { ...entry.capabilities, ...(meta.capabilities || {}) };
      if (!entry.contextLength && meta.contextLength) entry.contextLength = Number(meta.contextLength) || 0;
      if (!entry.maxOutputTokens && meta.maxOutputTokens) entry.maxOutputTokens = Number(meta.maxOutputTokens) || 0;
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

module.exports = { get, ADAPTERS, mergedModels, modelOwners, httpJson, refreshTokenLocked };
