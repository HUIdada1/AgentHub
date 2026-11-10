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
// 反代网关 · Accio 模型目录：catalog.json 静态兜底 + POST /api/llm/config 远程刷新（v1，失败回落 v2）
//
// 清单来源：
//   1. 静态兜底：客户端内置 model-catalog.json 的 visible:true 条目（见 FALLBACK）。进程启动即可用，
//      没有账号 / 网络不通时模型目录仍有内容。条目名是「代号之前」的那一代，上游接口仍认（逐条实测）。
//   2. 远程刷新：POST {gw}/api/llm/config，body {token}，头带 x-package-region（GLOBAL / CN）。
//      上游按地区与账号权限给清单。
//
// 上游响应形态（实测，解析必须按这一份）：
//   { success, code, message, data:[ { provider, providerDisplayName, modelList:[ { modelCode, modelName,
//     modelDisplayName, visible, protocol, group, contextWindow, multimodal, reasoningEfforts, isDefault } ] } ] }
//   注意 data 是 **provider 数组**，不是 {providers:[…]} 对象；数组与对象两种形态都接受。
//
// 上游把模型名换成了混淆代号（1Orbit-… / 1Helix-… 这类不透明串），人类可读名只在 modelDisplayName。
// 老名字仍然可用（实测 claude-sonnet-4-6 与代号都能出流）。处置：
//   - upstreamKey 存上游代号 —— 发给上游的就是它，转发永远用当前代号；
//   - 对外 id 走 STABLE_IDS：能沿用老名字就沿用（用户已配好的名字不用改），新模型没有老名字才用代号。
//
// 为什么按地区分开缓存：GLOBAL 与 CN 的目录可能不同（上游按 x-package-region 过滤），
// 共用一个格子会让两家互相覆盖，而时间戳还显示「刚刚更新」。缓存按渠道 id（accio / accio_cn）分格。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const auth = require("./auth.cjs");
const endpoints = require("./endpoints.cjs");

const CACHE_TTL_MS = 60 * 60 * 1000; // 目录变化不频繁，与 qoder 的 1 小时同量级；force 绕过

// 静态兜底（客户端内置 model-catalog.json 的 visible 条目，2026-09 快照）。
// upstreamKey 是发给上游的 model 字段值（就是 modelCode）。placement 一列是思考档位落点
// （静态表没有上游 protocol 字段，按实测逐条写死；远程清单走「读 protocol」）。
const FALLBACK = [
  // [modelCode, 展示名, contextWindow, multimodal, reasoningEfforts, isDefault, placement]
  ["gemini-3-flash-preview", "Gemini 3 Flash", 1000000, true, ["low", "high"], true, "top"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro", 1000000, true, ["low", "high"], false, "top"],
  ["qwen3.6-plus", "Qwen 3.6 Plus", 991808, false, [], false, "top"],
  ["qwen3-max-2026-01-23", "Qwen 3 Max", 262144, false, [], false, "top"],
  ["gpt-5.4", "GPT 5.4", 1050000, true, ["low", "high"], false, "properties"],
  ["gpt-5.2-1211", "GPT 5.2", 400000, true, ["low", "high"], false, "properties"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 1000000, true, ["low", "medium", "high", "max"], false, "top"],
  ["claude-opus-4-6", "Claude Opus 4.6", 1000000, true, ["low", "medium", "high", "max"], false, "top"],
  ["glm-5", "GLM-5", 200000, false, [], false, "top"],
  ["MiniMax-M2.5", "MiniMax M2.5", 204800, true, [], false, "properties"],
];

// 老模型名 → 上游展示名：把「目录里有 Claude Sonnet 4.6 这一条」接回老名字当对外 id（upstreamKey 仍是代号）。
// 按展示名而不是硬编码代号：代号是上游随时会换的不透明串，展示名才是稳定对外的东西。
// 只收「同一个模型」的对应关系：版本跃迁不在这里接（用户点名 A 却拿到 B 是静默替换，宁可 404）。
const STABLE_IDS = [
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["gemini-3-flash-preview", "Gemini 3 Flash"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro"],
  ["glm-5", "GLM-5"],
];

function stableId(code, display) {
  const hit = STABLE_IDS.find(([, name]) => name.toLowerCase() === String(display || "").toLowerCase());
  return hit ? hit[0] : code;
}

// 思考档位落点（properties / top）：为什么不能按模型名猜 —— 上游把模型名换成不透明代号后 contains("gpt") 全失效。
// 改用上游目录里自己给的 protocol 字段：responses / openai → properties（只有 properties 能出思考内容），
// 空 / 其它 → top（Gemini 系放 properties 是硬 400）。兜底取 top（唯一三种模型上都不报错的落点）。
function effortPlacement(entry) {
  const p = String((entry && entry.protocol) || "").trim().toLowerCase();
  return p === "responses" || p === "openai" ? "properties" : "top";
}

// 远程条目归一（上游字段 → 统一键名），保留 upstreamKey / reasoningEfforts / protocolKind 自有键
function normalizeEntry(entry, forcedPlacement) {
  const code = String((entry && (entry.modelCode || entry.modelName)) || "").trim();
  if (!code) return null;
  const display = String((entry && entry.modelDisplayName) || "").trim() || code;
  const contextWindow = Number(entry && entry.contextWindow) || 0;
  const multimodal = !!(entry && entry.multimodal);
  const efforts = Array.isArray(entry && entry.reasoningEfforts)
    ? entry.reasoningEfforts.filter((e) => typeof e === "string") : [];
  const item = {
    id: stableId(code, display),
    name: display,
    rate: null,
    capabilities: { images: multimodal, reasoning: efforts.length > 0, tools: true },
    contextLength: contextWindow,
    maxOutputTokens: 0,
    isDefault: !!(entry && entry.isDefault),
    upstreamKey: code,
    reasoningEfforts: efforts,
    protocolKind: forcedPlacement || effortPlacement(entry),
  };
  return item;
}

function fallbackModels() {
  return FALLBACK.map(([code, name, window, multimodal, efforts, isDefault, placement]) =>
    normalizeEntry({ modelCode: code, modelDisplayName: name, contextWindow: window, multimodal, reasoningEfforts: efforts, isDefault }, placement));
}

// 一渠道一缓存格
const caches = new Map(); // channel -> { at, models }
function cacheOf(channel) {
  if (!caches.has(channel)) caches.set(channel, { at: 0, models: [] });
  return caches.get(channel);
}

// 当前清单：远程（有的话）优先，否则静态兜底
function regionModels(channel) {
  const slot = cacheOf(channel);
  const saved = require("../rules.cjs").get("catalog.json")?.[channel];
  if (Array.isArray(saved?.models) && saved.models.length && saved.syncedAt > slot.at) {
    slot.models = saved.models; slot.at = saved.syncedAt;
  }
  const cached = slot.models;
  return cached.length ? cached : fallbackModels();
}

// 路由与界面都按小写 id 匹配，去重也必须大小写不敏感，否则同名模型会各留一份
function list(channel) {
  const merged = [];
  const seen = new Set();
  for (const item of regionModels(channel)) {
    const id = String(item.id || "");
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// 客户端点名的模型 → 上游发送名（先 id 再 name 再 upstreamKey，trim + 忽略大小写）。
// 老名字也认：远程条目的 id 已是「能沿用就沿用」的老名字，upstreamKey 兜住「客户端抄了代号过来」。
function resolve(channel, modelName) {
  const wanted = String(modelName || "").trim();
  if (!wanted) return null;
  const candidates = regionModels(channel);
  const hit = candidates.find((item) =>
    [item.id, item.name, item.upstreamKey].some((v) => typeof v === "string" && v.trim().toLowerCase() === wanted.toLowerCase()));
  return hit || null;
}

// 解析 /api/llm/config 响应（data 是 provider 数组，也接受 {providers:[…]} 对象形态）
function parseCatalog(payload) {
  const providers = (payload && Array.isArray(payload.data) && payload.data)
    || (payload && payload.data && Array.isArray(payload.data.providers) && payload.data.providers)
    || (Array.isArray(payload) ? payload : [])
    || [];
  const out = [];
  for (const provider of providers) {
    const modelList = provider && Array.isArray(provider.modelList) ? provider.modelList : [];
    for (const entry of modelList) {
      if (entry && entry.visible === false) continue; // 按不可用处理
      const item = normalizeEntry(entry);
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * 远程刷新（POST /api/llm/config，失败回落 /api/llm/config/v2）。
 * env = { token }（accessToken）；force=false 按 TTL 早退，force=true 真打一次。
 * 返回 { ok, unchanged?, added?, count?, message? }
 */
async function refresh(channel, env, force) {
  const token = String((env && env.token) || "").trim();
  if (!token) return { ok: false, message: "该账号没有凭据" };
  const slot = cacheOf(channel);
  if (!force && slot.at > 0 && Date.now() - slot.at < CACHE_TTL_MS) return { ok: true, unchanged: true };

  const body = { token, supportAutoModel: true };
  let lastError = "";
  let models = [];
  for (const p of [endpoints.MODEL_CONFIG_PATH, endpoints.MODEL_CONFIG_PATH_V2]) {
    let response;
    try {
      response = await auth.postJson(channel, p, body);
    } catch (e) {
      lastError = `目录请求失败：${(e && e.message) || e}`;
      continue;
    }
    if (!response.ok) {
      lastError = response.status === 401 || response.status === 403
        ? "凭证可能已失效，请重新登录" : `上游返回 HTTP ${response.status}`;
      continue;
    }
    const parsed = parseCatalog(response.data);
    if (!parsed.length) {
      lastError = "上游目录里没有可见模型";
      continue;
    }
    if (p === endpoints.MODEL_CONFIG_PATH_V2) {
      // 兜底路径成功留一行痕：意味着 v1 出了问题（上游改版 / 灰度下线），排障时看这一行
      console.log(`[Models] ⚠️ Accio ${endpoints.regionOf(channel).label}目录回落到 v2 精简清单（${parsed.length} 个模型）—— v1 本次不可用`);
    }
    models = parsed;
    break;
  }
  if (!models.length) return { ok: false, message: lastError || "上游目录里没有可见模型" };

  slot.at = Date.now();
  slot.models = models;
  return { ok: true, added: models.length, count: models.length };
}

module.exports = { list, resolve, refresh, parseCatalog, normalizeEntry, effortPlacement, fallbackModels };
