/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除声明。
 */

// 记忆仓库 · WebDAV 同步：全量 tar.gz 单包原子传输 + 清单比对 + 三方合并 + 冲突队列 + 墓碑。
// 复用框架既有能力：webdav.cjs（PROPFIND/GET/PUT）+ tarpack.cjs（tar.gz）+ config.moduleWebdav("memory")。
// 索引库不入包（可重建，且是二进制无法三方合并）；MD 是唯一事实源。
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const webdav = require("../webdav.cjs");
const { packDir, unpack } = require("../tarpack.cjs");

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
const EXCLUDE_DIRS = [".trash", "_import", "index", "node_modules"];
const EXCLUDE_FILES = ["memory-runtime.json", "memory.config.local.json", ".bridge-token"];

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

// 隐私白名单（privacy.localOnlyProjects，「永不上传的项目」）：
// projects/<slug>/... 不进包、不进清单、不参与合并——设置页对用户承诺了"永不上传"，
// 同步三个环节必须统一执行，不能只拦 LLM 任务侧
function isLocalOnly(rel, localOnly) {
  if (!localOnly || !localOnly.length) return false;
  const m = /^projects\/([^/]+)\//.exec(rel);
  return !!m && localOnly.includes(m[1]);
}

function shouldSkip(rel, localOnly) {
  if (isLocalOnly(rel, localOnly)) return true;
  const segs = rel.split("/");
  if (segs.some((s) => EXCLUDE_DIRS.includes(s))) return true;
  const base = segs[segs.length - 1];
  if (EXCLUDE_FILES.includes(base)) return true;
  if (/\.bak(\.\d+)?$/.test(base)) return true;
  if (/\.tmp(\.\d+)?$/.test(base)) return true;
  return false;
}

/** 本地清单：相对路径 → { size, mtime, hash }（跳过同步排除项与永不上传项目） */
function buildManifest(dir, opts = {}) {
  const localOnly = opts.localOnly || [];
  const out = {};
  const walk = (cur) => {
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (shouldSkip(rel, localOnly)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out[rel] = { size: st.size, mtime: Math.round(st.mtimeMs), hash: sha256File(full) };
        } catch { /* 读不到的文件跳过 */ }
      }
    }
  };
  walk(dir);
  return out;
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
        const url = webdav.joinUrl(c.endpoint, c.root, `devices/${String(f.name).split("/").pop()}`);
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
    if (cfg["sync.enabled"] === false) return { ok: false, message: "记忆仓库同步已关闭" };

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

      const remoteUrl = webdav.joinUrl(c.endpoint, c.root, PACK_NAME);
      this._log("pull", `探测远端 ${PACK_NAME}`);
      let remoteBuf = null;
      try {
        remoteBuf = await webdav.get(remoteUrl, c);
      } catch {
        remoteBuf = null;
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
          unpack(file, path.join(stageDir, "remote"));
          remoteReady = true;
        } catch (e) {
          // 远端包损坏（半截上传/传输错误）：原先每轮都炸在这一行 = 永久失败循环。
          // 按「远端无包」继续——随后的整包上传会覆盖坏包，同步自愈
          this._log("merge", `远端包损坏（${String(e.message || e).slice(0, 120)}），按首次上传处理，本轮跳过合并`);
        }
      }
      if (remoteReady) {
        // 合并的每一步都经写队列，且覆盖前复核本地 hash（同步期间 Agent 可能刚写过同一天的文件）
        const merged = await this.service.withWrite(() => this._mergeRemote(path.join(stageDir, "remote"), remoteManifest));
        result.merged = merged.applied;
        result.conflicts = merged.conflicts;
        result.downloaded = merged.applied;
        this._saveState();
      } else if (!remoteBuf || !remoteBuf.length) {
        this._log("merge", "远端没有包，本次为首次上传");
      }

      if (this.cancelFlag) {
        this._log("cancelled", "用户取消");
        this.running = false;
        return { ok: false, cancelled: true, message: "已取消" };
      }

      this._log("pack", "打包本地记忆");
      const packFile = path.join(stageDir, PACK_NAME);
      const localOnly = this._localOnly();
      packMemoryTree(this.rootDir, packFile, { includeIndex: cfg["sync.excludeIndex"] === false, localOnly });
      const localManifest = buildManifest(this.rootDir, { localOnly });
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

  /** 三方合并：基线（上次同步的本地态）/ 本地 / 远端 */
  _mergeRemote(remoteDir, remoteManifest) {
    const localOnly = this._localOnly();
    const baseline = this.state.baseline || {};
    const localManifest = buildManifest(this.rootDir, { localOnly });
    const remote = remoteManifest || buildManifest(remoteDir, { localOnly });
    let applied = 0;
    let conflicts = 0;
    const conflictList = [...(this.state.conflicts || [])];

    const allFiles = new Set([...Object.keys(localManifest), ...Object.keys(remote), ...Object.keys(baseline)]);
    for (const rel of allFiles) {
      if (shouldSkip(rel, localOnly)) continue;
      const b = baseline[rel];
      const l = localManifest[rel];
      const r = remote[rel];
      const localChanged = JSON.stringify(l || null) !== JSON.stringify(b || null);
      const remoteChanged = JSON.stringify(r || null) !== JSON.stringify(b || null);

      if (!remoteChanged && !localChanged) continue;

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
          continue;
        }
        if (fs.existsSync(remoteFile)) {
          this.service.store.writeAtomic(rel, fs.readFileSync(remoteFile, "utf8"), { backup: true });
          this.service.index.removeByPath(rel);
          this.service.reindexFile(rel);
          applied++;
        }
        continue;
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
          continue;
        }
      }

      // 两边都改：内容相同视为无冲突
      if (remoteChanged && localChanged) {
        const same = l && r && l.hash === r.hash;
        if (same) continue;
        if (!l && r) {
          // 本地没有（可能是本地删了）→ 冲突
          conflictList.push({ kind: "memory", path: rel, local: null, remote: r, detectedAt: Date.now(), note: "远端新增 / 本地不存在" });
          conflicts++;
          continue;
        }
        if (l && !r) {
          conflictList.push({ kind: "memory", path: rel, local: l, remote: null, detectedAt: Date.now(), note: "本地有 / 远端已删" });
          conflicts++;
          continue;
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
    }
    this.state.conflicts = conflictList.slice(-200);
    this._saveConflicts();
    if (conflicts) this.emit({ type: "conflict", count: conflicts });
    return { applied, conflicts };
  }

  // ---------- 冲突裁决 ----------

  conflictsList() {
    return (this.state.conflicts || []).map((c, i) => ({ index: i, ...c }));
  }

  conflictDiff(index) {
    const c = (this.state.conflicts || [])[index];
    if (!c) return { ok: false, message: "冲突不存在" };
    return {
      ok: true,
      path: c.path,
      note: c.note,
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
        if (c.remoteText != null) {
          await this.service.withWrite(() => {
            this.service.store.writeAtomic(c.path, c.remoteText, { backup: true });
            this.service.reindexFile(c.path);
          });
        } else if (c.remote === null) {
          // 远端已删：本地进回收站（走写队列，避免与 Agent 写入打架）
          await this.service.withWrite(async () => {
            this.service.store.moveToTrash(c.path);
            this.service.index.removeByPath(c.path);
          });
        }
      } else if (decision === "keepBoth") {
        if (c.remoteText != null) {
          const alt = c.path.replace(/\.md$/, `.remote-${Date.now()}.md`);
          await this.service.withWrite(() => {
            this.service.store.writeAtomic(alt, c.remoteText);
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
    this.state.baseline[c.path] = (() => {
      try {
        const st = fs.statSync(localFile);
        return { size: st.size, mtime: Math.round(st.mtimeMs), hash: sha256File(localFile) };
      } catch {
        return null;
      }
    })();
    this._saveState();
    this.emit({ type: "sync", stage: this.state.stage || "idle", detail: `冲突已裁决：${c.path}`, running: false, percent: this.state.percent });
    return { ok: true };
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

/** 打包记忆目录：默认排除索引库与回收站；sync.excludeIndex=false 时索引库也进包 */
function packMemoryTree(rootDir, outFile, opts = {}) {
  const exclude = new Set([".trash", "_import", "node_modules"]);
  if (!opts.includeIndex) exclude.add("index");
  const localOnly = opts.localOnly || [];
  const stage = path.join(path.dirname(outFile), ".packstage");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const copy = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const from = path.join(dir, e.name);
      const rel = path.relative(rootDir, from).replace(/\\/g, "/");
      // 永不上传的项目整目录跳过（目录本身与内部文件都拦）
      if (isLocalOnly(rel + (e.isDirectory() ? "/" : ""), localOnly)) continue;
      const to = path.join(stage, path.relative(rootDir, from));
      if (e.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        copy(from);
      } else if (e.isFile()) {
        if (/\.bak(\.\d+)?$/.test(e.name) || /\.old\.\d+$/.test(e.name) || /\.tmp\.\d+$/.test(e.name)) continue;
        if (EXCLUDE_FILES.includes(e.name)) continue;
        try { fs.copyFileSync(from, to); } catch { /* 单文件失败跳过 */ }
      }
    }
  };
  copy(rootDir);
  packDir(stage, outFile);
  fs.rmSync(stage, { recursive: true, force: true });
  return outFile;
}

module.exports = { MemorySync, STAGE_LABEL, buildManifest, shouldSkip, packMemoryTree };
