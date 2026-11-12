/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Docker 形态依赖纯净探测（方案 §六 T1；原型见 tmp/probe-gateway-deps2.cjs）。
//
// ── 它卡住的是什么坑 ──────────────────────────────────────────
// 镜像的 deps 层只 `npm ci` 了 gateway/package-lock.json（Dockerfile:19-20），而本机
// `npm run verify:gateway` 用的是仓库根的全量 node_modules。于是「某个共享模块顶层
// require 了一个只在根 package.json 声明的第三方包」这类问题，在本机永远全绿，
// 进了镜像就是启动即 MODULE_NOT_FOUND —— 这就是 2026-11-11 查出的 js-yaml 事故链：
//   gateway/src/index.cjs → commands.cjs → proxy/index.cjs → netproxy.cjs → clash.cjs:27
// 本工具把 require 环境**复刻成镜像里的样子**：允许集 = node 内建 + 相对/绝对路径
// + gateway lock 内真实存在的包名，其余裸名一律抛 MODULE_NOT_FOUND，再加载启动必经的
// gateway/src/commands.cjs。缺包当场在这里变红，不必等到有 Docker 的机器上才发现。
//
// ── 一个必须记住的实测事实（别再踩）────────────────────────────
// `node:sqlite` **不在** Module.builtinModules 里（Node 22.22 实测：
// builtinModules.includes("sqlite") === false，但 require("node:sqlite") 可用）。
// 而它正是容器唯一的数据库驱动（proxy/store.cjs:27）。所以判定内建**必须按 `node:`
// 前缀放行**，绝不可以「在不在 builtinModules 里」为准 —— 否则容器唯一驱动会被误报成
// 「缺失的第三方依赖」，而这种误报的结局是人们直接绕过门禁。builtinModules 在此只作
// 额外宽松项（兼容老式裸名 fs/path 之类），不作为判据。
//
// 只读工具：不启动 HTTP 服务、不写数据目录（require 链本身的顶层副作用与冒烟一致）。
//
// 用法：node tools/gateway-deps-purity.cjs [--entry <相对路径>] [--strict]
//   --entry  要加载的入口（默认 gateway/src/commands.cjs = 容器启动必经链）
//   --strict 把「运行期才 require」的包也判红（默认只 WARN）
// 退出码：0 = 通过（可含 WARN）；1 = 启动链上有未声明的第三方裸名，或入口没能加载
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
function argOf(flag, dft) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dft;
}
const unknownFlag = args.find((a) => a.startsWith("--") && !["--entry", "--strict"].includes(a));
if (unknownFlag) {
  console.error(`未知参数 ${unknownFlag}（可用：--entry <相对路径> --strict）`);
  process.exit(2);
}

const ENTRY_REL = argOf("--entry", path.join("gateway", "src", "commands.cjs"));
const STRICT = args.includes("--strict");
const ENTRY = path.resolve(ROOT, ENTRY_REL);
if (!fs.existsSync(ENTRY)) {
  console.error(`入口不存在：${ENTRY_REL}`);
  process.exit(2);
}

/** 「桌面专属 / 运行期才 require」的包：不在容器启动链上，缺了只 WARN 不判红。
 *  与 tools/gateway-closure-check.cjs 的 RUNTIME_OPTIONAL 是同一份口径（那边静态扫闭包，
 *  这边真加载入口），两处漂移会给出互相矛盾的结论 —— 改动务必同步。依据（逐条核对磁盘）：
 *   electron              : 全部 require 都在函数体内或 try/catch 内（config.cjs:24,41、
 *                           memory/index.cjs:26 等），容器走 platform/node 形态不会触达；
 *   better-sqlite3        : store.cjs:31 是 node:sqlite 失败后的嵌套 try 回退；
 *   koffi                 : 只被 sqlcipher.cjs:23 顶层 require，而该模块不在容器装配链上；
 *   electron-updater/-builder : 桌面更新与打包，容器升级走镜像 pull。 */
const RUNTIME_OPTIONAL = new Set(["electron", "better-sqlite3", "koffi", "electron-updater", "electron-builder"]);

/** 容器允许集：gateway lock 里出现的包名（含传递依赖；嵌套路径取末段） */
function loadContainerAllowed() {
  const lockFile = path.join(ROOT, "gateway", "package-lock.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch (e) {
    console.error(`无法读取 ${path.relative(ROOT, lockFile)}: ${(e && e.message) || e}`);
    process.exit(2);
  }
  const allowed = new Set();
  for (const key of Object.keys(raw.packages || {})) {
    if (!key.startsWith("node_modules/")) continue;
    allowed.add(key.slice("node_modules/".length).split("/node_modules/").pop());
  }
  if (!allowed.size) {
    console.error("gateway/package-lock.json 内没有任何 node_modules 条目（lock 可能损坏）");
    process.exit(2);
  }
  return allowed;
}

/** 裸名 → 包根名：scoped 取前两段（@scope/name），普通包去掉子路径 */
function pkgRootName(spec) {
  const seg = spec.split("/");
  return spec.startsWith("@") ? seg.slice(0, 2).join("/") : seg[0];
}

const allowed = loadContainerAllowed();
const builtins = new Set(Module.builtinModules); // 仅额外宽松项，判据见顶部实测事实说明

function isLocalOrBuiltin(req) {
  if (req.startsWith("node:")) return true; // ← 唯一可靠判据（builtinModules 里没有 sqlite）
  if (req.startsWith(".") || req.startsWith("/") || /^[A-Za-z]:[\\/]/.test(req)) return true;
  return builtins.has(req);
}

// 迭代探测：第一次拦到某个未声明的包就抛 MODULE_NOT_FOUND 并记账，后续轮次对该包放行
// （本机根 node_modules 里有它），从而把后面的缺失一次报全 —— 原型同款做法。
// 硬约束：**最终没能加载成功一律判红**，绝不允许「没加载成但缺失清单为空」的假绿。
const hits = [];
const blockedOnce = new Set();
let loaded = false;
let fatal = null;

for (let round = 0; round < 60; round++) {
  for (const k of Object.keys(require.cache)) {
    if (!k.includes("node_modules")) delete require.cache[k];
  }
  const before = blockedOnce.size;
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (!isLocalOrBuiltin(request)) {
      const pkg = pkgRootName(request);
      if (!allowed.has(pkg) && !blockedOnce.has(pkg)) {
        hits.push({
          pkg,
          request,
          requiredBy: parent && parent.filename ? path.relative(ROOT, parent.filename).split(path.sep).join("/") : "(entry)",
        });
        blockedOnce.add(pkg);
        const e = new Error(`Cannot find module '${request}'`);
        e.code = "MODULE_NOT_FOUND";
        throw e;
      }
    }
    return origLoad.apply(this, arguments);
  };
  try {
    require(ENTRY);
    loaded = true;
    fatal = null;
  } catch (e) {
    loaded = false;
    fatal = e;
  } finally {
    Module._load = origLoad;
  }
  if (loaded) break;
  if (blockedOnce.size === before) break; // 本轮没挖出新缺失，再迭代也不会前进
}

const missing = hits.filter((h) => !allowed.has(h.pkg));
const hard = missing.filter((h) => STRICT || !RUNTIME_OPTIONAL.has(h.pkg));
const warn = missing.filter((h) => !STRICT && RUNTIME_OPTIONAL.has(h.pkg));

console.log(`容器允许集：gateway lock 内 ${allowed.size} 个包 · 探测入口 ${path.relative(ROOT, ENTRY).split(path.sep).join("/")}`);
if (!loaded) {
  console.error(`❌ 入口未能加载：${String((fatal && fatal.message) || fatal).split("\n")[0]}`);
  console.error("   依赖拦截之外的加载失败同样要红：相对文件缺失、语法错误、顶层副作用抛错都算");
}
if (hard.length) {
  console.log(`❌ 未声明的第三方依赖 ${hard.length} 项（镜像内 npm ci 装不上 → 容器启动即 MODULE_NOT_FOUND）：`);
  for (const h of hard) console.log(`   ${h.pkg}  ← requiredBy: ${h.requiredBy}（require "${h.request}"）`);
  console.log("   修法：在 gateway/package.json 的 dependencies 补该包，再 cd gateway && npm run lock 重生成 lock");
}
if (warn.length) {
  console.log(`warn · 运行期才 require 或桌面专属，不在容器启动链上（${warn.length} 项）：`);
  for (const h of warn) console.log(`   ${h.pkg}  ← ${h.requiredBy}`);
}
if (loaded && !hard.length) console.log("✅ 依赖纯净探测通过：启动链上的第三方裸名全部在 gateway lock 内");
process.exit(loaded && !hard.length ? 0 : 1);
