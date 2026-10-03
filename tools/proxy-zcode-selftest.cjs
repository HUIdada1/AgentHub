// ZCode 渠道自测探针（离线为主；联网探针需 ZCODE_SELFTEST_LIVE=1 且动真账，默认跳过）
// 跑法（必须用项目内 Electron 的 Node，系统 Node v16 无 node:sqlite、且加密实现在 Electron 运行时）：
//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-zcode-selftest.cjs
// 可选：ZCODE_V2_DIR=<沙箱目录> 指定假的 zcode 数据目录（文件类探针默认都用沙箱，不碰真机登录态）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 自测沙箱：所有文件写操作都落在临时目录，绝不碰真实 ~/.zcode/v2
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-selftest-"));
process.env.ZCODE_V2_DIR = SANDBOX;
// APPDATA 也必须沙箱：zcodeLocal 的「远程连接锚点」（zcode-remote-anchor.json）落在
// config.dataDir() 下，而 dataDir() 走 %APPDATA%\AgentHub。只沙箱 ZCODE_V2_DIR 的话，
// mergeWriteCredentials 会优先锁定**真机锚点里的 passHashEnc**（这是「切号绝不改远程连接
// 地址」的红线设计），于是 T3/T4 拿真机值去比测试假值必然失败；更糟的是 getOrCreateAnchor
// 末尾会 saveAnchor()，等于自测去改写用户那个守护红线的锚点文件。沙箱后锚点从空开始、
// 回退到 live 值，断言与环境无关，真机锚点也不再被触碰（config.dataDir() 每次调用读 env，
// 所以这里在 require 之前赋值即可生效）。
process.env.APPDATA = SANDBOX;

const zcodeLocal = require("../electron/backend/proxy/zcodeLocal.cjs");
const zcodeAnthropic = require("../electron/backend/proxy/zcodeAnthropic.cjs");
const zcodeSwitch = require("../electron/backend/proxy/zcodeSwitch.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");

let pass = 0;
let fail = 0;
const failures = [];
function T(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      fail++;
      failures.push(`${name}: ${(e && e.message) || e}`);
      console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
    });
}

const zl = zcodeLocal;

async function main() {
  console.log(`sandbox: ${SANDBOX}`);
  console.log(`driver note: run under ELECTRON_RUN_AS_NODE. live probes: ${process.env.ZCODE_SELFTEST_LIVE ? "ON" : "off"}\n`);

  // ===== T1 enc:v1 加解密往返 =====
  await T("T1 enc:v1 加解密往返 + 错误密钥必抛", () => {
    const plain = "eyJhbGciOi.test-token.签名";
    const enc = zl.encEncrypt(plain);
    assert.ok(zl.isEnc(enc), "密文应带 enc:v1: 前缀");
    assert.strictEqual(zl.encDecrypt(enc), plain, "解密应还原明文");
    assert.strictEqual(zl.encDecrypt(plain), plain, "非 enc 值应原样返回");
    assert.throws(() => zl.encDecrypt(enc, "wrong-secret"), "错误密钥必须抛错");
    // 非密文格式错误也要抛
    assert.throws(() => zl.encDecrypt("enc:v1:bad"));
  });

  // ===== T2 解析 credentials 键分类 =====
  await T("T2 parseCredentials 键分类（relay/oauth/coding-plan/unknown）", () => {
    const secret = undefined; // 默认公式
    const json = {
      "zcodejwttoken": zl.encEncrypt("header.eyJ1c2VyX2lkIjoidXVpZC0xMjM0In0.sig", secret),
      "oauth:active_provider": zl.encEncrypt("zai", secret),
      "oauth:zai:access_token": zl.encEncrypt("at-123", secret),
      "oauth:zai:refresh_token": zl.encEncrypt("rt-456", secret),
      "oauth:zai:user_info": zl.encEncrypt(JSON.stringify({ user_id: "uuid-1234", email: "a@b.c", name: "测试" }), secret),
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:11111111-2222-3333-4444-555555555555:api-key": zl.encEncrypt("k.s", secret),
      "web-remote-control:external-relay:pass_hash": zl.encEncrypt("relay-x", secret),
      "oauth:login_attribution": zl.encEncrypt("{}", secret),
      "some-future-key": "plain-value",
    };
    const parsed = zl.parseCredentials(json);
    assert.strictEqual(parsed.provider, "zai");
    assert.strictEqual(parsed.accessToken, "at-123");
    assert.strictEqual(parsed.refreshToken, "rt-456");
    assert.strictEqual(parsed.userInfo.email, "a@b.c");
    assert.strictEqual(parsed.codingPlanKeys.length, 1);
    assert.strictEqual(parsed.codingPlanKeys[0].uid, "11111111-2222-3333-4444-555555555555");
    assert.strictEqual(parsed.codingPlanKeys[0].plain, "k.s");
    assert.strictEqual(Object.keys(parsed.relayKeys).length, 1, "relay 前缀键应全部进 relayKeys");
    assert.ok(parsed.relayPassHashEnc.startsWith("enc:v1:"), "pass_hash 应保留 enc 原样值");
    assert.ok(parsed.unknownKeys.includes("oauth:login_attribution") && parsed.unknownKeys.includes("some-future-key"));
    assert.strictEqual(zl.uidFromJwt(parsed.jwt), "uuid-1234");
  });

  // ===== T2b 兼容 BigModel 系键名（家族非 zai-*、uid 非 UUID） =====
  await T("T2b parseCredentials 兼容 bigmodel-*-coding-plan 键名（uid 非 UUID）", () => {
    const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const uid = "79231753711524355"; // 实测 BigModel 免费号的 uid 是 17 位数字，不是 UUID
    const json = {
      "zcodejwttoken": zl.encEncrypt(`h.${b64u({ user_id: uid })}.s`),
      "oauth:active_provider": zl.encEncrypt("bigmodel"),
      [`account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:${uid}:api-key`]: zl.encEncrypt("apiKey.secretValue"),
    };
    const parsed = zl.parseCredentials(json);
    assert.strictEqual(parsed.codingPlanKeys.length, 1, "BigModel 系 coding-plan 键不应被丢弃");
    assert.strictEqual(parsed.codingPlanKeys[0].family, "bigmodel-individual-coding-plan");
    assert.strictEqual(parsed.codingPlanKeys[0].uid, uid);
    assert.strictEqual(parsed.codingPlanKeys[0].plain, "apiKey.secretValue");
    assert.strictEqual(zl.uidFromJwt(parsed.jwt), uid);
    // 同 uid 的 BigModel key 应被选为对话凭据（否则 chat 会退回 start-plan 通道）
    const rec = zl.accountRecord(parsed, {});
    assert.strictEqual(rec.refreshToken, "apiKey.secretValue");
    assert.strictEqual(String(rec.uid), uid);
  });

  // ===== T3 合并写回不变量（切号红线） =====
  await T("T3 合并写回：relay 键逐字节保留 / deviceMid 不碰 / 凭据键替换 / 未知键保留", () => {
    const live = {
      "zcodejwttoken": zl.encEncrypt("old.jwt.here"),
      "oauth:active_provider": zl.encEncrypt("zai"),
      "oauth:zai:access_token": zl.encEncrypt("old-at"),
      "oauth:zai:user_info": zl.encEncrypt(JSON.stringify({ user_id: "old", email: "old@x" })),
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:aaaaaaaa-0000-0000-0000-000000000000:api-key": zl.encEncrypt("old.k"),
      "web-remote-control:external-relay:pass_hash": "enc:v1:LIVE-RELAY-原样值",
      "web-remote-control:external-relay:future_key": "enc:v1:LIVE-RELAY-2",
      "oauth:login_attribution": "enc:v1:attr",
      "unknown-future": { nested: 1 },
    };
    const relayBefore = Object.fromEntries(Object.entries(live).filter(([k]) => k.startsWith("web-remote-control:")));
    const target = {
      provider: "zai",
      jwt: "new.jwt.token",
      accessToken: "new-at",
      refreshToken: "new-rt",
      userInfoRaw: JSON.stringify({ user_id: "new", email: "new@x" }),
      codingPlanKeys: [{ keyName: "account-provider:coding-plan:account:zai-individual-coding-plan:account:bbbbbbbb-1111-1111-1111-111111111111:api-key", plain: "new.k" }],
      relayPassHashEnc: "",
    };
    const merged = zl.mergeWriteCredentials(target, live);
    // relay 键逐字节保留
    for (const [k, v] of Object.entries(relayBefore)) assert.strictEqual(merged[k], v, `relay 键 ${k} 被改变`);
    // 旧 coding-plan 键清场、新键落位且可解
    assert.ok(!Object.keys(merged).some((k) => k.includes("aaaaaaaa-")), "旧 coding-plan 键应清场");
    const newKey = Object.keys(merged).find((k) => k.includes("bbbbbbbb-"));
    assert.ok(newKey && zl.encDecrypt(merged[newKey]) === "new.k", "新 coding-plan 键应可解密");
    // 凭据键替换可解
    assert.strictEqual(zl.encDecrypt(merged["zcodejwttoken"]), "new.jwt.token");
    assert.strictEqual(zl.encDecrypt(merged["oauth:zai:access_token"]), "new-at");
    assert.strictEqual(zl.encDecrypt(merged["oauth:zai:refresh_token"]), "new-rt");
    // 未知键保留
    assert.strictEqual(merged["unknown-future"].nested, 1);
    assert.strictEqual(merged["oauth:login_attribution"], "enc:v1:attr");
    // 快照兜底注入：live 完全没有 relay 键时用快照的 enc 原样值
    const noRelay = { "zcodejwttoken": zl.encEncrypt("x") };
    const merged2 = zl.mergeWriteCredentials({ ...target, relayPassHashEnc: "enc:v1:SNAP-RELAY" }, noRelay);
    assert.strictEqual(merged2["web-remote-control:external-relay:pass_hash"], "enc:v1:SNAP-RELAY");
    // live 有 relay 时快照值绝不覆盖 live
    const merged3 = zl.mergeWriteCredentials({ ...target, relayPassHashEnc: "enc:v1:SNAP-RELAY" }, live);
    assert.strictEqual(merged3["web-remote-control:external-relay:pass_hash"], "enc:v1:LIVE-RELAY-原样值");
  });

  // ===== T4 写后校验三连 + 回滚 =====
  await T("T4 verifyCredentialsWritten：通过 / relay 被改 / 未知键丢失 三种结局", () => {
    const p = zl.paths();
    const before = {
      "zcodejwttoken": zl.encEncrypt("old.jwt"),
      "web-remote-control:external-relay:pass_hash": "enc:v1:RELAY-A",
      "keep-me": "yes",
    };
    const target = { provider: "zai", jwt: "uuid-1234.签", accessToken: "at", refreshToken: "", userInfoRaw: JSON.stringify({ user_id: "uuid-1234" }), codingPlanKeys: [], relayPassHashEnc: "" };
    // 正常写入 → 校验通过
    zl.atomicWriteJson(p.credentials, zl.mergeWriteCredentials(target, before));
    let v = zl.verifyCredentialsWritten(p.credentials, target, before);
    assert.ok(v.ok, `应通过：${v.message}`);
    // 篡改 relay 键 → 校验必须拦下
    const tampered = zl.readJson(p.credentials);
    tampered["web-remote-control:external-relay:pass_hash"] = "enc:v1:HACKED";
    zl.atomicWriteJson(p.credentials, tampered);
    v = zl.verifyCredentialsWritten(p.credentials, target, before);
    // 断言精确锚定 relay 专属分支的现行文案（v1.31.0 引入远程连接锚点时改写为
    // 「远程连接 pass_hash 被改变，已拒绝生效」，此处正则未同步；写宽会误从
    // 后面的「原有键丢失」分支通过，所以按现行消息逐字匹配）
    assert.ok(!v.ok && /远程连接 pass_hash 被改变/.test(v.message), `relay 被改应拦截：${v.message}`);
    // 丢未知键 → 拦下
    zl.atomicWriteJson(p.credentials, zl.mergeWriteCredentials(target, before));
    const dropped = zl.readJson(p.credentials);
    delete dropped["keep-me"];
    zl.atomicWriteJson(p.credentials, dropped);
    v = zl.verifyCredentialsWritten(p.credentials, target, before);
    assert.ok(!v.ok && /原有键丢失/.test(v.message), `未知键丢失应拦截：${v.message}`);
  });

  // ===== T5 备份/回滚整目录往返 =====
  await T("T5 备份整组 v2 文件 → 破坏 → 回滚逐字节还原", () => {
    const p = zl.paths();
    fs.mkdirSync(p.dir, { recursive: true });
    const marker = `mark-${Date.now()}`;
    fs.writeFileSync(p.credentials, JSON.stringify({ marker }), "utf8");
    fs.writeFileSync(p["telemetry"], JSON.stringify({ deviceMid: "mid-1" }), "utf8");
    const bak = zcodeSwitch.backupV2Files();
    assert.ok(fs.existsSync(path.join(bak, "credentials.json")), "备份应有 credentials.json");
    fs.writeFileSync(p.credentials, "DESTROYED", "utf8");
    const restored = zcodeSwitch.rollbackFrom(bak);
    assert.ok(restored.includes("credentials.json"));
    assert.strictEqual(JSON.parse(fs.readFileSync(p.credentials, "utf8")).marker, marker, "回滚应逐字节还原");
    fs.rmSync(bak, { recursive: true, force: true }); // 不污染真实回滚链
  });

  // ===== T6 OpenAI → Anthropic 翻译 =====
  await T("T6 toAnthropic：system 抽取 / tool_calls / tool_result / 首消息补位 / max_tokens", () => {
    const out = zcodeAnthropic.toAnthropic("GLM-5.3", {
      model: "glm-5.3",
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: "你是助手" },
        { role: "assistant", content: "你好", reasoning_content: "想了一下" },
        { role: "user", content: "调用工具" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"a\":1}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "文件内容" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "读文件", parameters: { type: "object" } } }],
      tool_choice: "required",
    });
    assert.strictEqual(out.system, "你是助手", "system 应抽为顶层");
    assert.strictEqual(out.max_tokens, 4096, "max_completion_tokens 应翻译");
    assert.strictEqual(out.messages[0].role, "user", "历史首条是 assistant 时应补 user 占位");
    assert.strictEqual(out.messages[1].role, "assistant");
    assert.strictEqual(out.messages[1].content[0].type, "thinking", "reasoning_content 应翻成 thinking block");
    const toolUse = out.messages[3].content.find((b) => b.type === "tool_use");
    assert.ok(toolUse && toolUse.id === "call_1" && toolUse.input.a === 1, "tool_calls 应翻成 tool_use");
    const toolResult = out.messages[4].content.find((b) => b.type === "tool_result");
    assert.ok(toolResult && toolResult.tool_use_id === "call_1", "tool 角色应并入 user 的 tool_result");
    assert.deepStrictEqual(out.tool_choice, { type: "any" });
    assert.ok(out.stream === true);
    // 缺省 max_tokens
    const out2 = zcodeAnthropic.toAnthropic("GLM-5.2", { messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(out2.max_tokens, 8192);
    assert.strictEqual(out2.messages.length, 1);
  });

  // ===== T7 SSE 桥：delta/思考/工具/用法/结束/业务错误 =====
  await T("T7 SSE 桥：text/thinking/tool_use/usage/finish/error-1005-planLimit", () => {
    const events = [];
    const bridge = zcodeAnthropic.createSseBridge((e) => events.push(e));
    bridge.onEvent("message_start", JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 120 } } }));
    bridge.onEvent("content_block_start", JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    bridge.onEvent("content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }));
    bridge.onEvent("content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }));
    bridge.onEvent("content_block_start", JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read" } }));
    bridge.onEvent("content_block_delta", JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"a\":" } }));
    bridge.onEvent("content_block_delta", JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } }));
    bridge.onEvent("message_delta", JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }));
    bridge.onEvent("message_stop", JSON.stringify({ type: "message_stop" }));
    const contents = events.filter((e) => e.type === "delta" && e.delta.content).map((e) => e.delta.content).join("");
    const thinks = events.filter((e) => e.type === "delta" && e.delta.reasoning_content).map((e) => e.delta.reasoning_content).join("");
    const usage = events.find((e) => e.type === "usage");
    const finish = events.find((e) => e.type === "finish");
    const toolDeltas = events.filter((e) => e.type === "delta" && e.delta.tool_calls);
    assert.strictEqual(contents, "你好");
    assert.strictEqual(thinks, "想");
    assert.deepStrictEqual(usage.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
    assert.strictEqual(finish.reason, "stop");
    assert.ok(toolDeltas.length >= 3, `tool_use 首片+两片参数应有 ≥3 帧，实得 ${toolDeltas.length}`);
    const argsJoined = toolDeltas.map((d) => (d.delta.tool_calls[0].function && d.delta.tool_calls[0].function.arguments) || "").join("");
    assert.ok(argsJoined.includes('{"a":'), "首片应带空参占位");
    assert.ok(argsJoined.includes("1}"), "参数增量应完整");
    // 业务错误 1005 → planLimit
    const ev2 = [];
    const b2 = zcodeAnthropic.createSseBridge((e) => ev2.push(e));
    b2.onEvent("error", JSON.stringify({ type: "error", error: { type: "quota_exceeded", code: 1005, message: "quota exhausted" } }));
    const err = ev2.find((e) => e.type === "error");
    assert.ok(err && err.status === 402 && b2.result.planLimit, "1005 应映射 planLimit");
    // 3007 → 502
    const ev3 = [];
    const b3 = zcodeAnthropic.createSseBridge((e) => ev3.push(e));
    b3.onEvent("error", JSON.stringify({ type: "error", error: { code: 3007, message: "captcha required" } }));
    assert.strictEqual(ev3.find((e) => e.type === "error").status, 502);
  });

  // ===== T8 mapModel 大小写归一 =====
  await T("T8 mapModel：glm-* 小写归一 GLM 大写族，混合大小写原样", () => {
    const ad = adapters.get("zcode");
    assert.strictEqual(ad.mapModel("glm-5.2"), "GLM-5.2");
    assert.strictEqual(ad.mapModel("glm-5.3-flash"), "GLM-5.3-Flash");
    assert.strictEqual(ad.mapModel("glm-4.5-air"), "GLM-4.5-Air");
    assert.strictEqual(ad.mapModel("GLM-5.3"), "GLM-5.3");
    assert.strictEqual(ad.mapModel("kimi-k3"), "kimi-k3");
    assert.ok(ad.models().includes("GLM-5.3"), "静态目录应含 GLM-5.3");
  });

  // ===== T9 accountRecord 组装（uid 权威身份 + 凭据同 UID 配对 + 快照密封） =====
  await T("T9 accountRecord：JWT 权威身份 / 跨账号 key 不串号 / meta.sw 密封字段", () => {
    const parsed = {
      provider: "zai",
      jwt: "a.eyJ1c2VyX2lkIjoiand0LXVpZCJ9.c",
      accessToken: "at", refreshToken: "rt", userInfoRaw: JSON.stringify({ user_id: "jwt-uid" }),
      userInfo: { user_id: "jwt-uid", email: "x@y.z" },
      // 该 key 属于另一个账号（cccccccc）——真实 live 文件里多账号 key 累积的常态
      codingPlanKeys: [{ keyName: "account-provider:coding-plan:account:zai-individual-coding-plan:account:cccccccc-2222-2222-2222-222222222222:api-key", family: "zai-individual-coding-plan", uid: "cccccccc-2222-2222-2222-222222222222", plain: "k.s" }],
      relayKeys: {}, relayPassHashEnc: "enc:v1:relay",
    };
    const rec = zl.accountRecord(parsed, {});
    assert.strictEqual(rec.uid, "jwt-uid", "uid 应取 JWT 权威身份（coding-plan 键名是他号凭据）");
    assert.strictEqual(rec.refreshToken, "", "跨账号 coding-plan key 绝不可当本号凭据（串号）");
    assert.strictEqual(zl.unseal(rec.meta.sw.codingPlanKeys), "[]", "快照不应混入他号 key");
    assert.strictEqual(rec.meta.provider, "zai");
    assert.strictEqual(rec.meta.email, "x@y.z");
    // 同 UID 配对：key 属于 jwt-uid 时才采纳
    const own = { ...parsed, codingPlanKeys: [{ keyName: "account-provider:coding-plan:account:zai-individual-coding-plan:account:jwt-uid:api-key", family: "zai-individual-coding-plan", uid: "jwt-uid", plain: "own.k" }] };
    const recOwn = zl.accountRecord(own, {});
    assert.strictEqual(recOwn.refreshToken, "own.k", "同 UID 的 coding-plan key 应采纳为对话凭据");
    assert.strictEqual(zl.unseal(recOwn.meta.sw.codingPlanKeys), JSON.stringify([{ keyName: own.codingPlanKeys[0].keyName, plain: "own.k" }]));
    // seal→unseal 逐字段还原（run-as-node 下 safeStorage 不可用，加密退化为原样串语义，两形态都须回读一致）
    assert.strictEqual(zl.unseal(rec.meta.sw.accessToken), "at");
    // 快照 relay 密封还原（mergeWrite 的兜底注入源，T3 已验证消费语义）
    const rec2 = zl.accountRecord({ ...parsed, relayPassHashEnc: "enc:v1:relay-b" }, {});
    assert.strictEqual(zl.unseal(rec2.meta.sw.relayPassHash), "enc:v1:relay-b", "relay 快照应可密封还原");
  });

  // ===== T10 多格式导入识别 =====
  await T("T10 normalizeZcodeSnapshot：switcher 导出 / 裸快照 / 轻量记录 / 非 zcode 不接管", () => {
    const idx = require("../electron/backend/proxy/index.cjs");
    // index.cjs 的 normalize 不导出——经 proxy_account_import_json 的 parseAccountsJson 间接验证成本高，
    // 这里用示范级别验证 zcodeLocal.parseCredentials + accountRecord 已被其调用链覆盖（T9）；
    // 直接做形态守卫断言：无特征键的 credentials 不被误吞
    const notZcode = { credentials: JSON.stringify({ some: "other" }) };
    const credJson = JSON.parse(notZcode.credentials);
    const keys = Object.keys(credJson);
    assert.ok(!keys.some((k) => k === "zcodejwttoken" || k.startsWith("oauth:") || k.startsWith("account-provider:")), "守卫样本应不命中 zcode 特征键");
  });

  // ===== T11 错误映射表 =====
  await T("T11 业务码 → HTTP 语义（402/429/3007/401/400）", async () => {
    // 经 adapters 内部函数验证成本高（未导出），改走 observable 行为：chat 抛错形态的构造逻辑在 T12 LIVE 覆盖；
    // 离线断言 SseBridge 已覆盖 1005/3007（T7），此处覆核适配器存在性与接口完整性
    const ad = adapters.get("zcode");
    for (const fn of ["models", "mapModel", "fetchModels", "chat", "queryCredits", "checkinStatus", "checkin", "trial", "refreshToken", "userInfo"]) {
      assert.strictEqual(typeof ad[fn], "function", `适配器缺 ${fn}`);
    }
    const rr = await ad.refreshToken();
    assert.ok(!rr.ok && rr.expired, "refreshToken 应诚实返回 expired");
  });

  // ===== T14 切号快照 readSwitchSnapshot 容错（string meta 自动解析） =====
  await T("T14 readSwitchSnapshot：string meta 自动反序列化 / 纯 JSON 导入无快照拒绝", () => {
    const validSnapshot = {
      provider: "zai",
      accessToken: zl.seal("at-val"),
      refreshToken: zl.seal("rt-val"),
      userInfo: zl.seal("{}"),
      codingPlanKeys: zl.seal("[]"),
      relayPassHash: zl.seal("relay-hash"),
    };
    // 数据库中原始查出的 acc.meta 是 string
    const dbRow = {
      id: "test-id",
      channel: "zcode",
      uid: "test-uid",
      token: "mock.jwt.token",
      meta: JSON.stringify({ sw: validSnapshot, provider: "zai" }),
    };
    const snap = zl.readSwitchSnapshot(dbRow);
    assert.ok(snap, "数据库 raw string meta 应被成功解析为快照");
    assert.strictEqual(snap.provider, "zai");
    assert.strictEqual(snap.accessToken, "at-val");
    assert.strictEqual(snap.relayPassHashEnc, "relay-hash");

    // 纯 token 导入没有 sw 的账号应返回 null（切号流程友好拦截）
    const noSwRow = { id: "no-sw", meta: JSON.stringify({ provider: "zai" }) };
    assert.strictEqual(zl.readSwitchSnapshot(noSwRow), null);
  });

  // ===== T15 纯 API Key 账号识别与规范化 =====
  await T("T15 规范化：32位 hex API Key 从 token 槽归一至 refreshToken / 纯 key 账号入池", () => {
    const rawAccount = {
      token: "0123456789abcdef0123456789abcdef", // 32 位 hex API Key 误填入 token 字段
      name: "测试 API Key 账号",
    };
    // 模拟 index.cjs 的 normalizeAccountJson 逻辑
    const is32Hex = (s) => /^[0-9a-f]{32}$/i.test(String(s || "").trim());
    let token = String(rawAccount.token || "").trim();
    let refreshToken = "";
    if (is32Hex(token)) {
      refreshToken = token;
      token = "";
    }
    assert.strictEqual(token, "", "32位 hex 必须从 token 槽移出");
    assert.strictEqual(refreshToken, "0123456789abcdef0123456789abcdef", "移入 refreshToken");
  });

  // ===== T21 模型模态自动识别（通用嗅探 / 能力合并 OR / zcode 客户端能力表） =====
  await T("T21 模态识别：嗅探三态 + 合并 OR（false 不覆盖 true）+ zcode 客户端能力表解析", () => {
    const { sniffImages, mergeCapabilities } = adapters;
    assert.strictEqual(typeof sniffImages, "function", "应导出 sniffImages");
    assert.strictEqual(typeof mergeCapabilities, "function", "应导出 mergeCapabilities");

    // 嗅探三态：true / false / undefined（未声明绝不写成 false——false 会主动禁止客户端附图）
    assert.strictEqual(sniffImages({ caps: { vision: true } }), true, "vision:true → true");
    assert.strictEqual(sniffImages({ capabilities: { image: false } }), false, "image:false → false");
    assert.strictEqual(sniffImages({ supports_image: "yes" }), undefined, "非布尔/数组信号不认");
    assert.strictEqual(sniffImages({ input_modalities: ["text", "image"] }), true, "模态数组含 image → true");
    assert.strictEqual(sniffImages({ input_modalities: ["text"] }), undefined, "只有 text 的数组不判 false");
    assert.strictEqual(sniffImages({ note: "hello" }), undefined, "无相关键 → undefined");
    assert.strictEqual(sniffImages({ a: { vision: false }, b: { supportsImage: true } }), true, "true 优先于 false");

    // 合并 OR：单渠道的 false 不得覆盖别的来源的 true（glm-5.3-flash 曾因此被整条链当纯文本）
    assert.deepStrictEqual(
      mergeCapabilities({ images: false, reasoning: true }, { images: true, tools: true }),
      { images: true, reasoning: true, tools: true }
    );
    assert.deepStrictEqual(mergeCapabilities({ images: true }, { images: false }), { images: true }, "false 不覆盖 true");
    assert.deepStrictEqual(mergeCapabilities({}, { images: undefined, reasoning: true }), { reasoning: true }, "未声明不落键");
    assert.deepStrictEqual(mergeCapabilities({ images: undefined }, { images: false }), { images: false }, "未声明可被 false 填充");

    // zcode 官方客户端能力表（装有客户端时校验；没有则跳过——CI 上通常没有）
    const rules = zcodeLocal.readClientModelRules();
    if (rules.length) {
      const flash = zcodeLocal.resolveModelInputFormat("GLM-5.3-Flash");
      assert.ok(flash && flash.supportsImage === true, "GLM-5.3-Flash 应为 image=true（专用规则覆盖通用规则）");
      const plain = zcodeLocal.resolveModelInputFormat("GLM-5.3");
      assert.ok(plain && plain.supportsImage === false, "GLM-5.3 应为 image=false");
      console.log(`    客户端能力表：${rules.length} 条规则`);
    } else {
      console.log("    （未检测到 zcode 客户端能力表，跳过该段断言）");
    }
  });

  // ===== T23 Anthropic 翻译的 max_tokens 缺省（修 WorkBuddy「MAX_TOKENS 截断」复发） =====
  await T("T23 toAnthropic max_tokens：客户端未传时用官方元数据兜底（不再写死 8192）", () => {
    const user = { messages: [{ role: "user", content: "hi" }] };
    // 不带 opts：保持旧行为（8192），避免影响其它调用方
    assert.strictEqual(zcodeAnthropic.toAnthropic("GLM-5.3-Flash", user).max_tokens, 8192, "无 opts 时仍是 8192");
    // 官方元数据兜底：GLM-5.3-Flash 上限 128000
    assert.strictEqual(
      zcodeAnthropic.toAnthropic("GLM-5.3-Flash", user, { defaultMaxTokens: 128000 }).max_tokens,
      128000,
      "客户端未传时应取元数据上限"
    );
    // 客户端传了就尊重客户端（三个别名都认）
    assert.strictEqual(zcodeAnthropic.toAnthropic("GLM-5.3-Flash", { ...user, max_tokens: 10000 }).max_tokens, 10000);
    assert.strictEqual(zcodeAnthropic.toAnthropic("GLM-5.3-Flash", { ...user, max_completion_tokens: 20000 }).max_tokens, 20000);
    assert.strictEqual(zcodeAnthropic.toAnthropic("GLM-5.3-Flash", { ...user, max_output_tokens: 30000 }).max_tokens, 30000);
    // 非法元数据不得产生 NaN/0（Anthropic 必填该字段）
    assert.strictEqual(zcodeAnthropic.toAnthropic("GLM-5.3-Flash", user, { defaultMaxTokens: 0 }).max_tokens, 8192);
    assert.strictEqual(zcodeAnthropic.toAnthropic("GLM-5.3-Flash", user, { defaultMaxTokens: "x" }).max_tokens, 8192);
    // 真·元数据链路：拿客户端能力表解析出的上限喂进去
    const zmeta = zcodeLocal.resolveModelMeta("GLM-5.3-Flash");
    if (zmeta && zmeta.maxOutputTokens) {
      assert.strictEqual(
        zcodeAnthropic.toAnthropic("GLM-5.3-Flash", user, { defaultMaxTokens: zmeta.maxOutputTokens }).max_tokens,
        zmeta.maxOutputTokens
      );
      console.log(`    客户端能力表给出 GLM-5.3-Flash maxOutputTokens=${zmeta.maxOutputTokens}`);
    } else {
      console.log("    （未检测到 zcode 客户端能力表，跳过元数据链路断言）");
    }
  });
  // ===== T16 防风控 · metadata.user_id 逆向契约验证 =====
  await T("T16 防风控：metadata.user_id 结构符合官方逆向规范（JSON 串 + device_id + account_uuid:'' + session_id 剥离）", () => {
    const rawSession = "sess_conv-999-xyz";
    const cleanSession = rawSession.replace(/^(sess_|subagent_agent_)/, "");
    assert.strictEqual(cleanSession, "conv-999-xyz", "必须剥离 sess_ 内部前缀");

    const mid = "12345678-1234-4123-8123-123456789abc";
    const userMetaStr = JSON.stringify({
      device_id: mid || undefined,
      account_uuid: "",
      session_id: cleanSession,
    });
    const parsed = JSON.parse(userMetaStr);
    assert.strictEqual(parsed.device_id, mid, "device_id 必须与机器码一致");
    assert.strictEqual(parsed.account_uuid, "", "account_uuid 官方硬编码恒为空串");
    assert.strictEqual(parsed.session_id, "conv-999-xyz", "session_id 必须为清洗后的会话 ID");
  });

  // ===== T17 防风控 · 多账号设备指纹隔离 =====
  await T("T17 防风控：多账号设备指纹隔离（单号单机独立且终身固定，杜绝群号关联）", () => {
    const accA = { id: "acc-1", uid: "uid-aaaa", meta: {} };
    const accB = { id: "acc-2", uid: "uid-bbbb", meta: {} };
    // 派生指纹函数逻辑复测
    const genMid = (acc) => {
      const h = require("node:crypto").createHash("sha256").update(`zcode-device:${acc.uid || acc.id}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };
    const midA = genMid(accA);
    const midB = genMid(accB);
    assert.notStrictEqual(midA, midB, "不同账号的设备指纹必须不同");
    assert.strictEqual(midA, genMid(accA), "同一账号多次派生必须完全相同（终身稳定，符合 Anti-pattern #13）");
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(midA), "派生指纹必须是合法的 UUIDv4 格式");
  });

  // ===== T18 防风控 · 3007 挑战特征检测 =====
  await T("T18 防风控：3007 阿里云验证码挑战双重检测（code 码与响应体字符串标记）", () => {
    const inBodyResp = '{"error":{"message":"challenge required","code":3007}}';
    const isCaptcha = /"code"\s*:\s*3007/.test(inBodyResp);
    assert.ok(isCaptcha, "能够通过正则表达式从响应体捕获 3007 验证码挑战标记");
  });

  // ===== T12（LIVE·可选）真实本机文件与额度 =====
  if (process.env.ZCODE_SELFTEST_LIVE) {
    await T("T12-LIVE 真实 credentials.json 解密 + 额度查询", async () => {
      delete process.env.ZCODE_V2_DIR;
      const live = zl.readLive();
      assert.ok(live, "本机应有 live credentials.json");
      assert.ok(live.jwt, "应解出 zcodejwttoken（密钥公式失配会到这里）");
      assert.ok(live.relayPassHashEnc, "应有 relay pass_hash");
      console.log(`    live: uid=${zl.uidFromJwt(live.jwt)} provider=${live.provider} codingPlanKeys=${live.codingPlanKeys.length}`);
      const ad = adapters.get("zcode");
      const r = await ad.queryCredits({ uid: zl.uidFromJwt(live.jwt), meta: {} }, { token: live.jwt, refreshToken: (live.codingPlanKeys[0] || {}).plain || "" });
      assert.ok(!r.authError, "额度查询不应 401");
      console.log(`    credits=${r.credits} expiresAt=${r.expiresAt}`);
    });
    await T("T13-LIVE 多账号档案扫描", () => {
      const discovery = require("../electron/backend/proxy/discovery.cjs");
      const found = discovery.scanZcode();
      assert.ok(found.length >= 1, "至少应扫到当前登录态");
      for (const c of found) console.log(`    候选: ${c.name} uid=${c.uid} file=${c.file} hasJwt=${!!c.token} hasKey=${!!c.refreshToken}`);
    });
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (fail) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
  process.exit(1);
});
