// 反代网关 · Qoder 适配器单元自测（纯函数 + 信封解包，无需网络/凭据）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-adapter-selftest.cjs [临时数据目录]
//
// 覆盖：
//   1) toQoderMessages：字符串/数组 content 归一、角色过滤、tool_calls 透传
//   2) toQoderTools：OpenAI function 形态过滤
//   3) rewriteBody：OpenAI → QoderInferRequest 字段映射 + 采样参数透传
//   4) fetchModels：目录解密 → 统一模型对象（注入 stub 签名器，验证整形与去重）
//   5) chat：SSE 信封解包（正常流 / 信封错误 / quota / 版本漂移 / [DONE] / usage）
//   6) queryCredits：额度口径（userQuota + addOnQuota，FIFO 求和）与 401/异常形态
//   7) refreshToken：轮换双 token 透传（注入 stub auth）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-adapter-"));
process.env.APPDATA = tmp;

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

// ===== SSE 帧构造工具：把内层 chunk 包成 qoder 信封 =====
const frame = (inner, statusCode = "OK") =>
  `data:${JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body: typeof inner === "string" ? inner : JSON.stringify(inner), statusCode })}\n\n`;

/** 构造一个受控的 SSE 响应体（ReadableStream） */
function sseStream(text) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      // 故意切成不规则分片，验证 pumpSse 的缓冲拼接
      for (let i = 0; i < text.length; i += 97) c.enqueue(enc.encode(text.slice(i, i + 97)));
      c.close();
    },
  });
}

async function main() {
  const { makeQoder, toQoderMessages, toQoderTools, STATIC_MODELS } = require("../electron/backend/proxy/qoderAdapter.cjs");
  const util = require("../electron/backend/proxy/util.cjs");

  // ===== 1. 消息归一 =====
  console.log("\n[1] toQoderMessages");
  const msgs = toQoderMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
    { role: "assistant", content: [{ type: "text", text: "在" }], tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "结果", tool_call_id: "c1", name: "f" },
    { role: "bogus", content: "应被过滤" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }] },
    { role: "user", content: [{ type: "unknown_part" }] },
  ]);
  // 输入 7 条：1 system、2 user、3 assistant(含 tool_calls)、4 tool、5 非法角色、6 user(image_url)、7 user(未知部件)
  // 保留 1/2/3/4/6 = 5 条；非法角色被过滤；未知部件归一后为空内容被丢弃
  assert(msgs.length === 5, "非法角色与空内容消息被过滤（7 → 5）");
  assert(Array.isArray(msgs[0].content) && msgs[0].content[0].text === "你是助手", "字符串 content 归一为 [{type:text}]");
  assert(msgs[2].tool_calls && msgs[2].tool_calls.length === 1, "assistant tool_calls 透传");
  assert(msgs[3].tool_call_id === "c1" && msgs[3].name === "f", "tool 角色 tool_call_id/name 透传");
  assert(msgs[4].content[0].type === "image_url", "image_url 部件保留");
  assert(toQoderMessages([{ role: "user", content: [{ type: "unknown_part" }] }]).length === 0, "未知部件归一为空后被丢弃");

  // ===== 2. tools 过滤 =====
  console.log("\n[2] toQoderTools");
  const tools = toQoderTools([
    { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
    { type: "function" },
    { type: "other", function: { name: "x" } },
    null,
  ]);
  assert(tools.length === 1 && tools[0].function.name === "get_weather", "仅保留合法 function 工具");

  // ===== 3. rewriteBody =====
  console.log("\n[3] rewriteBody");
  const rules = require("../electron/backend/proxy/rules.cjs");
  rules.init();
  // 生产环境的 fetchStream/pumpSse/httpJson 是 adapters.cjs 的私有函数（未导出），
  // 因此适配器通过 deps 注入。测试用同源实现（util.SseScanner）搭一个等价 pumpSse stub。
  const testPumpSse = async (resp, onEvent) => {
    const scanner = new util.SseScanner(onEvent);
    const dec = new TextDecoder();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      scanner.feed(dec.decode(value, { stream: true }));
    }
    scanner.feed(dec.decode());
    scanner.flush();
  };
  const deps = {
    fetchStream: async () => ({ resp: { body: sseStream(""), ok: true, status: 200 }, cancelTimer: () => {} }),
    pumpSse: testPumpSse,
    httpJson: async () => ({ ok: true, status: 200, data: {} }),
    rules,
    auth: require("../electron/backend/proxy/qoderAuth.cjs"),
    signer: { createSession: async () => { throw new Error("stub"); } },
    store: null,
    util, // hasConsumableDelta 用于流中断时的本地出线判定
  };
  const ad = makeQoder("qoder", deps);
  assert(ad.id === "qoder", "渠道 id 正确");
  const rw = ad.rewriteBody("dfmodel", { messages: [{ role: "user", content: "hi" }], temperature: 0.3, max_tokens: 64, stop: ["x"] }, { uid: "u1" }, {});
  assert(rw.model_config.key === "dfmodel", "model_config.key 来自请求模型");
  assert(rw.model_config.format === "openai", "format=openai");
  assert(rw.model_config.source === "system", "source=system");
  assert(rw.session_id && rw.request_id && rw.request_set_id, "session/request id 已生成");
  assert(rw.request_id === rw.request_set_id, "request_set_id 与 request_id 一致");
  assert(rw.temperature === 0.3 && rw.max_tokens === 64 && Array.isArray(rw.stop), "采样参数透传");
  assert(Array.isArray(rw.tools) && rw.tools.length === 0, "无工具时为空数组");
  const meta = { requestId: "R1", sessionId: "S1" };
  const rw2 = ad.rewriteBody("gfmodel", { messages: [] }, {}, meta);
  assert(rw2.request_id === "R1" && rw2.session_id === "S1", "meta 提供时复用 id（轮内稳定）");
  assert(ad.models().length >= STATIC_MODELS.length, "models() 含静态兜底表");

  // ===== 4. fetchModels（stub 签名器）=====
  console.log("\n[4] fetchModels 目录整形");
  const fakeCatalog = JSON.stringify({
    assistant: [
      { key: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0.1, enable: true, is_reasoning: true, is_vl: true, max_input_tokens: 180000, context_config: { "200K": { token_count: 200000, is_default: true }, "1M": { token_count: 1000000 } }, thinking_config: { enabled: { efforts: { low: {}, high: {} } } } },
      { key: "qfmodel", display_name: "Qwen3.8-Flash", price_factor: 0, enable: true, is_free: true },
      { key: "disabled1", display_name: "Disabled", price_factor: 1, enable: false },
    ],
    chat: [
      { key: "dfmodel", display_name: "重复项应被去重", price_factor: 9 },
      { key: "mmodel", display_name: "MiniMax-M2.7", price_factor: 0.2, enable: true },
    ],
  });
  const deps2 = {
    ...deps,
    auth: { ...deps.auth, readCatalogBlob: () => "BLOB" },
    signer: { createSession: async () => ({ modelCacheDecrypt: () => fakeCatalog, free: () => {} }) },
  };
  const ad2 = makeQoder("qoder", deps2);
  const fm = await ad2.fetchModels({ uid: "u1" }, { token: "dt-x" });
  assert(fm.ok, "目录拉取成功");
  const ids = fm.models.map((m) => m.id);
  assert(ids.includes("dfmodel") && ids.includes("qfmodel") && ids.includes("mmodel"), "三模型入表");
  assert(!ids.includes("disabled1"), "enable=false 被剔除");
  assert(fm.models.filter((m) => m.id === "dfmodel").length === 1, "跨场景同 key 去重（assistant 优先）");
  const df = fm.models.find((m) => m.id === "dfmodel");
  assert(df.name === "DeepSeek-Flash", "assistant 场景优先（未被 chat 的重复项覆盖）");
  assert(df.rate === 0.1, "rate = price_factor");
  assert(df.contextLength === 1000000, "contextLength 取 context_config 最大档");
  assert(df.capabilities.reasoning === true && df.capabilities.images === true, "能力位映射（is_reasoning/is_vl）");
  assert(df.reasoning.supportedEfforts.length === 2, "thinking efforts 映射");
  const qf = fm.models.find((m) => m.id === "qfmodel");
  assert(qf.isFree === true && qf.rate === 0, "免费模型标记（price_factor=0）");
  const bad = await makeQoder("qoder", { ...deps, auth: { ...deps.auth, readCatalogBlob: () => null } }).fetchModels({ uid: "u1" }, { token: "t" });
  assert(!bad.ok, "无目录缓存时如实失败（不写空）");

  // ===== 5. chat 信封解包 =====
  console.log("\n[5] chat 信封解包");
  const mkChat = (sseText, sessionOverride) => {
    const events = [];
    const d = {
      ...deps,
      fetchStream: async () => ({ resp: { body: sseStream(sseText), ok: true, status: 200 }, cancelTimer: () => {} }),
      signer: {
        createSession: async () => sessionOverride || {
          prepareInferRequest: () => ({ url: "https://gw/x?Encode=1", headers: { Authorization: "Bearer COSY.a.b" }, body: Buffer.from("encoded") }),
          free: () => {},
        },
      },
    };
    return { ad: makeQoder("qoder", d), events };
  };
  const emitInto = (events) => (e) => events.push(e);

  // 5a 正常流
  const okSse =
    frame({ choices: [{ delta: { role: "assistant", reasoning_content: "" }, index: 0 }] }) +
    frame({ choices: [{ delta: { reasoning_content: "思考" }, index: 0 }] }) +
    frame({ choices: [{ delta: { content: "你好" }, index: 0 }] }) +
    frame({ choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 37, completion_tokens: 28, total_tokens: 65, credits: 0.0066, billable: true } }) +
    frame("[DONE]");
  {
    const { ad: a, events } = mkChat(okSse);
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "dt-x" }, model: "dfmodel", body: { messages: [{ role: "user", content: "hi" }] }, emit: emitInto(events), meta: {} });
    const deltas = events.filter((e) => e.type === "delta");
    // 适配器只发原始 delta，不做字段剥离（剥离与出线判定归 server.cjs 统一 emit 包装）
    assert(deltas.length === 4, "四个 delta 原样透传（含空串噪声帧，由 server 侧剥离）");
    assert(deltas[0].delta.role === "assistant" && deltas[0].delta.reasoning_content === "", "首帧原样透传（空 reasoning_content 不被适配器剥离）");
    assert(deltas[1].delta.reasoning_content === "思考", "reasoning_content 透传（思考流）");
    assert(deltas[2].delta.content === "你好", "content 透传");
    assert(deltas[3].delta.content === "" && !("finish_reason" in deltas[3].delta), "空 content 帧原样透传；finish_reason 不进 delta（走独立 finish 事件）");
    const finishes = events.filter((e) => e.type === "finish");
    assert(finishes.length === 2 && finishes[0].reason === "stop" && finishes[1].reason === "", "finish 两次：上游 stop + [DONE] 空 reason（沿用既有约定）");
    const u = events.find((e) => e.type === "usage").usage;
    assert(u.credits === 0.0066 && u.prompt_tokens === 37, "usage 透传含 credits 与 token 口径");
    assert(res.status === 200 && res.planLimit === false, "正常返回 status 200 / planLimit false");
  }
  // 5a-2 出线判据：仅 role / 私有扩展字段的噪声帧不得算「已出内容」（决定流中断能否换号自救）
  {
    const noiseSse =
      frame({ choices: [{ delta: { role: "assistant" }, index: 0 }] }) +          // 仅 role
      frame({ choices: [{ delta: { extra_fields: { a: 1 } }, index: 0 }] }) +     // 私有扩展字段
      frame({ choices: [{ delta: { tool_calls: [] }, index: 0 }] }) +             // 空工具数组
      frame(JSON.stringify({ code: "116", error: "quota exceeded" }), "FORBIDDEN");
    const { ad: a, events } = mkChat(noiseSse);
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    assert(res.planLimit === true, "噪声帧后遇 quota → 仍能 planLimit 换号（未被误判为已出线）");
    assert(events.filter((e) => e.type === "delta").length === 3, "三类噪声帧均透传（判定与透传解耦）");
  }
  // 5b quota exceeded → planLimit
  {
    const { ad: a, events } = mkChat(frame(JSON.stringify({ code: "116", error: "quota exceeded" }), "FORBIDDEN"));
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    assert(res.planLimit === true, "code116 → planLimit=true（触发换号）");
    assert(events.some((e) => e.type === "error" && e.status === 402), "emit 402 错误");
  }
  // 5c Signature invalid → 版本漂移（不落账号冷却）
  {
    const { ad: a, events } = mkChat(frame(JSON.stringify({ code: "101", message: "Signature invalid" }), "FORBIDDEN"));
    await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    const err = events.find((e) => e.type === "error");
    assert(err && err.code === "signature_invalid" && err.status === 403, "Signature invalid → signature_invalid/403（版本漂移分类）");
  }
  // 5d 信封内 unauthorized → 401
  {
    const { ad: a, events } = mkChat(frame(JSON.stringify({ code: "TOKEN_EXPIRE", message: "token is not active" }), "UNAUTHORIZED"));
    await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    const err = events.find((e) => e.type === "error");
    assert(err && err.status === 401, "token 失效 → 401（relogin 判定依据）");
  }
  // 5e 签名器不可用 → 503 渠道级
  {
    const { ad: a } = mkChat("", null);
    const d5 = { ...deps, signer: { createSession: async () => { throw new Error("客户端未安装"); } } };
    const a5 = makeQoder("qoder", d5);
    let threw = null;
    try { await a5.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} }); }
    catch (e) { threw = e; }
    assert(threw && threw.status === 503 && threw.qoderSignerDown === true, "签名器不可用 → 503 渠道级故障（不罚账号）");
  }
  // 5f 畸形帧不崩
  {
    const { ad: a, events } = mkChat("data:not-json\n\n" + frame({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + frame("[DONE]"));
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    assert(res.status === 200 && events.some((e) => e.type === "delta"), "畸形帧被忽略，正常帧继续");
  }
  // 5g body:"null" 帧（实测：上游会在流中间夹一帧字面量 null，图片请求时尤其容易触发）
  // 修复前 JSON.parse 得到 null → chunk.choices 抛 TypeError → 整条流以内部异常中断
  {
    const { ad: a, events } = mkChat(
      frame({ choices: [{ delta: { role: "assistant" }, index: 0 }] }) +
      frame("null") +
      frame({ choices: [{ delta: { content: "after-null" }, index: 0 }] }) +
      frame("[DONE]")
    );
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    const text = events.filter((e) => e.type === "delta" && e.delta.content).map((e) => e.delta.content).join("");
    assert(res.status === 200, "body:\"null\" 帧不致流中断");
    assert(text === "after-null", "null 帧被跳过，其后内容正常透传");
    assert(!events.some((e) => e.type === "error"), "不产生 error 事件（修复前会抛 TypeError）");
  }
  // 5h 会话池：复用 / token 轮换新建 / 失败路径归还 / 容量淘汰
  {
    const created = [];
    const freed = [];
    const okResp = () => ({ resp: { body: sseStream(frame({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + frame("[DONE]")), ok: true, status: 200 }, cancelTimer: () => {} });
    let failNext = false;
    const d = {
      ...deps,
      fetchStream: async () => {
        if (failNext) throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return okResp();
      },
      signer: {
        createSession: async ({ token }) => {
          const s = {
            prepareInferRequest: () => ({ url: "https://gw/x?Encode=1", headers: {}, body: Buffer.from("encoded") }),
            free: () => freed.push(token),
          };
          created.push(s);
          return s;
        },
      },
    };
    const ad2 = makeQoder("qoder", d);
    const acctA = { uid: "A", meta: { machineId: "M1" } };
    const callA = () => ad2.chat({ account: acctA, secrets: { token: "T1" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    await callA();
    await callA();
    assert(created.length === 1, "同身份两次 chat 复用池中会话（createSession 仅 1 次）");
    assert(freed.length === 0, "归还时不销毁（free 未被调用）");
    await ad2.chat({ account: acctA, secrets: { token: "T2" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    assert(created.length === 2, "token 变化 → 新建会话（池键含 token）");
    // 失败路径归还：fetchStream 抛 429 时 chat 如实抛出，但会话必须已归还（旧实现在此泄漏）
    failNext = true;
    let threw = false;
    try { await callA(); } catch (e) { threw = true; }
    assert(threw, "fetchStream 抛错 → chat 如实抛出");
    assert(freed.length === 0, "失败路径归还后池中会话未被销毁（可复用）");
    failNext = false;
    // 容量淘汰：连续 20 个新身份（池上限 12）→ 最久未用的空闲会话被显式 free
    for (let i = 0; i < 20; i++) {
      await ad2.chat({ account: { uid: "U" + i, meta: { machineId: "M1" } }, secrets: { token: "TK" + i }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    }
    assert(created.length === 22, "累计新建 22 个会话（A 两次换 token + 20 个新身份）");
    assert(freed.length === created.length - 12, `容量淘汰 freed=${freed.length}（池上限 12，应释放 ${created.length - 12} 个）`);
    assert(freed.includes("T1"), "最先淘汰的是最久未用的（T1 在列）");
  }
  {
    // 加固回归：prepareInferRequest 抛错 → inUse 必须归还，否则该条目永远无法被
    // LRU 淘汰（等效池容量缩水）。观察法：让签名在 X 身份上炸一次，再压入 12 个新
    // 身份——若 X 已归还，X 会被正常淘汰计入 freed；若卡死则 freed 少 1。
    const created2 = [];
    const freed2 = [];
    const ok2 = () => ({ resp: { body: sseStream(frame({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + frame("[DONE]")), ok: true, status: 200 }, cancelTimer: () => {} });
    const d3 = {
      ...deps,
      fetchStream: ok2,
      signer: {
        createSession: async ({ token }) => {
          const s = {
            prepareInferRequest: (o, b, mk) => {
              if (mk === "boom") throw new Error("wasm boom");
              return { url: "https://gw/x?Encode=1", headers: {}, body: Buffer.from("encoded") };
            },
            free: () => freed2.push(token),
          };
          created2.push(s);
          return s;
        },
      },
    };
    const ad3 = makeQoder("qoder", d3);
    let threw3 = false;
    try {
      await ad3.chat({ account: { uid: "X", meta: { machineId: "M" } }, secrets: { token: "TX" }, model: "boom", body: { messages: [] }, emit: () => {}, meta: {} });
    } catch (e) { threw3 = true; }
    assert(threw3, "prepareInferRequest 抛错 → chat 如实抛出");
    for (let i = 0; i < 12; i++) {
      await ad3.chat({ account: { uid: "Y" + i, meta: { machineId: "M" } }, secrets: { token: "TY" + i }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    }
    assert(created2.length === 13, "X 炸一次 + 12 个新身份 = 13 个会话");
    assert(freed2.includes("TX"), `抛错会话已被正常淘汰（freed 含 TX，实际 ${JSON.stringify(freed2)}）`);
  }

  // ===== 6. queryCredits =====
  console.log("\n[6] queryCredits 口径");
  const mkQ = (data, status = 200, ok = true) => makeQoder("qoder", { ...deps, httpJson: async () => ({ ok, status, data }) });
  {
    const r = await mkQ({ userQuota: { total: 300, used: 1, remaining: 299 }, addOnQuota: { total: 100, used: 0, remaining: 100 }, expiresAt: 1792285722753, userType: "personal_professional_trial" }).queryCredits({}, { token: "t" });
    assert(r.credits === 399, "credits = userQuota.remaining + addOnQuota.remaining（299+100）");
    assert(r.expiresAt === 1792285722753, "expiresAt 透传");
    assert(r.detail && r.detail.userQuota, "保留明细供 UI 分层展示");
  }
  {
    const r = await mkQ({ userQuota: { remaining: 0.5 }, addOnQuota: { remaining: 0.25 } }).queryCredits({}, { token: "t" });
    assert(r.credits === 0.75, "小数保留（浮点 credits，两位内不截断）");
  }
  {
    const r = await mkQ(null, 401, false).queryCredits({}, { token: "t" });
    assert(r.authError === true, "HTTP 401 → authError（触发刷新重试/relogin）");
  }
  {
    const r = await mkQ({ something: "else" }).queryCredits({}, { token: "t" });
    assert(r.unavailable === true, "结构未识别 → unavailable（不误判为 0 余额）");
  }
  // 多域回退：INTL 的额度端点在 openapi，gateway 返回 404（实测）→ 必须能回退到第二个域
  // ⚠ 此块曾在文件恢复事故中被旧版本覆盖（6820f8b 误删），现按 fecb29e 原文补回。
  {
    const seen = [];
    const stubRules = {
      get: (name) => (name === "headers.json"
        ? { qoder: { quotaBase: "https://gw.invalid", gateway: "https://gw2.invalid", openApi: "https://openapi.invalid", quotaPath: "/api/v2/quota/usage", userAgent: "qoder/0.4.3" } }
        : {}),
      rulesDir: () => tmp,
    };
    const ad = makeQoder("qoder", {
      ...deps,
      rules: stubRules,
      httpJson: async (url) => {
        seen.push(url);
        return url.includes("openapi") ? { ok: true, status: 200, data: { userQuota: { remaining: 7 } } } : { ok: false, status: 404, data: null };
      },
    });
    const r = await ad.queryCredits({}, { token: "t" });
    assert(r.credits === 7, "前序域 404 时回退到后续域成功");
    assert(seen.length === 3, "依次尝试 quotaBase → gateway → openApi 三个域");
    assert(seen[0].includes("gw.invalid") && seen[1].includes("gw2.invalid") && seen[2].includes("openapi.invalid"), "回退顺序正确（去重后按 quotaBase/gateway/openApi）");
  }

  // ===== 7. refreshToken =====
  console.log("\n[7] refreshToken 轮换");
  {
    const d7 = { ...deps, auth: { ...deps.auth, refreshDeviceToken: async () => ({ ok: true, token: "dt-new", refreshToken: "drt-new", expiresAt: 111, refreshTokenExpiresAt: 222 }) } };
    const r = await makeQoder("qoder", d7).refreshToken({ meta: { machineId: "mid" } }, { refreshToken: "drt-old" });
    assert(r.ok && r.token === "dt-new" && r.refreshToken === "drt-new", "双 token 同时返回（轮换制）");
    assert(r.expiresAt === 111 && r.refreshTokenExpiresAt === 222, "两个到期时间一并返回（供落库）");
  }
  {
    const r = await makeQoder("qoder", deps).refreshToken({ meta: {} }, {});
    assert(!r.ok, "无 refreshToken 时如实失败");
  }

  console.log("\n[done] Qoder 适配器单元自测全部通过");
}

main()
  .then(() => process.exit(0)) // fetch keep-alive 句柄会让事件循环保持存活，测完显式退出（对齐 proxy-smoke 约定）
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });
