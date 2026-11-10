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
// AStudio（科大讯飞 Astron Studio）：**OpenAI Responses 协议 + 网页会话积分**。
// 依据 Agent2Providers `astudio/`（endpoints.rs / usage.rs / checkin.rs 模块头）。
//
// ── 上游是什么 ──────────────────────────────────────────────
//   模型调用  POST https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses
//             （OpenAI Responses 协议，Authorization: Bearer <modelBearerToken>）
//   模型目录  GET  https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models
//   账号面    https://agent.xfyun.cn/xingchen-studio/points/balance、membership/me
//   每日登录  POST tenant-app/v2/init-app（带网页会话，无请求体）
//
// ── 能力与缺口（如实声明）─────────────────────────────────────
//   有：对话（Responses）、在线目录、余额、每日登录积分
//   无：**凭证续期**（凭据失效只能重新读取桌面端登录态或重新粘贴）
"use strict";

const RESPONSES_URL = "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses";
const MODEL_MANAGER_URL = "https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models";
/** 账号面根（结尾带斜杠：相对路径拼在它后面） */
const STUDIO_API_BASE = "https://agent.xfyun.cn/xingchen-studio/";
const POINTS_BALANCE = "points/balance";
const MEMBERSHIP_ME = "membership/me";
const INIT_APP = "tenant-app/v2/init-app";

/** 工厂：deps = { httpJson, rules, util, store } */
function makeAStudio(deps) {
  const { httpJson, rules } = deps;
  const cfg = () => (rules.get("headers.json") || {}).astudio || {};
  const studio = () => String(cfg().studioApiBase || STUDIO_API_BASE);

  /** 账号里的两层凭据：模型 bearer + 网页会话 Cookie */
  function credsOf(secrets) {
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    return {
      key: String((secrets && secrets.token) || "").trim(),
      cookie: String(meta.cookie || "").trim(),
      uid: String(meta.uid || "").trim(),
    };
  }

  /** 账号面 GET（网页会话 Cookie） */
  async function studioJson(creds, relativePath) {
    if (!creds.cookie) return { ok: false, noSession: true, message: "该账号只有模型凭据（无网页会话），余额与签到不可用" };
    const url = new URL(relativePath, studio()).toString();
    const r = await httpJson(url, {
      method: "GET",
      headers: { cookie: creds.cookie, accept: "application/json", "user-agent": "Mozilla/5.0" },
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "网页会话已失效，请重新登录" };
    if (!r.ok || !r.data) return { ok: false, message: `账号面请求失败 HTTP ${r.status || 0}` };
    return { ok: true, data: (r.data.data && typeof r.data.data === "object") ? r.data.data : r.data };
  }

  return {
    id: "astudio",
    cfg,
    models() {
      const cat = (rules.get("catalog.json") || {}).astudio || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      return rows.map((m) => String(m.id)).filter(Boolean);
    },
    /** 目录：GET /api/v1/model-manager/models（Bearer modelBearerToken） */
    async fetchModels(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.key) return { ok: false, message: "缺少 modelBearerToken" };
      const r = await httpJson(String(cfg().modelManagerUrl || MODEL_MANAGER_URL), {
        method: "GET", headers: { authorization: `Bearer ${creds.key}`, accept: "application/json" },
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, authError: true, message: "模型凭据被拒（HTTP 401/403），请重新登录" };
      if (!r.ok || !r.data) return { ok: false, message: `目录拉取失败 HTTP ${r.status || 0}` };
      const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r.data.data) ? r.data.data : (Array.isArray(r.data.models) ? r.data.models : []));
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const id = row && (row.modelId || row.id || row.name);
        if (typeof id !== "string" || !id.trim() || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        out.push({ id: String(id), name: String(row.name || row.displayName || id), rate: null, capabilities: { tools: true, reasoning: true, images: false }, contextLength: 0, maxOutputTokens: 0 });
      }
      if (!out.length) return { ok: false, message: "目录为空" };
      return { ok: true, models: out };
    },
    /** 余额：通用积分 + 星火积分（两条接口，单项失败不塌方；会话失效必须透传） */
    async queryCredits(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { unavailable: true, message: "该账号只有模型凭据（无网页会话），余额不可用" };
      const [balance, membership] = await Promise.all([
        studioJson(creds, POINTS_BALANCE),
        studioJson(creds, MEMBERSHIP_ME),
      ]);
      if (balance.authError || membership.authError) return { authError: true, message: "网页会话已失效，请重新登录" };
      const packages = [];
      let credits = 0;
      if (balance.ok) {
        const d = balance.data || {};
        const total = Number(d.totalBalance);
        if (Number.isFinite(total)) {
          credits += total;
          packages.push({ code: "general", name: "通用积分", total: -1, used: -1, remaining: Math.max(total, 0), expiresAt: 0, ord: 0 });
        }
        const spark = Number(d.sparkTotalBalance);
        if (Number.isFinite(spark)) {
          credits += spark;
          packages.push({ code: "spark", name: "星火积分", total: -1, used: -1, remaining: Math.max(spark, 0), expiresAt: 0, ord: packages.length });
        }
      }
      if (!packages.length) return { unavailable: true, message: `账号信息读取失败：${[balance.message, membership.message].filter(Boolean).join("；") || "上游未返回余额"}` };
      return { credits, expiresAt: 0, packages, planName: membership.ok ? String((membership.data && membership.data.planName) || "") : "" };
    },
    /** 签到状态：只读会员信息（不产生写操作） */
    async checkinStatus(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { unavailable: true, message: "该账号只有模型凭据（无网页会话），无法执行每日登录签到" };
      const r = await studioJson(creds, MEMBERSHIP_ME);
      if (r.authError) return { unavailable: true, message: r.message };
      if (!r.ok) return { unavailable: true, message: r.message };
      return { ok: true, claimable: 1, message: "可执行每日登录（POST tenant-app/v2/init-app 触发登录奖励）" };
    },
    /** 签到：POST tenant-app/v2/init-app（无 body、带 Cookie）→ 前后读余额核对增量 */
    async checkin(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { ok: false, unavailable: true, message: "该账号只有模型凭据（无网页会话），无法执行每日登录签到" };
      const before = await this.queryCredits(account, secrets);
      const url = new URL(INIT_APP, studio()).toString();
      const r = await httpJson(url, {
        method: "POST", headers: { cookie: creds.cookie, accept: "application/json", "user-agent": "Mozilla/5.0" },
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, message: "网页会话已失效，请重新登录" };
      if (!r.ok) return { ok: false, message: `每日登录请求失败 HTTP ${r.status || 0}` };
      // 等上游结算后再读一次（2.5 秒；与参考实现同档）
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const after = await this.queryCredits(account, secrets);
      const gained = Number.isFinite(after.credits) && Number.isFinite(before.credits) ? Math.max(after.credits - before.credits, 0) : 0;
      return {
        ok: true, claimed: true, gained,
        // 余额没涨不等于今日已领，也不能断言没有活动；只报告本次未观测到新到账
        message: gained > 0 ? `已领取 ${gained} 积分` : "已执行每日登录（本次未观测到新到账，可能今日已领）",
      };
    },
    async trial() {
      return { ok: false, message: "AStudio 无加油包领取动作（上游没有接口）" };
    },
    /** 无续期接口：凭据失效只能重新读取桌面端登录态或重新粘贴 */
    async refreshToken() {
      return { ok: false, noRefresh: true, terminal: false, message: "AStudio 没有续期接口：凭据失效后请重新读取桌面端登录态或重新粘贴" };
    },
    /** 读本机桌面端登录态（env / 注册表 HKCU\Software\AStudioStorage / ~/.acode 三路候选） */
    readDesktopState() {
      return require("./desktop.cjs").readDesktopState();
    },
  };
}

module.exports = { makeAStudio, RESPONSES_URL, MODEL_MANAGER_URL, STUDIO_API_BASE, POINTS_BALANCE, MEMBERSHIP_ME, INIT_APP };
