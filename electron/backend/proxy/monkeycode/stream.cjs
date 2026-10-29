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
// 反代网关 · MonkeyCode 任务流：WebSocket 会话 + ACP 事件 → OpenAI delta
//
// 三个决定这条链能不能用的点：
//   1. 连上之后**先发 auto-approve 再发 user-input**，顺序固定。缺 auto-approve，任务会停在第一个
//      工具调用上等一个永远不会来的确认；缺 user-input（mode=new 下必须由客户端先发），上游不开始执行。
//   2. Agent 提问（acp_ask_user_question）必须自动回一条 reply-question（空答案 + 不取消），
//      否则任务停在提问处。提问的 data 见过 JSON 串与 base64(JSON) 两种形态，两种都认。
//   3. 四个出口（task-ended / task-error / 连接断开 / 超时）每个都必须给下游收尾：客户端的 SSE
//      解析器等的是结束帧，只断连接会被渲染成「回答被截断」。
//
// 工具调用：ACP 的 tool_call 事件不带 id，所以这里按「call_<序号>_<任务 id>」合成，客户端才能做
// tool_use / tool_result 配对；tool_call_update 的 tool_input / delta 是**增量**，按增量下发，
// 同名工具取最近一个（早先的同名调用因此不再接收更新——这是上游事件不带调用 id 的必然结果）。
//
// 出网代理：与上游客户端形态一致，只有建任务那一次 HTTP 经过代理；任务流是 WebSocket，
// 直连。配了代理时留一条排障记录，免得误以为任务流也走了出口。
"use strict";

const { WebSocket } = require("undici");

const endpoints = require("./endpoints.cjs");
const task = require("./task.cjs");

/** 任务流总时长上限：与建任务的 resource.life 同口径，别只改一边 */
const TASK_TOTAL_MS = 60 * 60 * 1000;
/** 空闲兜底下限：上游约每 10 秒推一条 ping，正常不会触达空闲判定 */
const IDLE_MIN_MS = 30000;

/** 帧数据可能是 string / ArrayBuffer / TypedArray / Blob，统一转文本（上游实际只发文本帧） */
async function frameText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.array === "function") {
    const buf = await data.array();
    return Buffer.from(buf).toString("utf8");
  }
  return "";
}

/** 文本预览：只记长度与截断片段，不落正文（隐私口径与号池其它渠道一致） */
function preview(text, limit) {
  const s = String(text || "");
  const max = limit || 120;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * ACP → OpenAI delta 的翻译状态机（纯函数集，不碰网络）。
 * 产出的是 delta 对象与需要回给上游的帧，由驱动层分别走 emit / ws.send。
 */
class Translator {
  constructor(taskId, requestedModel, includeUsage) {
    // 下发给客户端的 model 用**客户端请求的那一个**，不是上游真名：统一名/别名映射由网关侧负责
    this.chatId = `chatcmpl-${taskId}`;
    this.model = String(requestedModel || "");
    this.includeUsage = !!includeUsage;
    this.content = "";
    this.reasoning = "";
    this.tools = [];
    this.lastToolIndex = null;
    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    this.finished = false;
  }

  toolId(index) {
    const base = this.chatId.startsWith("chatcmpl-") ? this.chatId.slice("chatcmpl-".length) : this.chatId;
    return `call_${index}_${base}`;
  }

  /** agent_message_chunk / agent_thought_chunk：text 优先、content 兜底 */
  chunkText(acp) {
    const first = typeof acp.text === "string" ? acp.text : "";
    if (first) return first;
    return typeof acp.content === "string" ? acp.content : "";
  }

  /** tool_input 是对象时按 JSON 串下发（上游给过对象形态，客户端要的是字符串参数） */
  static fieldText(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  pushToolCall(acp) {
    const name = (String(acp.tool_name || "").trim() || "unknown");
    const args = Translator.fieldText(acp.tool_input);
    const index = this.tools.length;
    this.tools.push({ index, id: this.toolId(index), name, arguments: args });
    this.lastToolIndex = index;
    return { tool_calls: [{ index, id: this.tools[index].id, type: "function", function: { name, arguments: args } }] };
  }

  appendToolArguments(acp) {
    const delta = Translator.fieldText(acp.tool_input) || Translator.fieldText(acp.delta);
    if (!delta) return null;
    const name = String(acp.tool_name || "").trim();
    let target = null;
    if (!name) target = this.lastToolIndex;
    else {
      for (let i = this.tools.length - 1; i >= 0; i -= 1) {
        if (this.tools[i].name === name) {
          target = i;
          break;
        }
      }
    }
    if (target === null || target === undefined || !this.tools[target]) return null;
    this.tools[target].arguments += delta;
    this.lastToolIndex = target;
    return { tool_calls: [{ index: target, function: { arguments: delta } }] };
  }

  /** usage_update 是**累计值**不是增量：非零才覆盖，0 视为「这一项上游没说话」 */
  mergeUsage(acp) {
    const read = (key) => {
      const v = acp[key];
      return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
    };
    const input = read("input_tokens");
    const output = read("output_tokens");
    const total = read("total_tokens");
    if (input) this.usage.prompt_tokens = input;
    if (output) this.usage.completion_tokens = output;
    if (total) this.usage.total_tokens = total;
  }

  usageSeen() {
    return this.usage.prompt_tokens || this.usage.completion_tokens || this.usage.total_tokens;
  }

  summary() {
    return `正文 ${this.content.length} 字、思考 ${this.reasoning.length} 字、工具 ${this.tools.length} 个`;
  }

  /** 一条已解析的 ACP 事件 → { deltas: [], reply: null|object, note: '' } */
  handleAcp(acp) {
    const type = String((acp && acp.type) || "");
    const out = { deltas: [], reply: null };
    if (type === "agent_message_chunk") {
      const text = this.chunkText(acp);
      if (text) {
        this.content += text;
        out.deltas.push({ content: text });
      }
      return out;
    }
    if (type === "agent_thought_chunk") {
      const text = this.chunkText(acp);
      if (text) {
        this.reasoning += text;
        out.deltas.push({ reasoning_content: text });
      }
      return out;
    }
    if (type === "tool_call") {
      out.deltas.push(this.pushToolCall(acp));
      return out;
    }
    if (type === "tool_call_update") {
      const delta = this.appendToolArguments(acp);
      if (delta) out.deltas.push(delta);
      return out;
    }
    if (type === "usage_update") {
      this.mergeUsage(acp);
      return out;
    }
    // plan / available_commands_update / 未知事件：只记录，不造帧
    return out;
  }

  /** task-ended 的收尾数据里可能再带一次用量，合并后再报 */
  mergeFinalUsage(data) {
    if (data && typeof data === "object") this.mergeUsage(data);
  }
}

/** 提问 data 的三种形态：JSON 串 / base64(JSON) / 已是对象 */
function parseQuestion(data) {
  if (data && typeof data === "object") return data;
  const raw = String(data || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* 再试 base64 */
  }
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function questionReply(data) {
  const parsed = parseQuestion(data);
  if (!parsed) return null;
  const requestId = String(parsed.request_id || parsed.id || "");
  return {
    type: "reply-question",
    data: JSON.stringify({ request_id: requestId, answers_json: "", cancelled: false }),
  };
}

/** task-error 的人话原因：字符串直接用，对象按 error/message/msg 取，都没有给默认文案 */
function errorDetail(data) {
  const fallback = "任务执行出错（上游未给原因）";
  if (typeof data === "string") return data.trim() || fallback;
  if (data && typeof data === "object") {
    for (const key of ["error", "message", "msg"]) {
      const value = typeof data[key] === "string" ? data[key].trim() : "";
      if (value) return value;
    }
  }
  return fallback;
}

/**
 * 驱动一次任务流。
 * @returns {Promise<Translator>} 正常结束；任何失败都 reject（错误带 status）
 */
function runTaskStream(opts) {
  const { region, section, deps, session, taskId, prompt, requestedModel, includeUsage, emit, signal } = opts;
  const translator = new Translator(taskId, requestedModel, includeUsage);

  return new Promise((resolve, reject) => {
    const url = endpoints.taskStreamUrl(region, section, taskId, "new");
    const headers = endpoints.wsHeaders(region, session, section);
    const idleMs = Math.max(IDLE_MIN_MS, Number(deps.streamIdleMs || 0) || 300000);

    let ws = null;
    let settled = false;
    let sentAny = false;
    let idleTimer = null;
    let handshakeTimer = null;
    let totalTimer = null;
    let opened = false;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = handshakeTimer = totalTimer = null;
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      } catch {
        /* 关闭失败不影响定性 */
      }
    };
    // 每个出口都要走到 settle 一次：重复 settle 直接忽略
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const fail = (message, status, code) => {
      const error = Object.assign(new Error(`MonkeyCode ${message}`), { status: status || 502, code: code || null });
      deps.verbose && deps.verbose(`❌ ${error.message}（${translator.summary()}）`);
      // 还没给客户端下发任何字节 → 抛错（编排层可换号 / 落真实状态码）；已经下发 → 只能进流内
      if (!sentAny) settle(() => reject(error));
      else
        settle(() => {
          emit({ type: "error", status: error.status, code: error.code, message: error.message });
          emit({ type: "finish", reason: "stop" });
          resolve(translator);
        });
    };
    const succeed = () => {
      deps.verbose && deps.verbose(`任务 ${taskId} 正常结束（${translator.summary()}）`);
      if (translator.usageSeen()) emit({ type: "usage", usage: { ...translator.usage } });
      emit({ type: "finish", reason: "stop" });
      settle(() => resolve(translator));
    };

    const sendFrame = (payload, what) => {
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (e) {
        fail(`任务流发送 ${what} 失败：${e.message}`, 502);
        return false;
      }
    };
    // 空闲判定只管"多久没有下行"，总时长由 totalTimer 独立管：两条各自到点、各自定性，
    // 把总时长夹进空闲预算里会让"还剩 2 秒到 1 小时上限"被误报成空闲超时（定性错了用户就去查错方向）。
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(`任务流空闲超时（${Math.round(idleMs / 1000)} 秒没有任何下行消息）`, 504, "stream_idle"), idleMs);
    };
    const onAbort = () => fail("客户端已断开，任务流转发停止", 499, "cancelled");

    try {
      ws = new WebSocket(url, { headers });
    } catch (e) {
      settle(() => reject(Object.assign(new Error(`MonkeyCode 任务流地址无效或握手失败：${e.message}`), { status: 502 })));
      return;
    }
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* 不支持就不转，frameText 仍会兜住 Blob 形态 */
    }

    if (signal) {
      if (signal.aborted) {
        settle(() => reject(Object.assign(new Error("MonkeyCode 客户端已断开，任务流未启动"), { status: 499 })));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    totalTimer = setTimeout(() => fail("任务流超过 1 小时上限（与上游资源时长对齐）", 504, "task_timeout"), TASK_TOTAL_MS);
    // 握手兜底：空闲计时是在 open 之后才开始的，握手卡住时必须有独立的口子，
    // 否则这条请求会一直挂到外层超时，报错归属也说不清是上游不通还是账号不通
    handshakeTimer = setTimeout(
      () => fail("任务流握手超时（WebSocket 连接未建立）", 504, "handshake_timeout"),
      Number(endpoints.WS_CONNECT_TIMEOUT_MS) || 30000,
    );

    ws.addEventListener("open", () => {
      if (settled) return;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      opened = true;
      deps.verbose && deps.verbose(`任务流已连接 task=${taskId}（mode=new）`);
      if (!sendFrame({ type: "auto-approve" }, "auto-approve")) return;
      if (!sendFrame({ type: "user-input", data: task.userInputData(prompt) }, "user-input")) return;
      armIdle();
    });

    ws.addEventListener("message", (event) => {
      if (settled) return;
      armIdle();
      Promise.resolve()
        .then(async () => {
          const text = await frameText(event && event.data);
          let payload = null;
          try {
            payload = JSON.parse(text);
          } catch {
            deps.verbose && deps.verbose("忽略任务流里的非 JSON 消息");
            return;
          }
          const type = String((payload && payload.type) || "");
          if (type === "ping") {
            // 心跳是「回一条同 type」，不主动发起；上游约 10 秒推一次
            sendFrame({ type: "ping" }, "ping");
            return;
          }
          if (type === "task-started") {
            deps.verbose && deps.verbose("任务轮次开始（task-started）");
            return;
          }
          if (type === "task-ended") {
            translator.mergeFinalUsage(payload.data);
            succeed();
            return;
          }
          if (type === "task-error") {
            fail(errorDetail(payload.data), 502, "task_error");
            return;
          }
          if (type !== "task-running") {
            deps.verbose && deps.verbose(`忽略任务流消息类型：${type || "(空)"}`);
            return;
          }
          const kind = String((payload && payload.kind) || "");
          if (kind === "acp_ask_user_question") {
            const reply = questionReply(payload.data);
            if (!reply) {
              deps.verbose && deps.verbose("Agent 提问无法解析，未自动回复（任务可能停在提问处）");
              return;
            }
            sendFrame(reply, "reply-question");
            return;
          }
          if (kind !== "acp_event") {
            deps.verbose && deps.verbose(`忽略 task-running kind=${kind || "(空)"}`);
            return;
          }
          // acp_event 的 data 是**字符串化的 JSON**（双层编码），不是对象
          let acp = null;
          if (typeof payload.data === "string") {
            try {
              acp = JSON.parse(payload.data);
            } catch {
              deps.verbose && deps.verbose("acp_event 的 data 不是 JSON");
              return;
            }
          } else if (payload.data && typeof payload.data === "object") {
            acp = payload.data;
          } else {
            deps.verbose && deps.verbose("acp_event 缺少 data 字符串");
            return;
          }
          const handled = translator.handleAcp(acp);
          for (const delta of handled.deltas) {
            sentAny = true;
            emit({ type: "delta", delta });
          }
          const acpType = String((acp && acp.type) || "");
          if (acpType === "tool_call") deps.verbose && deps.verbose(`工具调用 ${acp.tool_name || "unknown"}（${preview(translator.tools[translator.tools.length - 1] && translator.tools[translator.tools.length - 1].arguments)}）`);
          else if (acpType === "plan" || acpType === "available_commands_update") deps.verbose && deps.verbose(`收到 ${acpType} 事件（仅记录）`);
          else if (acpType && !["agent_message_chunk", "agent_thought_chunk", "tool_call_update", "usage_update"].includes(acpType)) {
            deps.verbose && deps.verbose(`忽略 ACP 事件：${acpType}`);
          }
        })
        .catch((e) => fail(`任务流消息处理中断：${e.message}`, 502));
    });

    ws.addEventListener("error", (event) => {
      if (opened) fail(`任务流传输中断：${(event && event.message) || "未知错误"}`, 502);
      else fail(`任务流连接失败：${(event && event.message) || "WebSocket 握手未完成"}`, 502);
    });

    ws.addEventListener("close", () => {
      if (settled) return;
      // 没收到 task-ended 的连接关闭按异常收尾：客户端拿不到结束帧会一直挂着
      fail("任务流连接已关闭（未收到 task-ended）", 502, "closed");
    });
  });
}

module.exports = { runTaskStream, Translator, parseQuestion, questionReply, errorDetail, TASK_TOTAL_MS, IDLE_MIN_MS };
