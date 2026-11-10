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
// Kiro（kiro.dev / AWS AI IDE）：**会话 JSON + AWS event stream（二进制帧）**。
// 依据 Agent2Providers `kiro/`（endpoints.rs / eventstream.rs / events.rs / request.rs 模块头）。
//
// ── 地址 ────────────────────────────────────────────────────
//   门户        https://app.kiro.dev/signin
//   社交登录换码 https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token
//   刷新        https://prod.{region}.auth.desktop.kiro.dev/refreshToken
//   控制面      https://management.{region}.kiro.dev
//   推理        https://runtime.{region}.kiro.dev/generateAssistantResponse
//
// ── 地区 ────────────────────────────────────────────────────
// 只有 `us-east-1` 与 `eu-central-1` 两个订阅地区。两边共用同一套账号体系与令牌，
// 只是端点不同，所以**不拆渠道**（与「两地两个 provider」的家不同）。
//
// ── 本版边界（如实声明）──────────────────────────────────────
//   有：对话（AWS event stream → chat 帧）、令牌续期（社交登录 refreshToken）
//   无：**在线目录/用量**（控制面要 AWS SigV4 签名，本版未移植）→ 模型清单用
//       内置静态表；余额与签到如实回报 unavailable。
"use strict";

const AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
const PORTAL = "https://app.kiro.dev";
/** Builder ID 的 profile（Builder ID 没有自己的 profile，官方 IDE 与 kiro-cli 都用这一个） */
const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const REGIONS = ["us-east-1", "eu-central-1"];

/** 内置静态模型表（控制面目录要 SigV4，本版未移植；这张表按官方 IDE 的模型下拉抄录）。
 *  `auto` 是 Kiro 自己的路由模型，目录拿不到时至少要有它（参考实现 fallback 只有 auto）。 */
const STATIC_MODELS = [
  ["auto", "Auto"],
  ["claude-sonnet-4.5", "Claude Sonnet 4.5"],
  ["claude-haiku-4.5", "Claude Haiku 4.5"],
  ["claude-opus-4.1", "Claude Opus 4.1"],
  ["deepseek-v3.2", "DeepSeek V3.2"],
  ["glm-5", "GLM-5"],
  ["kimi-k2.5", "Kimi K2.5"],
  ["minimax-m2.5", "MiniMax M2.5"],
  ["qwen3-coder", "Qwen3-Coder"],
];

/** 镜像 UA：`KiroIDE-<version>-<hash>`（hash 由主机名派生，与参考实现同形态） */
function ideUserAgent(hostname) {
  const crypto = require("node:crypto");
  const hex = crypto.createHash("sha256").update(`agenthub:${String(hostname || "")}`).digest("hex");
  return `KiroIDE-1.1.70-${hex}`;
}

/** 从 profile ARN 取地区（`arn:aws:codewhisperer:<region>:…`） */
function regionOfProfile(arn) {
  const m = /^arn:aws:codewhisperer:([a-z0-9-]+):/.exec(String(arn || ""));
  return m && REGIONS.includes(m[1]) ? m[1] : "";
}

/** 工厂：deps = { httpJson, rules, util, store } */
function makeKiro(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).kiro || {};
  const authService = () => String(cfg().authService || AUTH_SERVICE).replace(/\/+$/, "");

  function credsOf(secrets) {
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    return {
      token: String((secrets && secrets.token) || "").trim(),
      refreshToken: String((secrets && secrets.refreshToken) || "").trim(),
      profileArn: String(meta.profileArn || "").trim(),
      region: String(meta.region || "").trim(),
      tokenType: String(meta.tokenType || "").trim(),
      // Builder ID / IAM Identity Center（method=idc）续期要用注册时那对 client 凭据
      method: String(meta.method || "social"),
      clientId: String(meta.clientId || "").trim(),
      clientSecret: String(meta.clientSecret || "").trim(),
    };
  }

  return {
    id: "kiro",
    cfg,
    models() {
      const cat = (rules.get("catalog.json") || {}).kiro || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      if (rows.length) return rows.map((m) => String(m.id)).filter(Boolean);
      return STATIC_MODELS.map(([id]) => id);
    },
    /** 在线目录：GET {management}/List-Available-Models?origin=KIRO_CLI[&profileArn=…]
     *  ⚠ 这里**不需要** AWS SigV4 —— 只是 `Authorization: Bearer <access>` 加一个
     *  `tokentype` 头（Agent2Providers kiro/models.rs `management_models` 逐字如此）。
     *  之前把它误记成 SigV4，本轮已纠正。 */
    async fetchModels(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.token) return { ok: false, message: "缺少访问令牌" };
      const region = creds.region || regionOfProfile(creds.profileArn) || "us-east-1";
      const url = `https://management.${region}.kiro.dev/List-Available-Models?origin=KIRO_CLI` +
        (creds.profileArn ? `&profileArn=${encodeURIComponent(creds.profileArn)}` : "");
      const headers = { accept: "application/json", authorization: `Bearer ${creds.token}` };
      if (creds.tokenType) headers.tokentype = creds.tokenType;
      const r = await httpJson(url, { method: "GET", headers })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "Kiro 凭据被拒，请重新登录" };
      if (!r.ok || !r.data) return { ok: false, message: `目录拉取失败 HTTP ${r.status || 0}` };
      const rows = Array.isArray(r.data.models) ? r.data.models : [];
      const defaultId = String(r.data?.defaultModel?.modelId || "");
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const id = row && typeof row.modelId === "string" ? row.modelId.trim() : "";
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        const types = Array.isArray(row.supportedInputTypes) ? row.supportedInputTypes : [];
        out.push({
          id,
          name: String(row.modelName || (id === "auto" ? "Auto" : id)),
          rate: null,
          capabilities: { tools: true, reasoning: /claude|think|^auto$/i.test(id), images: types.some((t) => String(t).toUpperCase() === "IMAGE") },
          contextLength: Number(row?.tokenLimits?.maxInputTokens) || 0,
          maxOutputTokens: Number(row?.tokenLimits?.maxOutputTokens) || 0,
          isDefault: !!defaultId && id === defaultId,
        });
      }
      if (!out.length) return { ok: false, message: "Kiro 没有返回任何模型" };
      // 默认模型排第一（与参考实现一致）
      out.sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1));
      return { ok: true, models: out };
    },
    /** 额度：GET {management}/Get-Usage-Limits?origin=KIRO_CLI&resourceType=CREDIT&isEmailRequired=true */
    async queryCredits(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.token) return { authError: true, message: "缺少访问令牌" };
      const region = creds.region || regionOfProfile(creds.profileArn) || "us-east-1";
      const url = `https://management.${region}.kiro.dev/Get-Usage-Limits?origin=KIRO_CLI&resourceType=CREDIT&isEmailRequired=true` +
        (creds.profileArn ? `&profileArn=${encodeURIComponent(creds.profileArn)}` : "");
      const headers = { accept: "application/json", authorization: `Bearer ${creds.token}` };
      if (creds.tokenType) headers.tokentype = creds.tokenType;
      const r = await httpJson(url, { method: "GET", headers })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { authError: true, message: "Kiro 凭据被拒" };
      if (!r.ok || !r.data) return { error: `额度查询失败 HTTP ${r.status || 0}` };
      const d = r.data;
      const now = Date.now();
      const packages = [];
      let remaining = 0;
      const secondsToMs = (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
        const t = Date.parse(String(v || ""));
        return Number.isFinite(t) ? t : 0;
      };
      for (const breakdown of Array.isArray(d.usageBreakdownList) ? d.usageBreakdownList : []) {
        const trial = breakdown && breakdown.freeTrialInfo;
        if (trial && String(trial.freeTrialStatus || "").toUpperCase() === "ACTIVE") {
          const limit = Number(trial.usageLimitWithPrecision) || 0;
          const used = Number(trial.currentUsageWithPrecision) || 0;
          if (limit > 0) {
            const left = Math.max(limit - used, 0);
            remaining += left;
            packages.push({ code: `trial${packages.length}`, name: "Free trial", total: limit, used, remaining: left, expiresAt: secondsToMs(trial.freeTrialExpiry), ord: packages.length });
          }
        }
        for (const bonus of Array.isArray(breakdown && breakdown.bonuses) ? breakdown.bonuses : []) {
          if (String(bonus && bonus.status || "").toUpperCase() !== "ACTIVE") continue;
          const limit = Number(bonus.usageLimit) || 0;
          if (limit <= 0) continue;
          const expiresAt = secondsToMs(bonus.expiresAt);
          if (expiresAt && expiresAt <= now) continue;
          const used = Number(bonus.currentUsage) || 0;
          const left = Math.max(limit - used, 0);
          remaining += left;
          packages.push({ code: `bonus${packages.length}`, name: String(bonus.displayName || "Bonus credits"), total: limit, used, remaining: left, expiresAt, ord: packages.length });
        }
        // 主额度（月度积分）——参考实现 usage.rs 在 trial / bonus 之后同样把这一档
        // 落成窗口；漏掉它会出现「账号明明有月度额度，界面却只显示 Free trial」。
        const planLimit = Number(breakdown && breakdown.usageLimitWithPrecision) || 0;
        if (planLimit > 0) {
          const planUsed = Number(breakdown && breakdown.currentUsageWithPrecision) || 0;
          const reset = secondsToMs(breakdown && breakdown.nextDateReset) || secondsToMs(d && d.nextDateReset);
          const left = Math.max(planLimit - planUsed, 0);
          remaining += left;
          const name = String((breakdown && (breakdown.displayNamePlural || breakdown.displayName)) || "Credits");
          packages.push({ code: `plan${packages.length}`, name, total: planLimit, used: planUsed, remaining: left, expiresAt: reset, ord: packages.length });
        }
      }
      if (!packages.length) return { unavailable: true, message: "上游未返回可用的额度条目（该账号可能没有订阅或额度已过期）" };
      return { credits: remaining, expiresAt: packages.find((p) => p.expiresAt)?.expiresAt || 0, packages, planName: String(d?.subscriptionInfo?.subscriptionTitle || d?.subscriptionInfo?.type || "") };
    },
    async checkinStatus() {
      return { unavailable: true, message: "Kiro 没有签到类活动" };
    },
    async checkin() {
      return { ok: false, unavailable: true, message: "Kiro 没有签到类活动" };
    },
    async trial() {
      return { ok: false, message: "Kiro 无加油包领取动作" };
    },
    /** 续期：POST {authService}/refreshToken（社交登录刷新；轮换，缺省保留旧值） */
    async refreshToken(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.refreshToken) return { ok: false, terminal: true, message: "无 refreshToken，请重新登录" };
      const region = creds.region || regionOfProfile(creds.profileArn) || "us-east-1";
      // IDC / Builder ID：走 AWS OIDC 的 refresh_token grant（与社交登录不是同一个端点）
      if (creds.method === "idc" && creds.clientId) {
        const r = await httpJson(`https://oidc.${region}.amazonaws.com/token`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            clientId: creds.clientId, clientSecret: creds.clientSecret,
            grantType: "refresh_token", refreshToken: creds.refreshToken,
          }),
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const d = (r.data && (r.data.data || r.data)) || {};
        if (!r.ok || !d.accessToken)
          return { ok: false, terminal: /invalid|expired|revoked/i.test(String(d.error || d.message || r.message || "")), message: `AWS OIDC 续期失败 HTTP ${r.status || 0}` };
        return {
          ok: true,
          token: String(d.accessToken),
          refreshToken: String(d.refreshToken || creds.refreshToken),
          rotated: !!(d.refreshToken && d.refreshToken !== creds.refreshToken),
          expiresAt: d.expiresIn ? Date.now() + Number(d.expiresIn) * 1000 : 0,
        };
      }
      const url = `${authService().replace("prod.us-east-1", `prod.${region}`)}/refreshToken`;
      const r = await httpJson(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": ideUserAgent(require("node:os").hostname()) },
        body: JSON.stringify({ refreshToken: creds.refreshToken }),
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const d = (r.data && (r.data.data || r.data)) || {};
      if (!r.ok || !d.accessToken)
        return { ok: false, terminal: /invalid|expired/i.test(String(d.message || d.error || r.message || "")), message: `续期失败 HTTP ${r.status || 0}` };
      return {
        ok: true,
        token: String(d.accessToken),
        refreshToken: String(d.refreshToken || creds.refreshToken),
        rotated: !!(d.refreshToken && d.refreshToken !== creds.refreshToken),
        expiresAt: d.expiresIn ? Date.now() + Number(d.expiresIn) * 1000 : 0,
      };
    },
    /** 投影给插件：token + profileArn + region（推理端点按 region 选） */
    readForwardCredentials(account, secrets) {
      const creds = credsOf(secrets);
      const region = creds.region || regionOfProfile(creds.profileArn) || "us-east-1";
      return { token: creds.token, profileArn: creds.profileArn || BUILDER_ID_PROFILE, region };
    },
    regionOfProfile,
    ideUserAgent,
  };
}

module.exports = { makeKiro, regionOfProfile, ideUserAgent, STATIC_MODELS, PORTAL, AUTH_SERVICE, BUILDER_ID_PROFILE, REGIONS };
