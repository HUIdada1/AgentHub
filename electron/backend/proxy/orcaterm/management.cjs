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
// Account management only. No model invocation or conversation entry points.
//
// OrcaTerm（腾讯云遨驰终端）：**两步有状态**的 agent 协议。
// 依据 Agent2Providers `crates/providers/src/providers/orcaterm/`（mod.rs / credentials.rs /
// balance.rs / models.rs 模块头）。
//
// ── 上游形状（2026-10-16 桌面客户端 1.6.4 + Web 版实测）──────────────
//   POST {LIGHTAI}/assistant/conversation        建会话（→ cid-<uuid>-orcaterm）
//   POST {LIGHTAI}/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true   SSE 对话
//   POST {CGI}/cgi/api?action=GetUserInfo&uin=<uid>
//   POST {CGI}/cgi/api?action=DescribeUserBillingStatus&uin=<uid>   月度配额
//   POST {CGI}/cgi/api?action=OAuthRefreshToken&uin=<uid>           续期
//
// ── 有状态的含义 ─────────────────────────────────────────────
// 「一次转发 = 建会话 → SSE 两步」，**不是**跨请求保有上游状态：会话是请求内的
// （每个请求新建、用毕即弃），多轮历史拍平进输入文本。所以没有会话注册表。
//
// ── 凭据 ───────────────────────────────────────────────────
// 微信 OAuth 登录后的 HS256 JWT（`oauth_access_token`，约 2 小时），payload 里有
// `userId`（CGI 的 uin 参数）。**只解 payload、不验签** —— token 好不好用由上游说了算。
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const CGI_BASE = "https://api.orcaterm.cloud.tencent.com";
const LIGHTAI_BASE = "https://lightai.cloud.tencent.com";
/** 出站 UA（Web 版同款；上游对默认 UA 敏感） */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
/** assistant 接口的固定 query */
const ASSISTANT_QUERY = "name=orcaterm&mode=0&csrfCode=&sseresume=true";
/** 默认模型（未知模型显式回退到实测可用的这一档） */
const DEFAULT_MODEL = "TokenHub/glm-5.3-flash";

/** 静态模型清单（与桌面端面板逐项对齐；上游没有可拉的清单接口）。
 *  `hy4-preview` 面板有、上游未挂载（真发对话回流内 LLM_ERROR），仍收录——
 *  面板是用户可见的事实，选中后的明确错误由插件下发兜底。 */
const STATIC_MODELS = [
  ["hy4-preview", "Hy4-preview"], ["hy3", "Hy3"], ["kimi-k3", "Kimi-K3"],
  ["glm-5.3-flash", "GLM-5.3-Flash"], ["glm-5.3", "GLM-5.3"], ["glm-5.2", "GLM-5.2"],
  ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"], ["deepseek-v4-flash", "DeepSeek-V4-Flash"],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro"],
];

/** 把客户端模型名归一成上游的 `TokenHub/<name>`（未知显式回退默认档） */
function resolveModel(name) {
  const bare = String(name || "").trim().replace(/^TokenHub\//, "").trim();
  if (!bare) return DEFAULT_MODEL;
  return STATIC_MODELS.some(([id]) => id === bare) ? `TokenHub/${bare}` : DEFAULT_MODEL;
}

/** 从 JWT payload 取字段（只解 payload、不验签） */
function jwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const data = JSON.parse(json);
    return data && typeof data === "object" ? data : null;
  } catch { return null; }
}

/** 工厂：deps = { httpJson, rules, util, store } */
function makeOrcaTerm(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).orcaterm || {};
  const cgi = () => String(cfg().cgiBase || CGI_BASE).replace(/\/+$/, "");
  const ua = () => String(cfg().userAgent || USER_AGENT);

  /** 调一次 CGI 动作：HTTP 恒 200，业务码在 data.Response.Error */
  async function cgiAction(secrets, action, data) {
    const token = String((secrets && secrets.token) || "").trim();
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    const uin = String(meta.uin || meta.userId || "").trim();
    if (!uin) return { ok: false, message: "缺少 uin（账号 userId），请重新导入登录态" };
    const url = `${cgi()}/cgi/api?action=${encodeURIComponent(action)}&uin=${encodeURIComponent(uin)}`;
    const r = await httpJson(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "user-agent": ua() },
      body: JSON.stringify(data || {}),
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "登录态失效，请重新导入" };
    if (!r.ok || !r.data) return { ok: false, message: `CGI 请求失败 HTTP ${r.status || 0}` };
    const response = (r.data.data && r.data.data.Response) || (r.data.Response) || null;
    if (response && response.Error) {
      return { ok: false, message: `上游返回错误：${response.Error.Code || ""} ${response.Error.Message || ""}`.trim() };
    }
    return { ok: true, response: response || r.data };
  }

  return {
    id: "orcaterm",
    cfg,
    models() {
      return STATIC_MODELS.map(([id]) => id);
    },
    /** 没有可拉的清单接口（面板内置）→ 如实拒绝，models() 用静态表 */
    async fetchModels() {
      return { ok: false, message: "OrcaTerm 上游没有模型清单接口（清单内置在客户端面板里），已使用内置 9 项" };
    },
    /** 余额：DescribeUserBillingStatus 的月度 AI 配额 */
    async queryCredits(account, secrets) {
      const r = await cgiAction(secrets, "DescribeUserBillingStatus", {});
      if (r.authError) return { authError: true, message: r.message };
      if (!r.ok) return { error: r.message };
      const body = r.response || {};
      const stats = Array.isArray(body.usageStats) ? body.usageStats : [];
      if (!stats.length) return { unavailable: true, message: "上游未返回用量配额（该账号可能没有月度 AI 配额）" };
      const packages = [];
      let remaining = 0;
      stats.forEach((row, index) => {
        const limit = Number(row && row.quotaLimit) || 0;
        const used = Number(row && row.quotaUsed) || 0;
        const left = Math.max(limit - used, 0);
        remaining += left;
        const end = Date.parse(String((row && row.quotaEndDate) || ""));
        packages.push({
          code: String((row && row.feature) || `q${index}`),
          name: String((row && row.feature) || "AI 配额"),
          total: limit, used, remaining: left,
          expiresAt: Number.isFinite(end) ? end : 0, ord: index,
        });
      });
      return { credits: remaining, expiresAt: packages.find((p) => p.expiresAt)?.expiresAt || 0, packages, roleType: String(body.roleType || "") };
    },
    /** 无签到活动（上游没有这类接口） */
    async checkinStatus() {
      return { unavailable: true, message: "OrcaTerm 没有签到 / 领取活动" };
    },
    async checkin() {
      return { ok: false, unavailable: true, message: "OrcaTerm 没有签到 / 领取活动" };
    },
    async trial() {
      return { ok: false, message: "OrcaTerm 无加油包领取动作" };
    },
    /** 续期：OAuthRefreshToken 传旧 token 换新 */
    async refreshToken(account, secrets) {
      const old = String((secrets && secrets.token) || "").trim();
      if (!old) return { ok: false, terminal: true, message: "无登录态，请重新导入" };
      const r = await cgiAction({ ...secrets, token: old }, "OAuthRefreshToken", { accessToken: old });
      if (!r.ok) return { ok: false, terminal: !!r.authError, message: r.message };
      const body = r.response || {};
      const token = String(body.AccessToken || body.accessToken || body.Token || "").trim();
      if (!token) return { ok: false, terminal: true, message: "上游未返回新登录态，请重新导入" };
      const payload = jwtPayload(token);
      const expiresAt = payload && Number(payload.exp) ? Number(payload.exp) * 1000 : 0;
      return { ok: true, token, refreshToken: "", expiresAt };
    },
    /** 投影给插件的凭据：token + uin（插件建会话与对话都要 user.id） */
    readForwardCredentials(account, secrets) {
      const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
      return { token: String((secrets && secrets.token) || ""), uin: String(meta.uin || meta.userId || "") };
    },
    /** 读本机桌面端登录态（Tauri store，明文 JSON） */
    readDesktopState() {
      const file = path.join(process.env.APPDATA || "", "com.orcaterm-desktop.app", "data.bin");
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 256 * 1024) return null;
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const token = String(data.oauth_access_token || "").trim();
        if (!token) return null;
        const payload = jwtPayload(token) || {};
        const identity = data.auth_identity || {};
        return {
          token,
          uid: String(payload.userId || identity.userId || ""),
          name: String(identity.nickName || identity.nickname || ""),
          expiresAt: Number(data.oauth_expires_at) || (Number(payload.exp) ? Number(payload.exp) * 1000 : 0),
        };
      } catch { return null; }
    },
    jwtPayload,
  };
}

module.exports = { makeOrcaTerm, resolveModel, jwtPayload, STATIC_MODELS, CGI_BASE, LIGHTAI_BASE, ASSISTANT_QUERY, DEFAULT_MODEL, USER_AGENT };
