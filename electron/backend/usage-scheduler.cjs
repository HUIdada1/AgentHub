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
// 定时同步调度：每 60s 检查一次，命中本地统计(half-hourly) / 远程同步(hourly) / daily 规则则触发
// 节奏设计：本地统计缓存每 30min 入库（含 Codex 归档会话补充），WebDAV 上传拉取每 hourlyInterval 小时一次
// （上传携带本机数据库全量状态，天然包含两次半小时统计的结果，无需专门的「增量合并传输」机制）
"use strict";
const sync = require("./sync.cjs");
const db = require("./db.cjs");

// 本地统计节奏（固定 30 分钟，不设配置项）
const LOCAL_INTERVAL_MS = 30 * 60 * 1000;
// 「本轮根本没开跑」的重试间隔：撞车类失败没花网络，等 1 分钟补跑即可
const RETRY_MS = 60 * 1000;

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

/** 记账的唯一写入口：内存与持久化必须同步改，否则重启后节奏错乱 */
function setLast(kind, value) {
  if (kind === "local") lastLocalAt = value;
  else if (kind === "hourly") lastRemoteAt = value;
  rememberLast(kind, value);
}

/**
 * 撞车类失败的识别：sync.cjs 的入口守卫与跨模块远端锁都是固定文案
 * （「同步正在进行中」「本地统计进行中」「正在恢复备份」「其他模块的远端同步正在进行」）。
 * 这类失败没发起任何请求，也不代表数据或网络有问题。
 */
function isBusyError(msg) {
  return /进行中|稍后|已跳过/.test(String(msg || ""));
}

/**
 * 跑一轮定时任务并按结果决定记账。periodMs 传 0 = 本类任务不参与记账（daily 已在 tick 里统一推进）。
 * 先记账再触发：中途崩溃不会在同一周期内反复补跑（与 prompts/sched.cjs 同口径）。
 * 旧口径的毛病正是「记账在跑之前一次性推进，本轮失败被 .catch(()=>{}) 静默吞掉」——
 * 只要那一拍恰好撞上同步/恢复占用、或远端锁被其他模块拿走，这一轮就整小时白等，
 * 且日志里一行痕迹都没有，用户看到的就是「设了每小时自动同步却死活不跑」。
 * 现在：成功照常停在触发时刻；撞车退回约 1 分钟后补跑；真失败（网络/磁盘）保持下一周期再试，
 * 不制造每分钟撞一次远端的重试风暴。三种情况都记一行日志，让「为什么没同步」可见。
 */
async function runScheduled(kind, fn, periodMs) {
  const label = kind === "local" ? "本地统计" : kind === "hourly" ? "远程同步" : "整轮同步";
  if (periodMs) setLast(kind, Date.now());
  let error = "";
  try {
    const r = await fn();
    if (r && r.ok === false) error = r.error || "未知失败";
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  if (!error) return;
  const retrySoon = !!periodMs && isBusyError(error);
  if (retrySoon) setLast(kind, Date.now() + RETRY_MS - periodMs);
  try {
    db.addLog("error", "warn",
      retrySoon ? `定时${label}本轮让位，约 ${RETRY_MS / 1000}s 后补跑` : `定时${label}失败，下一个周期再试`,
      error);
  } catch { /* 日志失败不影响调度 */ }
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
      // 失败只记日志、当天不再补撞（daily 是「到点一次」的语义，明天照常再来；periodMs=0 关闭记账回退）
      runScheduled("daily", () => sync.run(cfg), 0);
      return;
    }

    const interval = Math.max(1, cfg.schedule.hourlyInterval || 1);
    const localDue = now - lastLocalAt >= LOCAL_INTERVAL_MS;
    // 远程同步仅在有 WebDAV 配置且开启每小时自动同步时成立；未配 WebDAV 时本地统计照常
    const remoteReady = !!cfg.schedule.hourly && !!(cfg.webdav && cfg.webdav.endpoint);
    const remoteDue = remoteReady && now - lastRemoteAt >= interval * 60 * 60 * 1000;

    if (!localDue && !remoteDue) return;
    // 同 tick 双命中时先本地后远程串行执行：保证 WebDAV 上传携带刚采完的最新数据。
    // 记账交给 runScheduled 按结果推进（旧口径跑之前就推进 + 静默 catch，撞一次车就白等一整周期）
    (async () => {
      if (localDue) await runScheduled("local", () => sync.runLocal(cfg), LOCAL_INTERVAL_MS);
      if (remoteDue) await runScheduled("hourly", () => sync.runRemote(cfg), interval * 60 * 60 * 1000);
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

/**
 * 手动「立即同步」（含托盘等所有完整同步入口）跑成功后推进记账。
 * 不推进的话：刚点完一次，下一拍 tick 仍按周期判到点，1 分钟后又自动上传拉取一轮
 * （2026-11-20 实测 15:53 手动完成、15:54 定时又跑一遍，多付一次全量分片读回）。
 * 完整同步本身已含抽取，所以本地统计记账一并推进；remote=false（强制本机备份，没碰远端）时
 * 不动远程记账，免得一次备份把下一轮自动远程同步顶后一整周期。
 */
function noteFullSync(at = Date.now(), remote = true) {
  setLast("local", at);
  if (remote) setLast("hourly", at);
}

// tick 导出供自测直接触发一拍（与 prompts/sched.cjs 同惯例；生产仍走 60s setInterval）
module.exports = { start, stop, setPaused, isPaused, noteFullSync, tick };