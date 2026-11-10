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
// 反代网关 · 出线侧：OpenAI Responses（Codex CLI 看到的字节）
//
// 与 anthropic-out 同构：输入是调度核心交出来的四种事件（delta / usage / finish / error），
// 输出是 Responses 的事件流。item 边界同样由这里从 OpenAI 形态的 delta 推导：
//   reasoning_content → reasoning item；首个非空 content → message item；
//   tool_calls[i] 首现 → function_call item；收尾时按开项顺序逐项关闭。
//
// 三条来自 Codex 解析器的硬约束（改这里之前先核对，都在闸里有对应断言）：
//   1. EOF 之前必须出现 response.completed，否则 Codex 报 "stream closed before response.completed"；
//      response.incomplete 会被它当**失败**处理，所以 max_tokens 截断也发 completed，
//      截断信息放在 incomplete_details 里而不是靠 status 表达。
//   2. reasoning item 的 JSON 里 encrypted_content 这个 key 必须存在（值可为 null）——
//      它是 Option<String> 但没有 serde(default)，缺 key 会让整个 item 解析失败并被静默丢弃。
//   3. function_call item 的 name / arguments / call_id 三个 key 必需，且 call_id 要与入站保真。
//
// 与 Anthropic 通路一样必须 deferredOpen：换号重发时出现第二个 response.created，客户端必炸。
"use strict";
const util = require("../../proxy/util.cjs");

function ev(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function errorEnvelope(message, type, code) {
  return { error: { message: String(message || "网关错误"), type: type || "api_error", param: null, code: code || null } };
}

/**
 * @param ctx {{
 *   res: import("node:http").ServerResponse,
 *   reqId: string,
 *   requestedModel: string,
 *   wantStream: boolean,
 *   estInputTokens: () => number, // 入站 tokens 的本地估算（调度侧惰性给，OpenAI 通路不算）
 * }}
 */
function create(ctx) {
  const { res, reqId, requestedModel, wantStream } = ctx;
  // 断连只停写、不中止上游：上游继续消费到 EOF 才能把 usage 记全
  let clientGone = false;
  res.on("close", () => { clientGone = true; });
  const write = (text) => {
    // 非流式由 endOk 一次性 res.json：中途裸写会先发出 chunked 正文，之后 res.json 必抛
    // "headers already sent"（anthropic-out 就是被这条坑过的）
    if (!wantStream) return;
    if (clientGone || res.writableEnded) return;
    res.write(text);
  };

  const respId = `resp_${reqId}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const deferred = [];        // response.created 起、首个实质内容之前的所有帧
  let opened = false;         // response.created 是否已落盘
  let terminated = false;     // 已发过 response.failed / completed：终止事件只能有一个（见 endOk）
  let seq = 0;                // 帧号：已写出的帧号不可回收（见 resetAttempt 注释）
  let usage = null;
  let finishReason = "";
  let lastError = "";
  const items = [];           // 按开项顺序排列，output_index 即下标
  let textItem = null;
  let thinkItem = null;
  const toolOf = new Map();   // OpenAI tool_call index → function_call item
  let synthToolKey = 0;       // index 缺失流的当前合成桶（新工具头推进，resetAttempt 归零）
  const acc = { text: "", thinking: "" };

  /** 发一帧：未开流时进缓冲（deferredOpen），已开流时直接落盘 */
  const frame = (type, extra) => {
    const text = ev(type, Object.assign({ type, sequence_number: seq++ }, extra || {}));
    if (opened) write(text);
    else deferred.push(text);
  };

  function createdResponse() {
    return {
      id: respId, object: "response", created_at: createdAt, status: "in_progress",
      error: null, incomplete_details: null, model: requestedModel, output: [], usage: null,
    };
  }
  /** 响应头与首帧同批落地：首帧被扣住时头也不能提前写，否则客户端拿到一个没声明 SSE 内容类型的流 */
  function ensureHead() {
    if (res.headersSent) return;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
  }
  function flushDeferred() {
    if (opened) return;
    opened = true;
    if (!wantStream) { deferred.length = 0; return; }
    ensureHead();
    const first = deferred.length ? deferred.splice(0) : [ev("response.created", { type: "response.created", response: createdResponse(), sequence_number: seq++ })];
    for (const f of first) write(f);
  }

  function mkItem(kind, extra) {
    const item = {
      kind,
      id: `${kind === "message" ? "msg" : kind === "reasoning" ? "rs" : "fc"}_${reqId}_${items.length}`,
      index: -1,
      text: "",
      args: "",
      call_id: "",
      name: "",
      opened: false,
      done: false,
      addedShape() {
        if (this.kind === "message") return { type: "message", id: this.id, status: "in_progress", role: "assistant", content: [] };
        // encrypted_content 这个 key 必须在（文件头硬约束 2）
        if (this.kind === "reasoning") return { type: "reasoning", id: this.id, summary: [], encrypted_content: null };
        return { type: "function_call", id: this.id, call_id: this.call_id, name: this.name, arguments: "", status: "in_progress" };
      },
      doneShape() {
        if (this.kind === "message") return { type: "message", id: this.id, status: "completed", role: "assistant", content: [{ type: "output_text", text: this.text, annotations: [] }] };
        if (this.kind === "reasoning") return { type: "reasoning", id: this.id, summary: this.text ? [{ type: "summary_text", text: this.text }] : [], encrypted_content: null };
        return { type: "function_call", id: this.id, call_id: this.call_id, name: this.name, arguments: this.args, status: "completed" };
      },
    };
    return Object.assign(item, extra || {});
  }

  function openItem(item) {
    item.index = items.length;
    item.opened = true;
    items.push(item);
    frame("response.output_item.added", { output_index: item.index, item: item.addedShape() });
    if (item.kind === "message") {
      frame("response.content_part.added", { item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    } else if (item.kind === "reasoning") {
      frame("response.reasoning_summary_part.added", { item_id: item.id, output_index: item.index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    return item;
  }

  /** 关一个 item：先把该协议的 *.done 事件补齐，再发 output_item.done（item 必须是完整可反序列化对象） */
  function closeItem(item) {
    if (!item || item.done) return;
    item.done = true;
    if (item.kind === "message") {
      frame("response.output_text.done", { item_id: item.id, output_index: item.index, content_index: 0, text: item.text });
      frame("response.content_part.done", { item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } });
    } else if (item.kind === "reasoning") {
      frame("response.reasoning_summary_text.done", { item_id: item.id, output_index: item.index, summary_index: 0, text: item.text });
      frame("response.reasoning_summary_part.done", { item_id: item.id, output_index: item.index, summary_index: 0, part: { type: "summary_text", text: item.text } });
    } else {
      frame("response.function_call_arguments.done", { item_id: item.id, output_index: item.index, name: item.name, arguments: item.args });
    }
    frame("response.output_item.done", { output_index: item.index, item: item.doneShape() });
  }
  function closeAll() {
    for (const it of items) closeItem(it);
  }
  /** 新 item 开出来之前关掉当前还开着的（Responses 的 item 不交错） */
  function closeCurrent() {
    if (thinkItem) { closeItem(thinkItem); thinkItem = null; }
    if (textItem) { closeItem(textItem); textItem = null; }
  }

  function textDelta(s) {
    if (!s) return;
    acc.text += s;
    if (thinkItem) { closeItem(thinkItem); thinkItem = null; } // 正文开始后思考不再回投（item 已关）
    if (!textItem) textItem = openItem(mkItem("message"));
    textItem.text += s;
    frame("response.output_text.delta", { item_id: textItem.id, output_index: textItem.index, content_index: 0, delta: s, logprobs: [] });
  }
  function thinkingDelta(s) {
    if (!s) return;
    acc.thinking += s;
    if (!thinkItem) thinkItem = openItem(mkItem("reasoning"));
    thinkItem.text += s;
    frame("response.reasoning_summary_text.delta", { item_id: thinkItem.id, output_index: thinkItem.index, summary_index: 0, delta: s });
  }
  function toolDelta(tcs) {
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const fn = (tc.function && typeof tc.function === "object") ? tc.function : {};
      // index 缺失（部分中转不回传）时分桶：带 id/name 的分片是新工具头，推进合成桶；
      // 纯 arguments 分片延续当前桶。|| 0 会把多个工具并进同一项拼出损坏调用
      let key;
      if (tc.index != null && Number.isFinite(Number(tc.index))) key = String(Number(tc.index));
      else {
        if (tc.id || fn.name) synthToolKey++;
        key = String(synthToolKey);
      }
      let it = toolOf.get(key);
      if (!it) {
        it = mkItem("function_call");
        toolOf.set(key, it);
      }
      if (tc.id) it.call_id = String(tc.id);
      if (fn.name) it.name += fn.name;
      const args = typeof fn.arguments === "string" ? fn.arguments : "";
      // 只有拿到 id 或 name 才开项：上游偶发的空壳 tool_calls 分片不该变成一个无名工具
      if (!it.opened && (tc.id || it.name)) {
        closeCurrent();
        openItem(it);
      }
      if (args && it.opened) {
        it.args += args;
        frame("response.function_call_arguments.delta", { item_id: it.id, output_index: it.index, delta: args });
      }
    }
  }

  function usageObj() {
    const u = usage || {};
    const inp = Number(u.prompt_tokens || u.input_tokens) || Number(ctx.estInputTokens()) || 0;
    const outp = Number(u.completion_tokens || u.output_tokens) || 0;
    return { input_tokens: inp, output_tokens: outp, total_tokens: Number(u.total_tokens) || inp + outp };
  }
  /** status 只有 completed / failed 两种：见文件头硬约束 1 */
  function responsePayload(status) {
    return {
      id: respId,
      object: "response",
      created_at: createdAt,
      status,
      model: requestedModel,
      output: items.map((it) => it.doneShape()),
      output_text: acc.text,
      usage: usageObj(),
      error: status === "failed" ? { message: lastError, type: "api_error", param: null, code: null } : null,
      incomplete_details: status === "completed" && finishReason === "length" ? { reason: "max_output_tokens" } : null,
    };
  }

  return {
    protocol: "responses",

    writeHead() {
      if (!wantStream) return;
      deferred.push(ev("response.created", { type: "response.created", response: createdResponse(), sequence_number: seq++ }));
    },

    /** 一个上游 delta。返回「客户端真能消费的实质内容有没有出现过」——调度侧据此置 ttft/sent 位 */
    onDelta(d) {
      const delta = d || {};
      const substantive = util.hasConsumableDelta(delta);
      if (substantive) flushDeferred();
      if (delta.reasoning_content) thinkingDelta(delta.reasoning_content);
      if (delta.content) textDelta(delta.content);
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) toolDelta(delta.tool_calls);
      return substantive;
    },

    onUsage(u) {
      usage = u;
    },

    onFinish(reason) {
      if (reason) finishReason = reason;
    },

    /** 流中出现 error：已出线才下发（一条都没出时返回 false，交给调度换号） */
    onStreamError(err, { sent }) {
      if (!(wantStream && sent)) return false;
      lastError = String((err && err.message) || "上游错误");
      flushDeferred();
      closeAll();
      terminated = true;
      write(ev("response.failed", { type: "response.failed", response: responsePayload("failed"), sequence_number: seq++ }));
      return true;
    },

    keepAlive() {
      // 用 SSE 注释行而不是编造一个 "*.delta" 事件：Codex 只读 data 里的 type，注释行按 SSE 规范
      // 被忽略，既能重置它的 stream_idle_timeout_ms，又不污染事件流。
      // 但写之前必须先 flush：裸 res.write 会触发隐式发头（200、无 content-type），
      // response.created 还扣在 deferred 里时客户端收到的流没有协议头
      if (wantStream) {
        flushDeferred();
        write(": keep-alive\n\n");
      }
    },

    /** 流内 SSE 注释帧（模型回退明示用，issue #90 的 fork 形态）：与 keepAlive 同样先
     *  flushDeferred，客户端只读 data 里的 type，注释行按 SSE 规范被忽略 */
    comment(text) {
      if (!wantStream) return;
      flushDeferred();
      write(`: ${text}\n\n`);
    },

    /** 成功收尾。usage 用调度侧算好的那份（含估算兜底）。
     *  finishReason 形参**刻意不用**：incomplete_details 的判据必须是「本轮上游自己说的
     *  reason」，而调度侧那份是跨尝试累计的（默认 stop），上游没发 finish 事件时它是 stop 而不是
     *  「真的收了个 stop」——把它写进来会让截断判据依赖一个客户端没给过的事实。 */
    endOk(ignoredReason, schedUsage) {
      if (!usage) usage = schedUsage;
      // 已经发过 response.failed 的轮不再补 completed：Responses 的 status 是明写的，
      // failed 之后紧跟一个 completed 等于告诉客户端「这轮成功了」，而正文其实是截断的。
      // （OpenAI 通路没这个矛盾——它注入错误对象后照常 [DONE]，那里没有带 status 的终止帧）
      if (terminated) { if (!res.writableEnded) res.end(); return; }
      flushDeferred();
      closeAll();
      if (!wantStream) {
        res.json(responsePayload("completed"));
        return;
      }
      terminated = true;
      write(ev("response.completed", { type: "response.completed", response: responsePayload("completed"), sequence_number: seq++ }));
      res.end();
    },

    /**
     * 失败收尾。已写头时把失败做成一个 response.failed 帧（Codex 要看到一个终止事件才收流），
     * 没写头时回标准错误外壳。status 一律不是 completed，硬约束 1 说的就是这个分支。
     */
    endErr(status, message, type, code) {
      lastError = String(message || "网关错误");
      if (wantStream && res.headersSent) {
        flushDeferred();
        closeAll();
        terminated = true;
        write(ev("response.failed", { type: "response.failed", response: responsePayload("failed"), sequence_number: seq++ }));
        if (!res.writableEnded) res.end();
        return;
      }
      res.status(status).json(errorEnvelope(message, type, code));
    },

    /** 调度侧要 completion_tokens 的估算口径 */
    aggregated() {
      return { content: acc.text, reasoning: acc.thinking };
    },

    /**
     * 每次真实上游请求前重置「单轮尝试独占」的输出状态。
     *
     * opened / deferred / seq / terminated 不在可撤之列：comment()（模型回退明示）与
     * keepAlive() 会在**第一次尝试之前**就把头与 response.created 提交到线上，而已写出的字节、
     * 已经发出去的帧号与已经落定的终止事件都收不回来。把 opened 复位会让第二次 flush 再发一个
     * response.created（客户端必炸）；只复位 seq 更糟——缓冲里那帧的 0 号已经写死，重号会让按
     * sequence_number 排序的客户端错序。判据见 dev-responses-in-test 的 ⑧ 与 ⑬。
     */
    resetAttempt() {
      usage = null;
      finishReason = "";
      lastError = "";
      items.length = 0;
      textItem = null;
      thinkItem = null;
      toolOf.clear();
      synthToolKey = 0;
      acc.text = "";
      acc.thinking = "";
    },
  };
}

module.exports = { create };
