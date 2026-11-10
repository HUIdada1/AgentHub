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
// 豆包工作（www.doubao.com）：**自家协议 + Cookie 登录态**。
// 依据 Agent2Providers `doubaowork/`（mod.rs / api.rs / catalog.rs 模块头）。
//
// ── 上游形态 ────────────────────────────────────────────────
//   POST /alice/user/launch                       取 assistant_bot_id
//   POST /alice/slot/action_bar_v3/brief_list     模型菜单（bot_id）
//   POST /chat/completion                         对话（SSE）
//   查询串必须带 aid / device_platform / pc_version / device_id / fp —— 风控认的是
//   「这个账号在这台受信设备上」，缺 device_id / fp 一定被人机验证拦下。
//
// ── 能力与缺口（如实声明）────────────────────────────────────
//   有：对话、模型目录（在线菜单）、余额（订阅 overview 的 5h / 7d / 月窗口）、
//       每日签到（launch → campaign detail → 领奖 → 回查，带待确认台账）
//   无：**凭证续期**（Cookie 失效只能重新登录）
//   签到是**写链路**：领取回执不等于到账，最终以官方 checked_in_today 为准；
//   因此提交前先把「待确认」落盘，断网/超时/回执损坏只回查、不重复提交。
"use strict";
const crypto = require("node:crypto");

const BASE_URL = "https://www.doubao.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
/** 上游按 pc_version 下发模型菜单；只有 runtime_version 时会返回空菜单 */
const DEFAULT_CLIENT_VERSION = "2.33.5";

/** RFC3986 编码（与 api.rs encode 同口径） */
function encode(value) {
  return String(value).replace(/[^A-Za-z0-9\-._~]/g, (ch) => {
    const bytes = Buffer.from(ch, "utf8");
    let out = "";
    for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    return out;
  });
}

/** 固定查询参数（api.rs endpoint 的完整列表） */
function queryOf(creds) {
  const clientVersion = String(creds.clientVersion || DEFAULT_CLIENT_VERSION);
  const pairs = [
    ["aid", "1044603"], ["real_aid", "1044603"], ["device_platform", "web"],
    ["version_code", "20800"], ["samantha_web", "1"], ["web_platform", "desktop"],
    ["doubao_device_platform", "desktop"], ["client_platform", "pc_client"],
    ["pkg_type", "release_version"], ["runtime", "web"], ["runtime_version", "3.42.2"],
    ["pc_version", clientVersion], ["doubao_pc_version", clientVersion],
    ["use-olympus-account", "1"], ["language", "zh"], ["region", "CN"], ["sys_region", "CN"],
  ];
  if (creds.deviceId) { pairs.push(["device_id", creds.deviceId]); pairs.push(["fp", `verify_${creds.deviceId}`]); }
  else if (creds.fingerprint) pairs.push(["fp", creds.fingerprint]);
  for (const [wire, field] of [["web_id", "webId"], ["chromium_version", "chromiumVersion"], ["channel", "channel"]]) {
    if (creds[field]) pairs.push([wire, creds[field]]);
  }
  return pairs.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
}

/** 北京时间的「今天」（签到按北京时间零点切日） */
function beijingDay(ms = Date.now()) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
/** 进程内串行锁：并发点两次不能各发一次领奖请求 */
let claimBusy = false;
const LEDGER_KEY = "checkin";
const V3_GROUP = "pc_incentive_task_mvp_v3";
const CLAIM_PATH = "/alice/ug/campaign/item/reward/claim/";
const RETRY_GAP_MS = 10 * 60 * 1000;
const CONFIRM_WINDOW_MS = 30 * 60 * 1000;
const MAX_ROUNDS = 4;

/** 工厂：deps = { httpJson, rules, util, store } */
function makeDoubaoWork(deps) {
  const { httpJson, rules, store } = deps;
  const cfg = () => (rules.get("headers.json") || {}).doubaowork || {};
  const base = () => String(cfg().baseUrl || BASE_URL).replace(/\/+$/, "");

  function credsOf(secrets) {
    const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
    return {
      cookie: String((secrets && secrets.token) || "").trim(),
      deviceId: String(meta.deviceId || "").trim(),
      fingerprint: String(meta.fingerprint || "").trim(),
      clientVersion: String(meta.clientVersion || "").trim(),
      webId: String(meta.webId || "").trim(),
      chromiumVersion: String(meta.chromiumVersion || "").trim(),
      channel: String(meta.channel || "").trim(),
    };
  }
  function headersOf(creds) {
    return {
      cookie: creds.cookie,
      origin: base(),
      referer: `${base()}/chat/`,
      "user-agent": String(cfg().userAgent || USER_AGENT),
      "content-type": "application/json",
      "Agw-Js-Conv": "str",
      accept: "application/json",
    };
  }
  async function post(creds, path, body) {
    const url = `${base()}${path}?${queryOf(creds)}`;
    return httpJson(url, { method: "POST", headers: headersOf(creds), body: JSON.stringify(body || {}) })
      .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  }

  // ── 签到（rewards.rs / checkin.rs / checkin_state.rs 的移植）────────
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textIn = (value, key) => (value && typeof value[key] === "string" ? value[key].trim() : "");
  const numberOf = (value) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };

  /** 活动树里的任务：daily = 带 daily_checkin.checked_in_today 布尔；body = 领取请求体 */
  function tasksOf(value, group, out = [], depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return out;
    const groupCode = textIn(value, "campaign_group_code") || textIn(value, "campaign_code") || group;
    for (const key of ["tasks", "campaigns", "milestones"]) {
      for (const row of Array.isArray(value[key]) ? value[key] : []) {
        const item = textIn(row, "campaign_code");
        if (!item) continue;
        const rowGroup = textIn(row, "campaign_group_code") || groupCode;
        const dailyCheckin = row && typeof row.daily_checkin === "object" ? row.daily_checkin : null;
        const daily = !!dailyCheckin && typeof dailyCheckin.checked_in_today === "boolean";
        const checked = !!dailyCheckin && dailyCheckin.checked_in_today === true;
        const state = numberOf(row.task_status) ?? 0;
        const direct = numberOf(row.reward_mode) === 2 || key === "milestones";
        const body = direct
          ? (rowGroup ? { task_id: "", campaign_group_code: rowGroup, campaign_item_code: item } : null)
          : (textIn(row, "task_id") ? { task_id: textIn(row, "task_id") } : null);
        const points = numberOf(row?.daily_checkin?.reward?.reward_amount)
          ?? numberOf(row?.reward_summaries?.[0]?.reward_amount);
        const task = {
          key: item, group: rowGroup, state, daily, checked, points,
          body: state === 2 || (daily && direct && (state === 1 || state === 4)) ? body : null,
        };
        if (!out.some((old) => old.key === task.key && old.group === task.group)) out.push(task);
      }
    }
    // 活动组可能嵌在 data / campaign_group / campaign_groups 里（实测三种都出现过）
    for (const key of ["campaign_group", "campaign_groups", "data"]) {
      const child = value[key];
      if (Array.isArray(child)) { for (const row of child) tasksOf(row, groupCode, out, depth + 1); }
      else if (child && typeof child === "object") tasksOf(child, groupCode, out, depth + 1);
    }
    return out;
  }

  /** launch → 活动详情（v3 组走 /v3/detail/，其余走 /list/） */
  async function campaignDetail(creds) {
    const launch = await post(creds, "/alice/user/launch", {});
    if (launch.status === 401 || launch.status === 403) return { ok: false, authError: true, message: "Cookie 已失效，请重新登录" };
    if (!launch.ok || !launch.data) return { ok: false, message: `launch 失败 HTTP ${launch.status || 0}` };
    const info = launch.data?.data?.ug_campaign_info || launch.data?.ug_campaign_info || {};
    const group = textIn(info, "campaign_group_code");
    if (!group) return { ok: true, group: "", tasks: [] };
    const path = group === V3_GROUP ? "/alice/ug/campaign/v3/detail/" : "/alice/ug/campaign/list/";
    const detail = await post(creds, path, { campaign_group_code: group });
    if (detail.status === 401 || detail.status === 403) return { ok: false, authError: true, message: "Cookie 已失效，请重新登录" };
    if (!detail.ok || !detail.data) return { ok: false, message: `活动详情拉取失败 HTTP ${detail.status || 0}` };
    const data = detail.data.data;
    if (!data || typeof data !== "object") return { ok: false, message: "豆包工作活动详情格式无效" };
    if (group === V3_GROUP) {
      const code = textIn(data, "campaign_code");
      if (code && code !== group) return { ok: false, message: "豆包工作返回了不匹配的活动组" };
    }
    return { ok: true, group, tasks: tasksOf(detail.data, group) };
  }

  /** 待确认台账：存在账号 meta.checkin（跨重启有效；按北京时间切日） */
  function readLedger(id) {
    const fresh = { version: 1, day: beijingDay(), pending: null };
    if (!id || typeof store?.getAccount !== "function") return fresh;
    const row = store.getAccount(id);
    let meta = {};
    try { meta = row && row.meta ? JSON.parse(row.meta) : {}; } catch { meta = {}; }
    const stored = meta && meta[LEDGER_KEY];
    if (!stored || typeof stored !== "object") return fresh;
    // 只有明确的空台账才是首次领取；读失败或格式损坏不能抹掉上次提交的记忆
    if (stored.version !== 1 || typeof stored.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stored.day))
      throw new Error("豆包工作签到记录无效，已停止提交领取以避免重复操作");
    if (stored.day > fresh.day) throw new Error("系统日期早于豆包工作签到记录，请先校准时间");
    if (stored.day < fresh.day) return fresh;
    const pending = stored.pending;
    if (pending != null) {
      const valid = pending && typeof pending.group === "string" && pending.group
        && typeof pending.item === "string" && pending.item && Number(pending.submittedAt) > 0;
      if (!valid) throw new Error("豆包工作签到记录无效，已停止提交领取以避免重复操作");
    }
    return { version: 1, day: stored.day, pending: pending || null };
  }
  function writeLedger(id, ledger) {
    if (!id || typeof store?.patchAccountMeta !== "function") return;
    const ok = store.patchAccountMeta(id, (meta) => ({ ...meta, [LEDGER_KEY]: ledger }));
    if (!ok) throw new Error("保存豆包工作签到记录失败");
  }
  function retryAtOf(attempt) {
    const next = Date.now() + RETRY_GAP_MS;
    const rounds = Number(attempt.rounds) || 0;
    if (rounds >= MAX_ROUNDS) return 0;
    if (next > Number(attempt.submittedAt) + CONFIRM_WINDOW_MS) return 0;
    return beijingDay(next) === beijingDay() ? next : 0;
  }

  /** 回查：只查询、不重复提交（最多三次，18 秒预算） */
  async function reconcile(creds, id, ledger, submittedNow) {
    const attempt = ledger.pending;
    if (!attempt) return { ok: false, message: "豆包工作缺少待确认任务，未提交领取" };
    const deadline = Date.now() + 18000;
    for (const delay of [0, 2000, 4000]) {
      if (delay) await sleep(delay);
      if (Date.now() > deadline) break;
      if (beijingDay() !== ledger.day) return { ok: false, message: "签到确认已跨过北京时间零点，未将昨日结果计为今日签到，请重新查询今日活动" };
      const detail = await campaignDetail(creds);
      if (!detail.ok) return { ok: false, confirming: true, retryAt: retryAtOf(attempt), message: detail.message };
      const after = detail.tasks.find((task) => task.daily && task.key === attempt.item && task.group === attempt.group);
      if (!after) return { ok: false, confirming: true, retryAt: retryAtOf(attempt), message: "豆包工作回查未返回原签到任务，尚未确认到账；再次点击只查询结果" };
      if (after.checked) {
        writeLedger(id, { ...ledger, pending: null });
        const points = attempt.points ?? after.points ?? 0;
        return submittedNow
          ? { ok: true, claimed: true, gained: points > 0 ? points : 0, message: "豆包工作签到奖励已领取，已回查确认" }
          : { ok: true, already: true, message: "今日已领取豆包工作签到奖励，已由官方确认" };
      }
    }
    const retryAt = retryAtOf(attempt);
    writeLedger(id, { ...ledger, pending: { ...attempt, rounds: (Number(attempt.rounds) || 0) + 1 } });
    return {
      ok: false, confirming: true, retryAt,
      message: "豆包工作领取结果待确认，稍后只查询结果，不会重复提交领取",
    };
  }

  async function runCheckin(account, creds) {
    const id = account && account.id;
    const ledger = readLedger(id);
    if (ledger.pending) {
      ledger.pending = { ...ledger.pending, rounds: (Number(ledger.pending.rounds) || 0) + 1 };
      writeLedger(id, ledger);
      return reconcile(creds, id, ledger, false);
    }
    const detail = await campaignDetail(creds);
    if (!detail.ok) return { ok: false, message: detail.message, ...(detail.authError ? { authError: true } : {}) };
    const daily = detail.tasks.filter((task) => task.daily);
    if (daily.length > 1) return { ok: false, message: "豆包工作返回了多个每日签到任务，无法确定领取对象，未提交领取" };
    if (!daily.length) return { ok: false, unavailable: true, message: "当前活动未提供每日签到任务" };
    const task = daily[0];
    // 已有明确的布尔标记时不能用 task_status 覆盖 checked_in_today=false
    if (task.checked) return { ok: true, already: true, message: "今日签到已领取" };
    if (!task.body) return { ok: false, unavailable: true, message: "今日签到任务尚未满足领取条件" };
    if (beijingDay() !== ledger.day) return { ok: false, message: "签到已跨过北京时间零点，请重新查询今日活动" };
    ledger.pending = { group: task.group, item: task.key, submittedAt: Date.now(), rounds: 1, points: task.points };
    // 保存失败就不发写请求（抛错由调用方转成失败），避免丢重复提交保护
    writeLedger(id, ledger);
    const claimed = await post(creds, CLAIM_PATH, task.body);
    if (!claimed.ok) {
      // 明确拒绝可重新尝试；断网、超时、5xx、损坏回执都不能证明写请求未生效 → 保留待确认
      const rejected = [400, 401, 403, 404, 405, 422, 429].includes(Number(claimed.status));
      if (rejected) {
        writeLedger(id, { ...ledger, pending: null });
        return { ok: false, message: claimed.message || `领取被拒（HTTP ${claimed.status}）` };
      }
      return reconcile(creds, id, ledger, false);
    }
    const gained = numberOf(claimed.data?.data?.reward_amount);
    if (gained != null && ledger.pending) ledger.pending.points = gained;
    return reconcile(creds, id, ledger, true);
  }

  return {
    id: "doubaowork",
    cfg,
    models() {
      const cat = (rules.get("catalog.json") || {}).doubaowork || {};
      const rows = Array.isArray(cat.models) ? cat.models : [];
      return rows.map((m) => String(m.id)).filter(Boolean);
    },
    /** 目录：launch 取 bot_id → brief_list 取菜单 */
    async fetchModels(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { ok: false, message: "缺少 Cookie 登录态" };
      const launch = await post(creds, "/alice/user/launch", {});
      if (launch.status === 401 || launch.status === 403) return { ok: false, authError: true, message: "Cookie 已失效，请重新登录" };
      if (!launch.ok || !launch.data) return { ok: false, message: `launch 失败 HTTP ${launch.status || 0}` };
      const bot = String(launch.data?.data?.assistant_bot_id || launch.data?.assistant_bot_id || "").trim();
      if (!bot) return { ok: false, message: "上游未返回助手 ID（assistant_bot_id）" };
      const menu = await post(creds, "/alice/slot/action_bar_v3/brief_list", { language_code: "zh", bot_id: bot });
      if (!menu.ok || !menu.data) return { ok: false, message: `模型菜单拉取失败 HTTP ${menu.status || 0}` };
      // 菜单结构随版本变化：递归收集「像模型条目」的对象（有 key/id 与 name/label）
      const out = [];
      const seen = new Set();
      const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 8) return;
        if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
        const id = node.model_item_key || node.model_key || node.key || node.item_key;
        const name = node.name || node.label || node.display_name || node.title;
        if (typeof id === "string" && id.trim() && typeof name === "string" && name.trim() && !seen.has(id)) {
          seen.add(id);
          out.push({ id: String(id), name: String(name), rate: null, capabilities: { tools: true, reasoning: false, images: false }, contextLength: 0, maxOutputTokens: 0 });
        }
        for (const value of Object.values(node)) visit(value, depth + 1);
      };
      visit(menu.data, 0);
      if (!out.length) return { ok: false, message: "模型菜单为空或格式已变化（保留已有清单）" };
      return { ok: true, models: out, botId: bot };
    },
    /** 余额：POST /alice/commerce/sale/subscription/overview/（`{"product_line":"membership"}`）
     *  参考实现 doubaowork/quota.rs：个人/企业两套 `window_limit_section`，按
     *  `member_info.has*Subscription` 与 `usage_exhausted` 选一套；窗口类型
     *  1=5 小时、2=近 7 天、4=每月；非企业账号再补 `quota_package_section` 的 3=订阅额度。
     *  只读、单跳，失败如实 unavailable——这是「余额未对接」里唯一能安全落地的部分。 */
    async queryCredits(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { authError: true, message: "缺少 Cookie 登录态" };
      const r = await post(creds, "/alice/commerce/sale/subscription/overview/", { product_line: "membership" });
      if (r.status === 401 || r.status === 403) return { authError: true, message: "Cookie 已失效，请重新登录" };
      if (!r.ok || !r.data) return { unavailable: true, message: `额度查询失败 HTTP ${r.status || 0}` };
      const data = r.data.data && typeof r.data.data === "object" ? r.data.data : r.data;
      const limits = (section) => {
        const groups = Array.isArray(section?.window_limit_groups) ? section.window_limit_groups : [];
        return groups.flatMap((group) => (Array.isArray(group?.window_limits) ? group.window_limits : [])
          .map((limit) => ({ group, limit })));
      };
      const numberOf = (value) => {
        const n = typeof value === "number" ? value : Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };
      const usable = (section) => section && section.usage_exhausted !== true
        && limits(section).some(({ limit }) => [1, 2, 4].includes(numberOf(limit?.window_type) ?? -1));
      const member = data.member_info || {};
      const personal = data.window_limit_section;
      const enterprise = data.enterprise_window_limit_section;
      const hasPersonal = member.hasActiveSubscription === true;
      const hasEnterprise = member.hasEnterpriseSubscription === true;
      const enterpriseSelected = hasEnterprise && (usable(enterprise) || !hasPersonal || !usable(personal));
      const section = enterpriseSelected ? enterprise : hasPersonal ? personal : null;
      const packages = [];
      let remaining = 0;
      const rows = [];
      if (section) rows.push(...limits(section).filter(({ limit }) => [1, 2, 4].includes(numberOf(limit?.window_type) ?? -1)));
      if (!enterpriseSelected) rows.push(...limits(data.quota_package_section).filter(({ limit }) => numberOf(limit?.window_type) === 3));
      const WINDOW_LABEL = { 1: "5 小时", 2: "近 7 天", 3: "订阅额度", 4: "每月" };
      for (const { group, limit } of rows) {
        const code = numberOf(limit?.window_type) ?? 0;
        const total = numberOf(limit?.total_amount);
        const used = numberOf(limit?.used_amount);
        const left = total != null && used != null ? Math.max(total - used, 0) : null;
        const percent = numberOf(limit?.used_percent) != null ? Math.max(100 - Number(limit.used_percent), 0)
          : total > 0 && used != null ? Math.max(((total - used) / total) * 100, 0) : null;
        const groupName = String(group?.feature_group_name || "").trim();
        const name = `${groupName} ${WINDOW_LABEL[code] || "订阅额度"}`.trim();
        const rawEnd = limit?.end_time;
        const endNumber = Number(rawEnd);
        const reset = Number.isFinite(endNumber) && endNumber > 0
          ? (endNumber > 1e12 ? endNumber : endNumber * 1000)
          : (Number.isFinite(Date.parse(String(rawEnd || ""))) ? Date.parse(String(rawEnd)) : 0);
        const unlimited = limit?.unlimited === true || (code === 1 && limit?.exemption?.active === true);
        packages.push({
          code: `${code}-${packages.length}`, name,
          total: total ?? -1, used: used ?? -1,
          remaining: left != null ? Math.floor(left) : Math.floor(percent ?? 0),
          expiresAt: reset, ord: packages.length,
          ...(unlimited ? { unlimited: true } : {}),
        });
        if (left != null && !unlimited) remaining += left;
      }
      if (!packages.length) return { unavailable: true, message: "上游未返回额度窗口（该账号可能没有订阅）" };
      const plan = data.membership_display_name
        || data?.current_subscription?.display?.short_name
        || data?.current_subscription?.display?.product_name
        || data?.subscription?.display?.short_name || "";
      return {
        credits: Math.floor(remaining),
        expiresAt: packages.find((row) => row.expiresAt)?.expiresAt || 0,
        packages,
        planName: String(plan || ""),
        unit: "额度",
      };
    },
    /** 签到状态：读活动详情里的 daily_checkin.checked_in_today（**只读**，不提交） */
    async checkinStatus(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { unavailable: true, message: "缺少 Cookie 登录态" };
      const detail = await campaignDetail(creds);
      if (detail.authError) return { unavailable: true, message: detail.message, authError: true };
      if (!detail.ok) return { unavailable: true, message: detail.message };
      const daily = detail.tasks.filter((task) => task.daily);
      if (!daily.length) return { unavailable: true, message: "当前账号未下发豆包工作签到活动" };
      if (daily.some((task) => task.checked)) return { ok: true, already: true, message: "今日签到已领取" };
      const claimable = daily.filter((task) => !!task.body).length;
      if (claimable > 0) return { ok: true, claimable, message: `今日可签到（${claimable} 个每日任务）` };
      return { ok: true, already: false, message: "今日签到任务尚未满足领取条件" };
    },
    /** 签到：提交前先落「待确认」，之后只回查、不重复提交（checkin.rs + checkin_state.rs） */
    async checkin(account, secrets) {
      const creds = credsOf(secrets);
      if (!creds.cookie) return { ok: false, message: "缺少 Cookie 登录态" };
      if (claimBusy) return { ok: false, message: "签到正在进行中，请稍后再试" };
      claimBusy = true;
      try {
        return await runCheckin(account, creds);
      } finally {
        claimBusy = false;
      }
    },
    async trial() {
      return { ok: false, message: "豆包工作无加油包领取动作" };
    },
    /** Cookie 登录态没有续期接口 */
    async refreshToken() {
      return { ok: false, noRefresh: true, terminal: false, message: "豆包工作用 Cookie 登录态，没有续期接口；失效请重新登录并重新粘贴" };
    },
    /** 投影给插件的凭据：Cookie + 设备标识（风控认设备，缺 device_id/fp 必被拦） */
    readForwardCredentials(account, secrets) {
      const creds = credsOf(secrets);
      return { token: creds.cookie, deviceId: creds.deviceId, clientVersion: creds.clientVersion, webId: creds.webId, chromiumVersion: creds.chromiumVersion, channel: creds.channel };
    },
    /** 读本机客户端登录态（直接读 Cookie 库，不需要调试端口；只读不写回） */
    readDesktopState() {
      return require("./desktop.cjs").readDesktopState();
    },
    /** Cookie 串 → uid（sessionid 的摘要；不落明文，可去重） */
    uidOfCookie(cookie) {
      const text = String(cookie || "");
      const hit = /(?:^|;\s*)sessionid=([^;]+)/i.exec(text);
      const seed = hit ? hit[1] : text;
      return `db_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
    },
  };
}

module.exports = { makeDoubaoWork, queryOf, encode, BASE_URL, DEFAULT_CLIENT_VERSION, USER_AGENT };
