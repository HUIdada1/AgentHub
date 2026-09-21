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
const zip = require("../zip.cjs");

// ===== 号池 JSON 导入（粘贴 / 文件共用）：单个对象或数组，字段容忍常见别名 =====

// 一条记录归一化为 addAccount 入参；token 为空返回 null（交由上层按无效计数）
function normalizeAccountJson(raw, fallbackChannel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const channel = adapters.get(raw.channel) ? String(raw.channel) : fallbackChannel;
  let token = String(raw.token ?? raw.accessToken ?? raw.access_token ?? raw.jwt ?? raw.JWT ?? "").trim();
  token = token.replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const refreshToken = String(raw.refreshToken ?? raw.refresh_token ?? "").trim();
  const dec = util.jwtDecode(token);
  const uid = String(raw.uid ?? raw.userId ?? raw.user_id ?? dec.uid ?? "").trim();
  return {
    channel,
    uid,
    name: String(raw.name ?? raw.remark ?? "").trim(),
    token,
    refreshToken,
    expiresAt: Number(raw.expiresAt ?? raw.expires_at ?? 0) || 0,
    source: "json",
  };
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
async function checkinBatch({ channel, accountId, action }) {
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
      const ad = adapters.get(acc.channel);
      const useAct = act === "checkin" && acc.channel === "workbuddy_ai" ? "trial" : act;
      const secrets = store.accountSecrets(store.getAccount(acc.id));
      try {
        let r;
        if (useAct === "status") r = await ad.checkinStatus(acc, secrets);
        else if (useAct === "checkin") r = await ad.checkin(acc, secrets);
        else r = typeof ad.trial === "function" ? await ad.trial(acc, secrets) : { ok: false, message: "该渠道没有加油包" };
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
    events.emit({ type: "credits" });
    return { ok: true, action: act, total: rows.length, okCount, rows };
  } finally {
    if (act !== "status") checkinBusy = false;
  }
}

// ===== 定时自动签到：每天到点自动跑一次全渠道（Trae/WorkBuddy 每日签到 + 国际版领加油包） =====
// setInterval 常驻、tick 动态读配置——开关/时间改完即生效，无需重启；当天已跑过不重跑。
// 重启应用后当天会再跑一次：签到/加油包都是幂等语义（already 不算失败），无害
let checkinTimer = null;
let lastAutoCheckinDay = "";
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
    lastAutoCheckinDay = day;
    checkinBatch({ action: "checkin" }).catch(() => {});
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
  credits.startScheduler(() => settings().creditsRefreshMin);
  startCheckinAuto();
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

/** 号池全量视图：三渠道聚合 + 账号明细 + 调度策略（号池页数据源） */
function poolView() {
  const agents = store.listAgents();
  return store.CHANNELS.map((c) => {
    const summary = pool.poolSummary(c.id);
    const accounts = pool.poolAccounts(c.id);
    return {
      ...c,
      poolStrategy: (agents.find((a) => a.id === c.id) || {}).poolStrategy || "expire_first",
      summary,
      accounts,
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
    channels: store.CHANNELS.map((c) => ({ id: c.id, display: c.display, ...pool.poolSummary(c.id) })),
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

  // ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包，参考项目实证端点） =====
  // 批量签到动作见模块级 checkinBatch（手动 IPC 与定时自动签到共用）
  ipcMain.handle("proxy_checkin_status", handle(({ channel, accountId }) => checkinBatch({ channel, accountId, action: "status" })));
  ipcMain.handle("proxy_checkin_run", handle(({ channel, accountId, action }) => checkinBatch({ channel, accountId, action: action || "checkin" })));

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
    });
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
  // 合并视图 + 管理态（启停/渠道覆盖/回退模型）；管理态由渲染层写回整体配置（app.save），服务端每请求读盘热生效
  ipcMain.handle("proxy_models", handle(() => {
    const cfg = settings();
    return adapters.mergedModels().map((m) => ({
      ...m,
      enabled: !(cfg.disabledModels || []).includes(m.id),
      override: (cfg.modelOverrides || {})[m.id] || "",
      fallback: (cfg.modelFallback || {})[m.id] || "",
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
  ipcMain.handle("proxy_ide_switch", handle(({ accountId }) => ideswitch.switchIdeAccount(accountId)));
  ipcMain.handle("proxy_ide_status", handle(() => ideswitch.ideSwitchStatus()));

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
