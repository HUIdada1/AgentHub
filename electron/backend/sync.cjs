// 4 阶段同步引擎：抽取 → 上传 → 拉取 → 合并
// 本地模式（未配置 WebDAV 或强制备份 mode=backup）：抽取 → 打包备份（本机 zip 快照），跳过全部远程阶段
// WebDAV 布局：usage-tracker/devices/<deviceId>.json（设备元数据）
//             usage-tracker/data/<deviceId>/<YYYY-MM-DD>.jsonl.gz（UTC 日分片，gzip 压缩）
// 幂等：本地按 id 去重（INSERT OR REPLACE），远端按文件名 + 内容整体覆盖写
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
  const tmp = target + ".tmp";
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
    const records = src.extractSessions(dir, deviceId, deviceName, index);
    if (records.length) {
      db.insertRecords(records);
      log("extract", "info", `DeepSeek Harness 会话流水补充入库：${records.length} 条记录`);
    }
    db.setMeta(DSH_SESSIONS_INDEX_KEY, JSON.stringify(src.buildSessionsIndex(dir)));
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
      // 远程价格源自动拉取（来源 remote）：按配置间隔检查，拉取失败仅记日志
      try {
        const rp = cfg.billing && cfg.billing.remotePricing;
        if (rp && rp.enabled && rp.url) {
          const intervalMs = Math.max(1, Number(rp.intervalHours) || 24) * 3600000;
          const lastAt = Number(db.getMeta("remote_pricing_at") || 0);
          if (Date.now() - lastAt > intervalMs) {
            const r = await billing.pullRemotePricing({ ...rp, proxy: cfg.billing.importProxy || "" });
            if (r.action === "updated") {
              log("merge", "info", `远程价格源已更新：新增 ${r.added} · 调价 ${r.updated} · 未变 ${r.skipped}（本地 ${r.models} 个模型命中）`);
            }
          }
        }
      } catch (e) {
        log("upload", "warn", "远程价格源拉取失败（不影响数据同步，下轮重试）", e.message);
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
      // 上传本地数据分片（按 deviceId 过滤），每个天分片以本机该天【全部】记录整体覆盖写（PUT 覆盖语义，幂等）。
      // 全量上传天然实现「离线队列自动补传」：只要本地库有数据，配置 WebDAV 后即补传。
      // 增量优化：分片内容 hash 记账存 meta 表（与数据同库，删库自动回到全量），
      // 内容未变化的分片跳过 PUT；全部分片处理完后写 manifest.json（分片名 → hash），
      // 供其他设备做增量拉取判断。manifest 必须在分片全部 PUT 成功后写，保证「manifest 声明 = 远端实存」。
      // 记账键绑定远端地址（endpoint+root）：切换 WebDAV 根目录/地址后旧记账不适用，
      // 自动触发全量补传到新远端（旧键留存为少量垃圾记录，无害）。
      const uploadPrefix = `uploaded:${cfg.webdav.endpoint}${cfg.webdav.root || ""}:`;
      const days = db.getRecordDays(deviceId);
      await webdav.ensureDir(webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}`), cfg.webdav);
      const manifest = {};
      let uploadedCount = 0;
      for (let i = 0; i < days.length; i++) {
        const day = days[i];
        if (state.cancelled) return finish("cancelled");
        const dayRecs = db.getRecordsByDay(deviceId, day);
        const fileName = `${day}.jsonl.gz`;
        const payload = encodeShard(dayRecs);
        const hash = sha1(payload);
        manifest[fileName] = hash;
        const uploadedKey = `${uploadPrefix}${fileName}`;
        if (db.getMeta(uploadedKey) !== hash) {
          // 全量场景（首次/换根/清缓存）分片可达数百个，逐条日志会淹没其他记录，只在少量时逐条
          if (days.length <= 20) log("upload", "info", `上传日分片 ${day}：${dayRecs.length} 条记录`);
          await webdav.put(
            webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}/${fileName}`),
            cfg.webdav,
            payload
          );
          db.setMeta(uploadedKey, hash);
          uploadedCount++;
        }
        emit({ percent: 30 + Math.floor(((i + 1) / Math.max(days.length, 1)) * 20) });
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
        // 数据校验：过滤字段缺失、时间戳异常的无效数据（NOT NULL 字段必须齐备）
        const validRecs = recs.filter(
          (r) => r && typeof r.id === "string" && r.id && typeof r.deviceId === "string"
            && typeof r.deviceName === "string" && typeof r.source === "string" && r.source
            && typeof r.providerId === "string" && typeof r.modelId === "string"
            && Number.isFinite(r.startedAt) && r.startedAt > 0
        );
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
  state = { running: true, cancelled: false, stage: "extract", percent: 0, message: "准备抽取", lastSyncAt: state.lastSyncAt || null, localOnly: false, backupOnly: false, restoring: false };
  currentAbort = new AbortController();
  webdav.setActiveSignal(currentAbort.signal);

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
    webdav.setActiveSignal(null);
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
