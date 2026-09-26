/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 仓库内配置读写：config/memory.config.json（随同步）+ memory.config.local.json（本机覆盖）。
// 规矩：唯一事实源在仓库内（修正清单 D2）；schema.cjs 的元数据是默认值与校验的唯一出处。
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { SCHEMA, defaultConfig, validateValue, flattenDefaults } = require("./config-schema.cjs");

function defaultRoot() {
  return path.join(os.homedir(), "AgentHub", "memory");
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base)) return over === undefined ? base : over;
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function getByPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split(".")) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setByPath(obj, dotted, value) {
  const segs = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
}

/** 同步睡眠（Atomics.wait 不烧 CPU），文件被占用时的短退避用 */
function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 环境不支持 Atomics 时退化为忙等 */ }
  }
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, missing: true, data: null };
    return { ok: false, missing: false, data: null, error: String(e && e.message || e) };
  }
}

// 原子写：临时文件与目标同目录（跨卷 rename 非原子，修正清单 §3.3.2 口径）；
// 覆盖改名为「先挪 .old 再改名再清理」，避免「已删目标但改名失败」的真空丢数据
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  const fd = fs.openSync(tmp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const staging = `${file}.old.${process.pid}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (fs.existsSync(file)) {
        if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
        fs.renameSync(file, staging);
      }
      fs.renameSync(tmp, file);
      if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
      return;
    } catch (e) {
      if (fs.existsSync(staging) && !fs.existsSync(file)) {
        try { fs.renameSync(staging, file); } catch { /* 回滚失败则抛出原异常 */ }
      }
      if (attempt === 2) throw e;
      // 三次重试分别退避 50/150/300ms；之前 [50,150][min(attempt,1)] 把第三次钳回 150
      sleepSync([50, 150, 300][Math.min(attempt, 2)]);
    }
  }
}

class MemoryConfig {
  constructor(rootDir) {
    this.root = rootDir || defaultRoot();
    this.mainFile = path.join(this.root, "config", "memory.config.json");
    this.localFile = path.join(this.root, "config", "memory.config.local.json");
    this._cache = null;
    this._sig = "";
  }

  // 以文件 mtime 作为缓存签名：多个实例（引擎/页面/任务）共用同一份磁盘事实源，
  // 任一实例写入后其它实例下次读取自动重载，避免读到陈旧配置
  _signature() {
    const stat = (f) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "-";
      }
    };
    return `${stat(this.mainFile)}|${stat(this.localFile)}`;
  }

  load(force = false) {
    const sig = this._signature();
    if (!force && this._cache && sig === this._sig) return this._cache;
    const main = readJsonSafe(this.mainFile);
    const local = readJsonSafe(this.localFile);
    if (!main.ok && !main.missing) {
      // 损坏的主配置留档后回退默认，不丢用户文件
      try { fs.copyFileSync(this.mainFile, `${this.mainFile}.bad-${Date.now()}`); } catch { /* 留档失败不阻塞 */ }
    }
    const merged = deepMerge(defaultConfig(), main.data || {});
    const withLocal = deepMerge(merged, local.data || {});
    this._cache = withLocal;
    this._sig = sig;
    return withLocal;
  }

  get(dotted) {
    const v = getByPath(this.load(), dotted);
    return v === undefined ? getByPath(defaultConfig(), dotted) : v;
  }

  all() {
    return this.load();
  }

  // 写单项或多项；带 schema 校验，非法值不写入
  set(entries, { local = false } = {}) {
    const file = local ? this.localFile : this.mainFile;
    const current = readJsonSafe(file);
    const data = isPlainObject(current.data) ? current.data : {};
    const errors = [];
    for (const [key, value] of Object.entries(entries)) {
      // 必须 hasOwnProperty："__proto__" 经原型链命中 Object.prototype 会漏过校验，
      // 随后 setByPath 改写进程内配置对象的原型
      const meta = Object.prototype.hasOwnProperty.call(SCHEMA, key) ? SCHEMA[key] : null;
      if (!meta) { errors.push(`${key}: 未知配置项`); continue; }
      const err = validateValue(meta, value);
      if (err) { errors.push(`${key}: ${err}`); continue; }
      setByPath(data, key, value);
    }
    if (errors.length) return { ok: false, errors };
    writeJsonAtomic(file, data);
    this._cache = null;
    this._sig = "";
    return { ok: true };
  }

  reset(keys) {
    const file = this.mainFile;
    const current = readJsonSafe(file);
    const data = isPlainObject(current.data) ? current.data : {};
    const defaults = flattenDefaults();
    for (const key of keys) {
      if (!(key in defaults)) continue;
      setByPath(data, key, defaults[key]);
    }
    writeJsonAtomic(file, data);
    this._cache = null;
    this._sig = "";
    return { ok: true };
  }

  diffFromDefaults() {
    const all = this.all();
    const defaults = flattenDefaults();
    const out = [];
    for (const key of Object.keys(SCHEMA)) {
      const cur = getByPath(all, key);
      const def = defaults[key];
      if (JSON.stringify(cur) !== JSON.stringify(def)) out.push({ key, value: cur, default: def });
    }
    return out;
  }
}

module.exports = { MemoryConfig, defaultRoot, expandHome, writeJsonAtomic, readJsonSafe, deepMerge, getByPath, setByPath, sleepSync };
