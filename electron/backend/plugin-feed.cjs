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
 * @param options.suppressed Set<id> 用户主动卸载过、要求「停得住」的官方插件 id：
 *                  自动流不再把它们静默装回（手动在目录里点「安装」走 catalog→apply(ids)，不经这里）。
 * @param options.gapOf 可选 (id)=>string[]：已装插件的授权滞后渠道（清单已声明、自动授权
 *                  快照没覆盖）。版本相同但有滞后时列入 repair——重下同版本签过名的包走
 *                  install 补授权，这就是「自动更新直接修好 minimax」的通道；不注入则保持
 *                  纯版本比较，老调用方零变化。
 */
function plan(entries, { installed = new Map(), settings = {}, hostVersion = "0.0.0", target, suppressed = new Set(), gapOf } = {}) {
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
      // 用户主动卸载过 → 尊重这次卸载，自动流跳过（除非他再手动装回，那时卸载标记已清）。
      if (suppressed.has(entry.id)) continue;
      // 未安装：只在「自动下载官方插件」开启时安装
      if (settings.autoDownload) available.push({ ...entry, action: "install", required: false });
      continue;
    }
    const cmp = compareVersion(local.version, entry.version);
    // 版本已不落后，但若签名清单声明的渠道比自动授权多（升级只换插件没换授权的历史快照），
    // 列入 repair：重下同一个签过名的包走 install 补授权。仍受 autoUpdate 闸约束。
    if (cmp >= 0) {
      if (settings.autoUpdate && typeof gapOf === "function" && (gapOf(entry.id) || []).length) {
        available.push({ ...entry, action: "repair", required: false, currentVersion: local.version });
      }
      continue;
    }
    // 低于清单里的最低版本：不受开关影响，必须补齐。
    // minimumVersion 高于 version 是清单写错了，按不强制处理，否则会每轮都失败。
    const required = !!entry.minimumVersion && compareVersion(entry.minimumVersion, entry.version) <= 0
      && compareVersion(local.version, entry.minimumVersion) < 0;
    if (settings.autoUpdate || required) available.push({ ...entry, action: "update", required, currentVersion: local.version });
  }
  return available;
}

/**
 * 全量目录视图：把官方清单与本机已安装态合并，逐条标出「装没装 / 能不能装 / 有没有新版」。
 * 与 plan() 的区别：plan() 只回「自动流这次要装哪些」，catalog() 回「清单里一共有什么、各自什么状态」，
 * 因此受不受 autoDownload/autoUpdate 开关、有没有被卸载抑制都不影响展示——这正是
 * 「主程序显示我都有什么插件，没装就灰显」要的数据。纯函数，不碰网络与磁盘。
 * @param options.installed Map<id, { version }>
 * @param options.suppressed Set<id> 用户主动卸载、当前被灰显而非「已安装」的 id
 * @param options.gapOf 可选 (id)=>string[]，同 plan()：版本相同但授权滞后 → repairable=true，
 *                  目录里给它一个可点的「修复」入口（apply(ids) 本就不受版本闸约束）。
 */
function catalog(entries, { installed = new Map(), hostVersion = "0.0.0", target, gapOf } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    // 平台/宿主版本不匹配 → 不隐藏（让用户看得到有这个东西），但置灰到不可点并给出原因。
    const platformOk = platformMatches(entry, target);
    const hostOk = !(entry.minHostVersion && compareVersion(hostVersion, entry.minHostVersion) < 0);
    const supported = platformOk && hostOk;
    const reason = !platformOk ? "当前系统暂不支持该插件" : !hostOk ? `需要 AgentHub >= ${entry.minHostVersion}` : "";
    const local = installed.get(entry.id);
    if (local) {
      const updatable = supported && compareVersion(local.version, entry.version) < 0;
      const required = updatable && !!entry.minimumVersion
        && compareVersion(entry.minimumVersion, entry.version) <= 0
        && compareVersion(local.version, entry.minimumVersion) < 0;
      // 版本相同但有授权滞后也给出可点入口（走 apply→install 重装补授权），按钮文案叫「修复」。
      const repairable = supported && !updatable && compareVersion(local.version, entry.version) === 0
        && typeof gapOf === "function" && (gapOf(entry.id) || []).length > 0;
      out.push({
        id: entry.id, name: entry.name, version: entry.version, url: entry.url, sha256: entry.sha256,
        installed: true, currentVersion: local.version, installable: false, updatable, required, repairable,
        supported, reason,
      });
    } else {
      out.push({
        id: entry.id, name: entry.name, version: entry.version, url: entry.url, sha256: entry.sha256,
        installed: false, currentVersion: "", installable: supported, updatable: false, required: false,
        repairable: false,
        supported, reason,
      });
    }
  }
  return out;
}

module.exports = { parseIndex, platformMatches, compareVersion, plan, catalog, currentLibc };
