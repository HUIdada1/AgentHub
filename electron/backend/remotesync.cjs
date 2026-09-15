// 跨设备同步引擎：中央仓库 <-> WebDAV 远端（三方合并）
// 规矩：不自动选边（双边修改进冲突队列人工裁决）；删除走墓碑；远端孤儿自愈收录；
// 覆盖/删除先备份进 .trash；每次同步产出 MD 报告
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./config.cjs");
const hub = require("./hub.cjs");
const scanner = require("./scanner.cjs");
const syncer = require("./syncer.cjs");
const webdav = require("./webdav.cjs");
const tarpack = require("./tarpack.cjs");
const report = require("./report.cjs");

// 远端技能两种布局并存：skills/<name>.tar.gz（本版起，单文件原子传输）与
// skills/<name>/ 散目录（旧版客户端写的，读端仍兼容）。上传统一打包，散目录懒迁移：
// 没改动的旧技能保持原样，有更新重传时自然换成包
const PACK_EXT = ".tar.gz";

const STAGE_LABEL = {
  idle: "空闲",
  connect: "连接检查",
  pull: "拉取清单",
  download: "下载技能",
  upload: "上传技能",
  push: "推送台账",
  done: "同步完成",
  cancelled: "已取消",
  error: "同步失败",
};

// 进度百分比各阶段基准（循环内按完成数插值）；阶段没任务时自动落到基准
const STAGE_BASE = { connect: 2, pull: 8, download: 26, upload: 58, push: 90, done: 100 };

let state = { running: false, stage: "idle", pct: 0, detail: "", lastError: "", lastSyncAt: "" };
let logs = []; // 最近日志（环形），页面打开时补历史
let cancelSignal = null;
let onFinish = null; // 同步结束回调（main.cjs 注入：托盘菜单刷新 + 系统通知）

function setOnFinish(cb) {
  onFinish = typeof cb === "function" ? cb : null;
}

function log(text) {
  logs.push({ at: new Date().toISOString(), text });
  if (logs.length > 200) logs = logs.slice(-200);
}

function broadcast(payload) {
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("app:event", { event: "webdav", ...payload });
    }
  } catch { /* 自测环境无 electron */ }
}

function setStage(stage, detail, pct) {
  state.stage = stage;
  state.detail = detail || "";
  if (pct != null) state.pct = Math.min(100, Math.max(0, Math.round(pct)));
  else if (STAGE_BASE[stage] != null) state.pct = STAGE_BASE[stage];
  log(`[${STAGE_LABEL[stage] || stage}] ${detail || ""}`);
  broadcast({ stage, detail: state.detail, pct: state.pct, running: state.running });
}

function isRunning() {
  return state.running;
}

function progress() {
  return { ...state, stageLabel: STAGE_LABEL[state.stage] || state.stage };
}

function recentLogs() {
  return logs;
}

function cancel() {
  if (cancelSignal) cancelSignal.abort();
  return { ok: true };
}

// ===== remote-state.json：上次同步快照（三方合并的 base）+ 调度器记账 =====

function stateFile() {
  return path.join(config.hubDir(), "remote-state.json");
}

function loadRemoteState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
    return { lastSyncAt: "", base: {}, sched: {}, ...s };
  } catch {
    return { lastSyncAt: "", base: {}, sched: {} };
  }
}

function saveRemoteState(s) {
  config.ensureHub();
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), "utf-8");
}

// ===== 远端布局：<root>/manifest.json + devices/<id>.json + skills/<name>/ =====

function remoteUrl(cfg, ...segs) {
  return webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, segs.join("/"));
}

function configured(cfg) {
  const w = cfg.webdav || {};
  return !!(w.endpoint && w.username && w.password);
}

// 远端台账不存 mounts（挂载是纯本机概念，存了会把 A 机器路径带给 B）
function stripForRemote(entry) {
  return {
    name: entry.name,
    version: entry.version || "",
    description: entry.description || "",
    treeHash: entry.treeHash,
    skillName: entry.skillName || entry.name,
    sources: entry.sources || [],
    mergeHistory: entry.mergeHistory || [],
    health: entry.health || [],
  };
}

// ===== 目录传输 =====

async function uploadSkillDir(cfg, localDir, remoteRel) {
  const name = remoteRel.split("/").pop();
  // 打包成临时文件再一次性 PUT：包小，整读内存无压力
  const tmpPkg = path.join(config.hubDir(), ".remote-tmp", `${name}${PACK_EXT}`);
  fs.mkdirSync(path.dirname(tmpPkg), { recursive: true });
  const n = tarpack.packDir(localDir, tmpPkg);
  try {
    await webdav.put(remoteUrl(cfg, `${remoteRel}${PACK_EXT}`), cfg.webdav, fs.readFileSync(tmpPkg));
  } finally {
    fs.rmSync(tmpPkg, { force: true });
  }
  // 旧散目录若在就清掉（404 幂等）。删不动只记日志不判失败：包已传成，
  // 读端靠哈希校验能分辨散目录是旧残渣还是旧客户端新写的
  try {
    await webdav.remove(remoteUrl(cfg, remoteRel), cfg.webdav);
  } catch (e) {
    log(`旧散目录 ${remoteRel} 清理失败：${e.message}`);
  }
  return n;
}

// 散目录递归下载（旧版布局与回退路径共用）
async function downloadLooseDir(cfg, remoteRel, destDir) {
  const entries = await webdav.list(remoteUrl(cfg, remoteRel), cfg.webdav);
  let n = 0;
  for (const e of entries) {
    if (e.isDir) {
      n += await downloadLooseDir(cfg, `${remoteRel}/${e.name}`, path.join(destDir, e.name));
      continue;
    }
    const buf = await webdav.get(remoteUrl(cfg, remoteRel, e.name), cfg.webdav);
    if (buf == null) throw new Error(`远端文件缺失：${remoteRel}/${e.name}`);
    fs.writeFileSync(path.join(destDir, e.name), buf);
    n++;
  }
  return n;
}

/**
 * 下载远端技能：散目录优先，解压包兜底。expectHash（台账哈希）用来分辨散目录是
 * 旧客户端刚写的新内容还是包上传后没删干净的残渣——散目录内容与账不符时换包。
 * 两种都拿不到合法内容就抛错，让上层按跳过处理，绝不拿残渣冒充技能。
 */
async function downloadSkillDir(cfg, remoteRel, destDir, expectHash) {
  const name = remoteRel.split("/").pop();
  fs.mkdirSync(destDir, { recursive: true });
  const loose = await downloadLooseDir(cfg, remoteRel, destDir);
  if (loose > 0 && (!expectHash || scanner.treeHash(destDir) === expectHash)) return loose;
  if (loose > 0) fs.rmSync(destDir, { recursive: true, force: true }); // 残渣，换包重下
  const pkg = await webdav.get(remoteUrl(cfg, `${remoteRel}${PACK_EXT}`), cfg.webdav);
  if (pkg == null) {
    throw new Error(`远端技能内容不一致且无压缩包可用：${name}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const tmpPkg = path.join(config.hubDir(), ".remote-tmp", `${name}${PACK_EXT}`);
  fs.mkdirSync(path.dirname(tmpPkg), { recursive: true });
  fs.writeFileSync(tmpPkg, pkg);
  try {
    return tarpack.unpack(tmpPkg, destDir);
  } finally {
    fs.rmSync(tmpPkg, { force: true });
  }
}

// ===== 同步主流程 =====

async function run(cfg) {
  if (state.running) throw new Error("同步已在进行中");
  if (!configured(cfg)) throw new Error("WebDAV 未配置完整（服务器地址 / 账号 / 密码）");

  state = { running: true, stage: "connect", pct: STAGE_BASE.connect, detail: "", lastError: "", lastSyncAt: state.lastSyncAt };
  cancelSignal = new AbortController();
  webdav.setActiveSignal(cancelSignal.signal);
  broadcast({ stage: "connect", pct: state.pct, running: true });

  const deviceId = cfg.webdav.deviceId;
  const deviceName = cfg.webdav.deviceName || "这台电脑";
  const result = {
    device: deviceName,
    endpoint: `${cfg.webdav.endpoint}${cfg.webdav.root}`,
    downloads: [], uploads: [], conflicts: [], deletions: [], orphans: [],
    summary: { downloaded: 0, uploaded: 0, conflicts: 0, deletedRemote: 0, deletedLocal: 0, skipped: 0 },
  };
  const rstate = loadRemoteState();
  let aborted = false;

  try {
    // ---- 连接检查 ----
    setStage("connect", "检查远端连接…");
    const t = await webdav.test(cfg.webdav);
    if (!t.ok) throw new Error(t.message);
    await webdav.ensureDir(remoteUrl(cfg, "skills"), cfg.webdav);
    await webdav.ensureDir(remoteUrl(cfg, "devices"), cfg.webdav);

    reconcileManifest(); // 本机目录与台账对账后再合并，迁移/手工拷贝的技能才推得出去

    // ---- 拉取清单 + 算三方 diff ----
    setStage("pull", "拉取远端台账…");
    const manifestText = await webdav.getText(remoteUrl(cfg, "manifest.json"), cfg.webdav);
    let remoteManifest = null;
    if (manifestText != null) {
      try { remoteManifest = JSON.parse(manifestText); } catch { remoteManifest = null; }
    }
    if (!remoteManifest || typeof remoteManifest !== "object") remoteManifest = { version: 1, skills: {}, deleted: {} };
    if (!remoteManifest.skills || typeof remoteManifest.skills !== "object") remoteManifest.skills = {};
    if (!remoteManifest.deleted || typeof remoteManifest.deleted !== "object") remoteManifest.deleted = {};

    const localManifest = hub.loadManifest();
    // 远端技能集：散目录（旧版布局）+ *.tar.gz 包（新版布局）合并收集，两种布局读端都认
    const remoteSkills = [];
    for (const e of await webdav.list(remoteUrl(cfg, "skills"), cfg.webdav)) {
      const name = e.isDir ? e.name : e.name.endsWith(PACK_EXT) ? e.name.slice(0, -PACK_EXT.length) : "";
      if (name && !remoteSkills.includes(name)) remoteSkills.push(name);
    }
    setStage("pull", `远端台账 ${Object.keys(remoteManifest.skills).length} 个技能，本机 ${Object.keys(localManifest.skills).length} 个`, 16);

    const plan = computePlan(localManifest, remoteManifest, remoteSkills, rstate);
    log(`计划：下载 ${plan.downloads.length} · 上传 ${plan.uploads.length} · 冲突 ${plan.conflicts.length} · 删远端 ${plan.deleteRemote.length} · 删本机 ${plan.deleteLocal.length}`);

    // ---- 冲突检出：远端版下载到暂存供裁决 ----
    for (let ci = 0; ci < plan.conflicts.length; ci++) {
      const c = plan.conflicts[ci];
      setStage("pull", `检出冲突 ${c.name}（远端版暂存中）`, 18 + ((ci + 1) / plan.conflicts.length) * 8);
      const staging = stagingDir(c.name);
      fs.rmSync(staging, { recursive: true, force: true });
      // 暂存也带台账哈希：散目录残渣与新包并存时（服务器删不动散目录），
      // 不校验会把残渣当远端版暂存，keepRemote 裁决等于拿过时内容覆盖本机
      try {
        await downloadSkillDir(cfg, `skills/${c.name}`, staging, c.remoteHash);
        syncer.upsertConflict({
          id: `remote:${c.name}`,
          kind: "remote",
          skill: c.name,
          title: `${c.name} 本机与远端内容冲突`,
          detail: c.reason,
          localHash: c.localHash,
          remoteHash: c.remoteHash,
        });
        result.conflicts.push(c.name);
        result.summary.conflicts++;
        log(`${c.name} 冲突已入队（远端版已暂存，去「去重与冲突」页裁决）`);
      } catch (e) {
        log(`${c.name} 远端版暂存失败：${e.message}，本次按跳过处理`);
        result.summary.skipped++;
      }
    }

    // ---- 下载导入 ----
    if (plan.downloads.length) setStage("download", `待下载 ${plan.downloads.length} 个技能`);
    for (let di = 0; di < plan.downloads.length; di++) {
      const d = plan.downloads[di];
      checkAborted();
      setStage("download", `下载 ${d.name}（${d.reason}）`, 26 + ((di + 1) / plan.downloads.length) * 30);
      const tmp = path.join(config.hubDir(), ".remote-tmp", d.name);
      fs.rmSync(tmp, { recursive: true, force: true });
      try {
        await downloadSkillDir(cfg, `skills/${d.name}`, tmp, d.entry ? d.entry.treeHash : null);
        const hash = scanner.treeHash(tmp);
        deployDownload(d, tmp, hash, remoteManifest, result);
        rstate.base[d.name] = hash;
      } catch (e) {
        log(`${d.name} 下载失败：${e.message}，跳过`);
        result.summary.skipped++;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    // ---- 上传推送 ----
    if (plan.uploads.length) setStage("upload", `待上传 ${plan.uploads.length} 个技能`);
    for (let ui = 0; ui < plan.uploads.length; ui++) {
      const u = plan.uploads[ui];
      checkAborted();
      setStage("upload", `上传 ${u.name}（${u.reason}）`, 58 + ((ui + 1) / plan.uploads.length) * 24);
      try {
        const localDir = path.join(hub.skillsDir(), u.name);
        const n = await uploadSkillDir(cfg, localDir, `skills/${u.name}`);
        result.uploads.push({ name: u.name, reason: u.reason, files: n });
        result.summary.uploaded++;
        // 本机台账对齐实际文件：用户改了技能文件后台账里的 treeHash 是旧的，
        // 不更新的话推给远端的台账就是旧哈希，其他设备会拉不到更新
        const realHash = scanner.treeHash(localDir);
        const m = hub.loadManifest();
        if (m.skills[u.name]) {
          m.skills[u.name].treeHash = realHash;
          hub.saveManifest(m);
        }
        rstate.base[u.name] = realHash;
      } catch (e) {
        log(`${u.name} 上传失败：${e.message}，跳过`);
        result.summary.skipped++;
      }
    }

    // ---- 删远端（本机墓碑传播）----
    for (let ri = 0; ri < plan.deleteRemote.length; ri++) {
      const name = plan.deleteRemote[ri];
      checkAborted();
      setStage("upload", `删除远端 ${name}（本机已删除）`, 82 + ((ri + 1) / plan.deleteRemote.length) * 4);
      try {
        // 先删包（活跃格式）再删散目录：散目录删不动（服务器拒绝递归 DELETE）也不会卡住包
        await webdav.remove(remoteUrl(cfg, "skills", `${name}${PACK_EXT}`), cfg.webdav);
        await webdav.remove(remoteUrl(cfg, "skills", name), cfg.webdav);
        result.deletions.push({ name, side: "远端" });
        result.summary.deletedRemote++;
      } catch (e) {
        log(`远端 ${name} 删除失败：${e.message}`);
      }
    }

    // ---- 删本机（远端墓碑生效）：归入推送段，让阶段进度保持单调不回跳 ----
    for (let li = 0; li < plan.deleteLocal.length; li++) {
      const name = plan.deleteLocal[li];
      checkAborted();
      setStage("push", `本机 ${name} 移入回收站（远端已删除）`, 86 + ((li + 1) / plan.deleteLocal.length) * 4);
      try {
        const dir = path.join(hub.skillsDir(), name);
        if (fs.existsSync(dir)) hub.toTrash(dir, name);
        const m = hub.loadManifest();
        delete m.skills[name];
        m.deleted[name] = remoteManifest.deleted[name];
        hub.saveManifest(m);
        delete rstate.base[name];
        result.deletions.push({ name, side: "本机" });
        result.summary.deletedLocal++;
      } catch (e) {
        log(`本机 ${name} 删除失败：${e.message}`);
      }
    }

    // ---- 合并台账并推回远端 ----
    checkAborted();
    setStage("push", "合并台账并推送…");
    // 重新读盘：下载/删除步骤已经更新过本地 manifest，不能用开头那份旧引用。
    // 只有本机真正落盘执行过的事实（上传/下载/孤儿）才上账；冲突技能保持远端条目不动，
    // 否则本机未裁决的版本会悄悄覆盖远端台账，破坏"不自动选边"
    const landed = new Set([...result.uploads.map((u) => u.name), ...result.downloads.map((d) => d.name)]);
    const merged = mergeManifests(hub.loadManifest(), remoteManifest, landed);
    const remotePayload = JSON.stringify(merged, null, 2);
    const oldRemoteText = manifestText || "";
    const oldRemoteNoStamp = oldRemoteText.replace(/"updatedAt"\s*:\s*"[^"]*"/, "");
    const newRemoteNoStamp = remotePayload.replace(/"updatedAt"\s*:\s*"[^"]*"/, "");
    if (oldRemoteNoStamp.trim() !== newRemoteNoStamp.trim()) {
      await webdav.put(remoteUrl(cfg, "manifest.json"), cfg.webdav, remotePayload);
    } else {
      log("远端台账无变化，跳过推送");
    }
    await webdav.put(remoteUrl(cfg, "devices", `${deviceId}.json`), cfg.webdav,
      JSON.stringify({ name: deviceName, appVersion: appVersion(), lastSyncAt: new Date().toISOString() }));

    // ---- 收尾：快照 + 报告 ----
    rstate.lastSyncAt = new Date().toISOString();
    saveRemoteState(rstate);
    state.lastSyncAt = rstate.lastSyncAt;
    result.reportFile = report.writeRemoteSyncReport(result);
    result.summary.downloaded = result.downloads.length;
    result.summary.uploaded = result.uploads.length;

    state.running = false;
    setStage("done", `下载 ${result.summary.downloaded} · 上传 ${result.summary.uploaded} · 冲突 ${result.summary.conflicts} · 跳过 ${result.summary.skipped}`);
    if (onFinish) onFinish(true, state.detail);
    return { ok: true, ...result };
  } catch (e) {
    state.running = false;
    if (e && e.name === "AbortError") {
      aborted = true;
      state.stage = "cancelled";
      state.detail = "同步已取消";
      log("同步已取消");
      broadcast({ stage: "cancelled", running: false });
    } else {
      state.stage = "error";
      state.lastError = (e && e.message) || String(e);
      state.detail = state.lastError;
      log(`同步失败：${state.lastError}`);
      broadcast({ stage: "error", running: false, detail: state.lastError });
    }
    if (onFinish && !aborted) onFinish(false, state.lastError);
    return { ok: false, cancelled: aborted, message: aborted ? "同步已取消" : state.lastError };
  } finally {
    cancelSignal = null;
    webdav.setActiveSignal(null);
  }
}

function checkAborted() {
  if (cancelSignal && cancelSignal.signal.aborted) {
    throw Object.assign(new Error("同步已取消"), { name: "AbortError" });
  }
}

function appVersion() {
  try { return require("electron").app.getVersion(); } catch { return ""; }
}

function stagingDir(name) {
  return path.join(config.hubDir(), ".remote-staging", name);
}

function localSkillNames() {
  const dir = hub.skillsDir();
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// 本机 skills/ 目录与台账对账：有目录没条目的现场补录
// （从旧电脑整目录迁移、手工把技能拷进 ~/.agent_skills/skills/ 的场景）
function reconcileManifest() {
  const m = hub.loadManifest();
  let changed = false;
  for (const name of localSkillNames()) {
    if (m.skills[name]) continue;
    const dir = path.join(hub.skillsDir(), name);
    let info = { name: "", description: "", version: "" };
    try { info = scanner.parseSkillMd(dir).info; } catch { /* SKILL.md 坏了也照样收录 */ }
    m.skills[name] = {
      name,
      version: info.version || "",
      description: info.description || "",
      treeHash: scanner.treeHash(dir),
      skillName: info.name || name,
      sources: [{ tool: "local", originalName: name, firstSeen: new Date().toISOString() }],
      mounts: [],
      mergeHistory: [{ at: new Date().toISOString(), action: "remote-import", detail: "本机目录对账补录（无台账记录）" }],
      health: [],
    };
    changed = true;
  }
  if (changed) hub.saveManifest(m);
}

/**
 * 三方合并判定：base = 上次同步快照。
 * local 本机 skills/<name> 实际哈希；base 快照哈希；remote 远端台账哈希（null = 远端无）
 */
function computePlan(localManifest, remoteManifest, remoteSkills, rstate) {
  // 以两侧文件系统为准（本机 skills/ 目录 + 远端 skills/ 的目录或包），台账只是辅助记录
  const names = new Set([
    ...localSkillNames(),
    ...Object.keys(localManifest.skills),
    ...Object.keys(remoteManifest.skills),
    ...remoteSkills,
  ]);
  // 本机墓碑（removeSkill 写入）：treeHash 匹配的远端同名技能不再拉回
  const tombstones = localManifest.deleted || {};

  const plan = { downloads: [], uploads: [], conflicts: [], deleteRemote: [], deleteLocal: [], realigns: [] };
  for (const name of names) {
    const localDir = path.join(hub.skillsDir(), name);
    const localHash = fs.existsSync(localDir) ? scanner.treeHash(localDir) : null;
    const baseHash = rstate.base[name] || null;
    const remoteEntry = remoteManifest.skills[name];
    const remoteHash = remoteEntry ? remoteEntry.treeHash : null;

    if (localHash && !remoteHash) {
      // 远端无此技能
      if (baseHash && remoteManifest.deleted[name] && remoteManifest.deleted[name].treeHash === baseHash) {
        plan.deleteLocal.push(name); // 远端删除生效，本机跟随
      } else {
        plan.uploads.push({ name, reason: baseHash ? "远端台账缺失，推回本机版" : "本机新技能" });
      }
      continue;
    }
    if (!localHash && remoteHash) {
      // 本机无此技能：墓碑命中则尊重删除并清理远端，否则下载
      if (tombstones[name] && tombstones[name].treeHash === remoteHash) {
        plan.deleteRemote.push(name);
      } else {
        plan.downloads.push({ name, reason: "远端新技能", entry: remoteEntry });
      }
      continue;
    }
    if (localHash && remoteHash) {
      if (localHash === remoteHash) {
        if (baseHash !== localHash) plan.realigns.push({ name, hash: localHash });
        continue;
      }
      if (!baseHash) {
        plan.conflicts.push({ name, localHash, remoteHash, reason: "本机与远端都有同名技能但内容不同" });
      } else if (localHash === baseHash) {
        plan.downloads.push({ name, reason: "远端有更新，本机未改动", entry: remoteEntry });
      } else if (remoteHash === baseHash) {
        plan.uploads.push({ name, reason: "本机有更新，远端未改动" });
      } else {
        plan.conflicts.push({ name, localHash, remoteHash, reason: "两台电脑都修改了该技能" });
      }
      continue;
    }
    // 两边都没有：同名目录既不在本机也不在远端台账，无事可做
  }
  // 孤儿自愈：远端有目录或包、远端台账没收录、本机也没有 → 下载后按实际内容收录
  for (const name of remoteSkills) {
    if (!remoteManifest.skills[name] && !localManifest.skills[name] && !plan.downloads.some((d) => d.name === name)) {
      plan.downloads.push({ name, reason: "远端孤儿目录，自愈收录", entry: null, orphan: true });
    }
  }
  return plan;
}

/** 下载部署：远端版落进本机中央仓库（旧版先进回收站），台账更新 */
function deployDownload(d, tmpDir, hash, remoteManifest, result) {
  const dest = path.join(hub.skillsDir(), d.name);
  const m = hub.loadManifest();
  if (fs.existsSync(dest)) {
    const backed = hub.toTrash(dest, d.name);
    log(`本机旧版已备份 → .trash/${path.basename(backed)}`);
  }
  fs.cpSync(tmpDir, dest, { recursive: true });
  const remoteEntry = remoteManifest.skills[d.name] || {};
  m.skills[d.name] = {
    name: d.name,
    version: remoteEntry.version || "",
    description: remoteEntry.description || "",
    treeHash: hash,
    skillName: remoteEntry.skillName || d.name,
    sources: [...(remoteEntry.sources || []), { tool: "webdav", originalName: d.name, firstSeen: new Date().toISOString() }],
    mounts: [], // 挂载是本机概念，下载导入后由「同步中心」重新分发
    mergeHistory: [...(remoteEntry.mergeHistory || []), { at: new Date().toISOString(), action: "remote-import", detail: `从 WebDAV 拉取${d.orphan ? "（孤儿自愈）" : ""}` }],
    health: remoteEntry.health || [],
  };
  // 远端墓碑里若记录过该技能（其他设备删过旧版，本机现在是新版）清除本机墓碑
  if (m.deleted[d.name] && m.deleted[d.name].treeHash !== hash) delete m.deleted[d.name];
  hub.saveManifest(m);
  result.downloads.push({ name: d.name, reason: d.reason, hash: hash.slice(0, 12) });
}

/** 合并台账：远端条目为底，只让本机落过盘的事实（上传/下载/孤儿/删除）改写它，最后抹掉 mounts */
function mergeManifests(localManifest, remoteManifest, landed) {
  const merged = {
    version: 1,
    skills: { ...remoteManifest.skills },
    deleted: { ...remoteManifest.deleted },
    updatedAt: new Date().toISOString(),
  };
  // 墓碑合并：按 deletedAt 新者胜
  for (const [name, t] of Object.entries(localManifest.deleted || {})) {
    const old = merged.deleted[name];
    if (!old || !old.deletedAt || !t.deletedAt || t.deletedAt > old.deletedAt) merged.deleted[name] = t;
  }
  // 墓碑覆盖且本机已确认删除的技能：台账条目一并移除，不然远端记着条目、文件却没了
  for (const name of Object.keys(merged.deleted)) {
    if (!localManifest.skills[name]) delete merged.skills[name];
  }
  for (const [name, entry] of Object.entries(localManifest.skills)) {
    // fresh manifest 的 treeHash 已被落盘动作对齐（下载部署/上传时写入实际哈希），可信
    const actual = entry.treeHash;
    // 本机还有但远端墓碑标记删除且哈希一致的：删除已被其他设备确认，不再推回去
    const t = merged.deleted[name];
    if (t && t.treeHash === actual) continue;
    const remoteEntry = merged.skills[name];
    if (remoteEntry) {
      // 内容与远端一致：只对齐台账；本机版已落盘（上传完成）：覆盖远端条目；
      // 冲突/跳过（内容不同且没上传）：保持远端条目不动
      if (actual === remoteEntry.treeHash || landed.has(name)) {
        merged.skills[name] = { ...stripForRemote(entry), treeHash: actual };
      }
    } else if (landed.has(name)) {
      // 远端没有、本机落过盘（新技能上传/孤儿下载）才上账
      merged.skills[name] = { ...stripForRemote(entry), treeHash: actual };
    }
  }
  return merged;
}

// ===== 冲突裁决（去重页 remote 冲突三选一）=====

// 裁决把 base 快照指到「检出冲突时的远端版本」：本机版相对 base 是更新，
// 下次同步走「本机有更新，远端未改动」自然把本机版推上去，冲突状态解除
function settleBase(name, remoteHash) {
  if (!remoteHash) return;
  const s = loadRemoteState();
  s.base[name] = remoteHash;
  saveRemoteState(s);
}

function resolveRemoteConflict(item, choice, cfg) {
  const name = item.skill;
  const staging = stagingDir(name);
  if (choice === "keepLocal") {
    fs.rmSync(staging, { recursive: true, force: true });
    settleBase(name, item.remoteHash);
    noteHistory(name, "跨设备冲突裁决：保留本机版，下次同步推送到远端");
    return { ok: true, message: "已保留本机版，下次同步将推送到远端" };
  }
  if (choice === "keepRemote") {
    if (!fs.existsSync(staging)) return { ok: false, message: "远端版暂存不存在，请重新同步后再裁决" };
    const dest = path.join(hub.skillsDir(), name);
    if (fs.existsSync(dest)) hub.toTrash(dest, name);
    fs.cpSync(staging, dest, { recursive: true });
    const hash = scanner.treeHash(dest);
    const m = hub.loadManifest();
    const old = m.skills[name];
    if (old) {
      old.treeHash = hash;
      old.mergeHistory.push({ at: new Date().toISOString(), action: "conflict-resolved", detail: "跨设备冲突裁决：采用远端版覆盖本机" });
    } else {
      m.skills[name] = {
        name, version: "", description: "", treeHash: hash, skillName: name,
        sources: [{ tool: "webdav", originalName: name, firstSeen: new Date().toISOString() }],
        mounts: [], mergeHistory: [{ at: new Date().toISOString(), action: "remote-import", detail: "跨设备冲突裁决：采用远端版" }], health: [],
      };
    }
    hub.saveManifest(m);
    fs.rmSync(staging, { recursive: true, force: true });
    settleBase(name, item.remoteHash);
    noteHistory(name, "跨设备冲突裁决：采用远端版覆盖本机");
    return { ok: true, message: "已采用远端版覆盖本机（旧版进回收站）" };
  }
  if (choice === "keepBoth") {
    if (!fs.existsSync(staging)) return { ok: false, message: "远端版暂存不存在，请重新同步后再裁决" };
    const newName = `${name}-remote`;
    const r = hub.importSkill({
      name: newName,
      dir: staging,
      skillName: newName,
      description: "",
      version: "",
      treeHash: scanner.treeHash(staging),
      health: [],
      sources: [{ tool: "webdav", name, dir: staging }],
    });
    if (r.action !== "imported") return { ok: false, message: r.message || "改名收纳失败" };
    fs.rmSync(staging, { recursive: true, force: true });
    settleBase(name, item.remoteHash);
    noteHistory(name, `跨设备冲突裁决：双保留，远端版收纳为 ${newName}，本机版下次同步推送`);
    return { ok: true, message: `本机版保留，远端版已收纳为 ${newName}` };
  }
  return { ok: false, message: "未知裁决选项：" + choice };
}

function noteHistory(skill, detail) {
  const m = hub.loadManifest();
  if (!m.skills[skill]) return;
  m.skills[skill].mergeHistory.push({ at: new Date().toISOString(), action: "conflict-resolved", detail });
  hub.saveManifest(m);
}

/** 供同步中心复用的互斥检查：WebDAV 同步进行中时本地 sync_execute 应拒绝 */
function runningHint() {
  return state.running ? "WebDAV 跨设备同步进行中，请等它结束再执行本机同步" : "";
}

module.exports = {
  run, cancel, progress, recentLogs, isRunning, configured, runningHint,
  resolveRemoteConflict, stagingDir, setOnFinish,
  loadRemoteState, saveRemoteState, computePlan, mergeManifests, STAGE_LABEL,
};
