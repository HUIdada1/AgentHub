/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MonkeyCode 模型目录
//
// 建任务要的是模型 **UUID**（上游字段 id），不是模型名，所以目录必须拉下来并留住：
// 没有「拿客户端给的模型名直接发上去」这条路。本家没有内置兜底清单——拉不到就如实说拉不到，
// 绝不编模型名（编出来的名字既通不过目录校验，也会让用户以为某个模型存在）。
//
// 两站各占一格缓存：模型清单是两份独立数据，合成一格会互相覆盖。
"use strict";

const regionStore = require("./region.cjs");
const endpoints = require("./endpoints.cjs");

const CATALOG_TTL_MS = 10 * 60000;

/** channel → { models: [...], at } */
const slots = new Map();

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 上游条目 → 本仓库的目录条目（id 给客户端点用，upstreamId 给建任务用） */
function mapEntry(row) {
  if (!row || typeof row !== "object") return null;
  const model = trimText(row.model);
  // 没有上游模型名的条目直接跳过：建任务时无法指定，留着只是幽灵条目
  if (!model) return null;
  const provider = trimText(row.provider);
  const id = provider ? `${provider}/${model}` : model;
  const interfaceType = trimText(row.interface_type);
  const entry = {
    id,
    name: trimText(row.display_name) || model,
    provider,
    model,
    upstreamId: trimText(row.id),
    interfaceType,
    cliName: endpoints.cliNameFor(interfaceType),
    // 工具调用是上游 coding agent 的固有能力（三个 agent 都走工具循环），给 true；
    // 图片位上游没给依据，保守 false——写 true 会让客户端附图然后静默丢图
    supportsToolCall: true,
    supportsImages: false,
    supportsVideo: false,
    supportsReasoning: row.thinking_enabled === true,
    isDefault: row.is_default === true,
  };
  if (row.is_free !== undefined) entry.isFree = row.is_free === true;
  const accessLevel = trimText(row.access_level);
  if (accessLevel) entry.accessLevel = accessLevel;
  if (Number(row.context_limit) > 0) entry.maxInputTokens = Math.trunc(Number(row.context_limit));
  if (Number(row.output_limit) > 0) entry.maxOutputTokens = Math.trunc(Number(row.output_limit));
  return entry;
}

/** 目录响应宽松取条目：`{code,data:{models:[]}}`、`{data:{models:[]}}`、裸数组三种形态都认 */
function extractRows(payload) {
  const data = payload && typeof payload === "object" && payload.data ? payload.data : payload;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.models)) return data.models;
  return [];
}

function list(channel) {
  const slot = slots.get(String(channel || ""));
  return slot && slot.models.length ? slot.models : [];
}

function ids(channel) {
  return list(channel).map((m) => m.id);
}

/** 名称 → 建任务目标：按 id / 上游模型名 / 显示名 / UUID 四种写法精确匹配（大小写不敏感）。
 *  刻意不做「找不到就回落到默认模型」：入口已按目录收窄过模型名，走到这里还找不到就是数据不一致，
 *  静默换成另一个模型会变成「选了 A、用的是 B」——这类静默错位一律报错。 */
function resolveTarget(channel, requested) {
  const name = String(requested || "").trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const entry of list(channel)) {
    if (
      entry.id.toLowerCase() === lower ||
      String(entry.model).toLowerCase() === lower ||
      String(entry.name).toLowerCase() === lower ||
      String(entry.upstreamId).toLowerCase() === lower
    ) {
      if (!entry.upstreamId) return null;
      return {
        modelId: entry.upstreamId,
        cliName: entry.cliName || endpoints.cliNameFor(entry.interfaceType),
        model: entry.model,
      };
    }
  }
  return null;
}

async function requestJson(deps, url, cred, section, region, what) {
  const headers = { ...endpoints.jsonHeaders(region, section), Cookie: endpoints.cookieHeader(cred) };
  const r = await deps.httpJson(url, { method: "GET", headers });
  if (!r || !r.ok) {
    const status = Number(r && r.status) || 502;
    if (status === 401 || status === 403) {
      throw Object.assign(new Error(`${what}：MonkeyCode 登录态已失效，请重新粘贴 session（HTTP ${status}）`), { status: 401 });
    }
    throw Object.assign(new Error(`${what}返回 HTTP ${status}`), { status });
  }
  return r.data;
}

/** 拉一次目录并刷新该站点的缓存；失败保留现有清单（不清空，否则一次抖动就看不见模型了） */
async function refresh(region, section, deps, session, force) {
  const channel = region.channel;
  if (!String(session || "").trim()) {
    return { ok: true, skipped: true, models: ids(channel), message: "尚未添加账号，模型目录待添加后刷新" };
  }
  const slot = slots.get(channel);
  if (!force && slot && slot.models.length && Date.now() - slot.at < CATALOG_TTL_MS) {
    return { ok: true, models: ids(channel), cached: true };
  }
  let payload = null;
  try {
    payload = await requestJson(deps, `${baseUrlFor(region, section)}${endpoints.MODELS_PATH}`, session, section, region, "模型目录查询");
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e), models: ids(channel) };
  }
  const rows = extractRows(payload);
  const models = [];
  for (const row of rows) {
    const entry = mapEntry(row);
    if (entry) models.push(entry);
  }
  if (!models.length) return { ok: false, message: "MonkeyCode 模型目录为空或格式不认识（保留现有清单）", models: ids(channel) };
  slots.set(channel, { models, at: Date.now() });
  return { ok: true, models: models.map((m) => m.id), count: models.length };
}

/** 站点基址（规则文件 / 环境变量可改到自建站点；结尾斜杠统一去掉） */
function baseUrlFor(region, section) {
  return String(regionStore.baseUrl(region, section) || "").replace(/\/+$/, "");
}

module.exports = { list, ids, resolveTarget, refresh, requestJson, CATALOG_TTL_MS, baseUrlFor };
