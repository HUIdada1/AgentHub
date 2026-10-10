// CatPaw 轮次执行层：SSE 消费到底 + 轮次收尾与注册表写回（移植来源：参照实现 catpaw/turn_executor.rs）。
//
// 与 conversation.js 的分工：那边管决策与请求体，本文件管执行与收尾。
//
// 为什么流式分支要独立消费到底（硬约束 2）：turn 的 SSE 必须消费到**服务端关闭连接**
// （`message.finished=true` ≠ turn 结束）。AgentHub 的服务端在客户端断开后仍会继续把
// 上游读到底（只停写响应），本层的读取循环因此天然满足这条约束。
//
// 失败要能被上层识别：HTTP 200 早就发给客户端了，真正的失败只能靠 `emit({type:"error"})`
// 让 server.cjs 的分类与换号逻辑看见（没出过内容时它会换号重试，出过内容则源流内错误帧收尾）。
"use strict";
const log = require("./log.cjs");
const CatPawError = require("./errors.cjs");
const { SseReader, TurnTranslator } = require("./openai.cjs");
const { messageFingerprint } = require("./fingerprint.cjs");
const { reportTerminal, stopTurn } = require("./upstreamHttp.cjs");
const { sessionRecord, isAwaitingToolResults } = require("./registry.cjs");

/** 一次 turn 的执行上下文 */
function turnContext({
  baseUrl,
  credentials,
  conversationId,
  turnRequestId,
  modelName,
  modelType,
  accountId,
  sessionId,
  persistent,
  choice,
  registry,
}) {
  return {
    baseUrl,
    credentials,
    conversationId,
    turnRequestId,
    modelName,
    modelType,
    accountId,
    sessionId,
    persistent,
    choice,
    registry,
  };
}

/** 成功轮次要写回注册表的指纹链：旧链 + 本轮**实际提交**的指纹 + 上游返回消息的指纹。
 *  「实际提交的」必须与发出去的一致（长会话只提交增量、工具续接只提交那条 tool 消息），
 *  多算会让下一次增量定位在客户端历史里定位到错误的位置 */
class HistoryFingerprints {
  constructor(prefix, submitted) {
    this.prefix = Array.isArray(prefix) ? prefix : [];
    this.submitted = Array.isArray(submitted) ? submitted : [];
  }

  chain(responseMessage) {
    return [...this.prefix, ...this.submitted, messageFingerprint(responseMessage)];
  }
}

/** 一次会话的收尾凭证（原实现 try/catch/finally 的显式形态）。
 *  正常/失败/取消三个终态由调用方显式 close(status) 上报；「返回工具调用」走 release()
 *  （本轮在上游语义里还没结束，既不报终态也不能走兜底取消）。 */
class FinishGuard {
  constructor(ctx, inflight) {
    this.baseUrl = ctx.baseUrl;
    this.credentials = ctx.credentials;
    this.conversationId = ctx.conversationId;
    this.turnRequestId = ctx.turnRequestId;
    this.sessionId = ctx.sessionId;
    this.registry = ctx.registry;
    this.inflight = !!inflight;
    this.active = false; // round + event(running) 是否都成功过（决定要不要报终态）
    this.closed = false;
    this.settled = false;
  }

  markActive() {
    this.active = true;
  }

  /** 报一个终态并收尾（幂等；上报失败不影响结果） */
  async close(status, error) {
    if (this.closed) return;
    this.closed = true;
    this.settled = true;
    if (this.active) {
      await reportTerminal(this.baseUrl, this.credentials, this.conversationId, status, error);
    }
    this.release();
  }

  /** **只**放开占用，并标记本轮「已交接」——用于「返回工具调用、等客户端续接」这条路径 */
  release() {
    this.settled = true;
    if (this.inflight && this.sessionId) {
      this.registry.releaseInflight(this.sessionId);
      this.inflight = false;
    }
  }

  /** 打断当前轮次（尽力而为） */
  async interrupt() {
    await stopTurn(this.baseUrl, this.credentials, this.conversationId, this.turnRequestId);
  }
}

/** tool_calls → 待响应 id 列表 */
function callIds(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map((call) => String((call && call.id) || ""))
    .filter((id) => id);
}

/** 消费一个上游事件：把增量包成 emit 事件交给上层；上游在数据帧里报错则抛出 */
function handleEvent(translator, event, emit) {
  if (event.failed) throw event.failed;
  for (const delta of translator.consume(event.data)) emit({ type: "delta", delta });
}

/** 流式轮次：把上游 SSE 读到底，增量经 emit 下发，收尾后写回注册表并报终态 */
async function driveStream(ctx, turn, guard, history, emit) {
  const translator = new TurnTranslator({ choice: ctx.choice });
  const sse = new SseReader();
  const reader = turn.response.body.getReader();
  let outcome = null; // {result} | {error}
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        outcome = { error: CatPawError.upstream(`上游流式传输中断: ${String((e && e.message) || e)}`) };
        break;
      }
      if (chunk.done) {
        // 服务端关闭连接 = turn 真正结束（硬约束 2）
        try {
          const last = sse.finish();
          if (last) handleEvent(translator, last, emit);
          outcome = { result: translator.finish() };
        } catch (e) {
          outcome = { error: e };
        }
        break;
      }
      try {
        for (const event of sse.push(chunk.value)) handleEvent(translator, event, emit);
      } catch (e) {
        outcome = { error: e };
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已读完或已被取消 */
    }
    turn.cancelTimer();
  }
  await finishStream(ctx, guard, history, outcome, emit);
}

/** 收尾一条轮次：注册表写回 + 终态上报 */
async function finishStream(ctx, guard, history, outcome, emit) {
  if (outcome.result) {
    const result = outcome.result;
    writeBack(ctx, guard, history, result);
    if (!result.toolCalls.length) {
      // 轮次正常结束：必须回报 completed（硬约束 1），否则下一轮 round 被拒
      await guard.close("completed", null);
    } else {
      // 例外：返回了工具调用——这一轮在上游语义里还没结束（客户端马上带 tool 结果回来续接），
      // 因此不报终态、只释放占用
      log.verbose(`轮次 ${String(guard.conversationId).slice(0, 8)} 返回 ${result.toolCalls.length} 个工具调用，等待客户端续接（不报 completed）`);
      guard.release();
    }
    if (result.usage) emit({ type: "usage", usage: result.usage });
    emit({ type: "finish", reason: result.finishReason });
    return;
  }
  const error = outcome.error || CatPawError.upstream("上游没有返回消息");
  log.verbose(`轮次中断: ${error.message}`);
  // HTTP 头早就发出去了，客户端只能靠流内 error 帧知道这次补全失败；
  // 记完错帧再收尾（终态上报含网络请求，不能挡在错误可见性前面）
  emit({ type: "error", status: error.status || 502, code: error.code || null, message: error.message });
  await guard.close("failed", error);
}

/** 成功轮次后的状态写回：有工具调用 → 「等工具结果」记录（含 turnRequestId）；
 *  无工具调用的长会话 → 覆盖登记（指纹链前移、清空待响应）；无工具调用的无状态/并发冲突 → 不登记 */
function writeBack(ctx, guard, history, result) {
  log.verbose(`轮次产出 content=${result.text.length} 字符 reasoning=${result.reasoning.length} 字符 toolCalls=${result.toolCalls.length}`);
  const pending = callIds(result.toolCalls);
  // 并发冲突时走的是独立 conversation：不写映射（写进去会让下一个同会话请求错误地续接到这条并行历史）
  const sessionId = ctx.persistent ? ctx.sessionId : "";
  if (!sessionId && !pending.length) return;
  const now = Date.now();
  const conversationId = result.conversationId || guard.conversationId;
  ctx.registry.register(sessionRecord({
    conversationId,
    fingerprints: history.chain(result.message),
    modelType: ctx.modelType,
    accountId: ctx.accountId,
    createdAt: now,
    sessionId,
    // 等工具结果时要带上「哪个 turn 在跑」：下一轮若发现会话仍在等待，要先 stop 掉它才能 round
    turnRequestId: pending.length ? ctx.turnRequestId : null,
    pendingCallIds: pending,
  }));
}

module.exports = { turnContext, HistoryFingerprints, FinishGuard, driveStream, writeBack, callIds, isAwaitingToolResults };
