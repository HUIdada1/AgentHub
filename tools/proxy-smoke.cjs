// 反代网关后端自测脚本（Electron ELECTRON_RUN_AS_NODE 模式跑，拿到 Node 22 + node:sqlite）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-smoke.cjs <临时数据目录>
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-proxy-test-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const util = require("../electron/backend/proxy/util.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const discovery = require("../electron/backend/proxy/discovery.cjs");

  // 1. 数据库 + 种子
  store.open();
  console.log("db driver:", store.driver());
  assert(store.listAgents().length === store.CHANNELS.length, `渠道种子数 = CHANNELS 数（${store.CHANNELS.length}：${store.CHANNELS.map((c) => c.id).join("/")}）`);

  // 2. Key 全链路
  const k = store.createKey({ name: "自测", route: "auto", dailyQuota: 10, rateLimit: 0 });
  assert(k.secret.startsWith("sk-") && k.secret.length === 51, "sk- + 48 hex");
  const found = store.findKeyBySecret(k.secret);
  assert(found && found.name === "自测", "哈希查找命中");
  assert(!store.findKeyBySecret("sk-wrong"), "错误 Key 不命中");
  store.updateKey(k.id, { enabled: false, dailyQuota: 99 });
  assert(store.findKeyBySecret(k.secret).enabled === false, "停用即时生效");
  store.updateKey(k.id, { enabled: true });

  // 3. 账号 + 号池
  const aid = store.addAccount({ channel: "trae", uid: "u1", name: "测试号", token: "tok", refreshToken: "ref", source: "paste", expiresAt: Date.now() + 86400000 });
  store.updateAccount(aid, { credits: 500, creditsAt: Date.now() });
  const pick = pool.pickAccount("trae", "expire_first", []);
  assert(pick && pick.name === "测试号", "池内选号");
  const summary = pool.poolSummary("trae");
  assert(summary.totalCredits === 500 && summary.onlineCount === 1, "号池聚合");
  assert(pool.poolSummary("workbuddy").onlineCount === 0 && pool.poolSummary("workbuddy_ai").onlineCount === 0, "其余渠道空池");
  const sec = store.accountSecrets(store.getAccount(aid));
  assert(sec.token === "tok" && sec.refreshToken === "ref", "凭据加解密往返");
  pool.coolAccount(aid, "rate");
  assert(pool.poolAccounts("trae")[0].status === "cooling", "429 冷却 60s");
  assert(!pool.pickAccount("trae", "expire_first", []), "冷却账号不参与调度");
  pool.coolAccount(aid, "credit");
  assert(store.getAccount(aid).status === "exhausted", "402 耗尽至次日");
  pool.coolAccount(aid, "rate"); // 最终保持 cooling，供 healthz 503 断言用

  // 4. 规则热加载
  rules.init();
  assert(Object.keys(rules.get("model_map.json")).length >= 5, "model_map 默认表");
  assert(rules.list().every((r) => r.ok), "规则文件全部可解析");
  assert(fs.existsSync(rules.rulesDir()), "rules 目录已创建");

  // 5. 适配器改写
  const trae = adapters.get("trae");
  const tb = trae.rewriteBody("deepseek-v4-flash", {
    model: "deepseek-v4-flash",
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: { a: 1 } } }, { id: "c2", type: "function", function: { name: "", arguments: "{}" } }] },
    ],
    tools: [{ type: "function", function: { name: "fn", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "fn" } },
    stream: false,
  }, { id: "acc1", uid: "u1" });
  assert(tb.config_name === "DeepSeek-V4-Flash" && tb.model === "DeepSeek-V4-Flash", "模型映射（config_name/model 同值）");
  assert(tb.stream === true && tb.function === "solo_work_lite" && tb.workspace_id === "e04cdd" && tb.mode === "FunctionCall", "必填注入");
  // function 字段按模型分发（参考项目实证：部分模型仅在 solo_agent 下可用）
  const tAgent = trae.rewriteBody("glm-5.3-flash", { model: "glm-5.3-flash", messages: [{ role: "user", content: "x" }] }, { id: "acc1", uid: "u1" });
  assert(tAgent.function === "solo_agent", "function 分发：glm-5.3-flash → solo_agent");
  assert(Array.isArray(tb.messages[0].content) && tb.messages[0].content[0].type === "text", "内容数组化");
  assert(tb.messages[1].tool_calls.length === 1 && tb.messages[1].tool_calls[0].function_call.name === "fn", "tool_calls 改写 + 空 name 剔除");
  assert(typeof tb.tools[0].function.parameters === "string", "parameters 序列化");
  assert(tb.tool_choice === "fn", "tool_choice 归一");
  const th = trae.headers({ id: "acc1" }, { token: "jwt123" });
  assert(th.authorization === "Cloud-IDE-JWT jwt123" && th["x-ide-token"] === "jwt123" && th["x-device-id"], "Trae 认证头");

  const wb = adapters.get("workbuddy");
  const wbody = wb.rewriteBody("gpt-5", {
    model: "gpt-5",
    messages: [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI.", cc_trace: "x", "x-anthropic-billing": 1 },
      { role: "user", content: "hi" },
      { role: "user", content: "merge me" },
      // 孤儿 tool 会被清理（11128 修复）：测试里的 tool 必须带上对应 assistant tool_calls
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "f2", arguments: "{}" } }] },
      { role: "tool", content: "keep", tool_call_id: "c1" },
      { role: "tool", content: "separate", tool_call_id: "c2" },
    ],
    tool_choice: { type: "function", function: { name: "f" } },
    max_completion_tokens: 100,
  });
  assert(wbody.max_tokens === 100 && !("max_completion_tokens" in wbody), "max_completion_tokens → max_tokens 翻译");
  assert(wbody.stream === true, "WB 强制流式");
  assert(wbody.tool_choice === "f", "WB tool_choice 对象→string");
  assert(!("cc_trace" in wbody.messages[0]) && !("x-anthropic-billing" in wbody.messages[0]), "指纹键剥离");
  assert(wbody.messages[0].content.includes("CodeBuddy"), "模板最小改写");
  assert(
    wbody.messages.length === 5 && wbody.messages[1].content.includes("merge me") && wbody.messages[3].content === "keep" && wbody.messages[4].content === "separate",
    "连续同角色合并（tool 例外，孤儿 tool 清理）"
  );
  const wh = wb.headers({ uid: "u9" }, { token: "wbtoken" });
  assert(
    wh.authorization === "Bearer wbtoken" && wh["x-product"] === "WorkBuddy" && wh["x-agent-purpose"] === "conversation" && wh["x-codebuddy-request"] === "1" && !("x-refresh-token" in wh),
    "WB 头矩阵（桌面端指纹，无 X-Refresh-Token 红线）"
  );
  assert(wh["user-agent"].includes("WorkBuddy"), "UA 伪装");
  assert(typeof wbody.prompt_cache_key === "string" && wbody.prompt_cache_key.startsWith("agenthub-"), "prompt_cache_key 注入");
  // deepseek thinking（参考项目 thinking.go：开思考必须显式 enabled + 默认档，否则无思维链）
  const wDeep = wb.rewriteBody("deepseek-v3.2", { model: "deepseek-v3.2", messages: [{ role: "user", content: "hi" }] });
  assert(wDeep.thinking && wDeep.thinking.type === "enabled" && wDeep.reasoning_effort === "high", "deepseek thinking 注入");
  // 连续同角色合并不丢多模态 part（修复：压扁数组会丢 image_url）
  const wMulti = wb.rewriteBody("gpt-5", {
    model: "gpt-5",
    messages: [
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "http://img/x.png" } }] },
      { role: "user", content: "再看这张" },
    ],
  });
  assert(wMulti.messages.length === 2 && Array.isArray(wMulti.messages[0].content) && wMulti.messages[0].content.some((p) => p.type === "image_url"), "合并不丢多模态 part");
  // 工具结果组重排（参考项目 repackToolResultBlocks）：夹在 tool_calls 与 tool 结果之间的消息挪到组后
  const wPack = wb.rewriteBody("gpt-5", {
    model: "gpt-5",
    messages: [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "user", content: "夹在中间的通知" },
      { role: "tool", content: "ok", tool_call_id: "c1" },
    ],
  });
  assert(wPack.messages[0].role === "assistant" && wPack.messages[1].role === "tool" && wPack.messages[2].role === "user" && wPack.messages[2].content.includes("夹在中间"), "工具组重排：tool 在非 tool 消息前");

  // ===== 角色归一（issue #47）=====
  // 入口 util.normalizeRoles 负责把 role 收敛到各渠道上游白名单的交集，
  // 否则「workbuddy 拒 developer / raccoon 拒 function」在 400 渠道回退下表现为
  // 「trace 一用就断、且复现不稳定」。这里锁住映射规则本身。
  const nrOut = util.normalizeRoles([
    { role: "developer", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "function", content: "legacy result", name: "f" },                 // 无 tool_call_id → user
    { role: "function", content: "typed result", tool_call_id: "c1" },          // 有 tool_call_id → tool
  ]);
  assert(nrOut[0].role === "system", "developer → system");
  assert(nrOut[1].role === "user", "user 原样保留");
  assert(nrOut[3].role === "user" && nrOut[3].content === "legacy result", "legacy function（无 tool_call_id）→ user，content 不丢");
  assert(nrOut[4].role === "tool" && nrOut[4].tool_call_id === "c1", "function（带 tool_call_id）→ tool");
  // 幂等 + 非法输入不抛：归一后重复调用不得二次改写
  const nrTwice = util.normalizeRoles(nrOut);
  assert(nrTwice === nrOut && nrTwice.every((m) => ["system", "user", "assistant", "tool"].includes(m.role)), "归一后 role 全在交集内且幂等");
  assert(util.normalizeRoles(null) === null, "normalizeRoles 对非数组原样返回");
  assert(util.normalizeRoles([null, "x", { noRole: 1 }]) !== undefined, "非法消息项不抛（不因此拒绝请求）");
  // 未知 role：保持原样不猜语义，但必须留下 warning，不再无声丢弃
  const nrWarn = [];
  const nrRealWarn = console.warn;
  console.warn = (...a) => { nrWarn.push(a.join(" ")); };
  let nrUnknown;
  try {
    nrUnknown = util.normalizeRoles([
      { role: "tool_result", content: "a" },
      { role: "user", content: "hi" },
      { role: "tool_result", content: "b" },   // 同 role 重复 → 应合并计数
      { role: "__bogus__", content: "c" },
    ]);
  } finally {
    console.warn = nrRealWarn;
  }
  assert(nrUnknown[0].role === "tool_result" && nrUnknown[3].role === "__bogus__", "未知 role 保持原样（不猜语义、不改写）");
  assert(nrWarn.length === 1 && nrWarn[0].includes("tool_result") && nrWarn[0].includes("__bogus__") && nrWarn[0].includes("×2"), "未知 role 记 warning 且同 role 合并计数（长会话不刷屏）");
  const nrWarnClean = [];
  console.warn = (...a) => { nrWarnClean.push(a.join(" ")); };
  try { util.normalizeRoles([{ role: "system", content: "s" }, { role: "user", content: "u" }]); } finally { console.warn = nrRealWarn; }
  assert(nrWarnClean.length === 0, "全部已知 role 时不产生 warning 噪音");
  // 交集角色的大小写/首尾空白变体无损归一为小写（上游枚举校验区分大小写）
  const nrCase = util.normalizeRoles([{ role: "User", content: "a" }, { role: " ASSISTANT ", content: "b" }, { role: "System", content: "c" }]);
  assert(nrCase[0].role === "user" && nrCase[1].role === "assistant" && nrCase[2].role === "system", "大小写/空白变体（User/ASSISTANT/System）归一为小写");
  // 归一后各渠道的 rewriteBody 都不再收到白名单外角色（trae / raccoon 均不做 developer 归一）
  const nrBody = util.normalizeRoles([
    { role: "developer", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  const nrTrae = adapters.get("trae").rewriteBody("Doubao-Seed-2.1-Pro", { model: "Doubao-Seed-2.1-Pro", messages: nrBody.map((m) => ({ ...m })) }, { id: "acc1", uid: "u1" });
  const nrRaccoon = adapters.get("raccoon").rewriteBody("raccoon-chat-ml-5-5", { model: "raccoon-chat-ml-5-5", messages: nrBody.map((m) => ({ ...m })) });
  const nrOk = (out) => out.messages.every((m) => ["system", "user", "assistant", "tool"].includes(m.role));
  assert(nrOk(nrTrae) && nrOk(nrRaccoon), "归一后 trae / raccoon 均只收到交集角色");
  // 静默丢消息的两条路径也一并被堵住：qoderAdapter.toQoderMessages 对交集外 role
  // 直接 continue（无报错、消息消失），zcodeAnthropic 把 developer 并进 system、
  // 但 legacy function 会被静默丢弃。归一后两者都拿得到完整内容。
  const qoderAdapter = require("../electron/backend/proxy/qoderAdapter.cjs");
  const zcodeAnthropic = require("../electron/backend/proxy/zcodeAnthropic.cjs");
  const nrLegacy = util.normalizeRoles([
    { role: "developer", content: "sys-directive" },
    { role: "user", content: "hi" },
    { role: "function", content: "legacy-result", name: "f" },
  ]);
  const qMsgs = qoderAdapter.toQoderMessages(nrLegacy);
  const qText = JSON.stringify(qMsgs);
  assert(qMsgs.length === 3 && qText.includes("sys-directive") && qText.includes("legacy-result"), "qoder：归一后 developer/function 不再被 toQoderMessages 静默丢弃");
  const zOut = zcodeAnthropic.toAnthropic("glm-5.3-flash", { model: "glm-5.3-flash", messages: nrLegacy.map((m) => ({ ...m })) });
  const zText = JSON.stringify(zOut);
  assert(zText.includes("sys-directive") && zText.includes("legacy-result"), "zcode：归一后 developer 并入 system、legacy function 不再被丢弃");
  console.log("role layer ok（developer→system / function→tool|user / 幂等 / 非法输入不抛 / qoder+zcode 静默丢弃已堵）");

  assert(adapters.mergedModels().length > 5, "合并模型目录");
  assert(adapters.modelOwners("gpt-5").length === 1 && adapters.modelOwners("gpt-5")[0] === "workbuddy", "gpt-5 归属 CN workbuddy（AI 区目录已无此型号）");
  assert(adapters.modelOwners("deepseek-v4.1-flash").length === 1 && adapters.modelOwners("deepseek-v4.1-flash")[0] === "workbuddy_ai", "deepseek-v4.1-flash 归属国际版 workbuddy_ai");
  assert(adapters.modelOwners("deepseek-v4-flash")[0] === "trae", "单源模型归属");

  // ===== 商汤小浣熊（raccoon 渠道）离线断言 =====
  const rc = adapters.get("raccoon");
  assert(rc && rc.id === "raccoon", "raccoon 适配器注册");
  assert(store.CHANNELS.some((c) => c.id === "raccoon"), "store.CHANNELS 含 raccoon");
  assert(adapters.modelOwners("raccoon-chat-ml-5-5")[0] === "raccoon", "raccoon-chat-ml-5-5 归属 raccoon");

  // ===== Qoder 注册 =====
  // 与既有渠道的关键差异：签名是每请求的（wasm 驱动），headers() 只返回非签名基础头。
  // qoder_intl 暂停启用（store.QODER_INTL_ENABLED）——断言按开关实际状态校验，
  // 防止「隐藏渠道仍参与路由」的静默回归（ADAPTERS 参与 modelOwners）。
  const qd = adapters.get("qoder");
  assert(qd && qd.id === "qoder", "qoder 适配器注册");
  assert(store.CHANNELS.some((c) => c.id === "qoder"), "store.CHANNELS 含 qoder");
  const intlOn = !!store.QODER_INTL_ENABLED;
  assert(!!adapters.get("qoder_intl") === intlOn, `qoder_intl 适配器注册状态与开关(${intlOn}) 一致`);
  assert(store.CHANNELS.some((c) => c.id === "qoder_intl") === intlOn, `CHANNELS 中 qoder_intl 与开关一致`);
  const qoderList = [["qoder", qd, "https://gateway.qoder.com.cn"]];
  if (intlOn) qoderList.push(["qoder_intl", adapters.get("qoder_intl"), "https://api2.qoder.sh"]);
  for (const [id, ad, gw] of qoderList) {
    const need = ["cfg", "models", "fetchModels", "headers", "rewriteBody", "chat", "queryCredits", "refreshToken"];
    assert(need.every((k) => typeof ad[k] === "function"), `${id} 适配器十件套齐备`);
    assert(ad.cfg().gateway === gw, `${id} cfg.gateway 指向 ${gw}`);
    assert(ad.models().length >= 14, `${id} 静态模型表 ≥14`);
    // headers() 必须**不含** Authorization：签名由 chat() 内 wasm 现场产出，
    // 静态头里出现 Authorization 即为「照抄 WB 静态头组」的错误实现
    const h = ad.headers();
    assert(!("authorization" in h) && !("Authorization" in h), `${id} headers() 不含 Authorization（签名下沉 chat()）`);
    assert(typeof h["user-agent"] === "string" && h.accept === "text/event-stream", `${id} headers() 基础头正确`);
  }
  // 模型归属：INTL 关闭时 dfmodel 必须只归 qoder（残留双归属会路由到无账号渠道）
  const dfOwners = adapters.modelOwners("dfmodel");
  if (intlOn) {
    assert(dfOwners.length === 2 && dfOwners.includes("qoder_intl"), "dfmodel 归属 Qoder 双区（多归属→打分路由）");
  } else {
    assert(dfOwners.length === 1 && dfOwners[0] === "qoder", "dfmodel 仅归 qoder（INTL 关闭时无幽灵归属）");
  }
  const qModels = qd.models();
  for (const other of ["trae", "workbuddy", "workbuddy_ai", "raccoon", "zcode"]) {
    const om = adapters.get(other).models();
    const clash = qModels.filter((m) => om.includes(m));
    assert(clash.length === 0, `qoder 模型与 ${other} 零重名（无路由歧义）`);
  }
  const qBody = qd.rewriteBody("dfmodel", { messages: [{ role: "user", content: "hi" }], temperature: 0.2 }, { uid: "u" }, {});
  assert(qBody.model_config && qBody.model_config.key === "dfmodel" && qBody.model_config.format === "openai", "qoder rewriteBody 产出 QoderInferRequest");
  assert(qBody.request_id === qBody.request_set_id && Array.isArray(qBody.messages) && Array.isArray(qBody.tools), "qoder rewriteBody 结构正确");
  assert(qBody.messages[0].content[0].type === "text" && qBody.temperature === 0.2, "qoder rewriteBody 消息归一 + 采样参数透传");
  assert(rc.mapModel("raccoon-chat") === "raccoon-chat-ml-5-5" && rc.mapModel("raccoon-chat-ml") === "raccoon-chat-ml-5-5", "raccoon 模型别名归一");
  const rbody = rc.rewriteBody("raccoon-chat", { model: "raccoon-chat", conversation_id: "x", prompt_cache_key: "y", messages: [{ role: "user", content: "hi" }], temperature: 0.7 });
  assert(rbody.model === "raccoon-chat-ml-5-5" && rbody.stream === true && rbody.stream_options.include_usage === true, "raccoon rewriteBody 强制流式+include_usage");
  assert(!("conversation_id" in rbody) && !("prompt_cache_key" in rbody) && rbody.temperature === 0.7, "raccoon rewriteBody 剥内部字段、标准字段透传");
  // 与桌面端共用 auth.json 的双向同步（掉登录根因修复）：
  // ① refresh 端点专用头组不带 authorization（只凭 refresh_token，会话1 §1.3）；
  // ② fetchModels 对 401 返回 authError 交由上层刷新重试，而非直接判失败；
  // ③ 预刷新窗口贴官方 300s，避免每轮额度刷新都抢刷同一个 refresh_token
  assert(rc.refreshWindowSec === 300, "raccoon 预刷新窗口 = 300s");
  const raccoonAuth = require(path.join(__dirname, "..", "electron", "backend", "proxy", "raccoonAuth.cjs"));
  assert(raccoonAuth.AUTH_KEYS.length === 3 && raccoonAuth.AUTH_KEYS.includes("refresh_token"), "raccoonAuth 凭据三键");
  assert(typeof raccoonAuth.ownedTokens === "function" && typeof raccoonAuth.tokenUid === "function", "raccoonAuth 归属校验接口");
  assert(raccoonAuth.ownedTokens("someone", "") === null || raccoonAuth.ownedTokens("someone", "") === undefined, "无本地文件时 ownedTokens 不认领");
  const rcUid = raccoonAuth.tokenUid("x." + Buffer.from(JSON.stringify({ iss: "6f66ba", sid: "9a" })).toString("base64url") + ".y");
  assert(rcUid === "6f66ba", "raccoonAuth.tokenUid 认 iss（与 scanRaccoon 同口径）");
  // ④ OAuth 登录支持：v1.32.0 起主路径是「内嵌授权窗 + 深链截获」——beginOAuth 由后端自己开窗
  //    （所以不再回传 url），手动粘贴深链降为兜底。此前断言的 mode="manual" / url 是 v1.18.0
  //    手动粘贴时代的形态，升级时漏改，已按现状修正。
  const raccoonBegin = await discovery.beginOAuth("raccoon", () => {});
  assert(raccoonBegin.ok === true && raccoonBegin.mode === "window", "raccoon OAuth 主路径为内嵌授权窗（mode=window）");
  // 手动兜底仍在：粘贴不是深链的内容应被本地拦下（纯解析，不发任何网络请求）
  const raccoonPaste = await discovery.submitCallbackUrl("not-a-deeplink");
  assert(raccoonPaste.ok === false && /授权码/.test(raccoonPaste.message || ""), "raccoon 手动粘贴深链兜底可用（无授权码时如实拦截）");
  discovery.cancelOAuth();
  // ⑤ 401 旋转竞态重试（针头：值变了才重试，没变不原地打转）
  // 这个行为留在集成测试里跑（需要打点 fetch 与文件），smoke 只验证接口存在
  console.log("raccoon adapter ok");

  // 6. 统计链路
  store.insertUsage({ reqId: "r1", keyId: k.id, keyName: "自测", channel: "trae", accountId: aid, accountName: "测试号", model: "deepseek-v4-flash", promptTokens: 10, completionTokens: 20, ttftMs: 100, latencyMs: 500, status: 200 });
  store.insertUsage({ reqId: "r2", keyId: k.id, keyName: "自测", channel: "workbuddy", model: "gpt-5", promptTokens: 5, completionTokens: 5, ttftMs: 50, latencyMs: 200, status: 429, error: "rate limited" });
  const today = store.statsToday();
  assert(today.req === 2 && today.tokens === 40 && today.successRate === 50, "今日指标");
  assert(store.statsTrend(7).length === 7, "7 日趋势桶");
  assert(store.statsTop("channel", 7).length === 2, "渠道 TOP");
  assert(store.statsDetail({ page: 1, pageSize: 10 }).total === 2, "明细分页");
  assert(store.recentRequests(5).length === 2, "实时请求流");
  assert(store.keyTodayReq(k.id) === 2, "Key 日配额计数");
  store.snapshotCredits("trae", aid, 500, 0);
  store.snapshotCredits("trae", aid, 480, 0); // 同日覆盖
  console.log("stats ok");

  // 7. SSE 扫描与聚合
  const events = [];
  const sc = new util.SseScanner((ev, data) => events.push([ev, data]));
  sc.feed('event: output\ndata: {"response":"he');
  sc.feed('llo"}\n\n: keep-alive\n\nevent: done\ndata: {}\n\n');
  assert(events.length === 2 && events[0][0] === "output", "SSE 分块重组 + keep-alive 跳过");
  // 紧凑流兼容（参考项目 wb_sse 实证）：无空行分隔的连续 data: 也应逐条产出，不等 EOF
  const compact = [];
  const sc2 = new util.SseScanner((ev, data) => compact.push([ev, data]));
  sc2.feed('data: {"a":1}\ndata: {"b":2}\ndata: [DONE]\n');
  assert(compact.length === 3 && compact[2][1] === "[DONE]", "紧凑流不等空行逐条产出");
  const agg = new util.Aggregator("r1", "m");
  agg.pushDelta({ content: "hi" });
  agg.pushDelta({ tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: "{\"a\":" } }] });
  agg.pushDelta({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] });
  const ar = agg.result();
  assert(ar.choices[0].message.tool_calls[0].function.arguments === '{"a":1}', "tool_calls 按 index 合并");

  // 8. discovery（本机扫描不崩即可，命中与否取决于环境）
  const scanFound = discovery.scanAll();
  console.log("scan candidates:", scanFound.length);

  // 9. 网关服务端到端（Express 缺失时跳过 HTTP 层，提示 npm install）
  try {
    require.resolve("express");
  } catch {
    console.log("SKIP HTTP 层：express 未安装（npm install 后可测）");
    store.deleteKey(k.id);
    store.removeAccount(aid);
    console.log("SMOKE OK（除 HTTP 层）");
    return;
  }
  const server = require("../electron/backend/proxy/server.cjs");
  const settings = () => ({ port: 19527, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8, routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: true });
  const sr = await server.start(settings);
  assert(sr.ok, "网关启动: " + (sr.message || ""));
  const base = "http://127.0.0.1:19527";
  // healthz 语义：无健康渠道 503。此刻唯一账号 cooling → 应 503
  let r = await fetch(base + "/healthz");
  assert(r.status === 503, "无健康渠道 healthz 503（唯一账号冷却中）— 实际: " + r.status);
  r = await fetch(base + "/v1/models");
  assert(r.ok && (await r.json()).data.length > 5, "/v1/models");
  r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(r.status === 401, "无 Key 401");
  const errBody = await r.json();
  assert(errBody.error && errBody.error.code === "invalid_api_key", "OpenAI 同构错误");
  r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + k.secret }, body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }) });
  assert(r.status === 400, "messages 空 400");
  r = await fetch(base + "/status");
  const stBody = await r.text();
  assert(r.ok, "debugStatus 开启时 /status 可访问（回环）— 实际: " + r.status + " " + stBody.slice(0, 120));
  // 有效 Key + 无可用账号 → 503（账号冷却中）
  r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + k.secret }, body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }) });
  assert(r.status === 503 || r.status === 200, "号池无可用账号 503（流式则 200+错误chunk）: " + r.status);
  server.stop();
  console.log("http layer ok");

  // 10. 假上游端到端：换号 / 两种自动切换 / 流式与非流式 / 指纹头完整下发
  const http = require("node:http");
  const seenHeaders = { trae: null, wb: null };
  let flaky429Hits = 0; // 10.4d 用：记录上游被真实打了几次，证明退避重放确实发生
  const fake = http.createServer((req, res) => {
    const url = req.url || "";
    let reqBody = "";
    req.on("data", (c) => (reqBody += c));
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      if (url.includes("/trae/")) {
        seenHeaders.trae = req.headers;
        // 上游 5xx：验证单次不罚号、连续 3 次才熔断（必须在写 200 头之前返回）
        if (url.includes("/servererr")) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":{"message":"upstream boom"}}');
          return;
        }
        // 无明示重置时间的 429：首枪 429、第二枪放行，验证同号退避重试就地消化
        if (url.includes("/flaky429")) {
          flaky429Hits++;
          if (flaky429Hits === 1) {
            res.writeHead(429, { "content-type": "application/json" });
            res.end('{"error":{"message":"too many requests"}}');
            return;
          }
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (url.includes("/broken")) {
          // 流中途掐断：先让 Hello 真正送达网关，再杀连接（立即 destroy 会把缓冲整段 RST，网关收不到字节）
          res.write('event: output\ndata: {"response":"Hello"}\n\n');
          setTimeout(() => res.destroy(), 200);
          return;
        }
        if (url.includes("/misconfig")) {
          // 4001 模型配置为空：验证不罚号（账号保持 online）
          res.end('event: error\ndata: {"code":4001,"message":"model config is empty"}\n\n');
          return;
        }
        if (auth.includes("bad-token")) {
          // 积分不足 PlanLimit（1005）：应触发换号
          res.end('event: error\ndata: {"code":1005,"message":"credits insufficient"}\n\n');
          return;
        }
        res.end(
          "event: metadata\n" + 'data: {"conversation_id":"c1"}\n\n' +
          "event: output\n" + 'data: {"response":"Hello"}\n\n' +
          "event: output\n" + 'data: {"response":" world"}\n\n' +
          "event: token_usage\n" + 'data: {"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}\n\n' +
          "event: done\n" + 'data: {"finish_reason":"stop"}\n\n'
        );
        return;
      }
      if (url.includes("/wb/")) {
        seenHeaders.wb = req.headers;
        if (auth.includes("wb-bad")) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end('{"error":{"message":"insufficient credits"}}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"role":"assistant","content":"WB"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"content":" ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
          "data: [DONE]\n\n"
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r2) => fake.listen(19530, "127.0.0.1", r2));
  // 规则热加载：把上游指到假服务（同时验证 rules 外置热加载链路）
  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersBackup = fs.readFileSync(headersPath, "utf8");
  const headersCfg = JSON.parse(headersBackup);
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/chat";
  headersCfg.trae.mirrorChatUrl = "";
  headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19530/wb/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // 两个 Trae 账号：坏号（1005）先到期排前面，好号在后 → 验证 402/1005 换号
  const badTrae = store.addAccount({ channel: "trae", uid: "bad", name: "坏号", token: "bad-token", source: "paste", expiresAt: Date.now() + 3600000 });
  const goodTrae = store.addAccount({ channel: "trae", uid: "good", name: "好号", token: "good-token", source: "paste", expiresAt: Date.now() + 7200000 });
  const e2eDisabledFlag = [];
  const e2eSettings = () => ({ port: 19529, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8, routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false, disabledModels: e2eDisabledFlag, modelFallback: { "not-exist-model": "deepseek-v4-flash" }, channelCooldownMs: 800, channelCooldownCapMs: 3200 });
  const sr2 = await server.start(e2eSettings);
  assert(sr2.ok, "E2E 网关启动: " + (sr2.message || ""));
  const base2 = "http://127.0.0.1:19529";
  const call = (payload) =>
    fetch(base2 + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify(payload),
    });

  // 10.1 流式：坏号 1005 → 自动换好号，客户端无感（error chunk 不下发）
  let rr = await call({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert(rr.status === 200, "流式 200: " + rr.status);
  const sseText = await rr.text();
    assert(sseText.includes('"content":"Hello"') && sseText.includes('"content":" world"'), "SSE 内容来自好号");
  assert(sseText.includes("data: [DONE]"), "SSE [DONE]");
  assert(sseText.includes('"total_tokens":12'), "末 chunk 带 usage");
  assert(!sseText.includes("1005") && !sseText.includes("credits insufficient"), "换号前的错误不泄给客户端");
  assert(store.getAccount(badTrae).status === "exhausted", "1005 → 坏号标耗尽");
  const usageRows = store.recentRequests(1);
  assert(usageRows[0].status === 200 && usageRows[0].accountName === "好号" && usageRows[0].promptTokens === 7, "流水记录好号 + usage");

  // 10.2 非流式：本地聚合
  rr = await call({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] });
  const aggBody = await rr.json();
  assert(aggBody.object === "chat.completion" && aggBody.choices[0].message.content === "Hello world", "非流式聚合: " + JSON.stringify(aggBody).slice(0, 120));
  assert(aggBody.usage.total_tokens === 12, "非流式 usage");

  // 10.3 Trae 指纹头完整下发（防监测逐字段核对）
  const th2 = seenHeaders.trae;
  for (const h of ["authorization", "x-ide-token", "x-app-id", "x-ide-version", "x-device-id", "x-machine-id", "x-tt-trace-id", "x-custom-trace-id", "x-flow-traceparent", "x-lscbd-aid", "x-ss-dp", "x-lgw-req-sdk-type", "referer", "package-type"]) {
    assert(th2[h], "Trae 指纹头缺失: " + h);
  }
  assert(String(th2.authorization).startsWith("Cloud-IDE-JWT "), "Authorization 前缀");
  assert(/^00-[0-9a-f]{32}-[0-9a-f]{32}-01$/.test(String(th2["x-tt-trace-id"])), "trace id 格式");
  assert(th2.referer === "http://127.0.0.1:19530/trae/chat", "Trae referer 与请求 URL 同源伪装");

  // 10.4 WB：402 → 自动换号 + 头红线（绝不带 X-Refresh-Token）
  const badWb = store.addAccount({ channel: "workbuddy", uid: "wbbad", name: "WB坏号", token: "wb-bad", source: "paste", expiresAt: Date.now() + 3600000 });
  const goodWb = store.addAccount({ channel: "workbuddy", uid: "wbgood", name: "WB好号", token: "wb-good", source: "paste", expiresAt: Date.now() + 7200000 });
  rr = await call({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] });
  const wbText = await rr.text();
  assert(rr.status === 200 && wbText.includes('"content":"WB"') && wbText.includes("data: [DONE]"), "WB 换号后流式输出: " + wbText.slice(0, 100));
  assert(store.getAccount(badWb).status === "exhausted", "402 → WB 坏号标耗尽");
  assert(!("x-refresh-token" in seenHeaders.wb), "WB chat 请求绝不携带 X-Refresh-Token");
  assert(String(seenHeaders.wb["user-agent"]).includes("WorkBuddy"), "WB UA 伪装");
  // 官方桌面端指纹：Origin/Referer 按域名常量（CN=codebuddy.cn），不随请求 URL 变
  assert(seenHeaders.wb.origin === "https://www.codebuddy.cn" && seenHeaders.wb.referer === "https://www.codebuddy.cn/", "WB Origin/Referer 官方域名指纹");
  // X-Domain 与 X-No-Department-Info 互斥（无 domain 时显式占位，不并存）
  assert(seenHeaders.wb["x-no-department-info"] === "1" && !seenHeaders.wb["x-domain"], "无 domain → X-No-Department-Info 占位");
  store.updateAccount(goodWb, { meta: { domain: "example.corp", enterpriseId: "ent-1" } });
  rr = await call({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] });
  await rr.text();
  assert(seenHeaders.wb["x-domain"] === "example.corp" && !seenHeaders.wb["x-no-department-info"], "有 domain → X-Domain 真值");
  assert(seenHeaders.wb["x-enterprise-id"] === "ent-1", "X-Enterprise-Id 来自 meta");

  // 10.4a 流中途异常：已输出的内容绝不换号重发，就地错误收尾（修复：内容重复拼接）
  const brokenTrae = store.addAccount({ channel: "trae", uid: "broken", name: "断流号", token: "broken-token", source: "paste", expiresAt: Date.now() + 7200000 });
  pool.coolAccount(goodTrae, "rate");
  pool.coolAccount(badTrae, "rate");
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/broken";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");
  rr = await call({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] });
  const brokenText = await rr.text();
  assert(rr.status === 200 && brokenText.includes('"content":"Hello"'), "断流场景 200（已输出后收尾）");
  assert((brokenText.match(/content":"Hello"/g) || []).length === 1, "已输出内容不重复（不换号重发）: " + brokenText.slice(0, 200));
  assert(brokenText.includes("upstream_error") && brokenText.includes("data: [DONE]"), "断流后错误收尾 + [DONE]");
  pool.coolAccount(brokenTrae, "rate");

  // 10.4b 4001 模型配置为空：不罚号（账号保持 online），请求按上游错误收尾后由客户端重试
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/misconfig";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");
  const misCfg = store.addAccount({ channel: "trae", uid: "mis", name: "配置错号", token: "mis-token", source: "paste", expiresAt: Date.now() + 7200000 });
  rr = await call({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] });
  assert(rr.status === 502, "4001 按上游错误收尾: " + rr.status);
  assert(store.getAccount(misCfg).status === "online", "4001 不罚号（账号保持 online）");
  // 10.4b 的夹具账号用完即回收：它 creditsAt=0（未知余额）不参与零余额跳过，
  // 留在池里会让 10.5~10.7 的调度断言撞上 pickAccount 的 100ms 防惊群让位，结果随节奏漂移
  store.removeAccount(misCfg);
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // 10.4c server 类错误（5xx/网络/超时）：单次不罚号，连续 3 次真实命中才熔断；
  // 渠道级在连败 2 次「真实尝试后打光」时降级（channelCooldownMs=800 压缩节奏），
  // 等降级过期后第三次真实命中账号 → 账号计数 3 熔断——两层保护节奏互不冒充
  // 对应 issue #2 场景二——一次首字节超时即罚 10 分钟，会把整个号池直接打空成 503
  const srvAcc = store.addAccount({ channel: "trae", uid: "srv", name: "抖动号", token: "srv-token", source: "paste", expiresAt: Date.now() + 7200000 });
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/servererr";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");
  for (let i = 1; i <= 2; i++) {
    rr = await call({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] });
    assert(rr.status >= 500, `第 ${i} 次 5xx 按上游错误收尾（状态码原样透传）: ` + rr.status);
    await rr.text();
    assert(store.getAccount(srvAcc).status === "online", `第 ${i} 次 server 错误不罚号（网络抖动不再打空号池）`);
  }
  await new Promise((r) => setTimeout(r, 1200)); // 等 800ms 渠道降级过期，让第三次真实命中账号
  rr = await call({ model: "deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] });
  await rr.text();
  assert(store.getAccount(srvAcc).status === "cooling", "连续 3 次 server 错误才熔断");
  assert(store.getAccount(srvAcc).cool_until > Date.now() + 29 * 60000, "熔断档位 30 分钟起（指数封顶 6h）");
  store.removeAccount(srvAcc);
  await new Promise((r) => setTimeout(r, 2000)); // 渠道降级（streak1=2×800ms）过期再进 10.4d，不串节奏

  // 10.4d 无明示重置时间的 429：同号退避 1s 重试一次就地消化（参考项目 RetrySame 语义）。
  // 单号池场景下这一跳决定 429 是就地消化还是直接抛给客户端
  const rateAcc = store.addAccount({ channel: "trae", uid: "rate1", name: "短限流号", token: "rate-token", source: "paste", expiresAt: Date.now() + 7200000 });
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/flaky429";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");
  flaky429Hits = 0;
  rr = await call({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] });
  const retryText = await rr.text();
  assert(rr.status === 200 && retryText.includes('"content":"Hello"'), "429 经同号退避重试后成功: " + rr.status);
  assert(flaky429Hits === 2, "上游确实被打了两次（首枪 429 + 退避重放）: " + flaky429Hits);
  assert(store.getAccount(rateAcc).status === "online", "短窗限流就地消化，不罚号也不抛给客户端");
  store.removeAccount(rateAcc);
  headersCfg.trae.chatUrl = "http://127.0.0.1:19530/trae/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // 10.5 自动切换①：已知余额不足（credits=0）账号调度期直接跳过，不再发请求
  store.updateAccount(goodTrae, { credits: 0, creditsAt: Date.now(), status: "online", coolUntil: 0, coolReason: "" });
  store.updateAccount(badTrae, { status: "online", coolUntil: 0, coolReason: "", credits: 100, creditsAt: Date.now() });
  const zeroPick = pool.pickAccount("trae", "expire_first", []);
  assert(zeroPick && zeroPick.uid === "bad", "余额不足自动切换：零余额好号被跳过");
  assert(store.getAccount(goodTrae).status === "exhausted", "零余额账号被标记耗尽");

  // 10.6 自动切换②：余额已到期账号调度期直接跳过
  store.updateAccount(goodTrae, { status: "online", coolUntil: 0, coolReason: "", credits: 800, creditsAt: Date.now(), expiresAt: Date.now() - 1000 });
  const expiredPick = pool.pickAccount("trae", "expire_first", []);
  assert(expiredPick && expiredPick.uid === "bad", "余额到期自动切换：已过期账号被跳过");
  assert(/到期/.test(store.getAccount(goodTrae).cool_reason), "过期账号标注原因");

  // 10.7 过期账号优先级：快到期账号排最前优先消耗（expire_first 到期前榨干）
  store.updateAccount(goodTrae, { status: "online", coolUntil: 0, coolReason: "", credits: 800, creditsAt: Date.now(), expiresAt: Date.now() + 1800000 });
  const soonPick = pool.pickAccount("trae", "expire_first", []);
  assert(soonPick && soonPick.uid === "good", "快到期账号优先消耗");

  // 10.8 模型回退（多模型自动切换）：未知模型 → 回退模型命中，响应模型字段保持请求值
  store.updateAccount(goodTrae, { status: "online", coolUntil: 0, coolReason: "", credits: 800, creditsAt: Date.now(), expiresAt: Date.now() + 7200000 });
  rr = await call({ model: "not-exist-model", stream: true, messages: [{ role: "user", content: "hi" }] });
  const fbText = await rr.text();
  assert(rr.status === 200 && fbText.includes('"content":"Hello"'), "未知模型经回退链成功: " + rr.status);
  assert(fbText.includes('"model":"not-exist-model"'), "响应模型字段保持请求值（契约不变）");
  const fbRow = store.recentRequests(1)[0];
  assert(fbRow.error === "fallback→deepseek-v4-flash", "流水备注回退命中: " + fbRow.error);

  // 10.9 模型禁用：直接 400 model_disabled（disabledModels 每请求读设置热生效，无需重启）
  e2eDisabledFlag.push("glm-4.6");
  rr = await fetch(base2 + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
    body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
  });
  const disBody = await rr.json();
  assert(rr.status === 400 && disBody.error.code === "model_disabled", "禁用模型 400: " + rr.status);
  // 10.9a 停用模型不对外列出：/v1/models 减去 disabledModels，恢复启用后回归
  const probe = adapters.mergedModels(e2eSettings())[0].id;
  e2eDisabledFlag.push(probe);
  let modelsBody = await (await fetch(base2 + "/v1/models")).json();
  assert(!modelsBody.data.some((m) => m.id.toLowerCase() === probe.toLowerCase()), "停用模型不出现在 /v1/models: " + probe);
  assert(modelsBody.data.length > 0, "未停用模型仍在 /v1/models（剩余 " + modelsBody.data.length + " 条）");
  assert(adapters.mergedModels(e2eSettings()).some((m) => m.id.toLowerCase() === probe.toLowerCase()), "管理视图 mergedModels 仍含停用模型（过滤只发生在对外出口）");
  e2eDisabledFlag.length = 0;
  modelsBody = await (await fetch(base2 + "/v1/models")).json();
  assert(modelsBody.data.some((m) => m.id.toLowerCase() === probe.toLowerCase()), "恢复启用后 /v1/models 回归: " + probe);

  // 10.10 本地 IDE 快捷切换（确认协议 + WB auth 文件合并写回 + 备份 + Trae 诚实降级）
  process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ah-lappdata-"));
  const authDir = path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const authFile = path.join(authDir, "workbuddy-desktop.info");
  fs.writeFileSync(authFile, JSON.stringify({ accessToken: "old-token", refreshToken: "old-refresh", uid: "old-uid", nickname: "旧号", editionType: "pro", otherField: 42 }, null, 2));
  const ideswitch = require("../electron/backend/proxy/ideswitch.cjs");
  // 进程探测隔离：真机上本渠道客户端可能正开着，这里必须假装「未运行」——
  // 切号流程在确认后是真的会去 kill 客户端的，不隔离就会关掉用户正在用的软件
  const wbClient = require("../electron/backend/proxy/wbClient.cjs");
  const realIsRunning = wbClient.isWorkbuddyRunning;
  wbClient.isWorkbuddyRunning = () => ({ running: false, main: false });
  try {
    // ① 新入口协议：首调只做只读预检，一律回 needConfirm + probe（ok 必须为 true，
    //    否则前端 call() 会把它当执行失败抛错，确认框永远弹不出来）；此调不得改动任何文件
    const pre = await ideswitch.switchIdeAccount(goodWb); // 用户改动后 switchIdeAccount 已 async
    assert(pre.ok === true && pre.needConfirm === true, "首调返回 needConfirm 且 ok 为 true");
    assert(pre.probe && pre.probe.channel === "workbuddy" && pre.probe.running === false, "probe 带渠道与运行态");
    assert(typeof pre.message === "string" && pre.message.length > 0, "确认框正文非空");
    assert(JSON.parse(fs.readFileSync(authFile, "utf8")).accessToken === "old-token", "预检是只读的，不得提前写文件");
    // ② 确认后（confirmAck）才真正执行写回
    const sw = await ideswitch.switchIdeAccount(goodWb, { confirmAck: true });
    assert(sw.ok && sw.backup && fs.existsSync(sw.backup), "WB 切换成功且备份存在");
    const after = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert(after.accessToken === "wb-good" && after.uid === "wbgood", "凭据写回");
    assert(after.otherField === 42 && after.editionType === "pro", "原文件其它字段保留");
    assert(JSON.parse(fs.readFileSync(sw.backup, "utf8")).accessToken === "old-token", "备份是旧凭据（可回滚）");
    // ③ Trae 诚实降级：入口预检就如实回报，不弹确认框
    const swTrae = await ideswitch.switchIdeAccount(goodTrae);
    assert(!swTrae.ok && /加密信封/.test(swTrae.message), "Trae 诚实降级提示");
  } finally {
    wbClient.isWorkbuddyRunning = realIsRunning; // 还原探测，不把替身留给后续用例
  }

  // 收尾：恢复规则文件，关掉假服务
  fs.writeFileSync(headersPath, headersBackup);
  rules.reload("headers.json");
  await new Promise((r3) => fake.close(r3));
  server.stop();
  console.log("e2e layer ok（换号 / 两种自动切换 / 流式双态 / 指纹头 / 模型回退禁用 / IDE 切换）");

  // 11. 模型级负缓存（6004/11102）写穿 model_cooldowns 表 + 跨进程存活
  // 对应 issue #2 根因三：此前纯内存态，每次重启都要白撞一次上游 429 才能重建墙钟冷却
  const mcAcc = store.addAccount({ channel: "trae", uid: "mc", name: "负缓存号", token: "mc-token", source: "paste", expiresAt: Date.now() + 7200000 });
  pool.coolAccountModel(mcAcc, "deepseek-v4-flash", Date.now() + 600000, "6004 墙钟冷却（自测）");
  assert(pool.isModelCooled(mcAcc, "deepseek-v4-flash"), "负缓存即时生效");
  assert(!pool.isModelCooled(mcAcc, "glm-5.3-flash"), "负缓存按账号×模型粒度，其它模型不受影响");
  const mcRows = store.listModelCooldowns().filter((r) => r.accId === mcAcc);
  assert(mcRows.length === 1 && mcRows[0].model === "deepseek-v4-flash", "负缓存已写穿 model_cooldowns 表");
  // 模拟进程重启：丢掉 pool 模块缓存重开，内存表为空，只能从库里恢复
  delete require.cache[require.resolve("../electron/backend/proxy/pool.cjs")];
  const pool2 = require("../electron/backend/proxy/pool.cjs");
  assert(pool2.isModelCooled(mcAcc, "deepseek-v4-flash"), "重启后负缓存从库恢复（不再白撞上游 429）");
  store.deleteModelCooldowns(mcAcc, null);
  assert(store.listModelCooldowns().every((r) => r.accId !== mcAcc), "手动解除后库里不留残行（重启不复活）");
  store.removeAccount(mcAcc);
  console.log("cooldown layer ok（server 错误 3 次熔断 / 429 同号退避重试 / 模型级负缓存跨重启存活）");

  store.deleteKey(k.id);
  store.removeAccount(aid);
  console.log("SMOKE OK");
}

main()
  .then(() => process.exit(0)) // fetch/监听句柄会让事件循环保持存活，测完显式退出
  .catch((e) => {
  console.error("SMOKE FAIL:", e);
  process.exit(1);
});
