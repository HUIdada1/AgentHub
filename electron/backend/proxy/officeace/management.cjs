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
// OfficeAce（华为云果办 / OfficeClaw）：**无状态 OpenAI 兼容 + 两层凭证**。
// 依据 Agent2Providers `crates/providers/src/providers/officeace/`（mod.rs / credentials.rs /
// chat.rs / subscription.rs / checkin.rs / models.rs 模块头）。
//
// ── 两层凭证（别混）────────────────────────────────────────────
//   网关凭据    modelAppKey : modelAppSecret（Basic 头，**不过期**）—— 转发只用它
//   控制面凭据  AK/SK + securityToken + projectId（实测 2 小时）—— 只用于额度/签到
// 因此「导入过一次」就有稳定可用的转发账号；控制面过期只影响额度与签到。
//
// ── 三条上游特性（每条都有实测依据）──────────────────────────────
//   1. 上游**恒流式**（插件侧强制 stream:true + stream_options.include_usage）；
//   2. `max_tokens` 是「推理 + 正文」的总预算，给小了会 HTTP 200 但正文空串
//      → 插件侧**追加** 1024（<16 原样透传）；
//   3. 体积超限给 **HTTP 429 + 81113** → 必须先于限流判定挡掉（折成 413）。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const signer = require("./signer.cjs");

/** 模型网关基址的规范形态：`https://<host>/v2`（chat.rs normalize_base） */
function normalizeBase(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v2") ? trimmed : `${trimmed}/v2`;
}
/** 账号里存的 `https://{host}/v2` → 网关根 `https://{host}` */
function gatewayBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v2$/, "").replace(/\/+$/, "");
}
/** `<key>:<secret>` → Basic 头值 */
function basicAuthorization(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
}

/** 工厂：deps = { httpJson, rules, util, store } */
function makeOfficeAce(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).officeace || {};
  const region = () => String(cfg().region || signer.DEFAULT_REGION);

  /** 账号里解出两层凭据（meta 由 store.accountSecrets 解密后透传） */
  function credsOf(secrets) {
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    return {
      baseUrl: String(meta.baseUrl || cfg().baseUrl || ""),
      modelAppKey: String(meta.modelAppKey || ""),
      modelAppSecret: String(meta.modelAppSecret || ""),
      accessKeyId: String(meta.accessKeyId || ""),
      secretAccessKey: String(meta.secretAccessKey || ""),
      securityToken: String(meta.securityToken || ""),
      projectId: String(meta.projectId || ""),
      expiresAt: Number(meta.controlExpiresAt) || 0,
    };
  }

  /** V11 签名的控制面调用（GET 无体 / POST 带 `{}`） */
  async function controlCall(creds, method, apiPath, body) {
    if (!creds.accessKeyId || !creds.secretAccessKey)
      return { ok: false, noControl: true, message: "该账号只导入了网关凭据（无控制面 AK/SK），额度与签到不可用" };
    const url = `${gatewayBase(creds.baseUrl)}${apiPath}`;
    const payload = body == null ? null : JSON.stringify(body);
    const headers = [
      ["Accept", "application/json"],
      ["Content-Type", "application/json"],
      ["x-subscription-type", "v2"], // usage / rates 不带；订阅族与 bonus/claim 必要
    ];
    const signed = signer.sign({
      method, url, headers, body: payload,
      credential: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, securityToken: creds.securityToken, projectId: creds.projectId },
      region: region(),
    });
    const r = await httpJson(url, { method, headers: Object.fromEntries(signed), body: payload || undefined })
      .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403)
      return { ok: false, authError: true, message: "控制面凭据已过期（实测 2 小时），请重新导入" };
    if (!r.ok || !r.data)
      return { ok: false, message: `控制面请求失败 HTTP ${r.status || 0}${r.message ? " " + r.message : ""}` };
    return { ok: true, data: r.data };
  }

  return {
    id: "officeace",
    cfg,
    models() {
      const cat = (rules.get("catalog.json") || {}).officeace || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      return rows.map((m) => String(m.id)).filter(Boolean);
    },
    /** 目录：GET {规范化网关基址}/models（即 `https://<host>/v2/models`，OpenAI 格式，Basic 头；
     *  目录不需要控制面签名）。**不是** `/v1/models`——参考实现 models.rs 的
     *  `format!("{}/models", normalize_base(base_url))` 逐字如此。 */
    async fetchModels(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.baseUrl || !creds.modelAppKey || !creds.modelAppSecret)
        return { ok: false, message: "缺少网关凭据（baseUrl / modelAppKey / modelAppSecret）" };
      const r = await httpJson(`${normalizeBase(creds.baseUrl)}/models`, {
        method: "GET",
        headers: { Authorization: basicAuthorization(creds.modelAppKey, creds.modelAppSecret), Accept: "application/json" },
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "网关凭据无效（Basic 被拒）" };
      if (!r.ok || !r.data) return { ok: false, message: `目录拉取失败 HTTP ${r.status || 0}` };
      const rows = Array.isArray(r.data.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const id = row && typeof row.id === "string" ? row.id.trim() : "";
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        // 目录不给输出上限（officeace2api 的 /v1/models 也没这个字段）→ 记 0，不编造
        out.push({ id, name: String(row.name || id), rate: null, capabilities: { tools: true, reasoning: true, images: false }, contextLength: 0, maxOutputTokens: 0 });
      }
      if (!out.length) return { ok: false, message: "目录为空" };
      return { ok: true, models: out };
    },
    /** 余额：GET /v1/subscription（V11 签名）→ 套餐积分 + 奖励积分 */
    async queryCredits(account, secrets) {
      const creds = credsOf(secrets);
      const r = await controlCall(creds, "GET", "/v1/subscription", null);
      if (r.noControl) return { unavailable: true, message: r.message };
      if (r.authError) return { authError: true, message: r.message };
      if (!r.ok) return { error: r.message };
      const d = (r.data && r.data.data) || r.data || {};
      const now = Date.now();
      let planTotal = 0, planUsed = 0, bonusTotal = 0, bonusUsed = 0, planExpire = 0;
      const packages = [];
      const parseMs = (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        const t = Date.parse(String(v || ""));
        return Number.isFinite(t) ? t : 0;
      };
      for (const sku of Array.isArray(d.skus) ? d.skus : []) {
        for (const quota of Array.isArray(sku && sku.quotas) ? sku.quotas : []) {
          const expired = parseMs(quota && quota.expired_time);
          if (expired > 0 && expired <= now) continue;
          const code = String((quota && quota.sku_attr_code) || "");
          const total = Number(quota && quota.sku_value) || 0;
          const used = Number(quota && quota.current_value) || 0;
          if (code === "officeace_points") {
            planTotal += total; planUsed += used;
            packages.push({
              code: `sku${packages.length}`, name: String((sku && sku.sku_name) || "套餐积分"),
              total, used, remaining: Math.max(Math.floor(total - used), 0), expiresAt: expired, ord: packages.length,
            });
          }
        }
        const expire = parseMs(sku && sku.expired_time);
        if (expire > 0 && (planExpire === 0 || expire < planExpire)) planExpire = expire;
      }
      // 奖励活动（bonus）：全部条目出明细，聚合只算未过期的
      for (const bonus of Array.isArray(d.bonuses) ? d.bonuses : (Array.isArray(d.bonus) ? d.bonus : [])) {
        const expiresAt = parseMs(bonus && (bonus.expired_time || bonus.expire_time));
        const total = Number(bonus && (bonus.total || bonus.sku_value)) || 0;
        const used = Number(bonus && (bonus.used || bonus.current_value)) || 0;
        if (!expiresAt || expiresAt > now) { bonusTotal += total; bonusUsed += used; }
        packages.push({
          code: `bonus${packages.length}`, name: String((bonus && (bonus.name || bonus.activity_name)) || "奖励积分"),
          total, used, remaining: Math.max(Math.floor(total - used), 0), expiresAt, ord: packages.length,
        });
      }
      const available = Math.max(Math.floor(planTotal - planUsed), 0) + Math.max(Math.floor(bonusTotal - bonusUsed), 0);
      return { credits: available, expiresAt: planExpire, packages, detail: { planTotal, planUsed, bonusTotal, bonusUsed } };
    },
    /** 签到状态：只读订阅快照，报告「今天有没有可领的奖励」 */
    async checkinStatus(account, secrets) {
      const creds = credsOf(secrets);
      const r = await controlCall(creds, "GET", "/v1/subscription", null);
      if (r.noControl) return { unavailable: true, message: r.message };
      if (r.authError) return { unavailable: true, message: r.message };
      if (!r.ok) return { unavailable: true, message: r.message };
      const d = (r.data && r.data.data) || r.data || {};
      const bonuses = Array.isArray(d.bonuses) ? d.bonuses : (Array.isArray(d.bonus) ? d.bonus : []);
      // 上游「一天一个活动只能领一次、重复领不报错」→ 状态只能靠 current_value < sku_value 判
      const claimable = bonuses.filter((b) => {
        const total = Number(b && (b.total || b.sku_value)) || 0;
        const used = Number(b && (b.used || b.current_value)) || 0;
        return total > used;
      }).length;
      if (claimable > 0) return { ok: true, claimable, message: `有 ${claimable} 个奖励可领取` };
      return { ok: true, already: true, message: "今天没有可领的奖励（或已领过）" };
    },
    /** 签到：POST /v1/subscription/bonus/claim（body 必须给 `{}`，裸 POST 会 500） */
    async checkin(account, secrets) {
      const creds = credsOf(secrets);
      const before = await controlCall(creds, "GET", "/v1/subscription", null);
      const r = await controlCall(creds, "POST", "/v1/subscription/bonus/claim", {});
      if (r.noControl) return { ok: false, unavailable: true, message: r.message };
      if (r.authError) return { ok: false, message: r.message };
      if (!r.ok) return { ok: false, message: r.message };
      // 增量算得出才报数字；算不出就如实说「已签到」，不编一个数
      let gained = 0;
      if (before.ok) {
        const sum = (payload) => {
          const d = (payload && payload.data) || payload || {};
          let total = 0;
          for (const sku of Array.isArray(d.skus) ? d.skus : []) for (const q of Array.isArray(sku && sku.quotas) ? sku.quotas : []) {
            if (String(q && q.sku_attr_code) === "officeace_points") total += (Number(q.sku_value) || 0) - (Number(q.current_value) || 0);
          }
          return total;
        };
        gained = Math.max(Math.floor(sum(r.data) - sum(before.data)), 0);
      }
      return {
        ok: true,
        claimed: true,
        gained,
        message: gained > 0 ? `已领取 ${gained} 积分` : "已签到（今天没有可领的奖励或已领过）",
      };
    },
    /** 投影给插件的凭据：网关 Basic（token）+ 网关基址（baseUrl）。
     *  控制面 AK/SK **不投影**——插件只负责转发，不签控制面。 */
    readForwardCredentials(account, secrets) {
      const creds = credsOf(secrets);
      return { token: String((secrets && secrets.token) || ""), baseUrl: creds.baseUrl };
    },
    async trial() {
      return { ok: false, message: "OfficeAce 的奖励与新手任务由签到一次全领，无独立的加油包入口" };
    },
    /** 续期：网关 Basic 不过期；控制面临时凭据用**登录那把 DPoP 私钥**换新的（一次性轮换）。
     *  没有 dpopKeyPair 的存量账号（粘贴导入）只能重新走一次网页登录。 */
    async refreshToken(account, secrets) {
      const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
      const refreshToken = String((secrets && secrets.refreshToken) || "").trim();
      if (!meta.dpopKeyPair || !refreshToken)
        return { ok: false, noRefresh: true, terminal: false, message: "该账号没有 OAuth 续期上下文（DPoP 密钥 / refresh token），请用网页登录重新授权一次" };
      let next;
      try {
        next = await require("./oauth.cjs").refreshCredential({ dpopKeyPair: meta.dpopKeyPair, refreshToken });
      } catch (e) {
        const message = String((e && e.message) || e);
        // 一次性 refresh token 被消费 / 被拒 → 只能重新登录
        return { ok: false, terminal: /refresh token|重新登录|404|400/i.test(message), message: `控制面续期失败：${message}` };
      }
      return {
        ok: true,
        token: String((secrets && secrets.token) || ""),
        refreshToken: next.refreshToken,
        rotated: next.refreshToken !== refreshToken,
        expiresAt: 0,
        meta: {
          ...meta,
          accessKeyId: next.accessKeyId,
          secretAccessKey: next.secretAccessKey,
          securityToken: next.securityToken,
          projectId: next.projectId || meta.projectId || "",
          controlExpiresAt: next.expiresAt,
        },
        message: "控制面凭据已续期",
      };
    },
  };
}

module.exports = { makeOfficeAce, normalizeBase, gatewayBase, basicAuthorization };
