/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 小浣熊「多机共用一套凭据」自测：刷新被服务端拒 → 先拉远端取新凭据再判死；刷新成功回传。
// 运行：node scripts/test-raccoon-multi-machine.cjs
// 全程离线：fetch 与 WebDAV 传输层都打桩，只碰 AGENTHUB_DATA_DIR 指向的临时目录。
//
// 缺陷回顾（本文件逐条钉死，改动前必红）：
//   ① refresh_token 单副本、用后轮换作废 ⇒ 另一台机器同步过去的那份早晚作废，
//      刷新必吃 401/200822。原实现只重读**本机** auth.json（跨机取不到）⇒ 直接判 expired
//      ⇒ 号池标「需重新登录」；
//   ② 刷新成功后对端手里的 refresh 立刻作废，而回传要等到下一轮定时同步（小时级）
//      ⇒ 这段时间对端一用就掉登录。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-raccoon-mm-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
process.env.APPDATA = path.join(TMP, "appdata");
// raccoonAuth 读的是 ~/.box-agent/config/auth.json：把家目录也钉进沙箱，绝不碰真实登录文件
process.env.USERPROFILE = path.join(TMP, "home");
process.env.HOME = process.env.USERPROFILE;
process.env.AGENTHUB_POOL_PUSH_DEBOUNCE_MS = "40"; // 去抖窗口缩到 40ms，自测不必等 60s
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.APPDATA, { recursive: true });
fs.mkdirSync(process.env.USERPROFILE, { recursive: true });

const rules = require("../electron/backend/proxy/rules.cjs");
const store = require("../electron/backend/proxy/store.cjs");
const adapters = require("../electron/backend/proxy/management-adapters.cjs");
const poolsync = require("../electron/backend/proxy/poolsync.cjs");
const config = require("../electron/backend/config.cjs");
const webdav = require("../electron/backend/webdav.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra ? " —— " + extra : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const PASS = "agenthub-selftest-pass"; // ≥8 位，避开弱口令告警
const DEV_B = "bbbbbbbb"; // 远端设备 id（本机是 aaaaaaaa）

/** 造一枚假 JWT：只求 payload.exp 可解（util.jwtDecode 不验签） */
function jwt(expMs, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(expMs / 1000), ...(sid ? { sid } : {}) })}.sig`;
}

// ===== 打桩：配置（WebDAV 已配好）+ WebDAV 传输层（内存远端） =====
config.moduleWebdav = () => ({ endpoint: "https://dav.example.com", username: "u", password: PASS, passphrase: PASS, root: "/agenthub-proxy" });
const realLoadConfig = config.loadConfig.bind(config);
config.loadConfig = () => {
  const c = realLoadConfig();
  return { ...c, webdav: { ...(c.webdav || {}), deviceId: "aaaaaaaa", deviceName: "本机" }, proxy: { ...(c.proxy || {}) } };
};

const remote = { files: new Map(), puts: [], lists: 0, gets: [] };
webdav.list = async (url) => {
  remote.lists++;
  if (!url.includes("/archives")) return [];
  return [...remote.files.keys()].filter((n) => n.endsWith(".zip") && url.endsWith(n) === false).map((n) => ({ name: n, isDir: false }));
};
webdav.get = async (url) => {
  const name = url.split("/").pop();
  remote.gets.push(name);
  return remote.files.get(name) || null;
};
webdav.getText = async () => "";
webdav.put = async (url, _w, body) => { remote.puts.push({ name: url.split("/").pop(), size: (body && body.length) || 0 }); };
webdav.test = async () => ({ ok: true });
webdav.ensureDir = async () => {};
webdav.tryBeginSync = () => true;
webdav.endSync = () => {};
webdav.setActiveSignal = () => {};
webdav.isNetworkError = () => false;
webdav.describeFailure = (_t, e) => String((e && e.message) || e);

// ===== 打桩：上游 fetch =====
let fetchCalls = [];
let refreshRoutes = []; // [{ expectRefresh, status, body }]
function installFetch() {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? String(opts.body) : "";
    let sent = "";
    try { sent = JSON.parse(body).refresh_token || ""; } catch { /* 非刷新请求 */ }
    fetchCalls.push({ url: u, sent });
    for (const r of refreshRoutes) {
      if (r.urlPart && !u.includes(r.urlPart)) continue;
      if (r.expectRefresh !== undefined && sent !== r.expectRefresh) continue;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ code: -1, message: "stub 未匹配 " + u }), { status: 404 });
  };
}

/** 把「另一台设备」的号池归档放进内存远端 */
function putRemoteArchive(accounts, devId = DEV_B) {
  const snap = { format: "agenthub-proxy-pool@1", deviceId: devId, deviceName: "另一台", exportedAt: now, channel: "", accounts };
  remote.files.set(`${devId}.zip`, poolsync.encodeArchive(snap, PASS));
}

/** 造一个真实账号行（走 store，拿到的是 row：与适配器实际收到的形状一致） */
function seedAccount({ uid, token, refreshToken }) {
  const id = store.addAccount({ channel: "raccoon", uid, name: "小浣熊 " + uid, token, refreshToken, source: "oauth", expiresAt: 0, meta: { deviceId: "d-" + uid } });
  return store.getAccount(id);
}
const secretsOf = (row) => store.accountSecrets(row);
const remoteRow = (o) => ({
  key: `raccoon:${o.uid}`, channel: "raccoon", uid: o.uid, name: "小浣熊 " + o.uid,
  token: o.token, refreshToken: o.refreshToken, expiresAt: 0, credits: 0, creditsAt: 0,
  updatedAt: o.updatedAt || now, meta: {},
  ...(o.tokenAt !== undefined ? { tokenAt: o.tokenAt } : {}),
  ...(o.tokenExp !== undefined ? { tokenExp: o.tokenExp } : {}),
  source: "oauth",
});

(async () => {
  rules.init();
  store.open();
  const ad = adapters.get("raccoon");
  ok(!!ad, "拿到 raccoon 适配器");

  // ===== ① 401 后从远端号池取到新 refresh ⇒ 刷新成功（旧实现直接判 expired） =====
  console.log("\n[1] 刷新被拒 → 拉远端取新凭据 → 重试成功");
  {
    const UID = "1001";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-old" });
    // 本机这份是 2 小时前刷出来的（真实场景：本机刷完、对端之后又刷了一次并轮换）
    store.updateAccount(row.id, { token: jwt(now - 60000), refreshToken: "rt-old", tokenAt: now - 7200000 });
    putRemoteArchive([remoteRow({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-rotated", tokenAt: now - 1000, tokenExp: now - 60000 })]);
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", expectRefresh: "rt-old", status: 401, body: { code: 401, message: "unauthorized" } },
      { urlPart: "/auth/v1/refresh", expectRefresh: "rt-rotated", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-x"), refresh_token: "rt-newest" } } },
      { urlPart: "/auth/v1/user_info", status: 401, body: { code: 401 } },
    ];
    remote.lists = 0; remote.gets = [];
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === true, "旧 refresh 被拒后仍刷新成功（改动前：重读本机文件取不到 ⇒ expired）", JSON.stringify(r));
    ok(r.token === jwt(now + 3600000, "sid-x"), "用的是远端那份新 refresh 换回来的 access");
    ok(r.refreshToken === "rt-newest", "返回轮换后的 refresh_token");
    ok(remote.lists > 0 && remote.gets.includes(`${DEV_B}.zip`), "确实拉取过远端号池（不是凭空成功）");
    const sentSeq = fetchCalls.filter((c) => c.sent).map((c) => c.sent);
    ok(sentSeq[0] === "rt-old" && sentSeq[1] === "rt-rotated", "先用旧值试、再拿远端新值重试（顺序钉死）", sentSeq.join("→"));
  }

  // ===== ② 远端 refresh 与手里相同但 access 还活着 ⇒ 直接采用，不重复刷新 =====
  console.log("\n[2] 远端没换 refresh 但 access 仍在线 → 直接采用（省一次轮换）");
  {
    const UID = "1002";
    const dead = jwt(now - 60000);
    const alive = jwt(now + 3600000);
    const row = seedAccount({ uid: UID, token: dead, refreshToken: "rt-same" });
    putRemoteArchive([remoteRow({ uid: UID, token: alive, refreshToken: "rt-same", tokenAt: now, tokenExp: now + 3600000 })]);
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 401, body: { code: 401, message: "unauthorized" } },
      { urlPart: "/auth/v1/user_info", status: 401, body: { code: 401 } },
    ];
    remote.lists = 0;
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === true && r.adopted === true, "直接采用远端仍有效的 access（adopted 标记）", JSON.stringify(r));
    ok(r.token === alive, "拿到的是远端那把还没过期的 access");
    ok(fetchCalls.filter((c) => c.url.includes("/auth/v1/refresh")).length === 1, "只朝刷新端点发过一次请求（不再多刷一次把对端作废）");
  }

  // ===== ③ 三条兜底全不成立 ⇒ 才判 expired，且文案说明「已尝试拉取」 =====
  console.log("\n[3] 兜底全不成立 → 判失效，文案分流");
  {
    const UID = "1003";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-dead" });
    putRemoteArchive([remoteRow({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-dead", tokenAt: now, tokenExp: now - 60000 })]);
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 400, body: { code: 200822, message: "refresh token conflict or reused" } },
      { urlPart: "/auth/v1/user_info", status: 401, body: { code: 401 } },
    ];
    const r = await ad.refreshToken(row, secretsOf(row));
    ok(r.ok === false && r.expired === true, "仍判 expired（该判死的时候不含糊）");
    ok(String(r.message).includes("200822"), "文案带上服务端拒绝码（200822=并发抢刷）", r.message);
    ok(String(r.message).includes("已从其他设备拉取过"), "文案说明已尝试跨机取新凭据", r.message);
  }

  // ===== ④ WebDAV 不可用时不阻断：照旧判失效，但不会卡住，且不谎报「已尝试拉取」 =====
  console.log("\n[4] WebDAV 未配置 → 不阻断刷新链路");
  {
    const UID = "1004";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-x" });
    const realModuleWebdav = config.moduleWebdav;
    config.moduleWebdav = () => null; // 未配置
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 401, body: { code: 401 } },
      { urlPart: "/auth/v1/user_info", status: 401, body: { code: 401 } },
    ];
    const t0 = Date.now();
    const r = await ad.refreshToken(row, secretsOf(row));
    config.moduleWebdav = realModuleWebdav;
    ok(r.ok === false && r.expired === true, "判失效（不因 WebDAV 未配而抛错）");
    ok(Date.now() - t0 < 5000, "立即返回，没有被远端拖住");
    ok(!String(r.message).includes("已从其他设备拉取过"), "没拉成就不说「已拉取」（文案不谎报动作）", r.message);
  }

  // ===== ⑤ 刷新成功后去抖回传；且回传模式绝不碰墓碑与共享配置 =====
  console.log("\n[5] 刷新成功 → 去抖回传（uploadOnly）");
  {
    remote.puts = [];
    poolsync.pushSoon();
    poolsync.pushSoon(); // 去抖：窗口内再来一次不发第二次
    poolsync.pushSoon();
    await sleep(300);
    const names = remote.puts.map((p) => p.name);
    ok(names.filter((n) => n === "aaaaaaaa.zip").length === 1, "窗口内多次触发只上传一次本机归档", names.join(","));
    ok(names.includes("aaaaaaaa.json"), "顺手更新设备档案");
    ok(!names.some((n) => n.includes("tombstones")), "回传不动墓碑（没拉远端就推回会把对端删掉的账号复活）");
    ok(!names.some((n) => n.includes("shared-config")), "回传不动共享配置（模型映射/API Key 不该跟着刷号走）");
  }

  // ===== ⑥ sid 变化留告警（被顶号可诊断），首次记录不告警 =====
  console.log("\n[6] sid 比对：换会话才告警");
  {
    const UID = "1006";
    const row = seedAccount({ uid: UID, token: jwt(now - 60000), refreshToken: "rt-s" });
    installFetch();
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-1"), refresh_token: "rt-s1" } } },
    ];
    const r1 = await ad.refreshToken(row, secretsOf(row));
    ok(r1.ok === true && r1.sidChanged === false, "首次刷新：记录 sid、不告警");
    const row2 = store.getAccount(row.id);
    refreshRoutes = [
      { urlPart: "/auth/v1/refresh", status: 200, body: { code: 0, data: { access_token: jwt(now + 3600000, "sid-2"), refresh_token: "rt-s2" } } },
    ];
    const r2 = await ad.refreshToken(row2, secretsOf(row2));
    ok(r2.ok === true && r2.sidChanged === true, "二次刷新 sid 变了 ⇒ 标记（账号疑似在别处重新登录）");
    const st = store.getAccount(row.id);
    ok(String(st.meta).includes("sid-2"), "新 sid 已落 meta");
    ok(String(st.meta).includes("会话标识(sid)已变化"), "留了一条可诊断的告警（号池气泡看得到）");
    ok(Number(st.token_at) > 0, "sid 告警不污染凭据时刻");
  }

  // ===== ⑦ 拉取失败要把原异常交给 run 的分类器（取消态 / 网络文案都挂在它上面） =====
  // 重构把拉取循环抽进 pullChannel 时最容易踩的坑：catch 里压成字符串 → AbortError 不再是
  // AbortError（号池同步页「已取消」变成「失败」）、TypeError 不再是网络错误（可读文案退化成
  // 裸的 "fetch failed"）。这里直接钉「分类器收到的就是原异常」。
  console.log("\n[7] 拉取失败的原异常不被压平（取消 / 网络错误）");
  {
    const realList = webdav.list;
    webdav.list = async () => { throw Object.assign(new Error("同步已取消"), { name: "AbortError" }); };
    const r = await poolsync.run({});
    ok(r.ok === false && r.cancelled === true, "拉取阶段取消 ⇒ cancelled:true（不是失败态）", JSON.stringify(r));
    ok(poolsync.progress().stage === "cancelled", "同步状态落「已取消」");

    let seenNet = null;
    webdav.isNetworkError = (e) => { seenNet = e; return true; };
    webdav.describeFailure = () => "号池同步失败：网络错误（fetch failed）";
    webdav.list = async () => { throw new TypeError("fetch failed"); };
    const r2 = await poolsync.run({});
    ok(seenNet instanceof TypeError && seenNet.message === "fetch failed", "网络错误按原异常交给 isNetworkError（没被压成普通 Error）");
    ok(String(r2.message).includes("网络错误"), "走 describeFailure 出可读文案", r2.message);
    webdav.isNetworkError = () => false;
    webdav.describeFailure = (_t, e) => String((e && e.message) || e);
    webdav.list = realList;
  }

  const done = failed === 0;
  console.log(`\n${done ? "OK" : "FAIL"} 小浣熊多机凭据自测：${pass} 项通过，${failed} 项失败`);
  process.exit(done ? 0 : 1);
})().catch((e) => {
  console.error("自测异常：", e);
  process.exit(1);
});
