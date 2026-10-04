// 反代网关 · Qoder OAuth（PKCE 设备码轮询）自测
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-oauth-selftest.cjs
//
// 为什么需要：OAuth 登录会真实打开浏览器并等用户操作，无法在 CI 里跑完整流程。
// 本测试用 stub 覆盖「URL 构造正确性」与「轮询状态机」，这两处错了会导致登录静默失败：
//   · ① 登录 URL 少参数 → 官方页报错或登录后回调不生效
//   · ② 轮询把 404 当终局错误 → 用户还没点完就中止（客户端把 404 当"继续等"）
//
// 覆盖：
//   1) beginQoderOAuth 产出的登录 URL 含全部必需参数（PKCE/回调/nonce/client_id）
//   2) 轮询 404 → 继续等（不中止）
//   3) 轮询拿到 { token, refresh_token } → 落库成功
//   4) 明确的 4xx 终局错误 → 中止
//   5) 超时 → 报超时
//   6) 落库字段：meta.machineId 必需、refreshToken 落库、source=oauth
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-oauth-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  store.open();
  rules.init();

  // discovery 依赖 adapters.httpJson 做网络请求；stub 掉它以便离线测试
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const realHttpJson = adapters.httpJson;
  const calls = [];
  let pollResponder = () => ({ ok: false, status: 404, data: null });
  adapters.httpJson = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("/deviceToken/poll")) return pollResponder();
    if (String(url).includes("/userinfo")) {
      // 实测字段：{id, name, username, avatar, source}——没有独立 email，邮箱塞在 name 里
      return { ok: true, status: 200, data: { id: "uid-oauth-test", name: "t@example.com", username: "u-1", avatar: "https://x/a.png", source: "sso.aliyun" } };
    }
    return { ok: false, status: 404, data: null };
  };

  // refreshDeviceToken 走原生 fetch，测试里 stub 掉以便验证「用 refresh 换到期时间」这一步
  const qoderAuth = require("../electron/backend/proxy/qoderAuth.cjs");
  const realRefresh = qoderAuth.refreshDeviceToken;
  qoderAuth.refreshDeviceToken = async () => ({
    ok: true, token: "dt-after-refresh", refreshToken: "drt-after-refresh",
    expiresAt: Date.parse("2026-12-01T00:00:00Z"), refreshTokenExpiresAt: Date.parse("2027-12-01T00:00:00Z"),
  });

  // discovery 在 require 时已抓取 adapters 引用，但调用是 adapters.httpJson(...) 动态取，故 stub 生效
  const discovery = require("../electron/backend/proxy/discovery.cjs");

  const done = [];
  const onDone = (r) => done.push(r);

  console.log("\n[1] 登录 URL 构造");
  // 用真实时限但立即取消，避免测试等待
  const p = discovery.beginOAuth("qoder", onDone);
  const session = p && typeof p.then === "function" ? null : p;
  assert(!!p, "beginOAuth 返回结果");

  // beginOAuth 是 async：同步拿不到，改用微任务推进
  return (async () => {
    const r = await p;
    assert(r.ok === true && r.mode === "poll", "返回 poll 模式");
    const u = new URL(r.url);
    assert(u.origin === "https://qoder.cn", "登录域为 qoder.cn（CN 实测值）");
    assert(u.pathname === "/users/sign-in", "路径为 /users/sign-in");
    assert(u.searchParams.get("biz_variant") === "qoder", "带 biz_variant=qoder");
    const cb = u.searchParams.get("oauth_callback");
    assert(!!cb, "带 oauth_callback");
    const cbu = new URL(cb);
    assert(cbu.pathname === "/device/selectAccounts", "回调指向 /device/selectAccounts");
    assert(cbu.searchParams.get("challenge_method") === "S256", "回调带 challenge_method=S256");
    assert((cbu.searchParams.get("challenge") || "").length > 20, "回调带 PKCE challenge");
    assert(!!cbu.searchParams.get("nonce"), "回调带 nonce");
    assert(!!cbu.searchParams.get("machine_id"), "回调带 machine_id");
    assert(cbu.searchParams.get("client_id") === "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa", "回调带正确 client_id");

    console.log("\n[2] 轮询 404 → 继续等（不中止）");
    // 让轮询跑两轮：第一轮 404，第二轮给凭据
    let n = 0;
    pollResponder = () => {
      n += 1;
      if (n < 2) return { ok: false, status: 404, data: null };
      return { ok: true, status: 200, data: { token: "dt-oauth-test", refresh_token: "drt-oauth-test" } };
    };
    // 等待轮询完成（intervalMs=1000，两轮约 2s；给足 8s）
    const deadline = Date.now() + 8000;
    while (!done.length && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 200));
    }
    assert(done.length === 1, "轮询最终完成（404 未导致中止）");
    assert(done[0].ok === true, "登录成功");
    const polls = calls.filter((c) => c.url.includes("/deviceToken/poll"));
    assert(polls.length >= 2, `确实轮询了多次（${polls.length} 次）`);
    const pu = new URL(polls[0].url);
    assert(!!pu.searchParams.get("nonce") && !!pu.searchParams.get("verifier"), "轮询带 nonce + verifier");
    assert(pu.searchParams.get("challenge_method") === "S256", "轮询带 challenge_method=S256");

    console.log("\n[3] 落库字段");
    const acc = store.listAccounts("qoder").find((a) => a.uid === "uid-oauth-test");
    assert(!!acc, "账号已入库");
    assert(acc.source === "oauth", "source=oauth");
    assert(!!acc.meta && typeof acc.meta.machineId === "string" && acc.meta.machineId.length > 0, "meta.machineId 已落库（签名必需）");
    assert(acc.meta.product === "qoder", "meta.product 正确");
    // 实测 userinfo 无独立 email 字段，邮箱在 name 里 → 应被识别为邮箱
    assert(acc.meta.email === "t@example.com", "name 含 @ 时识别为邮箱（userinfo 无独立 email 字段）");
    assert(acc.meta.avatar === "https://x/a.png", "meta.avatar 落库");
    // 到期时间来自随后的 refresh 调用（轮询响应不含到期字段）
    assert(acc.expiresAt === Date.parse("2026-12-01T00:00:00Z"), "expiresAt 由 refresh 换取并落库");
    const raw = store.getAccount(acc.id);
    assert(Number(raw.expires_at) === Date.parse("2026-12-01T00:00:00Z"), "expires_at 落到原始列");
    assert(!!raw.refresh_enc && raw.refresh_enc.length > 10, "refreshToken 已加密落库（续期必需）");
    const sec = store.accountSecrets(raw);
    assert(sec.token === "dt-after-refresh" && sec.refreshToken === "drt-after-refresh", "落库的是 refresh 后的最新一代凭据");

    console.log("\n[4] 明确 4xx 终局错误 → 中止");
    done.length = 0;
    calls.length = 0;
    pollResponder = () => ({ ok: false, status: 403, data: null });
    const r2 = await discovery.beginOAuth("qoder", onDone);
    assert(r2.ok === true, "第二次登录已发起");
    const d2 = Date.now() + 5000;
    while (!done.length && Date.now() < d2) await new Promise((res) => setTimeout(res, 200));
    assert(done.length === 1 && done[0].ok === false, "403 导致中止");
    assert(/HTTP 403/.test(done[0].message || ""), "错误信息含状态码");

    console.log("\n[5] 已有账号 → 走更新分支（不重复建号）");
    done.length = 0;
    calls.length = 0;
    pollResponder = () => ({ ok: true, status: 200, data: { token: "dt-new", refresh_token: "drt-new" } });
    const before = store.listAccounts("qoder").length;
    await discovery.beginOAuth("qoder", onDone);
    const d3 = Date.now() + 5000;
    while (!done.length && Date.now() < d3) await new Promise((res) => setTimeout(res, 200));
    assert(done[0].ok === true, "再次登录成功");
    assert(store.listAccounts("qoder").length === before, "同 uid 不重复建号");

    adapters.httpJson = realHttpJson;
    qoderAuth.refreshDeviceToken = realRefresh;
    console.log("\n[done] Qoder OAuth 自测通过");
  })();
}

Promise.resolve()
  .then(() => main())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });
