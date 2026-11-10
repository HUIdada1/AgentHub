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
// 反代网关 · Loomy 模型目录：GET {集成网关}/api/v1/models（OpenAI 格式）+ 持久化缓存
//
// 上游形态（客户端 model-service.js 的 fetchModelsFromProvider）：标准 OpenAI 形态 {data:[{id,...}]}，
// 鉴权双头 token + Authorization: Bearer（客户端 authMode:'token' 时两个都发）。
// 拉取失败（500/404）时客户端会按 baseURL 用内置兜底清单 —— 但那条兜底只服务用户自配的
// spark-api-open.xf-yun.com，Loomy 官方 imodel 网关没有内置清单。因此这里如实报失败、保留旧清单，不编造模型名。
//
// 能力位读上游条目的 capabilities（reasoning / function_calling / vision / input_modalities），
// 实测每个条目都带这四个键；缺失时保守回落：工具调用按 OpenAI 兼容网关既有能力给 true，思考位按 id 判（spark-x）。
// 倍率从展示名尾部括号拆出（客户端 splitModelDisplayName 同口径：ASCII 与全角括号都认，只把 x<数字> 形态算倍率）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const client = require("./client.cjs");

const MODELS_PATH = "/api/v1/models";
const TTL_MS = 10 * 60 * 1000; // 自动路径缓存 TTL（与客户端自己的轮询周期同档）

// 进程内缓存 + 落盘（catalog.json 的 loomy 段，mtime 失效）
let cache = { at: 0, models: [], loaded: false };

function isReasoningModel(id) {
  const s = String(id || "").toLowerCase();
  return s === "spark-x" || s.includes("spark-x");
}

// 从上游展示名拆出积分倍率后缀（(x3.0) / (x0.8) / （x12）），返回 { name, rate }
function splitRateSuffix(name) {
  const trimmed = String(name || "").trimEnd();
  let body = null, inner = null;
  if (trimmed.endsWith(")")) {
    const open = trimmed.lastIndexOf("(");
    if (open < 0) return { name, rate: null };
    body = trimmed.slice(0, open); inner = trimmed.slice(open + 1, -1).trim();
  } else if (trimmed.endsWith("）")) {
    const open = trimmed.lastIndexOf("（");
    if (open < 0) return { name, rate: null };
    body = trimmed.slice(0, open); inner = trimmed.slice(open + 1, -1).trim();
  } else {
    return { name, rate: null };
  }
  const num = inner.startsWith("x") || inner.startsWith("X") ? inner.slice(1).trim() : null;
  if (!num || !/[0-9]/.test(num) || !/^[0-9.]+$/.test(num)) return { name, rate: null };
  const cleaned = body.trimEnd();
  const rate = `x${num}`;
  return { name: cleaned || name, rate };
}

function capsBool(caps, key) {
  return !!(caps && typeof caps === "object" && caps[key] === true);
}
function capsModal(caps, modal) {
  const arr = caps && caps.input_modalities;
  return Array.isArray(arr) && arr.some((v) => String(v).toLowerCase() === String(modal).toLowerCase());
}

// 把一个 OpenAI 目录条目映射成归一形态 {id,name,rate,capabilities,contextLength,maxOutputTokens}
function mapEntry(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || "").trim();
  if (!id) return null;
  const rawName = String(row.name || "").trim() || id;
  const { name, rate } = splitRateSuffix(rawName);
  const caps = row.capabilities && typeof row.capabilities === "object" ? row.capabilities : null;
  const capabilities = {
    images: capsBool(caps, "vision") || capsModal(caps, "image"),
    reasoning: capsBool(caps, "reasoning") || isReasoningModel(id),
    tools: capsBool(caps, "function_calling") || caps == null,
  };
  const pickNum = (keys) => {
    for (const k of keys) {
      const v = Number(row[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  };
  const contextLength = pickNum(["context_length", "context_window", "input_token_limit", "max_input_tokens", "maxInputTokens"]);
  const maxOutputTokens = pickNum(["max_output_tokens", "max_completion_tokens", "max_tokens", "maxOutputTokens"]);
  const out = { id, name, rate: null, capabilities, contextLength, maxOutputTokens };
  if (rate) out.rate = rate;
  return out;
}

// 解析 /models 响应（OpenAI {data:[...]} 或裸数组）
function parseModels(payload) {
  const rows = (payload && Array.isArray(payload.data) && payload.data) || (Array.isArray(payload) ? payload : []);
  return rows.map(mapEntry).filter(Boolean);
}

// 当前模型清单（内存 → catalog.json 落盘回读）
function list(rulesDir, channel) {
  if (cache.loaded) return cache.models.map((m) => m.id);
  const file = path.join(rulesDir, "catalog.json");
  try {
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = all && all[channel];
    if (entry && Array.isArray(entry.models) && entry.models.length) {
      cache = { at: Number(entry.syncedAt) || 0, models: entry.models, loaded: true };
      return cache.models.map((m) => m.id);
    }
  } catch { /* 无缓存 */ }
  return [];
}

// 条目数组（含元数据），供 chat 的能力/倍率展示
function entries(rulesDir, channel) {
  list(rulesDir, channel);
  return cache.models;
}

/**
 * 拉一次模型目录并落地（catalog.json 的 loomy 段）。
 * env = { session }；force=false 时 TTL 内早退（unchanged），force=true 真打上游。
 * 返回 { ok, added?, message?, count? }
 */
async function refresh(env, rulesDir, channel, force, fetchImpl, options = {}) {
  const session = String((env && env.session) || "").trim();
  if (!session) return { ok: false, message: "该账号没有凭据" };
  if (!force && cache.at > 0 && Date.now() - cache.at < TTL_MS) return { ok: true, unchanged: true };
  let payload;
  try {
    payload = await client.tokenRequest("GET", MODELS_PATH, session, null, "模型目录查询", fetchImpl);
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
  const models = parseModels(payload);
  if (!models.length) {
    return { ok: false, message: "Loomy 模型目录为空或格式不认识（保留现有清单）" };
  }
  const count = models.length;
  options.assertCurrent?.();
  cache = { at: Date.now(), models, loaded: true };
  // 落盘 catalog.json（整段覆盖对应渠道，与别家同口径）
  if (!options.deferPersist) try {
    const file = path.join(rulesDir, "catalog.json");
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 新建 */ }
    all[channel] = { syncedAt: cache.at, models };
    fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf8");
  } catch { /* 落盘失败不阻断，内存态已生效 */ }
  return { ok: true, models, added: count, count };
}

module.exports = { list, entries, refresh, parseModels, mapEntry, splitRateSuffix, isReasoningModel };
