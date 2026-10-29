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
// 反代网关 · KukuAI 模型目录：静态兜底 + 远程刷新
//
// 两层结构的理由：上游清单会变（新增 / 下线），但 /v1/models 在离线或会话没建立时也得有清单可列，
// 所以留一份实测快照兜底。远程拉过一次之后，条目结构按上游返回的模型名走。
//
// 能力字段（图像 / 思考 / 工具）**上游不声明，这里就不给假值**——写 false 会主动禁掉客户端的附图，
// 写 true 会诱导客户端把它当编码 Agent 模型用。目录只给 id 与 name。
"use strict";

const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");
const session = require("./session.cjs");

const CATALOG_TTL_MS = 10 * 60000;

/** 实测模型名快照（`auto` 是上游自动选路档，必须保留在首位） */
const FALLBACK_MODEL_IDS = [
  "auto",
  "gateway-deepseek-v4.1-flash-tencent",
  "gateway-deepseek-v4-pro-tencent",
  "gateway-deepseek-v4-flash-tencent",
  "gateway-glm-5.3-flash",
  "glm-5.3",
  "gateway-glm-5.2",
  "gateway-glm-5.1-kuaishou",
  "ernie-5.1",
  "ms-kimi-k3",
  "gateway-kimi-k2.7-code-tencent",
  "gateway-kimi-k2.6",
  "ali-minimax/minimax-m3",
];

let remote = null; // { models: [{id,name}], at }

function listingEntry(name) {
  return { id: name, name };
}

function fallbackEntries() {
  return FALLBACK_MODEL_IDS.map(listingEntry);
}

/** 条目清单：远程优先，没拉过或拉到空回兜底 */
function entries() {
  if (remote && remote.models.length) return remote.models.slice();
  return fallbackEntries();
}

function ids() {
  return entries().map((e) => e.id);
}

/** 上游目录响应结构未公开，按递归找键的方式宽松取模型名：认 model_name / modelName / modelId。
 *  刻意**不**认通用的 id / name 键——那两个在别的外层对象上会出现（账号、活动、面板），
 *  认了就会把非模型的字符串当成模型名。认不出结构就返回空集，由调用方回落兜底。 */
function collectModelNames(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectModelNames(item, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase();
    if ((lower === "model_name" || lower === "modelname" || lower === "modelid") && typeof value === "string") {
      const text = value.trim();
      if (text) out.push(text);
      continue;
    }
    collectModelNames(value, out);
  }
  return out;
}

async function fetchRemote(cred, deps) {
  const triple = await session.ensureTriple(cred, deps, false);
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.modelList}?${endpoints.WEB_QUERY}${session.tokenQuery(triple)}`;
  const r = await deps.httpJson(url, {
    method: "GET",
    headers: credentials.requestHeaders(cred, "application/json, text/plain, */*"),
  });
  if (!r || !r.ok) throw sessionFailure(r, url);
  const payload = r.data;
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error(`KukuAI 返回非 JSON 响应（${url}）`), { status: 502 });
  }
  // 目录接口是 {status, data} 顶层包络（判据在 status.code），与 userreport 的 errno 形态不是一套
  const status = payload.status || {};
  const code = Number(status.code);
  if (code !== 0) {
    throw Object.assign(
      new Error(`KukuAI 模型目录接口失败（status.code=${status.code ?? "缺失"}：${String(status.msg || "未知错误")}）`),
      { status: code === 401 || code === 403 ? 401 : 502 },
    );
  }
  const names = collectModelNames(payload.data || {}, []).sort();
  const uniq = [];
  for (const name of names) if (!uniq.includes(name)) uniq.push(name);
  return uniq.length ? uniq.map(listingEntry) : fallbackEntries();
}

/** 目录接口的 HTTP 失败翻译与 userreport 同一口径（401/403 = 登录态失效） */
function sessionFailure(r, url) {
  const status = Number(r && r.status) || 502;
  if (status === 401 || status === 403) {
    return Object.assign(
      new Error(`KukuAI 登录态已失效，请重新登录该账号或重新粘贴完整 Cookie（HTTP ${status}，${url}）`),
      { status: 401 },
    );
  }
  return Object.assign(new Error(`KukuAI 返回 HTTP ${status}（${url}）`), { status });
}

/**
 * 刷新目录。
 * @returns {Promise<{ok:boolean, models?:string[], message?:string, skipped?:boolean}>}
 *   没凭据 = skipped（那是「用户还没添加账号」，不是失败）；拉取失败 = ok:false 并**保留现有清单**。
 */
async function refresh(cred, deps, force) {
  if (!cred) return { ok: true, skipped: true, models: ids(), message: "尚未添加账号，保留静态兜底清单" };
  if (!force && remote && remote.models.length && Date.now() - remote.at < CATALOG_TTL_MS) {
    return { ok: true, models: ids(), cached: true };
  }
  try {
    const models = await fetchRemote(cred, deps);
    remote = { models, at: Date.now() };
    return { ok: true, models: models.map((m) => m.id), count: models.length };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e), models: ids() };
  }
}

/**
 * 把客户端给的模型名归一成上游 model_name。
 * 接受 `auto` / `kuku/<name>` / 裸名；**未知名显式回退 auto**——上游对未知名是静默降级的，
 * 显式回退至少让日志里看得出来「用的是 auto」，而不是让人以为点名生效了。
 */
function resolveModel(name) {
  let text = String(name || "").trim();
  if (text.toLowerCase().startsWith("kuku/")) text = text.slice(5).trim();
  if (!text) return endpoints.DEFAULT_MODEL;
  const lower = text.toLowerCase();
  const known = entries().some((m) => String(m.id).toLowerCase() === lower) || FALLBACK_MODEL_IDS.includes(text);
  return known ? text : endpoints.DEFAULT_MODEL;
}

function remoteRefreshed() {
  return !!(remote && remote.models.length);
}

module.exports = {
  ids,
  entries,
  refresh,
  resolveModel,
  remoteRefreshed,
  FALLBACK_MODEL_IDS,
  CATALOG_TTL_MS,
};
