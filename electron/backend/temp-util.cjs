// 临时目录删除保底工具（Windows 不会自动清 %TEMP%，临时副本必须由代码兜底清理）。
// 统一三原则：
//   1. 用完即删——数据源在 %TEMP% 的临时副本由调用方在 finally 中 rmTempDir；
//   2. 失败静默——删除失败（杀软/索引瞬时占用、句柄未释放）不阻断主流程；
//   3. 每轮自愈——sweepStale 在同步时清扫历史残留（崩溃遗留、旧版本堆积），本轮删不掉下轮再删。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

module.exports = { rmTempDir, sweepStale };