// CatPaw 上游 modelType 映射表与入站参数解析（移植来源：参照实现 catpaw/models.rs，
// 上游是 proxy-chat-utils.mjs 的 MODELS 与 resolveEffort / resolveContextWindow）。
//
// 数字 modelType 是**上游的内部 ID**：写错一个不会报错，只会让请求打到另一个模型，
// 所以下表刻意保留「证据」注释，改动前必须回去核对参照实现与实测记录。
//
// 静态表不是模型清单的唯一来源：上游有远程目录（POST /api/agent/maas/model-types，见 catalog.js）。
// 远程负责「有哪些模型、叫什么、倍率多少」这类会变的信息；静态表负责「上游数字 ID 与 context 档位」
// 这类必须实测坐实的信息。resolveModelRequest 因此是「静态表 → 远程目录 → 纯数字」三档判定。
"use strict";
const CatPawError = require("./errors.cjs");

/** 一个 CatPaw 模型的静态事实。
 *  数字 ID 证据（逐条对照参照实现，**不要凭名字猜**）：
 *    - 83 = Kimi-K3：长连接日志里 model:83 会话自述 Moonshot/Kimi，真实 Host 图片请求成功；
 *    - 91 = GLM-5.3-Flash：model:91 会话自述 Z.ai GLM、真实 Host 图片请求成功，
 *      桌面端持久化选择为 {"modelId":91,"modelParams":{"context":"1024000","effort":"max"}}。
 *  kimi-k3 没有 contextWindows ⇒ 不支持 context 参数（传了报 400），glm-5.3-flash 才有三档 */
const MODELS = [
  {
    id: "kimi-k3",
    name: "Kimi-K3",
    hostModelId: 83,
    supportImage: true,
    supportThinking: true,
    contextWindows: [],
    defaultContextWindow: null,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    hostModelId: 91,
    supportImage: true,
    supportThinking: true,
    contextWindows: ["204800", "512000", "1024000"],
    defaultContextWindow: "1024000",
  },
];

/** 模型名归一化：小写 + 空白/下划线/点 → 连字符（容忍 `GLM 5.3 Flash` / `glm_5.3_flash` 这类变体） */
function normalizeModelName(value) {
  return String(value || "").trim().replace(/[\s_.]/g, "-").toLowerCase();
}

/** 按名字或数字找静态表条目 */
function findModelEntry(model) {
  if (typeof model === "number" && Number.isFinite(model)) {
    return MODELS.find((entry) => entry.hostModelId === Math.trunc(model));
  }
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    return MODELS.find((entry) => entry.hostModelId === asNumber) || null;
  }
  const normalized = normalizeModelName(trimmed);
  return MODELS.find((entry) => normalizeModelName(entry.id) === normalized || normalizeModelName(entry.name) === normalized) || null;
}

/** 本家接受的三个思考档位（由弱到强）：上游枚举改了这里改一处 */
const EFFORTS = ["low", "high", "max"];

/** 网关通用思考等级 → 本家档位（两两合流，由弱到强保持单调）。null = 不在通用表内。
 *  上游对三个枚举之外的值当场 400，而网关的档位表是 6 档（minimal/low/medium/high/xhigh/max）：
 *  AgentHub 的模型页把自定义思考强度**直接注入请求体**（server.cjs 的 modelCustom.reasoningEffort），
 *  原样透传会让「中/极高」这类合法设置把本来能用的请求打成 400。
 *  合流规则与参照实现的 effort_for_level 一致：
 *    minimal|low → low；medium|high → high；xhigh|max → max */
const LEVEL_RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
function effortForLevel(level) {
  const rank = LEVEL_RANK[String(level || "").trim().toLowerCase()];
  if (rank === undefined) return null;
  return EFFORTS[Math.min(Math.floor(rank / 2), EFFORTS.length - 1)];
}

/** 关闭思考的取值（模型页「关闭思考」/ provider 私有写法都归一成「不发 effort」）。
 *  本家没有关闭开关：发 low 是**打开**思考链，语义相反，绝不能拿它当 off 用 */
const OFF_LEVELS = ["off", "none", "disabled", "disable"];

/** 从请求体读思考档位：`reasoning_effort ?? reasoningEffort ?? effort`（空值合并）。
 *  返回 null 有两种含义（都表示为「不发 declarativeParams.effort」）：没指定、或明确要求关闭。
 *  取值链与参照实现 resolve_effort 相同，但**多接了一段档位归并**——原因见 effortForLevel：
 *  走到这里的大多是网关自己注入的档位，400 掉它等于把「设置不生效」升级成「请求失败」 */
function resolveEffort(body) {
  const source = body || {};
  let raw;
  for (const key of ["reasoning_effort", "reasoningEffort", "effort"]) {
    if (source[key] !== undefined && source[key] !== null) {
      raw = source[key];
      break;
    }
  }
  if (raw === undefined) return null;
  const value = String(typeof raw === "object" ? JSON.stringify(raw) : raw).trim().toLowerCase();
  if (OFF_LEVELS.includes(value)) return null;
  if (EFFORTS.includes(value)) return value;
  const mapped = effortForLevel(value);
  if (mapped) return mapped;
  throw new CatPawError(
    400,
    "reasoning_effort 仅支持 off / minimal / low / medium / high / xhigh / max（本家三档 low·high·max，通用档位自动归并）",
    { fatal: true }
  );
}

/** 客户端是否显式指定过思考档位（读得出值、或读出来是非法值都算「指定过」）。
 *  非法值也算：客户端传了 medium 这类本家不认的值时，后续 prepare 会给出 400；
 *  若此时注入映射上的档位，就把用户传错的参数悄悄换掉了 */
const CONTEXT_WINDOW_ALIASES = new Map([
  ["200k", "204800"],
  ["204800", "204800"],
  ["500k", "512000"],
  ["512000", "512000"],
  ["1m", "1024000"],
  ["1024k", "1024000"],
  ["1024000", "1024000"],
]);

/** 解析 context 档位：先取请求里的显式值（八个候选字段里第一个非空），没有才用模型默认档位；
 *  两者都没有返回 null（不发 context 字段）。显式值必须在别名表里、且该模型支持这个档位 */
function resolveContextWindow(body, resolution) {
  const source = body || {};
  const candidates = [
    source.context_window,
    source.contextWindow,
    source.context_length,
    source.contextLength,
    source.model_params && source.model_params.context,
    source.modelParams && source.modelParams.context,
    source.request_context && source.request_context.modelParams && source.request_context.modelParams.declarativeParams && source.request_context.modelParams.declarativeParams.context,
    source.requestContext && source.requestContext.modelParams && source.requestContext.modelParams.declarativeParams && source.requestContext.modelParams.declarativeParams.context,
  ];
  const requested = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  let raw;
  if (requested !== undefined) {
    raw = String(requested);
  } else if (resolution.entry && resolution.entry.defaultContextWindow) {
    raw = resolution.entry.defaultContextWindow;
  } else {
    return null;
  }
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (!CONTEXT_WINDOW_ALIASES.has(text)) {
    throw CatPawError.badRequest("context_window 仅支持 200K / 500K / 1M");
  }
  const normalized = CONTEXT_WINDOW_ALIASES.get(text);
  const supported = (resolution.entry && resolution.entry.contextWindows) || [];
  if (!supported.length) {
    throw CatPawError.badRequest(`模型 ${resolution.displayName} 不支持 context_window 参数`);
  }
  if (!supported.includes(normalized)) {
    throw CatPawError.badRequest(`模型 ${resolution.displayName} 不支持请求的上下文长度`);
  }
  return normalized;
}

/** 把客户端请求的 model 解析成上游数字 ID（三档：静态表 → 远程目录 → 纯数字）。
 *  remote 由 catalog.js 提供（{find, knownIds}，避免 models ↔ catalog 循环依赖） */
function resolveModelRequest(model, remote) {
  const requested = typeof model === "number" ? String(model) : (typeof model === "string" ? model.trim() : "");
  const entry = findModelEntry(model);
  if (entry) {
    return { modelType: entry.hostModelId, displayName: entry.id, entry };
  }
  if (requested && remote && typeof remote.find === "function") {
    const item = remote.find(requested);
    if (item && Number.isFinite(Number(item.modelType))) {
      return {
        modelType: Math.trunc(Number(item.modelType)),
        displayName: String(item.id || requested),
        entry: null,
      };
    }
  }
  if (requested && /^\d+$/.test(requested)) {
    // 数字 ID 直接可用（上游按数字识别模型），只是我们不知道它的档位与能力
    return { modelType: Number(requested), displayName: requested, entry: null };
  }
  const names = (remote && typeof remote.knownIds === "function" ? remote.knownIds() : []).join("、");
  throw CatPawError.badRequest(
    `CatPaw 上游不支持模型 ${requested || "(未指定)"}（可用: ${names || "无"}）`
  );
}

module.exports = {
  MODELS,
  EFFORTS,
  normalizeModelName,
  findModelEntry,
  resolveModelRequest,
  resolveEffort,
  effortForLevel,
  resolveContextWindow,
};
