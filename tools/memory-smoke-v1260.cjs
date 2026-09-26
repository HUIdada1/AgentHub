/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · v1.26.0 修复批次回归断言：
//   a. 模块 init 后 scheduler.syncer 非 null（自动同步曾经因此从未运行）
//   b. writeMemory 把 classify.gitPreferred 传进 layout.classify（曾经是假旋钮）
//   c. 全空白 title+body 写入被拒（内容为空）
//   d. schema 已删的 dedup.l4.autoDelete 在 flat() 中消失，旧配置文件残留该键不炸
//   e. search 支持 type/tag/starred/pinned 过滤
//   f. ui.tabs 默认 5 项且含 dashboard/browse
//   g. import.maxBatchBytes 默认 8388608（8MB，与引擎硬顶一致）
//   h. 预算阻断不连坐 needsModel=false 的本地任务
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke-v1260.cjs
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

async function main() {
  const root = path.join(os.tmpdir(), `agenthub-memory-v1260-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  // ===== a. 模块装配：init 后 scheduler.syncer 非 null =====
  // 用独立 APPDATA 把框架配置重定向到临时目录，并把 memory.rootDir 指向测试根，
  // 避免 init() 落到真实用户目录
  console.log("[a] 模块装配：scheduler.syncer 在 init 后即就位");
  const fakeAppData = path.join(root, "_appdata");
  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = fakeAppData;
  const configMod = require("../electron/backend/config.cjs");
  const framework = configMod.loadConfig();
  framework.memory = { ...(framework.memory || {}), rootDir: path.join(root, "repo") };
  configMod.saveConfig(framework);
  const memIndex = require("../electron/backend/memory/index.cjs");
  const initRes = memIndex.init();
  check("init 返回 enabled", initRes.enabled === true, JSON.stringify(initRes));
  check("scheduler.syncer 非 null（自动同步可运行）", !!(memIndex.scheduler && memIndex.scheduler.syncer),
    `scheduler=${!!memIndex.scheduler} syncer=${!!(memIndex.scheduler && memIndex.scheduler.syncer)}`);
  check("导出的 syncer 与 scheduler.syncer 是同一实例", memIndex.syncer && memIndex.scheduler.syncer === memIndex.syncer);
  await memIndex.shutdown();
  if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;

  // ===== 后续用独立 service =====
  const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
  const { MemoryService } = require("../electron/backend/memory/service.cjs");
  const layout = require("../electron/backend/memory/layout.cjs");
  const { SCHEMA, flattenDefaults } = require("../electron/backend/memory/config-schema.cjs");

  const repoRoot = path.join(root, "repo2");
  const cfg = new MemoryConfig(repoRoot);
  cfg.load();
  const svc = new MemoryService(repoRoot, cfg, { deviceId: "dev_v1260", onEvent: () => {} }).init();

  // ===== b. gitPreferred 传入 classify =====
  console.log("[b] writeMemory 把 classify.gitPreferred 传进 layout.classify");
  const origClassify = layout.classify;
  const seenCfgs = [];
  layout.classify = function (input, registry, cfgArg) {
    seenCfgs.push(cfgArg || {});
    return origClassify.apply(this, arguments);
  };
  cfg.set({ "classify.gitPreferred": false }, { local: true });
  await svc.writeMemory({ title: "gitPreferred 探测条", body: "验证 gitPreferred 配置被传进归类引擎的正文内容。", type: "note", project: "R" });
  cfg.set({ "classify.gitPreferred": true }, { local: true });
  await svc.writeMemory({ title: "gitPreferred 探测条二", body: "验证 gitPreferred 配置被传进归类引擎的另一条正文内容。", type: "note", project: "R" });
  layout.classify = origClassify;
  check("第一次写入 classify 收到 gitPreferred=false", seenCfgs.length >= 1 && seenCfgs[0].gitPreferred === false, JSON.stringify(seenCfgs[0]));
  check("第二次写入 classify 收到 gitPreferred=true", seenCfgs.length >= 2 && seenCfgs[1].gitPreferred === true, JSON.stringify(seenCfgs[1]));

  // ===== c. 全空白写入被拒 =====
  console.log("[c] 空内容校验在标题兜底之前");
  const empty = await svc.writeMemory({ title: "   ", body: "  \n  ", type: "note", project: "R" });
  check("全空白 body+title → ok:false 且 message 含「内容为空」", empty.ok === false && /内容为空/.test(empty.message || ""), JSON.stringify(empty));
  const empty2 = await svc.writeMemory({ title: "", body: "", type: "note", project: "R" });
  check("空串 body+title → ok:false", empty2.ok === false && /内容为空/.test(empty2.message || ""), JSON.stringify(empty2));
  const normal = await svc.writeMemory({ title: "正常条", body: "有正文，不该被空校验误伤。", type: "note", project: "R" });
  check("正常写入不受新校验影响", normal.ok === true && !!normal.id, JSON.stringify(normal));

  // ===== d. autoDelete 已从 schema 移除；旧配置残留不炸 =====
  console.log("[d] dedup.l4.autoDelete 键清理");
  check("SCHEMA 不含 dedup.l4.autoDelete", !("dedup.l4.autoDelete" in SCHEMA));
  check("flat() 默认值不含 dedup.l4.autoDelete", !("dedup.l4.autoDelete" in svc.flat()), "flat 里仍出现该键");
  // 旧配置文件残留同名键：load/flat/get 都必须安全忽略（手工造一份含残留键的主配置）
  const cfgFile = path.join(repoRoot, "config", "memory.config.json");
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  let oldRaw = {};
  try { oldRaw = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { /* 主配置还没写过 */ }
  oldRaw.dedup = { ...(oldRaw.dedup || {}), l4: { ...((oldRaw.dedup || {}).l4 || {}), autoDelete: true } };
  fs.writeFileSync(cfgFile, JSON.stringify(oldRaw, null, 2), "utf8");
  cfg.load(true);
  let getThrew = null;
  let gotLegacy;
  try { gotLegacy = cfg.get("dedup.l4.autoDelete"); } catch (e) { getThrew = String(e.message || e); }
  check("旧配置残留 autoDelete 时 load/get 不炸", getThrew === null, String(getThrew));
  check("flat() 仍不返回 autoDelete（被 schema 口径忽略）", !("dedup.l4.autoDelete" in svc.flat()), `legacy=${JSON.stringify(gotLegacy)}`);
  const setRes = cfg.set({ "dedup.l4.autoDelete": false });
  check("memCfg.set 旧键返回错误而非崩溃", setRes && setRes.ok === false, JSON.stringify(setRes));

  // ===== e. search 过滤 type/tag/starred/pinned =====
  console.log("[e] search 支持 type/tag/starred/pinned 过滤");
  const kw = "回归v1260检索关键词";
  const r1 = await svc.writeMemory({ title: `${kw} 决策条`, body: `${kw}：决策类正文，足够长以便 FTS 命中。`, type: "decision", layer: "l2", project: "R", tags: ["过滤甲"] });
  const r2 = await svc.writeMemory({ title: `${kw} 日常条`, body: `${kw}：日常类正文，足够长以便 FTS 命中。`, type: "daily", project: "R", tags: ["过滤乙"] });
  const r3 = await svc.writeMemory({ title: `${kw} 星标条`, body: `${kw}：星标正文，足够长以便 FTS 命中。`, type: "note", project: "R", starred: true });
  const r4 = await svc.writeMemory({ title: `${kw} 置顶条`, body: `${kw}：置顶正文，足够长以便 FTS 命中。`, type: "note", project: "R", pinned: true });
  void r1; void r2; void r3; void r4;
  const flat = svc.flat();
  const sType = svc.searchMemories(kw, { type: "decision", limit: 20 }, flat);
  check("type=decision 只命中决策条", sType.results.length >= 1 && sType.results.every((r) => r.type === "decision"), JSON.stringify(sType.results.map((r) => r.type)));
  const sTag = svc.searchMemories(kw, { tag: "过滤乙", limit: 20 }, flat);
  check("tag=过滤乙 只命中带该标签的条", sTag.results.length >= 1 && sTag.results.every((r) => (r.tags || []).includes("过滤乙")), JSON.stringify(sTag.results.map((r) => r.tags)));
  const sStar = svc.searchMemories(kw, { starred: true, limit: 20 }, flat);
  check("starred=true 只命星标条", sStar.results.length >= 1 && sStar.results.every((r) => r.starred === true), JSON.stringify(sStar.results.map((r) => [r.id, r.starred])));
  const sPin = svc.searchMemories(kw, { pinned: true, limit: 20 }, flat);
  check("pinned=true 只命置顶条", sPin.results.length >= 1 && sPin.results.every((r) => r.pinned === true), JSON.stringify(sPin.results.map((r) => [r.id, r.pinned])));
  const sAll = svc.searchMemories(kw, { limit: 20 }, flat);
  check("无过滤时四类都能召回（过滤确实收窄了结果）", sAll.results.length >= 4 && sType.results.length < sAll.results.length, `all=${sAll.results.length} type=${sType.results.length}`);

  // ===== f/g. schema 新键与默认值 =====
  console.log("[f] ui.tabs 配置键");
  const tabsDef = SCHEMA["ui.tabs"];
  check("ui.tabs 存在且为 multiselect", !!tabsDef && tabsDef.type === "multiselect", JSON.stringify(tabsDef && tabsDef.type));
  check("ui.tabs 默认 5 项且含 dashboard/browse", Array.isArray(tabsDef.def) && tabsDef.def.length === 5 && tabsDef.def.includes("dashboard") && tabsDef.def.includes("browse"), JSON.stringify(tabsDef.def));
  check("ui.tabs options 覆盖 9 个页签", Array.isArray(tabsDef.options) && tabsDef.options.length === 9 && tabsDef.options.includes("profile") && tabsDef.options.includes("sync"), JSON.stringify(tabsDef.options));
  const defaults = flattenDefaults();
  check("flattenDefaults 含 ui.tabs 默认值", Array.isArray(defaults["ui.tabs"]) && defaults["ui.tabs"].length === 5);

  console.log("[g] import.maxBatchBytes 默认值与边界");
  const mb = SCHEMA["import.maxBatchBytes"];
  check("import.maxBatchBytes 默认 8388608", mb.def === 8388608, String(mb.def));
  check("import.maxBatchBytes min=1048576 max=8388608", mb.min === 1048576 && mb.max === 8388608, JSON.stringify({ min: mb.min, max: mb.max }));
  check("agents.enabled options 含 cursor/agents", SCHEMA["agents.enabled"].options.includes("cursor") && SCHEMA["agents.enabled"].options.includes("agents"), JSON.stringify(SCHEMA["agents.enabled"].options));

  // ===== h. 预算阻断不连坐本地任务 =====
  console.log("[h] scheduler budget 阻断不连坐 needsModel=false 任务");
  const { MemoryScheduler } = require("../electron/backend/memory/scheduler.cjs");
  // 把今日 token 用量顶到上限以上：dailyTokenLimit=1，再记一条今天的 llm 调用
  cfg.set({ "auto.dailyTokenLimit": 1, "auto.overBudgetAction": "pause" }, { local: true });
  svc.index.llmLog({ ts: Date.now(), provider: "test", model: "m", task: "extract", tokensIn: 10, tokensOut: 10, ok: true });
  const ran = [];
  const sched = new MemoryScheduler({
    service: svc,
    tasks: {
      runExtract: async () => { ran.push("extract"); return { processed: 0, tokens: 0, detail: "x" }; },
      runClassify: () => { ran.push("classify"); return { processed: 0, updated: 0, tokens: 0, detail: "x" }; },
    },
    getConfig: () => svc.flat(),
    emit: () => {},
  });
  sched.queue.push({ id: "extract", at: Date.now() });
  sched.queue.push({ id: "classify", at: Date.now() });
  await sched._drain();
  check("超预算后模型任务 extract 未执行", !ran.includes("extract"), JSON.stringify(ran));
  check("本地任务 classify 仍被执行（不连坐）", ran.includes("classify"), JSON.stringify(ran));
  const st = sched.status();
  check("预算状态如实上报 overBudget", st.overBudget === true, JSON.stringify({ overBudget: st.overBudget, todayTokens: st.todayTokens }));

  svc.close();
  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("回归自测崩溃：", (e && e.stack) || e);
  process.exit(2);
});
