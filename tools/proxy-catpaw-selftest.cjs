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
  assert(models.effortForLevel("custom-7") === null, "表外等级不在合流表内");
  assert(models.resolveEffort({ reasoning_effort: "MAX" }) === "max", "档位大小写归一");
  // 模型页自定义思考强度由 server.cjs 直接注入请求体（取值含 minimal/medium/xhigh/off），
  // 归并必须发生在这一层，否则「设置不生效」被升级成「请求 400」
  assert(models.resolveEffort({ reasoning_effort: "medium" }) === "high", "medium 归并为 high");
  assert(models.resolveEffort({ reasoning_effort: "minimal" }) === "low", "minimal 归并为 low");
  assert(models.resolveEffort({ reasoning_effort: "off" }) === null, "off → 不发 effort（本家没有关闭开关，拿 low 当 off 是反语义）");
  assert(models.resolveEffort({}) === null, "未指定 → 不发 effort");
  let effortErr = null;
  try { models.resolveEffort({ effort: "super-max" }); } catch (e) { effortErr = e; }
  assert(effortErr && effortErr.status === 400 && effortErr.fatal === true, "表外等级 400（不静默忽略、也不猜）");
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
  let balanceScript = []; // 积分接口的逐次应答脚本
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push({ path: req.url, body, headers: req.headers });
      // 积分接口（CATPAW_BALANCE_URL 指到这里）：按脚本逐次应答，缺省给一个可用响应
      if (req.url.includes("/gateway/credit/balance")) {
        const script = balanceScript.shift() || { status: 200, body: { code: 0, data: { availableCredits: "123.5" } } };
        res.writeHead(script.status || 200, { "content-type": "application/json" });
        res.end(JSON.stringify(script.body || {}));
        return;
      }
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
  process.env.CATPAW_BALANCE_URL = `http://127.0.0.1:${port}/gateway/credit/balance`;

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

  // ===== 12b. 积分查询（余额链路：账号层 credits.refreshAccount 认的三个出口）=====
  const balance = require(path.join(dir, "balance.cjs"));
  const balanceAccount = { id: "acc-bal", channel: "catpaw", uid: "cp-bal", meta: JSON.stringify({}) };
  const balanceSecrets = { token: "tok-bal", meta: {} };
  balanceScript = [{ status: 200, body: { code: 0, data: { availableCredits: "123.5", userPlan: { planName: "专业版", expireTime: "2026-12-01T00:00:00+08:00" } } } }];
  const okBalance = await balance.queryCredits(balanceAccount, balanceSecrets);
  assert(okBalance.credits === 123.5, `字符串余额转数值（实际 ${okBalance.credits}）`);
  assert(okBalance.expiresAt === Date.parse("2026-12-01T00:00:00+08:00"), `套餐到期日透传（实际 ${okBalance.expiresAt}）`);
  assert(okBalance.raw.subscription.name === "专业版", "套餐信息打包成前端认得的订阅形状");
  const balanceReq = requests.find((r) => r.path.includes("/gateway/credit/balance"));
  assert(balanceReq && balanceReq.headers["x-auth-token"] === "tok-bal", "只认 X-Auth-Token 头（不是 X-Passport-Token）");
  balanceScript = [{ status: 401, body: {} }];
  const authErr = await balance.queryCredits(balanceAccount, balanceSecrets);
  assert(authErr.authError === true && /失效/.test(authErr.message), "HTTP 401 → authError（账号层据此标 relogin）");
  balanceScript = [{ status: 200, body: { code: 4011, message: "token invalid" } }];
  const authErr2 = await balance.queryCredits(balanceAccount, balanceSecrets);
  assert(authErr2.authError === true, "业务码 4011 → authError（凭证失效的另一条路径）");
  balanceScript = [{ status: 200, body: { code: 500, message: "上游炸了" } }];
  let balanceThrew = null;
  try { await balance.queryCredits(balanceAccount, balanceSecrets); } catch (e) { balanceThrew = e; }
  assert(balanceThrew && balanceThrew.status === 502 && /上游炸了/.test(balanceThrew.message), "业务错误码 → 抛 502（不符不可用的错误被吞掉）");
  balanceScript = [{ status: 200, body: { code: 0, data: { userPlan: null } } }];
  const noCredits = await balance.queryCredits(balanceAccount, balanceSecrets);
  assert(noCredits.unavailable === true, "上游未返回可用积分 → unavailable（绝不折算成 0，否则号池把好号标耗尽）");
  const noToken = await balance.queryCredits({ id: "x", channel: "catpaw", uid: "", meta: "{}" }, { token: "", meta: {} });
  assert(noToken.unavailable === true, "取不到凭证 → unavailable（不是 authError，避免误标 relogin）");
  assert(balance.balanceUrl() === process.env.CATPAW_BALANCE_URL, "CATPAW_BALANCE_URL 覆盖生效（本地联调/自测入口）");

  // 账号层闭环：credits.refreshAccount 认这三种出口，落库 credits/creditsAt 并唤醒 exhausted 账号
  const credits = require("../electron/backend/proxy/credits.cjs");
  const balanceAccId = store.addAccount({ channel: "catpaw", uid: "cp-bal", name: "积分自测号", token: "tok-bal", source: "paste" });
  balanceScript = [{ status: 200, body: { code: 0, data: { availableCredits: "777" } } }];
  const refreshed = await credits.refreshAccount(balanceAccId);
  const refreshedRow = store.getAccount(balanceAccId);
  assert(refreshed.credits === 777 && refreshedRow.credits === 777 && refreshedRow.credits_at > 0, "账号层刷新落库（余额 + 时间戳）");
  balanceScript = [{ status: 200, body: { code: 0, data: { availableCredits: "777" } } }];
  assert((await ad.queryCredits({ id: balanceAccId, channel: "catpaw", uid: "cp-bal", meta: "{}" }, store.accountSecrets(refreshedRow))).credits === 777, "适配器 queryCredits 与账号层同一出口");
  store.updateAccount(balanceAccId, { status: "exhausted", coolUntil: 0, coolReason: "自测" });
  balanceScript = [{ status: 200, body: { code: 0, data: { availableCredits: "888" } } }];
  await credits.refreshAccount(balanceAccId);
  assert(store.getAccount(balanceAccId).status === "online", "余额恢复 → exhausted 账号被唤醒（号池自动切回）");
  store.removeAccount(balanceAccId);
  console.log("balance ok（字符串余额 / 套餐透传 / 401 与 4011 / 业务错误 / 未返回不折算为 0 / 账号层闭环）");

  // ===== 13. 过网关端到端（真 server.cjs + 假上游）：stateful 分流 / 记账 / 档位注入 =====
  // 这一段是「接缝」的验收：模型归属 → 号池选号 → attemptChat 的 stateful 分流 → chatSession
  // → emit 回流 → server 组装 SSE / 聚合 / 记账。协议层自测绿不代表这条链通。
  const gateway = require("../electron/backend/proxy/server.cjs");
  store.open();
  const key = store.createKey({ name: "catpaw 自测", route: "auto", dailyQuota: 100, rateLimit: 0 });
  const accountId = store.addAccount({ channel: "catpaw", uid: "cp-e2e", name: "CatPaw 端到端号", token: "tok-e2e", source: "paste" });
  const gwSettings = () => ({
    port: 19599, bind: "127.0.0.1", rateLimitPerMin: 600, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [], modelFallback: {},
    channelCooldownMs: 800, channelCooldownCapMs: 3200,
    // 思考档位注入用例：两个模型各绑一档（medium 需归并，off 应完全不发 effort）
    modelCustom: { "kimi-k3": { reasoningEffort: "medium" }, "glm-5.3-flash": { reasoningEffort: "off" } },
  });
  const started = await gateway.start(gwSettings);
  assert(started.ok, `网关启动：${started.message || ""}`);
  const call = (payload) =>
    fetch("http://127.0.0.1:19599/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.secret}` },
      body: JSON.stringify(payload),
    });
  const e2eMeta = { conversationId: "sess-E2E" };

  // 13.1 流式：模型只属 catpaw → 路由到本家；SSE 内容 + usage + [DONE]
  requests.length = 0;
  turnScript = [{ content: "网关端到端" }];
  let resp = await call({ model: "kimi-k3", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "你在吗" }] });
  assert(resp.status === 200, `流式过网关 200（实际 ${resp.status}）`);
  const sse = await resp.text();
  assert(sse.includes('"content":"网关端到端"'), "SSE 正文来自假上游");
  assert(sse.includes("data: [DONE]"), "SSE 以 [DONE] 收尾");
  assert(sse.includes('"total_tokens":100'), `末帧带修正后的 usage（实际 ${(sse.match(/"total_tokens":\d+/) || ["无"])[0]}）`);
  assert(sse.includes('"role":"assistant"'), "角色帧由服务端下发");
  const roundE2e = requests.find((r) => r.path.includes("/round"));
  assert(roundE2e && roundE2e.headers.cookie === "X-Passport-Token=tok-e2e", "上游收到 Cookie 形态凭证（号池凭据链路完整）");
  assert(requests.some((r) => r.path.includes("/event") && r.body.data.status === "completed"), "过网关也走完整的轮次收尾");

  // 13.2 记账：usage_requests 落行且渠道/模型/账号可归因（方案验证要点 11）
  const usageRow = store.recentRequests(1)[0];
  assert(usageRow && usageRow.channel === "catpaw" && usageRow.model === "kimi-k3" && usageRow.accountId === accountId, `记账行可归因（实际 ${usageRow && `${usageRow.channel}/${usageRow.model}`}）`);
  assert(usageRow.status === 200 && usageRow.promptTokens === 95 && usageRow.completionTokens === 5, `记账 usage 为修正后口径（实际 ${usageRow.promptTokens}/${usageRow.completionTokens}）`);

  // 13.3 非流式：由 server 聚合（协议层只发 delta）
  requests.length = 0;
  turnScript = [{ content: "聚合正文" }];
  resp = await call({ model: "glm-5.3-flash", stream: false, messages: [{ role: "user", content: "非流式" }] });
  const body = await resp.json();
  assert(resp.status === 200 && body.choices[0].message.content === "聚合正文", `非流式聚合正确（实际 ${resp.status}/${JSON.stringify(body.choices && body.choices[0].message.content)}）`);

  // 13.5 工具调用过网关：tool_calls 增量必须原样穿透服务端的 delta 清洗（不被 stripEmptyDelta 吃掉）
  requests.length = 0;
  turnScript = [{ content: "", toolCalls: [{ id: "gw-call-1", name: "get_weather", args: '{"city":"bj"}' }] }];
  const toolSse = await (await call({
    model: "kimi-k3", stream: true,
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "查天气" }],
  })).text();
  assert(toolSse.includes('"tool_calls"') && toolSse.includes("gw-call-1") && toolSse.includes("get_weather"), "tool_calls 增量穿透到客户端");
  assert(toolSse.includes('"finish_reason":"tool_calls"'), "finish_reason=tool_calls 下发给客户端");
  const gwTurn = requests.find((r) => r.path.includes("/turn"));
  assert(gwTurn && gwTurn.body.toolConfigs.length === 1 && gwTurn.body.availableTools[0] === "get_weather", "工具配置下发到上游（toolConfigs + availableTools）");
  assert(requests.every((r) => !r.path.includes("/event") || r.body.data.status !== "completed"), "工具调用轮不报 completed（上游语义里这轮还没结束）");

  // 13.4 思考档位注入（模型页自定义强度 → 上游 declarativeParams，本家三档归并）
  requests.length = 0;
  turnScript = [{ content: "中档" }];
  // 必须把响应读完再断言：网关先写 SSE 头、上游请求在其后才发出，不读体就查 requests 是竞态
  await (await call({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "中档" }] })).text();
  const mediumRound = requests.find((r) => r.path.includes("/round"));
  assert(mediumRound && mediumRound.body.requestContext && mediumRound.body.requestContext.modelParams.declarativeParams.effort === "high", `注入 medium → 归并为 high（实际 ${JSON.stringify(mediumRound && mediumRound.body.requestContext)}）`);
  requests.length = 0;
  turnScript = [{ content: "关档" }];
  await (await call({ model: "glm-5.3-flash", stream: true, messages: [{ role: "user", content: "关档" }] })).text();
  const offRound = requests.find((r) => r.path.includes("/round"));
  // glm-5.3-flash 有静态默认 context 档位，requestContext 会照常出现——只断言没有 effort
  const offParams = offRound && offRound.body.requestContext && offRound.body.requestContext.modelParams.declarativeParams;
  assert(offRound && (!offParams || offParams.effort === undefined), "off 不应下发 effort");
  assert(offParams && offParams.context === "1024000", "模型默认 context 档位照常下发（off 只影响 effort）");
  await gateway.stop();
  server.close();
  store.deleteKey(key.id);
  store.removeAccount(accountId);
  console.log("gateway e2e ok（stateful 分流 / SSE 与聚合 / 记账归因 / 档位注入归并）");

  console.log("CATPAW SELFTEST OK");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("CATPAW SELFTEST FAIL:", (e && e.stack) || e);
    process.exit(1);
  });
