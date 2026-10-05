// LobsterAI（网易有道龙虾）渠道自测探针（离线为主；联网探针默认跳过）
// 跑法（必须用项目内 Electron 的 Node：加密实现在 Electron 运行时，系统 Node 无 safeStorage）：
//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-lobster-selftest.cjs
// 联网探针（可选，只打**公开只读**端点，不带任何账号凭据）：
//   LOBSTER_SELFTEST_LIVE=1 ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-lobster-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 自测沙箱：所有文件写操作落在临时目录，绝不碰真实 %APPDATA%\AgentHub
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "lobster-selftest-"));
process.env.APPDATA = SANDBOX;

const adapters = require("../electron/backend/proxy/adapters.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const store = require("../electron/backend/proxy/store.cjs");

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

const LIVE = !!process.env.LOBSTER_SELFTEST_LIVE;
const UPSTREAM = "https://lobsterai-server.youdao.com";

async function main() {
  console.log(`sandbox: ${SANDBOX}`);
  console.log(`driver note: run under ELECTRON_RUN_AS_NODE. live probes: ${LIVE ? "ON" : "off"}\n`);

  const ad = adapters.get("lobster");

  // ===== T1 渠道注册与三处同步 =====
  await T("T1 渠道已注册（adapters / store.CHANNELS 双表同步）", () => {
    assert.ok(ad, "adapters.get('lobster') 必须有适配器");
    assert.strictEqual(ad.id, "lobster");
    const ch = store.CHANNELS.find((c) => c.id === "lobster");
    assert.ok(ch, "store.CHANNELS 必须含 lobster");
    assert.ok(ch.display.includes("LobsterAI"), `display 应含 LobsterAI，实际 ${ch.display}`);
    // 双表同步红线：只加一边会让模型被判为「无归属」并路由到不存在的渠道
    assert.ok(adapters.ADAPTERS.lobster, "ADAPTERS 必须含 lobster");
  });

  // ===== T2 适配器接口完整性（编排层按这些方法调用） =====
  await T("T2 适配器接口完整（chat/models/mapModel/rewriteBody/queryCredits/checkin/refreshToken/userInfo）", () => {
    for (const m of ["cfg", "models", "mapModel", "rewriteBody", "chat", "fetchModels", "queryCredits", "checkinStatus", "checkin", "trial", "refreshToken", "userInfo"]) {
      assert.strictEqual(typeof ad[m], "function", `缺方法 ${m}`);
    }
  });

  // ===== T3 配置项齐备（rules 热加载） =====
  await T("T3 headers.json.lobster 关键端点齐备", () => {
    const c = rules.get("headers.json").lobster;
    assert.ok(c, "headers.json 必须有 lobster 段");
    assert.strictEqual(c.chatUrl, `${UPSTREAM}/api/proxy/v1/chat/completions`);
    assert.strictEqual(c.modelsUrl, `${UPSTREAM}/api/models/available`);
    assert.strictEqual(c.balanceUrl, `${UPSTREAM}/api/user/profile-summary`);
    assert.strictEqual(c.exchangeUrl, `${UPSTREAM}/api/auth/exchange`);
    assert.strictEqual(c.refreshUrl, `${UPSTREAM}/api/auth/refresh`);
    assert.strictEqual(c.activitySlotUrl, `${UPSTREAM}/api/client-activities/slot`);
    assert.strictEqual(c.checkinPlacement, "desktop_sidebar");
    assert.ok(/^https:\/\/api-overmind\.youdao\.com\//.test(c.versionUrl), "版本号来源应是官方更新接口");
    assert.ok(/^\d{4}\.\d+/.test(c.clientVersion), `clientVersion 应是 2026.x 形态，实际 ${c.clientVersion}`);
  });

  // ===== T4 静态目录兜底（权威源：公开 pricing-catalog 实测） =====
  await T("T4 catalog.json.lobster 静态兜底目录非空且形态正确", () => {
    const ids = ad.models();
    assert.ok(Array.isArray(ids) && ids.length >= 25, `兜底模型数应 ≥25，实际 ${ids.length}`);
    for (const want of ["deepseek-flash", "glm-5.3-flash", "glm-5.3-flashx", "deepseek-v4-pro", "kimi-k3", "glm-5.2", "qwen3.8-max", "MiniMax-M3"]) {
      assert.ok(ids.includes(want), `兜底目录应含 ${want}`);
    }
  });

  // ===== T4b 上下文长度必须是真实值而非占位常量 =====
  await T("T4b 上下文长度取真实值（非 131072 占位；1M 档正确）", () => {
    const cat = rules.get("catalog.json").lobster;
    const by = (id) => cat.models.find((m) => m.id === id);
    // 官方公开端点实测：deepseek-flash / glm-5.3-flash 均为 1000000
    assert.strictEqual(by("deepseek-flash").contextLength, 1000000, "deepseek-flash 上下文应为 1M");
    assert.strictEqual(by("glm-5.3-flash").contextLength, 1000000, "glm-5.3-flash 上下文应为 1M");
    assert.strictEqual(by("deepseek-v4-pro").contextLength, 1000000, "deepseek-v4-pro 上下文应为 1M");
    assert.strictEqual(by("kimi-k3").contextLength, 1048576, "kimi-k3 上下文应为 1048576");
    assert.strictEqual(by("kimi-k2.7-code").contextLength, 262144, "kimi-k2.7-code 上下文应为 262144");
    assert.strictEqual(by("doubao-seed-2-1-turbo-260628").contextLength, 256000, "豆包 turbo 上下文应为 256000");
    // 服务端未标 contextWindow 的模型必须记 0（未知），绝不编造
    assert.strictEqual(by("glm-5.1").contextLength, 0, "未标窗口的模型应记 0（不编造默认值）");
    assert.strictEqual(by("qwen3.6-plus").contextLength, 0, "未标窗口的模型应记 0（不编造默认值）");
    // 全表不得出现 131072 这个第三方占位值
    const bogus = cat.models.filter((m) => m.contextLength === 131072);
    assert.strictEqual(bogus.length, 0, `不得残留 131072 占位值，实际 ${bogus.map((m) => m.id).join(",")}`);
  });

  // ===== T4c 能力位与倍率来自权威源 =====
  await T("T4c 能力位/倍率取自公开目录实测值", () => {
    const cat = rules.get("catalog.json").lobster;
    const by = (id) => cat.models.find((m) => m.id === id);
    assert.strictEqual(by("deepseek-flash").capabilities.images, true, "DeepSeek-V4.1-Flash 支持图片");
    assert.strictEqual(by("deepseek-v4-pro").capabilities.images, false, "DeepSeek-V4-Pro 不支持图片");
    assert.strictEqual(by("glm-5.3-flash").capabilities.images, true, "GLM-5.3-Flash 支持图片");
    assert.strictEqual(by("deepseek-flash").rate, 0.05, "deepseek-flash 倍率 0.05");
    assert.strictEqual(by("glm-5.3-flash").rate, 0.06, "glm-5.3-flash 倍率 0.06");
    assert.strictEqual(by("kimi-k3").rate, 20, "kimi-k3 倍率 20");
  });

  // ===== T4d 公开目录端点（无需鉴权，权威兜底源） =====
  await T("T4d LIVE 公开 pricing-catalog 可达且含真实 contextWindow", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const c = rules.get("headers.json").lobster;
    assert.ok(c.pricingCatalogUrl, "应配置公开目录端点");
    const r = await adapters.httpJson(c.pricingCatalogUrl, { method: "GET", headers: { accept: "application/json" } });
    assert.strictEqual(r.status, 200, `公开目录应 200（无需鉴权），实际 ${r.status}`);
    const tm = (r.data && r.data.data && r.data.data.textModels) || [];
    assert.ok(tm.length >= 25, `公开目录文本模型应 ≥25，实际 ${tm.length}`);
    const flash = tm.find((m) => m.modelId === "deepseek-flash");
    assert.ok(flash, "公开目录应含 deepseek-flash");
    assert.strictEqual(flash.contextWindow, 1000000, "deepseek-flash 上下文应为 1M");
    assert.ok(tm.some((m) => m.modelId === "glm-5.3-flash"), "公开目录应含 glm-5.3-flash");
    console.log(`      textModels=${tm.length}  imageModels=${(r.data.data.imageModels || []).length}  videoModels=${(r.data.data.videoModels || []).length}`);
  });

  // ===== T5 强制流式（上游只支持 stream=true，非流式实测 500） =====
  await T("T5 rewriteBody 强制 stream=true + include_usage", () => {
    const out = ad.rewriteBody("deepseek-v4-pro", { model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.strictEqual(out.stream, true, "必须强制 stream=true（上游非流式返回 500）");
    assert.strictEqual(out.stream_options.include_usage, true, "应带 include_usage 以拿 usage");
    assert.strictEqual(out.model, "deepseek-v4-pro");
  });

  // ===== T6 内部字段剥离 + tool_choice 归一 =====
  await T("T6 rewriteBody 剥离内部字段并归一 tool_choice", () => {
    const out = ad.rewriteBody("glm-5.2", {
      model: "glm-5.2",
      messages: [],
      conversation_id: "x",
      conversationId: "y",
      prompt_cache_key: "z",
      tool_choice: "none",
      temperature: 0.3,
    });
    assert.strictEqual(out.conversation_id, undefined, "conversation_id 应被剥离");
    assert.strictEqual(out.conversationId, undefined, "conversationId 应被剥离");
    assert.strictEqual(out.prompt_cache_key, undefined, "prompt_cache_key 应被剥离");
    assert.strictEqual(out.tool_choice, undefined, "tool_choice='none' 应被删除");
    assert.strictEqual(out.temperature, 0.3, "标准字段应原样透传");
    // 对象形态的 tool_choice 必须保留
    const out2 = ad.rewriteBody("glm-5.2", { model: "glm-5.2", messages: [], tool_choice: { type: "function", function: { name: "f" } } });
    assert.ok(out2.tool_choice, "对象形态 tool_choice 应保留");
  });

  // ===== T7 模型名归一（下划线变体容错） =====
  await T("T7 mapModel 归一大小写/下划线变体", () => {
    assert.strictEqual(ad.mapModel("DeepSeek-V4-Pro"), "deepseek-v4-pro");
    assert.strictEqual(ad.mapModel("deepseek_v4_pro"), "deepseek-v4-pro");
    assert.strictEqual(ad.mapModel("GLM-5.2"), "glm-5.2");
    // 目录外模型原样透传（上游可能新增）
    assert.strictEqual(ad.mapModel("some-future-model"), "some-future-model");
  });

  // ===== T8 签到活动槽解析：slotState=empty 不算失败 =====
  await T("T8 fetchSlot 对 slotState=empty 的处理（版本门禁，非错误）", async () => {
    // 用假 token 打真实端点会被鉴权拦；这里只校验「无活动」分支的返回契约，
    // 通过直接注入假的 httpJson 不可行（模块私有），故走 LIVE 分支或跳过
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const r = await ad.fetchSlot({ token: "FAKE" }, "0.1.0");
    // 版本过旧：服务端返回 slotState=empty 且无 activity —— 必须被当成「无活动」而非错误
    assert.ok(r.ok, `旧版本应返回 ok:true + activity:null，实际 ${JSON.stringify(r)}`);
    assert.strictEqual(r.activity, null, "旧版本号应看不到活动");
  });

  // ===== T9 鉴权头形态（Bearer + 客户端能力/版本头） =====
  await T("T9 chatHeaders 头组正确", () => {
    const h = ad.chatHeaders("tok-123");
    assert.strictEqual(h.authorization, "Bearer tok-123");
    assert.ok(h["user-agent"].startsWith("LobsterAI/"), `UA 应是 LobsterAI/<ver>，实际 ${h["user-agent"]}`);
    assert.strictEqual(h["X-LobsterAI-Client-Capabilities"], "kimi-k3-agentic-v1");
    assert.ok(/^\d{4}\.\d+/.test(h["X-LobsterAI-Client-Version"]), "版本头应是 2026.x 形态");
    assert.ok(h.accept.includes("text/event-stream"), "对话头应接受 SSE");
  });

  // ===== T10 refreshToken 无 refreshToken 时明确报错 =====
  await T("T10 refreshToken 缺凭据时明确报错（不发请求）", async () => {
    const r = await ad.refreshToken({}, { token: "x", refreshToken: "" });
    assert.strictEqual(r.ok, false);
    assert.ok(/refreshToken/.test(r.message), `应提示缺 refreshToken，实际 ${r.message}`);
  });

  // ===== T11 trial 明确不可用 =====
  await T("T11 trial 返回不可用（龙虾无加油包）", async () => {
    const r = await ad.trial();
    assert.strictEqual(r.ok, false);
    assert.ok(/加油包/.test(r.message));
  });

  // ===== T12 版本号解析（LIVE：官方更新接口） =====
  await T("T12 refreshVersion 从官方更新接口取到 2026.x 版本号", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const v = await ad.refreshVersion();
    assert.ok(/^\d{4}\.\d+/.test(v), `版本号应形如 2026.9.23，实际 ${v}`);
    console.log(`      clientVersion = ${v}`);
  });

  // ===== T13 LIVE：签到活动元数据（公开只读，不带凭据） =====
  await T("T13 LIVE 签到活动存在且奖励 100 积分", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const version = await ad.refreshVersion();
    // 无鉴权即可读活动槽（服务端对未登录也返回活动元数据，只是 authenticated:false）
    const r = await adapters.httpJson(
      `${UPSTREAM}/api/client-activities/slot?placement=desktop_sidebar&clientVersion=${encodeURIComponent(version)}&containerApiVersion=2&platform=win32`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    assert.ok(r.ok, `slot 应可达，实际 HTTP ${r.status}`);
    const d = r.data && r.data.data;
    assert.strictEqual(d.slotState, "available", `新版本号应看到活动，实际 ${d.slotState}`);
    assert.ok(d.activity && d.activity.activityCode, "应返回活动");
    assert.strictEqual(d.activity.activityType, "daily_check_in");
    // 取活动状态，核对奖励金额
    const ctx = await adapters.httpJson(
      `${UPSTREAM}/api/client-activities/${encodeURIComponent(d.activity.activityCode)}/context?configRevision=${d.activity.configRevision}`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    assert.ok(ctx.ok, `context 应可达，实际 HTTP ${ctx.status}`);
    const st = ctx.data && ctx.data.data && ctx.data.data.state;
    assert.ok(st, "context 应带 state");
    assert.strictEqual(Number(st.rewardCredits), 100, `每日签到奖励应为 100，实际 ${st.rewardCredits}`);
    assert.ok(Array.isArray(ctx.data.data.actions) && ctx.data.data.actions.includes("check_in"), "actions 应含 check_in");
    console.log(`      activity=${d.activity.activityCode} reward=${st.rewardCredits} 周期=${d.activity.startAt}→${d.activity.endAt}`);
  });

  // ===== T14 LIVE：旧版本号被门禁隐藏（防回归） =====
  await T("T14 LIVE 旧版本号被服务端隐藏活动（版本门禁仍生效）", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const r = await adapters.httpJson(
      `${UPSTREAM}/api/client-activities/slot?placement=desktop_sidebar&clientVersion=0.1.0&containerApiVersion=2&platform=win32`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    const d = r.data && r.data.data;
    assert.strictEqual(d.slotState, "empty", `旧版本号应拿到 slotState=empty，实际 ${d.slotState}`);
  });

  // ===== T15 LIVE：对话/目录端点存在（无鉴权 → 401，证明端点活着） =====
  await T("T15 LIVE 上游端点存在（无鉴权应 401 而非 404）", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    for (const u of [`${UPSTREAM}/api/proxy/v1/models`, `${UPSTREAM}/api/models/available`]) {
      const r = await adapters.httpJson(u, { method: "GET", headers: { accept: "application/json" } });
      assert.strictEqual(r.status, 401, `${u} 应返回 401（端点存在、仅缺鉴权），实际 ${r.status}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("selftest crashed:", e);
  process.exit(1);
});
