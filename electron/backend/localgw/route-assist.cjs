/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 选路辅助（把「计划」接到既有两层结构上的那层胶水）
//
// ── 它与 route-plan 的分工 ───────────────────────────────────
// route-plan 是纯函数：给账号数组，返回带原因的位次。
// 本模块负责从号池取出真实账号、把运行期状态喂进去、再把结果翻译成调用方要的东西：
//   · pinForBinding  同渠道多号时，算出「这一轮该钉哪个号」
//   · bestEffort     全渠道都没可用号时，挑一个冷却中但恢复最早的强试一次
//   · failureAction  失败后该记退避、记垫底，还是什么都不记
//   · requestNeeds   这次请求要不要 tools / images / video
//   · previewModel   只读的计划预览（IPC 用，不产生任何副作用）
//
// ── 为什么 pin 而不是改执行器 ────────────────────────────────
// 执行器已经有 `pinAccountId`：积分优先选号就靠它把账号钉住，pin 失效时还会自己回落。
// 复用这条既有通道，比在执行器里再塞一套排序少一处分叉。
//
// ── 保守原则 ────────────────────────────────────────────────
// 所有增强只在「多候选 / 异常 / 兜底」时生效：
//   · 单账号渠道直接返回空 pin，不改变原有行为；
//   · 能力过滤后一个候选都不剩时保留原候选，宁可让上游回明确的 400；
//   · 只有 cooling 账号允许强试，余额耗尽/无凭据强试没有意义。
"use strict";
const pool = require("../proxy/pool.cjs");
const routePlan = require("./route-plan.cjs");
const routeState = require("./route-state.cjs");
const lgwConfig = require("./config.cjs");

/** 这次请求需要哪些能力。判定与 Agent2API 的 RequestNeeds 同口径。 */
function requestNeeds(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const needs = { tools: false, images: false, video: false };
  if (Array.isArray(body && (body.tools || body.functions)) && (body.tools || body.functions).length) needs.tools = true;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool" || message.role === "function" || message.function_call) needs.tools = true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) needs.tools = true;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const type = part && part.type;
      if (type === "image_url" || type === "input_image" || type === "image") needs.images = true;
      else if (type === "video_url" || type === "input_video" || type === "video") needs.video = true;
    }
  }
  return needs;
}

function hasNeeds(needs) {
  return !!needs && (needs.tools === true || needs.images === true || needs.video === true);
}

/** 该绑定声明的能力是否覆盖本次需求。未声明按「不覆盖」处理（与 plan 的文案一致）。 */
function supportsBinding(binding, needs) {
  if (!hasNeeds(needs)) return true;
  const capabilities = (binding && binding.capabilities) || {};
  return ["tools", "images", "video"].every((key) => !needs[key] || capabilities[key] === true);
}

/**
 * 失败后的状态动作：
 *   rest —— 记退避（上游 5xx / 超时 / 网络，账号本身可能没问题，凉一会儿再试）
 *   sunk —— 记限流垫底（429 / 额度类，疑似共享池被抢，30 分钟后自动回来）
 *   none —— 不记（模型级错误已有账号×模型冷却；取消与出口问题不该罚账号）
 */
function failureAction(errCode, failureScope) {
  if (failureScope === "egress") return "none";
  const code = String(errCode || "").toLowerCase();
  if (["rate", "quota", "credit", "account_blocked", "429"].includes(code)) return "sunk";
  if (["server", "timeout", "network", "timeout_error"].includes(code)) return "rest";
  return "none";
}

/** 粘性开关：off 关闭；auto/on 都启用（auto 的 TTL 由 route-state 的 5 分钟兜底）。 */
function stickyMode() {
  const mode = String((lgwConfig.get().routing || {}).sticky || "auto");
  return ["auto", "on", "off"].includes(mode) ? mode : "auto";
}

/** 会话键：关闭粘性或没有模型时返回空串，调用方据此跳过整个粘性链路。 */
function stickyKeyFor(body, headers) {
  if (stickyMode() === "off") return "";
  const model = String((body && body.model) || "").trim();
  if (!model) return "";
  return routeState.conversationKey({ model, messages: body && body.messages, headers });
}

/** 同渠道多号时算出该钉哪个号；单号 / 取不到账号时返回空串（保持原行为）。 */
function pinForBinding(binding, options = {}) {
  if (!binding || !binding.channel || !binding.realModel) return "";
  let rows;
  try {
    rows = pool.accountPlan(binding.channel, undefined, [], 0, String(binding.realModel));
  } catch {
    return "";
  }
  const eligible = (Array.isArray(rows) ? rows : []).filter((row) => row && row.eligible && row.account);
  if (eligible.length <= 1) return "";
  const accounts = eligible.map((row) => routePlan.adaptAccount(row.account, { inFlight: pool.inFlightCount(row.account.id) }));
  const plan = routePlan.buildPlan({
    accounts,
    strategy: "order",
    // 账号顺序已经由号池的 poolStrategy 排好（optimal / expire_first / manual…），
    // 这里只叠加粘性与退避/垫底/熔断，不重新按 priority 排。
    preserveOrder: true,
    state: options.state || {},
    stickyKey: options.stickyKey || "",
    needs: options.needs || null,
    excluded: options.tried || [],
    now: Number(options.now) || Date.now(),
  });
  return plan.ordered.length ? plan.ordered[0].id : "";
}

/**
 * 全渠道没有可用账号时的兜底：挑「冷却中且恢复最早」的那个强试一次。
 * 与 Agent2API 的第一级兜底同语义 —— 上游若已实际解除限额就能成功，
 * 否则把真实的 429 与恢复时间带回客户端，比直接 503 有用。
 * 余额耗尽 / 无凭据的账号不参与：那不是"等一会儿就好"的状态。
 */
function bestEffort(bindings, now = Date.now()) {
  let best = null;
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    if (!binding || !binding.channel || !binding.realModel) continue;
    let rows;
    try {
      rows = pool.accountPlan(binding.channel, undefined, [], 0, String(binding.realModel));
    } catch {
      continue;
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      const account = row && row.account;
      if (!account || account.status !== "cooling") continue;
      const until = Number(account.coolUntil) || 0;
      if (!(until > now)) continue;
      if (!best || until < best.resetAt) best = { binding, accountId: account.id, resetAt: until };
    }
  }
  return best;
}

/** 号池的中文原因 → 计划里的状态码（预览面板用；未知一律 blocked）。 */
function reasonState(reason) {
  const text = String(reason || "");
  if (text.includes("已尝试")) return "tried";
  if (text.includes("非在线")) return "offline";
  if (text.includes("凭据")) return "no-credentials";
  if (text.includes("余额耗尽")) return "exhausted";
  if (text.includes("过期")) return "expired";
  if (text.includes("冷却")) return "cooldown";
  if (text.includes("并发")) return "concurrency";
  return "blocked";
}

/** 只读预览：回答「这个模型的下一个请求会先落到谁、其余候选为什么排后面」。
 *  不推进游标、不写粘性、不改账号状态 —— 与转发路径共用 route-plan 的排序规则。 */
async function previewModel(model, options = {}) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, message: "缺少模型名" };
  const models = require("./models.cjs");
  const snapshot = await models.prepare({});
  const bindings = models.bindings(name, new Set(), snapshot).filter((binding) => !binding.unavailable);
  if (!bindings.length) return { ok: false, message: "模型未配置或已关闭" };
  const state = routeState.snapshot();
  const stickyKey = String(options.stickyKey || "");
  const channels = bindings.map((binding) => {
    let rows = [];
    try {
      rows = pool.accountPlan(binding.channel, undefined, [], 0, binding.realModel);
    } catch {
      rows = [];
    }
    const eligible = rows.filter((row) => row && row.eligible && row.account);
    const accounts = eligible.map((row) => routePlan.adaptAccount(row.account, { inFlight: pool.inFlightCount(row.account.id) }));
    const plan = routePlan.buildPlan({
      accounts, strategy: "order", preserveOrder: true, state, stickyKey, now: Date.now(),
    });
    const blocked = rows.filter((row) => !(row && row.eligible)).map((row) => ({
      id: row.account && row.account.id,
      name: (row.account && (row.account.name || row.account.id)) || "",
      state: reasonState(row.reason),
      reason: String(row.reason || ""),
    }));
    return {
      channel: binding.channel,
      realModel: binding.realModel,
      group: binding.groupName || "",
      stickyHit: plan.stickyHit,
      ordered: plan.ordered,
      blocked,
    };
  });
  return { ok: true, model: name, channels, sticky: stickyMode(), state: routeState.stats() };
}

module.exports = {
  requestNeeds,
  hasNeeds,
  supportsBinding,
  failureAction,
  stickyMode,
  stickyKeyFor,
  pinForBinding,
  bestEffort,
  reasonState,
  previewModel,
};
