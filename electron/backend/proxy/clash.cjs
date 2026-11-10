/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-09
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Clash Verge 配置读取（网络代理页的「从 Clash Verge 同步」数据源）。
//
// ── 为什么单独一个模块 ────────────────────────────────────────
// 账号/出口的解析只依赖「快照形状」，而快照自身的读取涉及三个候选目录、
// 两个 YAML 文件与一层 TTL 缓存 —— 属于「外部环境探测」，与出口选择混在一起
// 会让两边都难改（对照 Agent2API core/clash.rs 的模块划分）。
//
// ── 关键设计：Clash 侧是**严格镜像** ──────────────────────────
// 端口只在 Clash Verge 里改，这里每次从 verge.yaml 实时读；出口条目只记 clashUid。
// Clash 里删掉某个监听器，引用它的账号会解析失败并如实报错（不静默回落直连）。
// 缓存 3 秒：Clash 改端口最多延迟 3 秒生效。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const CLASH_UNAVAILABLE = "未找到 Clash Verge 配置";
const MAX_PORT = 65535;
/** Clash Verge 的应用目录名（Windows 下 %APPDATA%\<这个名字>） */
const CLASH_APP_ID = "io.github.clash-verge-rev.clash-verge-rev";
/** Clash Verge 全局混合端口在账号绑定里的保留 uid（与真实监听器 uid 不会冲突） */
const CLASH_MIXED_UID = "__mixed__";
/** 快照缓存 TTL：Clash 改端口最多延迟 3 秒生效（对照 Agent2API clash.rs 的 CLASH_CACHE_TTL_MS） */
const CLASH_CACHE_TTL_MS = 3000;

let cache = { at: 0, snapshot: null };

function homeDir() {
  return String(process.env.USERPROFILE || os.homedir() || "").trim();
}

/** 候选目录：%APPDATA%\<appId> → ~/AppData/Roaming/<appId> → ~/.config/<appId>。
 *  判定标准是「目录里有 verge.yaml」—— 只判目录存在会把「刚装好还没写配置」误判成可用。 */
function configDir() {
  const candidates = [];
  const appdata = String(process.env.APPDATA || "").trim();
  if (appdata) candidates.push(path.join(appdata, CLASH_APP_ID));
  const home = homeDir();
  if (home) {
    candidates.push(path.join(home, "AppData", "Roaming", CLASH_APP_ID));
    candidates.push(path.join(home, ".config", CLASH_APP_ID));
  }
  return candidates.find((dir) => {
    try { return fs.statSync(path.join(dir, "verge.yaml")).isFile(); } catch { return false; }
  }) || null;
}

/** 读一个 YAML；缺失 / 解析失败 / 顶层不是映射一律返回 null（Clash 可能正在写，读到半截算本轮读不到） */
function readYaml(file) {
  try {
    const parsed = yaml.load(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** YAML 里的端口：数字与数字字符串都接受（Clash 有时写成 "7897"），其余一律无效 */
function yamlPort(value) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1 || number > MAX_PORT) return 0;
  return number;
}

function yamlText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 读快照（force = 跳过缓存，前端「重新读取」用） */
function snapshot(force = false) {
  const now = Date.now();
  if (!force && cache.snapshot && now - cache.at < CLASH_CACHE_TTL_MS) return cache.snapshot;
  const dir = configDir();
  if (!dir) {
    cache = { at: now, snapshot: { available: false, dir: "", mixedPort: 0, listeners: [], currentProfile: "", error: CLASH_UNAVAILABLE } };
    return cache.snapshot;
  }
  const verge = readYaml(path.join(dir, "verge.yaml"));
  if (!verge) {
    cache = { at: now, snapshot: { available: false, dir, mixedPort: 0, listeners: [], currentProfile: "", error: "verge.yaml 解析失败" } };
    return cache.snapshot;
  }
  const listeners = [];
  for (const item of Array.isArray(verge.verge_mixed_listeners) ? verge.verge_mixed_listeners : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const proxy = yamlText(item.proxy);
    if (!proxy) continue;
    const port = yamlPort(item.port);
    if (!port) continue;
    listeners.push({
      uid: yamlText(item.uid) || `${port}:${proxy}`,
      name: yamlText(item.name) || proxy,
      proxy,
      port,
      profileUid: yamlText(item.profile_uid),
      enabled: item.enabled !== false,
    });
  }
  const profiles = readYaml(path.join(dir, "profiles.yaml"));
  cache = {
    at: now,
    snapshot: {
      available: true,
      dir,
      mixedPort: yamlPort(verge.verge_mixed_port),
      listeners,
      currentProfile: profiles ? yamlText(profiles.current) : "",
      error: "",
    },
  };
  return cache.snapshot;
}

/** 可选项列表（网络代理页「从 Clash Verge 同步」预览用）。
 *  profileActive = 该监听器所属订阅就是当前激活订阅（端口实际生效）；缺 profile_uid 视为 true。 */
function options(force = false) {
  const snap = snapshot(force);
  if (!snap.available) return { available: false, error: snap.error, dir: snap.dir, options: [] };
  const out = [];
  if (snap.mixedPort) {
    out.push({ uid: CLASH_MIXED_UID, name: "Clash 混合端口（按规则分流）", port: snap.mixedPort, kind: "mixed", enabled: true, profileActive: true });
  }
  for (const listener of snap.listeners) {
    out.push({
      uid: listener.uid, name: listener.name, port: listener.port, kind: "listener",
      enabled: listener.enabled,
      profileActive: listener.profileUid ? listener.profileUid === snap.currentProfile : true,
    });
  }
  return { available: true, error: "", dir: snap.dir, options: out };
}

/** 按 clashUid 解析成可用的出口地址（netproxy 的 proxyUri 用）。
 *  mixed uid 走 mixedPort；其余找监听器。找不到返回 null（Clash 里被删了）。 */
function resolve(uid) {
  const snap = snapshot();
  if (!snap.available) return null;
  if (uid === CLASH_MIXED_UID) {
    return snap.mixedPort ? { host: "127.0.0.1", port: snap.mixedPort, protocol: "http", name: "Clash 混合端口" } : null;
  }
  const hit = snap.listeners.find((item) => item.uid === uid);
  if (!hit || !hit.enabled) return null;
  return { host: "127.0.0.1", port: hit.port, protocol: "http", name: hit.name };
}

module.exports = { snapshot, options, resolve, configDir, CLASH_MIXED_UID, CLASH_UNAVAILABLE, CLASH_APP_ID };
