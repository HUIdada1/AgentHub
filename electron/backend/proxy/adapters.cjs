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
    // X-Uid 官方客户端恒带（参考项目 SOLOHeaders 实证），缺了是风控识别点
    if (account && account.uid) h["x-uid"] = String(account.uid);
    return h;
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
      const d = r.data && (r.data.data || r.data);
      if (r.ok && d && (r.data.code === 0 || r.data.code == null) && (d.access_token || d.accessToken)) {
        const token = String(d.access_token || d.accessToken).replace(/^Cloud-IDE-JWT\s+/i, "");
        return {
          ok: true,
          token,
          refreshToken: d.refresh_token || d.refreshToken ? String(d.refresh_token || d.refreshToken) : secrets.refreshToken,
        };
      }
      lastErr = (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
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

/** 官方客户端会话头族（参考项目 issue #35 实证：后台按 X-Conversation-Request-ID 聚合请求）。
 *  B3 规范只认 16/32 hex TraceId 与 16 hex SpanId，非法值会破坏链路关联 */
function wbConversationHeaders(body) {
  const hex32 = () => crypto.randomBytes(16).toString("hex");
  const convReqId = hex32();
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
      const origin = channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
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
      if (account.uid) {
        h["x-user-id"] = account.uid;
        // 每账号一台固定虚拟设备：跨重启稳定、账号间互异（防设备指纹缺失/漂移关联风控）
        const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
        h["x-machine-id"] = stable("machine");
        h["x-session-id"] = stable("session");
      } else {
        h["x-no-user-id"] = "1";
      }
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
      return h;
    },

    /** OpenAI body → WB 改写：强制流式 + stream_options + tool_choice 归一 + developer 角色归一
     *  + 孤儿 tool_call/tool 清理 + 指纹清洗（对齐参考项目 payload.go + sanitize.go 全管线）。
     *  11128 的三类诱因都在这里拦截：role 白名单外的 developer、整句精确匹配的审核指纹、
     *  裸错误码数字（模板表 "11128"→"11-128"）与不成对的工具调用（上游对后续每条消息都 400） */
    rewriteBody(model, body) {
      const tpl = rules.get("wb_template_map.json") || {};
      const out = { ...body };
      out.model = model;
      out.stream = true; // WB 只支持 SSE，非流式本地聚合模拟（方案 §2.2）
      // 官方 CLI 流式必发：上游据此在末帧返回 usage
      if (!out.stream_options) out.stream_options = { include_usage: true };
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
      // 文本指纹清洗（对齐 sanitize.go）：模板表逐字替换 → header 键值段整段剥除 → cc_ 裸键值剥除 → 裸键名缩写
      const cleanText = (s) => {
        let t = applyTpl(s);
        t = t.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "");
        t = t.replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "");
        t = t.replace(/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr");
        return t;
      };
      // 孤儿 tool_call↔tool 配对清理（参考项目实证：不成对会让上游对之后每条消息都返 400）
      const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
      const validToolIds = new Set();
      for (const m of rawMsgs) {
        if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) if (tc && tc.id) validToolIds.add(String(tc.id));
        }
      }
      const answeredIds = new Set();
      for (const m of rawMsgs) {
        if (m && m.role === "tool" && m.tool_call_id) answeredIds.add(String(m.tool_call_id));
      }
      const merged = [];
      for (const m of rawMsgs) {
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
      // console 域（国际版官方客户端路径）要求首条消息必须是 system，否则 400 code 11128
      // "first message is not system prompt"（参考项目 ensureConsoleSystem 实证，吸收 PR #45）
      if (channelId === "workbuddy_ai" && out.messages.length) {
        const firstRole = String(out.messages[0].role || "").trim().toLowerCase();
        if (firstRole !== "system") {
          out.messages.unshift({ role: "system", content: "You are a helpful assistant." });
        }
      }
      // 会话 id 注入（官方客户端恒带；客户端已传则保留）
      if (!out.conversation_id) out.conversation_id = util.uuid();
      return out;
    },

    /** 对话主流程：WB 上游已近似 OpenAI 形态，透传归一（方案 §6.3 SSE 转换 WB）。
     *  国际版优先走 /console/chat/completions（官方国际客户端现行路径），404/405 回退 /v2（参考项目实证） */
    async chat({ account, secrets, model, body, emit }) {
      const c = this.cfg();
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const headers = { ...this.headers(account, secrets), ...wbConversationHeaders(body) };
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
          // 402 积分耗尽（insufficient credits）以错误体形式出现。
          // 必须置 result.planLimit：只 emit error 的话 server 侧换号分支认不到，
          // 该账号既不冷却也不换号，请求被记 200 成功，下次还会继续选中这个已耗尽的号
          if (data.error) {
            const status = Number(data.error.code) === 402 || /insufficient|credit|quota|balance/i.test(String(data.error.message || "")) ? 402 : 502;
            if (status === 402) result.planLimit = true;
            emit({ type: "error", status, code: data.error.code || 0, message: data.error.message || "insufficient credits" });
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
        const rr = await this.refreshToken(account, creds).catch(() => ({ ok: false }));
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

    /** Token 刷新：X-Refresh-Token 头 + 空体 {}（该头只允许出现在此端点） */
    async refreshToken(account, secrets) {
      const c = this.cfg();
      if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或从本机导入" };
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      let lastErr = "";
      for (const base of bases) {
        const r = await httpJson(`${base}/v2/plugin/auth/token/refresh`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer",
            "user-agent": "WorkBuddy",
            "x-refresh-token": secrets.refreshToken,
            "x-auth-refresh-source": "workbuddy",
          },
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

const ADAPTERS = { trae, workbuddy, workbuddy_ai };

function get(channel) {
  return ADAPTERS[channel] || null;
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

module.exports = { get, ADAPTERS, mergedModels, modelOwners, httpJson };
