// 自动感知：后台每 15 秒快照各工具技能目录的一层条目（名字+类型+mtime），
// 快照连续两拍稳定且变了才动作；只判断"变没变"，不看内容，开销随条目数走
// 设计：零冲突零 error 的新收纳/挂载自动执行（覆盖删除全进回收站可还原）；
// 有冲突绝不替人裁决，只托盘提醒
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.cjs");
const adapter = require("./adapter.cjs");
const syncer = require("./syncer.cjs");
const remotesync = require("./remotesync.cjs");

const INTERVAL_SECONDS = 15;

let timer = null;
let baseline = ""; // 已对过账的快照
let pending = "";  // 刚变化、还没确认稳定的快照
let lastScanAt = 0;
let busy = false;
let onEvent = null; // main.cjs 挂的桌面通知回调

function fingerprint(cfg) {
  const parts = [];
  for (const t of adapter.resolveScanTargets(cfg)) {
    const list = [];
    let entries;
    try {
      entries = fs.readdirSync(t.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      let st;
      try {
        st = fs.lstatSync(path.join(t.dir, e.name));
      } catch {
        continue;
      }
      const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "?";
      list.push(`${e.name}\u0000${kind}\u0000${st.mtimeMs}`);
    }
    list.sort();
    parts.push(`${t.id}\u0001${list.join("\n")}`);
  }
  return parts.join("\v");
}

function status() {
  return { intervalSeconds: INTERVAL_SECONDS, lastScanAt };
}

// 变化判断：只有真正挡执行的内容冲突 / 异常才算硬冲突，不自动执行；
// L2 归一是"疑似同名"提示，不阻碍零风险收纳，照常自动跑
function handle(cfg, fp) {
  if (remotesync.isRunning()) return; // WebDAV 同步占用中央仓库，这拍先让
  const plan = syncer.planSync(cfg);
  const hard = plan.actions.some((a) => a.type === "error")
    || plan.conflicts.some((c) => c.kind === "content" || c.kind === "diff-link");
  if (hard) {
    baseline = fp;
    if (onEvent) onEvent({ kind: "conflict", count: plan.conflicts.length });
    return;
  }
  if (!plan.actions.some((a) => a.type === "import" || a.type === "mount")) {
    baseline = fp; // 只是链接形态/内容变化后的第二拍收敛，对完账就静默
    return;
  }
  busy = true;
  try {
    // executeSync 内部会按当前磁盘重新规划，计划落地后快照由下一拍自然收敛
    const r = syncer.executeSync(cfg, plan);
    baseline = fp;
    if (onEvent && r.summary && (r.summary.imported || r.summary.mounted || r.summary.merged)) {
      onEvent({ kind: "synced", summary: r.summary });
    }
  } finally {
    busy = false;
  }
}

function tick() {
  lastScanAt = Date.now();
  try {
    if (busy) return;
    const cfg = config.loadConfig();
    if (!(cfg.watch && cfg.watch.enabled)) {
      baseline = "";
      pending = "";
      return;
    }
    const fp = fingerprint(cfg);
    if (!baseline) {
      baseline = fp; // 启动留基线，不立刻把历史存货收走
      return;
    }
    if (fp === baseline) {
      pending = "";
      return;
    }
    if (fp === pending) {
      handle(cfg, fp); // 连续两拍一致才动手，AI 写一半不算
      return;
    }
    pending = fp;
  } catch {
    /* 感知异常静默，下一拍重试 */
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_SECONDS * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick, fingerprint, handle, status, setOnEvent: (fn) => { onEvent = fn; } };