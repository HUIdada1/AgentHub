// 反代网关 · 编排层：模块装配 + IPC 命令注册（对应前端 src/views/proxy/* 与 src/api/ipc.ts）
// 设置统一存框架整体配置 config.json 的 proxy 段（config.cjs 默认值深合并），每次读取走磁盘 = 热生效；
// 端口属例外：改端口由 proxy_restart 同进程 stop→listen 秒级完成（方案 §6.6 第②层）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { shell } = require("electron");
const config = require("../config.cjs");
const store = require("./store.cjs");
const rules = require("./rules.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const discovery = require("./discovery.cjs");
const credits = require("./credits.cjs");
const server = require("./server.cjs");
const events = require("./events.cjs");
const util = require("./util.cjs");
const ideswitch = require("./ideswitch.cjs");
const poolsync = require("./poolsync.cjs");
const ccswitch = require("./ccswitch.cjs");
const zcodeLocal = require("./zcodeLocal.cjs");
const zcodeCapture = require("./zcodeCapture.cjs");
const zip = require("../zip.cjs");

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
 *   ① zcode-account-switcher 导出：{meta:{label,email}, snapshot:{credentials, config}}
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

/** 解析 JSON 文本（对象 / 数组 / {accounts:[...]} 包装），返回 { list, invalid } */
function parseAccountsJson(text, fallbackChannel) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("JSON 解析失败：内容不是合法 JSON");
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

let booted = false;

// ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包，参考项目实证端点） =====
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
      const useAct = act === "checkin" && acc.channel === "workbuddy_ai" ? "trial" : act;
      const secrets = store.accountSecrets(store.getAccount(acc.id));
      try {
        let r;
        if (useAct === "status") r = await ad.checkinStatus(acc, secrets);
        else if (useAct === "checkin") {
          r = await ad.checkin(acc, secrets);
          // zcode 领取奖励的人机校验二段流：上游启用验证码时适配器返回 needCaptcha，
          // 手动发起的领取弹官方 SDK 验证窗拿 verifyParam 重调一次；无人值守的自动 tick
          // 不弹窗，该行如实标「需人工过码」，UI 提示用户手动领取
          if (r && r.needCaptcha && r.captcha && r.captcha.sceneId && typeof ad.checkin === "function") {
            if (interactive) {
              const cap = await zcodeCapture.solveCaptcha(r.captcha);
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
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: !!r.ok, ...r });
        // 签到成功（且不是幂等/不可用）后顺手刷新余额，让号池立刻看到新积分
        if (useAct !== "status" && r.ok && !r.unavailable && !r.already) {
          credits.refreshAccount(acc.id).catch(() => {});
        }
      } catch (e) {
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: false, message: String((e && e.message) || e) });
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

// ===== 定时自动签到：每天到点自动跑一次全渠道（Trae/WorkBuddy 每日签到 + 国际版领加油包） =====
// setInterval 常驻、tick 动态读配置——开关/时间改完即生效，无需重启；当天已跑过不重跑。
// 重启应用后当天会再跑一次：签到/加油包都是幂等语义（already 不算失败），无害
let checkinTimer = null;
let lastAutoCheckinDay = "";
// 领取窗口未开（渠道 deferred）时的延后重试时刻：窗口开放前 60s tick 直接跳过，
// 且不标记当天已完成——否则一天一次的语义会永久错过当日窗口（Qoder 每日 10:00 UTC+8 重置）
let autoDeferredUntil = 0;
function checkinAutoTick() {
  try {
    const cfg = settings();
    if (!cfg.checkinAuto) return;
    const now = new Date();
    const [h, m] = String(cfg.checkinAutoTime || "09:00").split(":").map((x) => Number(x) || 0);
    const planned = new Date(now);
    planned.setHours(h, m, 0, 0);
    if (now < planned) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (lastAutoCheckinDay === day) return;
    if (Date.now() < autoDeferredUntil) return;
    lastAutoCheckinDay = day;
    checkinBatch({ action: "checkin" }).then((res) => {
      // deferred：撤销当天标记并记录重试时刻——60s tick 到点自会重跑并真正完成签到
      if (res && res.deferredRetryAt && res.deferredRetryAt > Date.now()) {
        lastAutoCheckinDay = "";
        // 延后只在当天内生效：retryAt 一旦落在明天及以后（远期活动实例/字段异常），
        // 窗口交由次日的例行签到重新评估——不让一个渠道的 deferred 停摆其它渠道好几天
        const endOfDay = new Date(now);
        endOfDay.setHours(24, 0, 0, 0);
        autoDeferredUntil = Math.min(res.deferredRetryAt, endOfDay.getTime());
      }
    }).catch(() => {});
  } catch {
    /* 配置读取失败下轮再试 */
  }
}
function startCheckinAuto() {
  stopCheckinAuto();
  checkinTimer = setInterval(checkinAutoTick, 60000);
}
function stopCheckinAuto() {
  if (checkinTimer) clearInterval(checkinTimer);
  checkinTimer = null;
}

/** 启动装配：规则热加载初始化 + 数据库 + 定时额度刷新 + 按上次的开关状态恢复网关
 *  （restoreOnLaunch 不是「用户偏好」而是「上次退出时网关是开是关」，默认 false → 首次打开是关闭的） */
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
  if (settings().restoreOnLaunch) {
    server.start(settings).then(() => events.emit({ type: "status" })).catch(() => {});
  }
}

function shutdown() {
  credits.stopScheduler();
  stopCheckinAuto();
  discovery.cancelOAuth();
  server.stop();
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
    else if (isAuthPage(url)) shell.openExternal(url).catch(() => {});
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
  };
}

/** 号池全量视图：五渠道聚合 + 账号明细 + 调度策略（号池页数据源） */
function poolView() {
  const agents = store.listAgents();
  const localLogins = currentLocalLogins();
  const health = server.channelHealthSnapshot(); // 渠道降级快照一次取全（循环内逐渠道取是全表快照 ×5）
  return store.CHANNELS.map((c) => {
    const summary = pool.poolSummary(c.id);
    const localUid = String((localLogins[c.id] && localLogins[c.id].uid) || "");
    const accounts = pool.poolAccounts(c.id).map((a) => ({
      ...a,
      modelCool: pool.accountModelCool(a.id),
      // 当前电脑上的 agent 客户端登录的就是这个账号（按本机登录态 uid 比对）
      liveHere: !!(localUid && a.uid && String(a.uid) === localUid),
    }));
    return {
      ...c,
      poolStrategy: (agents.find((a) => a.id === c.id) || {}).poolStrategy || "expire_first",
      summary,
      accounts,
      health: health[c.id] || null, // 降级状态（until/reason/streak），null=正常
    };
  });
}

function gatewayStatus() {
  const s = server.status();
  const cfg = settings();
  return {
    ...s,
    port: s.running ? s.port : cfg.port,
    bind: s.running ? s.bind : cfg.bind,
    baseUrl: `http://${s.running ? s.bind : cfg.bind}:${s.running ? s.port : cfg.port}/v1`,
    today: store.statsToday(),
    channels: store.CHANNELS.map((c) => ({ id: c.id, display: c.display, ...pool.poolSummary(c.id), health: server.channelHealthSnapshot()[c.id] || null })),
    keyCount: store.listKeys().length,
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

/** 记住网关的开关状态：每次启停都写回整体配置的 proxy.restoreOnLaunch，
 *  下次打开应用按它决定是否自动启动（默认 false，即首次打开是关闭的） */
function rememberRunning(running) {
  try {
    const cfg = config.loadConfig();
    if (cfg.proxy.restoreOnLaunch === running) return;
    cfg.proxy.restoreOnLaunch = running;
    config.saveConfig(cfg);
  } catch {
    /* 落盘失败不影响本次启停，只影响下次开机是否自动拉起 */
  }
}

function register(ipcMain) {
  // ===== 服务启停 / 状态 =====
  ipcMain.handle("proxy_status", handle(() => gatewayStatus()));
  ipcMain.handle("proxy_start", handle(async () => {
    const r = await server.start(settings);
    if (r.ok) rememberRunning(true);
    events.emit({ type: "status" });
    return r.ok ? ok({ port: r.port, already: !!r.already }) : fail(r.message);
  }));
  ipcMain.handle("proxy_stop", handle(() => {
    server.stop();
    rememberRunning(false);
    events.emit({ type: "status" });
    return ok({});
  }));
  // 改端口后调用：同进程 stop→listen，秒级完成（方案 §6.6）
  ipcMain.handle("proxy_restart", handle(async () => {
    await server.stopAsync();
    const r = await server.start(settings);
    if (r.ok) rememberRunning(true);
    credits.startScheduler(() => settings().creditsRefreshMin); // 刷新周期一并热生效
    events.emit({ type: "status" });
    return r.ok ? ok({ port: r.port }) : fail(r.message);
  }));

  // ===== API Keys =====
  ipcMain.handle("proxy_keys_list", handle(() => store.listKeys()));
  ipcMain.handle("proxy_key_create", handle(({ name, route, dailyQuota, rateLimit }) => {
    const r = store.createKey({ name, route, dailyQuota, rateLimit });
    const row = store.listKeys().find((k) => k.id === r.id);
    // 完整 Key 已以 DPAPI 信封存库，列表接口随时可取（列表行内即带 secret）
    return { ...row, secret: r.secret };
  }));
  ipcMain.handle("proxy_key_update", handle(({ id, name, route, dailyQuota, rateLimit, enabled }) => {
    if (!store.updateKey(id, { name, route, dailyQuota, rateLimit, enabled })) return fail("Key 不存在");
    return ok({});
  }));
  ipcMain.handle("proxy_key_delete", handle(({ id }) => {
    if (!store.deleteKey(id)) return fail("Key 不存在");
    return ok({});
  }));

  // ===== 号池 =====
  ipcMain.handle("proxy_pool", handle(() => poolView()));
  ipcMain.handle("proxy_pool_strategy", handle(({ channel, strategy }) => {
    if (!store.setPoolStrategy(channel, strategy)) return fail("不支持的调度策略");
    return ok({});
  }));
  // 手动粘贴（方案 §2.4 三途径之一）；token 仅本地加密存储
  ipcMain.handle("proxy_account_add", handle(({ channel, name, token, refreshToken, uid }) => {
    if (!adapters.get(channel)) return fail("未知渠道");
    if (!String(token || "").trim()) return fail("请粘贴 token / JWT");
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
    return ok({ id });
  }));
  ipcMain.handle("proxy_account_remove", handle(({ id }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    // 先写墓碑再删本机：删除要经 WebDAV 传播到其他设备（号池同步拉取时按墓碑移除）
    poolsync.noteRemoved(poolsync.accountKeyOf(acc));
    if (!store.removeAccount(id)) return fail("账号不存在");
    return ok({});
  }));
  ipcMain.handle("proxy_account_toggle", handle(({ id, enabled }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    store.updateAccount(id, enabled
      ? { status: "online", coolUntil: 0, coolReason: "" }
      : { status: "disabled" });
    return ok({});
  }));
  // 重命名账号（自定义备注）：改 name 字段，WebDAV 同步时 LWW 传播到其他设备
  ipcMain.handle("proxy_account_rename", handle(({ id, name }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    store.updateAccount(id, { name: String(name || "").trim() });
    return ok({});
  }));
  // 手动解除冷却：cooling 账号立即回 online，同时豁免该账号的模型级负缓存
  ipcMain.handle("proxy_account_cool_off", handle(({ id }) => {
    const r = pool.releaseCool(String(id || ""));
    return r.ok ? ok({ releasedModels: r.releasedModels }) : fail(r.message);
  }));
  ipcMain.handle("proxy_account_refresh", handle(({ id }) => credits.refreshAccount(id)));
  ipcMain.handle("proxy_credits_refresh", handle(() => credits.refreshAll()));
  // 号池页右上角「刷新当前渠道」：只刷一个编译器的号池额度
  ipcMain.handle("proxy_credits_refresh_channel", handle(({ channel }) => {
    if (!channel) return fail("缺少渠道参数");
    return credits.refreshChannel(String(channel));
  }));

    // ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包 / ZCode 领取奖励，参考项目实证端点） =====
  // 批量签到动作见模块级 checkinBatch（手动 IPC 与定时自动签到共用）；
  // 手动发起 interactive=true——zcode 领取需要人机校验时允许弹官方 SDK 验证窗
  ipcMain.handle("proxy_checkin_status", handle(({ channel, accountId }) => checkinBatch({ channel, accountId, action: "status" })));
  ipcMain.handle("proxy_checkin_run", handle(({ channel, accountId, action }) => checkinBatch({ channel, accountId, action: action || "checkin", interactive: true })));

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
  ipcMain.handle("proxy_oauth_begin", handle(async ({ channel }) => {
    const ch = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const r = await discovery.beginOAuth(ch, (result) => {
      if (result.ok) {
        credits.refreshAccount(result.id).catch(() => {});
        // 登录后自动签到一次（参考项目 login.sh / signin 同款：自动签到 + 查积分）
        checkinBatch({ accountId: result.id, action: "checkin" }).catch(() => {});
      }
      events.emit({ type: "oauth-done", channel: ch, ...result });
    }, { openAuthWindow });
    // 带授权地址的渠道在系统浏览器打开（小浣熊走内嵌授权窗，不回 url——深链回调绝不能进浏览器
    // 再被系统交给官方客户端：授权码是一次性的，官方客户端消费掉 AgentHub 就永远收不到回调）
    if (r.ok && r.url) await shell.openExternal(r.url);
    return r.ok ? ok({ url: r.url, mode: r.mode }) : fail(r.message);
  }));
  ipcMain.handle("proxy_oauth_cancel", handle(() => ok({ cancelled: discovery.cancelOAuth() })));
  // 浏览器没跳回回环地址时的兜底：把地址栏内容整段粘回来完成登录
  ipcMain.handle("proxy_oauth_submit_callback", handle(({ channel, url }) => discovery.submitCallbackUrl(url, channel)));

  // ===== 凭据接入：粘贴 JSON / 从 JSON/ZIP 文件添加（批量，字段容忍别名） =====
  ipcMain.handle("proxy_account_import_json", handle(({ channel, json }) => {
    const fallback = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const { list, invalid } = parseAccountsJson(json, fallback);
    if (!list.length) return fail(invalid ? `没有可导入的账号（${invalid} 条记录缺 token）` : "没有可导入的账号");
    const r = importAccounts(list);
    const parts = [`成功导入 ${r.added} 个账号`];
    if (r.dup) parts.push(`${r.dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录缺 token 忽略`);
    return ok({ ...r, invalid, message: parts.join("，") });
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
    let added = 0, dup = 0, invalid = 0;
    for (const text of texts) {
      let parsed;
      try {
        parsed = parseAccountsJson(text, fallback);
      } catch {
        invalid++; // 单个 JSON 坏了不拖垮整包
        continue;
      }
      invalid += parsed.invalid;
      const r2 = importAccounts(parsed.list);
      added += r2.added;
      dup += r2.dup;
    }
    if (!added && !dup) return fail(`没有可导入的账号（${invalid ? `${invalid} 条记录无效` : "文件为空"}）`);
    const parts = [`成功导入 ${added} 个账号`];
    if (dup) parts.push(`${dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录无效忽略`);
    return ok({ added, dup, invalid, file: path.basename(file), message: parts.join("，") });
  }));

  // ===== 模型目录 =====
  // 合并视图 + 管理态（启停/渠道覆盖/回退模型/自定义参数）；管理态由渲染层写回整体配置（app.save），服务端每请求读盘热生效
  ipcMain.handle("proxy_models", handle(() => {
    const cfg = settings();
    return adapters.mergedModels(cfg).map((m) => ({
      ...m,
      enabled: !(cfg.disabledModels || []).includes(m.id),
      override: (cfg.modelOverrides || {})[m.id] || "",
      fallback: (cfg.modelFallback || {})[m.id] || "",
      custom: (cfg.modelCustom || {})[m.id] || undefined,
    }));
  }));
  // 官方模型目录拉取（三渠道通用）：取号池里第一个 online 有 token 的账号，adapter.fetchModels 走云端接口
  // （Trae get_detail_param / WB v3/config + console models），结果写回 rules/catalog.json 热生效。
  // 拉取失败不写空——保留旧目录，面板报错由用户重试
  ipcMain.handle("proxy_models_sync", handle(async ({ channel }) => {
    const ch = String(channel || "");
    const adapter = adapters.get(ch);
    if (!adapter || typeof adapter.fetchModels !== "function") return fail(`未知渠道 "${ch}"`);
    const acc = pool.poolAccounts(ch).find((a) => a.status === "online" && a.hasToken);
    if (!acc) return fail(`${store.channelDisplay(ch)}号池无可用账号，无法拉取模型目录`);
    const secrets = store.accountSecrets(store.getAccount(acc.id));
    const r = await adapter.fetchModels(acc, secrets);
    if (!r || !r.ok || !Array.isArray(r.models) || !r.models.length) {
      return fail((r && r.message) || "目录拉取失败");
    }
    const file = path.join(rules.rulesDir(), "catalog.json");
    const cur = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
    cur[ch] = { syncedAt: Date.now(), models: r.models };
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
    rules.reload("catalog.json");
    const withRate = r.models.filter((m) => m && m.rate != null).length;
    return ok({ channel: ch, count: r.models.length, withRate });
  }));

  // ===== 生态接入：CC Switch =====
  ipcMain.handle("proxy_ccswitch_status", handle(() => ccswitch.status()));
  ipcMain.handle("proxy_ccswitch_register", handle(({ appType, apiKey, model, port }) =>
    ccswitch.register({ appType, apiKey, model, port })));

  // ===== 本地 IDE 快捷切换账号 =====
  // zcode 渠道：客户端在跑时首调返回 needConfirm（前端弹确认），用户确认后带 confirmAck 重调
  ipcMain.handle("proxy_ide_switch", handle(({ accountId, confirmAck }) => ideswitch.switchIdeAccount(accountId, { confirmAck: !!confirmAck })));
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

  // ===== 统计 =====
  ipcMain.handle("proxy_stats_overview", handle(({ days }) => ({
    today: store.statsToday(),
    trend: store.statsTrend(days || 7),
    tops: {
      channel: store.statsTop("channel", days || 7),
      model: store.statsTop("model", days || 7),
      key: store.statsTop("key", days || 7),
      account: store.statsTop("account", days || 7),
    },
  })));
  ipcMain.handle("proxy_stats_top", handle(({ dim, days }) => store.statsTop(dim, days)));
  ipcMain.handle("proxy_stats_detail", handle(({ page, pageSize, channel, keyId, model }) =>
    store.statsDetail({ page, pageSize, channel, keyId, model })));
  ipcMain.handle("proxy_recent", handle(({ limit }) => store.recentRequests(limit)));

  // ===== 规则文件 / 目录 / 安全 =====
  ipcMain.handle("proxy_rules_list", handle(() => rules.list()));
  ipcMain.handle("proxy_open_rules_dir", handle(async () => {
    await shell.openPath(rules.rulesDir());
    return ok({});
  }));
  ipcMain.handle("proxy_open_data_dir", handle(async () => {
    await shell.openPath(store.proxyDir());
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
    return poolsync.run({ channel: channel ? String(channel) : "" });
  }));
  ipcMain.handle("proxy_poolsync_cancel", handle(() => poolsync.cancel()));
}

module.exports = { boot, shutdown, register, settings };
