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
// AtomCode（AtomGit / GitCode）：**OpenAI 兼容 + 三平面三域**。
// 依据 Agent2Providers `crates/providers/src/providers/atomcode/`（endpoints.rs / models.rs /
// checkin.rs / usage.rs / oauth.rs 模块头）。
//
// ── 三条平面 ────────────────────────────────────────────────
//   登录代理（OAuth）  https://acs.atomgit.com                回调在代理域名终结，不回本机
//   CodingPlan REST    https://api.gitcode.com/api/v5         目录 / 套餐 / 领取 / 用量
//   聊天网关           https://api-ai.gitcode.com/v1          OpenAI Chat Completions
//
// ── 三条必须写下来的实测事实（每条都能让整条链路静默失效）────────────
//   1. 聊天网关**刻意不是**官方默认的 `llm-api.atomgit.com`（那个要闭源签名，
//      缺签名回 403 ATOMCODE_SIG_MISSING）。我们走 `api-ai.gitcode.com`——
//      官方 CLI 自己把它认成 first-party 网关，同一个 bearer、同一批模型、免签名。
//   2. 网关**按 User-Agent 决定要不要签名**：自称 `atomcode/<ver>` 立刻 403。
//      故 UA 是**功能性常量**（本仓库自称 `agenthub-atomcode/<ver>`）。
//   3. `models-v2` 每条自带的 `base_url` 指向需要签名的官方网关 —— 只作展示，
//      **不要**拿它替换网关基址。
//
// ── 额度口径与别家都不同 ─────────────────────────────────────
// 不是积分也不是 token，而是**每窗口可调用多少次**（免费档实测 200 次 / 5 小时）。
// 读 `status-v2` 的 `rate_limit_windows[]`，且只展示 `show_enable == 1` 的窗口。
"use strict";
const path = require("node:path");
const fs = require("node:fs");

/** 三条平面的默认基址（endpoints.rs） */
const DEFAULT_BROKER_BASE = "https://acs.atomgit.com";
const DEFAULT_CODINGPLAN_BASE = "https://api.gitcode.com/api/v5";
const DEFAULT_GATEWAY_BASE = "https://api-ai.gitcode.com/v1";
/** 功能性常量：绝不能自称 atomcode/<ver>（那是触发签名门的开关） */
const ADAPTER_USER_AGENT = "agenthub-atomcode/0.1.0";
/** 登录代理的 provider 参数 */
const BROKER_PROVIDER = "atomgit";
/** 档位级联顺序（官方 CASCADE_ORDER：Max → Pro → Lite） */
const CASCADE_ORDER = ["Max", "Pro", "Lite"];

/** 由套餐名推断档位（从最具体到最不具体：max → pro → lite） */
function planTierFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("lite")) return "Lite";
  return "";
}
/** 从 status-v2 取档位 */
function planTierFromStatus(payload) {
  const free = (payload && payload.codingplan_free) || {};
  return planTierFromName(free.plan_name || (payload && payload.plan_type) || "");
}

/**
 * 判定一次 claim-v2 的响应。**顺序是契约**：先看 duplicate（成功语义），再看 success。
 * 反过来写的话，所有「两者皆 false 之外」的组合都会走错分支。
 */
function classifyTierResponse(payload) {
  const message = String((payload && (payload.message || payload.msg)) || "").trim();
  const planName = String((payload && (payload.plan_name || (payload.plan && payload.plan.plan_name))) || "").trim();
  if (payload && payload.duplicate === true) return { kind: "already", message, planName };
  if (payload && payload.success === true) return { kind: "granted", message, planName };
  return { kind: "refused", message };
}

/** 工厂：deps = { httpJson, rules, util, store } */
function makeAtomCode(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).atomcode || {};
  const brokerBase = () => String(cfg().brokerBase || DEFAULT_BROKER_BASE).replace(/\/+$/, "");
  const planBase = () => String(cfg().codingPlanBase || DEFAULT_CODINGPLAN_BASE).replace(/\/+$/, "");
  const ua = () => String(cfg().userAgent || ADAPTER_USER_AGENT);
  const authHeaders = (token) => ({ authorization: `Bearer ${String(token || "")}`, accept: "application/json", "user-agent": ua() });

  return {
    id: "atomcode",
    cfg,
    models() {
      const cat = (rules.get("catalog.json") || {}).atomcode || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      // 不内置兜底清单：名义目录 ≠ 可达目录（实测同账号上 deepseek-flash 不在名单却能调，
      // 名单里有的反而回「参数错误」/一页 HTML）→ 拉不到就如实为空。
      return rows.map((m) => String(m.id)).filter(Boolean);
    },
    /** 目录：先读 status-v2 定档位，再 GET models-v2?plan_type=<档位> */
    async fetchModels(account, secrets) {
      const token = String((secrets && secrets.token) || "").trim();
      if (!token) return { ok: false, message: "缺少访问令牌" };
      const status = await httpJson(`${planBase()}/coding-plan/status-v2`, { method: "GET", headers: authHeaders(token) })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (status.status === 401 || status.status === 403) return { ok: false, authError: true, message: "访问令牌失效，请重新登录" };
      const tier = planTierFromStatus(status.data) || "";
      // 有档位时**只问该档位**：`plan_available` 是相对被问档位算的，换档问会把
      // 本来可用的模型过滤掉（参考实现 models.rs 的 candidates 逐字如此）。
      // 拿不到档位才按 Lite → Pro → Max 逐个试。
      const candidates = tier ? [tier] : ["Lite", "Pro", "Max"];
      let last = "";
      for (const candidate of candidates) {
        const r = await httpJson(`${planBase()}/coding-plan/models-v2?plan_type=${encodeURIComponent(candidate)}`, { method: "GET", headers: authHeaders(token) })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (!r.ok || !r.data) { last = `HTTP ${r.status || 0}`; continue; }
        const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r.data.models) ? r.data.models : (Array.isArray(r.data.data) ? r.data.data : []));
        const out = [];
        const seen = new Set();
        for (const row of rows) {
          if (!row || row.plan_available === false) continue;
          // ⚠ 网关认的是 display_model_name（形如 glm5.3-flash）；`id` 是数字内部 id，
          // 拿它发请求不会报错，只会回 HTTP 200 + 正文「参数错误」
          const id = String(row.display_model_name || row.displayModelName || "").trim();
          if (!id || seen.has(id.toLowerCase())) continue;
          seen.add(id.toLowerCase());
          out.push({
            id,
            name: String(row.display_name || row.name || id),
            rate: null,
            capabilities: { tools: true, reasoning: true, images: false },
            contextLength: Number(row.context_window || row.context_length) || 0,
            maxOutputTokens: 0,
            planTier: candidate,
          });
        }
        if (out.length) return { ok: true, models: out, planTier: candidate };
        last = "目录为空";
      }
      return { ok: false, message: `模型目录拉取失败：${last || "未知原因"}` };
    },
    /** 额度：status-v2 的滚动调用次数窗口（只展示 show_enable==1 的窗口） */
    async queryCredits(account, secrets) {
      const token = String((secrets && secrets.token) || "").trim();
      const r = await httpJson(`${planBase()}/coding-plan/status-v2`, { method: "GET", headers: authHeaders(token) })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { authError: true, message: "访问令牌失效" };
      if (!r.ok || !r.data) return { error: `额度查询失败 HTTP ${r.status || 0}` };
      const d = r.data;
      const free = (d && d.codingplan_free) || {};
      const windows = (Array.isArray(d && d.rate_limit_windows) ? d.rate_limit_windows : [])
        .filter((w) => w && Number(w.show_enable) === 1);
      if (!windows.length) return { unavailable: true, message: "上游未返回可展示的额度窗口（该账号可能没有有效套餐）" };
      const packages = windows.map((w, i) => {
        const limit = Number(w.call_limit ?? w.limit) || 0;
        const used = Number(w.used ?? w.call_used) || 0;
        return {
          code: `w${i}`, name: `${Number(w.hours) || 0} 小时窗口`,
          total: limit, used, remaining: Math.max(limit - used, 0),
          expiresAt: 0, ord: i,
        };
      });
      // 主读数取「最紧的那个窗口」的剩余次数（多窗口并存时用户最关心先耗尽的那个）
      const primary = packages.reduce((min, row) => (row.remaining < min.remaining ? row : min), packages[0]);
      return {
        credits: primary.remaining,
        expiresAt: 0,
        packages,
        planName: String(free.plan_name || ""),
        planExpiresAt: Number(free.expires_at) || 0,
        detail: { windows },
      };
    },
    /** 签到状态：只读 status-v2，判断「有没有有效套餐」 */
    async checkinStatus(account, secrets) {
      const token = String((secrets && secrets.token) || "").trim();
      const r = await httpJson(`${planBase()}/coding-plan/status-v2`, { method: "GET", headers: authHeaders(token) })
        .catch(() => ({ ok: false, status: 0, data: null }));
      if (r.status === 401 || r.status === 403) return { unavailable: true, message: "访问令牌失效" };
      if (!r.ok || !r.data) return { unavailable: true, message: `套餐状态查询失败 HTTP ${r.status || 0}` };
      const free = (r.data && r.data.codingplan_free) || {};
      const name = String(free.plan_name || "");
      const expiresAt = Number(free.expires_at) || 0;
      if (name && (!expiresAt || expiresAt > Date.now())) return { ok: true, already: true, message: `已持有套餐：${name}` };
      return { ok: true, claimable: CASCADE_ORDER.length, message: "没有有效套餐，可领取免费 CodingPlan（Max → Pro → Lite）" };
    },
    /**
     * 签到 = **领取免费 CodingPlan**（不是每日打卡）。
     * 顺序 Max → Pro → Lite，**命中即停**：
     *   duplicate（已持有）→ 停（继续往下会重复报或把用户降级）
     *   success（本次发放）→ 停
     *   两者皆 false（被拒）→ 记文案，试下一档
     *   传输/5xx/解析失败 → 整条级联中止（换档位修不好连接）
     */
    async checkin(account, secrets) {
      const token = String((secrets && secrets.token) || "").trim();
      if (!token) return { ok: false, message: "缺少访问令牌" };
      let lastMessage = "";
      for (const tier of CASCADE_ORDER) {
        const r = await httpJson(`${planBase()}/coding-plan/claim-v2`, {
          method: "POST", headers: { ...authHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ plan_type: tier }),
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (!r.ok || !r.data) {
          // 传输/5xx/解析失败 → 中止级联
          if (!r.status || r.status >= 500) return { ok: false, message: `领取请求失败（${r.status || "网络"}）：${r.message || ""}`.trim() };
          lastMessage = `HTTP ${r.status}`;
          continue;
        }
        const verdict = classifyTierResponse(r.data);
        if (verdict.kind === "already") return { ok: true, already: true, message: verdict.message || `已持有 ${tier} 套餐${verdict.planName ? `（${verdict.planName}）` : ""}` };
        if (verdict.kind === "granted") return { ok: true, claimed: true, message: verdict.message || `已领取 ${tier} 套餐${verdict.planName ? `（${verdict.planName}）` : ""}` };
        lastMessage = verdict.message || `${tier} 被拒`;
      }
      return { ok: false, message: lastMessage || "三档均未领取成功" };
    },
    async trial() {
      return { ok: false, message: "AtomCode 的领取动作就是 CodingPlan 领取（见签到）" };
    },
    /** 续期：POST {broker}/oauth/refresh，body 只有 refresh_token，**不带 Authorization**；
     *  轮换且可能不回新 refresh（省略时保留旧值）。 */
    async refreshToken(account, secrets) {
      const refresh = String((secrets && secrets.refreshToken) || "").trim();
      if (!refresh) return { ok: false, terminal: true, message: "无 refresh_token，请重新走一次浏览器登录" };
      const r = await httpJson(`${brokerBase()}/oauth/refresh`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": ua() },
        body: JSON.stringify({ refresh_token: refresh }),
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const d = (r.data && (r.data.data || r.data)) || {};
      if (!r.ok || !d.access_token)
        return { ok: false, terminal: /invalid_grant|invalid_client|expired/i.test(String(d.error || r.message || "")), message: `续期失败 HTTP ${r.status || 0}` };
      return {
        ok: true,
        token: String(d.access_token),
        refreshToken: String(d.refresh_token || refresh), // 省略时保留旧值
        rotated: !!(d.refresh_token && d.refresh_token !== refresh),
        expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : 0,
      };
    },
  };
}

module.exports = {
  makeAtomCode, planTierFromName, planTierFromStatus, classifyTierResponse,
  DEFAULT_BROKER_BASE, DEFAULT_CODINGPLAN_BASE, DEFAULT_GATEWAY_BASE, ADAPTER_USER_AGENT, CASCADE_ORDER,
};
