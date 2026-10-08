// 小浣熊每日积分「两步懒结算」自测（全离线，stub 全局 fetch）
//
// 背景（2026-10-07 00:11 双账号实测）：每日 300 的落账是懒结算——服务端 00:00 只记账
// （grant_at），实际写入（created_at）要等当天首次 Web 会话活动。客户端启动时先调
// setting_info 再调 grant，两步缺一不可：单独 POST grant 恒返回 granted:false 且
// 积分明细（/points/v1/bills）当日无 daily_grant 单据。
//
// 本自测用 stub fetch 验证适配器 checkin 的契约：
//   T1 调用顺序：setting_info（GET）必须先于 grant（POST）——懒结算顺序
//   T2 granted:true  → claimed:true / already:false（本次新发放）
//   T3 granted:false → already:true  / claimed:false（当日已发放，幂等语义）
//   T4 setting_info 失败不阻断 grant（激活失败时仍要尝试领取）
//   T5 grant 401 → 凭证失效提示
//   T6 配置契约：settingUrl 与 grantUrl 同域同通道、均在 raccoon 配置中
//
// 跑法（与其它自测一致，需 Electron 的 Node）：
//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-raccoon-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 沙箱：绝不碰真实号池与真实配置
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "raccoon-selftest-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;
process.env.APPDATA = SANDBOX;

// ---- fetch stub：记录调用顺序 + 按路由返回 ----
const realFetch = global.fetch;
let stubRoutes = []; // [{ urlPart, method, status, body }]
let stubCalls = [];  // [{ seq, url, method, headers }]
let stubSeq = 0;

function installStub() {
  stubSeq = 0;
  stubCalls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = String((opts && opts.method) || "GET").toUpperCase();
    stubCalls.push({ seq: ++stubSeq, url: u, method, headers: (opts && opts.headers) || {} });
    for (const r of stubRoutes) {
      if (r.method === method && u.includes(r.urlPart)) {
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ code: -1, message: "stub 未匹配: " + method + " " + u }), { status: 404 });
  };
}
function callsOf(urlPart, method) {
  return stubCalls.filter((c) => c.url.includes(urlPart) && c.method === method);
}
const ok = (data) => ({ code: 0, message: "success", data });

let pass = 0;
let fail = 0;
const failures = [];
async function T(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${(e && e.message) || e}`);
    console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

(async () => {
  console.log("\n[1] 配置契约");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  rules.init();
  store.open();

  await T("T6a raccoon 配置含 settingUrl", () => {
    const c = adapters.get("raccoon").cfg();
    assert.ok(c.settingUrl && c.settingUrl.includes("/office/v3/setting_info"), "settingUrl 应指向 office/v3/setting_info，实际=" + c.settingUrl);
  });
  await T("T6b raccoon 配置含 grantUrl", () => {
    const c = adapters.get("raccoon").cfg();
    assert.ok(c.grantUrl && c.grantUrl.includes("/desktop/v1/login/points/grant"), "grantUrl 应指向 desktop/v1/login/points/grant");
  });
  await T("T6c setting_info 与 grant 同源（激活与领取必须同会话通道）", () => {
    const c = adapters.get("raccoon").cfg();
    assert.strictEqual(new URL(c.settingUrl).origin, new URL(c.grantUrl).origin, "两步必须同源");
    assert.ok(c.settingUrl.includes("/api/web/"), "setting_info 走 Web 会话通道");
  });

  console.log("\n[2] checkin 两步懒结算（stub fetch）");
  const acc = { id: "acc-1", uid: "uid-test", name: "T", channel: "raccoon", meta: {} };
  const secrets = { token: "dt-selftest", refreshToken: "drt-selftest" };
  const ad = adapters.get("raccoon");

  await T("T1 setting_info（GET）先于 grant（POST）——懒结算顺序契约", async () => {
    stubRoutes = [
      { urlPart: "/office/v3/setting_info", method: "GET", status: 200, body: ok({ point_grant_popups: [] }) },
      { urlPart: "/desktop/v1/login/points/grant", method: "POST", status: 200, body: ok({ granted: true, popup: { points: 300 } }) },
    ];
    installStub();
    const r = await ad.checkin(acc, secrets);
    const si = callsOf("/office/v3/setting_info", "GET");
    const gr = callsOf("/desktop/v1/login/points/grant", "POST");
    assert.strictEqual(si.length, 1, "setting_info 应恰好调用 1 次，实际 " + si.length);
    assert.strictEqual(gr.length, 1, "grant 应恰好调用 1 次，实际 " + gr.length);
    assert.ok(si[0].seq < gr[0].seq, "setting_info 必须先于 grant（懒结算顺序）");
    assert.strictEqual(r.claimed, true, "granted:true 应映射为 claimed");
    assert.strictEqual(r.already, false, "granted:true 时 already 应为 false");
  });

  await T("T2 granted:true → 已领取语义", async () => {
    stubRoutes = [
      { urlPart: "/office/v3/setting_info", method: "GET", status: 200, body: ok({}) },
      { urlPart: "/desktop/v1/login/points/grant", method: "POST", status: 200, body: ok({ granted: true, popup: null }) },
    ];
    installStub();
    const r = await ad.checkin(acc, secrets);
    assert.ok(r.ok, "应 ok");
    assert.strictEqual(r.claimed, true);
    assert.strictEqual(r.already, false);
    assert.ok(/已领取/.test(r.message), "message 应为已领取，实际=" + r.message);
  });

  await T("T3 granted:false → 当日已发放（幂等，不算失败）", async () => {
    stubRoutes = [
      { urlPart: "/office/v3/setting_info", method: "GET", status: 200, body: ok({}) },
      { urlPart: "/desktop/v1/login/points/grant", method: "POST", status: 200, body: ok({ granted: false, popup: null }) },
    ];
    installStub();
    const r = await ad.checkin(acc, secrets);
    assert.ok(r.ok, "幂等返回应 ok=true");
    assert.strictEqual(r.already, true);
    assert.strictEqual(r.claimed, false);
    assert.ok(/已领取过/.test(r.message), "message 应为今日已领取过，实际=" + r.message);
  });

  await T("T4 setting_info 失败不阻断 grant（激活失败仍尝试领取）", async () => {
    stubCalls = [];
    stubRoutes = [
      { urlPart: "/office/v3/setting_info", method: "GET", status: 500, body: { code: 500, message: "boom" } },
      { urlPart: "/desktop/v1/login/points/grant", method: "POST", status: 200, body: ok({ granted: true, popup: null }) },
    ];
    installStub();
    const r = await ad.checkin(acc, secrets);
    assert.strictEqual(callsOf("/desktop/v1/login/points/grant", "POST").length, 1, "setting_info 失败后 grant 仍应发起");
    assert.strictEqual(r.claimed, true, "grant 成功应 claimed:true");
  });

  await T("T5 grant 401 → 凭证失效提示（不误报为已领取）", async () => {
    stubRoutes = [
      { urlPart: "/office/v3/setting_info", method: "GET", status: 200, body: ok({}) },
      { urlPart: "/desktop/v1/login/points/grant", method: "POST", status: 401, body: { code: 200003, message: "authorization_verify_error" } },
    ];
    installStub();
    const r = await ad.checkin(acc, secrets);
    assert.strictEqual(r.ok, false, "401 应 ok=false");
    assert.ok(/凭证失效/.test(r.message), "401 应提示凭证失效，实际=" + r.message);
  });

  await T("T6d grant 请求带 Authorization 与平台头（客户端同款最小头集）", async () => {
    stubCalls = [];
    stubRoutes = [
      { urlPart: "/office/v3/setting_info", method: "GET", status: 200, body: ok({}) },
      { urlPart: "/desktop/v1/login/points/grant", method: "POST", status: 200, body: ok({ granted: false, popup: null }) },
    ];
    installStub();
    await ad.checkin(acc, secrets);
    const gr = callsOf("/desktop/v1/login/points/grant", "POST")[0];
    // HTTP 头大小写不敏感：适配器用小写 authorization（服务端等价接受）
    const names = Object.keys(gr.headers || {}).map((k) => k.toLowerCase());
    assert.ok(names.includes("authorization"), "grant 应带 Authorization，实际头=" + names.join(","));
    assert.ok(names.includes("x-client-platform"), "grant 应带 X-Client-Platform");
  });

  // ===== 思考参数归一（issue #78）：上游对 GLM 系发 off 直接 400（真实流水实证）=====
  console.log("\n[2] 思考参数归一（GLM 系）");
  const raccoonAd = adapters.get("raccoon");
  const rBody = (model, extra) => raccoonAd.rewriteBody(model, { model, messages: [{ role: "user", content: "hi" }], ...extra });

  await T("T7a GLM 系：reasoning_effort=off + thinking.disabled → 归一成官方 low，并摘掉 thinking", () => {
    const out = rBody("sn-glm-5-3-flash", { reasoning_effort: "off", thinking: { type: "disabled" } });
    assert.strictEqual(out.reasoning_effort, "low", "off 必须译成官方 low（关思考的最低调），实际=" + out.reasoning_effort);
    assert.ok(!("thinking" in out), "GLM 分支不得再带 thinking 字段");
    assert.ok(!("enable_thinking" in out), "GLM 分支不得再带 enable_thinking 字段");
  });

  await T("T7b GLM 系：high / max 原样保留，开启类取值归一到 high", () => {
    assert.strictEqual(rBody("sn-glm-5-3-flash", { reasoning_effort: "high" }).reasoning_effort, "high");
    assert.strictEqual(rBody("sn-glm-5-3-flash", { reasoning_effort: "max" }).reasoning_effort, "max");
    assert.strictEqual(rBody("sn-glm-5-3-flash", { reasoning_effort: "on" }).reasoning_effort, "high", "未知/开启类取值按官方开思考档归一");
    // 客户端发别名（glm-5.3）也要命中：归一跑在 mapModel 之后的 id 上
    assert.strictEqual(rBody("glm-5.3", { reasoning_effort: "off" }).reasoning_effort, "low");
  });

  await T("T7c 非 GLM 模型：思考相关字段逐字节不变（别替其它家族做决定）", () => {
    const out = rBody("raccoon-chat-ml-5-5", { reasoning_effort: "off", thinking: { type: "disabled" }, enable_thinking: false, temperature: 0.3 });
    assert.strictEqual(out.reasoning_effort, "off", "非 GLM 模型不得改 reasoning_effort");
    assert.deepStrictEqual(out.thinking, { type: "disabled" }, "非 GLM 模型不得摘 thinking");
    assert.strictEqual(out.enable_thinking, false, "非 GLM 模型不得摘 enable_thinking");
    assert.strictEqual(out.temperature, 0.3, "其它标准字段原样透传");
  });

  // 恢复真实 fetch
  global.fetch = realFetch;
  stubRoutes = [];
  stubCalls = [];

  console.log(`\n════ 汇总: 通过 ${pass}  失败 ${fail} ════`);
  if (failures.length) {
    console.log(failures.map((f) => "  ✗ " + f).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[OK] 全部通过");
  }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
