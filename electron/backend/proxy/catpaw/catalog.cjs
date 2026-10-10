// CatPaw 模型目录：静态表 + 远程目录（POST /api/agent/maas/model-types）的合成视图
// （移植来源：参照实现 catpaw/catalog.rs）。
//
// 为什么远程目录接口一度被认为不存在：桌面端 `modelTypesService` 里那句
// `('/api/agent/maas/model-types', {tenant, scene, env})` 看着像 GET 的 query 参数，
// 实际 tenant/scene/env 是 **POST 的 JSON body**。它的域名是桌面端直连的
// ai.catpaw.meituan.com（与转发链路同一个 host），凭证头也完全一致（Cookie: X-Passport-Token）。
//
// 分工：远程目录负责「有哪些模型、叫什么、倍率多少」这类会变的信息；
// 静态表（models.js 的 MODELS）负责「上游数字 ID 与 context 档位」这类必须实测坐实的信息
// ——数字 ID 写错不会报错，只会让请求打到另一个模型。
//
// AgentHub 侧持久化：远程结果由 index.cjs 的模型同步入口写进 rules/catalog.json（与其它渠道同一套），
// 本模块读那份目录；拉取失败保留旧目录（不写空），与其它渠道一致。
"use strict";
const rules = require("../rules.cjs");
const { MODELS, normalizeModelName } = require("./models.cjs");

/** 目录路径（桌面端路径常量，逐字照搬） */
const MODEL_TYPES_PATH = "/api/agent/maas/model-types";
/** 请求体：tenant/scene/env 是**客户端身份**的一部分（客户端发错拿不到目录，单独改一个也没有语义） */
const MODEL_TYPES_BODY = { tenant: "CatDesk", scene: "CATX_APP", env: "EXTERNAL" };

/** 读取已持久化的远程目录条目（未同步过返回空数组 = 回落到静态表） */
function remoteModels() {
  try {
    const catalog = rules.get("catalog.json") || {};
    const section = catalog.catpaw || {};
    return Array.isArray(section.models) ? section.models : [];
  } catch {
    return [];
  }
}

/** 按 id 或展示名找远程条目（大小写不敏感）。
 *  两处必须同口径：`/v1/models` 的归属判定是先比 id 再比展示名，
 *  若这里只比 id，同一个名字就会「目录层认识、转发层不认识」——清单里列着、请求却报 400 */
function findRemote(id) {
  const wanted = String(id || "").trim().toLowerCase();
  if (!wanted) return null;
  for (const item of remoteModels()) {
    if (!item || typeof item !== "object") continue;
    for (const key of ["id", "name"]) {
      const text = String(item[key] || "").trim().toLowerCase();
      if (text && text === wanted) return item;
    }
  }
  return null;
}

/** 当前清单里所有可转发的模型名（报错文案用） */
function knownIds() {
  return list().map((item) => String(item.id || "")).filter(Boolean);
}

/** 清单：远程优先（命中静态表时把实测坐实的数字 ID 与档位并进去），远程为空回落静态表。
 *  最后一道闸：没有上游数字 ID 的条目一律不广告——建会话必须先有数字 modelType，
 *  列进清单会造出「清单里有、请求却报 400」的自相矛盾 */
function list() {
  const remote = remoteModels();
  if (!remote.length) return staticList();
  const out = [];
  for (const source of remote) {
    if (!source || typeof source !== "object") continue;
    const entry = { ...source };
    const spec = specOf(String(entry.id || ""));
    if (spec) {
      if (!Number.isFinite(Number(entry.modelType))) entry.modelType = spec.hostModelId;
      if (!entry.maxInputTokens && spec.contextWindows.length) {
        entry.maxInputTokens = Math.max(...spec.contextWindows.map((text) => Number(text)).filter(Number.isFinite));
      }
      if (!entry.name) entry.name = spec.name;
    }
    if (!Number.isFinite(Number(entry.modelType))) continue;
    out.push(entry);
  }
  return out;
}

/** 静态表形态的清单（远程不可用时的回落） */
function staticList() {
  return MODELS.map((model) => {
    const entry = {
      id: model.id,
      name: model.name,
      capabilities: { images: model.supportImage, reasoning: model.supportThinking, tools: true },
      rate: null, // 静态表没有倍率（上游目录才有），界面显示 —
      contextLength: model.contextWindows.length ? Math.max(...model.contextWindows.map((text) => Number(text))) : 0,
      maxOutputTokens: 0,
      // 上游数字 modelType 与默认档位是转发必须用的（客户端请求的模型名要反查它）
      modelType: model.hostModelId,
    };
    if (model.defaultContextWindow) entry.defaultContextWindow = model.defaultContextWindow;
    return entry;
  });
}

/** 静态表里按 id 找条目（大小写/分隔符宽容，与 models.findModelEntry 同口径） */
function specOf(id) {
  const wanted = normalizeModelName(id);
  if (!wanted) return null;
  return MODELS.find((entry) => normalizeModelName(entry.id) === wanted || normalizeModelName(entry.name) === wanted) || null;
}

/** 把上游目录条目归一成 AgentHub 的 catalog.json 条目形态（agent.catalog 读的那份键名）。
 *  - 过滤 USER_CUSTOM（用户自建模型依赖客户端本地 apiKey，网关拿到既没凭证也不该转发）；
 *  - 丢弃 auto 伪模型（`extendedInfo.isAuto` 是 UI 的「自动选择」档位入口，不是真实模型，
 *    实测没有 rateMultiplier、没有 parameterDefinitions——列进清单会让客户端拿一个转不了发的名字） */
function normalizeEntry(item) {
  if (!item || typeof item !== "object") return null;
  const extended = item.extendedInfo && typeof item.extendedInfo === "object" ? item.extendedInfo : null;
  if (extended && isTruthy(extended.isAuto)) return null;
  if (String(item.provider || "").trim().toLowerCase() === "user_custom") return null;
  // 上游 id 取 modelTypeName（真实名字，如 glm-5.3-flash）；id 是本地记录主键、catPawModelType 是数字的字符串形态
  const id = String(item.modelTypeName || "").trim();
  if (!id) return null;
  const name = String((extended && extended.modelCaptionZhCN) || "").trim()
    || String(item.description || "").trim()
    || id;
  // 倍率：上游给的是字符串形式浮点（"0.94" / "0.03" / "0.00"），catalog.json 的 rate 是数值形态
  const rate = rateOf(extended && extended.rateMultiplier);
  // 思考能力：顶层 supportThinking；缺省时看参数佐证（目录里带 effort 枚举的模型一定支持思考档位）
  let supportsThinking;
  if (item.supportThinking !== undefined) supportsThinking = isTruthy(item.supportThinking);
  else {
    const definitions = Array.isArray(item.parameterDefinitions) ? item.parameterDefinitions : [];
    supportsThinking = definitions.some((definition) => definition && definition.id === "effort");
  }
  const entry = {
    id,
    name,
    capabilities: {
      images: item.supportImage !== undefined ? isTruthy(item.supportImage) : undefined,
      reasoning: supportsThinking,
      tools: true,
    },
    rate,
    contextLength: 0,
    maxOutputTokens: 0,
  };
  // capabilities.images 未声明时不写这个键（false 会主动禁止客户端附图）
  if (entry.capabilities.images === undefined) delete entry.capabilities.images;
  const modelTypeId = Number(item.modelTypeId);
  if (Number.isFinite(modelTypeId)) entry.modelType = Math.trunc(modelTypeId);
  // 上下文档位藏在 parameterDefinitions 的 ENUM 里：取档位上限作为 contextLength，默认档位另存
  const definitions = Array.isArray(item.parameterDefinitions) ? item.parameterDefinitions : [];
  const maxWindow = enumMax(definitions, "context");
  if (maxWindow !== null) entry.contextLength = maxWindow;
  const defaultWindow = enumDefault(definitions, "context");
  if (defaultWindow) entry.defaultContextWindow = defaultWindow;
  return entry;
}

/** `extendedInfo.rateMultiplier` → 数值倍率（catalog.json 的 rate 形态，fmtRate 直接读它）。
 *  非数字/缺失给 null（界面显示 `—`，绝不编造） */
function rateOf(value) {
  let plain = "";
  if (typeof value === "string") plain = value.trim();
  else if (typeof value === "number" && Number.isFinite(value)) plain = String(value);
  if (!plain) return null;
  const number = Number(plain);
  return Number.isFinite(number) ? number : null;
}

function enumValues(definitions, id) {
  const hit = definitions.find((definition) => definition && definition.id === id);
  return hit && Array.isArray(hit.values) ? hit.values : null;
}

function enumMax(definitions, id) {
  const values = enumValues(definitions, id);
  if (!values) return null;
  const numbers = values
    .map((item) => Number(item && item.value))
    .filter((n) => Number.isFinite(n));
  return numbers.length ? Math.max(...numbers) : null;
}

function enumDefault(definitions, id) {
  const hit = definitions.find((definition) => definition && definition.id === id);
  const value = hit && typeof hit.defaultValue === "string" ? hit.defaultValue.trim() : "";
  return value || null;
}

function isTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  return true;
}

module.exports = {
  MODEL_TYPES_PATH,
  MODEL_TYPES_BODY,
  remoteModels,
  findRemote,
  knownIds,
  list,
  normalizeEntry,
};
