/**
 * 记忆中枢 · 本地清单构建核心（同步实现，供 worker 线程执行）
 *
 * 被 sync.cjs 以 tarpack 同款「源码注入 worker」的方式搬运执行：主进程把本文件
 * 源码写入临时目录，worker require 临时副本——打包态源码在 asar 里主进程也能读，
 * worker 不依赖 asar 加载，开发态与打包态行为一致。
 *
 * 自包含：仅依赖 node 内建模块（worker 里 require 仓库其它模块会拖出整条依赖链）。
 * 阻塞发生在 worker 线程：数千文件逐个 readFileSync+sha256 不再占用主进程事件循环
 * （此前在主进程同步执行，唤醒后磁盘冷缓存时 UI 与 9527 网关一起卡）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EXCLUDE_DIRS = [".trash", "_import", "index", "node_modules"];
const EXCLUDE_FILES = ["memory-runtime.json", "memory.config.local.json", ".bridge-token"];

// 隐私白名单（privacy.localOnlyProjects，「永不上传的项目」）：
// projects/<slug>/... 不进包、不进清单、不参与合并——worker 里同样必须执行，
// 否则「永不上传」项目会被清单收录并随整包上传（设置页对用户承诺了"永不上传"）。
function isLocalOnly(rel, localOnly) {
  if (!localOnly || !localOnly.length) return false;
  const m = /^projects\/([^/]+)\//.exec(rel);
  return !!m && localOnly.includes(m[1]);
}

function shouldSkip(rel, localOnly) {
  if (isLocalOnly(rel, localOnly)) return true;
  const segs = rel.split("/");
  if (segs.some((s) => EXCLUDE_DIRS.includes(s))) return true;
  const base = segs[segs.length - 1];
  if (EXCLUDE_FILES.includes(base)) return true;
  if (/\.bak(\.\d+)?$/.test(base)) return true;
  if (/\.tmp(\.\d+)?$/.test(base)) return true;
  return false;
}

/** 单文件 sha256。读不到时**抛错**（不返回空串）：调用方据此整条跳过该文件——
 *  与旧版 buildManifest 语义一致（旧实现里 readFileSync 抛错 → 外层 catch 跳过）。
 *  若在此吞掉异常返回 ""，读不到的文件会以「空哈希条目」进清单，下次比对时
 *  表现为「本地已改」→ 触发无谓的冲突/上传尝试。 */
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 同步版清单构建：walk + 逐文件 sha256（在 worker 线程里执行） */
function buildManifestSync(dir, opts = {}) {
  const localOnly = opts.localOnly || [];
  const out = {};
  const walk = (cur) => {
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (shouldSkip(rel, localOnly)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out[rel] = { size: st.size, mtime: Math.round(st.mtimeMs), hash: sha256File(full) };
        } catch {
          /* 读不到的文件跳过 */
        }
      }
    }
  };
  walk(dir);
  return out;
}

module.exports = { buildManifestSync, shouldSkip, isLocalOnly, EXCLUDE_DIRS, EXCLUDE_FILES };
