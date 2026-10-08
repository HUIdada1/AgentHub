/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除声明。
 */

// 记忆中枢 · WebDAV 同步：全量 tar.gz 单包原子传输 + 清单比对 + 三方合并 + 冲突队列 + 墓碑。
// 复用框架既有能力：webdav.cjs（PROPFIND/GET/PUT）+ tarpack.cjs（tar.gz）+ config.moduleWebdav("memory")。
// 索引库不入包（可重建，且是二进制无法三方合并）；MD 是唯一事实源。
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const webdav = require("../webdav.cjs");
const { unpackAsync, packFilesAsync } = require("../tarpack.cjs");
const profileCache = require("./profile-cache.cjs");
const { parseFrontmatter, parseDailySections, renderDailyFile } = require("./store.cjs");

function isDailyPath(rel) {
  const norm = String(rel || "").replace(/\\/g, "/");
  return norm.endsWith(".md") && (norm.includes("/l1/") || norm.startsWith("general/l1/") || norm.startsWith("projects/")) && /\d{4}-\d{2}-\d{2}\.md$/.test(norm);
}

function tryMergeDailyFiles(localPath, remotePath) {
  try {
    const localText = fs.readFileSync(localPath, "utf8");
    const remoteText = fs.readFileSync(remotePath, "utf8");
    const lParsed = parseFrontmatter(localText);
    const rParsed = parseFrontmatter(remoteText);
    const lSections = parseDailySections(lParsed.body);
    const rSections = parseDailySections(rParsed.body);

    const mergedSections = [];
    const sectionMap = new Map();
    for (const sec of lSections) {
      if (sec.id) sectionMap.set(sec.id, sec);
      else mergedSections.push(sec);
    }
    for (const rSec of rSections) {
      if (!rSec.id) {
        const exists = lSections.some((ls) => ls.body === rSec.body && ls.title === rSec.title);
        if (!exists) return { ok: false };
        continue;
      }
      const existing = sectionMap.get(rSec.id);
      if (existing) {
        if (existing.body.trim() !== rSec.body.trim() || existing.title !== rSec.title) {
          return { ok: false };
        }
      } else {
        sectionMap.set(rSec.id, rSec);
      }
    }
    const allSections = [...mergedSections, ...sectionMap.values()].sort((a, b) => {
      const ta = String(a.time || "00:00");
      const tb = String(b.time || "00:00");
      return ta.localeCompare(tb);
    });
    allSections.preamble = lSections.preamble || rSections.preamble || "";
    const mergedFm = { ...rParsed.fm, ...lParsed.fm };
    const content = renderDailyFile(mergedFm, allSections);
    return { ok: true, content };
  } catch {
    return { ok: false };
  }
}

const PACK_NAME = "memory-latest.tar.gz";
const STAGE_LABEL = {
  idle: "空闲",
  connect: "连接服务器",
  pull: "拉取远端包",
  merge: "三方合并",
  pack: "打包",
  push: "上传",
  done: "完成",
  cancelled: "已取消",
  error: "失败",
};
// 排除规则与隐私白名单收敛到 manifest-core.cjs：主进程（合并循环/打包收集）与
// worker（清单构建）必须用同一份判据，否则「永不上传」项目会从某一侧漏进包
const { shouldSkip, isLocalOnly, EXCLUDE_FILES } = require("./manifest-core.cjs");

function hashOfFile(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function sha256File(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * 清单条目「内容是否相同」——三方合并的变更判定只此一处口径：hash 优先，mtime 不参与。
 *
 * 同一份内容在不同设备上的 mtime 天然不同（各自解包/落盘的时刻），拿 mtime 参与比较会把整棵树
 * 判成「远端已改」：实测一次同步因此重写 4744 个文件（内容全都没变）、主进程冻结 139 秒；本地
 * 真有改动时又会被误报成「双方都改了」冲突，阻断整包上传。
 * 返回 true 表示内容相同（调用方据此判定「未变」）。
 */
function sameManifestEntry(x, y) {
  if (!x && !y) return true;
  if (!x || !y) return false;
  // 两侧都有 hash（正常路径）：hash 定内容，体积只做冗余校验；
  // 任一侧体积缺失（早年清单）时以 hash 为准，不退回含 mtime 的整对象比较——否则又踩回误判
  if (x.hash && y.hash) {
    if (x.hash !== y.hash) return false;
    const sx = Number(x.size);
    const sy = Number(y.size);
    return Number.isFinite(sx) && Number.isFinite(sy) ? sx === sy : true;
  }
  // 无 hash 的旧清单（极早期版本写的）退回原口径，避免漏判
  return JSON.stringify(x) === JSON.stringify(y);
}

/** 文件当前状态 → 基线条目（读不到返回 null，绝不抛） */
function statEntry(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtime: Math.round(st.mtimeMs), hash: sha256File(file) };
  } catch {
    return null;
  }
}

/** 冲突条目里的某一侧版本 → 基线条目（只取内容三元组，其余字段不进基线） */
function pickEntry(e) {
  return e ? { size: e.size, mtime: e.mtime, hash: e.hash } : null;
}

/** 本地清单构建 worker 化：walk + 逐文件 sha256（记忆树数千文件）挪出主进程事件循环
 *  （唤醒后磁盘冷缓存时 UI 与 9527 网关一起卡——rebuild-worker 同款问题）。
 *  引导与 tarpack / rebuild-worker 同款：主进程把 manifest-core.cjs 源码写入临时目录、
 *  worker require 临时副本（打包态源码在 asar 里主进程读没问题，worker 不依赖 asar 加载）；
 *  隐私白名单（isLocalOnly）随源码进 worker——「永不上传」项目同样不进清单。 */
const MANIFEST_WORKER_BOOT = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const mod = require(workerData.entry);
  parentPort.postMessage({ ok: true, result: mod.buildManifestSync(workerData.dir, workerData.opts) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
`;

const MANIFEST_WORKER_TIMEOUT_MS = 300000; // 与 tarpack 同款护栏，防御磁盘异常挂死

/** 源码副本临时目录：**主进程建、主进程清**（源码在 asar 里主进程读得到，worker 只 require 副本）。
 *  不让 worker 自己建：主线程 cleanup() 里的 terminate() 是异步的，往往赶在 worker 的清理之前生效，
 *  实测那样每个实例会在 %TEMP% 漏一个 agenthub-manifest-* / 本机累积过 313 个。 */
function prepareManifestWorkerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-manifest-"));
  try {
    fs.writeFileSync(path.join(dir, "manifest-core.cjs"), fs.readFileSync(path.join(__dirname, "manifest-core.cjs")));
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败尽力而为 */ }
    throw e;
  }
  return dir;
}

function buildManifest(dir, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let worker = null;
    let tmpDir = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (worker) {
        worker.terminate();
        worker = null;
      }
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败尽力而为 */ }
        tmpDir = null;
      }
    };
    try {
      const { Worker } = require("node:worker_threads");
      tmpDir = prepareManifestWorkerDir();
      worker = new Worker(MANIFEST_WORKER_BOOT, {
        eval: true,
        workerData: { entry: path.join(tmpDir, "manifest-core.cjs"), dir, opts },
      });
      timer = setTimeout(() => {
        settled = true;
        cleanup();
        reject(new Error("本地清单构建超时（5 分钟）"));
      }, MANIFEST_WORKER_TIMEOUT_MS);
      worker.on("message", (msg) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (msg && msg.ok) resolve(msg.result);
        else reject(new Error((msg && msg.error) || "清单构建失败"));
      });
      worker.on("error", (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
      worker.on("exit", (code) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("清单构建 worker 异常退出（code " + code + "）"));
        }
      });
    } catch (e) {
      settled = true;
      cleanup();
      reject(e);
    }
  });
}

class MemorySync {
  constructor(opts) {
    this.deviceName = opts.deviceName || "";
    this.service = opts.service;
    this.getConfig = opts.getConfig;
    this.moduleWebdav = opts.moduleWebdav;
    this.emit = opts.emit || (() => {});
    this.rootDir = opts.rootDir;
    this.dataDir = opts.dataDir;
    this.stateFile = path.join(opts.dataDir, "memory-sync-state.json");
    this.conflictsFile = path.join(opts.dataDir, "memory-sync-conflicts.json");
    this.state = this._loadState();
    // 设备 id 必须每机唯一：index.cjs 的 deviceId() 目前没有传进构造参数，
    // 退回 service 持有的同源 id；再不行才留空（留空时所有设备的登记文件都叫 local.json 互相覆盖）
    if (!this.state.deviceId) {
      const fallback = (opts.service && opts.service.deviceId) || opts.deviceId || "";
      if (fallback) {
        this.state.deviceId = fallback;
        this._saveState();
      }
    }
    // 冲突队列（含每条冲突的双侧全文）单独落盘：state 文件随每次日志重写，
    // 塞在一起意味着每条日志都重写数 MB（2 万条规模实测）
    this.state.conflicts = this._loadConflicts();
    this.running = false;
    this.cancelFlag = false;
    this._lastProgress = 0;
  }

  _loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return { deviceId: "", lastSyncAt: 0, lastHash: "", baseline: {}, tombstones: [], conflicts: [], logs: [], packs: [] };
    }
  }

  /** 设置页「永不上传的项目」slug 列表（privacy.localOnlyProjects） */
  _localOnly() {
    const v = this.getConfig()["privacy.localOnlyProjects"];
    return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s) : [];
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const { conflicts, ...rest } = this.state;
      fs.writeFileSync(this.stateFile, JSON.stringify(rest, null, 2), "utf8");
    } catch { /* 状态落盘失败不影响同步结果 */ }
  }

  _loadConflicts() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.conflictsFile, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // 兼容旧版内联在 state 里的冲突队列（只迁一次，随后由 _saveConflicts 接管）
      return Array.isArray(this.state.conflicts) ? this.state.conflicts : [];
    }
  }

  _saveConflicts() {
    try {
      fs.mkdirSync(path.dirname(this.conflictsFile), { recursive: true });
      fs.writeFileSync(this.conflictsFile, JSON.stringify(this.state.conflicts || [], null, 2), "utf8");
    } catch { /* 与 _saveState 同口径 */ }
  }

  // 读远端根目录时统一处理连接配置（与其它三模块共用同一套凭据，根目录隔离）
  _cfg() {
    if (typeof this.moduleWebdav === "function") return this.moduleWebdav("memory");
    return null;
  }

  configured() {
    const c = this._cfg();
    return !!(c && c.endpoint);
  }

  progress() {
    return {
      running: this.running,
      stage: this.state.stage || "idle",
      stageLabel: STAGE_LABEL[this.state.stage || "idle"],
      percent: this.state.percent || 0,
      detail: this.state.detail || "",
      lastSyncAt: this.state.lastSyncAt || 0,
      conflicts: (this.state.conflicts || []).length,
      tombstones: (this.state.tombstones || []).length,
    };
  }

  logs(limit) {
    return (this.state.logs || []).slice(-(limit || 50));
  }

  packs() {
    return (this.state.packs || []).slice(-20).reverse();
  }

  devices() {
    return this.state.devices || [];
  }

  /** 拉取远端设备清单（同步页设备列表；失败时保留上次结果） */
  async refreshDevices() {
    const c = this._cfg();
    if (!c || !c.endpoint) return this.devices();
    try {
      const items = await webdav.list(webdav.joinUrl(c.endpoint, c.root, "devices"), c);
      const files = (items || []).filter((x) => /\.json$/i.test(x.name || x.href || ""));
      const out = [];
      for (const f of files.slice(0, 20)) {
        // 有些 WebDAV 服务端只回 href 不带 name：从 href 里取文件名，否则拼出 devices/undefined 永远读不到
        const base = String(f.name || f.href || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
        if (!base) continue;
        const url = webdav.joinUrl(c.endpoint, c.root, `devices/${base}`);
        try {
          const text = await webdav.getText(url, c);
          if (text) out.push(JSON.parse(text));
        } catch { /* 单台设备读取失败跳过 */ }
      }
      if (out.length) {
        this.state.devices = out.sort((a, b) => (b.lastSyncAt || 0) - (a.lastSyncAt || 0));
        this._saveState();
      }
    } catch { /* 远端没有 devices 目录时保持原值 */ }
    return this.devices();
  }

  _log(stage, detail) {
    const entry = { at: Date.now(), stage, detail };
    this.state.logs = [...(this.state.logs || []), entry].slice(-200);
    this.state.stage = stage;
    this.state.detail = detail;
    const base = { connect: 2, pull: 8, merge: 30, pack: 58, push: 88, done: 100, cancelled: 100, error: 100 };
    this.state.percent = base[stage] !== undefined ? base[stage] : this.state.percent || 0;
    this._saveState();
    this.emit({ type: "sync", stage, stageLabel: STAGE_LABEL[stage] || stage, percent: this.state.percent, detail, running: this.running });
  }

  cancel() {
    if (!this.running) return { ok: false, message: "没有正在进行的同步" };
    this.cancelFlag = true;
    // 中断在途网络请求：原先只置标志位，取消要等 30s 超时 + 2 次重试才停
    if (this._abort) this._abort.abort();
    return { ok: true };
  }

  /**
   * 执行一次同步：connect → pull → merge → pack → push。
   * 冲突一律进队列人工裁决，绝不静默选边（与 remotesync 同规矩）。
   */
  async run() {
    if (this.running) return { ok: false, message: "同步已在进行中" };
    const c = this._cfg();
    if (!c || !c.endpoint) return { ok: false, message: "未配置统一 WebDAV 服务器（设置 · 数据存储）" };
    const cfg = this.getConfig();
    if (cfg["sync.enabled"] === false) return { ok: false, message: "记忆中枢同步已关闭" };

    this.running = true;
    this.cancelFlag = false;
    this._abort = new AbortController();
    webdav.setActiveSignal(this._abort.signal);
    const result = { ok: false, uploaded: 0, downloaded: 0, conflicts: 0, merged: 0, tombstones: 0 };
    const stageDir = path.join(this.dataDir, "memory-sync-stage");
    try {
      this._log("connect", `连接 ${c.endpoint}`);
      const t = await webdav.test(c);
      if (!t.ok) throw new Error(t.message || "连接失败");

      // 远端根目录必须先建出来：webdav.test 把 404 当作「目录尚未创建」放行（连接仍算成功），
      // 但若不去建，接下来对 <root>/memory-latest.tar.gz 的 GET/PUT 在多数 WebDAV 服务器上
      // 返回的是 409 Conflict（父集合不存在）而不是 404 —— 于是「首次上传永远 409、之后每轮
      // GET 也 409」，同步被永久卡死且报错文案误导（409 看起来像冲突，其实目录根本不存在）。
      // 放在 connect 之后、任何读写之前；ensureDir 对「已存在」返回 405/409 视为成功，幂等。
      this._log("connect", `确保远端目录 ${c.root || "/"}`);
      await webdav.ensureDir(webdav.joinUrl(c.endpoint, c.root, ""), c);

      const remoteUrl = webdav.joinUrl(c.endpoint, c.root, PACK_NAME);
      this._log("pull", `探测远端 ${PACK_NAME}`);
      let remoteBuf = null;
      try {
        remoteBuf = await webdav.get(remoteUrl, c);
      } catch (e) {
        // 拉取失败（网络中断/超时/5xx）绝不能当「远端没有包」：那会跳过合并直接整包上传，
        // 把其他设备已同步的改动覆盖掉，且本地无备份不可逆。404 由 webdav.get 以 null 区分，
        // 只有 null 才走「首次上传」——异常一律中止本轮，宁可不同步也不覆盖远端
        throw new Error(`拉取远端包失败，本轮中止（为防覆盖远端未上传）：${String((e && e.message) || e)}`);
      }
      const remoteManifest = await this._readRemoteManifest(c);

      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.mkdirSync(stageDir, { recursive: true });

      let remoteReady = false;
      if (remoteBuf && remoteBuf.length) {
        this._log("merge", "解包远端 → 三方合并");
        const file = path.join(stageDir, PACK_NAME);
        fs.writeFileSync(file, remoteBuf);
        try {
          await unpackAsync(file, path.join(stageDir, "remote"));
          remoteReady = true;
        } catch (e) {
          // 远端包损坏（半截上传/传输错误）：原先每轮都炸在这一行 = 永久失败循环。
          // 按「远端无包」继续——随后的整包上传会覆盖坏包，同步自愈
          this._log("merge", `远端包损坏（${String(e.message || e).slice(0, 120)}），按首次上传处理，本轮跳过合并`);
        }
      }
      if (remoteReady) {
        // 合并的每一步都经写队列，且覆盖前复核本地 hash（同步期间 Agent 可能刚写过同一天的文件）
        const merged = await this.service.withWrite(async () => this._mergeRemote(path.join(stageDir, "remote"), remoteManifest));
        result.merged = merged.applied;
        result.conflicts = merged.conflicts;
        result.downloaded = merged.applied;
        try {
          profileCache.syncStoreToCache(this.service.store, this.dataDir);
        } catch {}
        this._saveState();
        if (merged.conflicts > 0) {
          this._log("done", `同步已暂停上传：检测到 ${merged.conflicts} 处文件冲突，为防覆盖远端数据已停止推送，请在「同步」页面解决冲突后再同步`);
          result.ok = false;
          result.message = `检测到 ${merged.conflicts} 处文件冲突，已停止覆盖远端，请裁决后再同步`;
          return result;
        }
      } else if (!remoteBuf || !remoteBuf.length) {
        this._log("merge", "远端没有包，本次为首次上传");
      }

      if (this.cancelFlag) {
        this._log("cancelled", "用户取消");
        this.running = false;
        return { ok: false, cancelled: true, message: "已取消" };
      }

      this._log("pack", "打包本地记忆");
      // 打包前自愈深层画像：若本地因版本更新缺失但持久缓存存在，先复原再打包上传
      try {
        profileCache.restoreIfMissing(this.service.store, this.dataDir, (rel) => this.service.reindexFile(rel));
      } catch {}
      const packFile = path.join(stageDir, PACK_NAME);
      const localOnly = this._localOnly();
      await packMemoryTree(this.rootDir, packFile, { includeIndex: cfg["sync.excludeIndex"] === false, localOnly });
      const localManifest = await buildManifest(this.rootDir, { localOnly });
      const packBytes = fs.statSync(packFile).size;
      // sync.packSizeLimitMB：schema 里挂了很久的"假旋钮"，这里真正落地
      const limitMB = Number(cfg["sync.packSizeLimitMB"] || 0);
      if (limitMB > 0 && packBytes > limitMB * 1048576) {
        throw new Error(`同步包 ${(packBytes / 1048576).toFixed(1)}MB 超过上限 ${limitMB}MB：请清理仓库或调大「单包体积上限」`);
      }

      this._log("push", `上传 ${PACK_NAME}（${(packBytes / 1048576).toFixed(1)}MB）`);
      await webdav.put(remoteUrl, c, fs.readFileSync(packFile));
      // 清单与包一同上传：下一轮 pull 才有东西可比（早期只读不写，比对分支永远走不通）
      try {
        await webdav.put(webdav.joinUrl(c.endpoint, c.root, "memory-manifest.json"), c, JSON.stringify({
          at: Date.now(),
          deviceId: this.state.deviceId || "",
          pack: PACK_NAME,
          packBytes,
          manifest: localManifest,
        }));
      } catch (e) {
        this._log("push", `清单上传失败（不影响本次包同步）：${String(e.message || e)}`);
      }
      // 设备登记：每台机器一个 devices/<id>.json，供同步页「设备列表」与多机对照
      try {
        await webdav.ensureDir(webdav.joinUrl(c.endpoint, c.root, "devices"), c);
        await webdav.put(webdav.joinUrl(c.endpoint, c.root, `devices/${this.state.deviceId || "local"}.json`), c, JSON.stringify({
          deviceId: this.state.deviceId || "local",
          name: this.deviceName || "",
          lastSyncAt: Date.now(),
          files: Object.keys(localManifest).length,
        }));
      } catch (e) {
        this._log("push", `设备登记失败（不影响本次同步）：${String(e.message || e)}`);
      }
      result.uploaded = 1;

      this.state.lastSyncAt = Date.now();
      this.state.lastHash = sha256File(packFile);
      this.state.baseline = localManifest;
      this.state.packs = [...(this.state.packs || []), { at: Date.now(), bytes: packBytes, files: Object.keys(localManifest).length, dir: "upload" }].slice(-20);
      this._log("done", `同步完成：上传 ${(packBytes / 1048576).toFixed(1)}MB · 冲突 ${result.conflicts} 条`);
      result.ok = true;
      this.service.index.setMeta("lastSyncAt", String(Date.now()));
      return result;
    } catch (e) {
      this._log("error", String(e.message || e));
      return { ok: false, message: String(e.message || e), ...result };
    } finally {
      this.running = false;
      webdav.setActiveSignal(null);
      this._abort = null;
      this._saveState();
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
      this.emit({ type: "sync", stage: this.state.stage, running: false, percent: this.state.percent, detail: this.state.detail });
    }
  }

  async _readRemoteManifest(c) {
    // 包内清单（若无则用基线兜底）
    try {
      const url = webdav.joinUrl(c.endpoint, c.root, "memory-manifest.json");
      const raw = await webdav.getText(url, c);
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.manifest === "object" ? parsed.manifest : null;
    } catch {
      return null;
    }
  }

  /** 三方合并：基线（上次同步的本地态）/ 本地 / 远端。
   *  async 化：清单构建（buildManifest）已 worker 化，这里改为 await 取结果。
   *  注意：合并循环本身仍是主线程同步执行（逐文件读盘/哈希/解析/写库），
   *  未做周期性让出——重活（数千文件 sha256）已移出主线程，剩余部分量级受变更数约束。 */
  async _mergeRemote(remoteDir, remoteManifest) {
    const localOnly = this._localOnly();
    const baseline = this.state.baseline || {};
    const localManifest = await buildManifest(this.rootDir, { localOnly });
    const remote = remoteManifest || (await buildManifest(remoteDir, { localOnly }));
    let applied = 0;
    let conflicts = 0;
    const conflictList = [...(this.state.conflicts || [])];

    const allFiles = new Set([...Object.keys(localManifest), ...Object.keys(remote), ...Object.keys(baseline)]);

    // 「落地远端版本」批量化：写盘交给 worker（占单文件开销 54%，且含 fsyncSync 与两次 rename），
    // 索引写入（removeByPath + reindexFile，约 3ms/文件）留在主线程——SQLite 是单写者，
    // 不能让 worker 与主线程各持一个连接。每批之间让出事件循环，否则大额变更下界面仍会长时间无响应
    // （实测未让出时：1000 个变更文件冻结 12.1s、3000 个冻结 45.0s，约 15ms/文件线性放大）。
    const APPLY_BATCH = 25;
    let pendingApply = [];
    const failedDetail = [];
    // 常驻落地会话：一次 merge 只启动一个 worker（早先每批新建时 3000 文件要启动 120 次，
    // 总耗时反而比改动前涨 51%）；broken 之后不再重试，整轮退回主线程写
    let applySession = null;
    let applySessionBroken = false;
    // 落地前的最后一道守卫：决策用的是 merge 开始时的清单快照，而批次会排队等 worker，
    // 窗口内该文件可能已被写（MCP 桥是独立进程，不经 withWrite 也拦不住）。此时不能盲目覆盖，
    // 升级为冲突交给用户裁决——旧实现窗口是单文件级、现在是批次级，必须补这道检查。
    // 两种都算并发写：① 快照里有它、现在哈希对不上；② 快照里本地没有它（远端新增，或本地读不到），
    // 现在却冒出来了。原实现只查了 ①，漏了「窗口内本地新建同名文件」这条。
    // 返回当前本地条目（含 size/mtime，冲突页要显示）或 null。
    const concurrentLocalWrite = (job) => {
      const now = statEntry(path.join(this.rootDir, job.rel)); // 读不到 → null
      if (!now) return null;
      return job.expectHash ? (now.hash !== job.expectHash ? now : null) : now;
    };
    const flushApply = async () => {
      if (!pendingApply.length) return;
      const batch = pendingApply;
      pendingApply = [];
      const safe = [];
      for (const job of batch) {
        const stale = concurrentLocalWrite(job);
        if (stale) {
          conflictList.push({
            kind: "memory", path: job.rel, local: stale, remote: job.remoteEntry || null,
            localText: capText(readText(path.join(this.rootDir, job.rel))),
            remoteText: job.src ? capText(readText(job.src)) : capText(String(job.content || "")),
            detectedAt: Date.now(), note: "同步期间本地又被修改",
          });
          conflicts++;
          continue;
        }
        safe.push(job);
      }
      let written = [];
      let needFallback = applySessionBroken;
      if (!applySessionBroken && safe.length) {
        try {
          if (!applySession) {
            const { openApplySession } = require("./sync-apply-worker.cjs");
            applySession = openApplySession({ rootDir: this.rootDir, timeoutMs: 5 * 60 * 1000 });
          }
          const r = await applySession.applyBatch(safe);
          written = r.applied.map((a) => a.rel);
          for (const f of r.failed) failedDetail.push(f);
        } catch (e) {
          // worker 不可用（环境异常/超时熔断）→ 本轮退回主线程逐文件写，行为与改动前一致，功能不丢
          applySessionBroken = true;
          needFallback = true;
          try { if (applySession) applySession.close(); } catch { /* 已退出 */ }
          applySession = null;
          this.emit({ type: "sync", stage: this.state.stage || "merge", detail: `落地 worker 不可用（${String((e && e.message) || e).slice(0, 80)}），改用主线程落地`, running: true, percent: this.state.percent });
        }
      }
      if (needFallback) {
        for (const j of safe) {
          try {
            const text = typeof j.content === "string" ? j.content : fs.readFileSync(j.src, "utf8");
            this.service.store.writeAtomic(j.rel, text, { backup: true });
            written.push(j.rel);
          } catch (err) {
            // 记录到具体 rel：worker 路径能记，退化路径也要能记，否则只剩一个数字无法定位
            failedDetail.push({ rel: j.rel, message: String((err && err.message) || err) });
          }
        }
      }
      applied += written.length;
      for (const rel of written) {
        try {
          this.service.index.removeByPath(rel);
          this.service.reindexFile(rel);
        } catch (e) {
          // 单个文件索引失败不中止整批：文件已落地，索引可由下次扫描/重建恢复
          failedDetail.push({ rel, message: String((e && e.message) || e) });
          this.emit({ type: "sync", stage: this.state.stage || "merge", detail: `索引更新失败（文件已落地，可重建索引恢复）：${rel}`, running: true, percent: this.state.percent });
        }
      }
      // 让出事件循环：这批的索引写入已经做完，先把控制权还给界面/记忆 API
      await new Promise((r) => setImmediate(r));
    };

    /** 逐文件三方决策：只做判定与入队，不写盘（写盘由 flushApply 批量交给 worker）。
     *  返回即代表这一条处理完（原 for 循环里的 continue → return）。 */
    const decide = (rel) => {
      if (shouldSkip(rel, localOnly)) return;
      const b = baseline[rel];
      const l = localManifest[rel];
      const r = remote[rel];
      const localChanged = !sameManifestEntry(l, b);
      const remoteChanged = !sameManifestEntry(r, b);

      if (!remoteChanged && !localChanged) return;

      const remoteFile = path.join(remoteDir, rel);
      const localFile = path.join(this.rootDir, rel);

      // 仅远端改 → 落地（先备份）
      if (remoteChanged && !localChanged) {
        if (!r) {
          // 远端删除：本地进回收站。删除的传播靠的是整包替换上传（本地少文件 = 远端包少文件），
          // 墓碑只是审计留痕与进度计数，不参与合并判定（若未来改增量上传，必须在这里读它）
          if (l && fs.existsSync(localFile)) {
            this.service.store.moveToTrash(rel);
            this.service.index.removeByPath(rel);
          }
          this.state.tombstones = [...(this.state.tombstones || []), { rel, at: Date.now(), by: "remote" }].slice(-500);
          applied++;
          return;
        }
        if (fs.existsSync(remoteFile)) {
          // 只入队，不在这里写：写盘由 flushApply 批量交给 worker，索引写入随后在主线程统一做。
          // expectHash 供 flushApply 做落地前守卫（批次排队期间本地可能又被写过）
          pendingApply.push({ rel, src: remoteFile, expectHash: l ? l.hash : null, remoteEntry: r });
        }
        return;
      }

      // 本地在快照之后又被写过（同步期间 Agent 落盘）→ 不允许直接覆盖，一律升级为冲突
      if (r && localChanged) {
        const liveHash = hashOfFile(localFile);
        if (liveHash && l && liveHash !== l.hash) {
          conflictList.push({
            kind: "memory", path: rel, local: { ...l, hash: liveHash }, remote: r,
            localText: capText(readText(localFile)), remoteText: capText(readText(remoteFile)),
            detectedAt: Date.now(), note: "同步期间本地又被修改",
          });
          conflicts++;
          return;
        }
      }

      // 两边都改：内容相同视为无冲突
      if (remoteChanged && localChanged) {
        const same = l && r && l.hash === r.hash;
        if (same) return;
        if (!l && r) {
          // 本地没有（可能是本地删了）→ 冲突。remoteText 必须带上：keepRemote 裁决靠它落地，
          // 缺了会让 resolve 两个分支都不命中，「已裁决」变成静默空操作
          conflictList.push({
            kind: "memory", path: rel, local: null, remote: r,
            localText: "", remoteText: capText(readText(remoteFile)),
            detectedAt: Date.now(), note: "远端新增 / 本地不存在",
          });
          conflicts++;
          return;
        }
        if (l && !r) {
          conflictList.push({
            kind: "memory", path: rel, local: l, remote: null,
            localText: capText(readText(localFile)), remoteText: "",
            detectedAt: Date.now(), note: "本地有 / 远端已删",
          });
          conflicts++;
          return;
        }
        if (isDailyPath(rel) && fs.existsSync(localFile) && fs.existsSync(remoteFile)) {
          const autoMerged = tryMergeDailyFiles(localFile, remoteFile);
          if (autoMerged.ok) {
            // 同样入队：daily 三方合并的「结果文本」只有主线程算得出，所以带 content 入队，
            // 写盘仍由 worker 做。否则双设备同天写记忆时，这条路径会退回主线程逐文件写盘而重新冻结。
            pendingApply.push({ rel, content: autoMerged.content, expectHash: l ? l.hash : null, remoteEntry: r });
            return;
          }
        }
        conflictList.push({
          kind: "memory",
          path: rel,
          local: l,
          remote: r,
          localText: capText(readText(localFile)),
          remoteText: capText(readText(remoteFile)),
          detectedAt: Date.now(),
          note: "双方都改了",
        });
        conflicts++;
      }
    };
    // 用 try/finally 收尾：抛异常时也要把待落地批次冲掉并关闭常驻 worker，避免线程泄漏
    try {
      for (const rel of allFiles) {
        if (pendingApply.length >= APPLY_BATCH) await flushApply();
        decide(rel);
      }
    } finally {
      try { await flushApply(); } catch { /* 收尾失败不掩盖原始异常 */ }
      if (applySession) { try { applySession.close(); } catch { /* 已退出 */ } applySession = null; }
    }
    this.state.conflicts = conflictList.slice(-200);
    this._saveConflicts();
    if (conflicts) this.emit({ type: "conflict", count: conflicts });
    if (failedDetail.length) this.emit({ type: "sync", stage: this.state.stage || "merge", detail: `本轮有 ${failedDetail.length} 个文件落地/索引更新失败（${failedDetail.slice(0, 3).map((f) => f.rel).join("、")}${failedDetail.length > 3 ? " 等" : ""}），将随下次同步重试`, running: false, percent: this.state.percent });
    return { applied, conflicts, applyFailed: failedDetail.length };
  }

  // ---------- 冲突裁决 ----------

  conflictsList() {
    return (this.state.conflicts || []).map((c, i) => ({ index: i, ...c }));
  }

  /**
   * 按路径批量移除冲突记录（自动清理「冲突的记忆」后收口用：记录还挂在已删除的路径上，
   * 用户再去裁决会指向不存在的文件）。只移除记录，不动任何文件——文件删除由调用方完成。
   * @param {string[]} paths 记忆相对路径
   * @returns {number} 移除的冲突条数
   */
  dropConflicts(paths) {
    const wanted = new Set((Array.isArray(paths) ? paths : [])
      .map((p) => String(p || "").toLowerCase()).filter(Boolean));
    if (!wanted.size) return 0;
    const list = this.state.conflicts || [];
    const kept = list.filter((c) => !wanted.has(String((c && c.path) || "").toLowerCase()));
    const removed = list.length - kept.length;
    if (removed) {
      this.state.conflicts = kept;
      this._saveConflicts();
      this.emit({ type: "conflict", count: kept.length });
    }
    return removed;
  }

  conflictDiff(index) {
    const c = (this.state.conflicts || [])[index];
    if (!c) return { ok: false, message: "冲突不存在" };
    return {
      ok: true,
      path: c.path,
      note: c.note,
      local: c.local || null,
      remote: c.remote || null,
      localText: c.localText || (c.local ? readText(path.join(this.rootDir, c.path)) : ""),
      remoteText: c.remoteText || "",
    };
  }

  /** 裁决：keepLocal / keepRemote / keepBoth / 合并文本 */
  async resolve(index, decision, mergedText) {
    const list = [...(this.state.conflicts || [])];
    const c = list[index];
    if (!c) return { ok: false, message: "冲突不存在" };
    const localFile = path.join(this.rootDir, c.path);
    try {
      if (decision === "keepLocal") {
        // 保持本地：把远端内容丢弃（但把远端文本留档到 reports）
        archiveConflict(c, this.rootDir);
      } else if (decision === "keepRemote") {
        // 必须先判 remote === null（远端已删）：远端删除时 remoteText 是空串而不是 null，
        // 若先判 remoteText != null，会把「删除」走成「把空串写回本地」，静默清空文件
        if (c.remote === null) {
          await this.service.withWrite(async () => {
            this.service.store.moveToTrash(c.path);
            this.service.index.removeByPath(c.path);
          });
        } else {
          const remoteText = typeof c.remoteText === "string" ? c.remoteText : "";
          // 远端有内容却没有可写文本（读取失败/截断丢失）：宁可让用户重新同步，也不能写空覆盖
          if (!remoteText && c.remote && Number(c.remote.size) > 0) {
            return { ok: false, message: "远端内容缺失，无法保留远端版本；请重新同步后再裁决" };
          }
          await this.service.withWrite(() => {
            this.service.store.writeAtomic(c.path, remoteText, { backup: true });
            this.service.index.removeByPath(c.path);
            this.service.reindexFile(c.path);
          });
        }
      } else if (decision === "keepBoth") {
        if (c.remote) {
          const alt = c.path.replace(/\.md$/, `.remote-${Date.now()}.md`);
          const remoteText = typeof c.remoteText === "string" ? c.remoteText : "";
          if (!remoteText && c.remote && Number(c.remote.size) > 0) {
            return { ok: false, message: "远端内容缺失，无法保留远端版本；请重新同步后再裁决" };
          }
          await this.service.withWrite(() => {
            this.service.store.writeAtomic(alt, remoteText);
            this.service.reindexFile(alt);
          });
        }
      } else if (decision === "merge" && typeof mergedText === "string") {
        await this.service.withWrite(() => {
          this.service.store.writeAtomic(c.path, mergedText, { backup: true });
          this.service.reindexFile(c.path);
        });
      } else {
        return { ok: false, message: "未知裁决" };
      }
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
    this.state.conflicts = list.filter((_, i) => i !== index);
    this._saveConflicts();
    // 裁决后基线记「远端当前版本」，而不是「本地当前版本」。
    // 裁决表达的是本地意图，此刻远端还没收到；把基线推成本地版本会让下次 merge 得到
    // localChanged=false + remoteChanged=true（远端仍是旧版）→ 走「仅远端改」把本地覆盖回旧版，
    // 裁决被静默撤销（实测：keepLocal 后再次同步本地改动丢失；merge / keepBoth 的结果同理被覆盖）。
    // 记远端版本则本地改动读作「仅本地改」→ 保留本地，并在随后的 push 上传，语义正确。
    // 例外：keepRemote 已把本地写成远端内容，基线保持「本地当前版本」即可（两者内容一致）；
    // 若远端文本因超限被截断，旧口径还能让下次 merge 用远端完整版自愈。
    this.state.baseline[c.path] = decision === "keepRemote" ? statEntry(localFile) : pickEntry(c.remote);
    this._saveState();
    this.emit({ type: "sync", stage: this.state.stage || "idle", detail: `冲突已裁决：${c.path}`, running: false, percent: this.state.percent });
    return { ok: true };
  }

  /**
   * 批量裁决：[{ path, decision }]，逐条按 path 反查当前下标再执行。
   * 不用调用方传来的下标——裁决期间可能正好有同步事件刷新队列，旧下标会落到别的文件上。
   * 单条失败只跳过该条，其余照常执行，末尾汇总（部分成功也必须如实上报，不能吞成整体失败）。
   */
  async resolveMany(items) {
    const list = Array.isArray(items) ? items : [];
    const resolved = [];
    const failed = [];
    for (const it of list) {
      const rel = String((it && it.path) || "");
      const decision = it && it.decision;
      if (!rel || (decision !== "keepLocal" && decision !== "keepRemote")) {
        failed.push({ path: rel, message: "裁决参数不完整" });
        continue;
      }
      const idx = (this.state.conflicts || []).findIndex((c) => c.path === rel);
      if (idx === -1) {
        failed.push({ path: rel, message: "队列已变化，本条已被处理" });
        continue;
      }
      const r = await this.resolve(idx, decision);
      if (r && r.ok) resolved.push(rel);
      else failed.push({ path: rel, message: (r && r.message) || "裁决失败" });
    }
    return { ok: true, total: list.length, resolved: resolved.length, paths: resolved, failed };
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// 冲突双侧全文封顶（diff 视图只展示前 400 行，原文全量入队只是白白撑大冲突文件）
function capText(s, max = 256 * 1024) {
  const t = String(s || "");
  return t.length <= max ? t : t.slice(0, max) + "\n…（过长已截断）";
}

function archiveConflict(c, rootDir) {
  try {
    const dir = path.join(rootDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `conflict-${Date.now()}.md`);
    fs.writeFileSync(
      file,
      `# 同步冲突留档\n\n路径：${c.path}\n说明：${c.note || ""}\n裁决：保留本地\n\n## 远端版本（未采用）\n\n${c.remoteText || "（无内容）"}\n`,
      "utf8",
    );
  } catch { /* 留档失败不阻塞裁决 */ }
}

/** 打包记忆目录：默认排除索引库与回收站；sync.excludeIndex=false 时索引库也进包。
 *  walk+过滤留在主线程（readdir 级别的轻活，过滤规则本就在这一侧），读盘+tar+gzip 整体进 worker——
 *  那两段是同步 CPU/IO 大头，曾经把主进程事件循环占死约 40s（UI、记忆 API、9527 模型网关一起冻）。
 *  不再走 .packstage 暂存目录：按原始文件直接打包，省一趟整树拷贝；
 *  且 tar 头记录的是文件真实 mtime（staging 拷贝会把 mtime 盖成打包时刻），远端解包还原后冲突裁决按新旧比较才不失真。 */
async function packMemoryTree(rootDir, outFile, opts = {}) {
  const exclude = new Set([".trash", "_import", "node_modules"]);
  if (!opts.includeIndex) exclude.add("index");
  const localOnly = opts.localOnly || [];
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
      // 永不上传的项目整目录跳过（目录本身与内部文件都拦）
      if (isLocalOnly(rel + (e.isDirectory() ? "/" : ""), localOnly)) continue;
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        if (/\.bak(\.\d+)?$/.test(e.name) || /\.old\.\d+$/.test(e.name) || /\.tmp\.\d+$/.test(e.name)) continue;
        if (EXCLUDE_FILES.includes(e.name)) continue;
        files.push({ rel, abs });
      }
    }
  };
  walk(rootDir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)); // 与 treeHash 同序，包内容确定
  await packFilesAsync(files, outFile);
  return outFile;
}

module.exports = { MemorySync, STAGE_LABEL, buildManifest, shouldSkip, packMemoryTree };
