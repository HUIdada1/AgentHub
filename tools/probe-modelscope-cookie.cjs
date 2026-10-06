// 方案 A 可行性验证：OAuth 授权流程能否捕获魔搭 Web 会话 Cookie
//
// 验证内容（纯技术探查，不写任何用户数据）：
//   1. 用独立 partition 起授权窗，打开魔搭授权页
//   2. 授权完成后，从该 partition 的 cookie jar 读取 cookie
//   3. 关键：读到的 Cookie 能否调「点赞」与「login/info」（daily_active 触发端点）
//      —— 这两个正是 OAuth/ms- 令牌都不通的路径
//
// 用法：electron tools/probe-modelscope-cookie.cjs
// 结果写 %TEMP%\ms-cookie-probe.json
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { app, BrowserWindow, session } = require("electron");

const PORT = 18091;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`;
const SCOPES = "openid profile api-inference";
const HOST = "www.modelscope.cn";
const OUT = path.join(process.env.TEMP || ".", "ms-cookie-probe.json");
const result = { steps: [], cookies: null, verdict: {} };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8"); } catch { /* */ } };
const step = (n, d) => { result.steps.push({ n, d, at: new Date().toISOString() }); console.log(`[STEP] ${n}: ${JSON.stringify(d).slice(0, 240)}`); save(); };

// ⚠️ 关键：本脚本**不得**指向 AgentHub 的 userData（%APPDATA%\agenthub）。
// 初版犯过这个错：app.setPath("userData", …agenthub) 与正在运行的主进程共用同一目录，
// 两实例争抢 lockfile / Cookies / Local Storage → 弹出一连串 Electron 锁冲突错误窗口
// （功能仍能成功，因为 Cookie 走独立 partition，但弹窗很吓人）。
// 本脚本不需要读号池，故用**独立临时 userData**，与运行中的应用完全隔离。
app.setName("AgentHubCookieProbe");
app.setPath("userData", path.join(process.env.TEMP || ".", "ms-cookie-probe-ud"));

async function httpsJson(hostname, p, opts = {}) {
  const https = require("node:https");
  return new Promise((resolve) => {
    const r = https.request({ hostname, path: p, method: opts.method || "GET", headers: opts.headers || {}, timeout: 25000 }, (rs) => {
      let d = ""; rs.on("data", (c) => d += c);
      rs.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve({ s: rs.statusCode, j, raw: d }); });
    });
    r.on("error", (e) => resolve({ s: 0, j: null, raw: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ s: 0, j: null, raw: "timeout" }); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

app.whenReady().then(async () => {
  // 1) 动态注册（拿 client_id/secret）
  const regBody = JSON.stringify({ client_name: "AgentHub cookie probe", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_post", scope: SCOPES });
  const reg = await httpsJson(HOST, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(regBody), accept: "application/json" }, body: regBody });
  if (!reg.j || !reg.j.client_id) { step("注册失败", { status: reg.s, raw: String(reg.raw).slice(0, 200) }); app.exit(1); return; }
  const { client_id, client_secret } = reg.j;
  step("动态注册", { client_id });

  // 2) 回环服务器等授权码
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = `https://${HOST}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPES)}&state=${state}`;
  fs.writeFileSync(path.join(process.env.TEMP || ".", "ms-cookie-url.txt"), authUrl, "utf8");
  console.log("\n===== 请在弹出的窗口里完成登录并点「授权」 =====\n");

  const codePromise = new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname !== "/oauth/callback") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h2>授权成功</h2><p>请回到 AgentHub 查看验证结果。</p>");
      server.close();
      resolve(u.searchParams.get("code"));
    });
    server.listen(PORT, "127.0.0.1");
    setTimeout(() => { try { server.close(); } catch { /* */ } resolve(null); }, 300000);
  });

  // 3) 用独立 partition 起授权窗（关键：独立 session 便于读 cookie）
  const part = `ms-cookie-probe-${Date.now()}`;
  const sess = session.fromPartition(part, { cache: false });
  const win = new BrowserWindow({
    width: 480, height: 760, show: true, center: true, autoHideMenuBar: true,
    title: "魔搭授权（Cookie 可行性验证）",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: part },
  });
  win.loadURL(authUrl);

  // 4) 实时观察 Set-Cookie（webRequest 层）
  const seenCookies = new Set();
  try {
    sess.webRequest.onHeadersReceived((details, cb) => {
      const hdr = details.responseHeaders || {};
      for (const k of Object.keys(hdr)) {
        if (/^set-cookie$/i.test(k)) {
          for (const v of (Array.isArray(hdr[k]) ? hdr[k] : [hdr[k]])) {
            const name = String(v).split("=")[0];
            if (name && name !== "undefined") seenCookies.add(name);
          }
        }
      }
      cb({ responseHeaders: hdr });
    });
  } catch (e) { step("webRequest 挂载失败", { e: String(e.message || e) }); }

  const code = await codePromise;
  step("拿到授权码", { got: !!code });
  if (!code) { console.log("未拿到授权码，终止"); try { win.close(); } catch { /* */ } app.exit(1); return; }

  // 5) 等 3 秒让 Cookie 落盘，然后读 cookie jar
  await new Promise((r) => setTimeout(r, 3000));
  const all = await sess.cookies.get({});
  const relevant = all.filter((c) => /modelscope/i.test(c.domain || ""));
  result.cookies = {
    total: all.length,
    modelscopeDomains: [...new Set(relevant.map((c) => c.domain))],
    names: relevant.map((c) => c.name),
    seenFromHeaders: [...seenCookies],
    hasSessionLike: relevant.some((c) => /session|sso|login|token|ticket/i.test(c.name)),
  };
  step("读取 cookie jar", { total: all.length, modelscope: relevant.length, names: relevant.map((c) => c.name).slice(0, 20) });

  // 6) 关键验证：用捕获的 Cookie 调「点赞」与「login/info」
  const cookieHeader = relevant.map((c) => `${c.name}=${c.value}`).join("; ");
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const hdrs = { "user-agent": UA, accept: "application/json", origin: `https://${HOST}`, referer: `https://${HOST}/my/overview`, cookie: cookieHeader };

  if (cookieHeader) {
    const li = await httpsJson(HOST, "/api/v1/users/login/info", { headers: hdrs });
    result.verdict.loginInfo = { status: li.s, sample: String(li.raw).slice(0, 160) };
    step("Cookie 调 login/info（日活触发端点）", result.verdict.loginInfo);

    const tgt = await httpsJson(HOST, "/api/v1/dolphin/mcpServers", { method: "PUT", headers: { ...hdrs, "content-type": "application/json" }, body: JSON.stringify({ PageSize: 3, PageNumber: 1, Query: "", Criterion: [] }) });
    let t = null;
    try { const j = tgt.j; const ss = (((j.Data || {}).McpServer || {}).McpServers) || []; const s = ss.find((x) => !x.AlreadyStar) || ss[0]; if (s) t = { p: s.Path || s.FromSitePath || s.Namespace, n: s.Name }; } catch { /* */ }
    result.verdict.likeTargets = { status: tgt.s, gotTarget: !!t };
    step("Cookie 列点赞目标", result.verdict.likeTargets);

    if (t) {
      const like = await httpsJson(HOST, `/api/v1/mcpServers/${t.p}/${t.n}/stars`, { method: "PUT", headers: { ...hdrs, "content-type": "application/json" }, body: "{}" });
      result.verdict.like = { status: like.s, sample: String(like.raw).slice(0, 160) };
      step("Cookie 点赞（关键判定）", result.verdict.like);
    }
  } else {
    step("未捕获到 Cookie", {});
  }

  console.log("\n===== 结论 =====");
  console.log(JSON.stringify(result.verdict, null, 2));
  console.log("完整结果: " + OUT);
  try { win.close(); } catch { /* */ }
  app.exit(0);
}).catch((e) => { console.error("失败: " + (e && e.message)); try { app.exit(1); } catch { process.exit(1); } });
