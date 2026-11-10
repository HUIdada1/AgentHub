/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// AStudio（讯飞 Astron Studio）本机登录页：手机验证码 / 账号密码 + 极验滑块。
//
// 依据 Agent2Providers `astudio/login_page.rs` + `auth.rs`：
//   GET  {base}chat/gee-captcha                  → 极验配置
//   POST {base}login/mobile/send-verify-code     → 发码（要极验）
//   POST {base}login/phone-quick-login           → 手机号登录（不要极验）
//   POST {base}login/check-account               → 账号密码登录（要极验）
//   登录成功后：POST tenant-app/v2/init-app（空体，带 Cookie）→ banned
//               GET  userInfo / GET bot/models/configs → uid / 手机 / 模型 api_key
//
// 为什么把登录页跑在 127.0.0.1：极验滑块必须在真实页面里完成，结果由页面回传本机，
// 不依赖系统浏览器的回环跳转；页面本身是参考实现的原文件（login-page.html）。
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const STUDIO_API_BASE = "https://agent.xfyun.cn/xingchen-studio/";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PAGE = path.join(__dirname, "login-page.html");

/** 进程内的一轮登录（flow → { result, server }） */
const flows = new Map();

function messageOf(value) {
  for (const key of ["message", "msg", "desc", "error"]) {
    const text = value && typeof value[key] === "string" ? value[key].trim() : "";
    if (text) return text;
  }
  return "";
}
/** 拆信封：`{code:0,data:…}`；code 非 0 时把上游文案带出来（auth.rs unwrap_envelope） */
function unwrapEnvelope(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if ("code" in value && value.code != null) {
    const zero = value.code === 0 || value.code === "0";
    if (!zero) {
      const message = messageOf(value);
      throw new Error(message ? `${operation}失败：${message}` : `${operation}失败（上游返回 code ${value.code}）`);
    }
  }
  return value.data !== undefined ? value.data : value;
}
function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}
function cookieOf(session) {
  const parts = [];
  if (session.ssoSessionId) { parts.push(`ssoSessionId=${session.ssoSessionId}`); parts.push(`sso_sessionid=${session.ssoSessionId}`); }
  if (session.accountId) parts.push(`account_id=${session.accountId}`);
  if (session.token) parts.push(`token=${session.token}`);
  return parts.join("; ");
}

function createLogin({ httpJson }) {
  const json = (url, options) => httpJson(url, { redirect: "error", ...options })
    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));

  async function getValue(apiPath, cookie, operation) {
    const r = await json(`${STUDIO_API_BASE}${apiPath}`, {
      method: "GET",
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    });
    if (!r.ok) throw new Error(`${operation}失败 HTTP ${r.status || 0}`);
    return unwrapEnvelope(r.data, operation);
  }
  async function postForm(apiPath, fields, operation) {
    const r = await json(`${STUDIO_API_BASE}${apiPath}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: formEncode(fields),
    });
    if (!r.ok) throw new Error(`${operation}失败 HTTP ${r.status || 0}`);
    return unwrapEnvelope(r.data, operation);
  }
  async function postEmpty(apiPath, cookie, operation) {
    const r = await json(`${STUDIO_API_BASE}${apiPath}`, {
      method: "POST", headers: { accept: "application/json", cookie, "content-length": "0" }, body: "",
    });
    if (!r.ok) throw new Error(`${operation}失败 HTTP ${r.status || 0}`);
    return unwrapEnvelope(r.data, operation);
  }

  /** 登录之后的收尾：租户 App、用户信息、模型凭据（auth.rs complete） */
  async function complete(login) {
    const accountId = String(login.account_id || login.accountId || "");
    const ssoSessionId = String(login.ssoSessionId || "");
    const token = String(login.token || "") || ssoSessionId;
    if (!accountId || !token) throw new Error("AStudio 登录返回不完整（缺少账号或令牌）");
    const session = {
      accountId, token, ssoSessionId,
      uid: login.uid == null ? "" : String(login.uid),
      mobile: String(login.mobile || login.phoneNum || login.phone || ""),
      nickname: String(login.nickname || ""),
    };
    const cookie = cookieOf(session);
    try {
      const app = await postEmpty("tenant-app/v2/init-app", cookie, "初始化账号");
      if (app && app.banned === true) throw new Error("AStudio 账号已被封禁");
    } catch (e) {
      if (/封禁/.test(String(e && e.message))) throw e;
      // 初始化失败不阻断登录（与参考实现一致：读不到就跳过）
    }
    if (!session.uid || !session.mobile) {
      const info = await getValue("userInfo", cookie, "读取用户信息").catch(() => null);
      const user = (info && info.userInfo) || info || {};
      if (!session.uid && user.uid != null) session.uid = String(user.uid);
      if (!session.mobile) session.mobile = String(user.mobile || user.telephone || "");
      if (!session.nickname) session.nickname = String(user.nickname || user.username || "");
    }
    const configs = await getValue("bot/models/configs", cookie, "读取模型凭据");
    const list = Array.isArray(configs) ? configs : [];
    const keyOf = (predicate) => {
      const hit = list.find(predicate);
      const key = hit && typeof hit.api_key === "string" ? hit.api_key.trim() : "";
      return key || "";
    };
    const apiKey = keyOf((item) => item && item.is_current === true)
      || keyOf((item) => item && item.is_default === true)
      || (list.map((item) => String((item && item.api_key) || "").trim()).find(Boolean) || "");
    if (!apiKey) throw new Error("这个 AStudio 账号没有可用的模型凭据");
    return { modelBearerToken: apiKey, cookie, ...session };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
        catch { reject(new Error("请求内容不是 JSON")); }
      });
      req.on("error", reject);
    });
  }

  function reply(res, status, body, type = "application/json; charset=utf-8") {
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), connection: "close" });
    res.end(body);
  }
  function fail(res, status, message) {
    reply(res, status, JSON.stringify({ error: message }));
  }

  function captchaOf(payload) {
    const source = (payload && payload.captcha) || {};
    const pick = (key) => String(source[key] || "").trim();
    const captcha = { challenge: pick("geetest_challenge"), validate: pick("geetest_validate"), seccode: pick("geetest_seccode") };
    if (!captcha.challenge || !captcha.validate || !captcha.seccode) throw new Error("请先完成滑块验证");
    return captcha;
  }
  /** 极验要求 seccode 先做一次 base64（auth.rs captcha_form） */
  function captchaForm(captcha) {
    return {
      geetest_challenge: captcha.challenge,
      geetest_validate: captcha.validate,
      geetest_seccode: Buffer.from(captcha.seccode, "utf8").toString("base64"),
    };
  }

  async function route(flow, req, res, token) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const provided = String(url.searchParams.get("t") || req.headers["x-login-token"] || "");
    if (provided !== token) return fail(res, 403, "登录页凭证不正确，请重新发起登录");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let page = "";
      try { page = fs.readFileSync(PAGE, "utf8"); } catch { return fail(res, 500, "登录页资源缺失"); }
      return reply(res, 200, page, "text/html; charset=utf-8");
    }
    if (url.pathname === "/api/geetest") {
      try { return reply(res, 200, JSON.stringify(await getValue("chat/gee-captcha", "", "读取极验配置"))); }
      catch (e) { return fail(res, 502, String((e && e.message) || e)); }
    }
    if (req.method !== "POST") return fail(res, 404, "没有这个接口");
    let payload;
    try { payload = await readBody(req); }
    catch (e) { return fail(res, 400, String((e && e.message) || e)); }
    try {
      const mobile = String(payload.mobile || "").trim();
      if (url.pathname === "/api/send-code") {
        if (!/^1\d{10}$/.test(mobile)) return fail(res, 400, "请输入 11 位手机号");
        await postForm("login/mobile/send-verify-code", { ...captchaForm(captchaOf(payload)), mobile, countryCode: "86" }, "发送验证码");
        return reply(res, 200, JSON.stringify({ ok: true }));
      }
      if (url.pathname === "/api/login-sms") {
        if (!/^1\d{10}$/.test(mobile)) return fail(res, 400, "请输入 11 位手机号");
        const code = String(payload.verifyCode || "").trim();
        if (!/^\d{6}$/.test(code)) return fail(res, 400, "请输入 6 位验证码");
        const login = await postForm("login/phone-quick-login", { mobile, verifyCode: code, countryCode: "86" }, "手机号登录");
        flow.result = { ok: true, account: await complete(login) };
        return reply(res, 200, JSON.stringify({ ok: true }));
      }
      if (url.pathname === "/api/login-password") {
        const account = String(payload.accountName || "").trim();
        const password = String(payload.accountPwd || "");
        if (!account) return fail(res, 400, "请输入账号");
        if (password.length < 6 || password.length > 20) return fail(res, 400, "密码长度必须为 6–20 位");
        const login = await postForm("login/check-account", { ...captchaForm(captchaOf(payload)), accountName: account, accountPwd: password }, "账号密码登录");
        flow.result = { ok: true, account: await complete(login) };
        return reply(res, 200, JSON.stringify({ ok: true }));
      }
      return fail(res, 404, "没有这个接口");
    } catch (e) {
      return fail(res, 502, String((e && e.message) || e));
    }
  }

  /** 起一轮登录：返回 { flow, url, poll, cancel } */
  function start() {
    const flowId = `astudio-web-${crypto.randomBytes(9).toString("hex")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const flow = { result: null, server: null, timer: null };
    const server = http.createServer((req, res) => {
      route(flow, req, res, token).catch((e) => fail(res, 500, String((e && e.message) || e)));
    });
    flow.server = server;
    flows.set(flowId, flow);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        flow.timer = setTimeout(() => {
          if (!flow.result) flow.result = { ok: false, message: "登录超时，请重新发起" };
          try { server.close(); } catch { /* 已关 */ }
        }, LOGIN_TIMEOUT_MS);
        const port = server.address().port;
        resolve({
          flow: flowId,
          url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`,
          poll: () => {
            if (!flow.result) return { pending: true };
            const result = flow.result;
            flows.delete(flowId);
            try { server.close(); } catch { /* 已关 */ }
            clearTimeout(flow.timer);
            return result.ok ? { done: true, account: result.account } : { failed: true, message: result.message };
          },
          cancel: () => {
            flows.delete(flowId);
            clearTimeout(flow.timer);
            try { server.close(); } catch { /* 已关 */ }
          },
        });
      });
    });
  }

  return { start };
}

module.exports = { createLogin, STUDIO_API_BASE, LOGIN_TIMEOUT_MS };
