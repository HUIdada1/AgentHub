/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 号池管家 · 编排层：模块装配 + IPC 命令注册（对应前端 src/views/proxy/* 与 src/api/ipc.ts）
// 原「反代网关」模块已停止维护，转发服务（server.cjs）、API Keys、模型目录、自定义提供商、
// CC Switch 生态接入、网络代理页签、用量统计与远程 Docker 实例一并下线并归档到
// 「废弃代码（禁止git提交推送）/」；本编排层只保留号池管理：渠道账号、余额、积分签到、
// 号池同步与操作日志。
// 设置统一存框架整体配置 config.json 的 proxy 段（config.cjs 默认值深合并），每次读取走磁盘 = 热生效。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto"); // JSON 导入账号的 uid 派生用（Node 22 全局 crypto 是 WebCrypto，无 createHash）
const config = require("../config.cjs");
const platform = require("./platform/index.cjs");
const store = require("./store.cjs");
const rules = require("./rules.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const discovery = require("./discovery.cjs");
const credits = require("./credits.cjs");
const events = require("./events.cjs");
const util = require("./util.cjs");
const ideswitch = require("./ideswitch.cjs");
const poolsync = require("./poolsync.cjs");
const poolsched = require("./poolsched.cjs");
const oplog = require("./oplog.cjs");
// 网络代理池（出口池 + 出站策略）：adapters 的每次上游请求都经它取出口。
// 号池管家不再提供「网络代理」页签，但适配层仍依赖它取出口，故保留模块本体。
const netproxy = require("./netproxy.cjs");
const xlsx = require("./xlsx.cjs"); // xlsx 写入器在本目录（v1.57.0 误写 ../xlsx.cjs，顶层 require 抛错 → 启动即崩）
const zcodeLocal = require("./zcodeLocal.cjs");
const zip = require("../zip.cjs");
// 休眠唤醒守卫：避免唤醒瞬间逾期定时任务集中爆发（见 backend/wakeGuard.cjs 的实测说明）
const wakeGuard = require("../wakeGuard.cjs");
/** 签到自动检查的 tick 间隔：既用于 setInterval，也作为 B（时间跳跃检测）的预期间隔 */
const CHECKIN_TICK_MS = 60000;

// ModelScope（魔搭）续期实现注入：discovery.cjs 顶部 require 了 adapters.cjs，
// 适配器反向 require 会形成循环依赖（Node 下取到半初始化模块），故与 qoderAdapter
// 同款处理——由编排层在这里把实现注入给适配器。
adapters.setModelScopeRefresh(discovery.refreshModelScopeToken);

// ===== 号池 JSON 导入（粘贴 / 文件共用）：单个对象或数组，字段容忍常见别名 =====

/** JSON 文本宽容解析（快照形态的 credentials/config 常是字符串内嵌 JSON） */
function looseJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const j = JSON.parse(value);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * zcode 快照形态识别（三种来源同构归一）：
 *   ① 账号切换工具导出：{meta:{label,email}, snapshot:{credentials, config}}
 *   ② 官方/手工裸快照：{credentials, config}（credentials 可为对象或 JSON 字符串）
 *   ③ 官方档案导出：{provider_api_keys, cred_file?…} 带 credentials 键的变体
 * 守卫：credentials JSON 必须含 zcode 特征键（zcodejwttoken / oauth:* / account-provider:*），
 * 否则不接管（其他渠道的 credentials 字段名撞车不误导）。
 */
function normalizeZcodeSnapshot(raw) {
  const snap = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : raw;
  const credJson = looseJson(snap.credentials);
  if (!credJson) return null;
  const keys = Object.keys(credJson);
  if (!keys.some((k) => k === "zcodejwttoken" || k.startsWith("oauth:") || k.startsWith("account-provider:"))) return null;
  const parsed = zcodeLocal.parseCredentials(credJson);
  const configJson = looseJson(snap.config);
  const configKeys = zcodeLocal.extractConfigApiKeys(configJson);
  const label = (raw.meta && (raw.meta.label || raw.meta.email || raw.meta.name)) || snap.label || snap.name || snap.email || "";
  const record = zcodeLocal.accountRecord(parsed, {
    profileApiKeys: { ...configKeys, ...(looseJson(snap.provider_api_keys) || {}) },
    jwtFallback: configKeys["builtin:zai-start-plan"] || configKeys["builtin:bigmodel-start-plan"] || "",
    name: String(label || snap.name || ""),
    email: String((raw.meta && raw.meta.email) || snap.email || ""),
  });
  if (!record.token && !record.refreshToken) return null;
  return { channel: "zcode", ...record, expiresAt: 0, source: "json" };
}

// 一条记录归一化为 addAccount 入参；token 与 refreshToken 均为空返回 null（交由上层按无效计数）
function normalizeAccountJson(raw, fallbackChannel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // zcode 快照顾例先行（整份 credentials 导入，含切号快照）
  const snap = normalizeZcodeSnapshot(raw);
  if (snap) return snap;
  const channel = adapters.get(raw.channel) ? String(raw.channel) : fallbackChannel;
  let token = String(raw.token ?? raw.accessToken ?? raw.access_token ?? raw.jwt ?? raw.JWT ?? raw.zcodeJwtToken ?? raw.zcodejwttoken ?? "").trim();
  token = token.replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
  let refreshToken = String(raw.refreshToken ?? raw.refresh_token ?? raw.apiKey ?? raw.codingPlanKey ?? "").trim();
  // 智能识别：如果是 zcode 渠道，且 token 看起来是 32 位 apiKey.secret（2段且非 JWT），将其归一化到 refreshToken
  if (channel === "zcode") {
    if (token && !refreshToken && /^[a-f0-9]{32}\.[a-zA-Z0-9_-]+$/i.test(token)) {
      refreshToken = token;
      token = "";
    }
    if (!token && !refreshToken) return null;
  } else if (!token) {
    return null;
  }
  // CatPaw：凭据是桌面端会话 Cookie 里的 X-Passport-Token 值，用户常整段粘 Cookie 串——
  // 归一到该字段的值（认不出就原样当裸 token，与适配器侧的容错同口径）
  if (channel === "catpaw") {
    token = require("./catpaw/credentials.cjs").passportTokenOf(token);
    if (!token) return null;
  }
  const dec = util.jwtDecode(token);
  let uid = String(raw.uid ?? raw.userId ?? raw.user_id ?? dec.uid ?? "").trim();
  if (!uid && refreshToken) {
    uid = crypto.createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
  }
  const out = {
    channel,
    uid,
    name: String(raw.name ?? raw.remark ?? "").trim(),
    token,
    refreshToken,
    expiresAt: Number(raw.expiresAt ?? raw.expires_at ?? 0) || 0,
    source: "json",
  };
  // zcode 专属画像字段（provider/email 透传 meta，切号快照缺失时这些是仅有的渠道身份）
  if (channel === "zcode" && (raw.provider || raw.email)) {
    out.meta = { provider: String(raw.provider || "zai"), email: String(raw.email || "") };
  }
  return out;
}

/** 解析 JSON 文本（对象 / 数组 / {accounts:[...]} 包装），返回 { list, invalid, reason? } */
function parseAccountsJson(text, fallbackChannel) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("JSON 解析失败：内容不是合法 JSON");
  }
  // 桌面端「导出选中账号」是元数据包（format=agenthub-accounts，故意不含 token）。
  // 它与容器灌号所需的凭据包语义不同，直接按「缺 token」报错会把用户引向错误方向。
  if (parsed && parsed.format === "agenthub-accounts") {
    return { list: [], invalid: Array.isArray(parsed.accounts) ? parsed.accounts.length : 0, reason: "metadata-only" };
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [parsed];
  const list = [];
  let invalid = 0;
  for (const item of arr) {
    const acc = normalizeAccountJson(item, fallbackChannel);
    if (acc) list.push(acc);
    else invalid++;
  }
  return { list, invalid };
}

// 桌面元数据包 vs 凭据包：报错必须说清「文件本来就没有 token」，否则用户会反复换文件格式。
const METADATA_ONLY_MESSAGE =
  "这是旧版桌面端导出的账号元数据（不含 token），不能用于灌号。请改用：① 号池同步（推荐）；" +
  "② 粘贴含 token/refreshToken 的凭据 JSON（新版桌面端号池「导出」按钮的产物已含明文凭据）；" +
  "③ 管理 API POST /api/accounts/import";

/** 批量入池：同渠道同 uid 已存在则跳过；入池即后台查一次额度 */
function importAccounts(list) {
  const existing = store.listAccounts();
  let added = 0, dup = 0;
  for (const acc of list) {
    if (acc.uid && existing.some((a) => a.channel === acc.channel && a.uid === acc.uid)) {
      dup++;
      continue;
    }
    const id = store.addAccount(acc);
    credits.refreshAccount(id).catch(() => {}); // 入池即查一次额度（失败不阻塞）
    added++;
  }
  return { added, dup };
}

/** 网关设置（框架整体配置的 proxy 段，深合并默认值后必有完整结构） */
function settings() {
  return config.loadConfig().proxy;
}

/** 渠道启闭（「上游启闭」弹窗）：与 adapters.channelOn 同口径（显式 false = 关闭，其余 = 启用） */
function channelOn(channel) {
  const v = (settings().channelEnabled || {})[channel];
  return v !== false;
}

let booted = false;

// ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包，实测端点） =====
/** 批量签到动作：channel 为空 = 全渠道；accountId 指定 = 单账号（OAuth 登录后自动签到用）。
 *  国际版没有每日签到体系，checkin 动作对它自动改走 trial 加油包（与号池页按钮行为一致） */
let checkinBusy = false;
async function checkinBatch({ channel, accountId, action, interactive }) {
  const acts = ["status", "checkin", "trial"];
  const act = acts.includes(String(action)) ? String(action) : "checkin";
  if (checkinBusy && act !== "status") return { ok: false, action: act, total: 0, okCount: 0, rows: [], message: "签到进行中" };
  if (act !== "status") checkinBusy = true;
  try {
    const accounts = store.listAccounts().filter(
      (a) =>
        (!channel || a.channel === channel) &&
        (!accountId || a.id === accountId) &&
        a.hasToken &&
        a.status !== "disabled"
    );
    const rows = [];
    for (const acc of accounts) {
      // 避免突发并发风控：多账号批量操作（非纯状态查询）在账号之间注入 800ms ~ 2000ms 随机抖动
      if (act !== "status" && accounts.length > 1 && rows.length > 0) {
        const jitter = 800 + Math.floor(Math.random() * 1200);
        await new Promise((r) => setTimeout(r, jitter));
      }
      const ad = adapters.get(acc.channel);
      // 账号表可能残留已下架渠道的 channel（渠道注册表收缩后）——不守卫会在下面
      // ad.checkinStatus 处抛 TypeError，把整批签到拖进 catch 逐条报「Cannot read properties of null」
      if (!ad) {
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: false, message: `未知渠道 ${acc.channel}（适配器未注册）` });
        continue;
      }
      const useAct = act === "checkin" && acc.channel === "workbuddy_ai" ? "trial" : act;
      let secrets = store.accountSecrets(store.getAccount(acc.id));
      try {
        // 凭证保鲜：手上 token 已过期/临期时先刷一次（与余额链路 ensureFreshSecrets 同一口径）。
        // 缺这一步时，noPersist 渠道（AutoClaw 的新凭证只进适配器进程缓存、不落库）在进程
        // 重启后会拿着库内旧 token 直接吃 401——表现为「签到报登录态已过期，对话却正常」
        const tokenBefore = secrets.token;
        if (useAct !== "status") secrets = await credits.ensureFreshSecrets(acc, secrets);
        let r;
        if (useAct === "status") r = await ad.checkinStatus(acc, secrets);
        else if (useAct === "checkin") {
          r = await ad.checkin(acc, secrets);
          // 预刷新没赶上（或 refreshToken 刚被上游轮换）：刷新后重试一次，
          // 与对话链路 attemptChat 的 401 处理同款（single-flight，不重复刷）。
          // 预刷新已经换过 token 时不再刷第二次——那会白消耗一次 refresh_token 轮换
          if (r && r.authError && secrets.token === tokenBefore) {
            const rr = await adapters.refreshTokenLocked(acc.channel, acc, secrets).catch(() => ({ ok: false }));
            if (rr.ok) {
              secrets = { ...secrets, token: rr.token, refreshToken: rr.refreshToken };
              r = await ad.checkin(acc, secrets);
            }
          }
          // zcode 领取奖励的人机校验二段流：上游启用验证码时适配器返回 needCaptcha，
          // 手动发起的领取弹官方 SDK 验证窗拿 verifyParam 重调一次；无人值守的自动 tick
          // 不弹窗，该行如实标「需人工过码」，UI 提示用户手动领取
          if (r && r.needCaptcha && r.captcha && r.captcha.sceneId && typeof ad.checkin === "function") {
            if (interactive) {
              const cap = await platform.solveCaptcha(r.captcha);
              if (cap.ok) {
                r = await ad.checkin(acc, secrets, { captcha: { verifyParam: cap.verifyParam, region: cap.region || r.captcha.region, sceneId: r.captcha.sceneId }, planId: r.planId });
              } else {
                r = { ok: false, needCaptcha: true, message: cap.message || "人机校验未完成" };
              }
            } else {
              r = { ok: false, needCaptcha: true, skipped: true, message: "领取奖励需要完成一次人机校验，请到号池页手动点「一键领取」" };
            }
          }
        } else r = typeof ad.trial === "function" ? await ad.trial(acc, secrets) : { ok: false, message: "该渠道没有加油包" };
        // 国际版每日活跃（保活三件事）：issue #277 的实测结论——国际版没有签到体系，
        // 每日奖励的判定挂在①活跃上报 ②免费模型对话 ③网页会话 三条通道上，缺一条就领不到。
        // 放在 trial 之后：领完加油包顺手把「今日活跃」做掉，用户点一次就完整跑一遍。
        // 纯 best-effort：失败只拼进 message，绝不把 trial 的 ok 翻成失败（活动开关在上游手里，
        // 关掉活动不该让整个定时签到报错）。status/桌面端不触发，避免只查状态就写上游。
        if (useAct === "trial" && r && r.ok !== false && typeof ad.dailyActivity === "function") {
          try {
            const da = await ad.dailyActivity(acc, secrets);
            r.dailyActivity = da;
            if (da && da.message) r.message = `${r.message || ""}${r.message ? " · " : ""}每日活跃：${da.message}`.slice(0, 400);
          } catch (e) {
            r.dailyActivity = { ok: false, message: String((e && e.message) || e) };
          }
        }
        // 小浣熊首登奖励（一次性新手福利，桌面端/手机端各一条）自动领取：台账（meta.onboardingGrants）
        // 未结算才探测，成功（含幂等 granted=false）落标记，失败不落、下轮签到/自动签到自然重试
        // （「直到领取成功，后续不再领取」）。签到失败（401/网络）时跳过——凭证问题领取也必然失败
        if (useAct === "checkin" && acc.channel === "raccoon" && r.ok && typeof ad.claimOnboarding === "function") {
          try {
            const ob = await ad.claimOnboarding(acc, secrets);
            // settled 只含探测成功的增量（部分失败时成功那条也要落台账），401/全失败时为空
            if (ob && ob.settled && Object.keys(ob.settled).length) {
              store.noteOnboardingGrant(acc.id, ob.settled);
            }
            if (ob && (ob.claimed > 0 || ob.failed > 0)) {
              r.onboarding = { claimed: ob.claimed, already: ob.already, failed: ob.failed, points: ob.claimedPoints };
              const parts = [];
              if (ob.claimed > 0) parts.push(`首登奖励领取 ${ob.claimed} 项（+${ob.claimedPoints}）`);
              if (ob.already > 0) parts.push(`${ob.already} 项此前已领`);
              if (ob.failed > 0) parts.push(`${ob.failed} 项领取失败（下次签到自动重试）`);
              if (parts.length) r.message = `${r.message || "签到成功"} · ${parts.join("，")}`;
            }
          } catch { /* 领取失败不影响签到本身 */ }
        }
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: !!r.ok, ...r });
        // 签到结果落操作日志（needCaptcha=需人工过码记 warn，失败记 error）
        if (useAct !== "status") {
          oplog.log(r && r.needCaptcha ? "warn" : r && r.ok ? "info" : "error", "签到",
            String(r.message || (r.ok ? "签到完成" : "签到失败")).slice(0, 400),
            { channel: acc.channel, target: acc.name || acc.uid || acc.id, detail: r && r.error ? String(r.error).slice(0, 400) : "" });
        }
        // 今日签到记录落库（号池行内按钮三态 + 详情弹窗的数据源）；status 是纯读取，不记
        if (useAct !== "status") {
          try { store.noteCheckin(acc.id, r, useAct); } catch { /* 记录失败不影响签到本身 */ }
        }
        // 签到成功（且不是幂等/不可用）后顺手刷新余额，让号池立刻看到新积分
        if (useAct !== "status" && r.ok && !r.unavailable && !r.already) {
          credits.refreshAccount(acc.id).catch(() => {});
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: false, message: msg });
        if (useAct !== "status") {
          oplog.log("error", "签到", msg.slice(0, 400), { channel: acc.channel, target: acc.name || acc.uid || acc.id });
        }
        if (useAct !== "status") {
          try { store.noteCheckin(acc.id, { ok: false, message: msg }, useAct); } catch { /* 忽略 */ }
        }
      }
    }
    const okCount = rows.filter((r) => r.ok).length;
    // 只有真正改了状态的 checkin/trial 才广播：status 是纯读取。广播它会让「收到 credits 就刷新」
    // 的号池页被自己触发的刷新再次唤醒，形成约 1.2 秒一轮的自激刷新循环（每轮还白打一次上游接口）
    if (act !== "status") events.emit({ type: "credits" });
    // 渠道可声明「领取窗口未开」（Qoder 每日 Credits 10:00 UTC+8 重置）：
    // 聚合最晚的重试时刻，供 checkinAutoTick 延后当天的自动签到
    const deferredRetryAt = rows.reduce((n, x) => Math.max(n, (x && x.deferred && Number(x.retryAt)) || 0), 0);
    return { ok: true, action: act, total: rows.length, okCount, rows, ...(deferredRetryAt ? { deferredRetryAt } : {}) };
  } finally {
    if (act !== "status") checkinBusy = false;
  }
}

// ===== 定时自动签到：按渠道各自的规则跑（号池页每渠道设时间与抖动；默认全关） =====
// setInterval 常驻、tick 动态读配置——开关/时间改完即生效，无需重启；当天已跑过不重跑。
// 重启应用后当天会再跑一次：签到/加油包都是幂等语义（already 不算失败），无害
let checkinTimer = null;
// 渠道 → 已自动完成的日期（YYYY-MM-DD）；窗口未开/被其它签到占用的渠道不落标记，留给下轮 tick
let lastAutoCheckinDay = {};
// 渠道 → deferred 延后重试时刻：窗口开放前 60s tick 直接跳过，且不标记当天已完成——否则
// 一天一次的语义会永久错过当日窗口（Qoder 每日 Credits 10:00 UTC+8 重置）
let autoDeferredUntil = {};
// 各渠道串行跑的运行标志：checkinBatch 有全局互斥，并行发起会让后一个渠道直接被拒
let autoRunning = false;

/** 抖动偏移（毫秒）：同一天同一渠道确定性伪随机（FNV-1a），跨天重算——
 *  到点后随机延迟 0~jitterMin 分钟执行，避免所有用户整点同时打上游 */
function checkinJitterOffset(day, channel, jitterMin) {
  const j = Math.max(0, Math.min(180, Math.round(Number(jitterMin) || 0)));
  if (!j) return 0;
  let h = 2166136261;
  const s = `${day}|${channel}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % (j * 60000 + 1);
}

/** 某渠道在某日历日的计划执行时刻（该日 HH:mm + 该日该渠道的确定性抖动），毫秒时间戳 */
function checkinPlannedAt(day, channel, rule) {
  const [Y, M, D] = String(day).split("-").map(Number);
  const [h, m] = String((rule && rule.time) || "09:00").split(":").map((x) => Number(x) || 0);
  const d = new Date(Y || 1970, (M || 1) - 1, D || 1, h, m, 0, 0);
  return d.getTime() + checkinJitterOffset(day, channel, rule && rule.jitterMin);
}

/**
 * 判定渠道当前的待执行计划实例（tick 与自测共用）：
 *   返回 "" = 无（未启用 / 今天已完成 / 延后窗口未到 / 未到期）
 *   返回 day = 执行今天的实例（优先；一天只跑一次，不补历史欠账）
 *   返回 prevDay = 执行昨天被抖动推到今天凌晨的实例（如 23:30 + 180 分钟 → 次日 01:30）。
 *     只按"今天"算会让靠近午夜的配置在跨天瞬间把当天计划整个跳过（次日又重算 → 天天不跑）；
 *     但仅接续「确实跨午夜且未执行」的昨日实例，未跨天的昨日欠账不补
 */
function checkinDueKey(now, day, prevDay, channel, rule, lastKey, deferredUntil) {
  if (!rule || !rule.enabled) return "";
  if (lastKey === day) return "";
  if (now < (Number(deferredUntil) || 0)) return "";
  if (now >= checkinPlannedAt(day, channel, rule)) return day;
  const midnightToday = new Date(now);
  midnightToday.setHours(0, 0, 0, 0);
  const prevPlanned = checkinPlannedAt(prevDay, channel, rule);
  if (lastKey !== prevDay && prevPlanned >= midnightToday.getTime() && now >= prevPlanned) return prevDay;
  return "";
}

function checkinAutoTick() {
  try {
    const cfg = settings();
    // 唤醒守卫（见 backend/wakeGuard.cjs）：
    //   B. 先做时间跳跃检测——不依赖电源事件的兜底：睡眠期间定时器被冻结，
    //      唤醒后本轮间隔远大于 60s，推定刚唤醒并置静默窗（必须**先于** A/C 判定调用）
    //   A. 唤醒后 15 秒静默窗内不启动签到——否则一醒就开跑，与 Chromium 会话/GPU 恢复叠加
    //   C. 还要求「应用已连续唤醒 ≥ 30 秒」——签到批量本身持续 20~30 秒且带抖动，
    //      静默窗一过就开跑仍会压在用户刚开始操作的时刻上
    // ⚠ 守卫不通过时**不能**落当天标记：直接 return 让下一轮 tick 自然重试，
    //   否则当天签到会被永久跳过（标记只在真正发起该渠道签到前落）
    wakeGuard.noteTick("checkin-auto", CHECKIN_TICK_MS);
    if (!wakeGuard.checkinAllowed()) return;
    const rules = cfg.checkinAutoRules || {};
    const now = new Date();
    const day = store.dayStr(now.getTime());
    const prevDay = store.dayStr(now.getTime() - 86400000);
    const due = [];
    for (const [channel, rule] of Object.entries(rules)) {
      // 关闭的渠道不签（上游启闭：调用类操作对它一律不存在）
      if (!channelOn(channel)) continue;
      const dueKey = checkinDueKey(now.getTime(), day, prevDay, channel, rule, lastAutoCheckinDay[channel], autoDeferredUntil[channel]);
      if (dueKey) due.push({ channel, dueKey });
    }
    if (!due.length || autoRunning) return;
    autoRunning = true;
    void (async () => {
      try {
        for (const { channel, dueKey } of due) {
          if (Date.now() < (autoDeferredUntil[channel] || 0)) continue;
          lastAutoCheckinDay[channel] = dueKey;
          let res = null;
          try {
            res = await checkinBatch({ channel, action: "checkin" });
          } catch { /* 异常留待下一轮 tick 重试 */ }
          // 被其它签到占着（手动在跑）或异常：撤销当天标记，下一轮 tick 自然重试
          if (!res || res.ok === false) {
            lastAutoCheckinDay[channel] = "";
            continue;
          }
          // 自动签到触发记录（明细每账号一条已在 checkinBatch 里落，这里补触发上下文一条）
          oplog.log("info", "自动签到", `定时触发 · 成功 ${res.okCount}/${res.total}`, { channel });
          // deferred：撤销当天标记并记录重试时刻——60s tick 到点自会重跑并真正完成签到
          if (res.deferredRetryAt && res.deferredRetryAt > Date.now()) {
            lastAutoCheckinDay[channel] = "";
            // 延后只在当天内生效：retryAt 一旦落在明天及以后（远期活动实例/字段异常），
            // 窗口交由次日的例行签到重新评估——不让一个渠道的 deferred 停摆它自己好几天
            const endOfDay = new Date(now);
            endOfDay.setHours(24, 0, 0, 0);
            autoDeferredUntil[channel] = Math.min(res.deferredRetryAt, endOfDay.getTime());
          }
        }
      } finally {
        autoRunning = false;
      }
    })();
  } catch {
    /* 配置读取失败下轮再试 */
  }
}
function startCheckinAuto() {
  stopCheckinAuto();
  checkinTimer = setInterval(checkinAutoTick, CHECKIN_TICK_MS);
}
function stopCheckinAuto() {
  if (checkinTimer) clearInterval(checkinTimer);
  checkinTimer = null;
}

/** 启动装配：规则热加载初始化 + 数据库 + 定时额度刷新（号池管家不再启动任何监听服务） */
async function boot() {
  if (booted) return;
  booted = true;
  rules.init();
  store.open();
  // 存量迁移（deviceMid 撞车自愈启动闸）：历史版本会给「导入时是本机登录态」的账号继承
  // 同一枚 live 指纹（adopt 陷阱），多号共用一枚指纹 = 一号领取全组 1004。
  // 启动时静默跑一次修复，只动撞车/被烧的账号，正常账号零影响（幂等）
  try {
    const zs = require("./zcodeSwitch.cjs");
    const ds = zs.deviceStatus();
    if (ds.rows.some((r) => r.conflictWith.length || r.burnedLikely || !r.deviceMid)) {
      zs.repairDeviceMid({});
    }
  } catch { /* 迁移失败不阻断启动，号池页仍可手动修复 */ }
  credits.startScheduler(() => settings().creditsRefreshMin);
  startCheckinAuto();
  poolsched.start(); // 号池定时同步（issue #89/#92）：hourly/daily 周期触发，全关时空转
  // 远程锚定指纹（remoteMid）的云端兜底：本机 anchor 缺锚（重装/换机）先从 WebDAV 拉回；
  // 有锚则顺手上传一份（内容 hash 记账，未变不重传）。fire-and-forget，WebDAV 未配置/网络
  // 失败一律静默——锚定的主事实在本机 anchor 文件里，云端只是防丢副本
  try {
    const ps = require("./poolsync.cjs");
    const zl = require("./zcodeLocal.cjs");
    void (async () => {
      const st = zl.remoteMidState();
      if (!st.anchorMid) await ps.restoreAnchorMidFromRemote();
      await ps.backupAnchorMid();
    })().catch(() => {});
  } catch { /* WebDAV 不可用不影响启动 */ }
}

/** 停掉本模块持有的全部定时设施与在途流程（额度刷新 / 自动签到 / 号池同步 / 在途 OAuth） */
function stopTimers() {
  credits.stopScheduler();
  stopCheckinAuto();
  poolsched.stop();
  discovery.cancelOAuth();
}

function shutdown() {
  stopTimers();
  // 出口连接池随进程一起收：不关会让退出前的 close 等待 keep-alive 连接超时
  netproxy.closeAll();
}

/**
 * 模块开关（issue #91）运行时启停。
 * 开：从未装配过（启动时模块被关）→ 完整 boot；装配过 → 只重启各定时设施。
 * 关：停定时器并关库（各 store 函数入口都惰性 open，随时可重开）。
 * 不动 booted 装配闸与 rules 监听：重启应用后由启动短路决定是否装配，
 * 会话内反复开关不做全量拆卸/重建，避免 chokidar 重复挂监听。
 */
function setRuntime(on) {
  if (on) {
    if (!booted) return boot();
    credits.startScheduler(() => settings().creditsRefreshMin);
    startCheckinAuto();
    poolsched.start();
    events.emit({ type: "status" });
    return Promise.resolve();
  }
  credits.stopScheduler();
  stopCheckinAuto();
  poolsched.stop();
  discovery.cancelOAuth();
  try { poolsync.cancel(); } catch { /* 在途号池同步一并收尾，符合「停用后不运行」承诺 */ }
  try { store.close(); } catch { /* 关闭失败无碍，句柄随进程退出 */ }
  events.emit({ type: "status" }); // 侧栏号池卡片立即回到已停用态，不等下一次轮询
  return Promise.resolve();
}

// ===== IPC =====

function ok(data) {
  return { ok: true, ...data };
}
function fail(message) {
  return { ok: false, message: String((message && message.message) || message) };
}
function handle(fn) {
  return async (_event, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return fail(e);
    }
  };
}

// 本机 agent 当前登录态速查（渠道 → uid）：读几个本地 JSON/信封，10s TTL 缓存，
// 号池轮询频率高，不能每次都全量重扫五个客户端的登录文件
let localLoginsCache = { at: 0, map: {} };
function currentLocalLogins() {
  const now = Date.now();
  if (now - localLoginsCache.at < 10000) return localLoginsCache.map;
  let map = {};
  try {
    map = discovery.currentLocalLogins() || {};
  } catch { /* 探测失败按「无本机登录」处理，徽标只是提示性信息 */ }
  localLoginsCache = { at: now, map };
  return map;
}

/**
 * OAuth 内嵌授权窗（商汤小浣熊专用）：授权页开在我们自己的沙箱 BrowserWindow 里，
 * 登录收尾时页面会跳 office-raccoon://auth/callback?code=xxx 深链——在本窗内截获该地址
 * （will-navigate 拦截 + windowOpen 拦截 + 加载失败兜底三路），授权码只进 AgentHub：
 * 不进系统浏览器、不拉起官方客户端，官方客户端因此拿不到也消费不掉这个一次性授权码。
 * 一次性 in-memory session：多账号连登时上一个账号的网页登录态不残留，每次都从零开始登录。
 */
function openAuthWindow(opts) {
  const { BrowserWindow } = require("electron");
  let win;
  try {
    win = new BrowserWindow({
      width: 460,
      height: 720,
      show: false,
      center: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      title: String(opts.title || "授权登录"),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: `oauth-${Date.now()}`,
      },
    });
  } catch (e) {
    return { ok: false, message: `授权窗口创建失败：${(e && e.message) || e}` };
  }
  let fired = false;
  const capture = (url) => {
    if (fired || !/^office-raccoon:\/\//i.test(String(url || ""))) return;
    fired = true;
    try { opts.onCaptured(String(url)); } catch { /* 回调内部自管成败 */ }
  };
  const isAuthPage = (u) => /^https?:\/\//i.test(String(u || ""));
  // 网络层首道闸门：拦截 office-raccoon:// 请求并直接 cancel，绝对不向宿主操作系统派发（防止唤醒小浣熊客户端造成切号顶号）
  try {
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["office-raccoon://*"] }, (details, callback) => {
      capture(details.url);
      callback({ cancel: true });
    });
  } catch { /* 容错 */ }
  // 新开窗（含 target=_blank / window.open）：深链接管捕获，其余一律交系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^office-raccoon:\/\//i.test(url)) capture(url);
    else if (isAuthPage(url)) platform.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => {
    if (/^office-raccoon:\/\//i.test(url)) {
      ev.preventDefault();
      capture(url);
    }
  });
  win.webContents.on("will-redirect", (ev, url) => {
    if (/^office-raccoon:\/\//i.test(url)) {
      ev.preventDefault();
      capture(url);
    }
  });
  win.webContents.on("did-fail-load", (_ev, code, _desc, validatedURL) => {
    // 某些 Electron 版本不派发深链 will-navigate：导航失败（未知协议）时从出错地址回捞
    capture(validatedURL);
  });
  win.on("closed", () => {
    try { opts.onClosed(); } catch { /* 已收尾 */ }
  });
  win.once("ready-to-show", () => {
    try { win.show(); win.focus(); } catch { /* 已关 */ }
  });
  win.loadURL(String(opts.url)).catch((e) => {
    // 主文档加载失败（断网/被拦）：如实报错后关窗，走失败收尾
    if (!win.isDestroyed()) win.webContents.executeJavaScript(`document.title=${JSON.stringify(`加载失败：${String((e && e.message) || e)}`)}`).catch(() => {});
  });
  return {
    ok: true,
    close: () => {
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* 已关 */ }
    },
    // ===== Cookie 采集（ModelScope 专用；见 discovery.beginModelScopeOAuth）=====
    // 为什么需要：魔搭的点赞与「每日登录(daily_active)」只在 **Web 会话(Cookie)** 下生效，
    // OAuth/ms- 令牌调用该族端点会被拒（401 oauth token is not supported）或不计日活。
    // 授权窗用独立 partition，登录后 Cookie 落在该 partition 的 jar 里，可直接读走——
    // 这样用户仍然「只点一次授权」，却拿到了会话凭据。
    collectCookie: async (domains) => {
      try {
        const sess = win.webContents.session;
        const all = await sess.cookies.get({});
        const allow = (domains && domains.length ? domains : ["modelscope.cn"]);
        const hit = all.filter((c) => allow.some((d) => String(c.domain || "").replace(/^\./, "").endsWith(d)));
        if (!hit.length) return "";
        // 整组拼接：魔搭登录态由多个 cookie 共同构成（m_session_id / csrf_token / _tb_token_ 等），
        // 只挑一个会失效——实测必须整组发送
        return hit.map((c) => `${c.name}=${c.value}`).join("; ");
      } catch {
        return "";
      }
    },
  };
}

/** 号池全量视图：五渠道聚合 + 账号明细 + 调度策略（号池页数据源） */
function poolView(opts) {
  const all = !!(opts && opts.all); // 弹窗需要全量（含已关闭渠道，带开关），页面视图默认只出启用的
  const agents = store.listAgents();
  const localLogins = currentLocalLogins();
  const channelEnabled = settings().channelEnabled || {};
  const checkinRules = settings().checkinAutoRules || {};
  const now = Date.now();
  // 阈值随设置热生效（无需重启网关）：每次出号池视图前对齐一次（廉价的模块级 setter）。
  // poolSummary 的账号级 expiringSoon 与逐包用的是同一个值，改设置两处一起变。
  pool.setExpiringSoonDays(settings().expiringSoonDays);
  // 逐包一次全量读出再分桶：每账号一次查是 N+1（200 账号实测 15ms 上下，方差大）。
  // store.cjs 的 listKeys() 统计每把 Key 的今日用量走的也是「一次全量 + Map join」同一形态
  const packagesByAccount = store.listAllCreditPackages();
  return store.CHANNELS.filter((c) => all || channelOn(c.id)).map((c) => {
    const summary = pool.poolSummary(c.id);
    const localUid = String((localLogins[c.id] && localLogins[c.id].uid) || "");
    const accounts = pool.poolAccounts(c.id).map((a) => ({
      ...a,
      modelCool: pool.accountModelCool(a.id),
      // 逐包明细：时间态（expired/expiringSoon）每次出视图重算，不落库
      packages: pool.decoratePackageStates(packagesByAccount.get(a.id) || [], now),
      // 当前电脑上的 agent 客户端登录的就是这个账号（按本机登录态 uid 比对）
      liveHere: !!(localUid && a.uid && String(a.uid) === localUid),
    }));
    const agent = agents.find((a) => a.id === c.id) || {};
    const rule = checkinRules[c.id];
    return {
      ...c,
      // 成本档：库内值优先（用户可能改过），空值回落 CHANNELS 种子默认
      costTier: agent.costTier || c.costTier || "",
      poolStrategy: agent.poolStrategy || "expire_first",
      // 按渠道自动签到规则（号池页工具栏「自动签到」设置按钮的读源；写走 proxy_checkin_auto_set）
      checkinAuto: { enabled: !!(rule && rule.enabled), time: (rule && rule.time) || "09:00", jitterMin: Number((rule && rule.jitterMin) || 0) },
      // 渠道启闭（「上游启闭」弹窗）：缺省 = 启用
      enabled: channelOn(c.id),
      summary,
      accounts,
      // 号池管家不再有转发链路，渠道降级状态恒为正常（字段保留，前端契约不变）
      health: null,
    };
  });
}

/** 号池总览：各渠道余额聚合（总览页与侧栏卡片的单一数据源）。
 *  原 gatewayStatus 里的运行状态/端口/Key 数/今日请求等转发指标随转发服务一并下线。 */
function poolOverview() {
  const channels = store.CHANNELS.filter((c) => channelOn(c.id)).map((c) => ({
    id: c.id,
    display: c.display,
    ...pool.poolSummary(c.id),
  }));
  return {
    channels,
    channelCount: channels.length,
    accountCount: channels.reduce((s, c) => s + c.accountCount, 0),
    onlineCount: channels.reduce((s, c) => s + c.onlineCount, 0),
    expiringSoonCount: channels.filter((c) => c.expiringSoon).length,
    vaultOk: vaultOk(),
    dbDriver: store.driver(),
  };
}

function vaultOk() {
  try {
    const ss = require("electron").safeStorage;
    return !!(ss && ss.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/** 号池总览（侧栏卡片 / 总览页数据源）：转发服务下线后不再有运行状态与端口 */
function register(ipcMain) {
  // 请求流水保留期从设置灌入号池存储模块：gc() 只在 open()（首次摸库）时跑，register 先行不踩空。
  store.setUsageRetention(settings().usageRetentionDays);
  // ===== 号池状态 =====
  ipcMain.handle("proxy_status", handle(() => poolOverview()));

  // ===== 号池 =====
  ipcMain.handle("proxy_pool", handle(() => poolView()));
  // 渠道启闭（「上游启闭」弹窗）：list = 全量含已关闭渠道（弹窗数据源，带 enabled）；
  // toggle = 写整体配置 proxy.channelEnabled + 广播 status 事件，各页面事件刷新即动态显隐
  ipcMain.handle("proxy_channel_list", handle(() => poolView({ all: true })));
  ipcMain.handle("proxy_channel_toggle", handle(({ channel, enabled }) => {
    if (!store.CHANNELS.some((c) => c.id === channel)) return fail("渠道不存在");
    try {
      const cfg = config.loadConfig();
      const map = { ...(cfg.proxy.channelEnabled || {}) };
      // 配置只落显式 false（缺省 = 启用），不写 true 冗余键，配置文件保持干净
      if (enabled === false) map[channel] = false;
      else delete map[channel];
      cfg.proxy.channelEnabled = map;
      config.saveConfig(cfg);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
    oplog.log("info", "网关配置", `${store.channelDisplay(channel)} ${enabled === false ? "已关闭" : "已启用"}（上游启闭）`, { channel });
    events.emit({ type: "status" });
    return ok({ channel, enabled: enabled !== false });
  }));
  ipcMain.handle("proxy_pool_strategy", handle(({ channel, strategy }) => {
    if (!store.setPoolStrategy(channel, strategy)) return fail("不支持的调度策略");
    oplog.log("info", "网关配置", `${store.channelDisplay(channel)} 调度策略改为 ${strategy}`, { channel });
    return ok({});
  }));
  ipcMain.handle("proxy_pool_tier", handle(({ channel, tier }) => {
    if (!store.setAgentCostTier(channel, tier)) return fail("不支持的成本档位");
    oplog.log("info", "网关配置", `${store.channelDisplay(channel)} 成本档位改为 ${tier || "未标注"}`, { channel });
    return ok({});
  }));
  // 手动粘贴（三途径之一）；token 仅本地加密存储
  ipcMain.handle("proxy_account_add", handle(({ channel, name, token, refreshToken, uid }) => {
    if (!adapters.get(channel)) return fail("未知渠道");
    if (!String(token || "").trim()) return fail("请粘贴 token / JWT");
    // ModelScope（魔搭）：凭据形态与其它渠道不同（ms- 访问令牌，非 JWT），且必须先校验
    // 令牌有效性、并用真实用户名作 uid（否则号池去重失效、credit_first 排序错乱）。
    // 故走专用导入路径，不做 JWT 解码。
    if (channel === "modelscope") {
      return discovery.importModelScopeToken(String(token).trim()).then((r) => {
        if (!r.ok) return fail(r.message);
        credits.refreshAccount(r.id).catch(() => {});
        // 入池即跑一次每日任务（登录 200/绑云 50 自动 + 点赞补足）——与 OAuth 路径行为对齐
        checkinBatch({ accountId: r.id, action: "checkin" }).catch(() => {});
        return ok({ id: r.id, uid: r.uid, updated: r.updated, message: r.message });
      }).catch((e) => fail(String((e && e.message) || e)));
    }
    const clean = String(token).trim().replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
    const dec = util.jwtDecode(clean);
    const id = store.addAccount({
      channel,
      uid: String(uid || dec.uid || ""),
      name: String(name || "").trim() || (dec.uid ? `账号 ${dec.uid.slice(-6)}` : "手动添加"),
      token: clean,
      refreshToken: String(refreshToken || "").trim(),
      source: "paste",
    });
    credits.refreshAccount(id).catch(() => {}); // 入池即查一次额度（失败不阻塞）
    oplog.log("info", "号池账号", `手动添加 ${store.channelDisplay(channel)} 账号（uid ${String(uid || dec.uid || "-")}）`, { channel });
    return ok({ id });
  }));
  ipcMain.handle("proxy_account_remove", handle(({ id }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    // 先写墓碑再删本机：删除要经 WebDAV 传播到其他设备（号池同步拉取时按墓碑移除）
    poolsync.noteRemoved(poolsync.accountKeyOf(acc));
    if (!store.removeAccount(id)) return fail("账号不存在");
    // CatPaw 会话注册表挂点（对齐 W5 接线要求）：账号删除后其会话记录残留
    // （2h TTL），工具续接窗口内其他账号的请求可把 tool 结果提交到已消失账号的 conversation
    try { require("./catpaw/registry.cjs").registry.clearAccount(id); } catch { /* 无会话不影响删除 */ }
    oplog.log("info", "号池账号", `移除 ${store.channelDisplay(acc.channel)} 账号「${acc.name}」`, { channel: acc.channel, target: acc.name });
    return ok({});
  }));
  // 批量删除（号池列表多选）：逐个走与单删相同的链路（墓碑先行 + CatPaw 会话清理），oplog 只记汇总一条
  ipcMain.handle("proxy_account_remove_batch", handle(({ ids }) => {
    const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!list.length) return fail("未选择账号");
    let removed = 0;
    let missing = 0;
    for (const id of list) {
      const acc = store.getAccount(id);
      if (!acc) { missing++; continue; }
      poolsync.noteRemoved(poolsync.accountKeyOf(acc));
      if (store.removeAccount(id)) removed++;
      try { require("./catpaw/registry.cjs").registry.clearAccount(id); } catch { /* 无会话不影响删除 */ }
    }
    if (removed) oplog.log("info", "号池账号", `批量删除 ${removed} 个账号（选择 ${list.length} 个${missing ? `，${missing} 个已不存在` : ""}）`, {});
    return ok({ removed, missing });
  }));
  // 明文导出选中账号（号池多选 →「导出凭据」）：与元数据导出（format=agenthub-accounts，
  // 故意不含 token）语义不同——这里带**解密后的明文凭据**，供用户在其它软件里直接使用。
  // 落盘由渲染层用 Blob 触发下载（与旧导出同一条链路），主进程只做解密与组装。
  ipcMain.handle("proxy_account_export_plain", handle(({ ids }) => {
    const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!list.length) return fail("未选择账号");
    const views = new Map(store.listAccounts().map((v) => [v.id, v]));
    const accounts = [];
    const missing = [];
    for (const id of list) {
      const view = views.get(id);
      const row = view ? store.getAccount(id) : null;
      if (!view || !row) { missing.push(id); continue; }
      const secrets = store.accountSecrets(row);
      accounts.push({
        // 字段名与「粘贴 JSON 导入」的容忍表对齐：导出的文件可以直接再灌回号池
        channel: view.channel,
        uid: view.uid || "",
        name: view.name || "",
        note: view.note || "",
        token: secrets.token || "",
        refreshToken: secrets.refreshToken || "",
        // access token 的 JWT 到期（ms，解不出为 0）：外部软件据此判断还能不能用
        tokenExp: Number(util.jwtDecode(secrets.token).exp || 0) * 1000,
        expiresAt: view.expiresAt || 0,
        credits: view.credits || 0,
        status: view.status,
        source: view.source || "",
        createdAt: view.createdAt || 0,
        updatedAt: view.updatedAt || 0,
        // 切号快照等敏感元数据在这里一并解为明文：zcode 的 sw 是 DPAPI 密文，
        // 带着密文导出到别的机器/软件等于没带（与同步快照共用同一份明文实现）
        meta: poolsync.prepareMetaForExport(secrets.meta, view.channel),
      });
    }
    if (!accounts.length) return fail("选中账号都已不存在");
    // 只记条数与账号名，不记凭据本身（oplog 落库前另有一道脱敏，这里不依赖它）
    oplog.log("warn", "号池账号", `导出 ${accounts.length} 个账号的明文凭据（供外部软件使用）`, {
      channel: accounts[0].channel,
      detail: accounts.map((a) => a.name || a.uid).join(", ").slice(0, 200),
    });
    return ok({ accounts, missing, exportedAt: Date.now() });
  }));
  ipcMain.handle("proxy_account_toggle", handle(({ id, enabled }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    store.updateAccount(id, enabled
      ? { status: "online", coolUntil: 0, coolReason: "" }
      : { status: "disabled" });
    // 停用同样作废该账号名下的 CatPaw 会话（不再参与调度但记录残留，同上）
    if (!enabled) {
      try { require("./catpaw/registry.cjs").registry.clearAccount(id); } catch { /* 无会话不影响停用 */ }
    }
    oplog.log("info", "号池账号", `${enabled ? "启用" : "停用"} ${store.channelDisplay(acc.channel)} 账号「${acc.name}」`, { channel: acc.channel, target: acc.name });
    return ok({});
  }));
  // 重命名账号（自定义备注）：改 name 字段，WebDAV 同步时 LWW 传播到其他设备
  ipcMain.handle("proxy_account_rename", handle(({ id, name }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    store.updateAccount(id, { name: String(name || "").trim() });
    oplog.log("info", "号池账号", `重命名「${acc.name}」为「${String(name || "").trim()}」`, { channel: acc.channel, target: acc.name });
    return ok({});
  }));
  // 账号备注（号池列表「备注」弹窗）：落 meta.note，随 exportPool 快照导出 + 备注新者胜传播
  ipcMain.handle("proxy_account_note", handle(({ id, note }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    if (!store.noteAccount(id, note)) return fail("账号不存在");
    const text = String(note || "").trim();
    oplog.log("info", "号池账号", `${text ? "设置备注" : "清除备注"}「${acc.name}」${text ? `：${text.slice(0, 50)}${text.length > 50 ? "…" : ""}` : ""}`, { channel: acc.channel, target: acc.name });
    return ok({});
  }));
  // 手动解除冷却：cooling 账号立即回 online，同时豁免该账号的模型级负缓存
  ipcMain.handle("proxy_account_cool_off", handle(({ id }) => {
    const r = pool.releaseCool(String(id || ""));
    if (r.ok) {
      const acc = store.getAccount(id);
      oplog.log("info", "冷却与风控", `解除冷却${acc ? `「${acc.name}」` : ""}${r.releasedModels ? `（含 ${r.releasedModels} 条模型级负缓存）` : ""}`, { target: acc && acc.name });
    }
    return r.ok ? ok({ releasedModels: r.releasedModels }) : fail(r.message);
  }));
  ipcMain.handle("proxy_account_refresh", handle(({ id }) => credits.refreshAccount(id)));
  ipcMain.handle("proxy_credits_refresh", handle(() => credits.refreshAll()));
  // 号池页右上角「刷新当前渠道」：只刷一个编译器的号池额度
  ipcMain.handle("proxy_credits_refresh_channel", handle(({ channel }) => {
    if (!channel) return fail("缺少渠道参数");
    return credits.refreshChannel(String(channel));
  }));

    // ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包 / ZCode 领取奖励，实测端点） =====
  // 批量签到动作见模块级 checkinBatch（手动 IPC 与定时自动签到共用）；
  // 手动发起 interactive=true——zcode 领取需要人机校验时允许弹官方 SDK 验证窗
  ipcMain.handle("proxy_checkin_status", handle(({ channel, accountId }) => checkinBatch({ channel, accountId, action: "status" })));
  ipcMain.handle("proxy_checkin_run", handle(({ channel, accountId, action }) => checkinBatch({ channel, accountId, action: action || "checkin", interactive: true })));
  // 按渠道设置自动签到（号池页「自动签到」弹窗）：写整体配置的 proxy.checkinAutoRules，
  // tick 每 60s 动态读盘，保存即生效；读源在 proxy_pool 的渠道视图（checkinAuto 字段）
  ipcMain.handle("proxy_checkin_auto_set", handle(({ channel, enabled, time, jitterMin }) => {
    if (!store.CHANNELS.some((c) => c.id === channel)) return fail("渠道不存在");
    const cfg = config.loadConfig();
    const rules = { ...(cfg.proxy.checkinAutoRules || {}) };
    rules[channel] = { enabled: !!enabled, time: config.normalizeHm(time), jitterMin: config.normalizeJitter(jitterMin) };
    cfg.proxy.checkinAutoRules = rules;
    config.saveConfig(cfg);
    oplog.log("info", "网关配置", `${store.channelDisplay(channel)} 自动签到改为${enabled ? `每天 ${config.normalizeHm(time)}${Number(jitterMin) ? `（抖动 ${Number(jitterMin)} 分钟）` : ""}` : "关闭"}`, { channel });
    return ok({ channel, ...rules[channel] });
  }));

  // ===== 凭据接入：本机软件导入 =====
  ipcMain.handle("proxy_scan", handle(() => {
    const found = discovery.scanAll();
    const existing = store.listAccounts();
    return found.map((c) => ({
      ...c,
      token: "", // 凭据不出主进程：导入时按候选标识回读
      refreshToken: "",
      imported: !!(c.uid && existing.some((a) => a.channel === c.channel && a.uid === c.uid)),
    }));
  }));
  // 导入本机候选：index 指向 proxy_scan 返回的数组下标；
  // 同时带上 channel/file 做一次身份核对 —— 两次扫描之间文件可能增减，只认下标会导错账号
  ipcMain.handle("proxy_scan_import", handle(({ index, channel, file, uid }) => {
    const found = discovery.scanAll();
    let c = found[Number(index)];
    if (file || uid) {
      // 身份核对：以 file/uid 为准回查，防止两次扫描之间候选增减导致按下标导错账号
      const hit = found.find((x) => (file && x.file === file) || (uid && x.uid === uid && (!channel || x.channel === channel)));
      if (!hit) return fail("候选已变化（本地登录态可能刚被更新），请重新扫描后再导入");
      c = hit;
    }
    if (!c) return fail("候选不存在，请重新扫描");
    const r = discovery.importCandidate(c, channel || undefined);
    credits.refreshAccount(r.id).catch(() => {});
    return ok({ id: r.id, updated: r.updated });
  }));
  ipcMain.handle("proxy_oauth_begin", handle(async ({ channel, captchaVerifyParam, vendor }) => {
    const ch = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const r = await discovery.beginOAuth(ch, (result) => {
      if (result.ok) {
        credits.refreshAccount(result.id).catch(() => {});
        // 登录后自动签到一次（自动签到 + 查积分）
        checkinBatch({ accountId: result.id, action: "checkin" }).catch(() => {});
      }
      oplog.log(result.ok ? "info" : "error", "OAuth 登录", result.ok ? `${store.channelDisplay(ch)} 授权登录成功` : result.message || `${store.channelDisplay(ch)} 授权登录失败`, { channel: ch });
      events.emit({ type: "oauth-done", channel: ch, ...result });
    }, { openAuthWindow }, { captchaVerifyParam, vendor });
    // 带授权地址的渠道在系统浏览器打开（小浣熊走内嵌授权窗，不回 url——深链回调绝不能进浏览器
    // 再被系统交给官方客户端：授权码是一次性的，官方客户端消费掉 AgentHub 就永远收不到回调）
    if (r.ok && r.url) await platform.openExternal(r.url);
    // port 一并回传：AutoClaw 国际版回环登录会占用 z.ai 登记的白名单端口，前端展示/排障需要它；
    // userCode 一并回传：Cline 设备授权要显示「用户码」供手动输码（verification_uri_complete
    // 已带码，但用户改用普通授权页时仍需要这串码）
    return r.ok ? ok({ url: r.url, mode: r.mode, port: r.port, userCode: r.userCode }) : fail(r.message);
  }));
  ipcMain.handle("proxy_oauth_cancel", handle(() => ok({ cancelled: discovery.cancelOAuth() })));
  // ===== AutoClaw 登录辅助：国内版手机验证码两跳 + 国际版风控配置（验证码由前端跑 SDK）=====
  ipcMain.handle("proxy_autoclaw_sms_send", handle(async ({ channel, phone }) => {
    const ch = String(channel || "autoclaw");
    if (!adapters.get(ch)) return fail(`未知渠道 ${ch}`);
    const login = require("./autoclaw/login.cjs");
    const r = await login.sendSmsCode({ cfg: (rules.get("headers.json") || {})[ch] || {}, httpJson: adapters.httpJson, phone });
    if (r.ok) oplog.log("info", "AutoClaw 发码", `${store.channelDisplay(ch)} 验证码已发送（${r.phoneTail || r.phone}）`, { channel: ch });
    return r.ok ? ok(r) : fail(r.message);
  }));
  ipcMain.handle("proxy_autoclaw_sms_login", handle(async ({ channel, phone, code, deviceId }) => {
    const ch = String(channel || "autoclaw");
    if (!adapters.get(ch)) return fail(`未知渠道 ${ch}`);
    const login = require("./autoclaw/login.cjs");
    const r = await login.smsLogin({ cfg: (rules.get("headers.json") || {})[ch] || {}, httpJson: adapters.httpJson, phone, code, deviceId });
    if (!r.ok) return fail(r.message);
    try {
      const saved = await discovery.saveAutoclawAccount(ch, r, r.deviceId);
      credits.refreshAccount(saved.id).catch(() => {});
      checkinBatch({ accountId: saved.id, action: "checkin" }).catch(() => {});
      oplog.log("info", "AutoClaw 登录", `${store.channelDisplay(ch)} 短信登录成功`, { channel: ch });
      events.emit({ type: "oauth-done", channel: ch, ok: true, id: saved.id, uid: saved.uid });
      return ok({ id: saved.id, uid: saved.uid, updated: saved.updated });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  }));
  ipcMain.handle("proxy_autoclaw_captcha_config", handle(async ({ channel }) => {
    const ch = String(channel || "autoclaw_intl");
    if (!adapters.get(ch)) return fail(`未知渠道 ${ch}`);
    const login = require("./autoclaw/login.cjs");
    const r = await login.oauthCaptchaConfig({ cfg: (rules.get("headers.json") || {})[ch] || {}, httpJson: adapters.httpJson });
    return r.ok ? ok(r) : fail(r.message);
  }));
  // ===== Loomy（讯飞）登录辅助：手机验证码两跳（账号域 HMAC-SHA1 签名，见 loomy/login.cjs）=====
  ipcMain.handle("proxy_loomy_sms_send", handle(async ({ phone }) => {
    if (!adapters.get("loomy")) return fail("未知渠道 loomy");
    try {
      const r = await discovery.loomySendCode(phone);
      oplog.log("info", "Loomy 发码", `验证码已发送（${r.phoneTail || ""}）`, { channel: "loomy" });
      return ok(r);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  }));
  ipcMain.handle("proxy_loomy_sms_login", handle(async ({ phone, code, msgid }) => {
    if (!adapters.get("loomy")) return fail("未知渠道 loomy");
    try {
      const saved = await discovery.loomyLoginWithCode(phone, code, msgid);
      credits.refreshAccount(saved.id).catch(() => {});
      checkinBatch({ accountId: saved.id, action: "checkin" }).catch(() => {});
      oplog.log("info", "Loomy 登录", "短信登录成功", { channel: "loomy" });
      events.emit({ type: "oauth-done", channel: "loomy", ok: true, id: saved.id, uid: saved.uid });
      return ok({ id: saved.id, uid: saved.uid });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  }));
  // ===== CodeArts 福利：领取前先只读探测可领项（写请求仍然只有「一键领福利」那条路）=====
  ipcMain.handle("proxy_codearts_welfare_preview", handle(async ({ accountId }) => {
    const ad = adapters.get("codearts");
    if (!ad || typeof ad.previewWelfare !== "function") return fail("CodeArts 适配器未就绪");
    const accounts = (accountId ? [store.getAccount(accountId)] : store.listAccounts("codearts")).filter((a) => a && a.hasToken);
    if (!accounts.length) return fail("该渠道还没有可用账号");
    const rows = [];
    for (const acc of accounts) {
      const r = await ad.previewWelfare(acc, store.accountSecrets(acc)).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
      rows.push({ name: acc.name, ok: r.ok !== false, message: r.message || "" });
    }
    return ok({ rows, message: rows.map((r) => `${r.name}：${r.message}`).join("；") });
  }));
  // 浏览器没跳回回环地址时的兜底：把地址栏内容整段粘回来完成登录
  ipcMain.handle("proxy_oauth_submit_callback", handle(async ({ channel, url }) => {
    const r = await discovery.submitCallbackUrl(url, channel);
    // LobsterAI 的「晚到回调」补交路径不经过 beginOAuth 的 onDone（会话可能已超时关闭），
    // 故这里自行补跑「刷新余额 + 自动签到」——否则新入池账号停在 credits=0 / creditsAt=0，
    // 会被 credit_first 策略误判为最末位（与 onDone 路径行为对齐）。
    // 必须限定 channel：其它渠道的 submit（raccoon / zcode）内部已调 finishOAuth→onDone，
    // 同一套副作用会被执行第二遍（重复余额请求 / 重复签到 / 重复 oauth-done 事件）。
    if (r && r.ok && r.id && String(channel || "") === "lobster") {
      credits.refreshAccount(r.id).catch(() => {});
      checkinBatch({ accountId: r.id, action: "checkin" }).catch(() => {});
      events.emit({ type: "oauth-done", channel: String(channel || ""), ok: true, id: r.id, uid: r.uid });
    }
    return r;
  }));

  // ===== 凭据接入：粘贴 JSON / 从 JSON/ZIP 文件添加（批量，字段容忍别名） =====
  ipcMain.handle("proxy_account_import_json", handle(({ channel, json }) => {
    const fallback = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const { list, invalid, reason } = parseAccountsJson(json, fallback);
    if (reason === "metadata-only") return fail(METADATA_ONLY_MESSAGE);
    if (!list.length) return fail(invalid ? `没有可导入的账号（${invalid} 条记录缺 token）` : "没有可导入的账号");
    const r = importAccounts(list);
    const parts = [`成功导入 ${r.added} 个账号`];
    if (r.dup) parts.push(`${r.dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录缺 token 忽略`);
    const message = parts.join("，");
    oplog.log("info", "号池账号", `粘贴 JSON 导入：${message}`, { channel });
    return ok({ ...r, invalid, message });
  }));
  // 从 JSON/ZIP 文件添加：主进程弹文件选择框；zip 读取包内全部 .json 条目合并导入
  ipcMain.handle("proxy_account_import_file", handle(async ({ channel }) => {
    const fallback = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const { dialog, BrowserWindow } = require("electron");
    const r = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
      title: "选择账号 JSON / ZIP 文件",
      properties: ["openFile"],
      filters: [
        { name: "账号文件（JSON / ZIP）", extensions: ["json", "zip"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return ok({ canceled: true });
    const file = r.filePaths[0];
    const buf = fs.readFileSync(file);
    let texts = [];
    if (/\.zip$/i.test(file)) {
      const entries = zip.readZip(buf).filter((e) => /\.json$/i.test(e.name));
      if (!entries.length) return fail("压缩包里没有 .json 文件");
      texts = entries.map((e) => e.data.toString("utf8"));
    } else {
      texts = [buf.toString("utf8")];
    }
    let added = 0, dup = 0, invalid = 0, metaOnly = 0;
    for (const text of texts) {
      let parsed;
      try {
        parsed = parseAccountsJson(text, fallback);
      } catch {
        invalid++; // 单个 JSON 坏了不拖垮整包
        continue;
      }
      if (parsed.reason === "metadata-only") {
        metaOnly += parsed.invalid;
        continue;
      }
      invalid += parsed.invalid;
      const r2 = importAccounts(parsed.list);
      added += r2.added;
      dup += r2.dup;
    }
    if (!added && !dup && metaOnly) return fail(METADATA_ONLY_MESSAGE);
    if (!added && !dup) return fail(`没有可导入的账号（${invalid ? `${invalid} 条记录无效` : "文件为空"}）`);
    const parts = [`成功导入 ${added} 个账号`];
    if (dup) parts.push(`${dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录无效忽略`);
    if (metaOnly) parts.push(`${metaOnly} 条元数据（无凭据）已跳过`);
    const message = parts.join("，");
    oplog.log("info", "号池账号", `文件导入（${path.basename(file)}）：${message}`);
    return ok({ added, dup, invalid, metaOnly, file: path.basename(file), message });
  }));

  // ===== 本地 IDE 快捷切换账号 =====
  // zcode 渠道：客户端在跑时首调返回 needConfirm（前端弹确认），用户确认后带 confirmAck 重调
  ipcMain.handle("proxy_ide_switch", handle(async ({ accountId, confirmAck }) => {
    const r = await ideswitch.switchIdeAccount(accountId, { confirmAck: !!confirmAck });
    // 首调只回预检（needConfirm），不记日志；确认执行后才记（成败都记）
    if (r && r.ok && r.needConfirm) return r;
    const acc = store.getAccount(accountId);
    oplog.log(r && r.ok === false ? "error" : "info", "切换账号",
      r && r.ok ? `IDE 切号${acc ? `至「${acc.name}」` : ""}${r.relaunched ? "，客户端已重启" : ""}` : r && r.message || "IDE 切号失败",
      { target: acc && acc.name });
    return r;
  }));
  ipcMain.handle("proxy_ide_status", handle(() => ideswitch.ideSwitchStatus()));
  // zcode 切号回滚（逃生通道：切出问题 / 远程连接异常时一键还原最近一次切前状态）
  ipcMain.handle("proxy_zcode_switch_rollback", handle(() => require("./zcodeSwitch.cjs").rollbackLatest()));
  // zcode 设备指纹诊断（只读）：多号共用一枚指纹 = 一号领取全组 1004 的病灶定位
  ipcMain.handle("proxy_zcode_device_status", handle(() => require("./zcodeSwitch.cjs").deviceStatus()));
  // zcode 设备指纹修复（幂等）：撞车/疑似被烧的账号重派全新随机指纹，claim 1004 的唯一出路
  ipcMain.handle("proxy_zcode_device_repair", handle(({ all } = {}) => require("./zcodeSwitch.cjs").repairDeviceMid({ all: !!all })));
  // zcode 领取模式（人工链路）：live 指纹临时借出为目标账号专属指纹，官方客户端里人工领周末
  // 套餐用；客户端在跑时首调返回 needConfirm（前端弹确认），确认后带 confirmAck 重调
  ipcMain.handle("proxy_zcode_claim_mode", handle(({ accountId, confirmAck } = {}) =>
    require("./zcodeSwitch.cjs").enterClaimMode(String(accountId || ""), { confirmAck: !!confirmAck })));
  // zcode 恢复本机锚定指纹（领取模式收尾）：anchor.remoteMid 写回 live，手机远程随之恢复
  ipcMain.handle("proxy_zcode_restore_mid", handle(({ confirmAck } = {}) =>
    require("./zcodeSwitch.cjs").restoreRemoteMid({ confirmAck: !!confirmAck })));
  // zcode 独立人机校验（过码）：弹独立沙箱窗过码，拿 verifyParam 核销并解除风控限制
  ipcMain.handle("proxy_zcode_solve_captcha", handle(async ({ accountId }) => {
    if (!accountId) return fail("缺少账号 ID");
    const acc = store.getAccount(accountId);
    if (!acc) return fail("未找到指定账号");
    if (acc.channel !== "zcode") return fail("该渠道不支持此人机校验");
    const secrets = store.accountSecrets(acc);
    const ad = adapters.get("zcode");
    if (!ad || typeof ad.solveCaptcha !== "function") return fail("适配器不支持人机校验");
    const r = await ad.solveCaptcha(acc, secrets);
    if (r.ok) {
      pool.releaseCool(acc.id);
      store.clearError(acc.id);
      store.updateAccount(acc.id, { status: "online", coolUntil: 0, coolReason: "" });
      events.emit({ type: "credits" });
      credits.refreshAccount(acc.id).catch(() => {});
    }
    return r;
  }));

  // ===== 操作日志（反代网关「日志」页签）：分页查询 / 类型下拉 / 导出 Excel =====
  ipcMain.handle("proxy_oplog_list", handle(({ from, to, level, op, limit, offset }) =>
    oplog.list({ from, to, level, op, limit, offset })));
  ipcMain.handle("proxy_oplog_ops", handle(() => oplog.listOps()));
  ipcMain.handle("proxy_oplog_export", handle(({ from, to, level, op }) => {
    const rows = oplog.exportRows({ from, to, level, op });
    const { app } = require("electron");
    const dir = app.getPath("downloads");
    // 文件名精确到毫秒，同一秒多次导出不互相覆盖
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const file = path.join(dir, `proxy-oplog-${stamp}.xlsx`);
    const p2 = (n) => String(n).padStart(2, "0");
    const fmtTs = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    };
    const buf = xlsx.buildXlsx({
      sheetName: "操作日志",
      headers: ["时间", "等级", "操作", "渠道", "对象", "内容", "详情"],
      rows: rows.map((r) => [fmtTs(r.ts), r.level, r.op, r.channel, r.target, r.message, r.detail]),
      widths: [20, 8, 12, 16, 22, 60, 40],
    });
    fs.writeFileSync(file, buf);
    return ok({ path: file, count: rows.length, message: rows.length ? `导出成功（${rows.length} 条记录）：${file}` : "导出成功，但当前筛选条件下没有任何记录" });
  }));

  // ===== 数据目录 / 安全 =====
  ipcMain.handle("proxy_open_data_dir", handle(async () => {
    await platform.openPath(store.proxyDir());
    return ok({});
  }));
  ipcMain.handle("proxy_vault_status", handle(() => ({
    encrypted: vaultOk(),
    driver: store.driver(),
    dataDir: store.proxyDir(),
  })));

  // ===== 号池 WebDAV 同步（统一服务器 + proxy 根目录；压缩包用 WebDAV 密码加密；
  //        可选 channel = 只同步某一个编译器） =====
  ipcMain.handle("proxy_poolsync_status", handle(() => poolsync.progress()));
  ipcMain.handle("proxy_poolsync_run", handle(async ({ channel }) => {
    if (poolsync.progress().running) return fail("号池同步已在进行中");
    // 前台 await 跑完：号池体量小（几十账号），一轮就是几次请求；进度仍走 app:event 广播
    const r = await poolsync.run({ channel: channel ? String(channel) : "" });
    oplog.log(r && r.ok === false ? "error" : "info", "号池同步",
      r && r.message ? String(r.message) : `号池同步完成${channel ? `（${store.channelDisplay(channel)}）` : ""}`,
      { channel: channel ? String(channel) : "", detail: r && r.lastError ? String(r.lastError) : "" });
    return r;
  }));
  ipcMain.handle("proxy_poolsync_cancel", handle(() => {
    const r = poolsync.cancel();
    oplog.log("info", "号池同步", "号池同步已取消");
    return r;
  }));
}

// 计划判定与抖动的纯函数一并导出：供自测直接验证跨午夜 / 不补欠账 / 已完成等分支
module.exports = { boot, shutdown, stopTimers, setRuntime, register, settings, checkinJitterOffset, checkinPlannedAt, checkinDueKey, parseAccountsJson, normalizeAccountJson, METADATA_ONLY_MESSAGE };
