/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 模块编排层：装配 配置/存储/索引/检索/接入服务，注册全部 memory_* IPC，广播 memory 事件。
// 与其它三大模块平级且可剥离：卸载时删掉 memory/ 目录 + 六处框架触点即可，互不影响。
"use strict";

const fs = require("fs");
const path = require("path");

let electron = null;
try { electron = require("electron"); } catch { /* 纯 Node 自测环境 */ }

const configMod = require("../config.cjs");
const { MemoryConfig, defaultRoot, expandHome } = require("./config.cjs");
const { MemoryService } = require("./service.cjs");
const { isIndexWatchTarget } = require("./store.cjs");
const { MemoryHttpApi } = require("./httpapi.cjs");
const { AgentAccess } = require("./access.cjs");
const { ProviderStore } = require("./providers.cjs");
const { MemoryTasks } = require("./tasks.cjs");
const { MemoryScheduler, TASK_DEFS } = require("./scheduler.cjs");
const { MemorySync } = require("./sync.cjs");
const { DedupEngine } = require("./dedup.cjs");
const { ImportEngine } = require("./import/engine.cjs");
const { LlmClient } = require("./llm/client.cjs");
const agents = require("./agents.cjs");
const tools = require("./tools.cjs");
const { SCHEMA, defaultConfig: schemaDefaults, validateValue, migrateTaskTimes, migrateUiTabs } = require("./config-schema.cjs");
const profileCache = require("./profile-cache.cjs");

let service = null;
let memCfg = null;
let httpApi = null;
let booting = false; // boot 重入闸（异步启动期间防连点）
let access = null;
/** 启动延后任务的定时器句柄：shutdown 时统一取消 */
let bootTimers = [];
let watcher = null;
let watchTimer = null;
let watchPending = null;
let providers = null;
let llm = null;
let tasksRunner = null;
let scheduler = null;
let syncer = null;
let dedupEngine = null;
let importer = null;
let rootDir = "";
let booted = false;
// 网关状态探测与记忆中枢的生命周期无关（只读框架配置 + 打本机 /healthz）：
// 记忆中枢停用后「设置 · 模型与网关」仍要显示网关可用性，故默认就指向真实探测
let gatewayProbe = () => gatewaySnapshot();

function ok(data) { return { ok: true, ...(data || {}) }; }
/** 失败信封：message 之外必须把 code / tried 带出去。
 *  此前只回 {ok:false, message}，`no_model`（llm/client.cjs）与「试过哪些模型」（err.tried）
 *  在 IPC 包装层被吞掉，前端只能靠文案匹配猜原因——文案一改，引导弹窗就失效。 */
function fail(message) {
  const out = { ok: false, message: String((message && message.message) || message) };
  if (message && typeof message === "object") {
    if (message.code) out.code = String(message.code);
    if (Array.isArray(message.tried) && message.tried.length) out.tried = message.tried;
  }
  return out;
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

// 事件广播（app:event，event: "memory"）——与 proxy/events.cjs 同构
function emit(payload) {
  if (!electron || !electron.BrowserWindow) return;
  try {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("app:event", { event: "memory", ...payload });
    }
  } catch { /* 无窗口时静默 */ }
}

// 跨模块探测（不改 proxy 逻辑）：直接打本机网关的 /healthz，结果缓存 30 秒
let gatewayCache = { at: 0, value: { available: false, baseUrl: "", port: 0, fallbackModel: "" } };
async function probeGateway() {
  const now = Date.now();
  if (now - gatewayCache.at < 30000) return gatewayCache.value;
  const framework = configMod.loadConfig();
  const port = (framework.proxy && framework.proxy.port) || 9527;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  // fallbackModel（反代网关设置里的全局统一回退模型）必须带出去：模型池没配时 LlmClient 靠它
  // 回退到网关号池当前模型——此前探测结果漏了这个字段，「什么都不配回退号池」实际永不生效
  const value = { available: false, baseUrl, port, fallbackModel: String((framework.proxy && framework.proxy.fallbackModel) || "") };
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    value.available = res.ok;
  } catch {
    value.available = false;
  } finally {
    // fetch 在超时前就失败（如连接被拒）时也要清掉定时器，否则句柄会存活到 1.2s 后才自解
    if (timer) clearTimeout(timer);
  }
  gatewayCache = { at: now, value };
  return value;
}

// 同步给 LlmClient 用的网关状态（避免每次调用都 await 网络探测）
function gatewaySnapshot() {
  void probeGateway();
  return gatewayCache.value;
}

// 展开 ~ 与 %ENV% 形式的路径（来源配置里普遍这么写）
function expandPath(p) {
  let out = String(p || "");
  if (!out) return out;
  out = out.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || _m);
  return expandHome(out);
}

function runtimeFile() {
  const dataDir = configMod.dataDir();
  return path.join(dataDir, "memory-runtime.json");
}

function resolveRoot() {
  const framework = configMod.loadConfig();
  const fromFramework = framework && framework.memory && framework.memory.rootDir;
  const fromRepo = memCfg && memCfg.get("storage.root");
  return expandHome(fromRepo || fromFramework || defaultRoot());
}

function settings() {
  return memCfg ? memCfg.all() : schemaDefaults();
}

function flatSettings() {
  if (!service) return {};
  return service.flat();
}

/**
 * 配置链的就地保障：记忆中枢停用时 memCfg 为 null，但「设置 · 模型与网关」仍要读写 models.*
 * （供应商、模型池、超时/重试），所以按需建一个只读配置链的实例。
 * 只建 MemoryConfig（仓库内两个 JSON），不碰 service / 索引库 / 调度器 —— 零副作用。
 */
function ensureMemCfg() {
  if (!memCfg) {
    if (!rootDir) rootDir = resolveRoot();
    memCfg = new MemoryConfig(rootDir);
    memCfg.load();
  }
  return memCfg;
}

/**
 * 供应商/模型池的读写入口（所有 memory_provider_* / memory_model_* / memory_llm_sources* 都走它）。
 *
 * 为什么不能直接用模块级 `providers`：它在 boot() 里创建、在 shutdown() 里置 null，
 * 于是「记忆中枢板块一停用，设置 · 模型与网关整页报 Cannot read properties of null」——
 * 平台级配置跟着某个板块的开关一起死，是最刺眼的自相矛盾。
 *
 * 现在改成惰性创建：已启用时复用 boot 出来的实例（与任务共用同一份配置链与 quirks 记忆），
 * 未启用时就地建一个「只读配置链」的实例（service=null，ProviderStore.flat() 退回 flattenConfig）。
 * 存储位置完全不动：仍是仓库里的 memory.config.local.json，零数据搬迁风险。
 */
function providerStore() {
  if (providers) return providers;
  providers = new ProviderStore({
    memCfg: ensureMemCfg(),
    service,
    emit,
    gatewayResolver: () => gatewayProbe(),
  });
  return providers;
}

// ---------- 生命周期 ----------

function init() {
  const framework = configMod.loadConfig();
  // 启用开关唯一事实源 modules.memory.enabled（issue #91）；旧版 memory.enabled=false
  // 已由 loadConfig 迁移进 modules，这里不再读旧字段
  if (framework.modules && framework.modules.memory && framework.modules.memory.enabled === false) {
    return { enabled: false };
  }
  if (memCfg && service) return { enabled: true, root: rootDir };
  gatewayProbe = gatewaySnapshot;

  rootDir = resolveRoot();
  memCfg = new MemoryConfig(rootDir);
  memCfg.load();
  // 仓库配置里的 root 与框架指针保持一致（首次运行写回默认值，方便用户在设置里看到）
  if (!memCfg.get("storage.root")) memCfg.set({ "storage.root": rootDir }, { local: true });
  service = new MemoryService(rootDir, memCfg, {
    deviceId: deviceId(),
    onEvent: (p) => emit(p),
  }).init();
  // 一次性迁移：任务默认执行时间 23:00/23:30/02:00/03:00/04:00 → 11 点档（2026-10-08）。
  // 任务保存会把时间落盘，存量配置里写死的是旧默认值；meta 闸门保证整轮只跑一次 ——
  // 否则用户刻意改回旧时间点时，重启会被再次搬走。迁移失败不阻塞启动（下次启动重试）。
  try {
    if (service.index.getMeta("mem_sched_rhythm_v2") !== "done") {
      const tasks = JSON.parse(JSON.stringify(memCfg.get("auto.tasks") || {}));
      if (migrateTaskTimes(tasks)) memCfg.set({ "auto.tasks": tasks }, { local: false });
      service.index.setMeta("mem_sched_rhythm_v2", "done");
    }
  } catch { /* 迁移失败不阻塞启动 */ }
  // 一次性迁移：「显示的页签」旧默认 5 项 → 新默认 8 项（2026-10-20，仅「检索与索引」收进配置·界面）。
  // 只搬恰好等于旧默认的写盘值，用户自选过的清单不动；meta 闸门保证整轮只跑一次。
  try {
    if (service.index.getMeta("mem_ui_tabs_v2") !== "done") {
      const nextTabs = migrateUiTabs(memCfg.get("ui.tabs"));
      if (nextTabs) memCfg.set({ "ui.tabs": nextTabs }, { local: false });
      service.index.setMeta("mem_ui_tabs_v2", "done");
    }
  } catch { /* 迁移失败不阻塞启动 */ }
  access = new AgentAccess({
    appPath: electron && electron.app ? electron.app.getPath("exe") : process.execPath,
    resourcesPath: electron && electron.app && process.resourcesPath ? process.resourcesPath : undefined,
  });
  llm = new LlmClient({
    service,
    getConfig: () => service.flat(),
    emit,
    gatewayResolver: () => gatewayProbe(),
  });
  providers = new ProviderStore({
    memCfg,
    service,
    emit,
    gatewayResolver: () => gatewayProbe(),
  });
  dedupEngine = new DedupEngine({ service, client: providers.client, emit });
  tasksRunner = new MemoryTasks({ service, client: providers.client, emit, rootDir });
  scheduler = new MemoryScheduler({
    service,
    tasks: tasksRunner,
    getConfig: () => service.flat(),
    emit,
  });
  // 任务实现（tasks.cjs）把真实进度（i/N 或阶段）交回调度器，由调度器统一更新 running 快照并广播
  tasksRunner.onProgress = (percent, phase) => scheduler.progress(percent, phase);
  scheduler.dedup = dedupEngine;
  scheduler.verifyHook = () => reconcileAgents();
  scheduler.loadHistory();
  importer = new ImportEngine({
    service,
    rootDir,
    getConfig: () => service.flat(),
    emit,
    memCfg,
    expandPath: (p) => expandPath(p),
  });
  // 写记忆时同步去重（L1/L2 毫秒级）；异步补判交给调度器
  service.dedupHook = (info) => dedupEngine.checkSync(info);
  service.asyncDedupHook = (id) => dedupEngine.resolveQueued(id);
  service.thresholdHook = () => scheduler.maybeTriggerByThreshold();
  syncer = new MemorySync({
    service,
    deviceName: require("os").hostname(),
    // 设备登记文件名取自它：不传的话 state.deviceId 恒空、多台设备都写成 devices/local.json 互相覆盖
    deviceId: deviceId(),
    getConfig: () => service.flat(),
    moduleWebdav: (key) => configMod.moduleWebdav(key),
    emit,
    rootDir,
    dataDir: configMod.dataDir(),
  });
  // syncer 必须在 new MemorySync 之后再挂到调度器上：之前在这行之上赋值时 syncer 还是 null，
  // scheduler.maybeAutoSync 的 `if (!this.syncer) return` 永远命中，sync.auto 的定时同步从未跑过
  scheduler.syncer = syncer;
  // 检查深层画像自愈：如果本地 profile 缺失但持久缓存存在，自动还原落盘；若本地有画像，更新持久缓存
  try {
    profileCache.restoreIfMissing(service.store, configMod.dataDir(), (rel) => service.reindexFile(rel));
    profileCache.syncStoreToCache(service.store, configMod.dataDir());
  } catch {}
  booted = true;
  emit({ type: "ready", root: rootDir });
  return { enabled: true, root: rootDir };
}

function deviceId() {
  try {
    const file = path.join(configMod.dataDir(), "memory-device.json");
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && data.deviceId) return data.deviceId;
    }
    const id = "dev_" + Math.random().toString(36).slice(2, 10);
    fs.writeFileSync(file, JSON.stringify({ deviceId: id, createdAt: Date.now() }, null, 2), "utf8");
    return id;
  } catch {
    return "dev_local";
  }
}

async function boot() {
  // 重入闸（审查整改）：init 只保证服务对象存在，这里会无条件新建 HTTP API——
  // 已在运行时再 boot 会旧实例被覆盖、新实例 EADDRINUSE，桥状态显示错乱
  if (httpApi || booting) return { enabled: true, root: rootDir, booted: true };
  booting = true;
  try {
    const r = init();
    if (!r.enabled) return r;
    try {
      httpApi = new MemoryHttpApi(service, runtimeFile(), { onEvent: (p) => emit(p) });
      const started = await httpApi.start();
      emit({ type: "bridge", running: true, port: started.port });
    } catch (e) {
      emit({ type: "bridge", running: false, message: String(e.message || e) });
    }
    startWatch();
    if (scheduler) scheduler.start();
    // 存量项目元数据自愈：老版本用显式项目名写入时不探测 Git，项目卡因此缺远程/本地路径。
    // 延后到启动流程之外异步跑，且逐项目最多读少量文件——不能阻塞启动（曾因同步扫描主进程冻结数十秒）。
    // 句柄存引用：shutdown 时取消，否则关闭 6 秒后 reconcile 仍在已关闭的 service 上跑
    bootTimers = [
      setTimeout(() => {
        try {
          const r = service && service.reconcileProjectMetadata();
          if (r && r.healed) emit({ type: "projects", healed: r.healed });
        } catch (e) {
          emit({ type: "projects", healed: 0, message: String((e && e.message) || e) });
        }
      }, 6000),
    ];
    if (flatSettings()["agents.autoVerify"] !== false) {
      // 异步巡检，不阻塞启动
      bootTimers.push(setTimeout(() => reconcileAgents().catch(() => {}), 4000));
    }
    return r;
  } finally {
    booting = false;
  }
}

async function shutdown() {
  stopWatch();
  // 取消启动延后任务：否则关闭 6 秒后 reconcile 仍在已关闭的 service 上跑
  for (const t of bootTimers) clearTimeout(t);
  bootTimers = [];
  // 先等在途任务收尾再关库：任务在已关闭的 db 上写索引会报错，MD 已写而索引缺行
  if (scheduler) await scheduler.stopAndDrain().catch(() => {});
  if (syncer && syncer.running) syncer.cancel();
  if (httpApi) httpApi.stop();
  httpApi = null;
  if (service) service.close();
  service = null;
  memCfg = null;
  providers = null;
  llm = null;
  tasksRunner = null;
  scheduler = null;
  syncer = null;
  dedupEngine = null;
  importer = null;
  access = null;
  booted = false;
}

function status() {
  const enabled = booted && !!service;
  const s = enabled ? service.indexStatus() : null;
  const beats = enabled ? service.index.beats() : [];
  const verified = beats.filter((b) => b.last_call).length;
  return {
    ok: true,
    enabled,
    root: rootDir,
    bridge: httpApi ? httpApi.status() : { running: false, port: 0 },
    index: s,
    verifiedAgents: verified,
    beats,
  };
}

// ---------- 目录监听（外部编辑 MD 后重算索引） ----------

function startWatch() {
  if (watcher) return;
  let chokidar;
  try { chokidar = require("chokidar"); } catch { return; }
  try {
    watcher = chokidar.watch(rootDir, {
      ignoreInitial: true,
      // 忽略口径与索引范围同源（曾经这里单独写死一份，漏了 reports：冲突留档被索引成行，
      // 而扫描又看不见它，诊断里就出现永远清不掉的孤儿行）。
      // 目录一律放行：stats 缺失时按目录处理，误放一个文件无害（队列只收 .md、reindexFile 还有守卫），
      // 误拦一个目录会让整棵子树失去监听。
      ignored: (p, stats) => {
        const rel = path.relative(rootDir, p);
        if (!rel || rel.startsWith("..")) return false; // 仓库根与库外路径必须监听
        return !isIndexWatchTarget(rel, !!stats && stats.isFile());
      },
      depth: 8,
    });
    const pending = new Set();
    watchPending = pending;
    const flush = () => {
      const files = [...pending];
      pending.clear();
      watchTimer = null;
      // shutdown 后到点的定时器：模块已关闭，直接丢弃（原先会在 null 上调 withWrite 抛未捕获异常）
      if (!service) return;
      for (const f of files) {
        const rel = path.relative(rootDir, f).replace(/\\/g, "/");
        // 与写入串行：外部编辑触发的重索引不能和 Agent 的写同时改索引行
        service
          .withWrite(() => service.reindexFile(rel))
          .then(() => emit({ type: "index", detail: `已重索引 ${rel}` }))
          .catch((e) => emit({ type: "index", detail: `重索引失败 ${rel}：${e.message}` }));
      }
    };
    const queue = (f) => {
      if (!f.endsWith(".md")) return;
      pending.add(f);
      const debounce = flatSettings()["index.debounceMs"] || 2000;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(flush, Math.max(200, debounce));
    };
    watcher.on("add", queue).on("change", queue).on("unlink", (f) => {
      if (!service) return;
      const rel = path.relative(rootDir, f).replace(/\\/g, "/");
      service
        .withWrite(() => service.index.removeByPath(rel))
        .then(() => emit({ type: "index", detail: `已移除索引 ${rel}` }))
        .catch(() => {});
    });
  } catch { /* 监听不可用时降级为手动重建 */ }
}

function stopWatch() {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  if (watchPending) watchPending.clear();
  if (!watcher) return;
  try { watcher.close(); } catch { /* 已关闭 */ }
  watcher = null;
}

// 巡检：把已注入但没有心跳的 Agent 记一次配置态校验，状态灯由前端查询驱动
async function reconcileAgents() {
  if (!access) return [];
  const list = access.list(settings().agents, service.index.beats());
  const injected = list.filter((a) => a.injected);
  emit({ type: "agents", injected: injected.length, total: list.length });
  return list;
}

// ---------- 报告 ----------

function writeReport(kind, title, lines) {
  const dir = path.join(rootDir, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${new Date().toISOString().slice(0, 10)}.md`);
  const content = `# ${title}\n\n> 生成时间：${new Date().toLocaleString("zh-CN")}\n\n${lines.join("\n")}\n`;
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
  return file;
}

function listReports(limit) {
  const dir = path.join(rootDir, "reports");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }
  return files
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit || 50);
}

// 质检护栏：开启高消耗任务时给出预计消耗（§22.8 闸门 6）
function costEstimates() {
  return {
    extract: "每批 20 条约 800 token",
    summarize: "每批 20 条约 600 token",
    tag: "每批 20 条约 400 token",
    classify: "0（本地算法）",
    supersede: "每组约 1,500 token",
    distill: "每项目约 3,000 token",
    consolidate: "每轮约 5,000 token",
    profile: "每次约 8,000 token",
    "index-scan": "0（本地扫描）",
    cleanup: "0（本地扫描）",
  };
}

// ---------- IPC 注册 ----------

function register(ipcMain) {
  const need = () => {
    if (!service) throw new Error("记忆中枢未启用（可在设置中开启）");
    return service;
  };

  // ===== 配置 =====
  ipcMain.handle("memory_config_get", handle(() => {
    init();
    // 模块停用时 init() 提前返回、memCfg 仍为 null：配置信封照样要给（设置页的模型页要读
    // models.timeout / maxRetries），否则整页报 "Cannot read properties of null"
    const cfg = ensureMemCfg();
    return ok({ config: settings(), schema: SCHEMA, root: rootDir, diff: cfg.diffFromDefaults() });
  }));
  ipcMain.handle("memory_config_save", handle(({ entries, local }) => {
    if (!entries || typeof entries !== "object") return fail("缺少配置项");
    const invalid = Object.entries(entries)
      .map(([k, v]) => {
        const meta = SCHEMA[k];
        if (!meta) return `${k}: 未知配置项`;
        return validateValue(meta, v) ? `${k}: ${validateValue(meta, v)}` : null;
      })
      .filter(Boolean);
    if (invalid.length) return fail(invalid.join("；"));
    ensureMemCfg().set(entries, { local: !!local });
    emit({ type: "config-changed", keys: Object.keys(entries) });
    // 预算闸门相关改动立即重算一次到期任务：否则要等下一个 60s tick，
    // 用户「把预算调高」后会觉得没生效（尤其按天/按周任务本来就要等到点）
    if (Object.keys(entries).some((k) => k === "auto.dailyTokenLimit" || k === "auto.overBudgetAction" || k === "auto.enabled")) {
      // _tick 会 reject（调度器自己的定时器回调也一律带 catch）：漏接会变成未处理拒绝，
      // 由全局兜底记进 crash.log。调度器未启用时 scheduler 为 null，同步抛错由 catch 吃掉
      try { void scheduler._tick().catch(() => {}); } catch { /* 调度器未启用时忽略 */ }
    }
    return ok({});
  }));
  ipcMain.handle("memory_config_reset", handle(({ keys }) => {
    ensureMemCfg().reset(Array.isArray(keys) ? keys : Object.keys(SCHEMA));
    emit({ type: "config-changed", keys: keys || "all" });
    return ok({});
  }));
  ipcMain.handle("memory_config_export", handle(() => {
    // 导出不带 Key：apiKeyRef 自 v1.23.0 起是明文，随 JSON 外发即泄密。
    // settings() 返回的是 MemoryConfig 的内存缓存对象（all() 直接返回 _cache），必须深拷贝后再抹 Key——
    // 原地改会把运行中配置的 apiKeyRef 清空，此后所有 LLM 调用取不到 Key，直到配置文件被重新读取。
    ensureMemCfg();
    const tree = JSON.parse(JSON.stringify(settings() || {}));
    if (tree && tree.models && Array.isArray(tree.models.providers)) {
      tree.models.providers = tree.models.providers.map((p) => ({ ...p, apiKeyRef: "" }));
    }
    return {
      ok: true,
      json: JSON.stringify(tree, null, 2),
    };
  }));
  ipcMain.handle("memory_config_import", handle(({ json }) => {
    let parsed;
    try { parsed = JSON.parse(json); } catch { return fail("JSON 解析失败"); }
    const entries = {};
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v) && !SCHEMA[key]) walk(v, key);
        else entries[key] = v;
      }
    };
    walk(parsed, "");
    const known = {};
    for (const [k, v] of Object.entries(entries)) if (SCHEMA[k]) known[k] = v;
    ensureMemCfg().set(known);
    return ok({ applied: Object.keys(known).length });
  }));

  // ===== 根目录 / 统计 =====
  ipcMain.handle("memory_root_get", handle(() => ok({ root: rootDir, defaultRoot: defaultRoot() })));
  ipcMain.handle("memory_root_set", handle(async ({ dir, migrate }) => {
    if (!dir) return fail("目录为空");
    const target = expandHome(dir);
    fs.mkdirSync(target, { recursive: true });
    const old = rootDir;
    // 仓库配置先写（shutdown 会清掉 memCfg）：storage.root 随 config/ 一起复制到新根，
    // 否则新根的 config.json 里残留指向旧根的指针
    ensureMemCfg().set({ "storage.root": target }, { local: true });
    try {
      const framework = configMod.loadConfig();
      framework.memory = { ...(framework.memory || {}), rootDir: target };
      configMod.saveConfig(framework);
    } catch { /* 框架配置写失败不影响仓库自身 */ }
    // 先关停再迁移：shutdown 会等在途任务/写入收尾并停掉监听，
    // 复制窗口内旧根不再有增量写入漏搬（迁移放在 shutdown 之后是刻意的）
    await shutdown();
    if (migrate && old && fs.existsSync(old) && path.resolve(old) !== path.resolve(target)) {
      copyTree(old, target, new Set(["index"]));
    }
    // 必须走 boot()：init() 只重建对象，不会重启 HTTP 桥/目录监听/调度器（换根后模块半瘫）
    await boot();
    emit({ type: "root-changed", root: target });
    return ok({ root: target, migrated: !!migrate });
  }));

  // ===== 记忆读写 =====
  ipcMain.handle("memory_stats", handle(() => ok(need().stats())));
  ipcMain.handle("memory_list", handle((args) => ok(need().list(args))));
  ipcMain.handle("memory_get", handle(({ id }) => {
    const m = need().getById(id);
    return m ? ok({ memory: m, related: need().relatedTo(id, 5), timeline: need().timeline(id) }) : fail("记忆不存在");
  }));
  ipcMain.handle("memory_write", handle((args) => need().writeMemory(args)));
  ipcMain.handle("memory_update", handle(({ id, ...patch }) => need().updateMemory(id, patch)));
  ipcMain.handle("memory_delete", handle(({ id, purge }) => need().deleteMemory(id, { purge })));
  ipcMain.handle("memory_pin", handle(({ id, value }) => need().setFlag(id, "pinned", value)));
  ipcMain.handle("memory_star", handle(({ id, value }) => need().setFlag(id, "starred", value)));
  ipcMain.handle("memory_recent", handle((args) => ok({ rows: need().recent(args) })));
  ipcMain.handle("memory_heatmap", handle(({ days }) => ok({ days: need().heatmap(days) })));
  ipcMain.handle("memory_tags", handle(() => {
    const rows = need().index.db.prepare("SELECT tags FROM mem WHERE tags IS NOT NULL AND tags != ''").all();
    const counter = new Map();
    for (const r of rows) {
      for (const t of String(r.tags).split(",")) {
        const k = t.trim();
        if (k) counter.set(k, (counter.get(k) || 0) + 1);
      }
    }
    return ok({ tags: [...counter.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 200) });
  }));

  // ===== 回收站 =====
  ipcMain.handle("memory_trash_list", handle(() => ok({ items: need().trashList() })));
  ipcMain.handle("memory_trash_restore", handle(({ name, dest }) => need().trashRestore(name, dest)));
  ipcMain.handle("memory_trash_purge", handle(({ days }) => ok(need().trashPurge(days))));

  // ===== 项目归类 =====
  ipcMain.handle("memory_projects", handle(() => ok(need().projects())));
  ipcMain.handle("memory_project_detail", handle(({ slug }) => ok(need().projectDetail(slug))));
  ipcMain.handle("memory_project_merge", handle(({ from, to }) => need().projectMerge(from, to)));
  ipcMain.handle("memory_project_rename", handle(({ slug, name, aliases }) => need().projectRename(slug, name, aliases)));
  ipcMain.handle("memory_project_assign", handle(({ ids, slug }) => need().projectAssign(ids, slug)));
  ipcMain.handle("memory_project_suggest", handle(() => ok({ items: need().projectSuggestions() })));
  ipcMain.handle("memory_project_confirm", handle(({ id, slug }) => need().confirmSuggestion(id, slug)));
  // 正式关联入口：选一个本地目录补全项目卡的远程/路径（不新建卡、不改 slug）
  ipcMain.handle("memory_project_attach", handle(({ slug, dir }) => need().projectAttachPath(slug, dir)));

  // ===== 索引与检索 =====
  // 重建完成后随事件带上诊断快照，前端据此即时刷新健康卡，不必再猜修没修好
  const diagnoseSnapshot = () => {
    const d = need().diagnose();
    const g = need().graphStats();
    return { consistent: !d.fts.rebuilt, broken: g.broken, orphan: d.orphanRows.length, unindexed: d.unindexed.length };
  };
  ipcMain.handle("memory_index_status", handle(() => ok(need().indexStatus())));
  // 「一键修复」= 按磁盘现状收敛索引：补未索引的文件 + 清磁盘已无的孤儿行。
  // 只 upsert 不 prune 的话，孤儿行只能靠全量重建清零，用户点修复只会反复看到同一句差异。
  ipcMain.handle("memory_index_build", handle(() => need().withWrite(async () => {
    const files = need().store.walkMemoryFiles();
    emit({ type: "index", running: true, done: 0, total: files.length });
    // 重算跑在 Electron 主进程：一口气同步重算全部文件会阻塞事件循环，渲染进程的
    // IPC 与 UI 全部排队（低配电脑上表现为整窗卡死数十秒）。按小批让出事件循环，
    // 宁可整体慢一点，界面保持可响应。
    const yieldUi = () => new Promise((r) => setTimeout(r, 20));
    // 批越小每段阻塞越短（低配电脑更平滑），代价是总时长略增——可接受
    const BATCH = 20;
    let done = 0;
    // 单文件异常不能中止整轮：中止会让 pruneOrphans 与 lastScanAt 都不执行。
    // failed 口径与 rebuildIndex 一致（rel + 截断后的消息）
    const failed = [];
    for (const rel of files) {
      try {
        need().reindexFile(rel);
      } catch (e) {
        failed.push({ rel, message: String(e.message || e).slice(0, 160) });
      }
      done++;
      if (done % 200 === 0) emit({ type: "index", running: true, done, total: files.length });
      if (done % BATCH === 0) await yieldUi();
    }
    const pruned = need().pruneOrphans(new Set(files));
    // 存量大小写脏数据收口：同 id 双 path（写入折小写 slug、watcher 取目录真名留下的）在这里合并成一行，
    // project 列与项目台账一并折小写。不做的话用户升级后仍是「显示两遍 + 两张卡」，要等下一次自愈扫描
    const caseFixed = need().normalizeCase(new Set(files));
    need().index.setMeta("lastScanAt", String(Date.now()));
    const diagnose = diagnoseSnapshot();
    emit({ type: "index", running: false, done, total: files.length, diagnose });
    // 返回值直接带诊断快照：前端不必再发一次 memory_index_diagnose（又一次全量扫描）
    return ok({ files: files.length, pruned, caseFixed, failed, diagnose });
  })));
  ipcMain.handle("memory_index_rebuild", handle(() => need().withWrite(async () => {
    const total = need().store.walkMemoryFiles().length;
    emit({ type: "index", running: true, done: 0, total });
    // sidecar 路径提到 try 外：catch 的失败清理要引用它，若声明在 try 内，
    // require 失败时 catch 里会先抛 ReferenceError（TDZ），把「worker 不可用」的
    // 真实原因盖掉，退化路径的 fallbackReason 变成无意义的 "sidecar is not defined"
    const sidecar = path.join(configMod.dataDir(), "memory-rebuild-sidecar.sqlite");
    // 优先走 worker 建旁路库 + 事务换入：全量重建是几十秒的同步 CPU/IO，跑在主进程会把
    // 界面、记忆中枢本地 API 与 9527 模型网关一起冻住（实测 43~56s）。worker 期间主进程
    // 照常服务读写，只有最后的换入需要独占写（实测 ~1.5s，且是单事务）。
    try {
      const { rebuildInWorker, snapshotDb, checkpointWithRetry } = require("./rebuild-worker.cjs");
      const dbFile = path.join(rootDir, "index", "memory.sqlite");
      // 先把主库 WAL 落盘再复制，保证旁路库拿到的是完整快照（占用时重试后放弃，拿陈旧快照兜底）
      checkpointWithRetry(need().index.db);
      snapshotDb(dbFile, sidecar);
      const r = await rebuildInWorker({
        servicePath: __filename.replace(/index\.cjs$/, "service.cjs"),
        root: rootDir,
        sidecar,
        deviceId: deviceId(),
        onProgress: (p) => emit({ type: "index", running: true, done: p.done, total: p.total }),
      });
      const sw = need().swapInRebuiltIndex(sidecar);
      try { fs.rmSync(sidecar, { force: true }); fs.rmSync(sidecar + "-wal", { force: true }); fs.rmSync(sidecar + "-shm", { force: true }); } catch {}
      const result = { files: r.files, failed: r.failed, tookMs: r.tookMs, swapMs: sw.tookMs, mode: "worker" };
      emit({ type: "index", running: false, done: r.files, total: r.files, tookMs: r.tookMs, diagnose: diagnoseSnapshot() });
      return ok(result);
    } catch (e) {
      // 退化路径：worker 不可用（环境异常/超时熔断）时仍走主进程同步重建，保证功能不丢；
      // 失败的旁路库（可能带着 worker 写了一半的 WAL）一并清掉，不留垃圾文件
      try { fs.rmSync(sidecar, { force: true }); fs.rmSync(sidecar + "-wal", { force: true }); fs.rmSync(sidecar + "-shm", { force: true }); } catch {}
      emit({ type: "index", running: true, done: 0, total, detail: `worker 重建不可用（${String(e.message || e).slice(0, 80)}），改用主进程重建` });
      const r = need().rebuildIndex((p) => emit({ type: "index", running: true, ...p }));
      emit({ type: "index", running: false, done: r.files, total: r.files, tookMs: r.tookMs, diagnose: diagnoseSnapshot() });
      return ok({ ...r, mode: "inline", fallbackReason: String(e.message || e) });
    }
  })));
  ipcMain.handle("memory_index_diagnose", handle(() => ok({ diagnose: need().diagnose(), graph: need().graphStats() })));
  ipcMain.handle("memory_index_vacuum", handle(() => need().vacuum()));
  ipcMain.handle("memory_search", handle((args) => {
    const cfg = flatSettings();
    const r = need().searchMemories(args.query, {
      project: args.project, agent: args.agent, layer: args.layer,
      type: args.type, tag: args.tag, starred: args.starred, pinned: args.pinned,
      limit: args.limit, includeSuperseded: args.includeSuperseded,
    }, cfg);
    // 直接复用上面这次检索的结果拼文本，不再跑第二遍 FTS
    const lines = [`检索「${args.query}」命中 ${r.total} 条，返回 ${r.results.length} 条（${r.tookMs}ms）`];
    for (const hit of r.results) {
      lines.push(`[${hit.score}] ${hit.title}${hit.superseded ? "（已失效）" : ""}`);
      lines.push(`    ${(hit.summary || "").slice(0, 120)}`);
      lines.push(`    id=${hit.id} project=${hit.project || "-"} agent=${hit.agent}`);
    }
    return ok({ ...r, text: lines.join("\n") });
  }));
  ipcMain.handle("memory_search_debug", handle(({ query, project, layer }) => {
    const svc = need();
    const cfg = flatSettings();
    const res = svc.searchMemories(query, { project, layer, limit: 10 }, cfg);
    const { tokenizeList } = require("./tokenizer.cjs");
    const { loadSynonyms } = require("./search.cjs");
    const synonyms = loadSynonyms(path.join(rootDir, "index", "synonyms.json"));
    return ok({
      tokens: tokenizeList(query || ""),
      synonyms: synonyms,
      tookMs: res.tookMs,
      total: res.total,
      fallback: res.fallback,
      results: res.results,
      explain: "评分 = BM25×0.5 + 时间衰减×0.15 + 重要度×0.1 + 亲和×0.15 + 图层×0.05 + 置顶加成",
    });
  }));
  ipcMain.handle("memory_token_estimate", handle(({ texts }) => {
    const { estimateTokens } = require("./store.cjs");
    const list = Array.isArray(texts) ? texts : [texts || ""];
    const per = list.map((t) => estimateTokens(t));
    return ok({ per, total: per.reduce((a, b) => a + b, 0), note: "按 CJK≈1 token/字、ASCII≈0.25 token/字符估算，非计费值" });
  }));
  ipcMain.handle("memory_graph_stats", handle(() => ok(need().graphStats())));
  ipcMain.handle("memory_digest", handle(({ maxLines }) => {
    const svc = need();
    const d = svc.digest(maxLines);
    const text = svc.digestText(maxLines);
    return ok({ ...d, text: text.text, lines: text.lines });
  }));
  ipcMain.handle("memory_timeline", handle((args) => ok(need().timelineFor(args))));
  ipcMain.handle("memory_supersede", handle(({ id, byId, reason }) => need().markSuperseded(id, byId, reason)));

  // ===== Agent 接入 =====
  ipcMain.handle("memory_agents_list", handle(async () => {
    init();
    const list = access.list(settings().agents, service.index.beats());
    return ok({ agents: list, command: access.connection(), bridge: httpApi ? httpApi.status() : { running: false } });
  }));
  ipcMain.handle("memory_agent_verify", handle(({ id, skipHandshake }) =>
    access.verifyOne(id, settings().agents, service.index.beats(), { skipHandshake })));
  ipcMain.handle("memory_agent_verify_all", handle(() => access.verifyAll(settings().agents, service.index.beats())));
  ipcMain.handle("memory_agent_inject", handle(({ id }) => access.injectOne(id, settings().agents)));
  ipcMain.handle("memory_agent_uninject", handle(({ id }) => access.uninjectOne(id, settings().agents)));
  ipcMain.handle("memory_agent_snippet", handle(({ id, format }) => access.snippet(id, settings().agents, format)));
  ipcMain.handle("memory_agent_custom_save", handle(({ entry }) => {
    const r = access.saveCustom(settings().agents.custom, entry, settings().agents);
    if (!r.ok) return fail(r.message);
    memCfg.set({ "agents.custom": r.list }, { local: true });
    return ok({ id: r.id });
  }));
  ipcMain.handle("memory_agents_tools", handle(() => ok({ tools: access.toolsTable() })));
  ipcMain.handle("memory_bridge_status", handle(() => ok({ bridge: httpApi ? httpApi.status() : { running: false }, root: rootDir })));
  ipcMain.handle("memory_bridge_restart", handle(async () => {
    if (!httpApi) {
      httpApi = new MemoryHttpApi(need(), runtimeFile(), { onEvent: (p) => emit(p) });
      const r = await httpApi.start();
      return ok({ port: r.port });
    }
    const r = await httpApi.restart();
    return ok({ port: r.port });
  }));

  // ===== 报告 / 导出 / 备份 =====
  ipcMain.handle("memory_reports_list", handle(() => ok({ reports: listReports(50) })));
  ipcMain.handle("memory_report_read", handle(({ name }) => {
    const file = path.join(rootDir, "reports", path.basename(String(name)));
    if (!fs.existsSync(file)) return fail("报告不存在");
    return ok({ name: path.basename(file), content: fs.readFileSync(file, "utf8") });
  }));
  ipcMain.handle("memory_export", handle(({ scope }) => {
    const svc = need();
    const lines = [`# 记忆导出 · ${scope || "全部"}`, ""];
    const files = svc.store.walkMemoryFiles().filter((f) => !scope || f.includes(scope));
    // 总量闸门：全量逐文件读+拼字符串，大仓库不加顶会把主进程 OOM
    const MAX_EXPORT = 32 * 1024 * 1024;
    let size = 0;
    let truncated = 0;
    for (const rel of files) {
      if (size > MAX_EXPORT) { truncated++; continue; }
      const text = svc.store.read(rel);
      if (text) {
        lines.push(`## ${rel}`, "", text, "");
        size += Buffer.byteLength(text, "utf8");
      }
    }
    if (truncated) lines.push("", `> 超出 32MB 导出上限，省略 ${truncated} 个文件（完整备份请用「导出压缩包」）`);
    return ok({ content: lines.join("\n"), files: files.length, truncated });
  }));
  ipcMain.handle("memory_export_zip", handle(async () => {
    const dir = path.join(configMod.dataDir(), "memory-export");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `memory-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
    // worker 化：整树 tar+gzip 是几十秒的同步 CPU/IO 大头，原先在主进程里做会把 UI 与模型网关一起冻住
    const { packDirAsync } = require("../tarpack.cjs");
    const count = await packDirAsync(rootDir, out);
    const bytes = (() => { try { return fs.statSync(out).size; } catch { return 0; } })();
    return ok({ file: out, files: count, bytes });
  }));
  ipcMain.handle("memory_open_dir", handle(({ rel }) => {
    // 只允许打开仓库内的路径：渲染层传来的 rel 不能越过根目录（Windows 上 openPath 对 .exe 等于执行）
    let target = path.resolve(rootDir);
    if (rel) {
      const candidate = path.resolve(rootDir, String(rel));
      const relToRoot = path.relative(path.resolve(rootDir), candidate);
      // 只拦真正的越界段：startsWith("..") 会误伤仓库内名为 "..foo" 的合法条目
      if (relToRoot === ".." || relToRoot.startsWith(".." + path.sep) || path.isAbsolute(relToRoot)) return fail("路径越界：只能打开仓库目录内的路径");
      target = candidate;
    }
    if (!electron || !electron.shell) return fail("当前环境不支持打开目录");
    void electron.shell.openPath(target);
    return ok({ path: target });
  }));
  ipcMain.handle("memory_costs_estimate", handle(() => ok({ estimates: costEstimates() })));

  // ===== 隐私 / 状态 =====
  ipcMain.handle("memory_status", handle(() => status()));
  ipcMain.handle("memory_toggle", handle(async ({ enabled }) => {
    const framework = configMod.loadConfig();
    // modules.memory.enabled 是唯一事实源（issue #91）；memory.enabled 旧字段同步写，
    // 兼容回滚到旧版本时不丢开关状态
    const on = enabled !== false;
    framework.memory = { ...(framework.memory || {}), enabled: on };
    framework.modules = { ...(framework.modules || {}), memory: { ...((framework.modules || {}).memory || {}), enabled: on } };
    configMod.saveConfig(framework);
    if (on) await boot();
    else await shutdown();
    return ok({ enabled: on });
  }));

  // ===== 模型与网关（供应商 / 模型池 / 路由 / 三级测试） =====
  // 全部走 providerStore()：记忆中枢停用后这里仍然可读写（见该函数注释），
  // 设置页的「模型与网关」不再随板块开关一起失效。
  ipcMain.handle("memory_provider_list", handle(() => ok({ providers: providerStore().list() })));
  ipcMain.handle("memory_gateway_list", handle(() => ok({ gateways: providerStore().gateways() })));
  ipcMain.handle("memory_provider_save", handle((input) => {
    const r = providerStore().save(input);
    return r.ok ? ok({ id: r.id }) : fail(r.message);
  }));
  ipcMain.handle("memory_provider_delete", handle(({ id }) => providerStore().remove(id)));
  ipcMain.handle("memory_provider_toggle", handle(({ id, enabled }) => providerStore().toggleProvider(id, enabled)));
  ipcMain.handle("memory_provider_test", handle(({ id, modelId }) => providerStore().test(id, modelId)));
  ipcMain.handle("memory_provider_fetch_models", handle(({ id }) => providerStore().fetchModels(id)));
  ipcMain.handle("memory_provider_quirks", handle(({ id }) => ok(providerStore().quirks(id))));
  ipcMain.handle("memory_model_list", handle(({ providerId }) => ok({ models: providerStore().listModels(providerId) })));
  ipcMain.handle("memory_model_save", handle((input) => {
    const r = providerStore().saveModel(input);
    return r.ok ? ok({ id: r.id }) : fail(r.message);
  }));
  ipcMain.handle("memory_model_delete", handle(({ id }) => providerStore().deleteModel(id)));
  ipcMain.handle("memory_model_toggle", handle(({ id, enabled }) => providerStore().toggleModel(id, enabled)));
  ipcMain.handle("memory_model_batch", handle(({ ids, op, value }) => providerStore().batchModel(ids || [], op, value)));
  ipcMain.handle("memory_model_probe", handle(({ id }) => providerStore().probeModel(id)));
  ipcMain.handle("memory_llm_sources", handle(() => ok(providerStore().sources())));
  ipcMain.handle("memory_llm_sources_save", handle((payload) => providerStore().saveSources(payload)));
  ipcMain.handle("memory_llm_routing", handle(() => ok({ routing: providerStore().routingPreview() })));
  ipcMain.handle("memory_llm_routing_save", handle((payload) => providerStore().saveSources(payload)));
  ipcMain.handle("memory_llm_test_call", handle(({ providerId, modelId, effort }) => providerStore().testCall(providerId, modelId, effort)));
  // 用量表在记忆中枢的索引库里：模块停用时如实返回空，不让「设置 · 模型与网关」跟着报错
  ipcMain.handle("memory_llm_usage", handle(({ days }) => ok({
    usage: providerStore().usage(days),
    today: service ? service.index.llmUsageToday() : { tokens: 0, calls: 0 },
  })));

  // ===== 自动化任务 =====
  ipcMain.handle("memory_auto_status", handle(() => ok(scheduler.status())));
  ipcMain.handle("memory_auto_timeline", handle(({ limit }) => ok({ entries: scheduler.timeline(limit) })));
  // 手动执行走 requestRun：入队而非强占，忙时排队（不再报「已有任务在跑」）
  ipcMain.handle("memory_auto_task_run", handle(({ id }) => scheduler.requestRun(id)));
  ipcMain.handle("memory_auto_pause", handle(({ until, resume }) => {
    if (resume) scheduler.resume();
    else scheduler.pause(until);
    return ok(scheduler.status());
  }));
  ipcMain.handle("memory_auto_cancel", handle(() => scheduler.cancel()));
  ipcMain.handle("memory_auto_task_save", handle(({ id, patch }) => {
    const tasks = { ...(need().flat()["auto.tasks"] || {}) };
    tasks[id] = { ...(tasks[id] || {}), ...(patch || {}) };
    memCfg.set({ "auto.tasks": tasks }, { local: false });
    emit({ type: "config-changed", keys: [`auto.tasks.${id}`] });
    return ok({ tasks });
  }));
  ipcMain.handle("memory_auto_cost", handle(() => {
    const usage = need().index.llmUsageByProvider(30);
    const byTask = new Map();
    for (const row of usage) byTask.set(row.task, (byTask.get(row.task) || 0) + row.tokensIn + row.tokensOut);
    const today = need().index.llmUsageToday();
    const limit = Number(flatSettings()["auto.dailyTokenLimit"] ?? 200000);
    const month = need().index.db.prepare("SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS t FROM llm_call WHERE ts >= ?").get(Date.now() - 30 * 86400000).t;
    return ok({
      today: today.tokens,
      todayCalls: today.calls,
      month,
      limit,
      byTask: [...byTask.entries()].map(([task, tokens]) => ({ task, tokens })).sort((a, b) => b.tokens - a.tokens),
      estimates: costEstimates(),
    });
  }));
  ipcMain.handle("memory_auto_report", handle(() => {
    const st = scheduler.status();
    const lines = [
      "## 任务状态",
      ...st.tasks.map((t) => `- ${t.name}（${t.id}）：${t.enabled ? "开" : "关"} · 成功率 ${t.successRate ?? "—"}% · 累计 ${t.tokens} token`),
      "",
      "## 今日消耗",
      `${st.todayTokens} / ${st.dailyTokenLimit} token（${st.todayCalls} 次调用）`,
    ];
    const file = writeReport("auto", "自动化报告", lines);
    return ok({ file });
  }));

  // ===== 深层记忆 / 蒸馏 / 画像 =====
  ipcMain.handle("memory_distill_run", handle(({ project }) => tasksRunner.runDistill({ project })));
  ipcMain.handle("memory_profile_generate", handle(() => tasksRunner.runProfile({})));
  // ===== 记忆体检（纯本地统计）：手动触发 + 取最近一次报告 =====
  ipcMain.handle("memory_health_run", handle(() => scheduler.runTask("health")));
  ipcMain.handle("memory_health_get", handle(() => {
    const raw = service && service.index ? service.index.getMeta("mem_health_report") : null;
    if (!raw) return ok({ report: null });
    try { return ok({ report: JSON.parse(raw) }); } catch { return ok({ report: null }); }
  }));
  ipcMain.handle("memory_profile_get", handle(() => {
    // 读取前自愈兜底：若本地文件因版本更新或仓库重置缺失，自动从全局持久缓存恢复
    // （need() 返回的就是 MemoryService 本身，没有 .service 属性——写成 need().service
    // 会在回调里 TypeError 且被外层空 catch 吞掉，自愈重索引从未生效）
    try {
      profileCache.restoreIfMissing(need().store, configMod.dataDir(), (rel) => need().reindexFile(rel));
    } catch {}

    const names = ["persona", "preferences", "tech", "habits"];
    const sections = names.map((n) => {
      const rel = `profile/${n}.md`;
      const text = need().store.read(rel);
      return { name: n, path: rel, text: text || "", exists: text != null && text.trim().length > 0 };
    });
    // 本地有内容时同步更新全局持久缓存，保障双向镜像
    try {
      profileCache.syncStoreToCache(need().store, configMod.dataDir());
    } catch {}

    const historyDir = need().store.abs("profile/.history");
    let history = [];
    try {
      history = fs.readdirSync(historyDir).sort().reverse().slice(0, 50).map((f) => ({ name: f, mtime: fs.statSync(path.join(historyDir, f)).mtimeMs }));
    } catch { /* 无历史 */ }
    const cacheMeta = profileCache.loadCache(configMod.dataDir());
    return ok({
      sections,
      history,
      lastAt: Number(need().index.getMeta("mem_sched_profile") || (cacheMeta && cacheMeta.updatedAt) || 0),
      hasCache: !!(cacheMeta && cacheMeta.sections && Object.keys(cacheMeta.sections).length > 0),
    });
  }));
  ipcMain.handle("memory_profile_save", handle(({ name, text }) => {
    if (!["persona", "preferences", "tech", "habits"].includes(name)) return fail("未知画像分区");
    need().store.writeAtomic(`profile/${name}.md`, text, { backup: true });
    try {
      profileCache.saveCache(configMod.dataDir(), { [name]: text }, { updatedAt: Date.now() });
    } catch {}
    return ok({});
  }));
  ipcMain.handle("memory_review_list", handle(({ kind }) => {
    // 惰性清扫：引用已消失/损坏的 pending 建议先作废，死项不再出现在收件箱里
    need().index.sweepStaleReview();
    return ok({ items: need().index.reviewList("pending", kind) });
  }));
  ipcMain.handle("memory_review_resolve", handle(({ id, action, payload }) => resolveReview(need(), id, action, payload)));

  // ===== WebDAV 同步 =====
  ipcMain.handle("memory_sync_status", handle(() => ok({ ...syncer.progress(), configured: syncer.configured() })));
  ipcMain.handle("memory_sync_run", handle(async () => syncer.run()));
  ipcMain.handle("memory_sync_cancel", handle(() => syncer.cancel()));
  ipcMain.handle("memory_sync_logs", handle(({ limit }) => ok({ logs: syncer.logs(limit) })));
  ipcMain.handle("memory_conflicts_list", handle(() => ok({ conflicts: syncer.conflictsList() })));
  ipcMain.handle("memory_conflicts_diff", handle(({ index }) => syncer.conflictDiff(index)));
  ipcMain.handle("memory_conflicts_resolve", handle(({ index, decision, mergedText }) => syncer.resolve(index, decision, mergedText)));
  ipcMain.handle("memory_conflicts_resolve_recommended", handle(({ items }) => syncer.resolveMany(items)));
  ipcMain.handle("memory_sync_devices", handle(async () => ok({ devices: await syncer.refreshDevices(), deviceId: deviceId() })));
  ipcMain.handle("memory_sync_packs", handle(() => ok({ packs: syncer.packs() })));

  // ===== 记忆中枢：去重 =====
  ipcMain.handle("memory_dedup_status", handle(() => ok(dedupEngine.status())));
  ipcMain.handle("memory_dedup_scan", handle(({ useModel }) => dedupEngine.scanAll({ useModel: useModel !== false })));
  ipcMain.handle("memory_dedup_review_list", handle(() => {
    need().index.sweepStaleReview();
    return ok({ items: need().index.reviewList("pending", "dedup") });
  }));
  ipcMain.handle("memory_dedup_review_resolve", handle(({ id, action, payload }) => dedupEngine.resolveQueue(id, action, payload)));
  ipcMain.handle("memory_dedup_pairs_get", handle(() => ok({ pairs: dedupEngine.learnedList() })));
  ipcMain.handle("memory_dedup_pairs_clear", handle(({ pair }) => dedupEngine.clearLearned(pair)));
  ipcMain.handle("memory_dedup_layer_toggle", handle(({ layer, enabled }) => {
    const map = { l1: "dedup.l1.enabled", l2: "dedup.l2.enabled", l4: "dedup.l4.enabled" };
    const key = map[layer];
    if (!key) return fail("未知层");
    memCfg.set({ [key]: enabled !== false });
    return ok({});
  }));

  // ===== 记忆中枢：导入引擎 =====
  ipcMain.handle("memory_import_sources", handle(() => ok(importer.scan())));
  ipcMain.handle("memory_import_source_save", handle(({ list }) => importer.saveSources(list)));
  ipcMain.handle("memory_import_source_detect", handle(({ id, path: p }) => {
    // 渲染层可传任意路径做探测（会回读目录清单/文件样本）：敏感目录一律拒绝
    const target = String(p || "");
    if (target && /(\.ssh|\.aws|\.gnupg|\.gnupg\.d|[\\/]\.env$|ntuser\.|sam$|[\\/]windows[\\/]|[\\/]program files)/i.test(target)) {
      return fail("该路径属于系统或凭据目录，不能作为导入来源");
    }
    const src = importer.sources().find((s) => s.id === id) || { id, path: p, kind: "jsonl" };
    const detect = require("./import/parsers.cjs").detectSource({ ...src, path: p || src.path });
    return ok({ detect });
  }));
  ipcMain.handle("memory_import_preview", handle((args) => importer.preview(args)));
  ipcMain.handle("memory_import_apply", handle((args) => importer.apply(args)));
  ipcMain.handle("memory_import_cancel", handle(() => importer.cancel()));
  ipcMain.handle("memory_import_progress", handle(() => ok(importer.progress())));
  ipcMain.handle("memory_import_report", handle(() => importer.report()));
  ipcMain.handle("memory_import_cursors_get", handle(() => importer.cursors()));
  ipcMain.handle("memory_import_cursors_reset", handle(({ id }) => importer.resetCursor(id)));
  ipcMain.handle("memory_import_map_save", handle(({ id, mapping }) => importer.mapSave(id, mapping)));
}

/** 队列项引用的记忆是否已消失（与 service 层判存在口径一致，与 indexer.sweepStaleReview 同源）。
    这类建议没有任何可执行动作：作废收口，不能让用户在"处理失败"上反复点击。 */
function staleRefReason(svc, kind, data) {
  if (kind === "supersede") {
    if (!data.oldId) return "建议缺少原记忆引用";
    if (!svc.getById(data.oldId)) return `原记忆 ${data.oldId} 已不存在`;
    return "";
  }
  if (kind === "classify") {
    if (!data.memoryId) return "建议缺少记忆引用";
    if (!svc.getById(data.memoryId)) return `记忆 ${data.memoryId} 已不存在`;
    return "";
  }
  return "";
}

/** 待确认队列裁决：失效建议 / 归类建议 */
async function resolveReview(svc, id, action, payload) {
  const row = svc.index.db.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
  if (!row) return fail("待确认项不存在");
  // 与 confirmSuggestion 同口径：payload 因历史脏数据/手工改库损坏时显式失败，
  // 不让 JSON.parse 的英文异常冒给前端
  let data;
  try {
    data = JSON.parse(row.payload || "{}");
  } catch {
    return fail("待确认项数据损坏，无法解析");
  }
  if (!data || typeof data !== "object") return fail("待确认项数据损坏，无法解析");
  // 引用的记忆已消失（被删除/合并/清理，或模型输出 id 时漂移）→ 作废并如实告知
  const stale = staleRefReason(svc, row.kind, data);
  if (stale) {
    // 只读库写不进作废标记：如实失败，不能报"已作废"却没落库（与其它动作的只读口径一致）
    if (!svc.index.reviewResolve(id, "stale")) return fail("索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再操作");
    return ok({ stale: true, message: `${stale}（可能已被删除或并入其它记忆），该建议已自动作废` });
  }
  if (row.kind === "supersede") {
    if (action === "confirm") {
      const r = await svc.markSuperseded(data.oldId, data.newId, data.reason || "人工确认失效");
      if (!r.ok) return fail(r.message || "执行失败");
      svc.index.reviewResolve(id, "confirmed");
      return ok({});
    }
    if (action === "dismiss") {
      svc.index.reviewResolve(id, "dismissed");
      return ok({});
    }
    if (action === "merge" && data.newId) {
      const old = svc.getById(data.oldId);
      const next = svc.getById(data.newId);
      if (!old || !next) {
        if (!svc.index.reviewResolve(id, "stale")) return fail("索引库来自更新版本的 AgentHub，当前处于只读模式：请升级应用后再操作");
        return ok({ stale: true, message: "要合并的记忆之一已不存在（可能已被删除或并入其它记忆），该建议已自动作废" });
      }
      // 两步都成功才收口（与 dedup.resolveQueue 的 merge 同口径）：
      // 原先不查返回值就 resolve，只读/节丢失等失败会被静默吞成"假成功"
      const ur = await svc.updateMemory(data.newId, { body: `${next.body}\n\n---\n\n（来自 ${old.id}）\n${old.body}` });
      if (!ur.ok) return fail(ur.message || "合并写入失败，队列项保留");
      const r = await svc.markSuperseded(data.oldId, data.newId, "人工选择合并");
      if (!r.ok) return fail(r.message || "标记旧记忆失效失败，队列项保留");
      svc.index.reviewResolve(id, "merged");
      return ok({});
    }
    return fail("未知裁决动作");
  }
  if (row.kind === "classify") {
    if (action === "assign") {
      const r = await svc.projectAssign([data.memoryId], payload && payload.slug ? payload.slug : data.slug);
      // 失败不 resolve：原写法不查返回值就 resolve，只读等失败会被静默吞掉
      if (r && r.ok === false) return fail(r.message || "归入失败，队列项保留");
      svc.index.reviewResolve(id, `assign:${(payload && payload.slug) || data.slug}`);
      return ok({});
    }
    if (action === "newProject" && payload && payload.name) {
      const r = await svc.projectAssign([data.memoryId], payload.name);
      if (r && r.ok === false) return fail(r.message || "归入失败，队列项保留");
      svc.index.reviewResolve(id, `newProject:${payload.name}`);
      return ok({});
    }
    if (action === "general") {
      svc.index.reviewResolve(id, "general");
      return ok({});
    }
    if (action === "dismiss") {
      svc.index.reviewResolve(id, "dismissed");
      return ok({});
    }
    return fail("未知裁决动作");
  }
  if (action === "dismiss") {
    svc.index.reviewResolve(id, "dismissed");
    return ok({});
  }
  return fail(`暂不支持的队列类型：${row.kind}`);
}

function copyTree(from, to, skipDirs) {
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d);
      else if (e.isFile()) {
        try { fs.copyFileSync(s, d); } catch { /* 单文件失败继续 */ }
      }
    }
  };
  walk(from, to);
}

module.exports = {
  init, boot, shutdown, register, status, settings, flatSettings, emit,
  tools, agents, runtimeFile,
  // 自测钩子：待确认裁决入口（覆盖"引用已消失 → 自动作废"分支），svc 由调用方提供
  resolveReview,
  get service() { return service; },
  get rootDir() { return rootDir; },
  // 自测钩子（只读）：断言调度器装配完整，如 scheduler.syncer 是否真的挂上了
  get scheduler() { return scheduler; },
  get syncer() { return syncer; },
  // 平台级模型调用入口：提示词库（第五板块）的「优化提示词」直接复用它，
  // 走惰性 providerStore()，因此记忆中枢板块停用时仍可用（与「设置 · 模型与网关」同口径）
  get llmClient() { return providerStore().client; },
};
