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

// 远程价格源默认地址（参考 sub2api 的 pricing.remote_url / hash_url，LiteLLM 兼容格式）
const REMOTE_PRICING_DEFAULTS = {
  url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
  hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
  intervalHours: 24,
};

// ===== 网络 =====

async function doFetch(url, proxy) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (electron && electron.session && electron.net) {
    const session = electron.session.fromPartition("billing-import", { cache: false });
    await session.setProxy(proxy ? { mode: "fixed_servers", proxyRules: proxy } : { mode: "system" });
    return electron.net.fetch(url, { signal, session });
  }
  return fetch(url, { signal });
}

/** 依次尝试多个地址，返回首个成功的 { url, text } */
async function fetchText(urls, proxy) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await doFetch(url, proxy);
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
        effectiveFrom: Number.isFinite(Number(effectiveFrom)) ? Number(effectiveFrom) : Date.now(),
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
    db.replacePrices(remote.prices, remoteUpdated);
    return { action: "downloaded", count, remoteBy: remote.updatedBy || "其他设备" };
  }
  if (!remote || localUpdated > remoteUpdated) {
    const payload = JSON.stringify({
      v: 1,
      updatedAt: localUpdated || Date.now(),
      updatedBy: deviceName || "",
      prices: db.listAllPrices(),
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

// ===== 远程价格源自动拉取（来源 remote，参考 sub2api PricingService）=====

/** 上次拉取状态（meta 记账） */
function getRemotePricingStatus() {
  return {
    lastAt: Number(db.getMeta("remote_pricing_at") || 0) || null,
    lastHash: db.getMeta("remote_pricing_hash") || null,
    lastModels: Number(db.getMeta("remote_pricing_models") || 0) || null,
  };
}

/**
 * 从远程价格源拉取并应用（来源 remote）。借鉴 sub2api：
 * 哈希比对短路由（远程没变就拉个哈希文件，省流量）→ 全量下载解析 →
 * 只对「本地真实出现过用量」的模型入库（交集）→ 同价跳过 / 异价关旧段开新段。
 * 任何失败向上抛出，由调用方记日志兜底（不影响数据同步）。
 */
async function pullRemotePricing(opts = {}) {
  const url = String(opts.url || REMOTE_PRICING_DEFAULTS.url).trim();
  const hashUrl = String(opts.hashUrl || "").trim();
  if (!url) return { action: "skipped", reason: "未配置拉取网址" };

  // 1. 哈希短路（force 时跳过，用于手动「立即拉取」）
  let remoteHash = null;
  if (hashUrl && !opts.force) {
    try {
      remoteHash = (await fetchText([hashUrl], opts.proxy)).text.trim();
      if (remoteHash && remoteHash === db.getMeta("remote_pricing_hash")) {
        return { action: "unchanged", hash: remoteHash };
      }
    } catch {
      remoteHash = null; // 哈希拉取失败不阻断，直接尝试数据文件
    }
  }

  // 2. 全量拉取 + 解析（LiteLLM 格式，USD/token）
  const { text } = await fetchText([url], opts.proxy);
  const parsed = parseLiteLLM(text);

  // 3. 只取本地真实出现过用量的模型（交集），避免把数千个无关模型写进价格表
  const usedModels = db.getAggregate("full", "model", null, null, null).map((r) => r.key);
  const candidates = [];
  for (const modelId of usedModels) {
    const hit = parsed.get(modelId);
    if (hit) candidates.push({ ...hit, providerId: null });
  }

  // 4. 应用（remote 来源，同价跳过 / 异价关旧段开新段）
  const applied = db.applyRemotePricing(candidates);

  // 5. 记账（哈希作为同步锚点；远程无哈希文件时退化为数据自身哈希）
  const syncHash = remoteHash || crypto.createHash("sha256").update(text).digest("hex");
  db.setMeta("remote_pricing_hash", syncHash);
  db.setMeta("remote_pricing_at", String(Date.now()));
  db.setMeta("remote_pricing_models", String(candidates.length));
  return { action: "updated", total: parsed.size, ...applied, models: candidates.length, hash: syncHash };
}

module.exports = {
  parseLiteLLM, parseOpenRouter, previewImport, applyImport, syncPrices, pullRemotePricing, getRemotePricingStatus,
  LITELLM_URLS, OPENROUTER_URL, PRICES_FILE, REMOTE_PRICING_DEFAULTS,
};
