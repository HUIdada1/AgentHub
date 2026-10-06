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
const config = require("../config.cjs");

function proxyConfig() {
  try {
    return (config.loadConfig && config.loadConfig().proxy) || {};
  } catch {
    return {};
  }
}

const FIRST_BYTE_MS = 30000; // 首 token 30s 超时判失败。实测成功请求 TTFT P99≈8.7s、最大 20.2s，
// 10s 会误杀慢模型/thinking 首包（参考项目无首字节总超时，读空闲容忍 300s，这里取全覆盖+余量的折中）
const FIRST_BYTE_MAX_MS = 180000; // 首字节预算封顶（超长 prompt 的 prefill 可能上百秒）
const FIRST_BYTE_PER_10K_MS = 1000; // 每 1 万输入 token 追加的预算
const STREAM_IDLE_MS = 300000; // 流中读超时 300s

/** 估算输入规模（按序列化字符数折算 token，中英混排约 3 字符/token；宁高勿低，避免误杀超大 prompt） */
function estimateInputTokens(payload) {
  return Math.ceil(String(payload == null ? "" : payload).length / 3);
}

/**
 * 按 prompt 规模算首字节预算：基准 30s + 每 1 万输入 token 追加 1s，封顶 180s。
 * 固定 30s 打不过超大 prompt：实测 54 万 token 的蒸馏请求，同一批 prompt 在 WorkBuddy CN 渠道
 * 首字节就要 35–38s，于是每次都被判"首字节超时"，连续 3 次即把账号熔断 30 分钟。
 * 小请求仍是 30s 起步，不放松对真正卡死上游的判定。
 */
function firstByteBudgetMs(payload) {
  const extra = Math.floor(estimateInputTokens(payload) / 10000) * FIRST_BYTE_PER_10K_MS;
  return Math.min(FIRST_BYTE_MS + extra, FIRST_BYTE_MAX_MS);
}

// ===== HTTP 基础 =====

/** 流式请求：首字节超时内必须拿到响应头并开始产出，否则 abort 判失败（可故障转移）
 *  opts.firstByteMs 由调用方按 prompt 规模给定（缺省 FIRST_BYTE_MS） */
async function fetchStream(url, opts) {
  const { firstByteMs, ...rest } = opts || {};
  const budgetMs = Math.max(1000, Number(firstByteMs) || FIRST_BYTE_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  let resp;
  try {
    // redirect 默认 follow，但**必须允许调用方覆盖**：Qoder 的请求头带签名且签名覆盖
    // path+query，301 重定向后签名必然失效（实测 gateway http→301 https 真实存在），
    // 故它传 redirect:"error" 要明确报错而非跟随。原先写死 "follow" 会吃掉该参数。
    resp = await fetch(url, { redirect: "follow", ...rest, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = !!(e && e.name === "AbortError");
    throw Object.assign(
      new Error(timedOut ? `上游首字节超时（${Math.round(budgetMs / 1000)}s）` : `网络错误：${e.message}`),
      {
        network: true,
        // 首字节超时是"这次请求太大 / 上游这一刻慢"，不是账号故障：分类器据此**不计入熔断**、
        // 也不落账号冷却，否则一次慢请求就能把整条渠道冻结半小时（实测事故根因）
        firstByteTimeout: timedOut,
      }
    );
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
    try { reader.cancel().catch(() => {}); } catch { /* 正常完成或已取消无需处理 */ }
  }
  scanner.feed(decoder.decode());
  scanner.flush();
}

/** 账号级稳定指纹：device_id（自然分布 15 位数字，首位非零，消除连续补零假特征）/ machine_id（64 hex），同账号多次请求保持一致 */
function deviceIds(account) {
  const seed = String((account && (account.id || account.uid)) || "anon");
  const h = crypto.createHash("sha256").update(`agenthub:device:${seed}`).digest();
  let digits = String((h[0] % 9) + 1); // 首位保证 1~9
  let zeroCount = 0;
  for (let i = 1; i < 15; i++) {
    let d = h[i] % 10;
    if (d === 0) {
      zeroCount++;
      if (zeroCount >= 3) {
        d = (h[i] % 9) + 1; // 连续 0 达到 2 个以上时强制扰动为 1~9，根除连续 0 聚集
        zeroCount = 0;
      }
    } else {
      zeroCount = 0;
    }
    digits += String(d);
  }
  const machineId = crypto.createHash("sha256").update(`agenthub:machine:${seed}`).digest("hex");
  return { deviceId: digits, machineId };
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

/**
 * 通用模态嗅探：在"结构未知"的上游模型条目里找是否支持图片输入。
 * 用于字段名未逆向清楚/上游改版的渠道（如 Trae）：按 key 名（vision/image/multimodal/modalit）
 * 递归找布尔或数组信号。**找不到时返回 undefined**（=未声明，绝不写成 false——false 会主动禁止客户端附图）。
 */
const IMG_KEY_RE = /^(supports?|has|is|accepts?)(vision|image|multimodal)|(^|_)(vision|image|multimodal|modalit)|modalit/i;
/** 排噪声：与"生成/尺寸/字节数"相关的键不代表"能读图输入"（如 image_gen / imagePixelBudget / text-to-image） */
const IMG_KEY_DENY = /image_?(gen|generation|size|pixel|max|budget|bytes|count|edit)|text_?to_?image|imagePixel|imageMax/i;
const isImgKey = (k) => IMG_KEY_RE.test(k) && !IMG_KEY_DENY.test(k);
function sniffImages(item) {
  let found; // true 最强；false 仅在没有任何 true 信号时采用；undefined = 无信号
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return; }
    for (const [k, v] of Object.entries(node)) {
      if (!isImgKey(k)) { if (v && typeof v === "object") visit(v, depth + 1); continue; }
      if (typeof v === "boolean") { if (v) found = true; else if (found === undefined) found = false; }
      else if (Array.isArray(v)) { if (v.some((x) => /image|vision/i.test(String(x)))) found = true; }
      else if (typeof v === "string") { if (/^(image|vision|multimodal)$/i.test(v)) found = true; }
      else if (v && typeof v === "object") visit(v, depth + 1);
    }
  };
  visit(item, 0);
  return found;
}

/** 由嗅探结果构造能力对象（未声明时不写 images 键） */
function capsWithImages(img, base) {
  const caps = { ...(base || {}) };
  if (img !== undefined) caps.images = img;
  return caps;
}

/**
 * 把上游给的 token 上限归一成非负整数：非法/缺失一律返回 0（=未知）。
 * 模型上限类字段**绝不给编造的默认值**——下游客户端会拿它比对用量，
 * 假值会把正常回答误判成上下文溢出（详见 trae.fetchModels 的注释）。
 */
function tokenLimit(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Trae 目录条目的上下文/输出上限（字段结构实证自 2026-10-03 抓取的 get_detail_param 原始响应）：
 *
 *   {
 *     context_window_tokens: { dev: 200000, max: 268000 },   // 上下文窗口，**按环境分档的字典**
 *     model_detail_list: [
 *       { model_name: "xxx__dev", prompt_max_tokens: 168000, max_tokens: 32000 },
 *       { model_name: "xxx__max", prompt_max_tokens: 240000, max_tokens: 32000 },
 *     ],
 *   }
 *
 * 要点：① 窗口是字典而非标量（43 个模型里 10 个有 dev/max 两档，个别为空）；
 * ② 输出上限在 model_detail_list 里，且**每个档位一个条目**（取 [0] 会取错档）；
 * ③ prompt_max_tokens 恒等于「上下文窗口 − max_tokens」（给输出预留），故窗口直接取
 *    context_window_tokens，输出取 max_tokens，两者语义不重叠。
 * 多档位时取最大值，与合并视图「取各来源最大声明」的口径一致，避免少报。
 */
function traeLimits(it) {
  const o = it && typeof it === "object" ? it : {};
  let contextLength = 0;
  const cw = o.context_window_tokens;
  if (cw && typeof cw === "object" && !Array.isArray(cw)) {
    for (const v of Object.values(cw)) contextLength = Math.max(contextLength, tokenLimit(v));
  } else {
    contextLength = tokenLimit(cw);
  }
  let maxOutputTokens = 0;
  if (Array.isArray(o.model_detail_list)) {
    for (const det of o.model_detail_list) maxOutputTokens = Math.max(maxOutputTokens, tokenLimit(det && det.max_tokens));
  }
  return { contextLength, maxOutputTokens };
}

/**
 * 能力合并：images 采用 **OR** 语义（任一来源声明支持即支持），undefined 不覆盖已有值；
 * 其余能力沿用后者覆盖。用于修掉"某渠道的 false 把共享模型名的 true 顶掉"的问题
 * （glm-5.3-flash 曾因 zcode 的 false 在合并视图里被当成纯文本，实际它支持图片）。
 */
function mergeCapabilities(base, add) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(add || {})) {
    if (v === undefined) continue;
    if (k === "images") { if (v === true || out[k] === undefined) out[k] = v; continue; }
    out[k] = v;
  }
  return out;
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
          // 上限取自官方目录条目，字段结构实证自 2026-10-03 抓取的原始响应（详见 traeLimits 注释）。
          // 取不到写 0（=未知，与 workbuddy 系列静态兜底一致）。**原先无条件写 131072 是凭空捏造**：
          // 下游客户端（如 DSH 的 pi-ai）会拿它比对用量 —— isContextOverflow 的
          // 「stop 且 usage.input + cacheRead > contextWindow」分支 —— 把 30 万 token 的正常回答
          // 误判成 CONTEXT_WINDOW_EXCEEDED，整个 turn 失败（且溢出恢复的摘要请求同样超限，二次失败）。
          models.push({
            id,
            name: String(name),
            rate: null,
            capabilities: capsWithImages(sniffImages(it)),
            ...traeLimits(it),
          });
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
    out.max_tokens = Number(body.max_tokens ?? body.max_completion_tokens) > 0 ? Number(body.max_tokens ?? body.max_completion_tokens) : 4096;
    out.conversation_id = util.uuid();
    out.user_id = account.uid || "";
    out.session_id = util.uuid();
    out.device_id = deviceId;
    out.machine_id = machineId;
    out.project_id = util.uuid();
    out.workspace_id = "e04cdd";
    out.prompt_max_tokens = Number(body.prompt_max_tokens ?? body.context_length) > 0 ? Number(body.prompt_max_tokens ?? body.context_length) : 168000;
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
    const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) });
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
          capabilities: (() => {
            // 官方字段优先；缺失时退回通用嗅探（不写 false，避免把"未声明"当"不支持"）
            const explicit = it.supportsImages ?? it.supports_images;
            const img = typeof explicit === "boolean" ? explicit : sniffImages(it);
            const base = {
              reasoning: !!(it.supportsReasoning ?? it.supports_reasoning),
              tools: !!(it.supportsToolCall ?? it.supports_tool_call),
            };
            return capsWithImages(img, base);
          })(),
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
          const r = await fetchStream(url, { method: "POST", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) });
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
              // usage 透传完整对象（保留 prompt_tokens_details.cached_tokens / credit 等扩展字段）
              usage: {
                ...data.usage,
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

/** HTTP header 值只能是 latin-1（ByteString）：非 ASCII 码点一律百分号编码。
 *  否则中文标题会让 Node fetch 直接抛
 *    Cannot convert argument to a ByteString because the character at index 0 has a value of 24110 ...
 *  请求根本没发出去，却因 catch 分支把账号罚进冷却（表现为「渠道冷却 / 池中无可用账号」）。
 *  用 Array.from 按码点迭代，避免把 emoji 的代理对拆成孤立 surrogate 使 encodeURIComponent 抛 URIError。 */
function latin1HeaderValue(v) {
  return Array.from(String(v == null ? "" : v))
    .map((ch) => (/[\x20-\x7E]/.test(ch) ? ch : encodeURIComponent(ch)))
    .join("");
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
    // 标题来自用户正文，含中文时直接进 header 会让 fetch 抛 ByteString 错（见 latin1HeaderValue）
    "X-RACCOON-Title": latin1HeaderValue(title),
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
        capabilities: (() => {
          // 官方 tags 会归一成 "vision"（逆向文档：image/image-understanding → vision）；缺失时退回嗅探
          const byTag = (Array.isArray(raw.tags) ? raw.tags : []).some((t) => /image|vision/i.test(String(t)));
          const img = byTag ? true : sniffImages(raw);
          return capsWithImages(img, { reasoning: true, tools: true });
        })(),
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
    const { resp, cancelTimer } = await fetchStream(c.chatUrl, { method: "POST", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) });
    const result = { status: 200, planLimit: false };
    // 首字节达标即清 30s 首字节超时定时器：只在 finally 清的话定时器会在整条流期间一直挂着，
    // 任何超过 30 秒的回答都会被 AbortController 砍断（报原始 AbortError "This operation was aborted"）。
    let settled = false;
    try {
      await pumpSse(resp, (_event, raw) => {
        if (!settled) {
          settled = true;
          cancelTimer();
        }
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
            // usage 透传完整对象（保留 prompt_tokens_details.cached_tokens / credit 等扩展字段）
            usage: {
              ...data.usage,
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

  /** 每日积分 = 两步懒结算：先 GET setting_info「激活」当日 Web 会话，再 POST grant 领取。
   *
   *  实测（2026-10-07 00:11，双账号、客户端未启动）：跳过第 1 步时 grant 恒返回
   *  granted:false 且积分明细（/points/v1/bills）当日无 daily_grant 单据——即服务端
   *  并未发放；补上 setting_info 后 grant 立即 granted:true，单据 created_at=调用时刻、
   *  grant_at=当日 00:00（账期归属）、expire_at=+7 天。
   *
   *  官方规则页写的「00:00 自动发放、无需登录触发」指 grant_at 的账期归属；实际入库
   *  是懒结算——要等当天首次 Web 会话活动（setting_info 正是客户端启动时的必调项）。
   *  granted=false 语义 = 当日已发放（幂等），非失败。 */
  async checkin(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    // 第 1 步：setting_info 激活当日 Web 会话（懒结算前置；失败不阻断，由 grant 自行暴露）
    await httpJson(c.settingUrl, { method: "GET", headers }).catch(() => null);
    // 第 2 步：领取
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
      if (r.status === 401 || (r.status === 400 && Number(r.data && r.data.code) === 200822)) {
        // 401 或 200822 (refresh token conflict or reused)：
        // 可能是桌面端并发刷新旋转了 refresh——重读文件，值变了就用新值再试一次
        const own = raccoonAuth.ownedTokens(uid, refreshToken);
        const latest = (own && own.refreshToken) || "";
        if (latest && latest !== refreshToken) {
          refreshToken = latest;
          continue; // 值变了，再试一次
        }
        // 双保险容错：如果当前 access_token 依然有效（未过期且 user_info 正常），绝不误判为 expired！
        if (secrets && secrets.token) {
          const u = await this.userInfo(secrets.token, account).catch(() => null);
          if (u && u.uid && String(u.uid) === String(uid)) {
            // 当前 access_token 仍然在线，仅 refresh_token 存在单侧冲突，继续保持 online 态
            return { ok: true, token: secrets.token, refreshToken };
          }
        }
        return { ok: false, expired: true, message: "登录态已过期，请重新登录；若刚在小浣熊客户端点过「退出登录」，服务端凭据会被吊销，号池内该账号需重新导入或登录" };
      }
      return { ok: false, message: (d && (d.message || d.msg)) || r.message || `刷新失败 HTTP ${r.status}` };
    }
    return { ok: false, expired: true, message: "登录态已过期（重试后仍 401），请重新登录；客户端「退出登录」会吊销服务端凭据，号池内该账号需重新导入或登录" };
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

// ===== LobsterAI（网易有道龙虾，渠道 id: lobster） =====// 协议事实（2026-10-05 本机实测 + 参考实现 lobsterai2api@21c39a4 交叉验证，见 docs/lobster-反代）：
//   · 鉴权 = Bearer JWT（OAuth 授权码换发；回环回调 http://127.0.0.1:<port>/auth/callback）
//   · 对话 = 原生 OpenAI Chat Completions，但**上游只接受 stream=true**（非流式实测 500）
//   · 业务错误可能藏在 HTTP 200 的 SSE 流里（event:error 帧）→ 必须窥探首块
//   · 签到 = client-activities 三段式（slot → context → actions/check_in），活动按 clientVersion 门禁
//   · 积分 = /api/user/profile-summary 的 totalCreditsRemaining（/api/user/quota 不含活动积分）

const LOBSTER_UA_FALLBACK = "2026.9.23";
// 版本号缓存：签到活动按 clientVersion 下发，旧版本号会拿到 slotState=empty（实测 0.1.0 被隐藏）。
// 1h TTL，失败 10min 后重试（与参考实现同口径）
let lobsterVersionCache = { val: "", at: 0, failedAt: 0 };

/**
 * MiniMax 系模型的思考链归一：把 content 里的 `<think>…</think>` 抽成 reasoning_content。
 *
 * 实测三例对照（2026-10-05，同一 prompt「说：正常」）：
 *   · MiniMax-M3      → 思考链**混在 content**（`<think>The user just said…`），无 reasoning_content 字段
 *   · glm-5.3-flash   → 独立 `reasoning_content` 字段（1144 字符）
 *   · deepseek-v4-pro → 独立 `reasoning_content` 字段（542 字符）
 *
 * 通用层 server.cjs 只认 `reasoning_content`（server.cjs L435），若不归一，MiniMax 的思考链
 * 会被当正文原样透传（用户看到 "<think>The user simply…"）。
 *
 * 流式注意：标签可能被切成多帧（`<thi` + `nk>`），故用**跨帧状态机**。
 * 状态随 chat() 一次调用创建、调用内共享（见 createThinkSplitter 的用法）。
 */
function createThinkSplitter() {
  let inThink = false;
  let pending = ""; // 可能是半个标签的尾巴（如 "<thi"），留到下一帧判定
  const OPEN = "<think>";
  const CLOSE = "</think>";

  /** 取 s 末尾与 tag 开头匹配的最长前缀长度（把半个标签留到下一帧再判） */
  const tagPrefixLen = (s, tag) => {
    for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
      if (s.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  };

  /** 喂入一段 content，返回 { reasoning, content }（两者都可能为空串）。
   *  注意：疑似半个标签的尾巴会被**推迟到下一帧**才计入 reasoning（可能不是标签），
   *  因此调用方必须按帧累积 reasoning，不能只看最后一帧。 */
  return function split(content) {
    if (typeof content !== "string" || !content) return { reasoning: "", content: "" };
    let buf = pending + content;
    pending = "";
    let reasoning = "";
    let out = "";
    for (;;) {
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i >= 0) {
          out += buf.slice(0, i);
          buf = buf.slice(i + OPEN.length);
          inThink = true;
          continue;
        }
        const keep = tagPrefixLen(buf, OPEN);
        if (keep > 0) {
          out += buf.slice(0, buf.length - keep);
          pending = buf.slice(buf.length - keep);
        } else {
          out += buf;
        }
        break;
      }
      const j = buf.indexOf(CLOSE);
      if (j >= 0) {
        reasoning += buf.slice(0, j);
        buf = buf.slice(j + CLOSE.length);
        inThink = false;
        continue;
      }
      const keep = tagPrefixLen(buf, CLOSE);
      if (keep > 0) {
        reasoning += buf.slice(0, buf.length - keep);
        pending = buf.slice(buf.length - keep);
      } else {
        reasoning += buf;
      }
      break;
    }
    return { reasoning, content: out };
  };
}

/**
 * 把一个 delta 按 <think> 归一：返回 { reasoning, rest }。
 * rest 是改写后的 delta（content 可能被清空/截短）；reasoning 非空时由调用方
 * 挂成独立的 reasoning_content 增量发给通用层。
 * 快路径：既无 <think 也不在 think 段内时原样返回，零开销。
 */
function splitThinkDelta(split, d) {
  const content = d && d.content;
  if (typeof content !== "string" || !content) return { reasoning: "", rest: d };
  if (!content.includes("<think") && !content.includes("</think")) {
    // 不含标签：若上次留下半截标签（pending），仍需喂进去才能判出来
    const r = split(content);
    if (!r.reasoning && r.content === content) return { reasoning: "", rest: d };
    const rest = { ...d };
    if (r.content) rest.content = r.content;
    else delete rest.content;
    return { reasoning: r.reasoning, rest };
  }
  const r = split(content);
  const rest = { ...d };
  if (r.content) rest.content = r.content;
  else delete rest.content;
  return { reasoning: r.reasoning, rest };
}

// ===== ModelScope（魔搭 · 阿里）：官方 OpenAI 兼容 + 魔粒每日任务 =====
// 与其它渠道的本质差异：这是**官方公开 API**（非逆向），对话面零签名零客户端依赖；
// 但「魔粒」任务面在 www.modelscope.cn 的 openapi 上，鉴权是三头同发 + 浏览器上下文，
// 且点赞是有副作用的公开动作（PUT 星标），故 checkin 的动作面与状态面严格分离：
//   checkinStatus = 纯只读（读 earn/rules 与 balance，不产生任何写入）
//   checkin       = 会话触碰（保 daily_active）+ 按剩余额度点赞（幂等：读 today_used 决定次数）
const modelscope = {
  id: "modelscope",

  cfg() {
    return rules.get("headers.json").modelscope;
  },

  /** 对话头：官方网关只认 Bearer（实测三头对 api-inference 非必需，但带上无害且与站点一致） */
  chatHeaders(token) {
    const c = this.cfg();
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
    };
  },

  /** 魔粒控制面头：**三头同发 + 浏览器上下文**——缺 UA/Origin/Referer 会被风控中间件
   *  静默忽略（实测：只带 Authorization 时 earn/rules 返回空/异常，补齐后才稳定 200） */
  apiHeaders(token, refererPath) {
    const c = this.cfg();
    const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
    return {
      authorization: `Bearer ${token}`,
      "OpenAPI-Token": token,
      "X-Modelfun-Token": token,
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": c.userAgent || "Mozilla/5.0",
      origin: base,
      referer: `${base}${refererPath || c.refererPath || "/my/overview"}`,
    };
  },

  /** Cookie 头（/api/v1 族专用）。
   *
   *  为什么有这个：魔搭端点分两族且**严格互斥**（实测确立，见 rules.cjs 注释）：
   *    「OAuth 可用族」推理 /v1/chat + 魔粒 /openapi/v1/*
   *    「仅 Cookie/ms- 可用族」点赞 /api/v1/mcpServers/* + 令牌管理 /api/v1/users/tokens*
   *  且 ms- 令牌虽能点赞却不触发 daily_active（参考项目实测注释：
   *  只有 Web 会话（Cookie）活动才触发日活奖励）⇒ **Cookie 是唯一两全的凭据**。 */
  cookieHeaderOf(secrets) {
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    return String(meta[this.cfg().cookieMetaKey] || "").trim();
  },

  /** 星标族头（点赞/列目标共用）：有 Cookie 用 Cookie，否则退 ms- 令牌 */
  starHeaders(secrets, refererPath) {
    const c = this.cfg();
    const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
    const cookie = this.cookieHeaderOf(secrets);
    const ua = c.userAgent || "Mozilla/5.0";
    const common = {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": ua,
      origin: base,
      referer: `${base}${refererPath || c.refererPath || "/my/overview"}`,
    };
    if (cookie) return { cookie, ...common };
    // 回退：ms- 令牌（OAuth 令牌在此族会 401，故不尝试）
    const token = String((secrets && secrets.token) || "");
    return { authorization: `Bearer ${token}`, "OpenAPI-Token": token, "X-Modelfun-Token": token, ...common };
  },

  /** 是否有可用于星标族的凭据（Cookie 或 ms- 令牌；OAuth 令牌不算） */
  hasStarCredential(secrets) {
    if (this.cookieHeaderOf(secrets)) return true;
    const tk = String((secrets && secrets.token) || "");
    return !!tk && !tk.startsWith(String(this.cfg().oauthTokenPrefix || "ms_oauth"));
  },

  /** Web 会话触碰（触发 daily_active）。
   *
   *  daily_active 即「注册并登陆，每日登录即可获取」——参考项目 HAR 抓包确认前端每次页面加载
   *  都会调 /api/v1/users/login/info，故必须**真的走 Web 请求**才算登录事件；纯 OpenAPI
   *  （Bearer）调用不计入日活（参考项目实测注释明确记录）。
   *
   *  返回 { ok, touched, dead }：dead=true 表示 Cookie 已失效（供上层提示重新授权）。 */
  async webTouch(secrets) {
    const c = this.cfg();
    const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
    const cookie = this.cookieHeaderOf(secrets);
    if (!cookie) return { ok: false, touched: 0, dead: false, message: "无 Web 会话 Cookie" };
    const ua = c.userAgent || "Mozilla/5.0";
    const htmlHeaders = {
      cookie,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": ua,
      referer: `${base}/`,
    };
    let touched = 0;
    let dead = false;
    const deadRe = new RegExp(c.cookieDeadRe || "not logged in", "i");
    // ① Web 页面触碰（触发 Web 端活跃埋点中间件）
    for (const p of (c.cookieTouchPaths || ["/my/overview", "/"])) {
      const r = await httpJson(`${base}${p}`, { method: "GET", headers: htmlHeaders }).catch(() => ({ ok: false, status: 0 }));
      if (r.status === 401 || r.status === 403) dead = true;
      if (r.ok) touched++;
    }
    // ② 登录事件端点（daily_active 的关键——HAR 抓包确认前端必调）
    const jsonHeaders = { ...htmlHeaders, accept: "application/json, text/plain, */*" };
    for (const p of (c.cookieLoginEventPaths || [])) {
      const r = await httpJson(`${base}${p}`, { method: "GET", headers: jsonHeaders }).catch(() => ({ ok: false, status: 0, data: null }));
      if (r.status === 401 || r.status === 403) dead = true;
      if (deadRe.test(JSON.stringify((r && r.data) || ""))) dead = true;
      if (r.ok) touched++;
    }
    // ③ OpenAPI 轻量端点（魔粒系统激活，Cookie 同样可调）
    for (const p of (c.cookieOpenapiPaths || [])) {
      const r = await httpJson(`${base}${p}`, { method: "GET", headers: jsonHeaders }).catch(() => ({ ok: false }));
      if (r.ok) touched++;
    }
    return { ok: touched > 0 && !dead, touched, dead };
  },

  models() {
    return unionIds([...catalogMap("modelscope").values()].map((m) => String(m.id)), []);
  },

  /** 模型名归一：魔搭模型 id 形如 `deepseek-ai/DeepSeek-V4.1-Flash`（含斜杠，大小写敏感）。
   *  容忍：小写/下划线变体、以及「去掉 owner 前缀」的简写（用户可能只写 DeepSeek-V4.1-Flash） */
  mapModel(model) {
    const m = String(model || "");
    if (!m) return m;
    const catalog = catalogMap("modelscope");
    if (catalog.has(m.toLowerCase())) return catalog.get(m.toLowerCase()).id;
    const norm = m.toLowerCase().replace(/_/g, "-");
    for (const [k, v] of catalog) {
      if (k.replace(/_/g, "-") === norm) return String(v.id);
    }
    // 简写回退：`GLM-5.3-Flash` → `zhipuai/glm-5.3-flash`
    for (const [k, v] of catalog) {
      const tail = k.split("/").pop();
      if (tail === norm || tail.replace(/_/g, "-") === norm) return String(v.id);
    }
    return m;
  },

  /** 请求体改写：官方网关是标准 OpenAI 兼容，需要处理两件事：
   *  ① max_completion_tokens → max_tokens 翻译；
   *  ② **流式必须显式请求 usage**——实测：不带 stream_options.include_usage 时，
   *     上游每个 delta 帧都带 `usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}`
   *     占位且**不发最终真实帧**，网关侧 token 统计恒为 0；带上后最后一帧
   *     （choices:[] + 真实 usage）才会出现。 */
  rewriteBody(model, body, account) {
    const out = { ...(body || {}) };
    out.model = this.mapModel(model || out.model);
    if (out.max_completion_tokens != null && out.max_tokens == null) {
      out.max_tokens = Number(out.max_completion_tokens) || 4096;
    }
    delete out.max_completion_tokens;
    if (out.stream === true) {
      out.stream_options = { ...(out.stream_options || {}), include_usage: true };
    }
    // prompt_cache_key（与其它渠道同款）：账号段硬隔离，跨账号绝不复用同一键。
    // ⚠ 只注入 prompt_cache_key，**不注入 conversation_id**——后者是 WB/raccoon 的厂商私有字段，
    //   对严格的 OpenAI 兼容端点有 400 风险；会话段改用前 3 条消息的稳定指纹（同样满足
    //   「同一会话多轮键稳定」，且不向该端点引入未知字段）。
    //
    // ⚠ 实测结论（2026-10-06，真实账号直连上游）：**魔搭上游不提供前缀缓存**。
    //   · 上游 usage 只有 3 个键：prompt_tokens / completion_tokens / total_tokens，
    //     **完全没有 prompt_tokens_details.cached_tokens**（流式与非流式一致）。
    //   · 带 8KB 长前缀连发 4 次：prompt_tokens 恒为 3345，**无任何折扣**。
    //   · 带上 prompt_cache_key 再连发 4 次：token 数同样不变，HTTP 全 200（**字段被安全忽略，不报 400**）。
    //   ⇒ 本渠道历史记录 cache_read_tokens 全为 0 是**上游不提供该字段**，不是我们记账缺失，
    //     也不是「缓存未命中」。（对照：同机 zcode 95.0% / workbuddy_ai 82.7% / workbuddy 62.7%，
    //     那些渠道的上游确实给缓存字段。）
    //   既然如此为何仍注入？**为与其它渠道保持一致的行为**，且上游若日后启用缓存即自动受益；
    //   代价为零（实测不会引发 400）。
    if (!out.prompt_cache_key) {
      out.prompt_cache_key = util.promptCacheKey((account && account.uid) || "", util.stableConvId(out.messages));
    }
    return out;
  },

  /** 拉取模型目录：GET /v1/models（需 Bearer）。⚠ 清单是「按热度精选」而非全集
   *  （实测 35 个；GLM-5.3-Flash 不在清单内但直调 200）——故清单只用于展示，
   *  不用于可用性判定。返回 {ok, models:[{id,name,...}]} */
  async fetchModels(account, secrets) {
    const c = this.cfg();
    const r = await httpJson(c.modelsUrl, { method: "GET", headers: this.chatHeaders(secrets.token) })
      .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "凭证失效，请重新登录" };
    if (!r.ok || !r.data) return { ok: false, message: `模型目录拉取失败：HTTP ${r.status}${r.message ? " " + r.message : ""}` };
    const list = Array.isArray(r.data.data) ? r.data.data : [];
    const models = [];
    for (const raw of list) {
      const id = raw && (raw.id || raw.modelId);
      if (typeof id !== "string" || !id) continue;
      models.push({
        id,
        name: String((raw && (raw.name || raw.modelName)) || id),
        rate: null, // 魔粒按 tier 计费，非倍率制；不编造 rate
        capabilities: { images: true, reasoning: true, tools: true },
        contextLength: tokenLimit(raw && (raw.contextLength || raw.contextWindow)),
        maxOutputTokens: tokenLimit(raw && (raw.maxOutputTokens || raw.max_output_tokens)),
      });
    }
    if (!models.length) return { ok: false, message: "模型目录为空" };
    return { ok: true, models };
  },

  /** 对话：官方 OpenAI 兼容直通（上游原生支持 stream/tool_calls/reasoning_content，
   *  无需像龙虾那样做思考链归一——实测 reasoning_content 是独立字段） */
  async chat({ account, secrets, model, body, emit }) {
    const c = this.cfg();
    const payload = JSON.stringify(this.rewriteBody(model, body, account));
    const headers = this.chatHeaders(secrets.token);
    let resp, cancelTimer;
    try {
      ({ resp, cancelTimer } = await fetchStream(c.chatUrl, { method: "POST", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) }));
    } catch (e) {
      // 非 2xx 由 fetchStream 抛出（形如「上游 HTTP 403：{...错误体...}」）。
      // 魔搭的 403 有两种**账号侧可自行修复**的前置条件，必须给出可操作指引而非通用 502：
      //   ① 未绑定阿里云账号   → "please bind your Alibaba Cloud account"
      //   ② 已绑定但未实名认证 → "real-name verified"（2026-10-06 双账号实测发现）
      // 二者都属 403；其余 4xx/5xx 原样上抛交由通用分类器处理。
      const text = String((e && e.message) || "");
      if (/HTTP 403/.test(text) && /real-name|realname|实名/i.test(text)) {
        emit({
          type: "error", status: 403, code: 403,
          message: "该魔搭账号绑定的阿里云账号未完成实名认证，无法调用推理。请到 https://www.modelscope.cn/my/accountsettings 完成实名后重试。",
        });
        return { status: 403, planLimit: false, needRealName: true };
      }
      if (/HTTP 403/.test(text) && /bind your Alibaba Cloud account|绑定阿里云/i.test(text)) {
        emit({
          type: "error", status: 403, code: 403,
          message: "该魔搭账号尚未绑定阿里云账号，无法调用推理。请到 https://www.modelscope.cn/my/accountsettings 绑定后再试。",
        });
        return { status: 403, planLimit: false, needBind: true };
      }
      throw e;
    }
    const result = { status: 200, planLimit: false };

    // ⚠ 非流式响应必须单独处理（2026-10-06 实测踩坑）：
    //   魔搭对 stream:false 返回**单个 application/json 对象**（不是 SSE），内容在
    //   choices[0].message.content。若直接交给 pumpSse，SseScanner 只认 `data:` 行，
    //   整个响应会解析出 **0 帧** → 客户端拿到空回复（连 finish 都没有、usage 为 0），
    //   酷似「模型没回答」。这正是 DSH 默认非流式时必现的空响应缺陷。
    //   （先前误判为「delta 空壳顶掉 message」——那层判断本身没错，但它落在一条永远不会
    //     执行到的路径上，因为整个响应根本没进帧处理逻辑。）
    const ctype = String((resp.headers && resp.headers.get && resp.headers.get("content-type")) || "");
    const looksSse = /text\/event-stream/i.test(ctype);
    if (!looksSse) {
      const bodyText = await resp.text().catch(() => "");
      cancelTimer();
      const data = parseJson(bodyText);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        emit({ type: "error", status: 502, message: "上游返回了无法解析的响应体" });
        return result;
      }
      const errObj = data.error || null;
      if (errObj) {
        const msg = String(errObj.message || errObj.code || "上游错误");
        const isQuota = /insufficient|quota|balance|魔粒|余额|exceeded/i.test(msg);
        if (isQuota) result.planLimit = true;
        emit({ type: "error", status: isQuota ? 402 : 502, code: errObj.code || 0, message: msg });
        return result;
      }
      const choice = Array.isArray(data.choices) && data.choices[0];
      if (choice) {
        // 非流式优先取 message（真身）；delta 只是伴随的空壳
        const pick = (choice.message && typeof choice.message === "object") ? choice.message : choice.delta;
        if (pick && typeof pick === "object") {
          const clean = {};
          for (const [k, v] of Object.entries(pick)) {
            if (v === null) continue;
            clean[k] = v;
          }
          // 空串 content 也要发：下游据此区分「有响应但内容为空」与「上游无响应」
          if (Object.keys(clean).length) emit({ type: "delta", delta: clean });
        }
        emit({ type: "finish", reason: choice.finish_reason || "stop" });
      }
      if (data.usage) {
        const u = data.usage;
        const pt = Number(u.prompt_tokens ?? u.input_tokens) || 0;
        const ct = Number(u.completion_tokens ?? u.output_tokens) || 0;
        const tt = Number(u.total_tokens) || 0;
        if (pt || ct || tt) emit({ type: "usage", usage: { ...u, prompt_tokens: pt, completion_tokens: ct, total_tokens: tt || pt + ct } });
      }
      return result;
    }

    let settled = false;
    try {
      await pumpSse(resp, (event, raw) => {
        if (!settled) {
          settled = true;
          cancelTimer();
        }
        if (event === "error") {
          const d = parseJson(raw);
          const msg = String((d && (d.message || (d.error && d.error.message))) || raw || "上游返回错误帧").slice(0, 300);
          const isQuota = /insufficient|quota|balance|魔粒|余额|欠费|exceeded/i.test(msg);
          if (isQuota) result.planLimit = true;
          emit({ type: "error", status: isQuota ? 402 : 502, code: (d && d.code) || 0, message: msg });
          return;
        }
        if (raw === "[DONE]") {
          emit({ type: "finish", reason: "" });
          return;
        }
        const data = parseJson(raw);
        // 非对象帧守卫（本仓库既有约定：null/数组/裸标量一律丢弃，防 TypeError 中断整条流）
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        const errObj = data.error || null;
        if (errObj) {
          const msg = String(errObj.message || errObj.code || "上游错误");
          const isQuota = /insufficient|quota|balance|魔粒|余额|exceeded/i.test(msg);
          if (isQuota) result.planLimit = true;
          // 实名认证门槛（实测：绑定阿里云账号但未实名 → 403，错误信息含 real-name verified）：
          // 这是**账号侧可自行修复**的前置条件，不能混成通用 502——否则用户只看到「上游错误」，
          // 不知道要去 accountsettings 做实名。故单独归类为 403 并把可操作指引带进 message。
          const isRealName = /real-name|realname|实名/i.test(msg);
          if (isRealName) {
            emit({
              type: "error", status: 403, code: errObj.code || 0,
              message: "该魔搭账号绑定的阿里云账号未完成实名认证，无法调用推理。请到 https://www.modelscope.cn/my/accountsettings 完成实名后重试。",
            });
            return;
          }
          emit({ type: "error", status: isQuota ? 402 : 502, code: errObj.code || 0, message: msg });
          return;
        }
        const choice = Array.isArray(data.choices) && data.choices[0];
        if (choice) {
          // ⚠ 非流式响应同时带 delta 与 message（2026-10-06 实测）：
          //   delta   = {role:null, content:"", tool_calls:null, …}   ← 空壳
          //   message = {role:"assistant", content:"正常", …}          ← 真实内容
          // 旧写法 `choice.delta || choice.message` 取到 truthy 的空壳 delta、丢弃真实内容 →
          // 非流式客户端拿到空回复（finish_reason:stop、usage 极小，酷似「模型没回答」）。
          // 改为优先取真正带内容的一方。
          const carries = (o) => !!(o && (
            (typeof o.content === "string" && o.content !== "")
            || (typeof o.reasoning_content === "string" && o.reasoning_content !== "")
            || (Array.isArray(o.tool_calls) && o.tool_calls.length)
            || (Array.isArray(o.function_calls) && o.function_calls.length)
          ));
          const dRaw = choice.delta;
          const mRaw = choice.message;
          const d = carries(dRaw) ? dRaw : (carries(mRaw) ? mRaw : (dRaw || mRaw));
          // 上游 delta 里带一堆 null 占位字段（role:null / tool_calls:null / function_calls:null），
          // 直接透传会让下游 stripEmptyDelta 之外的路径收到无意义空壳；这里剥掉纯 null 字段
          if (d) {
            const clean = {};
            for (const [k, v] of Object.entries(d)) {
              if (v === null) continue;
              if (typeof v === "string" && v === "") {
                // 保留空串 content（[DONE] 前的收尾帧靠它标记结束），丢弃其它空串占位
                if (k !== "content") continue;
              }
              clean[k] = v;
            }
            if (Object.keys(clean).length) emit({ type: "delta", delta: clean });
          }
          if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
        }
        if (data.usage) {
          // ⚠ 上游每个 delta 帧都带 usage 字段（实测 18/18 帧），但除最后一帧外全是空壳（全 0）。
          // 若无条件 emit，会把真实 usage 之前的一堆 0 推给上层，聚合器最终拿到 0——
          // 表现为「对话完全正常但 token 统计恒为 0」。故只在有真实数值时 emit。
          const u = data.usage;
          const pt = Number(u.prompt_tokens ?? u.input_tokens) || 0;
          const ct = Number(u.completion_tokens ?? u.output_tokens) || 0;
          const tt = Number(u.total_tokens) || 0;
          if (pt || ct || tt) {
            emit({ type: "usage", usage: { ...u, prompt_tokens: pt, completion_tokens: ct, total_tokens: tt || pt + ct } });
          }
        }
      });
    } finally {
      cancelTimer();
    }
    return result;
  },

  /** 魔粒余额：GET /openapi/v1/magicubes/balance → data.total_balance */
  async queryCredits(account, secrets) {
    const r = await this.magicubesGet(secrets, this.cfg().balancePath);
    if (r.authError) return { authError: true };
    if (!r.ok) throw new Error(r.message || "魔粒余额查询失败");
    const d = (r.data && r.data.data) || {};
    const credits = Number(d.total_balance ?? d.available_balance ?? d.balance) || 0;
    return { credits, raw: d };
  },

  /** 魔粒控制面 GET 封装：统一三头 + 错误语义（401/403 → authError，供上层触发重登） */
  async magicubesGet(secrets, path, query) {
    const c = this.cfg();
    const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
    const url = `${base}${path}${query ? (path.includes("?") ? "&" : "?") + query : ""}`;
    const r = await httpJson(url, { method: "GET", headers: this.apiHeaders(secrets.token) })
      .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "凭证失效，请重新登录" };
    if (!r.ok || !r.data) return { ok: false, message: r.message || `HTTP ${r.status}` };
    // 站点信封：{success:true,data:…}；openapi 直出数据时 data 字段即业务体
    if (r.data.success === false) return { ok: false, message: r.data.message || "上游返回失败" };
    return { ok: true, data: r.data };
  },

  /** 读任务规则表（28 条）：返回原始数组 */
  async fetchEarnRules(secrets) {
    const r = await this.magicubesGet(secrets, this.cfg().earnRulesPath);
    if (!r.ok) return r;
    const list = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    return { ok: true, rules: list };
  },

  /** 从规则表里取某个 rule_key */
  ruleOf(rules, key) {
    return (rules || []).find((x) => String(x && x.rule_key) === String(key)) || null;
  },

  /** 签到状态（**纯只读，零副作用**）：报告每日任务的领取情况与点赞剩余额度。
   *  返回结构对齐其它渠道：{ok, checkedIn, already, reward, message}，
   *  额外带 detail 供号池页展示「200 登录 / 50 绑云 / 40 点赞」的分解。 */
  async checkinStatus(account, secrets) {
    try {
      const c = this.cfg();
      const rr = await this.fetchEarnRules(secrets);
      if (rr.authError) return { ok: false, message: "凭证失效，请重新登录" };
      if (!rr.ok) return { ok: false, message: rr.message || "任务规则查询失败" };
      const rules = rr.rules;
      const daily = this.ruleOf(rules, c.ruleDailyActive);
      const bind = this.ruleOf(rules, c.ruleAliyunBind);
      const like = this.ruleOf(rules, c.ruleLike);
      const likeCap = Number(like && like.daily_cap) || 0;
      const likeUsed = Number(like && like.today_used) || 0;
      const likeRemain = Math.max(likeCap - likeUsed, 0);
      const likeAmount = Number(like && like.amount) || 2;
      // 「已签到」判定：两条每日任务都已领取（daily_cap=1 时 today_remain=0）
      const dailyDone = !!daily && Number(daily.today_remain) === 0 && Number(daily.today_used) > 0;
      const bindDone = !!bind && Number(bind.today_remain) === 0 && Number(bind.today_used) > 0;
      const checkedIn = dailyDone;
      const reward = (Number(daily && daily.amount) || 0) + (Number(bind && bind.amount) || 0);
      const parts = [];
      parts.push(dailyDone ? `登录奖励 ${Number(daily.amount) || 200} 已领` : `登录奖励 ${Number(daily && daily.amount) || 200} 待领`);
      parts.push(bindDone ? `绑云奖励 ${Number(bind && bind.amount) || 50} 已领` : `绑云奖励 ${Number(bind && bind.amount) || 50} 待领`);
      parts.push(likeRemain > 0 ? `点赞可领 ${likeRemain}×${likeAmount}=${likeRemain * likeAmount} 魔粒` : "点赞今日已满");
      return {
        ok: true,
        checkedIn,
        already: checkedIn && likeRemain === 0,
        reward,
        likeRemain,
        likeAmount,
        message: parts.join(" · "),
        detail: { daily, bind, like },
      };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  },

  /** 每日任务执行（**有副作用**：Web 会话触碰 + 点赞）。
   *  幂等设计：先读 today_used/today_remain，只补做剩余次数——重复调用不会超领。
   *
   *  凭据分层（关键，见 rules.cjs 注释与 §2.8）：
   *    ① Web 会话触碰走 **Cookie**（唯一触发 daily_active 的凭据；Bearer 调用不计日活）
   *    ② 点赞走 **Cookie**（OAuth 令牌在此端点被上游 401 拒绝；ms- 令牌可但无日活）
   *    ③ 魔粒余额/规则查询走 **OAuth 令牌**（该族两种凭据都可）
   *  无 Cookie 时降级为 ms- 令牌（能点赞、不计日活），并在结果里**如实标注**，
   *  不再把「无可用凭据」静默吞成「无可点赞目标」——那是本实现早期的缺陷。 */
  async checkin(account, secrets) {
    const c = this.cfg();
    const hasCookie = !!this.cookieHeaderOf(secrets);
    const canStar = this.hasStarCredential(secrets);

    // ① 会话触碰：读余额与规则（Cookie 通道下另有 Web 页面触碰，见 webTouch）
    const before = await this.magicubesGet(secrets, this.cfg().balancePath);
    if (before.authError) return { ok: false, message: "凭证失效，请重新登录" };
    if (!before.ok) return { ok: false, message: before.message || "会话触碰失败" };
    const balBefore = Number((before.data && before.data.data && before.data.data.total_balance)) || 0;

    // ①b Web 会话触碰（Cookie 专用）：这是 daily_active 的真正触发条件
    let web = null;
    if (hasCookie) {
      web = await this.webTouch(secrets).catch((e) => ({ ok: false, touched: 0, dead: false, message: String((e && e.message) || e) }));
      if (web && web.dead) {
        return {
          ok: false, needReauth: true,
          message: "Web 会话 Cookie 已失效（无法触发每日登录奖励与点赞），请在「添加账号」里重新完成一次 OAuth 授权以刷新会话",
        };
      }
    }

    const rr = await this.fetchEarnRules(secrets);
    if (!rr.ok) return { ok: false, message: rr.message || "任务规则查询失败" };
    const daily = this.ruleOf(rr.rules, c.ruleDailyActive);
    const bind = this.ruleOf(rr.rules, c.ruleAliyunBind);
    const like = this.ruleOf(rr.rules, c.ruleLike);
    const dailyAmt = Number(daily && daily.amount) || 0;
    const bindAmt = Number(bind && bind.amount) || 0;

    // ② 点赞：按剩余额度补做（需要星标族凭据）
    const cap = Math.min(Number(like && like.daily_cap) || 0, Number(c.likeHardCap) || 25);
    const used = Number(like && like.today_used) || 0;
    const remain = Math.max(cap - used, 0);
    let liked = 0;
    let likeErr = "";
    if (remain > 0 && !canStar) {
      // 无星标族凭据：如实说明，而不是伪装成「无目标」
      likeErr = "点赞需 Web 会话（Cookie）或 ms- 令牌，当前账号只有 OAuth 令牌——请重新 OAuth 授权（应用内窗口会自动获取会话）";
    } else if (remain > 0) {
      const targets = await this.fetchLikeTargets(secrets, remain + 5);
      if (!targets.length) likeErr = "无可点赞目标（上游列表为空）";
      for (const t of targets) {
        if (liked >= remain) break;
        const okOne = await this.likeOne(secrets, t).catch(() => false);
        if (okOne) liked++;
        await new Promise((r) => setTimeout(r, (Number(c.likeDelayMinMs) || 400) + Math.floor(Math.random() * ((Number(c.likeDelayMaxMs) || 900) - (Number(c.likeDelayMinMs) || 400)))));
      }
      if (liked === 0 && !likeErr) likeErr = "点赞未成功（凭据可能无权调用该端点）";
    }

    // ③ 复核：重读规则 + 余额（防「接口成功但没发分」）
    const afterRules = await this.fetchEarnRules(secrets);
    const afterBal = await this.magicubesGet(secrets, this.cfg().balancePath);
    const balAfter = Number((afterBal.ok && afterBal.data && afterBal.data.data && afterBal.data.data.total_balance)) || 0;
    const likeAfter = afterRules.ok ? this.ruleOf(afterRules.rules, c.ruleLike) : null;
    const likeUsedAfter = Number(likeAfter && likeAfter.today_used) || used;
    const delta = balAfter - balBefore;
    const gained = delta > 0 ? delta : 0;

    // 成功判定：至少推进了一件事（点赞计数前进，或余额增长）
    const progressed = (likeUsedAfter > used) || (gained > 0);
    const msgs = [];
    if (dailyAmt && Number(daily && daily.today_used) > 0) msgs.push(`登录奖励 ${dailyAmt} 已领`);
    if (bindAmt && Number(bind && bind.today_used) > 0) msgs.push(`绑云奖励 ${bindAmt} 已领`);
    if (liked > 0) msgs.push(`点赞 ${liked} 次 +${liked * (Number(like && like.amount) || 2)} 魔粒`);
    else if (likeErr) msgs.push(likeErr);
    if (gained > 0) msgs.push(`余额 +${gained}`);
    // 降级提示：无 Cookie 时明确告知日活拿不到（避免用户以为签到成功了）
    if (!hasCookie && canStar) msgs.push("（当前无 Web 会话，daily_active 登录奖励需 Cookie 才能触发；重新 OAuth 授权可自动获取）");
    return {
      ok: progressed || (liked === 0 && remain === 0),
      already: liked === 0 && remain === 0 && !gained,
      claimed: progressed,
      liked,
      gained,
      balance: balAfter,
      hasCookie,
      webTouched: web ? web.touched : 0,
      message: msgs.length ? msgs.join(" · ") : "无可执行任务（今日已全部完成）",
    };
  },

  /** 列可点赞目标：PUT /api/v1/dolphin/mcpServers（分页体）→ Data.McpServer.McpServers[]，
   *  过滤掉已星标（AlreadyStar），按需取够 needed 个
   *  ⚠ 走 Cookie 通道：该端点在「仅 Cookie/ms- 可用族」里，OAuth 令牌调会 401 */
  async fetchLikeTargets(secrets, needed) {
    const c = this.cfg();
    const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
    const out = [];
    const seen = new Set();
    for (let page = 1; page <= 3 && out.length < needed; page++) {
      const body = JSON.stringify({ PageSize: Number(c.mcpPageSize) || 30, PageNumber: page, Query: "", Criterion: [] });
      const r = await httpJson(`${base}${c.mcpServersPath}`, { method: "PUT", headers: this.starHeaders(secrets), body })
        .catch(() => ({ ok: false, data: null }));
      if (!r.ok || !r.data) break;
      const servers = (((r.data.Data || {}).McpServer || {}).McpServers) || [];
      if (!servers.length) break;
      for (const s of servers) {
        if (out.length >= needed) break;
        const path = s.Path || s.FromSitePath || s.Namespace;
        const name = s.Name;
        if (!path || !name) continue;
        if (s.AlreadyStar) continue;
        const key = `${path}/${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path, name, key });
      }
    }
    return out;
  },

  /** 点赞单个 MCP 服务：PUT /api/v1/mcpServers/{path}/{name}/stars
   *  ⚠ 这是**对外可见**的动作（星标会展示在 MCP 服务页与用户动态），
   *  故仅在 checkin 被显式调用时执行，checkinStatus 绝不触发
   *  ⚠ 走 Cookie 通道（同 fetchLikeTargets）；无 Cookie 时回退 ms- 令牌（能点赞但不计日活） */
  async likeOne(secrets, target) {
    const c = this.cfg();
    const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
    const url = `${base}${c.starPathPrefix}/${target.path}/${target.name}/stars`;
    const headers = this.starHeaders(secrets, `/mcp/servers/${target.path}/${target.name}`);
    const r = await httpJson(url, { method: "PUT", headers, body: "{}" })
      .catch(() => ({ ok: false, data: null }));
    if (!r.ok || !r.data) return false;
    return !!(r.data.Success || r.data.Code === 200);
  },

  /** 魔搭无「加油包」类领取动作 */
  async trial() {
    return { ok: false, message: "ModelScope 无加油包领取动作" };
  },

  /** 令牌续期（OAuth 路径专用）：**由编排层注入实现**。
   *
   *  为什么不在适配器里直接 require discovery：discovery.cjs 顶部 require 了本模块
   *  （`const adapters = require("./adapters.cjs")`），反向 require 会形成循环依赖
   *  （Node 下取到半初始化模块 → undefined）。故与 qoderAdapter 同款处理：依赖注入。
   *  index.cjs 启动时调用 setModelScopeRefresh() 把 discovery.refreshModelScopeToken 注入进来。
   *
   *  ⚠ 上游约束（实测）：① refresh_token 一次性轮换 → 成功后必须把新值写回账号；
   *    ② OAuth 错误以 HTTP 200 + body.error 返回 → 判定在注入的实现内完成。 */
  async refreshToken(account, secrets) {
    const refresh = String((secrets && secrets.refreshToken) || "").trim();
    if (!refresh) {
      return { ok: false, terminal: true, message: "该账号是粘贴令牌入池（无 refresh_token），令牌失效后请到魔搭「访问令牌」页面重新生成并粘贴" };
    }
    if (typeof modelScopeRefreshImpl !== "function") {
      return { ok: false, terminal: true, message: "续期实现未注入（编排层未初始化），请重新执行 OAuth 登录" };
    }
    const meta = (account && account.meta) || {};
    const clientId = String(meta.oauthClientId || "");
    const clientSecret = String(meta.oauthClientSecret || "");
    if (!clientId || !clientSecret) {
      return { ok: false, terminal: true, message: "缺少 OAuth 客户端信息（meta.oauthClientId/Secret），无法续期，请重新执行 OAuth 登录" };
    }
    const r = await modelScopeRefreshImpl(clientId, clientSecret, refresh).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
    if (!r.ok) {
      // invalid_grant 是终止性的（refresh 已被轮换消耗或吊销）——交由上层判 relogin
      const terminal = /invalid_grant|invalid_client|expired/i.test(String(r.message || ""));
      return { ok: false, terminal, message: r.message };
    }
    return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt, rotated: r.rotated };
  },
};

/** ModelScope 续期实现注入点（避免 adapters ↔ discovery 循环依赖，见 refreshToken 注释） */
let modelScopeRefreshImpl = null;
function setModelScopeRefresh(fn) {
  modelScopeRefreshImpl = typeof fn === "function" ? fn : null;
}

const lobster = {
  id: "lobster",

  cfg() {
    return rules.get("headers.json").lobster;
  },

  /** 授权/刷新/积分等控制面头（无需 Bearer） */
  authHeaders(extra) {
    const c = this.cfg();
    return {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": `${c.clientName || "LobsterAI"}/${this.version()}`,
      ...(extra || {}),
    };
  },

  /** 对话头：Bearer + 客户端能力/版本头（官方客户端实测值） */
  chatHeaders(token, version) {
    const c = this.cfg();
    const ver = version || this.version();
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      "user-agent": `${c.clientName || "LobsterAI"}/${ver}`,
      "X-LobsterAI-Client-Capabilities": c.clientCapabilities || "kimi-k3-agentic-v1",
      "X-LobsterAI-Client-Version": ver,
    };
  },

  /** 当前客户端版本号：优先官方更新接口（缓存 1h），失败回落配置常量。
   *  签到活动按版本门禁——低于 2026.9.4 会被服务端隐藏（实测 0.1.0 → slotState=empty） */
  version() {
    const c = this.cfg();
    const now = Date.now();
    if (lobsterVersionCache.val && now - lobsterVersionCache.at < 3600000) return lobsterVersionCache.val;
    if (lobsterVersionCache.failedAt && now - lobsterVersionCache.failedAt < 600000) {
      return lobsterVersionCache.val || c.clientVersion || LOBSTER_UA_FALLBACK;
    }
    return lobsterVersionCache.val || c.clientVersion || LOBSTER_UA_FALLBACK;
  },

  /** 异步刷新版本号（签到/拉目录前调用，拿不到就用缓存/兜底） */
  async refreshVersion() {
    const c = this.cfg();
    const now = Date.now();
    if (lobsterVersionCache.val && now - lobsterVersionCache.at < 3600000) return lobsterVersionCache.val;
    const fallback = c.clientVersion || LOBSTER_UA_FALLBACK;
    const r = await httpJson(c.versionUrl, { method: "GET", headers: { accept: "application/json" } }).catch(() => null);
    const v = r && r.ok && r.data && r.data.data && r.data.data.value && r.data.data.value.version;
    if (v && /^\d{4}\.\d+/.test(String(v))) {
      lobsterVersionCache = { val: String(v), at: now, failedAt: 0 };
      return String(v);
    }
    lobsterVersionCache = { val: lobsterVersionCache.val || fallback, at: 0, failedAt: now };
    return lobsterVersionCache.val;
  },

  models() {
    return unionIds([...catalogMap("lobster").values()].map((m) => String(m.id)), []);
  },

  /** 模型名归一：龙虾模型 id 与 OpenAI 同名直传；容忍下划线变体 */
  mapModel(model) {
    const m = String(model || "");
    const catalog = catalogMap("lobster");
    if (catalog.has(m.toLowerCase())) return catalog.get(m.toLowerCase()).id;
    const norm = m.toLowerCase().replace(/_/g, "-");
    for (const [k, v] of catalog) {
      if (k.replace(/_/g, "-") === norm) return String(v.id);
    }
    return m;
  },

  /** 拉取官方模型目录：优先 GET /api/models/available（Bearer，含账号可见范围），
   *  Bearer 目录不可用（未登录/凭证失效/上游异常）时回退**公开** GET /api/models/pricing-catalog
   *  ——官方文档 2026-08-27-more-models.md 标注其 remains public，实测无需鉴权，含完整
   *  modelId/contextWindow/supportsImage/supportsThinking/costMultiplier。两者都失败才报错。
   *  返回 {code,data:[{modelId,modelName,provider,apiFormat,supportsImage,supportsThinking,
   *  contextWindow,explicitContextCache,thinkingConfig}]}（字段实证自官方开源仓库
   *  docs/server-integration/2026-06-24-explicit-context-cache-models.md 与
   *  specs/features/model-thinking-level-control） */
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
    if (r.ok) return r;
    // Bearer 目录拉不动时不直接判失败：公开定价目录仍能给出完整清单与真实元数据
    // （入口 IPC 要求号池有 online 账号；凭证失效但账号仍在池里时，这个兜底让目录照样能刷新）
    const pub = await this.fetchModelsPublic(account).catch(() => ({ ok: false }));
    if (pub.ok) return pub;
    return r.authError ? { ok: false, message: "账号登录态失效（401），请重新登录" } : r;
  },

  /** 公开定价目录（无需鉴权，权威兜底源）：{data:{textModels:[{modelId,modelName,contextWindow,
   *  supportsImage,supportsThinking,costMultiplier,freeAccess,...}]}}（另有 imageModels/videoModels，
   *  非文本对话、本渠道不接入） */
  async fetchModelsPublic() {
    const c = this.cfg();
    if (!c.pricingCatalogUrl) return { ok: false, message: "未配置公开目录端点" };
    const r = await httpJson(c.pricingCatalogUrl, { method: "GET", headers: { accept: "application/json" } }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    const list = (r.data && r.data.data && Array.isArray(r.data.data.textModels) && r.data.data.textModels) || null;
    if (!r.ok || !list || !list.length) return { ok: false, message: `公开目录拉取失败（HTTP ${r.status || 0}）` };
    const models = [];
    for (const raw of list) {
      const id = raw && raw.modelId;
      if (typeof id !== "string" || !id) continue;
      const img = typeof raw.supportsImage === "boolean" ? raw.supportsImage : undefined;
      const think = typeof raw.supportsThinking === "boolean" ? raw.supportsThinking : undefined;
      const rate = Number(raw.costMultiplier);
      models.push({
        id,
        name: String(raw.modelName || id),
        rate: Number.isFinite(rate) ? rate : null,
        capabilities: capsWithImages(img, { reasoning: think !== false, tools: true }),
        contextLength: tokenLimit(raw.contextWindow),
        maxOutputTokens: tokenLimit(raw.maxOutputTokens),
      });
    }
    if (!models.length) return { ok: false, message: "公开目录为空或无可对话模型" };
    return { ok: true, models };
  },

  async fetchModelsOnce(account, secrets) {
    const c = this.cfg();
    const headers = this.chatHeaders(secrets.token);
    const r = await httpJson(c.modelsUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "登录态已过期（HTTP 401）" };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    const list = (r.data && Array.isArray(r.data.data) && r.data.data) || findList(r.data, "data", 0);
    if (!r.ok || code !== 0 || !Array.isArray(list) || !list.length) {
      return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}${r.data && r.data.message ? " " + r.data.message : ""}）` };
    }
    const models = [];
    for (const raw of list) {
      const id = raw && (raw.modelId || raw.model_id || raw.id);
      if (typeof id !== "string" || !id) continue;
      const name = String(raw.modelName || raw.model_name || id);
      // 能力位优先取服务端显式声明（supportsImage/supportsThinking），缺失才嗅探。
      // 绝不编造：sniffImages 无信号时返回 undefined（=未声明），capsWithImages 会省略该键
      const imgDeclared = typeof raw.supportsImage === "boolean" ? raw.supportsImage : undefined;
      const thinkDeclared = typeof raw.supportsThinking === "boolean" ? raw.supportsThinking : undefined;
      const img = imgDeclared !== undefined ? imgDeclared : (sniffImages(raw) ?? (/v-turbo|vision|-vl\b/i.test(id) ? true : undefined));
      models.push({
        id,
        name,
        rate: null,
        capabilities: capsWithImages(img, { reasoning: thinkDeclared !== false, tools: true }),
        // contextWindow 缺失一律 0（未知）——官方对 null 值由客户端回落 OpenClaw 默认 200k，
        // 但本仓库约定「模型上限类字段绝不给编造的默认值」（假值会让客户端误判上下文溢出）
        contextLength: tokenLimit(raw.contextWindow ?? raw.context_length ?? raw.contextLength),
        maxOutputTokens: tokenLimit(raw.maxOutputTokens || raw.max_tokens),
      });
    }
    if (!models.length) return { ok: false, message: "目录为空或无可对话模型" };
    return { ok: true, models };
  },

  /** OpenAI body → lobster 改写：强制 stream=true（上游只支持流式）、归一 tool_choice、
   *  剥离 AgentHub 注入的内部字段 */
  rewriteBody(model, body) {
    const out = { ...(body || {}) };
    out.model = this.mapModel(model);
    // 上游只支持流式（实测 stream:false → 500），必须强制开启
    out.stream = true;
    if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
    out.stream_options.include_usage = true;
    // tool_choice 归一：空串/none/null 一律删除（上游不接受）
    if ("tool_choice" in out) {
      const tc = out.tool_choice;
      if (tc == null || tc === "" || tc === "none") delete out.tool_choice;
    }
    delete out.conversation_id;
    delete out.conversationId;
    delete out.prompt_cache_key;
    return out;
  },

  /** 对话主流程：原生 OpenAI SSE 透传。
   *  ⚠ 龙虾会把部分业务错误（额度不足等）藏在 HTTP 200 的 SSE 流首（event:error 帧），
   *  若不窥探会表现为「空内容的正常响应」穿透到客户端 → 必须识别并按错误处理 */
  async chat({ account, secrets, model, body, emit, meta }) {
    const c = this.cfg();
    const payload = JSON.stringify(this.rewriteBody(model, body));
    const headers = this.chatHeaders(secrets.token);
    const { resp, cancelTimer } = await fetchStream(c.chatUrl, { method: "POST", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) });
    const result = { status: 200, planLimit: false };
    // MiniMax 系把思考链塞在 content 里（<think>…</think>）→ 按帧状态机抽成 reasoning_content。
    // 状态必须每次 chat() 新建（跨帧共享，但绝不跨请求残留）
    const thinkSplit = createThinkSplitter();
    let settled = false;
    try {
      await pumpSse(resp, (event, raw) => {
        if (!settled) {
          settled = true;
          cancelTimer();
        }
        // 流内错误帧（event:error 或 data 里带 error 对象）
        if (event === "error") {
          const d = parseJson(raw);
          const msg = String((d && (d.message || (d.error && d.error.message))) || raw || "上游返回错误帧").slice(0, 300);
          const isQuota = /insufficient|credit|quota|balance|积分|余额|欠费|40201/i.test(msg);
          if (isQuota) result.planLimit = true;
          emit({ type: "error", status: isQuota ? 402 : 502, code: (d && d.code) || 0, message: msg });
          return;
        }
        if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
        const data = parseJson(raw);
        // 非对象帧一律丢弃：上游可能夹字面量 null / 数组 / 裸字符串（Qoder 渠道实证过
        // body:"null" 帧——JSON.parse 得 null 后访问 .choices 抛 TypeError，整条流以
        // 内部异常中断，用户看到 "Cannot read properties of null"）。`!data` 只挡 falsy，
        // 故这里显式判类型，覆盖 [] / "abc" / 123 这类 truthy 非对象值
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        const errObj = data.error || null;
        const codeNum = Number((errObj && errObj.code) ?? (data.choices ? 0 : data.code)) || 0;
        const msgStr = String((errObj && errObj.message) || data.message || "");
        if (errObj || (codeNum && codeNum !== 0 && codeNum !== 200)) {
          const isQuota = codeNum === 40201 || /insufficient|credit|quota|balance|积分|余额|欠费/i.test(msgStr);
          const status = isQuota ? 402 : codeNum === 401 ? 401 : codeNum === 429 ? 429 : 502;
          if (isQuota) result.planLimit = true;
          emit({ type: "error", status, code: codeNum, message: msgStr || `上游错误 ${codeNum}` });
          return;
        }
        const choice = Array.isArray(data.choices) && data.choices[0];
        if (choice) {
          const d = choice.delta || choice.message;
          if (d && Object.keys(d).length) {
            // MiniMax 系（M3 / M3.1）把思考链以 `<think>…</think>` 文本塞在 content 里，
            // 而不是像 GLM / DeepSeek 那样用独立的 reasoning_content 字段（实测三例对照）。
            // 通用层 server.cjs 只认 reasoning_content，若不在此归一，思考链会被当正文
            // 原样透传给客户端（用户看到一堆 "<think>The user simply…"）。
            // 归一方式：把 content 里的 think 段抽出来改挂 reasoning_content，与其它模型对齐。
            const norm = splitThinkDelta(thinkSplit, d);
            if (norm.reasoning) emit({ type: "delta", delta: { reasoning_content: norm.reasoning } });
            if (norm.rest && Object.keys(norm.rest).length) emit({ type: "delta", delta: norm.rest });
          }
          if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
        }
        if (data.usage) {
          emit({
            type: "usage",
            usage: {
              ...data.usage,
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

  /** 积分余额：GET /api/user/profile-summary → data.totalCreditsRemaining（含活动积分） */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    const headers = this.chatHeaders(secrets.token);
    const r = await httpJson(c.balanceUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { authError: true };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (!r.ok || !r.data || code !== 0) {
      throw new Error(`额度查询失败：HTTP ${r.status}${r.data && r.data.message ? " " + r.data.message : ""}${r.message ? " " + r.message : ""}`);
    }
    const d = r.data.data || r.data;
    const credits = Number(d.totalCreditsRemaining ?? d.total_credits_remaining ?? d.remainingCredits) || 0;
    return { credits, raw: d };
  },

  /** 签到状态：读活动 context 的 claimedToday（不消费签到动作） */
  async checkinStatus(account, secrets) {
    try {
      const c = this.cfg();
      const version = await this.refreshVersion();
      const slot = await this.fetchSlot(secrets, version);
      if (!slot.ok) return { ok: false, message: slot.message };
      if (!slot.activity) return { ok: true, unavailable: true, checkedIn: false, message: "当前没有可参与的签到活动（活动按客户端版本下发）" };
      const ctx = await this.fetchContext(secrets, slot.activity.activityCode, slot.activity.configRevision, version);
      if (!ctx.ok) return { ok: false, message: ctx.message };
      const claimed = !!(ctx.state && ctx.state.claimedToday);
      return {
        ok: true,
        checkedIn: claimed,
        already: claimed,
        reward: Number(ctx.state && ctx.state.rewardCredits) || 0,
        message: claimed ? "今日已签到" : `今日未签到（可得 ${Number(ctx.state && ctx.state.rewardCredits) || 0} 积分）`,
      };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  },

  /** 活动槽：GET /api/client-activities/slot?placement=…&clientVersion=… */
  async fetchSlot(secrets, version) {
    const c = this.cfg();
    const u = `${c.activitySlotUrl}?placement=${encodeURIComponent(c.checkinPlacement || "desktop_sidebar")}&clientVersion=${encodeURIComponent(version)}&containerApiVersion=2&platform=win32`;
    const r = await httpJson(u, { method: "GET", headers: this.authHeaders({ authorization: `Bearer ${secrets.token}` }) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "凭证失效，请重新登录" };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (!r.ok || code !== 0 || !r.data) return { ok: false, message: (r.data && r.data.message) || r.message || `活动查询失败 HTTP ${r.status}` };
    const d = r.data.data || {};
    // slotState=empty 表示该版本号看不到活动（不是错误，如实提示）
    if (d.slotState !== "available" || !d.activity) return { ok: true, activity: null, slotState: d.slotState || "" };
    return { ok: true, activity: d.activity };
  },

  /** 活动状态：GET /api/client-activities/{code}/context?configRevision=N */
  async fetchContext(secrets, code, revision, version) {
    const c = this.cfg();
    const u = `${c.activityBaseUrl}/${encodeURIComponent(code)}/context?configRevision=${Number(revision) || 1}`;
    const r = await httpJson(u, { method: "GET", headers: this.authHeaders({ authorization: `Bearer ${secrets.token}` }) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "凭证失效，请重新登录" };
    const code0 = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (!r.ok || code0 !== 0 || !r.data) return { ok: false, message: (r.data && r.data.message) || r.message || `活动状态查询失败 HTTP ${r.status}` };
    const d = r.data.data || {};
    return { ok: true, state: d.state || {}, actions: Array.isArray(d.actions) ? d.actions : [], authenticated: !!d.authenticated };
  },

  /** 每日签到：slot → context → POST actions/check_in → 复核 claimedToday。
   *  幂等：已签到 / 无活动 都返回 ok（不算失败），不会重复领取（服务端另有 idempotencyKey 兜底） */
  async checkin(account, secrets) {
    const c = this.cfg();
    const version = await this.refreshVersion();
    const slot = await this.fetchSlot(secrets, version);
    if (!slot.ok) return { ok: false, message: slot.message };
    if (!slot.activity) {
      // 版本门禁（服务端按 clientVersion 下发活动）：属「不开放」而非失败——照 trae 的
      // 同款约定返回 ok:true + unavailable，号池页才会显示「不开放」而不是红色「失败」
      // （checkinTagText 对 ok:false 一律判失败，unavailable 分支根本走不到）
      return { ok: true, unavailable: true, claimed: false, message: `当前版本看不到签到活动（slotState=${slot.slotState || "empty"}）——已自动取线上版本号，仍为空请稍后重试` };
    }
    const { activityCode: code, configRevision: rev } = slot.activity;
    const ctx = await this.fetchContext(secrets, code, rev, version);
    if (!ctx.ok) return { ok: false, message: ctx.message };
    const reward = Number(ctx.state && ctx.state.rewardCredits) || 0;
    if (ctx.state && ctx.state.claimedToday) {
      return { ok: true, already: true, claimed: false, reward, message: "今日已签到" };
    }
    if (!ctx.actions.includes("check_in")) {
      return { ok: false, message: `活动不可签到（actions=${JSON.stringify(ctx.actions)}）` };
    }
    const body = JSON.stringify({ configRevision: Number(rev) || 1, idempotencyKey: util.uuid(), payload: {} });
    const actionUrl = `${c.activityBaseUrl}/${encodeURIComponent(code)}/actions/check_in`;
    const r = await httpJson(actionUrl, { method: "POST", headers: this.authHeaders({ authorization: `Bearer ${secrets.token}` }), body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, message: "凭证失效，请重新登录" };
    const codeN = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (!r.ok || codeN !== 0) {
      return { ok: false, message: (r.data && r.data.message) || r.message || `签到失败 HTTP ${r.status}` };
    }
    // 复核：只有 claimedToday 真的翻转才算成功（防"接口成功但没发分"）
    const after = await this.fetchContext(secrets, code, rev, version);
    if (after.ok && after.state && !after.state.claimedToday) {
      return { ok: false, message: "签到接口已返回成功，但服务端 claimedToday 未翻转，请稍后在客户端确认" };
    }
    const got = Number(after.ok && after.state && after.state.claimedCredits) || 0;
    return { ok: true, already: false, claimed: true, reward: reward || got, message: reward ? `签到成功，+${reward} 积分` : "签到成功" };
  },

  /** 龙虾无"加油包"免费领取动作 */
  async trial() {
    return { ok: false, message: "LobsterAI 无加油包领取动作" };
  },

  /** Token 刷新：POST /api/auth/refresh（body 含 refreshToken + keyfrom 载荷，无需 Bearer）。
   *  参考实现口径：响应 accessToken 缺失即视为 refresh 被拒（终止性，需重新登录） */
  async refreshToken(account, secrets) {
    const c = this.cfg();
    const refreshToken = (secrets && secrets.refreshToken) || "";
    if (!refreshToken) return { ok: false, message: "无 refreshToken，请重新登录" };
    const meta = (account && account.meta) || {};
    const body = JSON.stringify({
      refreshToken,
      firstKeyfrom: String(meta.firstKeyfrom || ""),
      latestKeyfrom: String(Date.now()),
      version: "0.1.0",
      ...(meta.uuid ? { uuid: String(meta.uuid) } : {}),
      ...(meta.youdaoUserId ? { userId: String(meta.youdaoUserId) } : {}),
    });
    const r = await httpJson(c.refreshUrl, { method: "POST", headers: this.authHeaders(), body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    const d = (r.data && (r.data.data || r.data)) || null;
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    const token = d && (d.accessToken || d.access_token);
    if (r.ok && code === 0 && token) {
      const nextRefresh = (d.refreshToken || d.refresh_token) ? String(d.refreshToken || d.refresh_token) : refreshToken;
      const expiresIn = Number(d.expiresIn || d.expires_in) || 0;
      return {
        ok: true,
        token: String(token),
        refreshToken: nextRefresh,
        expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : (util.jwtDecode(String(token)).exp || 0) * 1000,
      };
    }
    if (r.status === 401 || r.status === 403 || code === 401 || code === 40100 || code === 40101) {
      return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
    }
    return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}` };
  },

  /** 用户信息（导入后补全 uid/昵称）：GET /api/user/profile-summary */
  async userInfo(token, account) {
    const c = this.cfg();
    const r = await httpJson(c.balanceUrl, { method: "GET", headers: this.chatHeaders(token) }).catch(() => ({ ok: false, status: 0, data: null }));
    const d = r.data && (r.data.data || r.data);
    if (r.ok && d) {
      return {
        uid: String(d.uid || d.userId || d.user_id || d.id || ""),
        name: String(d.nickname || d.name || d.phone || ""),
      };
    }
    // 兜底：从 JWT 解 uid
    const dec = util.jwtDecode(token);
    return { uid: String(dec.uid || dec.sub || ""), name: "" };
  },
};

// ===== ZCode（智谱 GLM 编码套餐，渠道 id: zcode） =====
// 与既有四渠道的本质差异：上游是 Anthropic Messages 协议（OpenAI 请求须经 zcodeAnthropic 双向翻译）；
// 一个账号是双凭据——zcodejwttoken（token_enc：start-plan 对话 + billing/claim 控制面）与
// coding-plan API key（refresh_enc：coding-plan 对话，"{apiKey}.{secret}"）。
// 对话选路：有 coding-plan key 优先 coding-plan（正式付费套餐），否则 start-plan（免费/领取的套餐）。
// 事实基线：zcode-api src/proxy/{upstream,identity}.ts + zcode-switch src-tauri/src/{quota,claim}.rs
// + 本机 ~/.zcode/v2 实测（见 zcodeLocal.cjs 文件头注释）。

const zcodeLocal = require("./zcodeLocal.cjs");
const zcodeAnthropic = require("./zcodeAnthropic.cjs");
// ZCode 官方 system 前缀：B 优先从本机客户端 bundle 提取，失败回落内置常量（官方客户端检测，防 405/3012）
const zcodeOfficialSystem = require("./zcodeOfficialSystem.cjs");

/** LLM 面身份头组（复刻官方 3.12.3 buildLlmIdentityHeaders：带 X-ZCode-Agent，不带 X-Device-Mid） */
function zcodeLlmHeaders(c, account, secrets, plan, convId) {
  const ver = c.appVersion || "4.1.10";
  const h = {
    "content-type": "application/json",
    "HTTP-Referer": c.refererOrigin || "https://zcode.z.ai",
    "User-Agent": `ZCode/${ver} ai-sdk/anthropic/3.0.81`,
    "X-ZCode-App-Version": ver,
    "X-Title": `Z Code@${c.sourceTitle || "cli"}`,
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    "X-ZCode-Agent": "glm",
    "X-Platform": c.platform || "win32-x64",
    "X-Os-Category": "windows",
    "anthropic-version": "2023-06-01",
    "x-request-id": util.uuid(),
    "x-zcode-trace-id": util.uuid(),
    "x-zcode-session-type": "main",
  };
  if (plan === "coding-plan") {
    h["x-api-key"] = secrets.refreshToken;
    h["authorization"] = `Bearer ${secrets.refreshToken}`;
    h["x-query-id"] = util.uuid();
    h["x-session-id"] = convId ? String(convId).replace(/^(sess_|subagent_agent_)/, "") : util.uuid();
  } else {
    h["authorization"] = `Bearer ${secrets.token}`;
  }
  return h;
}

/** 本机设备 ID（telemetry-state.json 的 deviceMid）：本机当前登录态的默认指纹 */
function zcodeDeviceMid() {
  const t = zcodeLocal.readJson(zcodeLocal.paths().telemetry);
  return String((t && t.deviceMid) || "");
}

/**
 * 账号级专属设备指纹（deviceMid 隔离）：
 * 优先取 account.meta.deviceMid（单号单机，终生稳定）；
 * 若无且确属本机当前登录账号，继承本机 telemetry-state.json 的真实 deviceMid；
 * 其余情况按账号 UID 派生出确定性的 UUIDv4，确保同账号多请求指纹恒定，且不同账号互不串联关联封号。
 */
function resolveAccountDeviceMid(account) {
  const meta = (account && account.meta) || {};
  if (meta.deviceMid) return String(meta.deviceMid);
  const live = zcodeLocal.readLive();
  const liveUid = live && (zcodeLocal.uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid));
  const mid = zcodeDeviceMid();
  if (mid && account && account.uid && liveUid && account.uid === liveUid) {
    return mid;
  }
  if (account && (account.uid || account.id)) {
    const h = crypto.createHash("sha256").update(`zcode-device:${account.uid || account.id}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  return mid || util.uuid();
}

/** 控制面身份头组（billing/claim/configs：带 X-Device-Mid，不带 X-ZCode-Agent）。
 *  deviceMid 采用账号级专属指纹，避免多账号并发同指纹触发上游设备关联封控 */
function zcodeCtlHeaders(c, secrets, account) {
  const ver = c.appVersion || "4.1.10";
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    "User-Agent": `ZCode/${ver}`,
    "HTTP-Referer": c.refererOrigin || "https://zcode.z.ai",
    "X-Title": `Z Code@${c.sourceTitle || "cli"}`,
    "X-ZCode-App-Version": ver,
    "X-Platform": c.platform || "win32-x64",
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    "X-Os-Category": "windows",
    authorization: `Bearer ${secrets.token}`,
  };
  const mid = resolveAccountDeviceMid(account);
  if (mid) h["X-Device-Mid"] = mid;
  return h;
}

// 待消费的阿里云验证码一次性凭据（账号 ID → { verifyParam, region, expireAt }）
const pendingCaptchaTokens = new Map();

function setPendingCaptcha(accountId, data) {
  if (!accountId || !data) return;
  pendingCaptchaTokens.set(String(accountId), data);
}

function getPendingCaptcha(accountId) {
  if (!accountId) return null;
  const hit = pendingCaptchaTokens.get(String(accountId));
  if (!hit) return null;
  if (hit.expireAt && hit.expireAt < Date.now()) {
    pendingCaptchaTokens.delete(String(accountId));
    return null;
  }
  pendingCaptchaTokens.delete(String(accountId)); // one-shot 即用即消
  return hit;
}

/** zcode 业务码 → HTTP 语义（参考 zcode-api / quota.rs classify_biz_err 口径）：
 *  1005→402 额度尽；3002/3008/3009/3010→429 限流；3007→502 验证码挑战（双重特征检测，如实报，不冷却号）；
 *  401/1006/3012→401；3001/3006/3102→400 参数；2007→502 服务端 */
function zcodeMapBizError(status, data, text) {
  // 业务码可能在顶层 code，也可能裹在 message 前缀里（实测形态 "[1113][Insufficient balance…]"）
  const rawMsg = String((data && (data.message || data.msg || (data.error && data.error.message))) || text || "");
  const bracket = /^\[(\d{3,5})\]/.exec(rawMsg);
  const code = Number((data && (data.code ?? (data.error && data.error.code))) || (bracket && bracket[1]) || 0);
  const msg = rawMsg;
  if (status === 402 || code === 1005 || code === 1113 || /insufficient|quota exhausted|balance|余额不足|额度|recharge/i.test(msg)) {
    return { status: 402, planLimit: true, message: msg || "额度已用完" };
  }
  if (status === 429 || [3002, 3008, 3009, 3010].includes(code)) return { status: 429, message: msg || "上游限流" };
  const isCaptcha = code === 3007 || /captcha|verify/i.test(msg) || /"code"\s*:\s*3007/.test(String(text || ""));
  if (isCaptcha) {
    return { status: 502, code: 3007, needCaptcha: true, message: "触发上游人机校验（阿里云验证码）：请在号池列表中点击该账号的「过码」按钮完成验证" };
  }
  if (status === 401 || status === 403 || [401, 1006, 3012].includes(code)) return { status: 401, message: msg || "凭证失效" };
  if (status === 400 || [3001, 3006, 3102].includes(code)) return { status: 400, message: msg || "参数错误" };
  return { status: status >= 400 && status < 600 ? status : 502, message: msg || `上游错误 ${status || code}` };
}

const zcode = {
  id: "zcode",

  cfg() {
    return rules.get("headers.json").zcode;
  },

  models() {
    const catalog = [...catalogMap("zcode").values()].map((m) => String(m.id));
    return unionIds(catalog, ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2"]);
  },

  /** 上游模型名大小写敏感（GLM-5.2 大写）：全小写 glm-* 归一为大写族，其余原样 */
  mapModel(model) {
    const m = String(model || "").trim();
    if (!/^glm-/i.test(m)) return m;
    if (/^GLM-/.test(m)) return m;
    return m
      .split("-")
      .map((seg, i) => (i === 0 ? seg.toUpperCase() : /^[a-z]+$/.test(seg) ? seg[0].toUpperCase() + seg.slice(1) : seg))
      .join("-");
  },

  /** 在线模型目录：billing/balance 的 balances[].capabilities "model:*" 提取（账号真实可用集） */
  async fetchModels(account, secrets) {
    const c = this.cfg();
    const url = `${c.billingBase}/billing/balance?app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
    const r = await httpJson(url, { method: "GET", headers: zcodeCtlHeaders(c, secrets, account) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { ok: false, message: "账号登录态失效（401），请重新登录" };
    const balances = r.data && r.data.data && Array.isArray(r.data.data.balances) ? r.data.data.balances : [];
    const ids = [];
    for (const b of balances) {
      for (const cap of Array.isArray(b && b.capabilities) ? b.capabilities : []) {
        const m = /^model:(.+)$/.exec(String(cap || ""));
        if (m && m[1] && !ids.includes(m[1])) ids.push(m[1]);
      }
    }
    if (!ids.length) return { ok: false, message: "上游未返回可用模型（balances 为空或无 capabilities）" };
    return {
      ok: true,
      models: ids.map((id) => {
        // 模态与上限都优先取官方客户端自带的元数据表（modelConfigRules；逐属性取最后定义值），
        // 取不到再退回通用嗅探/保守默认——别再硬编码 131072/8192（实测真实值为 1000000/128000，
        // 硬编码曾把长回答卡在 8192 造成 MAX_TOKENS 截断）
        const meta = zcodeLocal.resolveModelMeta(id);
        const fmt = (meta && meta.inputFormat) || null;
        const img = fmt && typeof fmt.supportsImage === "boolean" ? fmt.supportsImage : sniffImages(id);
        const caps = capsWithImages(img, { reasoning: true, tools: true });
        if (fmt && typeof fmt.supportsVideo === "boolean") caps.video = fmt.supportsVideo;
        if (fmt && typeof fmt.supportsPdf === "boolean") caps.pdf = fmt.supportsPdf;
        const ctx = (meta && meta.contextWindow) || 131072;
        const maxOut = (meta && meta.maxOutputTokens) || 8192;
        return { id, name: id, rate: null, capabilities: caps, contextLength: ctx, maxOutputTokens: maxOut };
      }),
    };
  },

  /** 对话主流程：OpenAI body → Anthropic 翻译 → 上游 SSE → OpenAI emit 桥。
   *  选路：有 coding-plan key（refresh_enc）优先 coding-plan（正式付费套餐），否则 start-plan
   *  （免费/领取的套餐）。双路兜底：coding-plan 402/欠费时若该号还有 jwt，就地带 jwt 重试
   *  start-plan 一次——号池里一份凭据两份额度，付费耗尽不应直接把号打死 */
  async chat({ account, secrets, model, body, emit, meta }) {
    const c = this.cfg();
    const convId = (meta && meta.conversationId) || util.stableConvId(body && body.messages) || "";
    const doChat = async (plan) => {
      const provider = String((account && account.meta && account.meta.provider) || "zai");
      const base = plan === "coding-plan"
        ? (provider === "bigmodel" ? c.bigmodelAnthropicBase : c.zaiAnthropicBase)
        : c.startPlanAnthropicBase;
      const url = `${String(base).replace(/\/+$/, "")}/v1/messages`;
      const headers = zcodeLlmHeaders(c, account, secrets, plan, convId);
      // 挂载可能存在的一次性人机校验凭据（one-shot header）
      const pendingCap = getPendingCaptcha(account && account.id);
      if (pendingCap && pendingCap.verifyParam) {
        headers["X-Aliyun-Captcha-Verify-Param"] = String(pendingCap.verifyParam);
        if (pendingCap.region) headers["X-Aliyun-Captcha-Verify-Region"] = String(pendingCap.region);
      }
      const upstreamModel = this.mapModel(model);
      // Anthropic 协议必填 max_tokens：客户端（如 WorkBuddy）不传时，用官方客户端元数据表里
      // 该模型的上限兜底（GLM-5.3-Flash = 128000），避免被写死的 8192 硬截断成长回答 MAX_TOKENS
      const zmeta = zcodeLocal.resolveModelMeta(upstreamModel);
      const payload = zcodeAnthropic.toAnthropic(upstreamModel, body, {
        defaultMaxTokens: zmeta && zmeta.maxOutputTokens,
      });
      // 官方客户端检测：zcode-plan 端点要求 system 以官方 ZCode 提示词开头，否则返回 405/3012
      // unusual activity（见 zcodeOfficialSystem.cjs）。coding-plan 走另一上游，无需注入。
      if (plan === "start-plan") payload.system = zcodeOfficialSystem.injectOfficialZcodeSystem(payload.system);
      // 官方流量规范（zcode-api E2e/UIo 逆向实证）：无论 coding-plan 还是 start-plan，
      // 官方客户端发送给 Anthropic 协议的 metadata.user_id 必须是特定结构的 JSON 字符串：
      // {"device_id":"<deviceMid>","account_uuid":"","session_id":"<sessionId>"}
      const mid = resolveAccountDeviceMid(account);
      const cleanSessionId = convId ? String(convId).replace(/^(sess_|subagent_agent_)/, "") : "";
      payload.metadata = {
        user_id: JSON.stringify({
          device_id: mid || undefined,
          account_uuid: "",
          session_id: cleanSessionId,
        }),
      };
      const bridge = zcodeAnthropic.createSseBridge(emit);
      const result = { status: 200, planLimit: false };
      const payloadText = JSON.stringify(payload);
      let respPair;
      try {
        respPair = await fetchStream(url, { method: "POST", headers, body: payloadText, firstByteMs: firstByteBudgetMs(payloadText) });
      } catch (e) {
        // 非 2xx：错误体里可能带业务码，映射成 server.cjs 分类器认得的语义
        if (e && e.status) {
          const data = parseJson(e.body || "");
          const mapped = zcodeMapBizError(e.status, data, e.body);
          if (mapped.planLimit) result.planLimit = true;
          if (mapped.code === 3007 && account && account.id) {
            store.noteError(account.id, mapped.message);
          }
          const err = new Error(mapped.message);
          err.status = mapped.status;
          if (mapped.code) err.code = mapped.code;
          err.zcodePlan = plan;
          throw err;
        }
        throw e;
      }
      // 同上：首个 SSE 事件到达即清 30s 首字节定时器，否则长回答（>30s）会在流中途被 abort
      let zcSettled = false;
      try {
        await pumpSse(respPair.resp, (event, raw) => {
          if (!zcSettled) {
            zcSettled = true;
            respPair.cancelTimer();
          }
          bridge.onEvent(event, raw);
        });
      } finally {
        respPair.cancelTimer();
      }
      if (bridge.result.planLimit) result.planLimit = true;
      return result;
    };

    if (secrets.refreshToken) {
      try {
        return await doChat("coding-plan");
      } catch (e) {
        // 付费套餐欠费/额度尽（402/1113）：若该号还有 jwt，带 jwt 重试 start-plan 一次
        if ((e && e.status === 402) && secrets.token) {
          try {
            return await doChat("start-plan");
          } catch (e2) {
            throw e2;
          }
        }
        throw e;
      }
    }
    return doChat("start-plan");
  },

  /**
   * 额度查询（双通道）：jwt 在 → zai billing（balance + current 合并）；
   * jwt 缺失但有 coding-plan key → bigmodel monitor quota/limit。
   * 429 退避 [0.5,1.5,4]s；全员 401 时等 1.5s 重试一次（新账号服务端激活延迟的实证口径）。
   */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    if (secrets.token && secrets.refreshToken) {
      const [rj, ra] = await Promise.all([
        this.queryCreditsByJwt(account, secrets, c).catch((e) => ({ error: String((e && e.message) || e) })),
        this.queryCreditsByApiKey(account, secrets, c).catch((e) => ({ error: String((e && e.message) || e) })),
      ]);
      // 若 API Key 成功：绝不报 authError 误判停用好号，且合并两路额度（参考 zcode-switch merge_parts）
      if (ra && !ra.authError && !ra.error) {
        const totalCredits = (Number(ra.credits) || 0) + (!rj.authError && !rj.error ? (Number(rj.credits) || 0) : 0);
        const exp = [ra.expiresAt, (!rj.authError && !rj.error ? rj.expiresAt : 0)].filter((t) => t > Date.now());
        return {
          credits: totalCredits,
          expiresAt: exp.length ? Math.min(...exp) : 0,
          raw: { jwt: rj.raw, apiKey: ra.raw, jwtAuthError: !!rj.authError },
        };
      }
      if (rj && !rj.authError && !rj.error) return rj;
      // 两路均明确 401/authError 才终判凭据失效
      if (rj.authError && ra.authError) return { authError: true, message: "ZCode 凭证失效（JWT 与 API Key 均失效）" };
      return { error: rj.error || ra.error || "额度查询失败" };
    }
    if (secrets.token) return this.queryCreditsByJwt(account, secrets, c);
    if (secrets.refreshToken) return this.queryCreditsByApiKey(account, secrets, c);
    return { authError: true, message: "该账号没有任何可用凭据" };
  },

  async queryCreditsByJwt(account, secrets, c) {
    const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
    const headers = zcodeCtlHeaders(c, secrets, account);
    const delays = [0, 500, 1500, 4000];
    let last = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      const [rb, rc] = await Promise.all([
        httpJson(`${c.billingBase}/billing/balance?${qs}`, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) })),
        httpJson(`${c.billingBase}/billing/current?${qs}`, { method: "GET", headers }).catch(() => ({ ok: false, status: 0, data: null })),
      ]);
      if (rb.status === 401 || rb.status === 403) {
        last = { authError: true };
        continue; // 退避后重试；末尾仍 401 交给「激活延迟」终判
      }
      if (rb.status === 429) {
        last = { error: "额度接口限流（429），已退避重试" };
        continue;
      }
      const data = rb.data && (rb.data.data || rb.data);
      if (!rb.ok || !data) {
        last = { error: `额度查询失败：HTTP ${rb.status || 0}${rb.message ? " " + rb.message : ""}` };
        break;
      }
      const balances = Array.isArray(data.balances) ? data.balances : [];
      const credits = balances.reduce((sum, b) => sum + (Number(b ? (b.remaining_units ?? b.remainingUnits) : 0) || 0), 0);
      const futureExpiries = balances.map((b) => util.toMs(b && (b.expires_at ?? b.expiresAt))).filter((t) => t > Date.now());
      const expiresAt = futureExpiries.length ? Math.min(...futureExpiries) : 0;
      const cur = rc.data && (rc.data.data || rc.data);
      const plans = Array.isArray(data.plans) ? data.plans : Array.isArray(cur && cur.plans) ? cur.plans : [];
      // 全部为空且 401 之外的「空响应」可能是新账号激活延迟：与 401 场景共用一次终判重试
      if (!balances.length && !plans.length && i < delays.length - 1) {
        last = { error: "额度数据为空（新账号可能激活延迟）" };
        continue;
      }
      return { credits, expiresAt, raw: { balances: balances.length, plans: plans.length } };
    }
    // 终判：全程 401 → 最后再等 1.5s 用同一 jwt 试一次，仍 401 才算凭证失效
    if (last && last.authError) {
      await new Promise((r) => setTimeout(r, 1500));
      const qs2 = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
      const r2 = await httpJson(`${c.billingBase}/billing/balance?${qs2}`, { method: "GET", headers: zcodeCtlHeaders(c, secrets, account) }).catch(() => ({ status: 0 }));
      if (r2.status === 401 || r2.status === 403) return { authError: true };
    }
    return last && last.error ? { error: last.error } : last && last.authError ? { authError: true } : { error: "额度查询失败" };
  },

  async queryCreditsByApiKey(account, secrets, c) {
    const r = await httpJson(c.monitorQuotaUrl, {
      method: "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${secrets.refreshToken}` },
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { authError: true };
    const data = r.data && (r.data.data || r.data);
    if (!r.ok || !data) return { error: `额度查询失败：HTTP ${r.status || 0}${r.message ? " " + r.message : ""}` };
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const credits = limits.reduce((sum, l) => sum + (Number(l && l.remaining) || 0), 0);
    const resets = limits.map((l) => util.toMs(l && l.nextResetTime)).filter((t) => t > Date.now());
    return { credits, expiresAt: resets.length ? Math.min(...resets) : 0, raw: { level: data.level || "" } };
  },

  /** 领取奖励状态 = claim preview：列出当前可领套餐（周末包等） */
  async checkinStatus(account, secrets) {
    const c = this.cfg();
    if (!secrets.token) return { ok: false, message: "该账号无 zcodejwt 凭据（仅 coding-plan key 不支持领取）" };
    const url = `${c.billingBase}/billing/preview?app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
    const r = await httpJson(url, { method: "GET", headers: zcodeCtlHeaders(c, secrets, account) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { ok: false, message: "凭证失效，请重新登录" };
    if (r.status === 404) return { ok: true, unavailable: true, message: "当前没有可领取的奖励活动" };
    const data = r.data && (r.data.data || r.data);
    const plans = Array.isArray(data && data.plans) ? data.plans : [];
    if (!r.ok) return { ok: false, message: `查询失败 HTTP ${r.status}${r.message ? " " + r.message : ""}` };
    if (!plans.length) return { ok: true, unavailable: true, message: "当前没有可领取的奖励活动" };
    return {
      ok: true,
      checkedIn: false,
      plans: plans.map((p) => ({ planId: String(p.plan_id || ""), name: String(p.name || ""), description: String(p.description || ""), priority: Number(p.priority) || 0, endsAt: util.toMs(p.ends_at) })),
      message: `有 ${plans.length} 个可领取的奖励套餐`,
    };
  },

  /**
   * 领取奖励（checkin 语义映射）：preview 取最高优先级套餐 → 验证码配置判定 → claim。
   * 验证码二段流：captcha 未携带且上游启用验证码时返回 {needCaptcha:true, plan}，
   * 由编排层（index.cjs checkinBatch）弹验证码窗拿 verifyParam 后带 opts.captcha 重调。
   */
  async checkin(account, secrets, opts) {
    const c = this.cfg();
    if (!secrets.token) return { ok: false, message: "该账号无 zcodejwt 凭据，无法领取" };
    const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
    const headers = zcodeCtlHeaders(c, secrets, account);

    // ① 选定套餐：调用方指定 planId，否则 preview 取最高优先级
    let planId = String((opts && opts.planId) || "");
    if (!planId) {
      const st = await this.checkinStatus(account, secrets);
      if (!st.ok) return st;
      if (st.unavailable) return { ok: true, already: true, message: st.message };
      const top = [...(st.plans || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
      if (!top || !top.planId) return { ok: true, already: true, message: "当前没有可领取的奖励活动" };
      planId = top.planId;
    }

    // ② 验证码判定：上游启用且未携带 verifyParam → 交编排层弹窗过码（不自动求解）
    let captcha = (opts && opts.captcha) || null;
    if (!captcha) {
      const cfgR = await httpJson(`${c.clientConfigsUrl}?${qs}`, { method: "GET", headers }).catch(() => null);
      const cc = cfgR && cfgR.data && cfgR.data.data && cfgR.data.data.configs && cfgR.data.data.configs.captcha;
      if (cc && cc.enabled && cc.sceneId) {
        return {
          ok: false,
          needCaptcha: true,
          planId,
          captcha: { sceneId: String(cc.sceneId), prefix: String(cc.prefix || ""), region: String(cc.region || "") },
          message: "领取需要完成一次人机校验（滑块/点选），请在弹出的验证窗口中完成",
        };
      }
    }

    // ③ 激活事件上报（官方客户端 claim 前的固定动作，提升领取资格；失败不阻断）
    const mid = resolveAccountDeviceMid(account);
    for (const event of ["app_launch", "app_daily_active"]) {
      httpJson(c.eventReportUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ event, user_id: account && account.uid || "", device_mid: mid, app_version: c.appVersion, platform: c.platform }),
      }).catch(() => {});
    }

    // ④ claim
    const claimHeaders = { ...headers };
    if (captcha && captcha.verifyParam) {
      claimHeaders["X-Aliyun-Captcha-Verify-Param"] = String(captcha.verifyParam);
      if (captcha.region) claimHeaders["X-Aliyun-Captcha-Verify-Region"] = String(captcha.region);
    }
    const r = await httpJson(`${c.billingBase}/billing/claim`, {
      method: "POST",
      headers: claimHeaders,
      body: JSON.stringify({ plan_id: planId }),
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    const data = r.data && (r.data.data || r.data);
    const code = Number((r.data && r.data.code) || 0);
    if (r.status === 401) return { ok: false, message: "凭证失效，请重新登录" };
    if (code === 3007) {
      // verifyParam 被拒：编排层应重新弹窗
      return { ok: false, needCaptcha: true, planId, captcha: { sceneId: (opts && opts.captcha && opts.captcha.sceneId) || "" }, message: "人机校验未通过，请重试" };
    }
    if (code === 1005 || code === 1003) {
      const endsAt = util.toMs(data && (data.ends_at || (data.plan && data.plan.ends_at)));
      return { ok: true, already: true, nextAt: endsAt || 0, message: endsAt ? `已领取过，下次窗口 ${new Date(endsAt).toLocaleString("zh-CN")}` : "已领取过（已达上限）" };
    }
    if (code === 1004) {
      // 设备指纹被消耗（本周已有领取记录打在这枚 X-Device-Mid 上）：资格判定是
      // 「账号本周未领 ∧ 指纹本周未被消耗」，preview 能出套餐但 claim 必被挡。
      // 唯一出路是给该账号换一枚全新设备指纹——号池页「指纹修复」一键完成
      return { ok: false, deviceBurned: true, message: "设备指纹本周已被消耗（1004）：请到号池工具栏点「指纹修复」给该账号换新指纹后重试" };
    }
    if (r.ok && code === 0) return { ok: true, claimed: true, message: "领取成功" };
    return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || r.message || `领取失败 HTTP ${r.status}` };
  },

  /** 加油包语义在 zcode 即领取奖励（与 checkin 同路径） */
  async trial(account, secrets, opts) {
    return this.checkin(account, secrets, opts);
  },

  /** zcodejwt 无 exp（长期有效）、coding-plan key 不过期：没有可刷新的东西，诚实返回。
   *  401 语义由 credits/server 落入 relogin 计数，引导用户重新 OAuth 登录或本机导入 */
  async refreshToken() {
    return { ok: false, expired: true, message: "ZCode 凭据长期有效（无自动刷新端点）；凭证失效时请重新 OAuth 登录或从本机软件导入" };
  },

  /** 账号信息（导入/OAuth 后补全 uid/昵称）：jwt 本地解 payload，user_info 由调用方从凭证快照补 */
  async userInfo(token) {
    const uid = zcodeLocal.uidFromJwt(token);
    return { uid, name: uid ? `ZCode ${uid.slice(0, 6)}` : "ZCode 账号" };
  },

  /**
   * 独立人机校验（过码）：从 client/configs 获取 captcha 配置，
   * 弹窗跑阿里云验证码拿到 verifyParam，并向服务端上报/核销，解除风控限制。
   */
  async solveCaptcha(account, secrets) {
    const c = this.cfg();
    if (!secrets.token) return { ok: false, message: "该账号无 zcodejwt 凭据，无法进行人机校验" };
    const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
    const headers = zcodeCtlHeaders(c, secrets, account);

    // ① 获取验证码配置（sceneId、region、prefix）
    const cfgR = await httpJson(`${c.clientConfigsUrl}?${qs}`, { method: "GET", headers }).catch(() => null);
    const cc = cfgR && cfgR.data && cfgR.data.data && cfgR.data.data.configs && cfgR.data.data.configs.captcha;
    const sceneId = (cc && cc.sceneId) || (c.captcha && c.captcha.sceneId) || "";
    if (!sceneId) {
      return { ok: false, message: "上游未返回验证码配置（sceneId 为空），请稍后重试" };
    }
    const captchaCfg = {
      sceneId: String(sceneId),
      prefix: String((cc && cc.prefix) || ""),
      region: String((cc && cc.region) || "cn"),
    };

    // ② 调起独立沙箱验证窗
    const zcodeCapture = require("./zcodeCapture.cjs");
    const cap = await zcodeCapture.solveCaptcha(captchaCfg, { forceShow: true });
    if (!cap.ok) {
      return { ok: false, message: cap.message || "人机校验未完成" };
    }

    // ③ 激活事件上报（提升风控信誉）
    const mid = resolveAccountDeviceMid(account);
    for (const event of ["app_launch", "app_daily_active"]) {
      httpJson(c.eventReportUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ event, user_id: (account && account.uid) || "", device_mid: mid, app_version: c.appVersion, platform: c.platform }),
      }).catch(() => {});
    }

    // ④ 向 billing/claim 尝试核销验证码（即使套餐已领过或无套餐，带着 Header 请求也可核销验证码提升信誉）
    try {
      const claimHeaders = { ...headers, "X-Aliyun-Captcha-Verify-Param": String(cap.verifyParam) };
      if (cap.region) claimHeaders["X-Aliyun-Captcha-Verify-Region"] = String(cap.region);
      await httpJson(`${c.billingBase}/billing/claim`, {
        method: "POST",
        headers: claimHeaders,
        body: JSON.stringify({ plan_id: "verify" }),
      }).catch(() => {});
    } catch { /* 忽略核销错误 */ }

    // ⑤ 写入短期内存 token，供下一次聊天请求直接带上
    setPendingCaptcha(account.id, {
      verifyParam: cap.verifyParam,
      region: cap.region || captchaCfg.region,
      expireAt: Date.now() + 5 * 60000,
    });

    return { ok: true, verifyParam: cap.verifyParam, message: "人机校验通过，账号已恢复可用" };
  },
};

const ADAPTERS = { trae, workbuddy, workbuddy_ai, raccoon, modelscope, lobster, zcode };

// ===== Qoder 双区（凭据层 + WASM 签名器 + 适配器）=====
// 与其它渠道的差异：签名是**每请求的**（wasm 驱动，见 qoderSigner.cjs），
// 故其 headers() 只返回非签名基础头，签名在 chat() 内按账号现场完成。
// 依赖注入原因：fetchStream/pumpSse/httpJson 是本模块私有函数（未导出），
// 由 qoderAdapter 直接 require 会形成循环依赖，故在此注入。
const qoderAuth = require("./qoderAuth.cjs");
const qoderSigner = require("./qoderSigner.cjs");
const { makeQoder } = require("./qoderAdapter.cjs");
const qoderDeps = { fetchStream, pumpSse, httpJson, rules, auth: qoderAuth, signer: qoderSigner, util, store };
const qoder = makeQoder("qoder", qoderDeps);
ADAPTERS.qoder = qoder;
// qoder_intl 暂停启用（免费额度不含 DeepSeek/GLM Flash，需充值；且本机未装国际版客户端）。
// 必须与 store.QODER_INTL_ENABLED 同步——ADAPTERS 参与 modelOwners/mergedModels，
// 只从 CHANNELS 移除而留在此处，会让模型被判为「双区共有」并路由到无账号的渠道。
if (store.QODER_INTL_ENABLED) {
  ADAPTERS.qoder_intl = makeQoder("qoder_intl", qoderDeps);
}

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

/** 合并模型目录（/v1/models）：canonical id 归并 + 来源标记 + 反向映射融合 + 自定义参数覆盖 + 目录元数据（倍率/能力/上下文） */
function mergedModels(cfg) {
  const c = cfg || proxyConfig();
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

  // 反向映射：统一请求模型名注入合并目录，拥有各映射渠道的 sources
  const rev = c.modelReverseAliases || {};
  for (const [unifiedId, chMap] of Object.entries(rev)) {
    if (!unifiedId || !chMap || typeof chMap !== "object") continue;
    const lowerUnified = unifiedId.toLowerCase();
    const mappedSources = Object.keys(chMap).filter((ch) => ADAPTERS[ch]);
    if (!mappedSources.length) continue;
    const existing = seen.get(lowerUnified);
    if (existing) {
      existing.id = unifiedId; // 使用用户定义的统一请求名字面形态
      for (const ch of mappedSources) {
        if (!existing.sources.includes(ch)) existing.sources.push(ch);
      }
    } else {
      seen.set(lowerUnified, {
        id: unifiedId,
        object: "model",
        created: 0,
        owned_by: mappedSources[0] || "custom",
        sources: [...mappedSources],
      });
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
      let lookupId = entry.id;
      let revMap = rev[entry.id];
      if (!revMap) {
        const lowerId = entry.id.toLowerCase();
        for (const [rk, rv] of Object.entries(rev)) {
          if (rk.toLowerCase() === lowerId) { revMap = rv; break; }
        }
      }
      if (revMap && revMap[channel]) {
        lookupId = revMap[channel];
      }
      const meta = catMaps[channel].get(lookupId.toLowerCase()) || catMaps[channel].get(entry.id.toLowerCase());
      if (!meta) continue;
      if (meta.name && meta.name !== entry.id && entry.name === entry.id) entry.name = String(meta.name);
      if (entry.rate == null && meta.rate != null && !Number.isNaN(Number(meta.rate))) entry.rate = Number(meta.rate);
      // images 走 OR（任一来源支持即支持），避免单渠道的 false 污染共享模型名；其余能力沿用后者覆盖
      entry.capabilities = mergeCapabilities(entry.capabilities, meta.capabilities);
      // 数值上限取各来源的**最大声明**：渠道的占位值不得压低另一渠道的真实声明。
      // 例：Trae 目录曾对所有模型硬编码占位 131072（v1.41.2 起改取目录真实限额 traeLimits），
      // 而 GLM-5.3 的真实窗口是 1000000（workbuddy / workbuddy_ai / zcode 均如此声明），
      // 按"先到先得"会被 Trae 顶成 131072。
      // 这两个字段只用于 /v1/models 展示，请求路径各适配器用自己的 meta 兜底，故取最大值安全。
      const ctxN = Number(meta.contextLength) || 0;
      if (ctxN > entry.contextLength) entry.contextLength = ctxN;
      const outN = Number(meta.maxOutputTokens) || 0;
      if (outN > entry.maxOutputTokens) entry.maxOutputTokens = outN;
    }
  }

  // 自定义参数（modelCustom）：覆写 contextLength、maxOutputTokens、reasoning 能力
  const customMap = c.modelCustom || {};
  for (const entry of seen.values()) {
    let cust = customMap[entry.id];
    if (!cust) {
      const lower = entry.id.toLowerCase();
      for (const [k, v] of Object.entries(customMap)) {
        if (k.toLowerCase() === lower) { cust = v; break; }
      }
    }
    if (cust && typeof cust === "object") {
      if (typeof cust.contextLength === "number" && cust.contextLength > 0) {
        entry.contextLength = cust.contextLength;
      }
      if (typeof cust.maxOutputTokens === "number" && cust.maxOutputTokens > 0) {
        entry.maxOutputTokens = cust.maxOutputTokens;
      }
      if (cust.reasoningEffort) {
        if (cust.reasoningEffort === "off") {
          entry.capabilities = { ...entry.capabilities, reasoning: false };
        } else {
          entry.capabilities = { ...entry.capabilities, reasoning: true };
        }
      }
    }
  }

  return [...seen.values()];
}

/** 模型 → 渠道归属：返回拥有该模型的渠道列表（模型完全不存在 → 空数组） */
function modelOwners(model, cfg) {
  const c = cfg || proxyConfig();
  const rev = c.modelReverseAliases || {};
  // 先查反向映射
  const directRev = rev[model];
  if (directRev && typeof directRev === "object") {
    const owners = Object.keys(directRev).filter((ch) => ADAPTERS[ch]);
    if (owners.length) return owners;
  }
  const lower = String(model || "").toLowerCase();
  for (const [k, map] of Object.entries(rev)) {
    if (k.toLowerCase() === lower && map && typeof map === "object") {
      const owners = Object.keys(map).filter((ch) => ADAPTERS[ch]);
      if (owners.length) return owners;
    }
  }

  const id = lower;
  const owners = [];
  for (const [channel, ad] of Object.entries(ADAPTERS)) {
    if (ad.models().some((m) => String(m).toLowerCase() === id)) owners.push(channel);
  }
  return owners;
}

/** /v1/models 对外可列模型：合并视图减去 disabledModels（口径与请求路径 400 拦截一致）。
 * 只供对外 HTTP 出口用；管理页 proxy_models 仍走 mergedModels 全量 + enabled 标志，否则停用模型无法恢复。 */
function listableModels(cfg) {
  const c = cfg || proxyConfig();
  const disabled = c.disabledModels || [];
  if (!disabled.length) return mergedModels(c);
  const off = new Set(disabled.map((s) => String(s).toLowerCase()));
  return mergedModels(c).filter((m) => !off.has(m.id.toLowerCase()));
}

module.exports = { get, ADAPTERS, mergedModels, listableModels, modelOwners, httpJson, refreshTokenLocked, setPendingCaptcha, getPendingCaptcha,
  // ModelScope 续期实现注入（避免 adapters ↔ discovery 循环依赖；由 index.cjs 启动时注入）
  setModelScopeRefresh,
  // 供自测校验 LobsterAI 的 <think> 思考链归一（MiniMax 系把思考塞在 content 里）
  __lobsterThink: { createThinkSplitter, splitThinkDelta },  // 供自测校验首字节预算随 prompt 规模增长（修"大 prompt 被 30s 误杀→熔断 30 分钟"）
  firstByteBudgetMs, estimateInputTokens, FIRST_BYTE_MS, FIRST_BYTE_MAX_MS,
  // 供自测校验模态识别（通用嗅探 / 能力合并 OR 语义）
  sniffImages, mergeCapabilities,
  // 供自测校验模型上限归一化（缺失/非法 → 0，绝不编造）与 trae 目录结构解析
  tokenLimit, traeLimits };
