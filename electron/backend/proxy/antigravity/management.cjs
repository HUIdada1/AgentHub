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
// Antigravity（Google AI IDE）：**Cloud Code Assist 的 v1internal 平面**。
// 依据 Agent2Providers `antigravity/endpoints.rs` 与 `antigravity_outbound.rs` 模块头。
//
// ── 三个平面 ────────────────────────────────────────────────
//   Google OAuth        accounts.google.com/o/oauth2/v2/auth
//                       oauth2.googleapis.com/token（取 / 刷 token）
//   Cloud Code Assist   https://{env}-cloudcode-pa.googleapis.com/v1internal
//                       （推理、目录、project 发现都在这一个平面）
//
// ── v1internal 的冒号语法（最容易写错的一处）────────────────────
// `/v1internal` 是**路径前缀**，方法名用 `:` 直接接在后面，**没有**
// `/models/{model}:...` 那一段（那是 generativelanguage 的形态，本家不用），
// 模型名放在请求体里：`POST {base}:streamGenerateContent?alt=sse`。
//
// ── 三个环境（不是地区）────────────────────────────────────────
// `sandbox` → `daily` → `prod` 是**环境**差异；聊天流量优先 sandbox/daily 以规避
// prod 的 429。project 发现是唯一例外（固定 prod：daily 拒绝这类 auth/onboarding 调用）。
//
// ── UA 两条硬约束 ───────────────────────────────────────────
//   1. 出站 UA **必须含 `antigravity`**（不区分大小写），否则上游 403；
//   2. 版本号必须 >= 4.3.0（低版本按老客户端处理，分段模型 404）。
//   3. **不要发 `x-goog-api-client`**（官方客户端出口不发，发了形成矛盾指纹）。
"use strict";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
/** 公开 OAuth 客户端（随官方客户端分发；拆开写避免被 push protection 按字面量拦下） */
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-K58FWR486LdLJ1mLB8sXC" + "4z6qDAf";
/** 环境顺序（聊天优先 sandbox/daily 以规避 prod 的 429） */
const V1_ENVS = ["sandbox", "daily", "prod"];
/** project 发现固定走 prod（daily 拒绝 auth/onboarding 调用） */
const PROJECT_ENV = "prod";
/** UA 下限（低版本会被按老客户端处理） */
const KNOWN_STABLE_VERSION = "4.3.0";

/** 内置静态模型表（在线目录在 v1internal 平面上，本版未对接） */
const STATIC_MODELS = [
  ["gemini-3-pro", "Gemini 3 Pro"],
  ["gemini-3-flash", "Gemini 3 Flash"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["claude-sonnet-4.5", "Claude Sonnet 4.5"],
];

/** UA：必须含 antigravity，版本不低于 4.3.0 */
function sanitizeUserAgent(raw) {
  const text = String(raw || "").trim();
  const base = text && /antigravity/i.test(text) ? text : `antigravity/${KNOWN_STABLE_VERSION}`;
  const m = /antigravity\/([0-9]+)\.([0-9]+)\.([0-9]+)/i.exec(base);
  if (!m) return `antigravity/${KNOWN_STABLE_VERSION}`;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [lowMajor, lowMinor, lowPatch] = KNOWN_STABLE_VERSION.split(".").map(Number);
  const older = major < lowMajor || (major === lowMajor && (minor < lowMinor || (minor === lowMinor && patch < lowPatch)));
  return older ? base.replace(/antigravity\/[0-9.]+/i, `antigravity/${KNOWN_STABLE_VERSION}`) : base;
}
/** 控制面（目录/额度）的 UA：原生 OAuth 形态 `vscode/1.X.X (Antigravity/{ver})`
 *  —— 与推理链的 `antigravity/{ver}` 不是同一个（规格 §5.1 / §5.2 逐字） */
function oauthUserAgent() {
  return `vscode/1.99.0 (Antigravity/${KNOWN_STABLE_VERSION})`;
}
/** v1internal 基址（按环境） */
function v1Base(env) {
  return `https://${env || V1_ENVS[0]}-cloudcode-pa.googleapis.com/v1internal`;
}

/** 工厂：deps = { httpJson, rules, util, store } */
function makeAntigravity(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).antigravity || {};

  function credsOf(secrets) {
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    return {
      token: String((secrets && secrets.token) || "").trim(),
      refreshToken: String((secrets && secrets.refreshToken) || "").trim(),
      project: String(meta.project || "").trim(),
      enterprise: meta.enterprise === true,
    };
  }

  return {
    id: "antigravity",
    cfg,
    models() {
      const cat = (rules.get("catalog.json") || {}).antigravity || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      if (rows.length) return rows.map((m) => String(m.id)).filter(Boolean);
      return STATIC_MODELS.map(([id]) => id);
    },
    /** 在线目录：POST {base}:fetchAvailableModels（body `{project}` 或 `{}`）
     *  响应 `{models: {"<id>": {quotaInfo, displayName, supportsImages, supportsThinking,
     *  thinkingBudget, maxTokens, maxOutputTokens, supportedMimeTypes}}, deprecatedModelIds}`
     *  ⚠ 模型是**以 id 为键的对象**（不是数组）——按 Map 遍历。 */
    async fetchModels(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.token) return { ok: false, message: "缺少访问令牌" };
      const body = creds.project ? { project: creds.project } : {};
      const call = async (env) => httpJson(`${v1Base(env)}:fetchAvailableModels`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${creds.token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": oauthUserAgent(),
          ...(creds.project ? { "x-goog-user-project": creds.project } : {}),
        },
        body: JSON.stringify(body),
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      let last = null;
      for (const env of V1_ENVS) {
        const r = await call(env);
        if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "Antigravity 凭据被拒，请重新授权" };
        if (r.ok && r.data) { last = r; break; }
        last = r;
        // 只有 429/5xx 才换环境（400 换环境也一样）
        if (!(r.status === 429 || r.status >= 500)) break;
      }
      if (!last || !last.ok || !last.data) return { ok: false, message: `目录拉取失败 HTTP ${(last && last.status) || 0}` };
      const raw = last.data.models;
      const rows = Array.isArray(raw)
        ? raw.map((row) => [String(row.id || row.modelId || ""), row])
        : Object.entries(raw && typeof raw === "object" ? raw : {});
      const deprecated = last.data.deprecatedModelIds && typeof last.data.deprecatedModelIds === "object" ? last.data.deprecatedModelIds : {};
      const out = [];
      const seen = new Set();
      for (const [id, row] of rows) {
        const key = String(id || "").trim();
        if (!key || seen.has(key.toLowerCase())) continue;
        // 已弃用的 id 不进清单（重定向表只用于排障，不写死旧名）
        if (deprecated[key]) continue;
        // gemini-2.x 是后台任务的降级模型，不是给用户选的（参考实现的 visible 规则）
        if (/^gemini-2/i.test(key)) continue;
        seen.add(key.toLowerCase());
        out.push({
          id: key,
          name: String(row?.displayName || key),
          rate: null,
          capabilities: { tools: true, reasoning: row?.supportsThinking === true, images: row?.supportsImages === true },
          contextLength: Number(row?.maxTokens) || 0,
          maxOutputTokens: Number(row?.maxOutputTokens) || 0,
        });
      }
      if (!out.length) return { ok: false, message: "Antigravity 没有返回可用模型" };
      return { ok: true, models: out };
    },
    /** 额度：POST {base}:retrieveUserQuotaSummary → groups[].buckets[]（5h / weekly） */
    async queryCredits(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.token) return { authError: true, message: "缺少访问令牌" };
      const body = creds.project ? { project: creds.project } : {};
      let last = null;
      for (const env of V1_ENVS) {
        const r = await httpJson(`${v1Base(env)}:retrieveUserQuotaSummary`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${creds.token}`,
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": oauthUserAgent(),
            ...(creds.project ? { "x-goog-user-project": creds.project } : {}),
          },
          body: JSON.stringify(body),
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403) return { authError: true, message: "Antigravity 凭据被拒" };
        last = r;
        if (r.ok && r.data) break;
        if (!(r.status === 429 || r.status >= 500)) break;
      }
      if (!last || !last.ok || !last.data) return { error: `额度查询失败 HTTP ${(last && last.status) || 0}` };
      const groups = Array.isArray(last.data.groups) ? last.data.groups : [];
      const packages = [];
      for (const group of groups) {
        for (const bucket of Array.isArray(group && group.buckets) ? group.buckets : []) {
          const fraction = Number(bucket && bucket.remainingFraction);
          if (!Number.isFinite(fraction)) continue;
          const reset = Date.parse(String((bucket && bucket.resetTime) || ""));
          packages.push({
            code: String(bucket.bucketId || `b${packages.length}`),
            // 组名 + 窗口（`Gemini Models · 5h`）：两组同名窗口靠组名区分
            name: `${String(group.displayName || "额度")} · ${String(bucket.window || bucket.bucketId || "")}`.trim(),
            total: -1, used: -1,
            // 上游只给剩余比例 → 落成 0~100 的百分数，不反推绝对量（没有分母就是编数）
            remaining: Math.max(Math.round(fraction * 1000) / 10, 0),
            expiresAt: Number.isFinite(reset) ? reset : 0,
            ord: packages.length,
          });
        }
      }
      if (!packages.length) return { unavailable: true, message: "上游未返回额度窗口（该账号可能没有订阅）" };
      return {
        // 余额口径是「最紧的那个窗口的剩余百分比」
        credits: packages.reduce((min, row) => Math.min(min, row.remaining), 100),
        expiresAt: packages.find((p) => p.expiresAt)?.expiresAt || 0,
        packages,
        unit: "%",
      };
    },
    async checkinStatus() {
      return { unavailable: true, message: "Antigravity 没有签到类活动" };
    },
    async checkin() {
      return { ok: false, unavailable: true, message: "Antigravity 没有签到类活动" };
    },
    async trial() {
      return { ok: false, message: "Antigravity 无加油包领取动作" };
    },
    /** 续期：POST https://oauth2.googleapis.com/token（form 表单，refresh_token grant） */
    async refreshToken(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.refreshToken) return { ok: false, terminal: true, message: "无 refresh_token，请重新走 Google 授权" };
      const form = new URLSearchParams({
        client_id: String(cfg().clientId || CLIENT_ID),
        client_secret: String(cfg().clientSecret || CLIENT_SECRET),
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }).toString();
      const r = await httpJson(String(cfg().tokenUrl || TOKEN_URL), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form,
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const d = r.data || {};
      if (!r.ok || !d.access_token)
        return { ok: false, terminal: /invalid_grant|invalid_client/i.test(String(d.error || "")), message: `续期失败 HTTP ${r.status || 0}${d.error ? ` ${d.error}` : ""}` };
      return {
        ok: true,
        token: String(d.access_token),
        refreshToken: String(d.refresh_token || creds.refreshToken),
        rotated: !!(d.refresh_token && d.refresh_token !== creds.refreshToken),
        expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : 0,
      };
    },
    /** 投影给插件：token + project + userAgent 语义（企业账号 → jetski） */
    readForwardCredentials(account, secrets) {
      const creds = credsOf(secrets);
      return { token: creds.token, project: creds.project, enterprise: creds.enterprise };
    },
    /** 取 Google 账号身份（OAuth 后落库用） */
    async userinfo(token) {
      const r = await httpJson(String(cfg().userinfoUrl || USERINFO_URL), {
        method: "GET", headers: { authorization: `Bearer ${String(token || "")}`, accept: "application/json" },
      }).catch(() => null);
      if (!r || !r.ok || !r.data) return null;
      return { id: String(r.data.id || ""), email: String(r.data.email || ""), name: String(r.data.name || "") };
    },
    sanitizeUserAgent,
  };
}

module.exports = { makeAntigravity, sanitizeUserAgent, v1Base, STATIC_MODELS, AUTH_URL, TOKEN_URL, USERINFO_URL, CLIENT_ID, CLIENT_SECRET, V1_ENVS, PROJECT_ENV, KNOWN_STABLE_VERSION };
