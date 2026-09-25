/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 模块编排层：装配 配置/存储/索引/检索/接入服务，注册全部 memory_* IPC，广播 memory 事件。
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
const { SCHEMA, defaultConfig: schemaDefaults, validateValue } = require("./config-schema.cjs");

let service = null;
let memCfg = null;
let httpApi = null;
let access = null;
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
let gatewayProbe = () => ({ available: false, baseUrl: "" });

function ok(data) { return { ok: true, ...(data || {}) }; }
function fail(message) { return { ok: false, message: String((message && message.message) || message) }; }

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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    value.available = res.ok;
  } catch {
    value.available = false;
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

// ---------- 生命周期 ----------

function init() {
  const framework = configMod.loadConfig();
  if (framework.memory && framework.memory.enabled === false) {
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
  scheduler.dedup = dedupEngine;
  scheduler.syncer = syncer;
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
    getConfig: () => service.flat(),
    moduleWebdav: (key) => configMod.moduleWebdav(key),
    emit,
    rootDir,
    dataDir: configMod.dataDir(),
  });
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
  if (flatSettings()["agents.autoVerify"] !== false) {
    // 异步巡检，不阻塞启动
    setTimeout(() => reconcileAgents().catch(() => {}), 4000);
  }
  return r;
}

async function shutdown() {
  stopWatch();
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
  const tmp = `${file}.tmp`;
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
  };
}

// ---------- IPC 注册 ----------

function register(ipcMain) {
  const need = () => {
    if (!service) throw new Error("记忆仓库未启用（可在设置中开启）");
    return service;
  };

  // ===== 配置 =====
  ipcMain.handle("memory_config_get", handle(() => {
    init();
    return ok({ config: settings(), schema: SCHEMA, root: rootDir, diff: memCfg.diffFromDefaults() });
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
    memCfg.set(entries, { local: !!local });
    emit({ type: "config-changed", keys: Object.keys(entries) });
    return ok({});
  }));
  ipcMain.handle("memory_config_reset", handle(({ keys }) => {
    memCfg.reset(Array.isArray(keys) ? keys : Object.keys(SCHEMA));
    emit({ type: "config-changed", keys: keys || "all" });
    return ok({});
  }));
  ipcMain.handle("memory_config_export", handle(() => {
    // 导出不带 Key：apiKeyRef 自 v1.23.0 起是明文，随 JSON 外发即泄密
    const tree = settings();
    if (tree && tree.models && Array.isArray(tree.models.providers)) {
      tree.models = { ...tree.models, providers: tree.models.providers.map((p) => ({ ...p, apiKeyRef: "" })) };
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
    memCfg.set(known);
    return ok({ applied: Object.keys(known).length });
  }));

  // ===== 根目录 / 统计 =====
  ipcMain.handle("memory_root_get", handle(() => ok({ root: rootDir, defaultRoot: defaultRoot() })));
  ipcMain.handle("memory_root_set", handle(async ({ dir, migrate }) => {
    if (!dir) return fail("目录为空");
    const target = expandHome(dir);
    fs.mkdirSync(target, { recursive: true });
    const old = rootDir;
    if (migrate && old && fs.existsSync(old) && path.resolve(old) !== path.resolve(target)) {
      copyTree(old, target, new Set(["index"]));
    }
    memCfg.set({ "storage.root": target }, { local: true });
    try {
      const framework = configMod.loadConfig();
      framework.memory = { ...(framework.memory || {}), rootDir: target };
      configMod.saveConfig(framework);
    } catch { /* 框架配置写失败不影响仓库自身 */ }
    await shutdown();
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
    let done = 0;
    for (const rel of files) {
      need().reindexFile(rel);
      done++;
      if (done % 200 === 0) emit({ type: "index", running: true, done, total: files.length });
    }
    const pruned = need().pruneOrphans(new Set(files));
    need().index.setMeta("lastScanAt", String(Date.now()));
    emit({ type: "index", running: false, done, total: files.length, diagnose: diagnoseSnapshot() });
    return ok({ files: files.length, pruned });
  })));
  ipcMain.handle("memory_index_rebuild", handle(() => need().withWrite(async () => {
    emit({ type: "index", running: true, done: 0, total: need().store.walkMemoryFiles().length });
    const r = need().rebuildIndex((p) => emit({ type: "index", running: true, ...p }));
    emit({ type: "index", running: false, done: r.files, total: r.files, tookMs: r.tookMs, diagnose: diagnoseSnapshot() });
    return ok(r);
  })));
  ipcMain.handle("memory_index_diagnose", handle(() => ok({ diagnose: need().diagnose(), graph: need().graphStats() })));
  ipcMain.handle("memory_index_vacuum", handle(() => need().vacuum()));
  ipcMain.handle("memory_search", handle((args) => {
    const cfg = flatSettings();
    const r = need().searchMemories(args.query, {
      project: args.project, agent: args.agent, layer: args.layer,
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
  ipcMain.handle("memory_export_zip", handle(() => {
    const dir = path.join(configMod.dataDir(), "memory-export");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `memory-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
    const { packDir } = require("../tarpack.cjs");
    const count = packDir(rootDir, out);
    const bytes = (() => { try { return fs.statSync(out).size; } catch { return 0; } })();
    return ok({ file: out, files: count, bytes });
  }));
  ipcMain.handle("memory_open_dir", handle(({ rel }) => {
    // 只允许打开仓库内的路径：渲染层传来的 rel 不能越过根目录（Windows 上 openPath 对 .exe 等于执行）
    let target = path.resolve(rootDir);
    if (rel) {
      const candidate = path.resolve(rootDir, String(rel));
      const relToRoot = path.relative(path.resolve(rootDir), candidate);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return fail("路径越界：只能打开仓库目录内的路径");
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
    framework.memory = { ...(framework.memory || {}), enabled: enabled !== false };
    configMod.saveConfig(framework);
    if (framework.memory.enabled) await boot();
    else await shutdown();
    return ok({ enabled: framework.memory.enabled });
  }));

  // ===== 模型与网关（供应商 / 模型池 / 路由 / 三级测试） =====
  ipcMain.handle("memory_provider_list", handle(() => ok({ providers: providers.list() })));
  ipcMain.handle("memory_gateway_list", handle(() => ok({ gateways: providers.gateways() })));
  ipcMain.handle("memory_provider_save", handle((input) => {
    const r = providers.save(input);
    return r.ok ? ok({ id: r.id }) : fail(r.message);
  }));
  ipcMain.handle("memory_provider_delete", handle(({ id }) => providers.remove(id)));
  ipcMain.handle("memory_provider_test", handle(({ id, modelId }) => providers.test(id, modelId)));
  ipcMain.handle("memory_provider_fetch_models", handle(({ id }) => providers.fetchModels(id)));
  ipcMain.handle("memory_provider_quirks", handle(({ id }) => ok(providers.quirks(id))));
  ipcMain.handle("memory_model_list", handle(({ providerId }) => ok({ models: providers.listModels(providerId) })));
  ipcMain.handle("memory_model_save", handle((input) => {
    const r = providers.saveModel(input);
    return r.ok ? ok({ id: r.id }) : fail(r.message);
  }));
  ipcMain.handle("memory_model_delete", handle(({ id }) => providers.deleteModel(id)));
  ipcMain.handle("memory_model_toggle", handle(({ id, enabled }) => providers.toggleModel(id, enabled)));
  ipcMain.handle("memory_model_batch", handle(({ ids, op, value }) => providers.batchModel(ids || [], op, value)));
  ipcMain.handle("memory_model_probe", handle(({ id }) => providers.probeModel(id)));
  ipcMain.handle("memory_llm_sources", handle(() => ok(providers.sources())));
  ipcMain.handle("memory_llm_sources_save", handle((payload) => providers.saveSources(payload)));
  ipcMain.handle("memory_llm_routing", handle(() => ok({ routing: providers.routingPreview() })));
  ipcMain.handle("memory_llm_routing_save", handle((payload) => providers.saveSources(payload)));
  ipcMain.handle("memory_llm_test_call", handle(({ providerId, modelId, effort }) => providers.testCall(providerId, modelId, effort)));
  ipcMain.handle("memory_llm_usage", handle(({ days }) => ok({ usage: providers.usage(days), today: need().index.llmUsageToday() })));

  // ===== 自动化任务 =====
  ipcMain.handle("memory_auto_status", handle(() => ok(scheduler.status())));
  ipcMain.handle("memory_auto_timeline", handle(({ limit }) => ok({ entries: scheduler.timeline(limit) })));
  ipcMain.handle("memory_auto_task_run", handle(({ id }) => scheduler.runTask(id, { batchSize: undefined })));
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
  ipcMain.handle("memory_profile_get", handle(() => {
    const names = ["persona", "preferences", "tech", "habits"];
    const sections = names.map((n) => {
      const rel = `profile/${n}.md`;
      const text = need().store.read(rel);
      return { name: n, path: rel, text: text || "", exists: text != null };
    });
    const historyDir = need().store.abs("profile/.history");
    let history = [];
    try {
      history = fs.readdirSync(historyDir).sort().reverse().slice(0, 50).map((f) => ({ name: f, mtime: fs.statSync(path.join(historyDir, f)).mtimeMs }));
    } catch { /* 无历史 */ }
    return ok({ sections, history, lastAt: Number(need().index.getMeta("mem_sched_profile") || 0) });
  }));
  ipcMain.handle("memory_profile_save", handle(({ name, text }) => {
    if (!["persona", "preferences", "tech", "habits"].includes(name)) return fail("未知画像分区");
    need().store.writeAtomic(`profile/${name}.md`, text, { backup: true });
    return ok({});
  }));
  ipcMain.handle("memory_review_list", handle(({ kind }) => ok({ items: need().index.reviewList("pending", kind) })));
  ipcMain.handle("memory_review_resolve", handle(({ id, action, payload }) => resolveReview(need(), id, action, payload)));

  // ===== WebDAV 同步 =====
  ipcMain.handle("memory_sync_status", handle(() => ok({ ...syncer.progress(), configured: syncer.configured() })));
  ipcMain.handle("memory_sync_run", handle(async () => syncer.run()));
  ipcMain.handle("memory_sync_cancel", handle(() => syncer.cancel()));
  ipcMain.handle("memory_sync_logs", handle(({ limit }) => ok({ logs: syncer.logs(limit) })));
  ipcMain.handle("memory_conflicts_list", handle(() => ok({ conflicts: syncer.conflictsList() })));
  ipcMain.handle("memory_conflicts_diff", handle(({ index }) => syncer.conflictDiff(index)));
  ipcMain.handle("memory_conflicts_resolve", handle(({ index, decision, mergedText }) => syncer.resolve(index, decision, mergedText)));
  ipcMain.handle("memory_sync_devices", handle(async () => ok({ devices: await syncer.refreshDevices(), deviceId: deviceId() })));
  ipcMain.handle("memory_sync_packs", handle(() => ok({ packs: syncer.packs() })));

  // ===== 记忆仓库：去重 =====
  ipcMain.handle("memory_dedup_status", handle(() => ok(dedupEngine.status())));
  ipcMain.handle("memory_dedup_scan", handle(({ useModel }) => dedupEngine.scanAll({ useModel: useModel !== false })));
  ipcMain.handle("memory_dedup_review_list", handle(() => ok({ items: need().index.reviewList("pending", "dedup") })));
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

  // ===== 记忆仓库：导入引擎 =====
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

/** 待确认队列裁决：失效建议 / 归类建议 */
async function resolveReview(svc, id, action, payload) {
  const row = svc.index.db.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
  if (!row) return fail("待确认项不存在");
  const data = JSON.parse(row.payload || "{}");
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
      if (old && next) {
        await svc.updateMemory(data.newId, { body: `${next.body}\n\n---\n\n（来自 ${old.id}）\n${old.body}` });
        await svc.markSuperseded(data.oldId, data.newId, "人工选择合并");
      }
      svc.index.reviewResolve(id, "merged");
      return ok({});
    }
    return fail("未知裁决动作");
  }
  if (row.kind === "classify") {
    if (action === "assign") {
      const r = await svc.projectAssign([data.memoryId], payload && payload.slug ? payload.slug : data.slug);
      svc.index.reviewResolve(id, `assign:${(payload && payload.slug) || data.slug}`);
      return ok(r);
    }
    if (action === "newProject" && payload && payload.name) {
      const r = await svc.projectAssign([data.memoryId], payload.name);
      svc.index.reviewResolve(id, `newProject:${payload.name}`);
      return ok(r);
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
  get service() { return service; },
  get rootDir() { return rootDir; },
};
