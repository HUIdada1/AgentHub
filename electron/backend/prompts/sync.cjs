/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库 · 跨设备同步引擎（独立于技能/用量/号池/记忆四条同步链）
//
// 与技能同步的三个本质区别：
//   1) **按条 PUT，不打整包**。技能同步把整个技能目录打成 tar 一次性读进内存
//      （记忆中枢那条链自己注释里就承认 512MB 上限会 OOM）；提示词条数多、单条小，
//      按条传输既省内存又能只传变化的条目。
//   2) **冲突默认自动合并**。技能同步遇冲突是挂起等人工；提示词库按方案要求默认自动裁决
//      （默认新者优先），但被放弃的那一份一定写进该条目的版本历史，用户随时能改判或回滚。
//   3) **独立互斥 tag**（"prompts"）。四条既有同步链各有自己的 tag，共用一把锁会让
//      「提示词在同步」把技能同步整个挡掉。
//
// 远端布局（<root> 由 config.moduleWebdav("prompts") 给出，默认 /agenthub-prompts）：
//   manifest.json        远端台账（只放轻量元信息 + 墓碑）
//   items/<id>.md        每条一个文件
//   versions/<id>.json   版本历史（syncVersions 打开时）
//   devices/<id>.json    设备档案
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.cjs");
const webdav = require("../webdav.cjs");
const store = require("./store.cjs");

const TAG = "prompts";
const MAX_LOGS = 500;

// ===== 运行时状态（进程内，不落盘） =====

let emitter = null;
let running = false;
let cancelled = false;
const logs = [];
let lastError = "";
let stage = "idle";
let stageLabel = "";
let detail = "";
let pct = 0;
let autoMergedCount = 0;

function setEmitter(fn) {
  emitter = typeof fn === "function" ? fn : null;
}

function log(text) {
  const line = { at: Date.now(), text: String(text) };
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  if (emitter) {
    try {
      emitter({ event: "prompts", type: "sync-stage", stage, stageLabel, detail: line.text, running });
    } catch { /* 广播失败不影响同步 */ }
  }
}

function setStage(s, label, d, p) {
  stage = s;
  stageLabel = label || "";
  detail = d || "";
  pct = typeof p === "number" ? p : pct;
  if (emitter) {
    try {
      emitter({ event: "prompts", type: "sync-stage", stage, stageLabel, detail, pct, running });
    } catch { /* 忽略 */ }
  }
}

// ===== 远端配置 =====

function wcfg() {
  return config.moduleWebdav("prompts");
}

function remoteUrl(...segs) {
  const w = wcfg();
  return webdav.joinUrl(w.endpoint, w.root, segs.filter(Boolean).join("/"));
}

/** 「配置齐全才可同步」的判断与其它四条链同口径：endpoint/账号/密码都要有 */
function configured() {
  const w = wcfg();
  return !!(w && w.endpoint && w.username && w.password);
}

// ===== 同步状态（含三方合并基线与冲突队列） =====

function emptyState() {
  return {
    version: 1,
    deviceId: "",
    base: {},        // { [id]: hash } —— 上次同步后的共识哈希，三方合并的 base
    lastSyncAt: 0,
    conflicts: [],   // 冲突队列（含已自动合并的留痕，供界面改判）
    sched: { lastHourlyAt: 0 },
  };
}

function loadState() {
  const raw = store.readJson(store.remoteStateFile(), null);
  if (!raw || typeof raw !== "object") return emptyState();
  return {
    version: 1,
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
    base: raw.base && typeof raw.base === "object" ? raw.base : {},
    lastSyncAt: Number(raw.lastSyncAt) || 0,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    sched: raw.sched && typeof raw.sched === "object" ? raw.sched : { lastHourlyAt: 0 },
  };
}

function saveState(s) {
  store.writeJsonAtomic(store.remoteStateFile(), s);
}

function deviceId() {
  const s = loadState();
  if (!s.deviceId) {
    s.deviceId = require("node:crypto").randomUUID();
    saveState(s);
  }
  return s.deviceId;
}

// ===== 远端台账 =====

async function fetchRemoteManifest() {
  try {
    const text = await webdav.getText(remoteUrl("manifest.json"), wcfg());
    const parsed = JSON.parse(text);
    return {
      exists: true,
      items: parsed && parsed.items && typeof parsed.items === "object" ? parsed.items : {},
      deleted: parsed && parsed.deleted && typeof parsed.deleted === "object" ? parsed.deleted : {},
    };
  } catch (e) {
    // 404 / 空目录 = 首次同步；其它错误交给上层判定（区分「远端为空」与「远端读不到」很重要：
    // 后者若当成空，就会把本地全量推上去，把别人刚写的东西覆盖掉）
    const msg = String((e && e.message) || e);
    if (/404|not\s*found|不存在/i.test(msg)) return { exists: false, items: {}, deleted: {} };
    throw e;
  }
}

// ===== 单条传输 =====

async function downloadItem(id) {
  const text = await webdav.getText(remoteUrl("items", `${id}.md`), wcfg());
  const { meta, body } = store.parseMd(text);
  return store.normalizeItem({ ...meta, id, body });
}

async function uploadItem(item) {
  await webdav.put(remoteUrl("items", `${item.id}.md`), wcfg(), store.buildMd(item));
}

async function uploadVersions(id) {
  const versions = store.loadVersions(id);
  if (!versions.length) return;
  await webdav.put(remoteUrl("versions", `${id}.json`), wcfg(), JSON.stringify({ version: 1, id, versions }, null, 2));
}

async function downloadVersions(id) {
  try {
    const text = await webdav.getText(remoteUrl("versions", `${id}.json`), wcfg());
    const parsed = JSON.parse(text);
    return Array.isArray(parsed && parsed.versions) ? parsed.versions : [];
  } catch {
    return null; // 远端没有版本历史（对方关了 syncVersions）
  }
}

// ===== 合并与自动裁决 =====

function pickByStrategy(strategy, local, remote, baseHash) {
  switch (strategy) {
    case "local-wins":
      return "local";
    case "remote-wins":
      return "remote";
    case "longer-wins":
      return String(local.body || "").length >= String(remote.body || "").length ? "local" : "remote";
    case "newer-wins":
    default: {
      const lt = Number(local.updatedAt) || 0;
      const rt = Number(remote.updatedAt) || 0;
      if (lt === rt) return "local"; // 时间完全相同时偏向本地，保证结果可预期
      return lt > rt ? "local" : "remote";
    }
  }
}

/** 把「被放弃的那一份」写进版本历史。
 *  这是敢把自动合并设为默认的前提：自动裁决不会让任何一份内容凭空消失。 */
function keepDiscarded(id, discarded, note) {
  const versions = store.loadVersions(id);
  const nextVersion = versions.length ? Math.max(...versions.map((v) => Number(v.version) || 0)) + 1 : 1;
  versions.push({ version: nextVersion, body: String(discarded.body || ""), at: Date.now(), note: note || "同步自动合并时被放弃的版本", by: "sync-merge" });
  const keep = (config.loadConfig().prompts || {}).versionKeep || 20;
  store.saveVersions(id, store.pruneVersions(versions, keep));
}

function conflictRecord(kind, item, extra) {
  return {
    id: store.newId(),
    kind,
    name: item && item.name ? item.name : "",
    title: extra && extra.title ? extra.title : "",
    detail: extra && extra.detail ? extra.detail : "",
    autoMerged: !!(extra && extra.autoMerged),
    strategy: extra && extra.strategy ? extra.strategy : undefined,
    kept: extra && extra.kept ? extra.kept : undefined,
    discardedAt: extra && extra.discardedAt ? extra.discardedAt : undefined,
    localHash: item ? item.hash : undefined,
    remoteHash: extra && extra.remoteHash ? extra.remoteHash : undefined,
    at: Date.now(),
    resolved: undefined,
  };
}

// ===== 主流程 =====

async function run() {
  if (running) throw new Error("提示词库同步已在进行中");
  if (!configured()) throw new Error("尚未配置 WebDAV 服务器");
  // 跨模块互斥：与技能/用量/号池/记忆四条链共用一把锁，被拒时抛错（调用方据此跳过本轮）
  if (!webdav.tryBeginSync(TAG)) throw new Error("其它板块正在同步，本轮已跳过");

  running = true;
  cancelled = false;
  lastError = "";
  autoMergedCount = 0;
  const state = loadState();
  const strategy = (config.loadConfig().prompts || {}).mergeStrategy || "newer-wins";
  const syncVersions = (config.loadConfig().prompts || {}).syncVersions !== false;
  const onDeleteConflict = (config.loadConfig().prompts || {}).onDeleteConflict || "tombstone";
  const summary = { pulled: 0, pushed: 0, removed: 0, conflicts: 0, autoMerged: 0, skipped: 0, errors: [] };

  try {
    store.ensureLib();
    setStage("connect", "连接", "正在读取远端台账", 5);
    const remote = await fetchRemoteManifest();
    if (cancelled) throw new Error("已取消");

    const local = store.listItems({ includeTrash: true }).items;
    const localMap = {};
    for (const it of local) localMap[it.id] = it;
    const localActive = local.filter((it) => !it.deletedAt);

    // 远端被清空保护：本地有数据、base 有共识、远端却一条都没有 —— 这更像误删而不是正常状态，
    // 直接推上去会把远端（以及其它设备）的数据一起覆盖掉，所以停下来让用户确认
    const remoteIds = Object.keys(remote.items);
    const baseIds = Object.keys(state.base || {});
    if (remote.exists && remoteIds.length === 0 && localActive.length > 0 && baseIds.length > 0) {
      throw new Error("远端清单为空但本地有数据，疑似远端被误删；为避免覆盖，本轮已停止。如确认要重建远端，请先手动清空本地库或联系支持");
    }

    setStage("pull", "拉取", "正在比对差异", 25);
    const toPush = [];
    const newBase = { ...state.base };
    const conflicts = [];

    // ---- 逐条三方合并 ----
    for (const id of new Set([...Object.keys(remote.items), ...Object.keys(localMap), ...baseIds])) {
      if (cancelled) throw new Error("已取消");
      const L = localMap[id];
      const R = remote.items[id];
      const B = state.base[id];

      // 本地已彻底删除（墓碑在 manifest.deleted 里）且远端还在 → 把删除传出去
      const localGone = !L;
      const remoteGone = !R;

      if (localGone && remoteGone) continue;

      if (!localGone && remoteGone) {
        if (!B) { toPush.push(id); continue; } // 本地新增
        // 远端删了、本地还在 → 删除冲突
        if (onDeleteConflict === "keep-modified" && L.hash !== B) {
          toPush.push(id);
          conflicts.push(conflictRecord("delete", L, { title: "远端已删除、本地有修改", detail: "已按「保留修改」策略保留本地并重新上传", autoMerged: true, strategy: "keep-modified", kept: "local" }));
          summary.autoMerged++;
        } else {
          store.purgeItem(id);
          delete newBase[id];
          summary.skipped++;
        }
        continue;
      }

      if (localGone && !remoteGone) {
        if (!B) { // 远端新增
          const item = await downloadItem(id);
          store.saveItem(item);
          newBase[id] = item.hash;
          summary.pulled++;
          continue;
        }
        // 本地删了、远端还在（可能改了）
        const remoteChanged = R.hash !== B;
        if (remoteChanged && onDeleteConflict === "keep-modified") {
          const item = await downloadItem(id);
          store.saveItem(item);
          newBase[id] = item.hash;
          summary.pulled++;
          conflicts.push(conflictRecord("delete", item, { title: "本地已删除、远端有修改", detail: "已按「保留修改」策略恢复远端版本", autoMerged: true, strategy: "keep-modified", kept: "remote" }));
          summary.autoMerged++;
        } else {
          await webdav.remove(remoteUrl("items", `${id}.md`), wcfg()).catch(() => {});
          delete newBase[id];
          summary.removed++;
        }
        continue;
      }

      // 两边都有
      if (L.hash === R.hash) { newBase[id] = L.hash; continue; }
      const localChanged = !B || L.hash !== B;
      const remoteChanged = !B || R.hash !== B;

      if (localChanged && !remoteChanged) { toPush.push(id); continue; }
      if (!localChanged && remoteChanged) {
        const item = await downloadItem(id);
        store.saveItem(item);
        if (syncVersions) {
          const vs = await downloadVersions(id);
          if (vs) store.saveVersions(id, store.pruneVersions(vs, (config.loadConfig().prompts || {}).versionKeep || 20));
        }
        newBase[id] = item.hash;
        summary.pulled++;
        continue;
      }

      // 两边都改 → 自动裁决
      const remoteItem = await downloadItem(id);
      if (strategy === "manual") {
        conflicts.push(conflictRecord("content", L, { title: "两边都修改了同一条", detail: "策略为「人工裁决」，已挂起等待处理", remoteHash: R.hash }));
        summary.conflicts++;
        continue;
      }
      const winner = pickByStrategy(strategy, L, remoteItem, B);
      const kept = winner === "local" ? L : remoteItem;
      const dropped = winner === "local" ? remoteItem : L;
      keepDiscarded(id, dropped, `同步自动合并（${strategy}）时被放弃的版本`);
      if (winner === "remote") {
        store.saveItem(remoteItem);
        summary.pulled++;
      } else {
        toPush.push(id);
        summary.pushed++;
      }
      newBase[id] = kept.hash;
      conflicts.push(conflictRecord("content", kept, {
        title: "两边都修改了同一条",
        detail: `已自动合并（策略：${strategy}），被放弃的版本已存入版本历史`,
        autoMerged: true, strategy, kept: winner, discardedAt: Date.now(), remoteHash: R.hash,
      }));
      summary.autoMerged++;
    }

    // ---- 上传变更 ----
    if (toPush.length) {
      setStage("push", "上传", `正在上传 ${toPush.length} 条`, 60);
      await webdav.ensureDir(remoteUrl("items"), wcfg()).catch(() => {});
      if (syncVersions) await webdav.ensureDir(remoteUrl("versions"), wcfg()).catch(() => {});
      let i = 0;
      for (const id of toPush) {
        if (cancelled) throw new Error("已取消");
        const item = store.getItem(id);
        if (!item) continue;
        await uploadItem(item);
        if (syncVersions) await uploadVersions(id);
        newBase[id] = item.hash;
        summary.pushed++;
        i++;
        pct = 60 + Math.round((i / toPush.length) * 25);
      }
    }

    // ---- 墓碑同步（本地彻底删除的条目要在远端也删掉，否则下次同步会被别人拉回来） ----
    const localManifest = store.loadManifest();
    const tomb = Object.keys(localManifest.deleted || {});
    const remoteTomb = Object.keys(remote.deleted || {});
    for (const id of [...new Set([...tomb, ...remoteTomb])]) {
      const gone = tomb.includes(id) || remoteTomb.includes(id);
      if (!gone) continue;
      if (remote.items[id]) {
        await webdav.remove(remoteUrl("items", `${id}.md`), wcfg()).catch(() => {});
        summary.removed++;
      }
      delete newBase[id];
    }

    // ---- 上传台账与设备档案 ----
    setStage("push", "上传", "正在写远端台账", 90);
    const remoteManifest = { version: 1, items: {}, deleted: { ...(remote.deleted || {}) }, updatedAt: Date.now() };
    const finalLocal = store.listItems({ includeTrash: true }).items;
    for (const it of finalLocal) {
      if (it.deletedAt) continue;
      remoteManifest.items[it.id] = {
        id: it.id, name: it.name, description: it.description, category: it.category, tags: it.tags,
        source: it.source, version: it.version, hash: it.hash, favorite: it.favorite,
        createdAt: it.createdAt, updatedAt: it.updatedAt,
      };
    }
    for (const id of tomb) remoteManifest.deleted[id] = { at: Date.now() };
    await webdav.put(remoteUrl("manifest.json"), wcfg(), JSON.stringify(remoteManifest, null, 2));

    await webdav.ensureDir(remoteUrl("devices"), wcfg()).catch(() => {});
    const myId = deviceId();
    await webdav.put(remoteUrl("devices", `${myId}.json`), wcfg(), JSON.stringify({
      id: myId,
      name: require("node:os").hostname(),
      appVersion: (() => { try { return require("electron").app.getVersion(); } catch { return ""; } })(),
      lastSyncAt: Date.now(),
    }, null, 2));

    // ---- 落盘状态 ----
    const merged = conflicts.filter((c) => c.autoMerged);
    const pending = conflicts.filter((c) => !c.autoMerged);
    state.base = newBase;
    state.lastSyncAt = Date.now();
    // 冲突队列保留最近 200 条（含已自动合并的留痕，界面可改判）
    state.conflicts = [...conflicts, ...(state.conflicts || []).filter((c) => !conflicts.some((n) => n.id === c.id))].slice(0, 200);
    saveState(state);
    autoMergedCount = merged.length;

    setStage("done", "完成", `拉取 ${summary.pulled} · 上传 ${summary.pushed} · 自动合并 ${summary.autoMerged} · 待裁决 ${pending.length}`, 100);
    writeReport(summary, merged, pending);

    if (emitter) {
      try {
        emitter({ event: "prompts", type: "sync-done", running: false, autoMerged: merged.length, pendingConflicts: pending.length, message: detail });
        emitter({ event: "prompts", type: "library-changed" });
      } catch { /* 忽略 */ }
    }
    return { ok: true, summary, autoMerged: merged.length, pendingConflicts: pending.length };
  } catch (e) {
    lastError = String((e && e.message) || e);
    stage = "error";
    stageLabel = "失败";
    detail = lastError;
    log("同步失败：" + lastError);
    if (emitter) {
      try { emitter({ event: "prompts", type: "sync-error", running: false, message: lastError }); } catch { /* 忽略 */ }
    }
    return { ok: false, message: lastError };
  } finally {
    running = false;
    try { webdav.endSync(); } catch { /* 未持锁时无操作 */ }
    if (stage !== "error") setStage("idle", "", detail, 100);
  }
}

function cancel() {
  cancelled = true;
  return { ok: true };
}

// ===== 报告 =====

function writeReport(summary, merged, pending) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `prompts-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
    const lines = [];
    lines.push(`# 提示词库同步报告 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
    lines.push("");
    lines.push(`拉取 ${summary.pulled} · 上传 ${summary.pushed} · 远端删除 ${summary.removed} · 自动合并 ${summary.autoMerged} · 待裁决 ${pending.length}`);
    lines.push("");
    if (merged.length) {
      lines.push("## 自动合并");
      lines.push("");
      lines.push("| 提示词 | 策略 | 保留 | 被放弃的版本 |");
      lines.push("|---|---|---|---|");
      for (const c of merged) lines.push(`| ${c.name || c.title} | ${c.strategy || "-"} | ${c.kept || "-"} | 已存入版本历史 |`);
      lines.push("");
    }
    if (pending.length) {
      lines.push("## 待人工裁决");
      lines.push("");
      for (const c of pending) lines.push(`- ${c.name || c.title}：${c.detail}`);
      lines.push("");
    }
    fs.mkdirSync(store.reportsDir(), { recursive: true });
    store.writeTextAtomic(path.join(store.reportsDir(), name), lines.join("\n"));
  } catch { /* 报告写失败不影响同步结果 */ }
}

function listReports(limit = 50) {
  try {
    const dir = store.reportsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith("prompts-") && f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => ({ name: f, path: path.join(dir, f), size: (() => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } })() }));
  } catch {
    return [];
  }
}

// ===== 冲突队列 =====

function listConflicts() {
  const s = loadState();
  return s.conflicts || [];
}

function conflictDiff(id) {
  const s = loadState();
  const c = (s.conflicts || []).find((x) => x.id === id);
  if (!c) return null;
  // 本地当前内容 vs 远端当前内容（远端读不到时用冲突记录里的哈希占位，让界面仍能显示）
  const local = c.name ? store.listItems({ includeTrash: false }).items.find((x) => x.name === c.name) : null;
  return {
    item: c,
    left: { label: "本地", body: local ? local.body : "（本地已无此条目）", updatedAt: local ? local.updatedAt : 0 },
    right: { label: "远端", body: "（远端内容需重新同步后查看）", updatedAt: 0 },
  };
}

async function resolveConflict(id, decision, mergedText) {
  const s = loadState();
  const idx = (s.conflicts || []).findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, message: "冲突记录不存在" };
  const c = s.conflicts[idx];
  const local = c.name ? store.listItems({ includeTrash: false }).items.find((x) => x.name === c.name) : null;

  try {
    if (decision === "merge" && mergedText != null) {
      if (local) {
        store.saveItem({ id: local.id, name: local.name, body: String(mergedText) });
      }
    } else if (decision === "remote") {
      const remoteItem = await downloadItem(local ? local.id : c.id);
      store.saveItem(remoteItem);
    } else if (decision === "both") {
      if (local) {
        const copy = store.normalizeItem({ ...local, id: undefined, name: `${local.name}（副本）`, source: "local" });
        store.saveItem(copy);
      }
    }
    // decision === "local"：保留本地即可，无需动作（本地已是当前内容）
    c.resolved = { at: Date.now(), choice: decision };
    s.conflicts[idx] = c;
    saveState(s);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 一键「自动合并全部」：对当前所有未裁决项应用策略（含把 manual 策略下的挂起项一次性处理掉） */
async function autoResolveAll(strategyArg) {
  const cfg = config.loadConfig().prompts || {};
  const strategy = strategyArg || (cfg.mergeStrategy === "manual" ? "newer-wins" : cfg.mergeStrategy) || "newer-wins";
  const s = loadState();
  let merged = 0;
  for (const c of s.conflicts || []) {
    if (c.resolved || c.autoMerged) continue;
    try {
      if (c.kind === "content") {
        const local = c.name ? store.listItems({ includeTrash: false }).items.find((x) => x.name === c.name) : null;
        const remoteItem = await downloadItem(local ? local.id : c.id);
        if (local) {
          const winner = pickByStrategy(strategy, local, remoteItem, null);
          const kept = winner === "local" ? local : remoteItem;
          const dropped = winner === "local" ? remoteItem : local;
          keepDiscarded(local.id, dropped, `一键自动合并（${strategy}）时被放弃的版本`);
          if (winner === "remote") store.saveItem(remoteItem);
          c.autoMerged = true;
          c.strategy = strategy;
          c.kept = winner;
          c.detail = `已自动合并（策略：${strategy}）`;
          merged++;
        }
      }
    } catch { /* 单条失败不拦其余 */ }
  }
  saveState(s);
  const remaining = (s.conflicts || []).filter((c) => !c.resolved && !c.autoMerged).length;
  return { ok: true, merged, remaining };
}

// ===== 设备与状态 =====

async function devices() {
  const myId = deviceId();
  try {
    const entries = await webdav.list(remoteUrl("devices"), wcfg());
    const out = [];
    for (const e of entries) {
      if (e.isDir || !String(e.name).endsWith(".json")) continue;
      try {
        const text = await webdav.getText(remoteUrl("devices", e.name), wcfg());
        const d = JSON.parse(text);
        out.push({ id: d.id || e.name.replace(/\.json$/, ""), name: d.name || "未知设备", appVersion: d.appVersion || "", lastSyncAt: Number(d.lastSyncAt) || 0, self: (d.id || "") === myId });
      } catch { /* 单个档案读不到就跳过 */ }
    }
    return out.sort((a, b) => (b.lastSyncAt || 0) - (a.lastSyncAt || 0));
  } catch {
    return [];
  }
}

function status() {
  const s = loadState();
  const pending = (s.conflicts || []).filter((c) => !c.resolved && !c.autoMerged).length;
  return {
    running,
    configured: configured(),
    stage,
    stageLabel,
    detail,
    pct,
    lastSyncAt: s.lastSyncAt,
    lastError,
    autoMerged: (s.conflicts || []).filter((c) => c.autoMerged).length,
    pendingConflicts: pending,
  };
}

module.exports = {
  TAG, setEmitter, configured, run, cancel, status, log,
  loadState, saveState, deviceId,
  listConflicts, conflictDiff, resolveConflict, autoResolveAll,
  devices, listReports,
  logs: () => logs.slice(),
  isRunning: () => running,
};
