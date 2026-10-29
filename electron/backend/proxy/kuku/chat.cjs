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
// 反代网关 · KukuAI 对话转发：换会话 → 建会话 → 分配算力 → SSE 流式
//
// 上游不是 OpenAI 协议，一条客户端请求要拆成四跳上游请求，因此本渠道把整条链装在一次 chat() 里完成
// （号池与本地网关的转发入口都是 chat()，见 adapters.cjs 契约块）。
//
// 三条必须照做的协议事实：
//   1. 分配算力那一跳挂在 `/wenchain/genflow/`（不是 genflowpro）下；建会话与 SSE 挂在
//      `/wenchain/genflowpro/` 下。写错前缀是 404，不是业务失败。
//   2. `show_text` 与 `client_added` 是**字符串字段**，内容才是 JSON——上游按客户端形态校验这两段，
//      直接给对象会被判参数错误。三件套（bdstoken/uinfo/uk）在 query 与 client_added 里**都要带真值**。
//   3. 上游没有多轮接续接口：每次请求新建会话，多轮历史拍平成单条 prompt。拍平口径见 buildPrompt。
//
// 会话与算力那两跳是浏览器会调但对话不依赖的，失败只记日志继续（容错），不让一次副请求拖垮对话。
// 工具调用不做：上游的工具体系是「注入式文本协议」，并且有产品级的人格保护（陌生工具会被拒），
// 半成品注入的表现是莫名其妙的空回复，比明确不支持更难排查——所以这里文本直通，如实标注能力。
"use strict";

const crypto = require("node:crypto");

const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");
const models = require("./models.cjs");
const session = require("./session.cjs");

const FALLBACK_PROMPT = "你好";

/** 把一条消息取成可读文本：content 是字符串直接用；是数组时只收带 text 的部件（忽略 type）。
 *  content 为 null / 对象 / 缺失 → null（该消息在拍平时被丢弃，工具轮的历史因此不会污染 prompt）。 */
function contentText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (part && typeof part.text === "string") texts.push(part.text);
    }
    return texts.length ? texts.join("\n") : null;
  }
  return null;
}

/**
 * OpenAI messages → 单条 prompt（上游无多轮接续接口）。
 * 口径细节都是实测出来的，别"顺手优化"：
 *   · 只有一条消息时**不加角色前缀**（system 也原样发出去）——多条时才启用标注；
 *   · 空数组 / 缺 messages / 全部为空白 → 兜底串「你好」（上游不接受空 prompt）；
 *   · 判空白用 trim、落库用原串：trim 只是筛掉纯空格的消息，不裁剪内容；
 *   · 段间连接符是空行，角色标签是「[系统指令] 」「[助手之前的回复] 」，各带一个半角空格。
 */
function buildPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) return FALLBACK_PROMPT;
  if (messages.length === 1) return contentText(messages[0]) ?? FALLBACK_PROMPT;
  const lines = [];
  for (const message of messages) {
    const role = String((message && message.role) || "user");
    const text = contentText(message);
    if (text === null) continue;
    if (!text.trim()) continue;
    if (role === "system") lines.push(`[系统指令] ${text}`);
    else if (role === "assistant") lines.push(`[助手之前的回复] ${text}`);
    else lines.push(text);
  }
  return lines.length ? lines.join("\n\n") : FALLBACK_PROMPT;
}

/** 请求体里的 show_text 段：先建成对象再序列化成字符串（它本身就是个字符串字段） */
function showTextOf(model, prompt) {
  return JSON.stringify({
    skills: [],
    experts: [],
    model_name: model,
    model_display_name: model,
    think_mode: endpoints.DEFAULT_THINK_MODE,
    richInputContent: [{ type: "text", "text": prompt }],
    fileInfo: [],
  });
}

/** sendmsg 与 getchatcontent 共用的 data 段（prompt 在四处重复出现，是上游客户端的真实形态） */
function messageData(model, prompt) {
  return {
    project_type: 1,
    text: prompt,
    rich_input_params: [{ id: "textId", version: "1.0", type: "text", text: prompt, data: { content: prompt } }],
    fsid: [],
    quotes: [],
    skills: [],
    experts: [],
    model_name: model,
    model_display_name: model,
    think_mode: endpoints.DEFAULT_THINK_MODE,
    show_text: showTextOf(model, prompt),
    premake_data: {},
    custom_instructions: "",
    memory_sign: true,
    skill_dig_sign: true,
  };
}

/** 建会话（sendmsg）→ { session_id, reply_id } */
async function createSession(deps, cred, triple, prompt, model) {
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.sendMsg}?${endpoints.WEB_QUERY}${session.tokenQuery(triple)}`;
  const clientSessionId = deps.uuid();
  const body = {
    type: "message",
    sub_type: "chat_create",
    client_session_id: clientSessionId,
    session_id: "",
    // 顶层 uk 恒空是客户端形态的一部分（真值在 client_added 里），"顺手"填上反而会不一致
    uk: "",
    cid: 0,
    channel: endpoints.SESSION_CHANNEL,
    device_type: endpoints.CLIENT_TYPE,
    created_at: Date.now(),
    msg_type: 1,
    sync_type: 0,
    sync_id: "",
    v: crypto.randomBytes(12).toString("hex"),
    data: {
      ...messageData(model, prompt),
      client_added: JSON.stringify({
        client_session_id: clientSessionId,
        permission_type: 0,
        clienttype: endpoints.CLIENT_TYPE,
        app_id: endpoints.APP_ID,
        web: 1,
        channel: endpoints.CHANNEL,
        version: endpoints.CLIENT_VERSION,
        bdstoken: triple.bdstoken,
        uinfo: triple.uinfo,
        uk: triple.uk,
      }),
    },
  };
  const r = await deps.httpJson(url, {
    method: "POST",
    headers: { ...credentials.requestHeaders(cred, "application/json, text/plain, */*"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r || !r.ok) throw sessionHttpFailure(r, url);
  const payload = r.data;
  const status = (payload && payload.status) || {};
  if (Number(status.code) !== 0) {
    throw Object.assign(
      new Error(`KukuAI 建会话失败（status.code=${status.code ?? "缺失"}：${String(status.msg || "未知错误")}）`),
      { status: Number(status.code) === 401 || Number(status.code) === 403 ? 401 : 502 },
    );
  }
  const info = (payload && payload.data) || {};
  const sessionId = String(info.session_id || "");
  if (!sessionId) {
    throw Object.assign(new Error("KukuAI 建会话返回缺少 session_id（上游响应异常）"), { status: 502 });
  }
  return { sessionId, replyId: String(info.reply_id || "") };
}

/** 分配算力（容错：失败不阻断对话） */
async function allocate(deps, cred) {
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.allocate}?${endpoints.WEB_QUERY}`;
  const r = await deps.httpJson(url, {
    method: "POST",
    headers: { ...credentials.requestHeaders(cred, "application/json, text/plain, */*"), "Content-Type": "application/json" },
    body: JSON.stringify({ channel: endpoints.SESSION_CHANNEL, gen_type: 2 }),
  });
  if (!r || !r.ok) deps.verbose && deps.verbose(`[Kuku] 分配算力失败（容错）：HTTP ${r && r.status}`);
}

/** 切会话（浏览器会调，同样容错） */
async function switchSession(deps, cred, sessionId) {
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.sessionSwitch}?${endpoints.WEB_QUERY}`;
  const r = await deps.httpJson(url, {
    method: "POST",
    headers: { ...credentials.requestHeaders(cred, "application/json, text/plain, */*"), "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, op: 1, full_access_enabled: 0 }),
  });
  if (!r || !r.ok) deps.verbose && deps.verbose(`[Kuku] 切会话失败（容错）：HTTP ${r && r.status}`);
}

function sessionHttpFailure(r, url) {
  const status = Number(r && r.status) || 502;
  if (status === 401 || status === 403) {
    return Object.assign(
      new Error(`KukuAI 登录态已失效，请重新登录该账号或重新粘贴完整 Cookie（HTTP ${status}，${url}）`),
      { status: 401 },
    );
  }
  return Object.assign(new Error(`KukuAI 返回 HTTP ${status}（${url}）`), { status });
}

/** 一条上游 SSE data 帧 → 事件（认不得的 type 一律忽略，与上游客户端的行为一致） */
function eventFromFrame(payload) {
  const type = String((payload && payload.type) || "");
  const data = (payload && payload.data) || {};
  if (type === "TEXT_BLOCK_DELTA") {
    const delta = typeof data.delta === "string" ? data.delta : "";
    return delta ? { kind: "delta", text: delta } : null;
  }
  if (type === "REPLY_END" || type === "DIALOGUE_END") return { kind: "done" };
  if (type === "ERROR") return { kind: "error", message: String(data.message || "上游错误") };
  return null;
}

/**
 * 对话主流程。ctx = { account, secrets, model, body, emit, meta }（契约见 adapters.cjs）。
 * 约定：**没下发任何字节前抛错**（编排层据此换号 / 落真实状态码），**下发之后只走 emit**。
 */
async function runChat(ctx) {
  const deps = ctx.deps;
  const cred = ctx.credential;
  const body = ctx.body || {};
  const emit = typeof ctx.emit === "function" ? ctx.emit : () => {};
  // ctx.model 才是"要转发给上游的那一个"（网关已按目录/别名/反向映射解过），body.model 是客户端请求名。
  // 优先用 ctx.model：统一虚拟名（如 AgentHub-1.0）拿去做 resolveModel 会被判"未知名"而静默回退 auto，
  // 表现就是"选了 A、实际用的是 auto"。
  const requestedModel = String(ctx.model || body.model || "").trim();
  const model = models.resolveModel(requestedModel);
  const prompt = buildPrompt(body.messages);

  const triple = await session.ensureTriple(cred, deps, false);
  const created = await createSession(deps, cred, triple, prompt, model);
  await allocate(deps, cred).catch(() => {});
  await switchSession(deps, cred, created.sessionId).catch(() => {});

  const query = `${endpoints.WEB_QUERY}${session.tokenQuery(triple)}`;
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.chatStream}?${query}`;
  const payload = { ...messageData(model, prompt), session_id: created.sessionId, reply_id: created.replyId };
  const bodyText = JSON.stringify(payload);

  const { resp, cancelTimer } = await deps.fetchStream(url, {
    method: "POST",
    headers: {
      ...credentials.requestHeaders(cred, "text/event-stream"),
      "Content-Type": "application/json",
    },
    body: bodyText,
    firstByteMs: deps.firstByteBudgetMs(bodyText),
    // 本渠道的会话材料就在 Cookie 里，重定向会把它们带给另一个域
    redirect: "error",
  });

  let settled = false;
  let sawEnd = false;
  let sawContent = false;
  try {
    await deps.pumpSse(resp, (_event, raw) => {
      if (!settled) {
        settled = true;
        cancelTimer();
      }
      if (sawEnd || !raw || raw === "[DONE]") return;
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch {
        return; // 非 JSON 的 data 帧：上游不会发，发了也不该把对话判死
      }
      const event = eventFromFrame(frame);
      if (!event) return;
      if (event.kind === "delta") {
        sawContent = true;
        emit({ type: "delta", delta: { content: event.text } });
        return;
      }
      if (event.kind === "done") {
        sawEnd = true;
        emit({ type: "finish", reason: "stop" });
        return;
      }
      // ERROR：上游在流里报告失败。判据是"此刻有没有字节已经下发"——
      //   还没下发 → 抛错。编排层据此落真实状态码并换号，这是唯一能把失败如实报出去的窗口；
      //   已经下发 → 只能进流内（HTTP 头早发出去了），先发错误帧再补收尾帧，
      //     已有内容保留，不把它截断成"看起来成功了"。
      sawEnd = true;
      if (!sawContent) {
        throw Object.assign(new Error(`KukuAI 上游错误：${event.message}`), { status: 502, code: "kuku_stream_error" });
      }
      emit({ type: "error", status: 502, code: "kuku_stream_error", message: `KukuAI 上游错误：${event.message}` });
      emit({ type: "finish", reason: "stop" });
    });
  } finally {
    cancelTimer();
  }

  // 上游把连接关了却没见过结束帧：补一次收尾，否则客户端的 SSE 解析器等不到结束帧会一直挂着
  if (!sawEnd) {
    if (!sawContent) {
      // 一个字都没答：空回答不是成功。跨账号降级链的触发条件完全依赖错误定性是否正确，
      // 回一个 200 空回复会让降级永远不被触发（此刻还没有任何字节，抛错是安全的）
      throw Object.assign(new Error("KukuAI 上游返回了空回答（流结束但没有任何内容）"), { status: 502 });
    }
    emit({ type: "finish", reason: "stop" });
  }
  return { status: 200, planLimit: false };
}

module.exports = { runChat, buildPrompt, eventFromFrame, FALLBACK_PROMPT };
