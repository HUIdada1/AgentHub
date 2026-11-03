/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-03（归档版 2026-10-22，自归档恢复并适配双模块）
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Docker 形态依赖闭包断言：从网关入口与核心模块出发，递归收集全部相对 require 目标，
// 断言每个文件都存在。用途是卡住 Dockerfile 的 COPY 范围与真实闭包漂移——
// 历史上白名单漏过 28 个文件（24 个用量适配器 + sqlcipher/sync-adapter/temp-util/crashlog），
// 靠分支巧合与 try/catch 才没在启动时炸。
//
// 补充断言（双模块版）：闭包里不允许出现 proxy/server.cjs / proxy/inflight.cjs /
// proxy/remote.cjs——旧「反代网关」转发链路已下线归档，Docker 入口一旦 require 到它们，
// 说明有人绕过了本地网关（localgw）复活旧链路，直接 fail。
//
// 用法：node tools/gateway-closure-check.cjs [--root <dir>] [--min <n>]
//   --root  以该目录为仓库根（默认脚本的上一级）
//   --min   闭包文件数下限（默认 100，防 COPY 缩水后无人察觉）
//
// 入口是显式清单：gateway/src/index.cjs 的核心模块全部用 path.join 动态拼路径，
// 纯静态扫描抓不到，故把它的目标与共享核心一并列为入口。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function argOf(flag, dft) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dft;
}

const ROOT = path.resolve(argOf("--root", path.join(__dirname, "..")));
const MIN = Number(argOf("--min", "100"));

const ENTRIES = [
  "gateway/src/index.cjs",
  "gateway/src/commands.cjs",
  "electron/backend/proxy/index.cjs",
  "electron/backend/proxy/store.cjs",
  "electron/backend/proxy/adapters.cjs",
  "electron/backend/proxy/pool.cjs",
  "electron/backend/proxy/credits.cjs",
  "electron/backend/proxy/poolsched.cjs",
  "electron/backend/proxy/rules.cjs",
  "electron/backend/proxy/discovery.cjs",
  "electron/backend/proxy/poolsync.cjs",
  "electron/backend/localgw/index.cjs",
  "electron/backend/localgw/server.cjs",
  "electron/backend/localgw/forwarder.cjs",
  "electron/backend/localgw/routing.cjs",
  "electron/backend/localgw/models.cjs",
  "electron/backend/localgw/keys-store.cjs",
  "electron/backend/localgw/outbound.cjs",
  "electron/backend/prompts/index.cjs",
  "electron/backend/prompts/store.cjs",
  "electron/backend/prompts/sync.cjs",
  "electron/backend/memory/index.cjs",
  "electron/backend/memory/store.cjs",
  "electron/backend/memory/sync.cjs",
  "electron/backend/config.cjs",
];

/** 已下线的旧转发链路：闭包出现任一即 fail（docker 转发只走 localgw） */
const FORBIDDEN = /electron[/\\]backend[/\\]proxy[/\\](server|inflight|remote)\.cjs$/;

function resolveRel(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + ".cjs", base + ".js", path.join(base, "index.cjs")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* 权限等异常按缺失处理 */ }
  }
  return null;
}

const seen = new Set();
const missing = [];
const forbidden = [];

function walk(file) {
  if (seen.has(file)) return;
  if (!fs.existsSync(file)) {
    missing.push(file.slice(ROOT.length + 1));
    return;
  }
  seen.add(file);
  const rel = file.slice(ROOT.length + 1).split(path.sep).join("/");
  if (FORBIDDEN.test(rel)) forbidden.push(rel);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  // 逐行扫描并跳过整行注释：注释里的示例性/历史性 require 不该算入闭包（防误报缺失）。
  // 行尾注释与块注释中段未剥离——当前代码库无此形态，出现时按缺失报出人工确认即可
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    const re = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(line))) {
      const next = resolveRel(file, m[1]);
      if (next) walk(next);
      else if (m[1].startsWith(".")) missing.push(`${file.slice(ROOT.length + 1)} -> ${m[1]}`);
    }
  }
}

for (const rel of ENTRIES) walk(path.resolve(ROOT, rel));

const count = seen.size;
console.log(`gateway 依赖闭包：${count} 个文件（下限 ${MIN}）`);
if (missing.length) {
  console.log(`解析失败 ${missing.length} 项：`);
  for (const m of missing) console.log("  " + m);
}
if (forbidden.length) {
  console.log(`命中已下线转发链路 ${forbidden.length} 项（必须改走 localgw）：`);
  for (const f of forbidden) console.log("  " + f);
}
if (count < MIN || missing.length || forbidden.length) {
  console.error(missing.length ? "闭包存在缺失文件" : forbidden.length ? "闭包出现旧转发链路文件" : `闭包文件数低于下限 ${MIN}`);
  process.exit(1);
}
console.log("闭包完整，且未复活旧转发链路");
