/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 出线侧：Anthropic Messages 协议（Claude Code / Anthropic SDK 看到的字节）
//
// 输入是调度核心交出来的四种事件（delta / usage / finish / error，词汇与 OpenAI 通路完全一致），
// 输出是 Messages 协议的事件流。块边界由这里自己从 OpenAI 形态的 delta 推导：
//   reasoning_content → thinking 块；首个非空 content → text 块；tool_calls[i] 首现 → tool_use 块；
//   finish → 关掉所有未闭合块再发 message_delta / message_stop。
//
// 为什么必须先探后写（deferredOpen）：换号重发是网关的常规动作，而 Messages 流里出现两个
// message_start 客户端必炸。所以在第一个实质内容出现之前，message_start 与首个 content_block_start
// 都扣在缓冲里没落盘——此时换号仍是零痕迹。OpenAI 通路没这个问题（它的首帧 role 是可容忍的），
// 保持原样立即写，两条通路的差异就体现在这里。
//
// ⚠️ sink 接口（writeHead / onDelta / onUsage / onFinish / onStreamError / keepAlive / comment /
//    endOk / endErr / aggregated / resetAttempt）与 protocols/openai-out.cjs 同构，
//    判据见 scripts/dev-anthropic-in-test.cjs（真实 HTTP + 打桩上游，逐事件核验）。
"use strict";
const util = require("../../proxy/util.cjs");

// finish_reason → stop_reason。OpenAI 侧的取值集合比 Anthropic 宽，认不出的一律 end_turn，
// 不能让客户端因为一个非法 stop_reason 直接判整轮失败
const STOP_REASON = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

function ev(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function errObj(message, type) {
  return { type: "error", error: { type: type || "api_error", message: String(message || "网关错误") } };
}

// HTTP 状态 → Anthropic 的 error.type。它是有限集合，客户端按它分类（Claude Code 对
// rate_limit_error 有自己的退避，对 api_error 直接报「网关挂了」）——429 报成 api_error
// 等于把限流说成故障。认不出的状态一律 api_error，这是官方文档里「其它」的那一档。
const ERROR_TYPE_BY_STATUS = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
};

/**
 * @param ctx {{
 *   res: import("node:http").ServerResponse,
 *   reqId: string,
 *   requestedModel: string,   // 客户端请求里的模型名；响应始终回显它，路由改判不外泄（契约不变）
 *   wantStream: boolean,
 *   estInputTokens: () => number, // 入站 tokens 的本地估算（调度侧惰性给，OpenAI 通路不算）
 * }}
 */
function create(ctx) {
  const { res, requestedModel, wantStream } = ctx;
  // 断连只停写、不中止上游：上游继续消费到 EOF 才能把 usage 记全
  let clientGone = false;
  res.on("close", () => { clientGone = true; });
  const write = (text) => {
    // 非流式请求由 endOk 一次性 res.json，中途绝不裸写：res.write 会在没写响应头的情况下
    // 发出 chunked 正文，之后 res.json 必抛 "headers already sent"，那个错误再被外层 catch
    // 二次抛出后就没人应答了——表现是请求永久挂住（本闸的非流式用例抓到过）。
    if (!wantStream) return;
    if (clientGone || res.writableEnded) return;
    res.write(text);
  };

  const msgId = `msg_${ctx.reqId}`;
  const deferred = [];        // message_start 起、首个实质内容前的所有帧
  let opened = false;         // message_start 是否已落盘
  let terminated = false;     // 已发过 event: error：一轮只该有一个终止事件（见 endOk）
  let blocks = new Map();     // 块下标 → {kind, id?, name?}
  let nextIndex = 0;
  let closedAll = false;
  let stopReason = "end_turn";
  let usage = null;
  let pendingTools = new Map(); // OpenAI tool_call index → {id, name, args}
  let synthToolKey = 0; // index 缺失流的当前合成桶（新工具头推进，resetAttempt 归零）
  // 非流式：同一批事件在本地攒成一条 Messages 对象
  const acc = { text: "", thinking: "", tools: [] };

  /** 响应头必须与首帧同批落地：既然首帧被扣住（deferredOpen），头就不能在 writeHead 时写，
   *  否则客户端拿到一个没有 text/event-stream 的 SSE 流（Claude Code 会按内容类型判失败）。 */
  const ensureHead = () => {
    if (res.headersSent) return;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
  };
  const flushDeferred = () => {
    if (opened) return;
    opened = true;
    if (!wantStream) { deferred.length = 0; return; }
    ensureHead();
    // 首帧要么已在 writeHead 时进了缓冲（流式），要么此刻现造；两条路都只发一次
    for (const f of deferred.length ? deferred.splice(0) : [startFrame()]) write(f);
  };
  function startFrame() {
    return ev("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          // 入站 tokens 网关算不出真值（上游才是分词方），先给本地估算：Claude Code 只拿它做上下文占用显示
          input_tokens: Number(ctx.estInputTokens()) || 0,
          output_tokens: 0,
        },
      },
    });
  }
  const push = (frame) => {
    if (opened) write(frame);
    else deferred.push(frame);
  };

  function openBlock(kind, extra) {
    const index = nextIndex++;
    const block = { kind, index, ...(extra || {}) };
    blocks.set(kind === "tool_use" ? `tool:${extra.toolkey}` : kind, block);
    const content_block = kind === "text"
      ? { type: "text", text: "" }
      : kind === "thinking"
        ? { type: "thinking", thinking: "", signature: "" }
        : { type: "tool_use", id: extra.id, name: extra.name, input: {} };
    push(ev("content_block_start", { type: "content_block_start", index, content_block }));
    return block;
  }

  /** 关闭某个已开块（thinking 结束 / text 结束 / 工具参数送完） */
  function closeBlock(block) {
    if (!block || block.done) return;
    block.done = true;
    push(ev("content_block_stop", { type: "content_block_stop", index: block.index }));
  }
  function closeKind(kind) {
    const b = blocks.get(kind);
    if (b) { closeBlock(b); blocks.delete(kind); }
  }
  function closeAll() {
    if (closedAll) return;
    closedAll = true;
    for (const key of [...blocks.keys()]) {
      const b = blocks.get(key);
      blocks.delete(key);
      closeBlock(b);
    }
  }

  /** 正文：思考块若还开着要先关（Anthropic 的块不能交错） */
  function textDelta(s) {
    if (!s) return;
    acc.text += s;
    closeKind("thinking");
    let b = blocks.get("text");
    if (!b) b = openBlock("text");
    push(ev("content_block_delta", { type: "content_block_delta", index: b.index, delta: { type: "text_delta", text: s } }));
  }
  function thinkingDelta(s) {
    if (!s) return;
    acc.thinking += s;
    let b = blocks.get("thinking");
    if (!b) b = openBlock("thinking");
    push(ev("content_block_delta", { type: "content_block_delta", index: b.index, delta: { type: "thinking_delta", thinking: s } }));
  }
  /** OpenAI 的 tool_calls 增量 → tool_use 块：首片带 id/name 才开块，arguments 增量喂 partial_json */
  function toolDelta(tcs) {
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const fn = (tc.function && typeof tc.function === "object") ? tc.function : {};
      // index 缺失（部分中转不回传）时分桶：带 id/name 的分片是新工具头，推进合成桶；
      // 纯 arguments 分片延续当前桶。|| 0 会把多个工具并进同一块拼出损坏调用
      let key;
      if (tc.index != null && Number.isFinite(Number(tc.index))) key = String(Number(tc.index));
      else {
        if (tc.id || fn.name) synthToolKey++;
        key = String(synthToolKey);
      }
      let cur = pendingTools.get(key);
      if (!cur) {
        cur = { id: String(tc.id || `toolu_${ctx.reqId}_${key}`), name: "", args: "" };
        pendingTools.set(key, cur);
      }
      if (tc.id) cur.id = String(tc.id);
      if (fn.name) cur.name += fn.name;
      const args = typeof fn.arguments === "string" ? fn.arguments : "";
      let block = blocks.get(`tool:${key}`);
      if (!block && (tc.id || fn.name)) {
        closeKind("thinking");
        closeKind("text");
        block = openBlock("tool_use", { id: cur.id, name: cur.name, toolkey: key });
        cur.block = block;
      }
      if (args && block) {
        cur.args += args;
        push(ev("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: args } }));
      }
    }
  }

  function contentBlocks() {
    const out = [];
    if (acc.thinking) out.push({ type: "thinking", thinking: acc.thinking, signature: "" });
    if (acc.text) out.push({ type: "text", text: acc.text });
    for (const t of pendingTools.values()) {
      out.push({ type: "tool_use", id: t.id, name: t.name, input: parseOrRaw(t.args) });
    }
    return out;
  }
  function parseOrRaw(s) {
    try {
      const v = JSON.parse(s || "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  return {
    protocol: "anthropic",

    writeHead() {
      // 关键：这里只准备首帧，不落盘。落盘时机交给 flushDeferred（第一个实质 delta 到达时）
      if (!wantStream) return;
      deferred.push(startFrame());
    },

    /** 一个上游 delta。返回「客户端真正可消费的实质内容有没有出现过」——调度核心用它置位
     *  ttftMs 与 sentDelta，两者都不能算进噪声帧（与 openai-out 同一条契约） */
    onDelta(d) {
      const delta = d || {};
      const substantive = util.hasConsumableDelta(delta);
      if (substantive) flushDeferred();
      if (!wantStream) {
        // 非流式也要完整走一遍同样的累积逻辑，只是不写字节：
        // 写字节的两条分支（textDelta 等）在 opened=false 时只会进 deferred，endOk 前统一丢弃
        if (delta.reasoning_content) thinkingDelta(delta.reasoning_content);
        if (delta.content) textDelta(delta.content);
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) toolDelta(delta.tool_calls);
        return substantive;
      }
      if (delta.reasoning_content) thinkingDelta(delta.reasoning_content);
      if (delta.content) textDelta(delta.content);
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) toolDelta(delta.tool_calls);
      return substantive;
    },

    onUsage(u) {
      usage = u;
    },

    onFinish(reason) {
      if (reason) stopReason = STOP_REASON[reason] || "end_turn";
      flushDeferred();
      closeAll();
    },

    /**
     * 已出线才把错误塞进流。event: error 按协议就是这一轮的终点，所以这里置 terminated：
     * 收尾交给 endOk，它见位只收流、不再补 message_delta / message_stop——补了等于给客户端
     * 一个 stop_reason=end_turn 的正常收尾，而正文其实是截断的。
     * （非流式不会走到这里：判据含 wantStream，两条通路的差异留在各自 sink 里。）
     */
    onStreamError(err, { sent }) {
      if (!(wantStream && sent)) return false;
      flushDeferred();
      terminated = true;
      write(ev("error", errObj(err.message, "api_error")));
      return true;
    },

    keepAlive() {
      if (!wantStream) return;
      // 保活前必须先让头与 message_start 落地：裸 res.write 会触发隐式发头（200、无
      // content-type，按内容类型判流的客户端直接失败），且 ping 不得先于 message_start。
      // 15s 静默本就只能走流内错误，此刻提交 200 不损失任何回错能力
      flushDeferred();
      write(ev("ping", { type: "ping" }));
    },

    /** 流内 SSE 注释帧（模型回退明示用，issue #90 的 fork 形态）：与 keepAlive 同一套
     *  「先落地头与 message_start」纪律，注释行按 SSE 规范被客户端忽略 */
    comment(text) {
      if (!wantStream) return;
      flushDeferred();
      write(`: ${text}\n\n`);
    },

    /** 成功收尾。usage 由调度侧算好（含估算兜底），这里只管成形 */
    endOk(finishReason, schedUsage) {
      // 上游一个 usage 都没发时用调度侧的估算值：它同时是落库的那个数，
      // 两边不同口径会让客户端的用量显示与统计页互相打脸（真实渠道里这类上游不少）
      if (!usage) usage = schedUsage;
      const stop = reasonToStop(finishReason);
      if (stop) stopReason = stop;
      if (!wantStream) {
        res.json({
          id: msgId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: contentBlocks(),
          stop_reason: stopReason,
          stop_sequence: null,
          usage: anthropicUsage(),
        });
        return;
      }
      // 已经发过 event: error 的轮不再补收尾：见 onStreamError 的注释
      if (terminated) { if (!res.writableEnded) res.end(); return; }
      flushDeferred();
      closeAll();
      write(ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTokens() } }));
      write(ev("message_stop", { type: "message_stop" }));
      res.end();
    },

    /**
     * 失败收尾。写头之前回 Messages 形状的错误体；已写头就只能塞进流里（客户端得拿到终止事件）。
     * type 的口径与 openai-out 不同：Anthropic 认的是 ERROR_TYPE_BY_STATUS 那套按状态码定的枚举，
     * 调度侧传来的 OpenAI 形 type/code 在这里一律不用（直接沿用会让客户端读不出错误类别）。
     */
    endErr(status, message) {
      const type = ERROR_TYPE_BY_STATUS[Number(status)] || "api_error";
      if (wantStream && res.headersSent) {
        flushDeferred();
        terminated = true;
        write(ev("error", errObj(message, type)));
        if (!res.writableEnded) res.end();
        return;
      }
      res.status(status).json(errObj(message, type));
    },

    /** 聚合器只读句柄：调度侧估算 completion_tokens 要用这里攒的正文，别另存一份真相 */
    aggregated() {
      return { content: acc.text, reasoning: acc.thinking };
    },

    /**
     * 每次真实上游请求前重置「单轮尝试独占」的输出状态。
     * 已落盘的字节撤不回来，所以调用点保证只在未出线时走到（这正是 deferredOpen 换来的能力）。
     *
     * opened / deferred / terminated 不在可撤之列：comment()（模型回退明示）与 keepAlive() 会在
     * **第一次尝试之前**就把头与 message_start 提交到线上。把 opened 复位会让下一次 flushDeferred
     * 再发一个 message_start，而同一条流里出现两个流头客户端必炸——这正是本文件开头那条
     * 「先探后写」纪律要防的事，判据见 dev-anthropic-in-test 的 ⑬。terminated 同理：
     * event: error 一旦写出就收不回来，复位它会让它之后又补出一个 message_stop。
     */
    resetAttempt() {
      blocks = new Map();
      nextIndex = 0;
      closedAll = false;
      stopReason = "end_turn";
      usage = null;
      pendingTools = new Map();
      synthToolKey = 0;
      acc.text = "";
      acc.thinking = "";
      acc.tools = [];
    },
  };

  function outTokens() {
    return Number(usage && (usage.completion_tokens || usage.output_tokens)) || 0;
  }
  function anthropicUsage() {
    return {
      input_tokens: Number(usage && (usage.prompt_tokens || usage.input_tokens)) || Number(ctx.estInputTokens()) || 0,
      output_tokens: outTokens(),
    };
  }
  function reasonToStop(r) {
    return r ? STOP_REASON[r] || null : null;
  }
}

module.exports = { create, STOP_REASON };
