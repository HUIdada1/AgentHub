// ModelScope OAuth 端到端验证（一次性探针，不入库）
//
// 验证链路（每一步都打印实测结果，不推测）：
//   1. POST /oauth/register 动态注册互联应用（拿 client_id / client_secret）
//   2. 起回环 HTTP 服务器 http://127.0.0.1:18080/oauth/callback
//   3. 拼授权 URL 并写入 %TEMP%\ms-oauth-url.txt（供外部打开浏览器）
//   4. 等回调拿 code → POST /oauth/token 换 access_token / refresh_token
//   5. GET /oauth/userinfo 验证身份端点
//   6. ★ 关键：用 OAuth access_token 调 api-inference.modelscope.cn/v1/chat/completions
//      —— 这决定 api-inference scope 是否真的可用（若不通，整套 OAuth 设计作废）
//   7. 用 refresh_token 换新 access_token（验证准入判据「可自助续期」）
//
// 用法：ELECTRON_RUN_AS_NODE=1 node tools/probe-modelscope-oauth.cjs
// 结果写入 %TEMP%\ms-oauth-result.json
"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = 18080;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`;
const HOST = "www.modelscope.cn";
const SCOPES = "openid profile api-inference";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OUT = path.join(os.tmpdir(), "ms-oauth-result.json");
const URL_FILE = path.join(os.tmpdir(), "ms-oauth-url.txt");

const result = { steps: [], tokens: null, apiInference: null, refresh: null, errors: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8"); } catch { /* */ } };
const step = (name, data) => { result.steps.push({ name, at: new Date().toISOString(), data }); console.log(`[STEP] ${name}: ${JSON.stringify(data).slice(0, 300)}`); save(); };
const fail = (name, err) => { const m = String((err && err.message) || err); result.errors.push({ name, message: m }); console.error(`[FAIL] ${name}: ${m}`); save(); };

function httpsReq(method, hostname, p, { headers, body } = {}) {
  return new Promise((resolve) => {
    const r = https.request({ hostname, path: p, method, headers: headers || {}, timeout: 30000 }, (rs) => {
      let d = ""; rs.on("data", (c) => d += c);
      rs.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve({ status: rs.statusCode, json: j, raw: d, headers: rs.headers }); });
    });
    r.on("error", (e) => resolve({ status: 0, json: null, raw: e.message, headers: {} }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, json: null, raw: "timeout", headers: {} }); });
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  // ===== 1. 动态注册 =====
  const regBody = JSON.stringify({
    client_name: "AgentHub (local probe)",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    scope: SCOPES,
  });
  const reg = await httpsReq("POST", HOST, "/oauth/register", {
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(regBody), "user-agent": UA, accept: "application/json" },
    body: regBody,
  });
  if (reg.status !== 200 || !reg.json || !reg.json.client_id) {
    fail("动态注册", `HTTP ${reg.status} ${String(reg.raw).slice(0, 200)}`);
    process.exit(1);
  }
  const { client_id, client_secret } = reg.json;
  step("动态注册成功", { client_id, client_secret: "***" + String(client_secret).slice(-6), redirect_uris: reg.json.redirect_uris });

  // ===== 2. 授权 URL =====
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = `https://${HOST}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPES)}&state=${state}`;
  fs.writeFileSync(URL_FILE, authUrl, "utf8");
  step("授权 URL 已生成", { urlFile: URL_FILE, urlPreview: authUrl.slice(0, 120) + "…" });
  console.log("\n===== 请在弹出的浏览器页面点击「授权」 =====");
  console.log(authUrl + "\n");

  // ===== 3. 回环服务器等回调 =====
  const code = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname !== "/oauth/callback") { res.writeHead(404); res.end("not found"); return; }
      const c = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (err) {
        res.end(`<h2>授权失败：${err}</h2><p>${u.searchParams.get("error_description") || ""}</p>`);
        server.close();
        fail("授权回调", err);
        resolve(null);
        return;
      }
      if (st !== state) {
        res.end("<h2>state 不匹配，已拒绝（CSRF 防护生效）</h2>");
        server.close();
        fail("授权回调", "state 不匹配");
        resolve(null);
        return;
      }
      res.end("<h2>授权成功</h2><p>可以关闭本页，回到 AgentHub 查看验证结果。</p>");
      server.close();
      resolve(c);
    });
    server.listen(PORT, "127.0.0.1", () => console.log(`[INFO] 回环服务器已监听 ${REDIRECT}`));
    // 5 分钟超时
    setTimeout(() => { try { server.close(); } catch { /* */ } fail("授权回调", "等待授权超时（300s）"); resolve(null); }, 300000);
  });
  if (!code) { console.log("未拿到授权码，验证终止"); process.exit(1); }
  step("拿到授权码", { codeLen: code.length, code: code.slice(0, 8) + "…" });

  // ===== 4. 换 token（client_secret_post，失败再试 basic） =====
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, client_secret }).toString();
  let tok = await httpsReq("POST", HOST, "/oauth/token", {
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(form), "user-agent": UA, accept: "application/json" },
    body: form,
  });
  let authMethod = "client_secret_post";
  if (tok.status !== 200) {
    const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");
    const form2 = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }).toString();
    tok = await httpsReq("POST", HOST, "/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}`, "content-length": Buffer.byteLength(form2), "user-agent": UA, accept: "application/json" },
      body: form2,
    });
    authMethod = "client_secret_basic";
  }
  if (tok.status !== 200 || !tok.json || !tok.json.access_token) {
    fail("换取令牌", `HTTP ${tok.status}（${authMethod}）${String(tok.raw).slice(0, 300)}`);
    process.exit(1);
  }
  const t = tok.json;
  // ⚠ 关键抗中断设计：令牌**立刻落盘**。上一版只把脱敏信息写进 result，
  // 进程被外部中断（如宿主命令被 abort）时令牌即丢失，必须让用户重新授权一次。
  // 落盘位置是本机临时目录，属一次性探针产物，用完即删。
  const TOKENS_FILE = path.join(os.tmpdir(), "ms-oauth-tokens.json");
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({
      client_id, client_secret,
      access_token: t.access_token, refresh_token: t.refresh_token || "",
      token_type: t.token_type, expires_in: t.expires_in, scope: t.scope,
      savedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    console.log(`[INFO] 令牌已落盘（供中断后独立复验）：${TOKENS_FILE}`);
  } catch (e) { console.error("[WARN] 令牌落盘失败：" + e.message); }
  result.tokens = {
    authMethod,
    token_type: t.token_type,
    expires_in: t.expires_in,
    scope: t.scope,
    has_refresh: !!t.refresh_token,
    access_len: String(t.access_token).length,
    access_prefix: String(t.access_token).slice(0, 6),
    id_token: t.id_token ? String(t.id_token).slice(0, 20) + "…" : null,
  };
  step("换取令牌成功", result.tokens);

  // ===== 5. userinfo =====
  const ui = await httpsReq("GET", HOST, "/oauth/userinfo", { headers: { authorization: `Bearer ${t.access_token}`, "user-agent": UA, accept: "application/json" } });
  step("userinfo", { status: ui.status, body: ui.json ? { sub: ui.json.sub, username: ui.json.username, nickname: ui.json.nickname } : String(ui.raw).slice(0, 200) });

  // ===== 6. ★ 关键：OAuth token 能否调 API-Inference =====
  const chatBody = JSON.stringify({ model: "deepseek-ai/DeepSeek-V4.1-Flash", stream: false, max_tokens: 300, messages: [{ role: "user", content: "只回复两个字：正常" }] });
  const chat = await httpsReq("POST", "api-inference.modelscope.cn", "/v1/chat/completions", {
    headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", "content-length": Buffer.byteLength(chatBody), accept: "application/json" },
    body: chatBody,
  });
  let chatText = null;
  if (chat.json && chat.json.choices && chat.json.choices[0]) chatText = String(chat.json.choices[0].message.content || "").trim().slice(0, 20);
  result.apiInference = {
    status: chat.status,
    ok: chat.status === 200,
    text: chatText,
    usage: chat.json && chat.json.usage ? chat.json.usage : null,
    error: chat.status === 200 ? null : String(chat.raw).slice(0, 300),
  };
  step("★ OAuth token 调 API-Inference", result.apiInference);

  // ===== 7. refresh_token 续期 =====
  if (t.refresh_token) {
    const rf = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id, client_secret }).toString();
    const rr = await httpsReq("POST", HOST, "/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(rf), "user-agent": UA, accept: "application/json" },
      body: rf,
    });
    result.refresh = {
      status: rr.status,
      ok: rr.status === 200 && !!(rr.json && rr.json.access_token),
      newAccessLen: rr.json && rr.json.access_token ? String(rr.json.access_token).length : null,
      rotatedRefresh: !!(rr.json && rr.json.refresh_token && rr.json.refresh_token !== t.refresh_token),
      error: rr.status === 200 ? null : String(rr.raw).slice(0, 300),
    };
    step("refresh_token 续期", result.refresh);
  } else {
    result.refresh = { ok: false, error: "上游未返回 refresh_token" };
    step("refresh_token 续期", result.refresh);
  }

  console.log("\n===== 验证结论 =====");
  console.log(JSON.stringify({ apiInference: result.apiInference, refresh: result.refresh, tokens: result.tokens }, null, 2));
  console.log(`\n完整结果：${OUT}`);
  process.exit(0);
}

main().catch((e) => { fail("主流程", e); process.exit(1); });
