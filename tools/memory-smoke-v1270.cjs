/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · v1.27.0 整改回归断言（真实调度器，假 service）：
//   a. 运行中快照：status().running 带中文 name / 中文 phase / percent（界面「正在执行」卡片的数据源）
//   b. 进度广播：任务通过 onProgress 上报时，emit 出 task-progress 事件（percent 原样透传）
//   c. 开始事件带中文任务名（name），不再是让界面自己猜 id
//   d. 时间线条目带中文 name（历史记录里存的是英文 id，返回时映射）
//   e. 超预算跳过文案用中文任务名，不露 extract 这类英文标识
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke-v1270.cjs
"use strict";

const path = require("path");
const { MemoryScheduler } = require(path.join(__dirname, "..", "electron", "backend", "memory", "scheduler.cjs"));

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return true;
  }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}

function makeIndex(usageTokens = 0) {
  return {
    readOnly: false,
    getMeta: () => 0,
    setMeta: () => {},
    llmUsageToday: () => ({ tokens: usageTokens, calls: 1 }),
    db: { prepare: () => ({ get: () => ({ c: 0 }), all: () => [] }), exec: () => {} },
  };
}

function makeScheduler({ usageTokens = 0, cfg = {} } = {}) {
  const events = [];
  const service = { index: makeIndex(usageTokens), store: { walkMemoryFiles: () => [] }, reindexFile: () => {}, pruneOrphans: () => 0 };
  const tasks = {
    onProgress: null,
    snapshot: null,
    runClassify() {
      this.snapshot = sched.status().running; // 运行中读一次快照，模拟真实任务在跑的时候界面能看到什么
      if (this.onProgress) this.onProgress(50, "本地匹配 50/100 条");
      return { processed: 100, updated: 3, tokens: 0, detail: "扫描 100 条未归类，产出 3 条建议" };
    },
    runExtract: () => ({ processed: 0, tokens: 0, detail: "不该被调用" }),
  };
  const sched = new MemoryScheduler({
    service,
    tasks,
    getConfig: () => ({ "auto.logKeepDays": 0, ...cfg }),
    emit: (e) => events.push(e),
  });
  // 与 index.cjs 的真实装配同款：任务实现把进度交回调度器
  tasks.onProgress = (percent, phase) => sched.progress(percent, phase);
  sched.loadHistory = () => {}; // 不读持久化历史（fake index 的 meta 恒为 0）
  return { sched, tasks, events };
}

async function main() {
  console.log("[a-e] 调度器：中文任务名 + 运行中进度 + 时间线映射 + 超预算文案");
  const { sched, tasks, events } = makeScheduler();

  const record = await sched.runTask("classify");
  check("runTask 正常返回 ok", record.ok === true, JSON.stringify(record));
  check("运行中快照带中文 name（项目归类建议）", tasks.snapshot && tasks.snapshot.name === "项目归类建议", JSON.stringify(tasks.snapshot));
  check("运行中快照带数字 percent", tasks.snapshot && typeof tasks.snapshot.percent === "number" && tasks.snapshot.percent >= 0, JSON.stringify(tasks.snapshot && tasks.snapshot.percent));
  check("运行中快照的 phase 是中文", tasks.snapshot && /[\u4e00-\u9fa5]/.test(String(tasks.snapshot.phase || "")), String(tasks.snapshot && tasks.snapshot.phase));
  check("结束后 running 归零", sched.status().running === null, JSON.stringify(sched.status().running));

  const startEvt = events.find((e) => e.type === "task" && e.phase === "start");
  check("开始事件带中文任务名", !!startEvt && startEvt.name === "项目归类建议", JSON.stringify(startEvt));
  const progressEvt = events.find((e) => e.type === "task-progress");
  check("有 task-progress 进度事件（percent=50 / 中文阶段）", !!progressEvt && progressEvt.percent === 50 && /[\u4e00-\u9fa5]/.test(String(progressEvt.phase)), JSON.stringify(progressEvt));

  const tl = sched.timeline(10);
  check("时间线返回条目", tl.length === 1, String(tl.length));
  check("时间线条目带中文 name（记录里仍是英文 id）", tl[0] && tl[0].name === "项目归类建议" && tl[0].task === "classify", JSON.stringify(tl[0] && { task: tl[0].task, name: tl[0].name }));

  // 超预算：日上限 10、已用 100 → 模型任务被闸门拦下，文案必须是中文任务名
  const over = makeScheduler({ usageTokens: 100, cfg: { "auto.dailyTokenLimit": 10 } });
  const blocked = await over.sched.runTask("extract");
  check("超预算时模型任务被跳过", blocked.ok === false && blocked.skipped === "budget", JSON.stringify(blocked));
  check("跳过文案用中文任务名（含「抽取结构化信息」、不含 extract）", /抽取结构化信息/.test(blocked.message) && !/\bextract\b/.test(blocked.message), blocked.message);
  const pausedEvt = over.events.find((e) => e.type === "auto-paused");
  check("auto-paused 事件文案也是中文", !!pausedEvt && /抽取结构化信息/.test(pausedEvt.detail), JSON.stringify(pausedEvt));

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log(" - " + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("套件异常：", e && e.stack ? e.stack : e);
  process.exit(2);
});
