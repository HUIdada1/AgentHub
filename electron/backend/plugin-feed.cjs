"use strict";
// 插件更新清单的解析与匹配。这里不碰网络和磁盘，纯函数，便于单独测。
const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function compareVersion(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function parseIndex(raw) {
  const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  if (!value || value.schema !== 1 || !Array.isArray(value.plugins)) throw new Error("插件清单格式不支持");
  return value.plugins.map(entry => {
    if (!entry || typeof entry.id !== "string" || !ID_RE.test(entry.id)) throw new Error("插件清单条目 id 非法");
    if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+/.test(entry.version)) throw new Error(`插件 ${entry.id} 版本号非法`);
    if (typeof entry.url !== "string" || !/^https:\/\//i.test(entry.url)) throw new Error(`插件 ${entry.id} 下载地址非法`);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error(`插件 ${entry.id} 缺少 sha256`);
    return {
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      version: entry.version,
      minimumVersion: typeof entry.minimumVersion === "string" ? entry.minimumVersion : "",
      minHostVersion: typeof entry.minHostVersion === "string" ? entry.minHostVersion : "",
      platforms: Array.isArray(entry.platforms) ? entry.platforms : [],
      url: entry.url,
      sha256: entry.sha256.toLowerCase(),
    };
  });
}

function currentLibc() {
  if (process.platform !== "linux") return undefined;
  return process.report?.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
}

function platformMatches(entry, target = { os: process.platform, arch: process.arch, libc: currentLibc() }) {
  const list = Array.isArray(entry.platforms) ? entry.platforms : [];
  if (!list.length) return true;
  return list.some(item => item && item.os === target.os && item.arch === target.arch
    && (item.libc === undefined || item.libc === target.libc));
}

/**
 * 算出这次要装什么。
 * @param entries parseIndex 的结果
 * @param options.installed Map<id, { version }>
 * @param options.settings { autoUpdate, autoDownload }
 * @param options.hostVersion 当前主程序版本
 */
function plan(entries, { installed = new Map(), settings = {}, hostVersion = "0.0.0", target } = {}) {
  const available = [];
  const seen = new Set();
  for (const entry of entries) {
    // 清单里同一个 id 出现多次时只认第一条，避免同一轮装两遍
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (!platformMatches(entry, target)) continue;
    if (entry.minHostVersion && compareVersion(hostVersion, entry.minHostVersion) < 0) continue;
    const local = installed.get(entry.id);
    if (!local) {
      // 未安装：只在「自动下载官方插件」开启时安装
      if (settings.autoDownload) available.push({ ...entry, action: "install", required: false });
      continue;
    }
    if (compareVersion(local.version, entry.version) >= 0) continue;
    // 低于清单里的最低版本：不受开关影响，必须补齐。
    // minimumVersion 高于 version 是清单写错了，按不强制处理，否则会每轮都失败。
    const required = !!entry.minimumVersion && compareVersion(entry.minimumVersion, entry.version) <= 0
      && compareVersion(local.version, entry.minimumVersion) < 0;
    if (settings.autoUpdate || required) available.push({ ...entry, action: "update", required, currentVersion: local.version });
  }
  return available;
}

module.exports = { parseIndex, platformMatches, compareVersion, plan, currentLibc };
