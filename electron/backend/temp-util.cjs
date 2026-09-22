// 临时目录删除保底工具（Windows 不会自动清 %TEMP%，临时副本必须由代码兜底清理）。
// 统一三原则：
//   1. 用完即删——数据源在 %TEMP% 的临时副本由调用方在 finally 中 rmTempDir；
//   2. 失败静默——删除失败（杀软/索引瞬时占用、句柄未释放）不阻断主流程；
//   3. 每轮自愈——sweepStale 在同步时清扫历史残留（崩溃遗留、旧版本堆积），本轮删不掉下轮再删。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

/**
 * 尽力删除目录：瞬时占用自动重试（EBUSY/EPERM 等），仍失败静默返回 false，
 * 残留交由 sweepStale 在后续轮次继续尝试，绝不因清理失败影响主流程。
 */
function rmTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清扫 %TEMP% 下指定前缀的历史残留目录。except 为受保护路径（本次同步正在使用
 * 的目录）——被占用的目录删除会失败，由下一轮清扫兜底，故无需判断新旧。
 */
function sweepStale(prefix, except) {
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    const dir = path.join(os.tmpdir(), e.name);
    if (dir === except) continue;
    rmTempDir(dir);
  }
}

/**
 * SQLite 只读打开，锁库（源应用正在运行等）时复制 db+wal+shm 三件套到临时副本再读。
 * tmpPrefix 为 %TEMP% 副本目录前缀（各数据源自带标识，供 sweepStale 清扫）；
 * 返回连接的副本目录由 exit 钩子与后续 sweepStale 兜底清理，调用方无需关心。
 */
const pendingExitCleanup = new Set();
let exitHookRegistered = false;

function registerExitCleanup(dir) {
  pendingExitCleanup.add(dir);
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const d of pendingExitCleanup) rmTempDir(d);
    pendingExitCleanup.clear();
  });
}

function openReadOnly(file, tmpPrefix) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    const tmp = path.join(os.tmpdir(), `${tmpPrefix}${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    // 常驻进程下 exit 钩子要等进程退出才触发，上一轮已用完的副本目录必须每轮随手清，
    // 否则应用开着期间每轮遇锁都堆一个新目录；正在读的删不掉，删除失败留下轮再清
    sweepStale(tmpPrefix, tmp);
    // 清理登记必须在复制/构造之前：任一步骤失败临时目录都不会泄漏
    registerExitCleanup(tmp);
    try {
      const base = path.basename(file);
      for (const ext of ["", "-wal", "-shm"]) {
        const src = file + ext;
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, base + ext));
      }
      // 副本目录须等连接用完才能删，exit 钩子兜底 + 下轮 sweepStale 自愈
      return new DatabaseSync(path.join(tmp, base), { readOnly: true });
    } catch (e) {
      // 立即清理失败的临时目录，exit 兜底时跳过已删的
      rmTempDir(tmp);
      pendingExitCleanup.delete(tmp);
      throw e;
    }
  }
}

module.exports = { rmTempDir, sweepStale, openReadOnly };