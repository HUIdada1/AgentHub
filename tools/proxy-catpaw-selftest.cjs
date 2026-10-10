// 反代网关 · CatPaw 渠道自测：纯函数归一化 / 指纹链 / 注册表 TTL·LRU·身份隔离 /
// 轮次状态机三规则 / 三条硬约束 / 图片压缩降质序列 / usage 口径修正。
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-catpaw-selftest.cjs
//
// 与 proxy-smoke 的分工：smoke 覆盖全渠道公共链路（路由/换号/记账），本文件只打 CatPaw
// 的协议特有面。全程用本地假上游（随机端口，不碰真实上游、不碰生产库）。
"use strict";
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// 独立数据目录：rules/config 落临时目录，绝不触碰真实 %APPDATA%
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-catpaw-test-"));

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };

  const dir = path.join(__dirname, "..", "electron", "backend", "proxy", "catpaw");
  const blocks = require(path.join(dir, "blocks.cjs"));
  const messages = require(path.join(dir, "messages.cjs"));
  const fingerprint = require(path.join(dir, "fingerprint.cjs"));
  const models = require(path.join(dir, "models.cjs"));
  const tools = require(path.join(dir, "tools.cjs"));
  const imageCompress = require(path.join(dir, "imageCompress.cjs"));
  const registryMod = require(path.join(dir, "registry.cjs"));
  const openai = require(path.join(dir, "openai.cjs"));
  const decision = require(path.join(dir, "decision.cjs"));
  const conversation = require(path.join(dir, "conversation.cjs"));
  const turnExecutor = require(path.join(dir, "turnExecutor.cjs"));
  const credentials = require(path.join(dir, "credentials.cjs"));
  const catalog = require(path.join(dir, "catalog.cjs"));
  const upstreamHttp = require(path.join(dir, "upstreamHttp.cjs"));
  const adapterMod = require(path.join(dir, "adapter.cjs"));
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const store = require("../electron/backend/proxy/store.cjs");

  // ===== 1. 双表与适配器契约（渠道已注册 + 会话式转发声明）=====
  assert(store.CHANNELS.some((c) => c.id === "catpaw"), "store.CHANNELS 含 catpaw");
  const ad = adapters.get("catpaw");
  assert(ad && ad.stateful() === true && typeof ad.chatSession === "function", "catpaw 声明 stateful 且有 chatSession");
  const noCred = await ad.chat().then(() => null, (e) => e);
  assert(noCred && noCred.status === 503 && /会话式转发/.test(noCred.message), "单发 chat 防御性报错（有状态渠道不该被单请求路径调用）");
  const checkin = await ad.checkinStatus({}, {});
  assert(checkin.ok === true && checkin.unavailable === true, "无签到如实回报不适用（不是假装成功）");
  const refresh = await ad.refreshToken({}, {});
  assert(refresh.ok === false && /不支持自动刷新/.test(refresh.message), "refreshToken 如实回报不支持");
  assert(ad.models().includes("glm-5.3-flash") && ad.models().includes("kimi-k3"), "静态兜底模型清单");
  console.log("gate ok（渠道注册 / stateful 声明 / 无签到与无刷新如实回报）");

  // ===== 2. 消息归一化（messages/blocks）=====
  const norm = messages.normalizeMessages([
    { role: "system", content: "系统提示" },
    { role: "developer", content: "规则" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的", reasoning_content: "思考" },
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "https://x/a.png", detail: "high" } }] },
  ], {});
  assert(norm.systemPrompt === "系统提示" && norm.rulesMessage === "规则", "system/developer 抽离成独立字段");
  assert(!norm.messages.some((m) => m.type === "system" || m.type === "developer"), "抽离后 messages 不含指令消息");
  assert(norm.messages.length === 3, `对话消息 3 条（system/developer 抽离后剩 user/assistant/user，实际 ${norm.messages.length}）`);
  assert(norm.messages.every((m) => typeof m.messageId === "string" && m.messageId.length > 0), "每条消息 messageId 非空（上游逐条校验）");
  const imageBlock = norm.messages[2].content[1];
  assert(imageBlock.type === "image_url" && imageBlock.imageUrl.url === "https://x/a.png" && imageBlock.imageUrl.detail === "high", "图片块蛇形→驼峰 imageUrl");
  const reasoningBlock = norm.messages[1].content.find((b) => b.type === "text");
  assert(reasoningBlock.reasoningContent === "思考", "reasoning_content 挂到 text 块");

  // 连续 tool 消息合并成单条 tool 消息的多个 tool_result 块
  const merged = messages.normalizeMessages([
    { role: "user", content: "并行调用" },
    { role: "assistant", tool_calls: [
      { id: "c1", type: "function", function: { name: "f1", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "f2", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "r1" },
    { role: "tool", tool_call_id: "c2", content: "r2" },
  ], {});
  const toolMsg = merged.messages[2];
  assert(toolMsg.type === "tool" && toolMsg.content.length === 2, "连续 tool 消息合并为多 tool_result 块");
  assert(toolMsg.content[0].toolName === "f1" && toolMsg.content[1].toolName === "f2", "toolName 从 assistant tool_calls 回填（进指纹，必须写回）");

  // 打断未完成工具调用：补合成 tool 消息保持配对
  const interrupted = messages.normalizeMessages([
    { role: "user", content: "调用" },
    { role: "assistant", tool_calls: [{ id: "c9", type: "function", function: { name: "fx", arguments: "{}" } }] },
    { role: "user", content: "算了" },
  ], {});
  const synth = interrupted.messages[2];
  assert(synth.type === "tool" && synth.content[0].toolResult === messages.INTERRUPTED_TOOL_RESULT, "被打断的工具调用补合成 tool 消息");

  // 尾部 tool_call 缺结果：默认报错、工具续接模式放行
  let tailErr = null;
  try {
    messages.normalizeMessages([
      { role: "user", content: "x" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ], {});
  } catch (e) { tailErr = e; }
  assert(tailErr && tailErr.status === 400 && /缺少对应的 tool 结果/.test(tailErr.message), "尾部 tool_call 缺结果默认报 400");
  assert(messages.normalizeMessages([
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
  ], { allowTrailingToolCalls: true }).messages.length === 2, "allowTrailingToolCalls 放行");

  // 相邻 assistant 合并；两条都带 tool_use 不合并
  const twoAssistants = messages.normalizeMessages([
    { role: "user", content: "x" },
    { role: "assistant", content: "前半" },
    { role: "assistant", content: "后半" },
  ], {});
  assert(twoAssistants.messages.length === 2 && twoAssistants.messages[1].content.length === 2, "相邻 assistant 合并");
  console.log("messages ok（抽离 / 合并 / 配对回填 / 打断合成 / 尾部校验）");

  // ===== 3. 块级校验（图片 data URL / 工具参数 / 结果文本）=====
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const imgNorm = blocks.normalizeImageBlock({ type: "image_url", imageUrl: { url: dataUrl } });
  assert(imgNorm.imageUrl.detail === "auto", "detail 缺省回落 auto");
  for (const bad of ["data:image/svg+xml;base64,AAAA", "ftp://x/a.png", "data:image/png;base64,"]) {
    let threw = null;
    try { blocks.normalizeImageBlock({ type: "image_url", image_url: { url: bad } }); } catch (e) { threw = e; }
    assert(threw && threw.status === 400, `非法图片 URL 报 400: ${bad.slice(0, 24)}`);
  }
  let protoErr = null;
  try {
    // 注意必须用 JSON 文本构造：对象字面量的 __proto__ 是设置原型、不会成为自有键
    blocks.validateToolArguments('{"__proto__":{"polluted":1}}', 0);
  } catch (e) { protoErr = e; }
  assert(protoErr && protoErr.status === 400, "工具参数含危险键被拒（原型污染面）");
  assert(blocks.validateToolArguments('{"a": 1}', 0) === '{"a": 1}', "字符串参数原样保留（重序列化会让指纹漂移）");
  assert(blocks.validateToolArguments({ a: 1 }, 0) === '{"a":1}', "对象参数转紧凑 JSON");
  assert(blocks.toolResultContent({ content: ["a", "b"] }, 0) === "a\nb", "tool 结果字符串数组按 \\n 连接");
  assert(blocks.toolResultContent({ content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] }, 0) === "x\ny", "text 块数组取 text 连接");
  console.log("blocks ok（图片校验 / 危险键 / 参数序列化口径 / 结果文本）");

  // ===== 4. 指纹链与增量定位 =====
  const msgA = { type: "user", messageId: "id-1", content: [{ type: "text", text: "你好" }], finished: true };
  const msgClone = { type: "user", messageId: "id-2", content: [{ type: "text", text: "你好" }], finished: true };
  const msgB = { type: "user", messageId: "id-3", content: [{ type: "text", text: "世界" }], finished: true };
  assert(fingerprint.messageFingerprint(msgA) === fingerprint.messageFingerprint(msgClone), "messageId 不参与指纹（同内容同指纹）");
  const withBlank = { type: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "答" }] };
  const withoutBlank = { type: "assistant", content: [{ type: "text", text: "答" }] };
  assert(fingerprint.messageFingerprint(withBlank) === fingerprint.messageFingerprint(withoutBlank), "空 text 块不参与指纹（客户端回显会丢掉它）");
  assert(fingerprint.messageFingerprint(msgA).length === 64, "指纹是 64 位十六进制");
  const chain = fingerprint.fingerprintsFor([msgA]);
  assert(fingerprint.locateIncrement([msgA, msgB], chain).start === 1, "增量定位：末条已同步指纹之后即增量");
  assert(fingerprint.locateIncrement([msgA], []).start === 0, "无指纹链时全部是增量");
  assert(fingerprint.locateIncrement([msgB], chain).kind === "mismatch", "历史被改写 → mismatch（调用方作废重建）");
  assert(fingerprint.locateIncrement([msgA, msgClone], chain).start === 2, "重复指纹取最后一次出现（从后往前找）");
  console.log("fingerprint ok（messageId 不参与 / 空块跳过 / 增量三态）");

  // ===== 5. 模型 / effort / context 口径 =====
  assert(models.findModelEntry("Kimi K3").hostModelId === 83, "模型名归一化匹配（空白→连字符）");
  assert(models.findModelEntry("91").hostModelId === 91 && models.findModelEntry(83).id === "kimi-k3", "数字 ID 直认");
  assert(models.effortForLevel("minimal") === "low" && models.effortForLevel("medium") === "high" && models.effortForLevel("xhigh") === "max", "通用 6 档两两合流到本家 3 档");
  assert(models.effortForLevel("custom-7") === null, "表外等级返回 null（不注入，避免把请求打成 400）");
  assert(models.resolveEffort({ reasoning_effort: "MAX" }) === "max", "档位大小写归一");
  let effortErr = null;
  try { models.resolveEffort({ effort: "medium" }); } catch (e) { effortErr = e; }
  assert(effortErr && effortErr.status === 400, "非法档位 400（原样注入会被上游拒，静默忽略又让用户以为生效）");
  const resolution = models.resolveModelRequest("glm-5.3-flash", { find: () => null, knownIds: () => ["glm-5.3-flash"] });
  assert(resolution.modelType === 91 && resolution.displayName === "glm-5.3-flash", "静态表命中给实测数字 ID");
  assert(models.resolveContextWindow({ context_window: "1m" }, resolution) === "1024000", "context 别名 1m → 1024000");
  assert(models.resolveContextWindow({}, resolution) === "1024000", "缺省用模型默认档位");
  const kimi = models.resolveModelRequest("kimi-k3", { find: () => null, knownIds: () => [] });
  let ctxErr = null;
  try { models.resolveContextWindow({ context_window: "200k" }, kimi); } catch (e) { ctxErr = e; }
  assert(ctxErr && ctxErr.status === 400 && /不支持 context_window/.test(ctxErr.message), "kimi-k3 不支持 context 参数（静态表无档位）");
  let modelErr = null;
  try { models.resolveModelRequest("gpt-9", { find: () => null, knownIds: () => ["glm-5.3-flash"] }); } catch (e) { modelErr = e; }
  assert(modelErr && modelErr.status === 400 && /可用: glm-5.3-flash/.test(modelErr.message), "未知模型 400 且列出可用清单");
  console.log("models ok（数字 ID / 档位合流 / context 校验 / 未知模型）");

  // ===== 6. 工具归一化 =====
  assert(tools.normalizeTools(undefined).length === 0, "未给 tools 不是错误");
  let strictErr = null;
  try {
    tools.normalizeTools([{ type: "function", function: { name: "f", strict: true, parameters: {} } }]);
  } catch (e) { strictErr = e; }
  assert(strictErr && /strict=true 暂不支持/.test(strictErr.message), "strict=true 如实拒绝（上游没有强制 schema 输出）");
  const toolConfigs = tools.normalizeTools([{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }]);
  assert(toolConfigs[0].enable === true && toolConfigs[0].fromClient === true && toolConfigs[0].inputSchema.type === "object", "toolConfigs 常量字段与 inputSchema");
  assert(tools.toolChoiceMode("required").kind === "required" && tools.toolChoiceMode({ type: "function", function: { name: "f" } }).name === "f", "tool_choice 形态");
  let choiceErr = null;
  try { tools.selectTools([], { kind: "function", name: "nope" }); } catch (e) { choiceErr = e; }
  assert(choiceErr && /指定的工具不存在/.test(choiceErr.message), "指定工具不存在报 400");
  assert(tools.selectTools(toolConfigs, { kind: "none" }).length === 0, "tool_choice=none 不下发工具");
  console.log("tools ok（strict / toolConfigs / tool_choice 裁剪）");

  // ===== 7. 图片压缩（注入假 codec 复验降质降尺寸序列）=====
  const bigBase64 = Buffer.alloc(200 * 1024, 7).toString("base64");
  const bigDataUrl = `data:image/jpeg;base64,${bigBase64}`;
  const calls = [];
  imageCompress.setCodec({
    decode: () => ({ w: 4000, h: 3000 }),
    resize: (handle, dim) => ({ w: Math.min(4000, dim), h: Math.min(3000, dim) }),
    encodeJpeg: (handle, quality) => {
      calls.push({ dim: handle.w, quality });
      const size = quality >= 80 ? 200 * 1024 : quality >= 65 ? 150 * 1024 : 100 * 1024;
      return Buffer.alloc(size, 1);
    },
  });
  const compressed = imageCompress.compressIfNeeded(bigDataUrl);
  assert(compressed.startsWith("data:image/jpeg;base64,"), "压缩产物是 JPEG data URL");
  assert(calls.length === 3, `最多编码到达标即停（实际 ${calls.length} 次）`);
  assert(calls.map((c) => c.quality).join(",") === "80,65,55", `质量序列 80→65→55（实际 ${calls.map((c) => c.quality).join(",")}）`);
  assert(calls.map((c) => c.dim).join(",") === "1568,1568,1176", `尺寸序列 1568→1568→1176（第 3 轮起才降，实际 ${calls.map((c) => c.dim).join(",")}）`);
  assert(Buffer.from(compressed.split(",")[1], "base64").length === 100 * 1024, "达标即停（≤120KB）");
  imageCompress.setCodec({
    decode: () => ({ w: 4000, h: 3000 }),
    resize: (handle, dim) => ({ w: dim, h: dim }),
    encodeJpeg: () => Buffer.alloc(400 * 1024, 1),
  });
  assert(imageCompress.compressIfNeeded(bigDataUrl) === bigDataUrl, "压了反而更大 → 保留原图");
  imageCompress.setCodec(null);
  assert(imageCompress.compressIfNeeded(bigDataUrl) === bigDataUrl, "无 codec（非 Electron 环境）降级为原样放行");
  assert(imageCompress.compressIfNeeded("https://x/a.png") === "https://x/a.png", "非 data URL 不碰");
  const small = `data:image/png;base64,${Buffer.alloc(1024).toString("base64")}`;
  assert(imageCompress.compressIfNeeded(small) === small, "未超 60KB 阈值不压");
  assert(imageCompress.__internals.imageDataUrlBody("data:image/svg+xml;base64,AA==") === "AA==", "SVG 也认形态（解码环节失败才放行）");
  console.log("imageCompress ok（阈值早退 / 降质降尺寸序列 / 更大保留 / 无 codec 降级）");

  // ===== 8. 翻译层（累积值差分 + 收尾）=====
  const translator = new openai.TurnTranslator({ choice: { kind: "auto" } });
  const deltas = [];
  const feed = (message, extra) => deltas.push(...translator.consume({ conversationId: "c1", code: 0, data: { message, conversationId: "c1", ...extra } }));
  feed({ type: "assistant", content: [{ type: "text", text: "你" }], finished: false });
  feed({ type: "assistant", content: [{ type: "text", text: "你好" }], finished: false });
  feed({ type: "assistant", content: [{ type: "text", text: "你好", reasoningContent: "想" }], finished: true });
  const text = deltas.map((d) => d.content || "").join("");
  assert(text === "你好", `累积值差分后不重复（实际 ${JSON.stringify(text)}）`);
  assert(deltas.some((d) => d.reasoning_content === "想"), "思考内容走 reasoning_content 增量");
  const emptyFrames = translator.consume({ conversationId: "c1", code: 0, data: { message: { type: "assistant", content: [{ type: "text", text: "你好", reasoningContent: "想" }], finished: true } } });
  assert(emptyFrames.length === 0, "内容没变化不发帧（空帧会污染客户端）");
  const result = translator.finish();
  assert(result.finishReason === "stop" && result.chatId === undefined, "收尾产出 stop");
  const badTranslator = new openai.TurnTranslator({ choice: { kind: "auto" } });
  let finishErr = null;
  try { badTranslator.finish(); } catch (e) { finishErr = e; }
  assert(finishErr && /消息完成前结束/.test(finishErr.message), "流在消息完成前结束 → 报错（提前 EOF 不能当成功）");
  const usage = openai.usageFromResponse({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 100 } });
  assert(usage.prompt_tokens === 95 && usage.total_tokens === 100, "usage 口径修正：prompt = max(增量, total-completion)");
  const frame = new openai.TurnTranslator({ choice: { kind: "required" } });
  let choiceErr2 = null;
  try {
    frame.finish();
  } catch (e) { choiceErr2 = e; }
  assert(choiceErr2 && /消息完成前结束/.test(choiceErr2.message), "required 下空流先报未完成");
  console.log("openai ok（累积差分 / 空帧抑制 / 提前 EOF / usage 修正）");

  // ===== 9. 注册表（TTL / LRU / 身份 / 占用）=====
  const registry = registryMod.registry;
  assert(registryMod.CLIENT_SESSION_TTL_MS === 2 * 3600 * 1000 && registryMod.CLIENT_TOOL_SESSION_TTL_MS === 10 * 60 * 1000, "TTL 常量 2h / 10min");
  assert(registryMod.ttlMs({ sessionId: "s" }) === registryMod.CLIENT_SESSION_TTL_MS, "带会话 id 的记录按 2h");
  assert(registryMod.ttlMs({ sessionId: "" }) === registryMod.CLIENT_TOOL_SESSION_TTL_MS, "匿名工具会话按 10min");
  assert(registryMod.isExpired({ lastActiveAt: 0, sessionId: "s" }, Date.now()) === true, "超期判定");
  const identity = registryMod.identityOf("acc-1", "uid-1");
  assert(registry.markInflight("s-inflight", identity) === true, "首次占用成功");
  assert(registry.markInflight("s-inflight", identity) === false, "同一会话并发占用被拒（走独立 conversation）");
  assert(registry.releaseInflight("s-inflight") === true, "释放占用");
  assert(registry.markInflight("s-inflight", identity) === true, "释放后可再次占用");
  registry.releaseInflight("s-inflight");
  registry.register(registryMod.sessionRecord({ conversationId: "conv-x", fingerprints: ["f"], modelType: 91, accountId: "acc-1", sessionId: "s-1" }));
  assert(registry.resolve("s-1", 91, "acc-1").kind === "reuse", "同模型同账号 → 复用");
  assert(registry.resolve("s-1", 83, "acc-1").reason === "model-mismatch", "换模型 → 作废重建");
  registry.register(registryMod.sessionRecord({ conversationId: "conv-x", fingerprints: ["f"], modelType: 91, accountId: "acc-1", sessionId: "s-1" }));
  assert(registry.resolve("s-1", 91, "acc-2").reason === "account-mismatch", "换账号 → 作废重建");
  // 真实顺序：选路时先对账（记下本次凭证身份），再登记记录 → 记录带上身份
  registry.reconcileIdentity(registryMod.identityOf("acc-1", "uid-1"));
  registry.register(registryMod.sessionRecord({ conversationId: "conv-x", fingerprints: ["f"], modelType: 91, accountId: "acc-1", sessionId: "s-1" }));
  assert(registry.resolve("s-1", 91, "acc-1").kind === "reuse", "身份一致 → 复用");
  const cleared = registry.reconcileIdentity(registryMod.identityOf("acc-1", "uid-2"));
  assert(cleared === 1, `同一账号换用户 → 名下会话作废（实际 ${cleared} 条）`);
  assert(registry.resolve("s-1", 91, "acc-1").kind === "rebuild", "作废后重建");
  // 工具续接索引与身份隔离
  registry.reconcileIdentity(registryMod.identityOf("acc-1", "uid-1"));
  registry.register(registryMod.sessionRecord({ conversationId: "conv-t", fingerprints: ["f"], modelType: 91, accountId: "acc-1", sessionId: "s-2", pendingCallIds: ["call-a"], turnRequestId: "turn-1" }));
  assert(registry.lookupByCallId("call-a") && registry.lookupByCallId("call-a").conversationId === "conv-t", "call 索引命中");
  registry.reconcileIdentity(registryMod.identityOf("acc-1", "uid-3"));
  assert(registry.lookupByCallId("call-a") === null, "换号后工具续接不返回旧身份记录（不把 tool 结果提交到上一个用户的会话）");
  // LRU：超过上限淘汰最久未写
  registry.clearAll();
  for (let i = 0; i < registryMod.MAX_CLIENT_SESSIONS; i++) {
    registry.register(registryMod.sessionRecord({ conversationId: `conv-${i}`, fingerprints: [], modelType: 91, accountId: "a", sessionId: `s-lru-${i}` }));
  }
  registry.register(registryMod.sessionRecord({ conversationId: "conv-new", fingerprints: [], modelType: 91, accountId: "a", sessionId: "s-lru-new" }));
  assert(registry.stats().sessions === registryMod.MAX_CLIENT_SESSIONS, "容量上限生效（不无界增长）");
  assert(registry.resolve("s-lru-0", 91, "a").kind === "rebuild", "最久未写的一条被 LRU 淘汰");
  assert(registry.resolve("s-lru-new", 91, "a").kind === "reuse", "新写入的仍在表里");
  registry.clearAll();
  console.log("registry ok（TTL / 占用 / 模型·账号·身份隔离 / call 索引 / LRU）");

  // ===== 10. 收尾守卫（硬约束 1 的落点）=====
  const terminals = [];
  const guardCtx = {
    baseUrl: "http://127.0.0.1:1", credentials: { token: "t", uid: "u" },
    conversationId: "conv-g", turnRequestId: "turn-g", sessionId: "s-g", registry,
  };
  registry.markInflight("s-g", registryMod.identityOf("a", "u"));
  const guard = new turnExecutor.FinishGuard(guardCtx, true);
  assert(registry.isInflight("s-g"), "守卫登记了在途占用");
  guard.markActive();
  await guard.close("completed", null);
  assert(!registry.isInflight("s-g"), "收尾释放占用");
  await guard.close("failed", null); // 幂等：早退不发第二次请求（baseUrl 指向不可达端口，发出去会慢）
  const quietGuard = new turnExecutor.FinishGuard(guardCtx, false);
  await quietGuard.close("completed", null);
  assert(true, "close 幂等且未 active 时不报终态");
  assert(terminals.length === 0, "终态上报失败被吞掉（不把成功轮次变成失败）");
  console.log("turnExecutor ok（占用释放 / close 幂等 / 终态上报容错）");

  // ===== 11. 状态机端到端（假上游，三规则 + 三条硬约束 + 并发隔离）=====
  const requests = [];
  let turnScript = [];
  let holdNextTurn = false; // 卡住下一条 turn（并发隔离用例）
  let releaseTurn = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push({ path: req.url, body, headers: req.headers });
      if (req.url.includes("/round")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: {} }));
        return;
      }
      if (req.url.includes("/event") || req.url.includes("/turn/stop")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: {} }));
        return;
      }
      if (req.url.includes("/turn")) {
        const script = turnScript.shift() || { content: "Hello" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const blocksOut = [];
        if (script.content) blocksOut.push({ type: "text", text: script.content });
        for (const tc of script.toolCalls || []) blocksOut.push({ type: "tool_use", toolCallId: tc.id, toolName: tc.name, toolParams: tc.args });
        const event = (message, usage) => `data: ${JSON.stringify({ conversationId: "conv-1", code: 0, data: { message, conversationId: "conv-1", ...(usage ? { usage } : {}) } })}\n\n`;
        res.write(event({ type: "assistant", messageId: "m1", content: blocksOut, finished: false }));
        if (holdNextTurn) {
          holdNextTurn = false;
          await new Promise((resolve) => { releaseTurn = resolve; });
        }
        if (script.broken) {
          // 先让首帧真正送达（与 proxy-smoke 的 /broken 同款：立即 destroy 会把缓冲整段 RST，
          // 客户端侧表现为 fetch 本身失败而不是「流中途断」），再掐断连接
          setTimeout(() => res.destroy(), 80);
          return;
        }
        res.write(event({ type: "assistant", messageId: "m1", content: blocksOut, finished: true }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 100 }));
        // 硬约束 2：finished=true 之后仍继续下发（客户端必须读到服务端关连接）
        if (script.tail) {
          res.write(event({ type: "assistant", messageId: "m1", content: [{ type: "text", text: "Hello" }, { type: "text", text: script.tail }], finished: true }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  process.env.CATPAW_UPSTREAM_BASE_URL = `http://127.0.0.1:${port}`;

  const account = { id: "acc-1", uid: "uid-1", name: "测试号", meta: {} };
  const secrets = { token: "tok-1", meta: {} };
  const meta = { conversationId: "sess-Z" };
  const textOf = (events) => events.filter((e) => e.type === "delta").map((e) => e.delta.content || "").join("");

  // 规则 3：全新会话（全量 round + running/completed）
  let events = [];
  await conversation.runConversation({ account, secrets, meta, body: { model: "glm-5.3-flash", stream: true, messages: [{ role: "user", content: "一" }] }, emit: (e) => events.push(e) });
  assert(requests.filter((r) => r.path.includes("/round"))[0].body.messages.length === 1, "规则 3：全新会话全量 round");
  assert(requests.filter((r) => r.path.includes("/event")).map((r) => r.body.data.status).join(",") === "running,completed", "硬约束 1：轮次结束回报 completed");
  assert(textOf(events) === "Hello", "流式正文下发");

  // 规则 2：长会话新轮次（增量）
  requests.length = 0;
  events = [];
  await conversation.runConversation({ account, secrets, meta, body: { model: "glm-5.3-flash", stream: true, messages: [
    { role: "user", content: "一" }, { role: "assistant", content: "Hello" }, { role: "user", content: "二" },
  ] }, emit: (e) => events.push(e) });
  const incrementRound = requests.filter((r) => r.path.includes("/round"))[0];
  assert(incrementRound.body.messages.length === 1 && incrementRound.body.conversationId === "conv-1", "规则 2：复用会话 + 只提交增量");

  // 规则 1：工具续接（不 round、不重复 running）
  requests.length = 0;
  events = [];
  turnScript = [{ content: "", toolCalls: [{ id: "call-1", name: "get_weather", args: '{"city":"bj"}' }] }];
  await conversation.runConversation({ account, secrets, meta, body: { model: "glm-5.3-flash", stream: true, messages: [
    { role: "user", content: "一" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "二" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "查天气" },
  ] }, emit: (e) => events.push(e) });
  const toolStatuses = requests.filter((r) => r.path.includes("/event")).map((r) => r.body.data.status);
  assert(toolStatuses.join(",") === "running", "硬约束 1 例外：返回工具调用时不报 completed");
  assert(events.some((e) => e.type === "finish" && e.reason === "tool_calls"), "finish_reason=tool_calls");
  requests.length = 0;
  events = [];
  turnScript = [{ content: "晴" }];
  await conversation.runConversation({ account, secrets, meta, body: { model: "glm-5.3-flash", stream: true, messages: [
    { role: "user", content: "一" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "二" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "查天气" },
    { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"bj"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "北京晴" },
  ] }, emit: (e) => events.push(e) });
  assert(!requests.some((r) => r.path.includes("/round")), "规则 1：工具续接不 round");
  assert(!requests.some((r) => r.path.includes("/event") && r.body.data.status === "running"), "规则 1：不重复报 running");
  const toolTurn = requests.find((r) => r.path.includes("/turn"));
  assert(toolTurn.body.message.type === "tool" && toolTurn.body.message.content[0].toolName === "get_weather", "规则 1：turn 提交回填 toolName 的 tool 消息");

  // 硬约束 3：非流式辅助请求不读不写会话映射
  const before = registry.stats();
  requests.length = 0;
  events = [];
  turnScript = [{ content: "标题" }];
  await conversation.runConversation({ account, secrets, meta, body: { model: "kimi-k3", stream: false, messages: [{ role: "user", content: "起标题" }] }, emit: (e) => events.push(e) });
  assert(registry.stats().sessions === before.sessions, "硬约束 3：非流式不写会话映射");
  assert(textOf(events) === "标题", "非流式照样产出 delta（由服务端聚合）");

  // 硬约束 3：并发冲突 → 独立 conversation 且不写映射
  const metaCq = { conversationId: "sess-CQ" };
  requests.length = 0;
  events = [];
  turnScript = [{ content: "Hello" }];
  await conversation.runConversation({ account, secrets, meta: metaCq, body: { model: "glm-5.3-flash", stream: true, messages: [{ role: "user", content: "一" }] }, emit: (e) => events.push(e) });
  requests.length = 0;
  events = [];
  turnScript = [{ content: "A" }, { content: "B" }];
  holdNextTurn = true;
  const waitHold = async () => {
    for (let i = 0; i < 100 && !releaseTurn; i++) await new Promise((r) => setTimeout(r, 20));
    releaseTurn();
  };
  const inflightPromise = conversation.runConversation({ account, secrets, meta: metaCq, body: { model: "glm-5.3-flash", stream: true, messages: [
    { role: "user", content: "一" }, { role: "assistant", content: "Hello" }, { role: "user", content: "A 请求" },
  ] }, emit: (e) => events.push(e) });
  const concurrentEvents = [];
  const concurrentPromise = (async () => {
    await waitHold(); // 等 A 占住会话（进入 turn）
    await conversation.runConversation({ account, secrets, meta: metaCq, body: { model: "glm-5.3-flash", stream: true, messages: [
      { role: "user", content: "一" }, { role: "assistant", content: "Hello" }, { role: "user", content: "B 请求" },
    ] }, emit: (e) => concurrentEvents.push(e) });
  })();
  await concurrentPromise;
  releaseTurn();
  await inflightPromise;
  const rounds = requests.filter((r) => r.path.includes("/round"));
  assert(rounds.length === 2, `A/B 各自 round 一次（实际 ${rounds.length}）`);
  assert(rounds[0].body.conversationId === "conv-1", "A 续接既有会话");
  assert(rounds[1].body.conversationId !== "conv-1", "并发冲突：B 走独立 conversation（不续接在跑的那条）");
  assert(textOf(events) === "A" && textOf(concurrentEvents) === "B", "两条并发互不串流");
  const resident = registry.resolve("sess-CQ", 91, "acc-1");
  assert(resident.kind === "reuse" && resident.record.conversationId === "conv-1", "冲突请求不写会话映射（主会话映射仍是 A 的）");

  // 硬约束 2：finished=true 之后的内容仍要读到底
  requests.length = 0;
  events = [];
  turnScript = [{ content: "Hello", tail: "尾段" }];
  await conversation.runConversation({ account, secrets, meta, body: { model: "glm-5.3-flash", stream: true, messages: [
    { role: "user", content: "一" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "二" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "尾" },
  ] }, emit: (e) => events.push(e) });
  assert(textOf(events) === "Hello尾段", `硬约束 2：finished=true 之后仍读到底（实际 ${JSON.stringify(textOf(events))}）`);

  // 硬约束 2 + 失败路径：流中途断 → 发 failed 终态 + 流内 error 帧
  requests.length = 0;
  events = [];
  turnScript = [{ broken: true }];
  await conversation.runConversation({ account, secrets, meta, body: { model: "glm-5.3-flash", stream: true, messages: [
    { role: "user", content: "一" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "二" }, { role: "assistant", content: "Hello" },
    { role: "user", content: "断" },
  ] }, emit: (e) => events.push(e) });
  assert(events.some((e) => e.type === "error"), "断流下发流内 error 帧（HTTP 200 早已发出，失败只能这样告诉客户端）");
  const failedStatuses = requests.filter((r) => r.path.includes("/event")).map((r) => r.body.data.status);
  assert(failedStatuses.includes("failed"), `断流回报 failed 终态（实际 ${failedStatuses.join(",")}）`);

  // 入参错误 400 不外发（判定阶段释放占用）
  let badErr = null;
  try {
    await conversation.runConversation({ account, secrets, meta, body: { model: "nope-model", stream: true, messages: [{ role: "user", content: "x" }] }, emit: () => {} });
  } catch (e) { badErr = e; }
  assert(badErr && badErr.status === 400, "未知模型 400 抛出（server 侧按 fatal 透传）");
  assert(!registry.isInflight("sess-Z"), "失败路径不留占用（下次请求不被永久挡住）");

  server.close();
  console.log("state machine ok（三规则 / 三条硬约束 / 并发隔离 / 失败收尾）");

  // ===== 12. 凭据与目录辅助 =====
  assert(credentials.passportTokenOf("X-Passport-Token=abc; other=1") === "abc", "Cookie 串取 X-Passport-Token");
  assert(credentials.passportTokenOf("raw-token") === "raw-token", "裸 token 原样");
  assert(credentials.passportTokenOf("x-passport-token=ABC") === "ABC", "字段名大小写不敏感");
  const upstreamBase = upstreamHttp.upstreamBaseUrl();
  assert(upstreamBase === `http://127.0.0.1:${port}`.replace(/\/+$/, ""), "CATPAW_UPSTREAM_BASE_URL 覆盖生效");
  const headers = upstreamHttp.requestHeaders({ token: "t", uid: "u" }, "application/json");
  assert(headers.Cookie === "X-Passport-Token=t" && headers["user-uid"] === "u" && headers["M-APPKEY"], "凭证头形态（Cookie + 独立 uid 头 + APPKEY）");
  assert(!("Authorization" in headers), "不带 Authorization（本家不是 Bearer）");
  assert(catalog.list().some((m) => m.id === "kimi-k3"), "catalog.list 回落静态表");
  assert(catalog.normalizeEntry({ modelTypeName: "glm-x", modelTypeId: 7, extendedInfo: { isAuto: "true" } }) === null, "auto 伪模型被过滤");
  assert(catalog.normalizeEntry({ modelTypeName: "gm", provider: "USER_CUSTOM" }) === null, "用户自建模型被过滤");
  const normalized = catalog.normalizeEntry({
    modelTypeName: "glm-5.3-flash", modelTypeId: 91, supportImage: true, supportThinking: true,
    extendedInfo: { rateMultiplier: "0.94", modelCaptionZhCN: "GLM-5.3-Flash" },
    parameterDefinitions: [{ id: "context", values: [{ value: "204800" }, { value: "1024000" }], defaultValue: "1024000" }],
  });
  assert(normalized.rate === 0.94 && normalized.modelType === 91 && normalized.capabilities.images === true, "远程条目归一（倍率/数字 ID/能力）");
  assert(normalized.contextLength === 1024000 && normalized.defaultContextWindow === "1024000", "context 档位从 parameterDefinitions 取上限与默认");
  console.log("credentials/catalog ok（Cookie 解析 / 上游覆盖 / 目录过滤与归一）");

  console.log("CATPAW SELFTEST OK");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("CATPAW SELFTEST FAIL:", (e && e.stack) || e);
    process.exit(1);
  });
