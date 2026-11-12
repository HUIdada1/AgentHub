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
// 补充断言（2026-11-12 · 阶段 0.2）：**第三方裸名必须在 gateway lock 内可解析**。
// 本脚本原先只递归相对 require，于是留下了一个根因级盲区：electron/backend/proxy/clash.cjs:27
// 顶层 require("js-yaml")，而 js-yaml 只在仓库根 package.json 里声明、gateway 的 lock 没有它
// → 本机拿全量 node_modules 跑冒烟全绿，镜像里 `npm ci` 只装 gateway lock 的包，容器启动即
// MODULE_NOT_FOUND。现在递归时顺带收集所有第三方裸名，逐个断言存在于
// gateway/package-lock.json，缺失即 fail 并列出 requiredBy。
// 例外清单 RUNTIME_OPTIONAL 只降级为 warn（不 fail）：这些包是「桌面专属或运行期才触达」，
// 顶层不在容器启动链上，且 require 点都包在 try/catch 或函数内（已逐条核对磁盘代码）。
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

/** 容器里「桌面专属 / 运行期才触达」的第三方包：缺了只 warn 不 fail。
 *  逐条核对磁盘代码后的依据——
 *   electron        : 10 处 require 全在函数体内或 try/catch 内（config.cjs:24,41、
 *                     memory/index.cjs:26 等），容器走 platform/node 形态不会触达；
 *   better-sqlite3  : store.cjs:31 / ccswitch.cjs:79 都在 `node:sqlite` 失败后的
 *                     嵌套 try 里，容器用内置 node:sqlite，缺失即静默跳过；
 *   koffi           : 只被 sqlcipher.cjs:23 顶层 require，而该模块不在容器装配链上
 *                     （Trae 系渠道运行期取数才 require），属次级风险，列 warn 人工看。 */
const RUNTIME_OPTIONAL = new Set(["electron", "better-sqlite3", "koffi"]);

/** 读 gateway lock，得到「容器镜像里真的会装上」的包名集合（含传递依赖）。
 *  以 gateway/package-lock.json 为唯一允许集：Dockerfile 的 deps 层只 npm ci 这一份。 */
function loadContainerAllowed() {
  const lockFile = path.join(ROOT, "gateway", "package-lock.json");
  const allowed = new Set();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch (e) {
    return { allowed, error: `无法读取 ${lockFile}: ${(e && e.message) || e}` };
  }
  const pkgs = raw.packages || {};
  for (const key of Object.keys(pkgs)) {
    if (!key.startsWith("node_modules/")) continue;
    // 嵌套依赖的 key 形如 node_modules/a/node_modules/b，取最后一段作为包名
    allowed.add(key.slice("node_modules/".length).split("/node_modules/").pop());
  }
  if (!allowed.size) return { allowed, error: `${lockFile} 里没有任何 node_modules 条目（lock 可能损坏）` };
  return { allowed, error: null };
}

/** 裸名 → 包根名：scoped 包取前两段（@scope/name），普通包取第一段（去掉子路径） */
function pkgRootName(spec) {
  const seg = spec.split("/");
  return spec.startsWith("@") ? seg.slice(0, 2).join("/") : seg[0];
}

const ENTRIES = [
  "gateway/src/index.cjs",
  "gateway/src/commands.cjs",
  "electron/backend/proxy/index.cjs",
  "electron/backend/proxy/store.cjs",
  "electron/backend/proxy/management-adapters.cjs",
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
  "electron/backend/plugin-host.cjs",
  "electron/backend/extensions/pool-runtime.cjs",
];

/** 已下线的旧转发链路：闭包出现任一即 fail（docker 转发只走 localgw） */
const FORBIDDEN = /electron[/\\]backend[/\\]proxy[/\\](?:(?:server|inflight|remote|adapters|qoderAdapter|qoderSigner|zcodeAnthropic|zcode-official-system)\.cjs|[^/\\]+[/\\]adapter\.cjs)$/;

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
const containerAllowed = loadContainerAllowed();
/** 第三方裸名 → 引入它的文件清单（相对 ROOT，便于报告 requiredBy） */
const bareRequires = new Map();
/** T8 违例：闭包内**顶层**（零缩进、不在函数/try 里）require("electron") 的位置清单。
 *  为什么必须单列而不是靠 RUNTIME_OPTIONAL 的 WARN 兜：electron 在 WARN 名单里，
 *  纯净探测只会在"真的 require 到"时报 warn 然后继续——可**顶层** require 一旦出现在
 *  容器装配链上，容器是当场崩、不是 warn。专项 §八 V1 与 §十 第 5 条要拦的正是这个：
 *  4C 刚把 plugin-updater.cjs 原 :6 那行顶层 require 拆掉，谁再写回来必须当场红。 */
const topLevelElectron = [];
/** WARN：可选包里"顶层且无 try 保护"的 require。今天不在启动链上（purity 实测），
 *  但谁把它所在的文件顶层 require 进容器装配链，就会当场崩——列出来是让人改动时看得见。 */
const unguardedOptional = [];

const builtins = new Set(require("node:module").builtinModules);


function relOf(file) {
  return file.slice(ROOT.length + 1).split(path.sep).join("/");
}

/** 是否需要在镜像里真装上的第三方裸名（node 内建 / node: 前缀 / 相对与绝对路径都不算） */
function isBareThirdParty(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)) return false;
  if (spec.startsWith("node:")) return false;
  if (builtins.has(spec)) return false;
  return true;
}

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
  const lines = src.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    const re = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(line))) {
      const next = resolveRel(file, m[1]);
      if (next) walk(next);
      else if (m[1].startsWith(".")) missing.push(`${file.slice(ROOT.length + 1)} -> ${m[1]}`);
      else if (isBareThirdParty(m[1])) {
        const pkg = pkgRootName(m[1]);
        if (!bareRequires.has(pkg)) bareRequires.set(pkg, new Set());
        bareRequires.get(pkg).add(rel);
        // 「顶层且无保护」的判定：零缩进（函数体/回调体必然有缩进）**且**这一行不是
        // try { … } 的单行保护。两个都是实测出来的必要条件：config.cjs:41 与
        // memory/index.cjs:26 都是零缩进的 `try { require("electron") } catch {}`，
        // 只判缩进会把它们误报成崩溃点（第一版就红在这两处）。
        const atCol0 = line.length === line.trimStart().length;
        const guardedInline = /(^|;|\})\s*try\s*\{/.test(line.slice(0, m.index));
        if (atCol0 && !guardedInline) {
          const where = `${rel}:${idx + 1}`;
          if (pkg === "electron") topLevelElectron.push(`${where}  require("${m[1]}")`);
          // 其它"桌面专属/运行期才 require"的包：顶层无保护本身不是错，错的是它可能
          // 被拖进启动链。purity 已实测 sqlcipher.cjs:23 的 koffi 当前**不在**启动链上，
          // 所以只 warn，并写清前提，免得后来人把 warn 当 noise 划掉。
          else if (RUNTIME_OPTIONAL.has(pkg)) unguardedOptional.push(`${where}  require("${m[1]}")`);
        }
      }
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

// ── 第三方裸名断言（阶段 0.2）：闭包里出现的每个第三方包，镜像内必须真的装得上 ──
const undeclared = [];
const optionalWarn = [];
for (const [pkg, from] of [...bareRequires.entries()].sort()) {
  if (containerAllowed.allowed.has(pkg)) continue;
  const line = `  ${pkg}  ← requiredBy: ${[...from].sort().join(", ")}`;
  if (RUNTIME_OPTIONAL.has(pkg)) optionalWarn.push(line);
  else undeclared.push(line);
}
console.log(`第三方裸名：${bareRequires.size} 个（容器允许集 ${containerAllowed.allowed.size} 个包）`);
if (undeclared.length) {
  console.log(`未在 gateway/package-lock.json 内 ${undeclared.length} 项（镜像内 npm ci 装不上 → 容器启动即 MODULE_NOT_FOUND）：`);
  for (const l of undeclared) console.log(l);
  console.error("修法：在 gateway/package.json 的 dependencies 里补该包，再 cd gateway && npm run lock 重生成 lock");
}
if (optionalWarn.length) {
  console.log(`warn · 桌面专属或运行期才触达，暂不阻断（新增请同步核对其 require 是否仍在 try/函数内）：`);
  for (const l of optionalWarn) console.log(l);
}

// ── T8：容器 require 链上不得有**顶层** require("electron")（专项 §八 V1 / §十 第 5 条）──
if (unguardedOptional.length) {
  console.log(`warn · 可选包的顶层无保护 require（${unguardedOptional.length} 处；当前不在容器启动链上，由 purity 实测保证）：`);
  for (const u of unguardedOptional) console.log("  " + u);
  console.log("  ↑ 别划掉这条：把上述文件顶层 require 进容器装配链，就会变成第二个 js-yaml 事故");
}
if (topLevelElectron.length) {
  console.log(`❌ 顶层 require("electron") ${topLevelElectron.length} 处（容器装配链上一旦出现即启动即崩，不是运行期问题）：`);
  for (const t of topLevelElectron) console.log("  " + t);
  console.error("修法：把 electron 的取用挪进函数体并包 try/catch，或走 proxy/platform 的形态契约（fetchBinary 等），参照 plugin-updater.cjs:9 的约束注释");
}

if (count < MIN || missing.length || forbidden.length || undeclared.length || topLevelElectron.length || containerAllowed.error) {
  if (containerAllowed.error) console.error(containerAllowed.error);
  console.error(
    missing.length ? "闭包存在缺失文件"
      : forbidden.length ? "闭包出现旧转发链路文件"
      : undeclared.length ? "闭包出现未声明的第三方依赖"
      : topLevelElectron.length ? "闭包出现顶层 require(electron)，容器会启动即崩"
      : `闭包文件数低于下限 ${MIN}`
  );
  process.exit(1);
}
console.log("闭包完整，未复活旧转发链路，第三方依赖全部在 gateway lock 内，且容器链上无顶层 require(electron)");

