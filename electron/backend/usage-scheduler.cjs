// 定时同步调度：每 60s 检查一次，命中本地统计(half-hourly) / 远程同步(hourly) / daily 规则则触发
// 节奏设计：本地统计缓存每 30min 入库（含 Codex 归档会话补充），WebDAV 上传拉取每 hourlyInterval 小时一次
// （上传携带本机数据库全量状态，天然包含两次半小时统计的结果，无需专门的「增量合并传输」机制）
"use strict";
const sync = require("./sync.cjs");
const db = require("./db.cjs");

// 本地统计节奏（固定 30 分钟，不设配置项）
const LOCAL_INTERVAL_MS = 30 * 60 * 1000;

let timer = null;
let lastLocalAt = 0;
let lastRemoteAt = 0;
let lastDailyAt = ""; // "YYYY-MM-DD"
let paused = false;

/** 触发时间持久化到 meta 表：重启后不重置，避免启动即同步/当天 daily 重复补跑 */
function rememberLast(kind, value) {
  try {
    db.setMeta(`sched_last_${kind}`, String(value));
  } catch {
    /* 持久化失败仅意味着重启后可能多跑一次，不影响正确性 */
  }
}

function setPaused(v) {
  paused = !!v;
}

function isPaused() {
  return paused;
}

/** daily 命中：当天首次 tick 且已过设定时刻（追赶式补跑，错过不丢） */
function dailyDue(cfg, now) {
  if (!cfg.schedule.daily || !cfg.schedule.dailyTime) return false;
  const [h, m] = cfg.schedule.dailyTime.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  const d = new Date(now);
  const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return today !== lastDailyAt && d.getHours() * 60 + d.getMinutes() >= h * 60 + m;
}

/** 时间回拨保护：系统时间被调早（NTP 校正/手动回拨）时重置基准，避免差值虚大导致立即误触发 */
function guardClock(now) {
  if (now < lastLocalAt) lastLocalAt = now;
  if (now < lastRemoteAt) lastRemoteAt = now;
}

function getConfig() {
  // 延迟 require 避免循环依赖
  const config = require("./sync-config.cjs");
  return config.loadConfig();
}

function tick() {
  try {
    if (paused) return;
    // 同步/本地统计/恢复进行中先跳过且不推进记账：命中条件在下一 tick 依然成立，结束后自然补跑
    if (sync.isBusy()) return;
    const cfg = getConfig();
    if (!cfg.schedule) return;
    // 自动同步总开关（hourly/daily 任一开启才有后台节奏；全关时手动/托盘触发照旧）
    if (!cfg.schedule.hourly && !cfg.schedule.daily) return;

    const now = Date.now();
    guardClock(now);

    // daily 优先：完整同步一次并推进全部记账，避免随后 local/remote 规则同窗口重复跑
    if (dailyDue(cfg, now)) {
      const d = new Date(now);
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      lastLocalAt = now;
      lastRemoteAt = now;
      lastDailyAt = today;
      rememberLast("local", now);
      rememberLast("hourly", now);
      rememberLast("daily", today);
      sync.run(cfg).catch(() => {});
      return;
    }

    const interval = Math.max(1, cfg.schedule.hourlyInterval || 1);
    const localDue = now - lastLocalAt >= LOCAL_INTERVAL_MS;
    // 远程同步仅在有 WebDAV 配置且开启每小时自动同步时成立；未配 WebDAV 时本地统计照常
    const remoteReady = !!cfg.schedule.hourly && !!(cfg.webdav && cfg.webdav.endpoint);
    const remoteDue = remoteReady && now - lastRemoteAt >= interval * 60 * 60 * 1000;

    if (!localDue && !remoteDue) return;
    if (localDue) {
      lastLocalAt = now;
      rememberLast("local", now);
    }
    if (remoteDue) {
      lastRemoteAt = now;
      rememberLast("hourly", now);
    }
    // 同 tick 双命中时先本地后远程串行执行：保证 WebDAV 上传携带刚采完的最新数据
    (async () => {
      if (localDue) await sync.runLocal(cfg).catch(() => {});
      if (remoteDue) await sync.runRemote(cfg).catch(() => {});
    })();
  } catch {
    /* 调度异常静默，下一轮重试 */
  }
}

function start() {
  if (timer) return;
  // 恢复上次触发时间：重启后接着原节奏调度，而不是立刻补跑
  try {
    const l = Number(db.getMeta("sched_last_local"));
    if (Number.isFinite(l) && l > 0) lastLocalAt = l;
    const r = Number(db.getMeta("sched_last_hourly"));
    if (Number.isFinite(r) && r > 0) lastRemoteAt = r;
    const d = db.getMeta("sched_last_daily");
    if (d) lastDailyAt = d;
  } catch {
    /* 读取失败按默认值（首次启动视为从未触发） */
  }
  timer = setInterval(tick, 60 * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, setPaused, isPaused };