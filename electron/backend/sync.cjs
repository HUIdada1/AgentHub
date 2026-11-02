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
// 4 阶段同步引擎：抽取 → 上传 → 拉取 → 合并
// 本地模式（未配置 WebDAV 或强制备份 mode=backup）：抽取 → 打包备份（本机 zip 快照），跳过全部远程阶段
// WebDAV 布局：usage-tracker/devices/<deviceId>.json（设备元数据）
//             usage-tracker/data/<deviceId>/<YYYY-MM-DD>.jsonl.gz（UTC 日分片，gzip 压缩）
// 幂等：本地按 id 去重（INSERT OR REPLACE）；远端日分片上传前先读回、按 id 取并集再整体覆盖写，
//       因此本地缓存被清空/换数据目录后重抽到的局部数据不会削掉远端仍存着的原文。
"use strict";
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db.cjs");
const adapter = require("./sync-adapter.cjs");
const webdav = require("./webdav.cjs");
const billing = require("./billing.cjs");
const config = require("./sync-config.cjs");
const zip = require("./zip.cjs");

// 重扫窗口：仅补抽最近 24h 的记录，避免每次全量
const RESCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

// 本进程启动标识：随每次启动重新生成（不持久化），用于探测「同一设备 ID 被多台电脑使用」的克隆场景
const BOOT_ID = crypto.randomUUID();

const DEVICES_DIR = "usage-tracker/devices";
const DATA_DIR = "usage-tracker/data";

const STAGE_LABEL = {
  idle: "空闲",
  extract: "抽取",
  package: "打包备份",
  upload: "上传",
  download: "拉取",
  merge: "合并",
  done: "完成",
  cancelled: "已取消",
  error: "失败",
};

let state = {
  running: false,
  cancelled: false,
  stage: "idle",
  percent: 0,
  message: "",
  lastSyncAt: null,
  localOnly: false,
  backupOnly: false,
  restoring: false,
};

// 同步结束/失败回调（由 main.cjs 注入，用于发系统通知）
let onFinish = null;

// 本地统计互斥标志：runLocal 静默执行（不走进度状态机），与 run/runRemote 共用互斥
let localBusy = false;

function isBusy() {
  return state.running || state.restoring || localBusy;
}

/** 本地统计完成广播（渲染进程据此静默刷新总览；自测环境无 electron 时静默跳过） */
function broadcastLocalDone() {
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("app:event", { event: "usage-local-synced", at: Date.now() });
    }
  } catch {
    /* 自测环境无 electron */
  }
}

function emit(partial) {
  Object.assign(state, partial);
}

function setOnFinish(fn) {
  onFinish = fn;
}

function log(kind, level, message, detail) {
  db.addLog(kind, level, message, detail || "");
}

/** 确保本机 deviceId 存在：按适配器注册表顺序（zcode → codex → dsh → workbuddy → reasonix）探测回退，否则生成 UUID */
function ensureLocalDeviceId(cfg = null) {
  let id = db.getLocalDeviceId();
  if (id) return id;
  for (const src of adapter.sources) {
    const sourceCfg = (cfg?.sources || []).find((item) => item.source === src.id);
    const dir = sourceCfg?.dataDir || src.detect();
    if (!dir) continue;
    const detected = src.getDeviceId(dir);
    if (detected) {
      id = detected;
      break;
    }
  }
  if (!id) id = crypto.randomUUID();
  db.setLocalDeviceId(id);
  return id;
}

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** 编码日分片：JSONL 文本 → gzip 压缩字节（传输体积更小） */
function encodeShard(records) {
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  return zlib.gzipSync(Buffer.from(lines, "utf8"));
}

/** 解码日分片：兼容 gzip 与旧版纯文本 JSONL */
function decodeShard(buf, name) {
  if (!buf || buf.length === 0) return [];
  let text;
  if (name.endsWith(".gz")) {
    try {
      text = zlib.gunzipSync(buf).toString("utf8");
    } catch {
      text = buf.toString("utf8"); // 损坏 gzip 退化为文本
    }
  } else {
    text = buf.toString("utf8");
  }
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* 损坏行跳过，不影响其余分片合并 */
    }
  }
  return recs;
}

/** 远端记录有效性判据（上传前读回远端分片、跨设备拉取共用）：NOT NULL 字段齐备且时间戳可入库 */
function isValidRemoteRecord(r) {
  return !!(r && typeof r.id === "string" && r.id
    && typeof r.deviceId === "string"
    && typeof r.deviceName === "string"
    && typeof r.source === "string" && r.source
    && typeof r.providerId === "string"
    && typeof r.modelId === "string"
    && Number.isFinite(r.startedAt) && r.startedAt > 0);
}

/** 远端分片文件名 → UTC 日（"YYYY-MM-DD"）；非日分片（manifest.json 等）返回 null */
function dayOfShardName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$/.exec(String(name || ""));
  return m ? m[1] : null;
}

function sourceEnabled(cfg, id) {
  const s = (cfg.sources || []).find((x) => x.source === id);
  return !!s && s.enabled;
}

function enabledSourceIds(cfg) {
  return adapter.sources.filter((src) => sourceEnabled(cfg, src.id)).map((src) => src.id);
}

/** 判断 WebDAV 是否已完整配置（endpoint 非空且非纯空白），否则视为本地模式 */
function webdavReady(cfg) {
  const wd = cfg && cfg.webdav;
  if (!wd || typeof wd !== "object") return false;
  const endpoint = typeof wd.endpoint === "string" ? wd.endpoint.trim() : "";
  return endpoint.length > 0;
}

/** 当前同步轮次的取消控制器：cancel() 时中断在途网络请求 */
let currentAbort = null;

async function ensureRoots(wd) {
  await webdav.ensureDir(webdav.joinUrl(wd.endpoint, wd.root, `${DEVICES_DIR}`), wd);
  await webdav.ensureDir(webdav.joinUrl(wd.endpoint, wd.root, `${DATA_DIR}`), wd);
}

// ===== 本机存储：备份压缩包（整库快照 = 汇总库 + 配置文件，固定名覆盖式） =====

/**
 * 生成本机备份压缩包：WAL checkpoint 保证主库文件完整 → zip 打包汇总库与配置 →
 * 先写临时文件再原子改名（恢复入口永远不会读到半个包）。
 * 只取固定两个文件名、不做目录递归，因此备份目录=数据缓存目录时也不会自我打包。
 */
async function packageBackup(cfg) {
  emit({ stage: "package", percent: 30, message: "正在生成本机备份…" });
  log("package", "info", "开始生成备份压缩包");
  const dir = config.resolveBackupDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  // 时间戳先写库再 checkpoint 进快照：还原后「上次备份时间」不回退到旧值
  db.setMeta("local_backup_at", String(Date.now()));
  db.close(); // 内部先 wal_checkpoint(TRUNCATE)，关闭后重开，主库文件即为完整快照
  if (state.cancelled) throw new Error("已取消");
  const entries = [{ name: "dosage-sync.sqlite", data: fs.readFileSync(config.dbPath()) }];
  const configFile = config.configPath();
  if (fs.existsSync(configFile)) entries.push({ name: "config.json", data: fs.readFileSync(configFile) });
  const zipBuf = zip.createZip(entries);
  const target = path.join(dir, config.BACKUP_FILE);
  // 中转名带 pid：备份目录用户可自定义，两个实例（dev 版与安装版并存）或同刻多次打包都会
  // 落同一个 target——固定名会让两个写入者互相 rename 踩掉，甚至把对方的半成品当自己的压缩包收走
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, zipBuf);
  fs.renameSync(tmp, target);
  log("package", "ok", `备份压缩包已生成：${target}`, `${entries.length} 个文件 · ${(zipBuf.length / 1048576).toFixed(2)} MB`);
  emit({ percent: 55, message: "备份压缩包已生成" });
}

/** 备份失败错误归类：给用户可行动的中文提示，不暴露完整本机路径 */
function describeBackupError(e) {
  const code = e && e.code;
  const where = e && e.path ? `（${path.basename(String(e.path))}）` : "";
  if (code === "EACCES" || code === "EPERM") return `备份目录或压缩包不可写${where}，请检查目录权限，或确认压缩包未被其他程序占用`;
  if (code === "ENOSPC") return "磁盘空间不足，无法生成备份压缩包";
  if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") return "备份目录配置无效（指向了文件或非法路径），请在设置中重新选择备份目录";
  if (code === "ENOENT") return "备份目录不存在且无法创建，请在设置中重新选择备份目录";
  return e.message;
}

/** 还原安全副本：把改名留档的旧文件挪回原位（恢复失败时回滚用）；返回回滚失败的文件列表 */
function rollBackRestore(backups) {
  const failed = [];
  for (const b of backups) {
    try { fs.rmSync(b.src, { force: true }); fs.renameSync(b.dst, b.src); } catch { failed.push(b.src); }
  }
  return failed;
}

/** 恢复失败统一收尾：先关库释放句柄（Windows 上句柄占用会让回滚的 rm/rename 静默失败），
 * 再尽力回滚；回滚未完成时如实告知手动恢复路径，绝不谎报「已回滚」（2026-09-10 审查修复 N1） */
function rollbackOrThrow(backups, cause) {
  db.close();
  const failed = rollBackRestore(backups);
  if (failed.length > 0) {
    throw new Error(`恢复失败（${cause.message}），且自动回滚未完成：原数据保留在 ${failed.map((f) => path.basename(f) + ".restore-bak").join("、")}，请关闭应用后到数据目录手动恢复`);
  }
  try { db.get(); } catch (e) { throw new Error(`恢复失败已回滚（${cause.message}），但原库重开失败：${e.message}`); }
  throw new Error(`恢复失败，已回滚到原数据：${cause.message}`);
}

/**
 * 从备份压缩包整包还原：解压校验（含 SQLite 文件头校验，坏包直接拒绝）→ 关库 →
 * 现有文件改名留安全副本 → 换入备份内容 → 重开库校验 → 清理副本；
 * 任一步失败自动回滚并重开库，应用不会处于无库状态。
 * 成功后设置（config.json）一并还原，渲染层需重拉配置与页面数据。
 */
async function startRestore(zipPath) {
  if (state.running) throw new Error("同步正在进行中，请稍后再恢复");
  if (state.restoring) throw new Error("恢复正在进行中");
  state.restoring = true;
  try {
    const entries = zip.readZip(fs.readFileSync(zipPath));
    const dbEntry = entries.find((e) => e.name === "dosage-sync.sqlite");
    if (!dbEntry || dbEntry.data.length === 0) throw new Error("不是有效的备份压缩包（缺少汇总库文件）");
    // 写盘前先校验备份库文件头：损坏内容在替换文件之前拦截——读库失败后的回滚在句柄占用时并不可靠
    if (dbEntry.data.length < 16 || dbEntry.data.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") {
      throw new Error("备份压缩包内的汇总库文件已损坏，无法恢复");
    }
    const cfgEntry = entries.find((e) => e.name === "config.json") || null;

    const dataDir = config.dataDir();
    const dbPath = config.dbPath();
    const cfgPath = config.configPath();
    const bakSuffix = ".restore-bak";

    db.close();
    // 现有文件逐个改名留安全副本（含 WAL/SHM，避免旧 -wal 在新库打开时被误用）
    const backups = [];
    try {
      for (const name of ["dosage-sync.sqlite", "dosage-sync.sqlite-wal", "dosage-sync.sqlite-shm", "config.json"]) {
        const src = path.join(dataDir, name);
        if (!fs.existsSync(src)) continue;
        const dst = src + bakSuffix;
        fs.rmSync(dst, { force: true }); // 只保留一代安全副本：覆盖上一轮的
        fs.renameSync(src, dst);
        backups.push({ src, dst });
      }
    } catch (e) {
      rollbackOrThrow(backups, e);
    }

    try {
      fs.writeFileSync(dbPath, dbEntry.data);
      if (cfgEntry) fs.writeFileSync(cfgPath, cfgEntry.data);
    } catch (e) {
      rollbackOrThrow(backups, e);
    }

    // 重开库：init 内含 schema 迁移，备份来自旧版本时自动补齐表结构
    try {
      db.get();
    } catch (e) {
      rollbackOrThrow(backups, e);
    }

    for (const b of backups) { try { fs.rmSync(b.dst, { force: true }); } catch { /* 清理失败不影响结果 */ } }
    const message = cfgEntry ? "恢复完成：数据与设置已还原到备份时点" : "恢复完成：数据已还原（压缩包内未含设置文件）";
    log("package", "ok", `已从备份压缩包恢复：${zipPath}`, message);
    return { ok: true, message, restoredConfig: !!cfgEntry };
  } finally {
    state.restoring = false;
  }
}

const CODEX_ARCHIVE_INDEX_KEY = "codex_archived_index";
const DSH_SESSIONS_INDEX_KEY = "dsh_sessions_index";

async function collectLocal(cfg, opts = {}) {
  const quiet = !!opts.quiet;
  const deviceId = ensureLocalDeviceId(cfg);
  const deviceName = cfg.deviceName || "这台电脑";
  const activeSources = enabledSourceIds(cfg);
  const deviceSources = activeSources.join(",");
  if (!quiet) emit({ stage: "extract", percent: 5, message: "正在抽取本地用量…" });
  log("extract", "info", "开始获取本地数据");
  if (activeSources.length === 0) log("extract", "info", "没有启用的数据源，跳过抽取");
  for (let sourceIndex = 0; sourceIndex < activeSources.length; sourceIndex++) {
    // 逐源检查取消：上传/拉取循环均有同等检查，多源抽取耗时不应例外
    if (!quiet && state.cancelled) return finish("cancelled");
    const sourceId = activeSources[sourceIndex];
    const src = adapter.byId(sourceId);
    const sourceCfg = (cfg.sources || []).find((item) => item.source === sourceId);
    if (!src) continue;
    if (!quiet) {
      emit({
        percent: 5 + Math.floor((sourceIndex / Math.max(activeSources.length, 1)) * 20),
        message: `正在抽取 ${src.name} 用量…`,
      });
    }
    // 单源失败只跳过该源：库损坏/被占用等问题不应中断其余源与后续上传下载
    try {
      const dir = sourceCfg?.dataDir || src.detect();
      if (!dir || !src.validate(dir)) {
        log("extract", "info", `未检测到 ${src.name} 数据，跳过抽取`);
      } else {
        const anchor = db.getAnchor(sourceId);
        // 首次同步（锚点=0）：全量抽取；之后：回扫最近 RESCAN_WINDOW 窗口，
        // 覆盖源端后续更新（如回填 token）的旧记录。
        const sinceMs = anchor > 0 ? anchor - RESCAN_WINDOW_MS : 0;
        // await 兼容同步返回值的适配器（Antigravity 系为异步配额快照）
        const records = await src.extract(dir, deviceId, deviceName, sinceMs);
        db.insertRecords(records);
        // 适配器可选的落库后回调（Antigravity 快照在记录确认入库后才推进，失败不丢消耗）
        if (typeof records.onInserted === "function") records.onInserted();
        // 锚点单调不回退：回扫窗口内无新记录时保持原锚点，避免每次倒退 24h。
        // 只认实际会入库的记录（与 db 层入库钳制共用 isValidTs 判据）：防止源端未来垃圾
        // 时间戳把锚点拉到不可用区间，导致该源增量永久漏采（2026-09-10 审查修复 H2/N3）
        let maxTs = anchor;
        for (const r of records) {
          if (r && db.isValidTs(r.startedAt)) maxTs = Math.max(maxTs, r.startedAt);
        }
        db.setAnchor(sourceId, maxTs);
        log("extract", "info", `${src.name} 获取完成：${records.length} 条记录（since=${sinceMs}）`);
      }
    } catch (e) {
      log("extract", "error", `${src.name} 抽取失败，已跳过该源继续同步`, e.message);
    }
  }

  // Codex 归档会话补充：独立于 sessions 增量锚点，按「文件名→大小」清单只解析未处理的文件
  if (activeSources.includes("codex")) {
    await collectCodexArchived(cfg, deviceId, deviceName);
  }

  // DeepSeek Harness 会话流水补充：官方账本（tokenledger）2026-09 起新版官方软件不再写入，
  // 9 月后的用量只落在会话流水里；独立于账本增量锚点，按「路径→大小+mtime」清单只解析新变化的文件
  if (activeSources.includes("dsh")) {
    await collectDshSessions(cfg, deviceId, deviceName);
  }

  return { deviceId, deviceName, deviceSources };
}

/** Codex 归档目录补充入库：首扫全量（补历史），之后清单增量。失败仅记日志不阻断本轮。 */
async function collectCodexArchived(cfg, deviceId, deviceName) {
  const src = adapter.byId("codex");
  if (!src || !src.extractArchived) return;
  const sourceCfg = (cfg.sources || []).find((item) => item.source === "codex");
  const dir = sourceCfg?.dataDir || src.detect();
  if (!dir) return;
  try {
    let index = null;
    try {
      const raw = db.getMeta(CODEX_ARCHIVE_INDEX_KEY);
      if (raw) index = JSON.parse(raw);
    } catch {
      index = null; // 清单损坏按未处理对待，重扫全量（幂等无害）
    }
    const records = src.extractArchived(dir, deviceId, deviceName, index);
    if (records.length) {
      db.insertRecords(records);
      log("extract", "info", `Codex 归档会话补充入库：${records.length} 条记录`);
    }
    db.setMeta(CODEX_ARCHIVE_INDEX_KEY, JSON.stringify(src.buildArchivedIndex(dir)));
  } catch (e) {
    log("extract", "error", "Codex 归档会话扫描失败，已跳过", e.message);
  }
}

/** DeepSeek Harness 会话流水补充入库：首扫全量（含官方账本未覆盖的 2026-09 起增量），之后清单增量。失败仅记日志不阻断本轮。 */
async function collectDshSessions(cfg, deviceId, deviceName) {
  const src = adapter.byId("dsh");
  if (!src || !src.extractSessions) return;
  const sourceCfg = (cfg.sources || []).find((item) => item.source === "dsh");
  const dir = sourceCfg?.dataDir || src.detect();
  if (!dir || !src.validate(dir)) return;
  try {
    let index = null;
    try {
      const raw = db.getMeta(DSH_SESSIONS_INDEX_KEY);
      if (raw) index = JSON.parse(raw);
    } catch {
      index = null; // 清单损坏按未处理对待，重扫全量（幂等无害）
    }
    const { records, settledFiles } = await src.extractSessions(dir, deviceId, deviceName, index);
    if (records.length) {
      db.insertRecords(records);
      log("extract", "info", `DeepSeek Harness 会话流水补充入库：${records.length} 条记录`);
    }
    // 清单合并：本轮成功的文件用本轮账目；子进程崩溃/超时未完成的文件保留旧账（下轮重试）；
    // 已消失的文件随枚举自然移除。绝不给未成功文件记新账，否则该文件数据永久漏采。
    const fresh = src.buildSessionsIndex(dir);
    const files = {};
    for (const [rel, meta] of Object.entries(fresh.files)) {
      if (settledFiles.has(rel)) files[rel] = settledFiles.get(rel);
      else if (index && index.files && index.files[rel]) files[rel] = index.files[rel];
    }
    db.setMeta(DSH_SESSIONS_INDEX_KEY, JSON.stringify({ v: 1, files }));
  } catch (e) {
    log("extract", "error", "DeepSeek Harness 会话流水扫描失败，已跳过", e.message);
  }
}

/** 上传 + 拉取（原 run 的远程阶段；调用方已排除本地模式） */
async function pushRemote(cfg, deviceId, deviceName, deviceSources) {
  // 3. 上传
  emit({ stage: "upload", percent: 30, message: "正在上传…" });
  log("upload", "info", "开始上传到 WebDAV");
  log("upload", "info", `WebDAV 上传目标：${cfg.webdav.endpoint}${cfg.webdav.root || ""}`);
  log("upload", "info", "创建 WebDAV 业务目录");
  await ensureRoots(cfg.webdav);
      // 价格表多设备同步（LWW）：远端新则替换本地，本地新则上传；失败仅记日志，不阻断数据同步
      try {
        const priceAction = await billing.syncPrices(cfg.webdav, deviceName);
        if (priceAction.action === "downloaded") {
          log("merge", "info", `价格表已更新（${priceAction.count} 条，来自「${priceAction.remoteBy}」），费用按新价格重算`);
        } else if (priceAction.action === "uploaded" || priceAction.action === "created") {
          log("upload", "info", "价格表已上传到 WebDAV（多设备共享）");
        }
      } catch (e) {
        log("upload", "warn", "价格表同步失败（不影响数据同步）", e.message);
      }
      // 在线定价源自动拉取：三套价格表各按自己的间隔检查，互不影响（一套挂了其余照用）。
      // 拉取即应用；失败落到 meta，配置页三张卡片据此显示原因，而不是只有一行同步日志。
      try {
        const srcCfg = (cfg.billing && cfg.billing.sources) || {};
        for (const src of billing.PRICING_SOURCES) {
          const c = srcCfg[src.id] || {};
          if (!c.enabled) continue;
          const intervalMs = Math.max(1, Number(c.intervalHours) || 24) * 3600000;
          const lastAt = Number(db.getMeta(`pricing_${src.id}_at`) || 0);
          if (Date.now() - lastAt <= intervalMs) continue;
          try {
            const r = await billing.pullPricingSource(src.id, { proxy: cfg.billing.importProxy || "" });
            if (r.action === "updated") {
              log("merge", "info", `${src.name}已更新：新增 ${r.added} · 调价 ${r.updated} · 未变 ${r.same}（命中 ${r.models}/${r.total} 个模型）`
                + (r.shadowed ? `；${r.shadowed} 个已有手动价，本表暂不生效` : ""));
            } else if (r.action === "empty") {
              log("upload", "warn", `${src.name}未匹配到本地模型（远端 ${r.total} 个），已保留原价格`);
            }
          } catch (e) {
            try {
              db.setMeta(`pricing_${src.id}_error`, e.message);
              db.setMeta(`pricing_${src.id}_error_at`, String(Date.now()));
            } catch { /* 记账失败不影响同步 */ }
            log("upload", "warn", `${src.name}拉取失败（不影响数据同步，下轮重试）`, e.message);
          }
        }
      } catch (e) {
        log("upload", "warn", "在线定价源拉取异常（不影响数据同步）", e.message);
      }
      // 设备元数据。上传前做设备 ID 碰撞探测：远端设备文件的写入实例既不是本次进程、
      // 也不是本机上次上传的进程时，说明同一设备 ID 有多台电脑在写（克隆/复制数据目录），
      // 双方日分片会互相覆盖——写 warn 日志告警但不阻断同步。
      const devFileUrl = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/${deviceId}.json`);
      let remoteMeta = null;
      try {
        const remoteText = await webdav.getText(devFileUrl, cfg.webdav);
        remoteMeta = remoteText ? JSON.parse(remoteText) : null;
      } catch {
        remoteMeta = null; // 读取/解析失败不影响后续上传
      }
      if (remoteMeta && typeof remoteMeta.bootId === "string"
        && remoteMeta.bootId !== BOOT_ID && remoteMeta.bootId !== db.getMeta("uploaded_boot")) {
        log("upload", "warn", `设备 ID ${deviceId} 疑似被多台电脑同时使用，双方日分片会互相覆盖；` +
          `若你最近迁移/复制过本工具数据目录，本条告警可忽略`, `远端实例标识：${remoteMeta.bootId.slice(0, 8)}…`);
      }
      const devMeta = { deviceId, deviceName, source: deviceSources, lastSyncAt: Date.now(), bootId: BOOT_ID };
      await webdav.put(devFileUrl, cfg.webdav, JSON.stringify(devMeta));
      db.setMeta("uploaded_boot", BOOT_ID);
      log("upload", "info", "设备信息上传完成");
      // 上传本地数据分片（按 deviceId 过滤）。每个天分片以本机该天【全部】记录整体覆盖写（PUT 覆盖语义，幂等），
      // 全量上传天然实现「离线队列自动补传」：只要本地库有数据，配置 WebDAV 后即补传。
      // 增量优化：远端 manifest.json 记录「分片名 → 内容 hash」，内容未变化的分片跳过 PUT；
      // 全部分片处理完后写 manifest，供其他设备做增量拉取判断。manifest 必须在分片全部 PUT 成功后写，
      // 保证「manifest 声明 = 远端实存」。上传记账键绑定远端地址（endpoint+root）：
      // 切换 WebDAV 根目录/地址后旧记账不适用，自动触发全量补传到新远端（旧键留存为少量垃圾记录，无害）。
      //
      // ⚠ 覆盖写的前提是「本地数据完整」：本地缓存被清空（设置页「清空本地缓存」/手动删库/换数据目录/
      // 恢复旧备份）后，源端往往只能重新抽取到一部分历史（会话流水会轮转、账本会被清理），此时直接拿
      // 本地记录覆盖远端日分片，会把远端仍然存着的原始记录削掉——用户视角就是「同步一次，远端历史少一截」。
      // 所以上传前先核对远端分片：内容不一致时读回远端、按 id 取并集、把本地缺失的记录补回本地库，
      // 再把并集写回去。远端原文只会被「至少同样完整」的内容替换：
      //   · manifest hash 与本机当天编码完全一致 → 远端即原文，不读不写直接跳过；
      //   · 远端有、本地没有的记录 → 先补回本地库（总览/明细立即恢复），再随并集上传；
      //   · 远端分片读取失败（网络/HTTP 错误）→ 中止本轮上传，绝不拿不完整数据覆盖远端原文。
      const uploadPrefix = `uploaded:${cfg.webdav.endpoint}${cfg.webdav.root || ""}:`;
      const ownDataUrl = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}`);
      const ownShardUrl = (name) => webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}/${name}`);
      await webdav.ensureDir(ownDataUrl, cfg.webdav);
      // 远端分片台账：UTC 日 → [{ name, hash }]（hash 仅来自远端 manifest；null = 需要读回来才知道）
      const shardsByDay = new Map();
      const addShard = (name, hash) => {
        const day = dayOfShardName(name);
        if (!day) return;
        if (!shardsByDay.has(day)) shardsByDay.set(day, []);
        const list = shardsByDay.get(day);
        if (!list.some((item) => item.name === String(name))) {
          list.push({ name: String(name), hash: typeof hash === "string" ? hash : null });
        }
      };
      // 先读远端 manifest：解析成功即视为可信台账（不做额外目录枚举）；缺失/损坏时退化为目录枚举
      // （兼容旧版纯文本 .jsonl 分片与 manifest 丢失）。此时没有 hash，每个分片都必须读回来核对后才能覆盖。
      let manifestMissing = false;
      let manifestReadError = null;
      try {
        const manifestText = await webdav.getText(`${ownDataUrl}/manifest.json`, cfg.webdav);
        if (manifestText) {
          let parsed = null;
          try { parsed = JSON.parse(manifestText); } catch { parsed = null; }
          if (parsed && parsed.shards && typeof parsed.shards === "object") {
            for (const [name, hash] of Object.entries(parsed.shards)) addShard(name, hash);
          } else {
            manifestReadError = new Error("manifest.json 内容无法解析");
          }
        } else {
          manifestMissing = true;
        }
      } catch (e) {
        manifestReadError = e;
      }
      if (manifestReadError) {
        // manifest 读不到 ≠ 远端没有数据：目录枚举兜底；枚举到的分片逐个读回，读不到就中止上传
        log("upload", "warn", "远端分片清单读取失败，改用目录枚举核对后再上传", manifestReadError.message);
        const listed = await webdav.list(`${ownDataUrl}/`, cfg.webdav);
        for (const f of listed) if (!f.isDir) addShard(f.name, null);
      } else if (manifestMissing) {
        // 远端没有 manifest：首次上传到新根目录，或旧版客户端/中途失败留下的分片。
        // 目录里实际存在的分片同样要先读回再覆盖，不能当「远端没有数据」直接上传。
        const listed = await webdav.list(`${ownDataUrl}/`, cfg.webdav);
        for (const f of listed) if (!f.isDir) addShard(f.name, null);
      }
      // 遍历「本地有记录的日」∪「远端已有分片的日」：远端有而本地没有的日（典型：缓存被清空后
      // 源端已无法重新抽取的历史）也要读回来，才能还原到本地库并保住远端原文
      const daySet = new Set(db.getRecordDays(deviceId));
      for (const day of shardsByDay.keys()) daySet.add(day);
      const days = Array.from(daySet).sort();
      const manifest = {};
      let uploadedCount = 0;
      let restoredCount = 0;
      let keptRemoteCount = 0;
      for (let i = 0; i < days.length; i++) {
        const day = days[i];
        if (state.cancelled) return finish("cancelled");
        const candidates = shardsByDay.get(day) || [];
        const fileName = `${day}.jsonl.gz`;
        const localRecs = db.getRecordsByDay(deviceId, day);
        const localHash = sha1(encodeShard(localRecs));
        // 远端分片内容与本机当天编码完全一致 → 远端就是原文，无需读回/写回
        if (candidates.length === 1 && candidates[0].hash === localHash) {
          manifest[candidates[0].name] = localHash;
          db.setMeta(`${uploadPrefix}${candidates[0].name}`, localHash);
          emit({ percent: 30 + Math.floor(((i + 1) / Math.max(days.length, 1)) * 20) });
          continue;
        }
        // 读回远端现有分片：manifest 不可信（缺失/损坏）时远端状态未知，还要按两种历史文件名
        // 探测一次，确认远端确实没有该日分片后才能直接用本地数据上传
        const remoteBufs = [];
        for (const item of candidates) {
          const buf = await webdav.get(ownShardUrl(item.name), cfg.webdav);
          if (buf) remoteBufs.push({ name: item.name, buf });
        }
        if (manifestReadError && candidates.length === 0) {
          for (const name of [`${day}.jsonl.gz`, `${day}.jsonl`]) {
            const buf = await webdav.get(ownShardUrl(name), cfg.webdav);
            if (buf) remoteBufs.push({ name, buf });
          }
        }
        // 远端记录先补回本地库（insertRecords 按 id 幂等）：缓存被清空后总览/明细能立刻恢复，
        // 随后的并集上传也不会把远端独有的记录削掉
        for (const item of remoteBufs) {
          const recs = decodeShard(item.buf, item.name);
          const valid = recs.filter(isValidRemoteRecord);
          if (recs.length > valid.length) {
            log("upload", "warn", `远端分片 ${day}/${item.name} 跳过 ${recs.length - valid.length} 条字段缺失或时间戳异常的记录`);
          }
          if (valid.length) {
            db.insertRecords(valid);
            restoredCount += valid.length;
          }
        }
        const dayRecs = db.getRecordsByDay(deviceId, day);
        const payload = encodeShard(dayRecs);
        const hash = sha1(payload);
        if (remoteBufs.length && dayRecs.length === 0) {
          // 远端分片在、但读回来的记录全部无效（损坏）：保留远端原文，绝不写空分片覆盖
          manifest[remoteBufs[0].name] = candidates[0]?.hash || sha1(remoteBufs[0].buf);
          keptRemoteCount++;
          emit({ percent: 30 + Math.floor(((i + 1) / Math.max(days.length, 1)) * 20) });
          continue;
        }
        if (remoteBufs.length === 0 && dayRecs.length === 0) {
          // 本地与远端都没有这一天的数据：不写空分片
          emit({ percent: 30 + Math.floor(((i + 1) / Math.max(days.length, 1)) * 20) });
          continue;
        }
        // 远端字节与本轮要写的字节完全一致时跳过 PUT，不制造无意义写入（「不修改原先的数据」）
        const unchanged = remoteBufs.some((item) => sha1(item.buf) === hash);
        manifest[fileName] = hash;
        db.setMeta(`${uploadPrefix}${fileName}`, hash);
        if (!unchanged) {
          // 全量场景（首次/换根/清缓存）分片可达数百个，逐条日志会淹没其他记录，只在少量时逐条
          if (days.length <= 20) log("upload", "info", `上传日分片 ${day}：${dayRecs.length} 条记录`);
          await webdav.put(ownShardUrl(fileName), cfg.webdav, payload);
          uploadedCount++;
        }
        emit({ percent: 30 + Math.floor(((i + 1) / Math.max(days.length, 1)) * 20) });
      }
      if (restoredCount > 0) {
        log("upload", "info",
          `已从 WebDAV 读回 ${restoredCount} 条远端记录并合并进本地库（常见于本地缓存被清空/换数据目录后），`
          + "本轮按「远端并集」上传，远端原有记录未被覆盖丢失");
      }
      if (keptRemoteCount > 0) {
        log("upload", "warn", `${keptRemoteCount} 个日分片的远端内容无法解析，已原样保留、未用本地数据覆盖`);
      }
      await webdav.put(
        webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}/manifest.json`),
        cfg.webdav,
        JSON.stringify({ v: 1, shards: manifest })
      );
      log("upload", "info", `分片上传完成：${uploadedCount}/${days.length} 个有变化（其余内容未变化已跳过）`);

  if (state.cancelled) return finish("cancelled");

  // 4. 拉取
  emit({ stage: "download", percent: 55, message: "正在拉取其他设备…" });
  log("download", "info", "开始拉取远端数据");
  const devDir = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/`);
      const devList = await webdav.list(devDir, cfg.webdav);
      const deviceFiles = devList
        .filter((e) => !e.isDir && e.name.endsWith(".json"))
        .map((e) => e.name.replace(/\.json$/, ""));

      // 先枚举所有待拉分片，用于细分拉取进度。
      // 增量拉取：优先读对方 manifest.json（分片名 → 内容 hash），
      // 本地已按相同内容合并过的分片直接跳过；对方无 manifest（旧版客户端）时
      // 回退为目录全量遍历，下载后同样计算 hash 记账，对方升级后即可无缝衔接。
      const pending = [];
      for (const other of deviceFiles) {
        if (other === deviceId) continue;
        const dataBase = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${other}`);
        let manifest = null;
        try {
          const manifestText = await webdav.getText(`${dataBase}/manifest.json`, cfg.webdav);
          manifest = manifestText ? JSON.parse(manifestText) : null;
        } catch {
          manifest = null; // manifest 缺失/损坏时按旧版全量遍历处理
        }
        if (manifest && manifest.shards && typeof manifest.shards === "object") {
          for (const [fileName, hash] of Object.entries(manifest.shards)) {
            if (typeof hash !== "string") continue;
            if (db.getMeta(`merged:${other}:${fileName}`) === hash) continue;
            pending.push({ other, name: fileName, url: `${dataBase}/${fileName}`, hash });
          }
        } else {
          const files = await webdav.list(`${dataBase}/`, cfg.webdav);
          for (const f of files) {
            if (f.isDir || !/\.jsonl(\.gz)?$/.test(f.name)) continue;
            pending.push({
              other,
              name: f.name,
              url: webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${other}/${f.name}`),
              hash: null,
            });
          }
        }
      }

      let merged = 0;
      let fileCount = 0;
      const mergedDevices = new Set();
      for (let idx = 0; idx < pending.length; idx++) {
        if (state.cancelled) return finish("cancelled");
        const p = pending[idx];
        const buf = await webdav.get(p.url, cfg.webdav);
        if (!buf) continue;
        const recs = decodeShard(buf, p.name);
        // 数据校验：过滤字段缺失、时间戳异常的无效数据（NOT NULL 字段必须齐备；判据与上传前读回共用）
        const validRecs = recs.filter(isValidRemoteRecord);
        // 远端分片含畸形行时给出可见提示（不阻断合并）
        if (recs.length > validRecs.length) {
          log("download", "warn", `分片 ${p.other}/${p.name} 跳过 ${recs.length - validRecs.length} 条字段缺失或时间戳异常的记录`);
        }
        if (validRecs.length > 0) {
          db.insertRecords(validRecs);
          // 增量拉取记账：hash 与远端 manifest 对齐，下次相同内容直接跳过。
          // 仅在成功合并后记账——损坏分片（0 条有效记录）下次仍会重试。
          db.setMeta(`merged:${p.other}:${p.name}`, p.hash || sha1(buf));
        }
        fileCount++;
        if (!mergedDevices.has(p.other)) mergedDevices.add(p.other);
        emit({ percent: 55 + Math.floor((idx + 1) / Math.max(pending.length, 1) * 30) });
      }
      // 无待拉取分片（全部已合并/自产）时循环不执行，补发进度避免 55% 直跳 90%
      if (pending.length === 0) emit({ percent: 85 });

      // 设备元数据
      for (const other of deviceFiles) {
        if (other === deviceId) continue;
        if (state.cancelled) return finish("cancelled");
        const metaUrl = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/${other}.json`);
        const metaText = await webdav.getText(metaUrl, cfg.webdav);
        let devName = other;
        let devSources = "";
        let lastSyncAt = null;
        if (metaText) {
          try {
            const meta = JSON.parse(metaText);
            devName = meta.deviceName || other;
            devSources = typeof meta.source === "string" ? meta.source : "";
            lastSyncAt = meta.lastSyncAt ?? null;
          } catch {
            /* 元数据损坏时回退为设备 ID */
          }
        }
        db.upsertDevice(other, devName, devSources, lastSyncAt);
        merged++;
      }
      log("download", "info", `已合并 ${mergedDevices.size} 台其他设备（${fileCount} 个分片）`);
}

/** 完整同步（手动/托盘/daily）：抽取 → 备份/上传拉取 → 合并，一次跑全流程 */
async function run(cfg, opts = {}) {
  // 恢复与同步/本地统计互斥：三者入口均为同步代码段，标志位先行置位，不存在并发窗口
  if (state.restoring) throw new Error("正在恢复备份，请稍后再同步");
  if (state.running) throw new Error("同步正在进行中");
  if (localBusy) throw new Error("本地统计进行中");
  // 远端同步跨模块互斥（issue #92）：本地/备份模式不碰远端，不占锁
  const remoteRun = webdavReady(cfg) && !((opts && opts.mode) === "backup");
  if (remoteRun && !webdav.tryBeginSync("usage")) throw new Error("其他模块的远端同步正在进行，本轮已跳过");
  state = { running: true, cancelled: false, stage: "extract", percent: 0, message: "准备抽取", lastSyncAt: state.lastSyncAt || null, localOnly: false, backupOnly: false, restoring: false };
  currentAbort = new AbortController();
  // 只有真正走远端时才占用全局取消信号：本地模式会与远端同步并发（它不拿全局锁），
  // 原先无条件设置会覆盖对方的 signal，本地结束再写 null，远端在途请求因此失去取消能力。
  if (remoteRun) webdav.setActiveSignal(currentAbort.signal);

  try {
    // 本地模式：未配置 WebDAV 或强制备份（opts.mode=backup）时，仅做本机抽取与备份打包，
    // 跳过全部远程请求，避免因等待远端响应阻塞
    const backupOnly = !!(opts && opts.mode === "backup");
    const localOnly = !webdavReady(cfg) || backupOnly;
    if (localOnly) {
      emit({ localOnly: true, backupOnly });
      log("extract", "info", backupOnly
        ? "本次为手动本机备份：仅抽取本机数据并重新生成备份压缩包"
        : "未配置 WebDAV 存储，本次仅同步本机（本地）数据并生成备份压缩包，跳过远程上传/拉取");
    }

    // 1. 抽取（含 Codex 归档会话补充）
    const ctx = await collectLocal(cfg, { quiet: false });

    if (state.cancelled) return finish("cancelled");

    // 2. 本机备份打包（仅本地模式）：生成/覆盖备份压缩包。
    // 显式备份（opts.mode=backup）失败即整轮失败——用户核心诉求就是备份；
    // 常规本地同步顺带备份失败只记错误日志，不阻断同步（抽取数据已入库），
    // 修复前打包失败会让原本成功的本地同步整体报错（2026-09-10 审查修复 H3）
    if (localOnly) {
      if (state.cancelled) return finish("cancelled");
      try {
        await packageBackup(cfg);
      } catch (e) {
        if (state.cancelled) return finish("cancelled");
        if (backupOnly) throw new Error(describeBackupError(e));
        log("package", "error", "备份压缩包生成失败（不影响本次同步的数据）", describeBackupError(e));
      }
    }

    // 3+4. 上传与拉取（本地模式跳过）
    if (!localOnly) {
      await pushRemote(cfg, ctx.deviceId, ctx.deviceName, ctx.deviceSources);
    }

    if (state.cancelled) return finish("cancelled");

    // 5. 合并
    emit({ stage: "merge", percent: 90, message: "正在合并…" });
    db.upsertDevice(ctx.deviceId, ctx.deviceName, ctx.deviceSources, Date.now());
    log("merge", "info", "合并去重完成");

    return finish("completed");
  } catch (e) {
    // 取消触发的网络中断按取消收尾，不当作同步失败
    if (state.cancelled) return finish("cancelled");
    // 仅网络层异常做分类提示；HTTP 状态错误/DB/磁盘等业务错误保留原始 message，避免误导
    const msg = webdav.isNetworkError(e) ? webdav.describeFailure("同步", e) : e.message;
    log("error", "error", state.backupOnly ? "备份失败" : "同步失败", msg);
    state.running = false;
    state.stage = "error";
    state.message = msg;
    if (onFinish) onFinish(false, msg);
    return { ok: false, error: msg };
  } finally {
    // 本地模式没有占用全局锁/取消信号，不能在这里清掉远端同步的信号
    if (remoteRun) {
      webdav.endSync();
      webdav.setActiveSignal(null);
    }
    currentAbort = null;
  }
}

/** 本地统计（半小时节奏）：抽取入库（含 Codex 归档补充）+ 未配 WebDAV 时顺带 zip 备份。
 *  静默执行：不走进度状态机、不发系统通知，完成后广播 usage-local-synced 让前端静默刷新。 */
async function runLocal(cfg) {
  if (state.restoring) throw new Error("正在恢复备份，本地统计已跳过");
  if (state.running) throw new Error("同步正在进行中，本地统计已跳过");
  if (localBusy) throw new Error("本地统计进行中");
  localBusy = true;
  try {
    await collectLocal(cfg, { quiet: true });
    // 未配置 WebDAV 时本地统计即完整动作，顺带刷新本机备份压缩包；失败只记日志不阻断
    if (!webdavReady(cfg)) {
      try {
        await packageBackup(cfg);
      } catch (e) {
        log("package", "error", "备份压缩包生成失败（不影响本地统计）", describeBackupError(e));
      }
    }
    log("extract", "info", "本地统计完成");
    try { db.pruneLogs(); } catch { /* 日志裁剪失败不影响本地统计 */ }
    broadcastLocalDone();
    return { ok: true };
  } catch (e) {
    log("error", "error", "本地统计失败", e.message);
    return { ok: false, error: e.message };
  } finally {
    localBusy = false;
  }
}

/** 远程同步（每小时节奏）：仅上传 + 拉取合并（含价格表/设备元数据），走进度状态机与完成通知 */
async function runRemote(cfg) {
  if (state.restoring) throw new Error("正在恢复备份，请稍后再同步");
  if (state.running) throw new Error("同步正在进行中");
  if (localBusy) throw new Error("本地统计进行中，远程同步已跳过");
  // 远端同步跨模块互斥（issue #92）：其他模块同步中时跳过本轮（定时下轮补跑）
  if (!webdav.tryBeginSync("usage")) throw new Error("其他模块的远端同步正在进行，本轮已跳过");
  state = { running: true, cancelled: false, stage: "upload", percent: 0, message: "准备上传", lastSyncAt: state.lastSyncAt || null, localOnly: false, backupOnly: false, restoring: false };
  currentAbort = new AbortController();
  webdav.setActiveSignal(currentAbort.signal);
  try {
    const deviceId = ensureLocalDeviceId(cfg);
    const deviceName = cfg.deviceName || "这台电脑";
    const deviceSources = enabledSourceIds(cfg).join(",");
    await pushRemote(cfg, deviceId, deviceName, deviceSources);
    if (state.cancelled) return finish("cancelled");
    emit({ stage: "merge", percent: 90, message: "正在合并…" });
    db.upsertDevice(deviceId, deviceName, deviceSources, Date.now());
    log("merge", "info", "合并去重完成");
    return finish("completed");
  } catch (e) {
    // 取消触发的网络中断按取消收尾，不当作同步失败
    if (state.cancelled) return finish("cancelled");
    // 仅网络层异常做分类提示；HTTP 状态错误/DB/磁盘等业务错误保留原始 message，避免误导
    const msg = webdav.isNetworkError(e) ? webdav.describeFailure("同步", e) : e.message;
    log("error", "error", "同步失败", msg);
    state.running = false;
    state.stage = "error";
    state.message = msg;
    if (onFinish) onFinish(false, msg);
    return { ok: false, error: msg };
  } finally {
    webdav.endSync();
    webdav.setActiveSignal(null);
    currentAbort = null;
  }
}

function finish(result) {
  state.running = false;
  if (result === "completed") {
    state.stage = "done";
    state.percent = 100;
    state.message = state.backupOnly ? "备份完成" : state.localOnly ? "同步完成（仅本机数据）" : "同步完成";
    state.lastSyncAt = Date.now();
    log("done", "ok", state.backupOnly ? "备份完成" : state.localOnly ? "同步完成（仅本机数据，未配置 WebDAV）" : "同步完成");
    try { db.pruneLogs(); } catch { /* 日志裁剪失败不影响同步 */ }
    if (onFinish) onFinish(true, state.message);
    return { ok: true };
  }
  state.stage = "cancelled";
  state.message = "已取消";
  log("done", "info", "同步已取消");
  return { ok: false, cancelled: true };
}

function cancel() {
  if (!state.running) return; // 未运行时置 cancelled 会把状态机卡进"正在取消…"直到下次 run
  state.cancelled = true;
  if (currentAbort) currentAbort.abort(); // 立即中断在途网络请求
  emit({ message: "正在取消…" });
}

function progress() {
  if (!state.lastSyncAt) {
    try { state.lastSyncAt = db.getLastSyncAt(db.getLocalDeviceId()); } catch { /* 初始化阶段忽略 */ }
  }
  return {
    running: state.running,
    restoring: !!state.restoring,
    stage: state.stage,
    stageLabel: STAGE_LABEL[state.stage] || state.stage,
    percent: state.percent,
    message: state.message,
    lastSyncAt: state.lastSyncAt,
    localOnly: !!state.localOnly,
    backupOnly: !!state.backupOnly,
  };
}

module.exports = { run, runLocal, runRemote, isBusy, cancel, progress, startRestore, setOnFinish, ensureLocalDeviceId, enabledSourceIds, RESCAN_WINDOW_MS, DEVICES_DIR, DATA_DIR };
