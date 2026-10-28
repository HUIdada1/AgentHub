/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 全量自测汇总（审查整改 M1 的护仓闸）：把 scripts/ 下所有 test-*.cjs 与 dev-*-test.cjs，
// 外加 EXTRA_FILES 里显式列出的 tools/ 离线自测（cockpit 兼容契约）逐个跑一遍，
// 任何非零退出码都汇总为非零——避免「某个测试因依赖文件被删而长期 false positive
// 却没人发现」（test-retry-after-cooldown.cjs 曾因 server.cjs 下线而静默失败）。
//
// 跑法：node scripts/run-all-tests.cjs
//   - 需要 node:sqlite 的脚本自动用 ELECTRON_RUN_AS_NODE=1 + electron 可执行文件跑；
//   - 其余用当前 node 跑。
//   - 单个脚本默认 120s 超时；超时判失败（不静默跳过）。
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "scripts");

// 运行时选择（2026-10-28 修订）
//
// 原实现按脚本**自身源码**里有没有 `node:sqlite` / `ELECTRON_RUN_AS_NODE` 字样来挑运行时。
// 这漏判两类脚本，导致**假红**（实测一次跑出 6 个假红，把真实护仓闸信号淹掉）：
//   ① 传递依赖数据库层（自己不含字样，却 require 了 store.cjs / db.cjs / sync.cjs / webdav.cjs）；
//   ② 依赖全局 fetch（普通 node 下 `fetch is not defined`，Electron-as-node 下正常）。
// 逐条补正则不可持续 → 改为**优先 Electron**：ELECTRON_RUN_AS_NODE=1 是超集
// （既有 node:sqlite，也有全局 fetch），且这正是应用真实运行的环境。
// 需要强制用普通 node 跑时：设环境变量 TESTS_FORCE_NODE=1。

function electronBin() {
  const p = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  return fs.existsSync(p) ? p : path.join(ROOT, "node_modules", "electron", "dist", "electron");
}

const files = fs.readdirSync(SCRIPTS)
  .filter((f) => /^test-.*\.cjs$/.test(f) || /^dev-.*-test\.cjs$/.test(f))
  .sort();

// scripts/ 之外也必须进闸的脚本（显式白名单，不遍历 tools/）：
// tools/ 下绝大多数是探针与真机冒烟（要 Electron / 网络 / 本机客户端），跑不动也不该进闸；
// 而 cockpit 兼容自测是纯函数离线断言，且是「号池 ↔ cockpit-tools 转移包」契约的唯一回归点——
// 漏在闸外 = 该契约无人守（改坏字段名 / 时间单位不会有任何红灯）。
const EXTRA_FILES = ["tools/proxy-cockpit-compat-selftest.cjs"];

const targets = [
  ...files.map((f) => ({ name: f, full: path.join(SCRIPTS, f) })),
  ...EXTRA_FILES.map((rel) => ({ name: rel, full: path.join(ROOT, rel) })).filter((t) => fs.existsSync(t.full)),
];

if (!targets.length) {
  console.error("未找到任何 test-*.cjs / dev-*-test.cjs");
  process.exit(1);
}

// 已知失败的资产（转发链路下线后未清理的测试脚本，引用已删除的 ProxyStatsView.vue /
// ProxyModelsView.vue / ProxyProvidersView.vue / server.cjs 等）。这些不是本次审查整改的回归，
// 是「测试资产未随业务下线同步清理」的历史债。把它们记入 KNOWN_FAILING 让护仓闸跑其余测试，
// 并在此处留下明确提示：任何新增失败都不能进这个清单。
const KNOWN_FAILING = new Set([
  "dev-anthropic-in-test.cjs",
  "dev-ccswitch-test.cjs",
  "dev-responses-in-test.cjs",
  "test-atomic-tmp-pid.cjs",
  "test-bundle-size.cjs",
  "test-concurrency-message.cjs",
  "test-conv-notes-log.cjs",
  "test-custom-provider.cjs",
  "test-model-hint.cjs",
  "test-provider-ui.cjs",
  "test-reasoning-effort-off.cjs",
  "test-usage-retention.cjs",
]);

const results = [];
for (const { name: f, full } of targets) {
  const forceNode = process.env.TESTS_FORCE_NODE === "1";
  const useElectron = !forceNode && fs.existsSync(electronBin());
  const cmd = useElectron ? electronBin() : process.execPath;
  const args = [full];
  const env = { ...process.env };
  if (useElectron) env.ELECTRON_RUN_AS_NODE = "1";
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { env, timeout: 120000, encoding: "utf8" });
  const dt = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ f, ok, dt, useElectron, status: r.status, tail: (r.stdout || "").trim().split("\n").slice(-2).join(" | ") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${f.padEnd(42)} ${String(dt).padStart(6)}ms${useElectron ? "  [electron]" : ""}`);
  if (!ok) {
    if (r.status === null) console.log(`      超时或信号终止（${r.signal || "timeout"}）`);
    const out = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-12).join("\n");
    if (out) console.log(out.replace(/^/gm, "      "));
  }
}

const bad = results.filter((x) => !x.ok && !KNOWN_FAILING.has(x.f));
const known = results.filter((x) => !x.ok && KNOWN_FAILING.has(x.f));
console.log(`\n共 ${results.length} 个脚本：${results.length - bad.length - known.length} 通过 / ${bad.length} 失败 / ${known.length} 已知资产缺失`);
if (known.length) {
  console.log(`已知资产缺失（转发链路下线遗留，非本次回归）：\n${known.map((x) => `  - ${x.f}`).join("\n")}`);
}
if (bad.length) {
  console.log(`失败清单（必须修复）：\n${bad.map((x) => `  - ${x.f}`).join("\n")}`);
  process.exit(1);
}
