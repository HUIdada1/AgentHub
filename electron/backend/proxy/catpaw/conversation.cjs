// CatPaw 轮次状态机：round → event(running) → turn(SSE) → 工具循环 → event(completed)
// （移植来源：参照实现 catpaw/conversation.rs）。
//
// 时序与三条硬约束：
//   全新会话         round(全量)   → event(running) → turn(user)     → … → event(completed)
//   长会话新轮次     round(增量)   → event(running) → turn(user)     → … → event(completed)
//   工具续接         （不 round）  →                  turn(tool 结果) → …
//   1. **每个轮次结束必须回报 event(completed)**，否则 conversation 停在上游「执行中」，
//      下一轮 round 会被拒（`会话正在执行中，无法创建新轮次`）。失败回报 failed、打断回报 canceled；
//      例外：本轮返回工具调用时**不报** completed（上游语义里这一轮还没结束，客户端马上带 tool 结果回来续接）；
//   2. turn 的 SSE 必须消费到服务端关闭连接（在 turnExecutor.js 里落实）；
//   3. 同一会话 id 已有流式请求在跑 → 新请求走**独立 conversation**；非流式辅助请求
//      （客户端标题/摘要类）**不读不写**会话映射。
//
// 与参照实现的一处差异：round 被上游以「会话正在执行中」拒绝时**自愈重试一次**
// （新 conversation 全量 round）——参照实现只依赖下一轮先 turn/stop；这里多一层兜底，
// 因为注册表可能因进程重启/TTL 淘汰而丢失「上一轮还在跑」的信息，那条旧 conversation 就再没人停得掉。
"use strict";
const CatPawError = require("./errors.cjs");
const log = require("./log.cjs");
const util = require("../util.cjs");
const { resolveCredentials } = require("./credentials.cjs");
const { prepare } = require("./prepare.cjs");
const { decide, submittedFingerprints } = require("./decision.cjs");
const { fingerprintsFor } = require("./fingerprint.cjs");
const { registry, identityOf, isAwaitingToolResults, REASONS, shortId } = require("./registry.cjs");
const { HistoryFingerprints, FinishGuard, turnContext, driveStream } = require("./turnExecutor.cjs");
const { postJson, reportStatus, reportTerminal, stopTurn, turnRequest, upstreamBaseUrl, settings } = require("./upstreamHttp.cjs");

/** source / mode / toolVersion / permissionMode 全部取 headers.json 的 catpaw 段（可热改） */
function identityFields() {
  const cfg = settings();
  return {
    source: String(cfg.source),
    mode: String(cfg.mode),
    toolVersion: String(cfg.toolVersion),
    permissionMode: String(cfg.permissionMode),
  };
}

/** 会话 id：取 server.cjs 传入的 meta.conversationId（它由消息前缀哈希而来，同一会话跨轮稳定）。
 *  超长 id 不做截断而是丢弃：截断后的 id 会在两次请求之间不稳定地碰撞 */
function sessionIdOf(ctx) {
  const raw = String((ctx.meta && ctx.meta.conversationId) || util.stableConvId(ctx.body && ctx.body.messages) || "").trim();
  if (!raw || raw.length > 256) return "";
  return raw;
}

/** 构造 round 请求体 */
function roundBody(prepared, conversationId, messages) {
  const identity = identityFields();
  const body = {
    conversationId,
    source: identity.source,
    messages,
    modelType: prepared.resolution.modelType,
    mode: identity.mode,
    permissionMode: identity.permissionMode,
    toolVersion: identity.toolVersion,
  };
  if (prepared.systemPrompt) body.systemPromptContext = { systemPromptOverride: prepared.systemPrompt };
  if (prepared.rulesMessage) body.rulesMessage = prepared.rulesMessage;
  const declarative = {};
  if (prepared.effort) declarative.effort = prepared.effort;
  if (prepared.context) declarative.context = prepared.context;
  if (Object.keys(declarative).length) {
    body.requestContext = { modelParams: { declarativeParams: declarative } };
  }
  return body;
}

/** 构造 turn 请求体（返回 {body, finalType}；finalType 用于「持久会话必须以 user 结尾」的校验） */
function buildTurnBody(prepared, decision, guard) {
  const message = decision.mode === "tool-continuation" ? decision.continuation : prepared.finalMessage;
  if (!message) throw CatPawError.badRequest("工具结果续接请求缺少 tool 消息");
  const finalType = String(message.type || "");
  const availableTools = prepared.selectedTools.map((tool) => tool.name);
  const identity = identityFields();
  const body = {
    conversationId: guard.conversationId,
    turnRequestId: guard.turnRequestId,
    source: identity.source,
    action: "turn",
    message,
    modelType: prepared.resolution.modelType,
    mode: identity.mode,
    permissionMode: identity.permissionMode,
    toolVersion: identity.toolVersion,
    toolConfigs: prepared.selectedTools,
    availableTools,
  };
  if (prepared.systemPrompt) body.systemPromptContext = { systemPromptOverride: prepared.systemPrompt };
  if (prepared.rulesMessage) body.rulesMessage = prepared.rulesMessage;
  return { body, finalType };
}

/** 上游「会话正在执行中」的判定：上游这个拒绝没有稳定业务码（参照实现也只靠文案匹配），
 *  匹配失败只会退化成「不自愈」，不会误伤别的错误 */
function isBusyError(error) {
  return String((error && error.message) || "").includes("执行中");
}

/** 真正发一次 round */
async function submitRound(baseUrl, credentials, prepared, conversationId, messages) {
  const startedAt = Date.now();
  await postJson(baseUrl, "/api/agent/conversation/round", credentials, roundBody(prepared, conversationId, messages));
  log.verbose(`round 完成 conversationId=${shortId(conversationId)} msgs=${messages.length} durationMs=${Date.now() - startedAt}`);
}

/** round 提交 + 「会话正在执行中」的自愈重试（只在长会话新轮次模式上重试，且只重试一次） */
async function submitRoundWithSelfHeal(baseUrl, credentials, prepared, guard, decision, sessionId) {
  try {
    await submitRound(baseUrl, credentials, prepared, guard.conversationId, decision.roundMessages || []);
    return "fresh";
  } catch (error) {
    if (decision.mode !== "session-round" || !isBusyError(error)) throw error;
    log.verbose("上一轮仍在上游执行中，作废会话映射并改为全新会话重试一次");
    registry.invalidate(sessionId, REASONS.UpstreamRejected);
    guard.conversationId = util.uuid();
    await submitRound(baseUrl, credentials, prepared, guard.conversationId, prepared.messages);
    return "healed";
  }
}

/** 会话式转发的公开入口（adapters.cjs 的 catpaw.chatSession 调它）。
 *  出参与单发 chat 同形：{status, planLimit}；增量经 emit 回流，失败抛错（带 status / fatal） */
async function runConversation(ctx) {
  const credentials = resolveCredentials(ctx.account, ctx.secrets);
  if (!String(credentials.token || "").trim()) {
    throw new CatPawError(503, "CatPaw 没有可用的登录凭证：请在账号页添加账号，或配置环境变量", { fatal: true });
  }
  const prepared = prepare(ctx.body);
  return execute(ctx, prepared, credentials);
}

async function execute(ctx, prepared, credentials) {
  const body = ctx.body || {};
  const emit = typeof ctx.emit === "function" ? ctx.emit : () => {};
  const baseUrl = upstreamBaseUrl();
  const sessionId = sessionIdOf(ctx);
  const stateless = body.stream !== true;
  const accountId = String((ctx.account && ctx.account.id) || "");
  const identity = identityOf(accountId, credentials.uid);
  // 账号身份对账（转发选路时）：桌面端实时登录态由 CatPaw 客户端自己维护，用户可以在客户端里
  // 换一个账号登录——那时 accountId（desktop 账号 / 空）一个字都没变，只有 uid 变了，
  // 注册表按 accountId 看不出异常。这里拿**本次实际使用的凭证**里的 uid 与注册表记录的身份比对，
  // 不一致就把该账号名下的会话全部作废，于是客户端换号后的**下一次请求**走全新会话，
  // 而不是续接到上一个用户的 conversationId 上。身份没变时 O(1) 早退（一次 Map 查 + 一次比较）
  registry.reconcileIdentity(identity);
  // ── 并发占用与无状态判定：非流式的辅助请求（客户端标题/摘要类）不读也不写会话映射 ──
  let inflight = false;
  if (sessionId && !stateless) {
    inflight = registry.markInflight(sessionId, identity);
    if (!inflight) log.verbose("同一会话已有流式请求在跑，本次走独立 conversation");
  }
  const persistent = inflight;

  let decision;
  try {
    decision = decide({
      rawMessages: Array.isArray(body.messages) ? body.messages : [],
      sessionId,
      modelType: prepared.resolution.modelType,
      accountId,
      prepared,
      persistent,
    });
  } catch (error) {
    // 判定阶段失败也要把占用标记放开（否则同会话会被永久挡住）
    if (inflight) registry.releaseInflight(sessionId);
    throw error;
  }

  const tctx = turnContext({
    baseUrl,
    credentials,
    conversationId: decision.conversationId,
    turnRequestId: util.uuid(),
    modelName: prepared.resolution.displayName,
    modelType: prepared.resolution.modelType,
    accountId,
    sessionId,
    persistent,
    choice: prepared.choice,
    registry,
  });
  let history = new HistoryFingerprints(
    decision.session ? decision.session.fingerprints : [],
    submittedFingerprints(decision)
  );
  const guard = new FinishGuard(tctx, inflight);
  try {
    if (decision.roundMessages) {
      // 上一轮的工具调用被打断时 conversation 仍停在上游「执行中」，必须先停掉旧轮次，
      // 否则新 round 被拒（对齐桌面端的 turn_stop）
      const session = decision.session;
      if (session && isAwaitingToolResults(session) && session.turnRequestId) {
        await stopTurn(baseUrl, credentials, session.conversationId, session.turnRequestId);
        await reportTerminal(baseUrl, credentials, session.conversationId, "canceled", null);
      }
      const outcome = await submitRoundWithSelfHeal(baseUrl, credentials, prepared, guard, decision, sessionId);
      if (outcome === "healed") {
        // 自愈换了 conversation 且全量重提交：旧指纹链对新 conversation 毫无意义，
        // 前缀必须清空、提交集换成全量，否则下一轮的增量定位会以为上游已见过整段历史
        history = new HistoryFingerprints([], fingerprintsFor(prepared.messages));
        tctx.conversationId = guard.conversationId;
      }
      // event(running)（工具续接不重复报）
      try {
        await reportStatus(baseUrl, credentials, guard.conversationId, "running", null);
      } catch (error) {
        // round 成功但 running 回报失败：上游可能不认这次轮次，报一个 failed 收尾（尽力而为）
        guard.markActive();
        await guard.close("failed", error);
        throw error;
      }
    }
    guard.markActive();

    const turn = buildTurnBody(prepared, decision, guard);
    if (decision.mode !== "tool-continuation" && turn.finalType !== "user" && persistent) {
      // 只有持久会话要求轮次以 user 结尾；走到这里说明客户端提交的历史与映射对不上
      // （例如上一轮工具会话已失效），作废映射让它下一轮全量重来
      registry.invalidate(sessionId, REASONS.Explicit);
      await guard.close("failed", null);
      throw CatPawError.badRequest("工具会话已失效，请重新发起当前回合");
    }
    log.verbose(
      `mode=${decision.mode} conversationId=${shortId(guard.conversationId)} modelType=${prepared.resolution.modelType}`
      + ` msgs=${prepared.messages.length} roundMsgs=${decision.roundMessages ? decision.roundMessages.length : 0}`
      + ` finalType=${turn.finalType} tools=${prepared.selectedTools.length} stream=${body.stream === true}`
      + ` persistent=${persistent} stateless=${stateless}`
    );

    let stream;
    try {
      stream = await turnRequest(baseUrl, credentials, turn.body);
    } catch (error) {
      // turn 在请求头阶段就失败（网络/上游拒绝）：对话已经 round 过了，
      // 不报终态会让上游卡在「执行中」，因此必须报 failed
      log.verbose(`turn 请求失败: ${error.message}`);
      await guard.close("failed", error);
      throw error;
    }
    await driveStream(tctx, stream, guard, history, emit);
    return { status: 200, planLimit: false };
  } catch (error) {
    if (!guard.settled) {
      // 未显式收尾的兜底（等价参照实现的 Drop）：打断上游轮次 + 回报 canceled，
      // 上游硬约束要求 conversation 不能停在「执行中」
      log.verbose(`轮次未显式收尾（异常路径），补 stop + canceled：${(error && error.message) || ""}`);
      await guard.interrupt();
      await guard.close("canceled", null);
    }
    throw error;
  }
}

module.exports = { runConversation, sessionIdOf, buildTurnBody, isBusyError };
