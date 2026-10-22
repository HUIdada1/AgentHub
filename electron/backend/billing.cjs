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
// 计费扩展：外部价格源导入（LiteLLM / OpenRouter）+ 价格表 WebDAV 多设备同步
// 网络策略：Electron 运行时用 net.fetch 走独立 session（代理设置只影响导入请求，不污染主会话）；
// 纯 Node 测试环境退化为原生 fetch 直连（解析逻辑用本地 fixture 测，不发真网）。
"use strict";
const crypto = require("node:crypto");
const db = require("./db.cjs");
const webdav = require("./webdav.cjs");

let electron = null;
try {
  electron = require("electron");
  if (typeof electron !== "object" || !electron.net) electron = null;
} catch {
  /* 非 Electron 环境 */
}

// jsdelivr 镜像在前（国内通常可直连），GitHub raw 兜底
const LITELLM_URLS = [
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 20000;
const PRICES_FILE = "usage-tracker/prices.json";

// ===== 网络 =====

async function doFetch(url, proxy, headers) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const init = headers && Object.keys(headers).length ? { signal, headers } : { signal };
  if (electron && electron.session && electron.net) {
    const session = electron.session.fromPartition("billing-import", { cache: false });
    await session.setProxy(proxy ? { mode: "fixed_servers", proxyRules: proxy } : { mode: "system" });
    return electron.net.fetch(url, { ...init, session });
  }
  return fetch(url, init);
}

/** 依次尝试多个地址，返回首个成功的 { url, text } */
async function fetchText(urls, proxy, headers) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await doFetch(url, proxy, headers);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { url, text: await res.text() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`价格源拉取失败：${lastErr ? lastErr.message : "全部地址不可达"}`);
}

// ===== 解析（纯函数，测试可注入 fixture）=====

/** LiteLLM 价格表 JSON → Map<modelId, 价目行>（USD/百万 token；仅保留 chat/completion 类） */
function parseLiteLLM(text) {
  const data = JSON.parse(text);
  const out = new Map();
  for (const [key, m] of Object.entries(data || {})) {
    if (!m || typeof m !== "object") continue;
    if (m.mode && m.mode !== "chat" && m.mode !== "completion") continue;
    const inC = Number(m.input_cost_per_token);
    const outC = Number(m.output_cost_per_token);
    if (!isFinite(inC) || !isFinite(outC) || inC < 0 || outC < 0) continue;
    out.set(key, {
      modelId: key,
      inputPerM: inC * 1e6,
      outputPerM: outC * 1e6,
      cacheReadPerM: (Number(m.cache_read_input_token_cost) * 1e6) || 0,
      cacheWritePerM: (Number(m.cache_creation_input_token_cost) * 1e6) || 0,
      currency: "USD",
    });
  }
  return out;
}

/** OpenRouter /models JSON → Map<modelId, 价目行>（id 取 "vendor/" 后缀；免费模型单价为 0） */
function parseOpenRouter(text) {
  const data = JSON.parse(text);
  const out = new Map();
  for (const m of (data && data.data) || []) {
    if (!m || !m.id || !m.pricing) continue;
    const inC = Number(m.pricing.prompt);
    const outC = Number(m.pricing.completion);
    if (!isFinite(inC) || !isFinite(outC) || inC < 0 || outC < 0) continue;
    const modelId = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
    out.set(modelId, {
      modelId,
      inputPerM: inC * 1e6,
      outputPerM: outC * 1e6,
      cacheReadPerM: (Number(m.pricing.input_cache_read) * 1e6) || 0,
      cacheWritePerM: 0,
      currency: "USD",
    });
  }
  return out;
}

// ===== 导入预览与写入 =====

const samePrice = (a, b) =>
  ["inputPerM", "outputPerM", "cacheReadPerM", "cacheWritePerM"].every(
    (k) => Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0)) < 1e-9
  ) && a.currency === b.currency;

/**
 * 拉取价格源并与本地比对，生成导入预览：
 * - additions：本地有用量但未配置价格的模型，价格源有 → 建议新增
 * - changes：已配置模型价格与价格源不同 → 建议更新（可能含币种变化，由用户勾选决断）
 * - missing：本地未配置且价格源未收录 → 需手动填写
 * 返回 { sourceName, resolvedUrl, additions, changes, missing }
 */
async function previewImport(source, proxy) {
  let remote, fetched;
  if (source === "openrouter") {
    fetched = await fetchText([OPENROUTER_URL], proxy);
    remote = parseOpenRouter(fetched.text);
  } else {
    fetched = await fetchText(LITELLM_URLS, proxy);
    remote = parseLiteLLM(fetched.text);
  }
  const sourceName = source === "openrouter" ? "OpenRouter" : "LiteLLM";

  const current = new Map(
    db.listCurrentPrices().map((p) => [`${p.providerId || ""}|${p.modelId}`, p])
  );
  // 本地出现过的全部模型（含已配置），从用量聚合取，避免硬编码漏项
  const usedModels = new Set(db.getAggregate("full", "model", null, null, null).map((r) => r.key));

  const additions = [];
  const changes = [];
  const missing = [];
  for (const modelId of usedModels) {
    const hit = remote.get(modelId);
    const existing = current.get(`|${modelId}`);
    if (existing) {
      if (hit && !samePrice(existing, hit)) {
        changes.push({ ...hit, providerId: existing.providerId, prev: existing });
      }
      continue;
    }
    if (hit) additions.push({ ...hit, providerId: null });
    else missing.push({ modelId });
  }
  return { sourceName, resolvedUrl: fetched.url, additions, changes, missing };
}

/** 应用导入（仅写用户勾选的条目）；沿用既有行的供应商维度，避免精确价被通配导入架空 */
function applyImport(items, effectiveFrom, updatedBy) {
  let n = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.modelId) continue;
    db.savePrice(
      {
        providerId: it.providerId ?? null,
        modelId: it.modelId,
        inputPerM: it.inputPerM,
        outputPerM: it.outputPerM,
        cacheReadPerM: it.cacheReadPerM,
        cacheWritePerM: it.cacheWritePerM,
        currency: it.currency,
        effectiveFrom: (effectiveFrom == null || effectiveFrom === "" || !Number.isFinite(Number(effectiveFrom)) || Number(effectiveFrom) < 1) ? Date.now() : Number(effectiveFrom),
      },
      updatedBy
    );
    n++;
  }
  return n;
}

// ===== 价格表 WebDAV 多设备同步（LWW 整文件）=====

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** 本地价格时钟（meta 记账，增删改都推进；下载替换时保留远端时钟防乒乓） */
function localPricesUpdatedAt() {
  return Number(db.getMeta("prices_local_updated") || 0);
}

/**
 * 与远端 prices.json 对齐：远端新 → 整表替换本地；本地新/远端缺失 → 上传；
 * 内容一致（hash 记账）→ 跳过。任何异常由调用方兜底记日志，不中断数据同步。
 */
async function syncPrices(wd, deviceName) {
  if (!wd || !wd.endpoint) return { action: "skipped", reason: "未配置 WebDAV" };
  const url = webdav.joinUrl(wd.endpoint, wd.root, PRICES_FILE);
  // 注意：远端缺失（404 → null）才允许本地上传覆盖；网络错误/5xx 必须向上抛出，
  // 由调用方记日志并跳过本轮价格同步——若把读失败当缺失处理，本地旧时钟的
  // 价格表会反向覆盖远端较新的表（LWW 失效）。
  const text = await webdav.getText(url, wd);
  let remote = null;
  if (text) {
    try {
      remote = JSON.parse(text);
      if (!remote || typeof remote !== "object") remote = null;
    } catch {
      remote = null; // 损坏文件按缺失处理，本地覆盖上传自愈
    }
  }
  const remoteUpdated = remote ? Number(remote.updatedAt) || 0 : 0;
  const localUpdated = localPricesUpdatedAt();

  // LWW 依赖各设备墙钟：远端时间戳明显领先本地时钟时提示（说明对端或本机时间不准，
  // 可能导致后改的配置因时钟偏慢而输掉 LWW），不阻断同步
  if (remote && remoteUpdated > Date.now() + 5 * 60 * 1000) {
    db.addLog("merge", "warn", "远端价格表时间戳明显领先本机时钟，请检查各设备系统时间是否准确（时间偏差会影响价格表新旧判定）");
  }

  if (remote && remoteUpdated > localUpdated) {
    const count = Array.isArray(remote.prices) ? remote.prices.length : 0;
    db.replacePrices(remote.prices, remoteUpdated, remote.aliases);
    return { action: "downloaded", count, remoteBy: remote.updatedBy || "其他设备" };
  }
  if (!remote || localUpdated > remoteUpdated) {
    const payload = JSON.stringify({
      v: 1,
      updatedAt: localUpdated || Date.now(),
      updatedBy: deviceName || "",
      prices: db.listAllPrices(),
      aliases: db.listAliases(),
    });
    const hashKey = `prices_uploaded:${wd.endpoint}${wd.root || ""}`;
    if (db.getMeta(hashKey) !== sha1(payload)) {
      await webdav.put(url, wd, payload);
      db.setMeta(hashKey, sha1(payload));
      return { action: remote ? "uploaded" : "created" };
    }
    return { action: "unchanged" };
  }
  return { action: "unchanged" };
}

// ===== 在线定价源（三套内置价格表，优先级按数组顺序）=====
// 三套链接全部内置，用户不用填地址；每套独立开关 / 检查间隔 / 立即拉取，
// 各自写自己 source 的价格段，谁生效由 db 的排序键决定：
//   手动价 > 官方倍率预设 > models.dev > 远程价格表 > 内置
// 口径：
//   ① official（basellm 官方倍率预设）—— billing_expr 表达式，系数即 $/1M 真实价格
//      （new-api pkg/billingexpr/expr.md：p * 2.5 = $2.50/1M 输入），无需倍率换算
//   ② modelsdev（models.dev/api.json）—— cost.input/output/cache_read 即 $/1M
//   ③ remote（Wei-Shaw 远程价格表）—— LiteLLM 格式，input_cost_per_token 是 $/token
const PRICING_SOURCES = [
  {
    id: "official",
    name: "官方倍率预设",
    host: "basellm.github.io",
    url: "https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json",
    hashUrl: "",
    format: "billing_expr",
  },
  {
    id: "modelsdev",
    name: "models.dev 预设",
    host: "models.dev",
    url: "https://models.dev/api.json",
    hashUrl: "",
    format: "models_dev",
  },
  {
    id: "remote",
    name: "远程价格表",
    host: "raw.githubusercontent.com",
    url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
    hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
    format: "litellm",
  },
];

const DEFAULT_CACHE_RATIO = 1.0; // 表达式/数据未给缓存读价时，按输入价
const DEFAULT_CREATE_CACHE_RATIO = 1.25; // 未给缓存写价时，输入价 × 1.25
const MAX_PRICE_PER_M = 2000; // USD/1M 上限，超过按异常值处理


/**
 * 模型名归一化（兜底匹配用）：小写 → 去供应商前缀 → 去变体后缀 → 去日期/版本后缀。
 * 只收敛「明显同义」的写法，不做模糊相似度：宁可匹配不上留给用户归并，
 * 也不能把 gpt-4o-mini 算成 gpt-4o 的价。所以只剥纯数字/日期这类版本尾巴。
 */
function normalizeModelName(name) {
  let s = String(name || "").trim().toLowerCase();
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  if (slash > 0 && slash < s.length - 1) s = s.slice(slash + 1);
  s = s.replace(/:(?:free|beta|extended|thinking|online)$/, "");
  s = s.replace(/[-@](?:\d{4}-?\d{2}-?\d{2}|v\d+(?:\.\d+)*|latest)$/, "");
  return s;
}

/**
 * 取表达式里第一个 tier(...) 的计价部分。
 * new-api 的阶梯/分时表达式形如 `len <= 512000 ? tier("0_512k", …) : tier("512k_plus", …)`，
 * 单价表只能存一组数，这里统一取表达式里第一个 tier（首档）；取不到时退回整条表达式。
 */
function firstTierBody(expr) {
  const idx = expr.indexOf("tier(");
  if (idx < 0) return null;
  let depth = 0;
  let comma = -1;
  for (let i = idx + 4; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return comma < 0 ? "" : expr.slice(comma + 1, i);
    } else if (ch === "," && depth === 1 && comma < 0) comma = i;
  }
  return null;
}

/**
 * 从计价式里抽 token 单价系数（$ / 百万 token）。
 * 只认 `变量 * 数字` 这一种写法——new-api 内置预设全部是这个形态；
 * 一旦出现 `变量 * 另一个变量`（系数不确定），整条作废：宁可跳过留给下层来源，
 * 也不能按 0 或残缺系数写进价格表。
 */
function extractPriceCoefs(expr) {
  const body = firstTierBody(expr);
  const target = body == null ? expr : body;
  const coef = { p: null, c: null, cr: null, cc: null };
  // `p * rate` 这类系数不是字面量的写法，无法定价
  // 注意用字符类而不是 (?!\d)：`\s*` 回溯会让先行断言看到空格，误判成「非数字」
  const uncertain = /(?:^|[^a-z0-9_])(cc1h|cr|cc|p|c)\s*\*\s*[^\d\s)]/.test(target);
  // cc1h 是 Claude 1 小时 TTL 的缓存写，并入 cc（缓存写总价）
  const re = /(?:^|[^a-z0-9_])(cc1h|img_cr|img_o|cr|cc|img|ai|ao|p|c)\s*\*\s*([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(target))) {
    const k = m[1] === "cc1h" ? "cc" : m[1];
    if (!(k in coef)) continue;
    coef[k] = (coef[k] || 0) + Number(m[2]);
  }
  return { coef, uncertain };
}

/**
 * new-api「官方倍率预设」→ USD/1M 价目表（纯函数，测试可注入 fixture）。
 * 内容为 { data: { billing_expr: {模型: 表达式}, billing_mode: {模型: "tiered_expr"} } }。
 * 跳过（不写库、留给下层来源兜底）：
 *   request  fixed(...) 按次计费，token 计价表达不了
 *   invalid  表达式为空 / 抽不到任何 token 系数 / 单价离谱
 * tiered 只作提示（阶梯与分时表达式按首档价写入），不算跳过。
 */
function parseBillingExprPreset(text) {
  const payload = JSON.parse(text);
  const data = payload && payload.data;
  const exprs = data && data.billing_expr;
  if (!exprs || typeof exprs !== "object") {
    throw new Error("不是 new-api 官方倍率预设（缺少 data.billing_expr）");
  }
  const modes = data.billing_mode && typeof data.billing_mode === "object" ? data.billing_mode : {};
  const prices = new Map();
  const skipped = { request: [], invalid: [] };
  const tiered = [];

  for (const [rawId, rawExpr] of Object.entries(exprs)) {
    const modelId = String(rawId || "").trim();
    if (!modelId) continue;
    // 显式配成 ratio 模式的模型走倍率表，表达式不生效，解析出来是错的
    if (modes[modelId] && modes[modelId] !== "tiered_expr") { skipped.invalid.push(modelId); continue; }
    const expr = String(rawExpr || "").trim().replace(/^v\d+:/i, "");
    if (!expr) { skipped.invalid.push(modelId); continue; }
    if (/\bfixed\s*\(/i.test(expr)) { skipped.request.push(modelId); continue; }

    const { coef, uncertain } = extractPriceCoefs(expr);
    if (uncertain) { skipped.invalid.push(modelId); continue; }
    if (coef.p == null && coef.c == null && coef.cr == null && coef.cc == null) {
      skipped.invalid.push(modelId);
      continue;
    }
    const inputPerM = coef.p || 0;
    const outputPerM = coef.c || 0;
    if (inputPerM > MAX_PRICE_PER_M || outputPerM > MAX_PRICE_PER_M) {
      skipped.invalid.push(modelId);
      continue;
    }
    // 表达式没单列缓存读 = 缓存 token 已含在 p 里，按输入价计；单列了（哪怕是 0）就用它的系数
    const cacheReadPerM = coef.cr != null ? coef.cr : inputPerM * DEFAULT_CACHE_RATIO;
    const cacheWritePerM = coef.cc != null ? coef.cc : inputPerM * DEFAULT_CREATE_CACHE_RATIO;
    if (/len\s*[<>=]|\?/.test(expr)) tiered.push(modelId);

    prices.set(modelId, { modelId, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, currency: "USD" });
  }
  return { prices, skipped, tiered, total: Object.keys(exprs).length };
}

/**
 * models.dev/api.json → USD/1M 价目表。
 * 结构：{ 供应商: { models: { 模型名: { cost: { input, output, cache_read, cache_write } } } } }。
 * 同一模型名会出现在多个供应商下，按 new-api 的冲突策略取「最便宜的非零输入价」
 * （零价多为未定价或免费渠道，不能代表市场价）。
 */
function parseModelsDev(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("不是 models.dev 价格数据（顶层应为供应商对象）");
  }
  const prices = new Map();
  let total = 0;
  const better = (next, cur) => {
    const nextNonZero = next.inputPerM > 0;
    const curNonZero = cur.inputPerM > 0;
    if (nextNonZero !== curNonZero) return nextNonZero;
    if (nextNonZero && next.inputPerM !== cur.inputPerM) return next.inputPerM < cur.inputPerM;
    return false;
  };

  for (const provider of Object.keys(data).sort()) {
    const models = data[provider] && data[provider].models;
    if (!models || typeof models !== "object") continue;
    for (const [name, m] of Object.entries(models)) {
      const cost = m && m.cost;
      if (!cost) continue;
      const inputPerM = Number(cost.input);
      const outputPerM = Number(cost.output);
      if (!isFinite(inputPerM) || !isFinite(outputPerM) || inputPerM < 0 || outputPerM < 0) continue;
      if (inputPerM > MAX_PRICE_PER_M || outputPerM > MAX_PRICE_PER_M) continue;
      total++;
      const readC = Number(cost.cache_read);
      const writeC = Number(cost.cache_write);
      const row = {
        modelId: name,
        inputPerM,
        outputPerM,
        cacheReadPerM: isFinite(readC) && readC >= 0 ? readC : inputPerM * DEFAULT_CACHE_RATIO,
        cacheWritePerM: isFinite(writeC) && writeC >= 0 ? writeC : inputPerM * DEFAULT_CREATE_CACHE_RATIO,
        currency: "USD",
      };
      const cur = prices.get(name);
      if (!cur || better(row, cur)) prices.set(name, row);
    }
  }
  return { prices, skipped: { request: [], invalid: [] }, tiered: [], total };
}

/** 建三级索引：原名 / 小写 / 归一化 */
function buildPriceIndex(prices) {
  const exact = new Map();
  const lower = new Map();
  const normalized = new Map();
  for (const [name, row] of prices) {
    exact.set(name, row);
    const lo = name.toLowerCase();
    if (!lower.has(lo)) lower.set(lo, row);
  }
  // 归一化索引分两遍：先占位，再让「本身没有后缀」的名字覆盖——
  // 同时存在 gpt-4o 与 gpt-4o-2024-08-06 时，前者才是通用价
  for (const [name, row] of prices) {
    const nk = normalizeModelName(name);
    if (nk && !normalized.has(nk)) normalized.set(nk, row);
  }
  for (const [name, row] of prices) {
    const nk = normalizeModelName(name);
    if (nk && nk === name.toLowerCase()) normalized.set(nk, row);
  }
  return { exact, lower, normalized };
}

/** 逐级匹配：原名 → 小写 → 归一化。返回 { row, via } 或 null */
function matchModel(index, modelId) {
  const raw = String(modelId || "");
  if (!raw) return null;
  if (index.exact.has(raw)) return { row: index.exact.get(raw), via: "exact" };
  const lo = raw.toLowerCase();
  if (index.lower.has(lo)) return { row: index.lower.get(lo), via: "case" };
  const nk = normalizeModelName(raw);
  if (nk && index.normalized.has(nk)) return { row: index.normalized.get(nk), via: "normalized" };
  return null;
}

// ===== 三套价格源的拉取与状态 =====

/** 按 id 取源定义 */
function getPricingSource(id) {
  return PRICING_SOURCES.find((s) => s.id === id) || null;
}

/** 源 id 列表（配置层 / 调度用） */
function pricingSourceIds() {
  return PRICING_SOURCES.map((s) => s.id);
}

/** 正文 → 价目表（Map<modelId, 价目>），按 format 分派 */
function parsePricingSource(source, text) {
  if (source.format === "models_dev") return parseModelsDev(text);
  if (source.format === "litellm") {
    const prices = parseLiteLLM(text);
    return { prices, skipped: { request: [], invalid: [] }, tiered: [], total: prices.size };
  }
  return parseBillingExprPreset(text);
}

/** 单源状态（meta 记账） */
function getPricingSourceStatus(id) {
  return {
    id,
    lastAt: Number(db.getMeta(`pricing_${id}_at`) || 0) || null,
    lastHash: db.getMeta(`pricing_${id}_hash`) || null,
    lastModels: Number(db.getMeta(`pricing_${id}_models`) || 0) || null,
    lastTotal: Number(db.getMeta(`pricing_${id}_total`) || 0) || null,
    lastError: db.getMeta(`pricing_${id}_error`) || null,
    lastErrorAt: Number(db.getMeta(`pricing_${id}_error_at`) || 0) || null,
  };
}

/** 三源状态（按优先级顺序，界面直接渲染） */
function getPricingSourcesStatus() {
  return PRICING_SOURCES.map((s) => ({ ...s, ...getPricingSourceStatus(s.id) }));
}

/**
 * 拉取并应用单套价格表。拉取即应用，不弹确认：新增/调价/未变都进返回值，
 * 由界面 toast 汇报。只对「本地真实出现过用量」的模型入库。
 * 任何失败向上抛出，由调用方记日志兜底（不影响数据同步）。
 */
async function pullPricingSource(id, opts = {}) {
  const source = getPricingSource(id);
  if (!source) throw new Error(`未知价格源：${id}`);
  const force = !!opts.force;
  const hasSegments = db.countSourcePrices(id) > 0;

  // 1. 哈希短路：远程表带 .sha256，其它源退化用正文哈希（省的是写库与重算）
  let remoteHash = null;
  if (source.hashUrl && !force) {
    try {
      remoteHash = (await fetchText([source.hashUrl], opts.proxy)).text.trim();
      if (remoteHash && hasSegments && remoteHash === db.getMeta(`pricing_${id}_hash`)) {
        db.setMeta(`pricing_${id}_at`, String(Date.now()));
        return { action: "unchanged", hash: remoteHash };
      }
    } catch {
      remoteHash = null; // 哈希文件不可用不阻断，继续拉正文
    }
  }

  // 2. 全量拉取 + 解析
  const { text } = await fetchText([source.url], opts.proxy);
  const parsed = parsePricingSource(source, text);
  const hash = remoteHash || crypto.createHash("sha256").update(text).digest("hex");
  if (!force && hasSegments && hash === db.getMeta(`pricing_${id}_hash`)) {
    db.setMeta(`pricing_${id}_at`, String(Date.now()));
    return { action: "unchanged", hash };
  }

  // 3. 与本地真实用量取交集（避免把上万条无关模型写进价格表）
  const index = buildPriceIndex(parsed.prices);
  const usedModels = db.getAggregate("full", "model", null, null, null).map((r) => r.key);
  const candidates = [];
  let unmatched = 0;
  for (const modelId of usedModels) {
    const hit = matchModel(index, modelId);
    if (hit) candidates.push({ ...hit.row, modelId, providerId: null });
    else unmatched++;
  }

  // 4. 空响应保护：一个都没匹配上时不动已有段——清掉价格会让费用静默归零
  if (!candidates.length) {
    const msg = "本次未匹配到任何本地模型，已保留原价格";
    db.setMeta(`pricing_${id}_error`, msg);
    db.setMeta(`pricing_${id}_error_at`, String(Date.now()));
    return { action: "empty", total: parsed.prices.size, unmatched, skipped: parsed.skipped };
  }

  // 5. 写自己的来源段（同价跳过 / 异价关旧段开新段）
  const applied = db.applySourcePricing(candidates, id);
  const manualModels = new Set(
    db.listCurrentPrices().filter((p) => p.source === "manual").map((p) => p.modelId)
  );
  const shadowed = candidates.filter((c) => manualModels.has(c.modelId)).length;
  db.setMeta(`pricing_${id}_hash`, hash);
  db.setMeta(`pricing_${id}_at`, String(Date.now()));
  db.setMeta(`pricing_${id}_models`, String(candidates.length));
  db.setMeta(`pricing_${id}_total`, String(parsed.prices.size));
  db.setMeta(`pricing_${id}_error`, "");
  db.setMeta(`pricing_${id}_error_at`, "");
  return {
    action: "updated",
    added: applied.added, updated: applied.updated, same: applied.skipped,
    models: candidates.length, total: parsed.prices.size, hash,
    unmatched, shadowed,
    skipped: parsed.skipped, tieredCount: parsed.tiered.length,
  };
}

module.exports = {
  parseLiteLLM, parseOpenRouter, previewImport, applyImport, syncPrices,
  parseBillingExprPreset, parseModelsDev, normalizeModelName, buildPriceIndex, matchModel,
  pullPricingSource, getPricingSourcesStatus, getPricingSourceStatus, pricingSourceIds,
  LITELLM_URLS, OPENROUTER_URL, PRICES_FILE, PRICING_SOURCES,
};