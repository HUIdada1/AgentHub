/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止复制本声明。
 */

// 记忆仓库 · 真实模型联调自检（**手动按需运行，会真实消耗令牌**，不进任何自动流程）：
// 在记忆库的**副本**上用真实供应商 + 真实 Key 各跑一次结构化任务（抽取 / L2 蒸馏），
// 用来验收「Key 能解、模型能连、标签能路由、结构化输出没被 maxTokens 截断、L2 真的落盘」。
// 这些恰好是自动化跑不起来时最难从日志看出来的环节（历史故障：标签没打全 → 无可用模型；
// 思考型模型吃掉输出预算 → JSON 截断 → L2 一条都写不出）。
// 用法（必须 Electron 本体，safeStorage 要解 Key）：
//   ./node_modules/electron/dist/electron.exe tools/memory-llm-live-check.cjs [项目slug]
// 真实库只读：全流程在 tmp 副本里跑，结束即删。
"use strict";
const { app } = require("electron");
const fs0 = require("fs"), os0 = require("os"), path0 = require("path");

// safeStorage 的加密密钥与应用 userData 绑定，Chromium 在启动早期就初始化 ——
// 必须在 app ready 之前把 userData 指到「镜像了真实应用 Local State」的临时目录，
// 否则解不出（enc:v1: 信封）的 API Key，检查会以 401 假失败告终
const appData0 = path0.join(process.env.APPDATA || os0.homedir(), "AgentHub");
const tempUserData0 = path0.join(os0.tmpdir(), "agenthub-live-check-userdata");
fs0.mkdirSync(tempUserData0, { recursive: true });
try {
  fs0.copyFileSync(path0.join(appData0, "Local State"), path0.join(tempUserData0, "Local State"));
} catch { /* 没有 Local State 就跳过 */ }
app.setPath("userData", tempUserData0);

const PROJECT = process.argv[2] || "HUIdada1--AgentHub";

function copyMd(src, dst) {
  const fs = require("fs"), path = require("path");
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyMd(s, d);
    else if (e.name.endsWith(".md")) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

app.whenReady().then(async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const SRC = path.join(os.homedir(), "AgentHub", "memory");
  const DST = path.join(os.tmpdir(), "agenthub-live-check-" + Date.now());
  let failures = 0;
  try {
    fs.mkdirSync(DST, { recursive: true });
    fs.cpSync(path.join(SRC, "config"), path.join(DST, "config"), { recursive: true });
    let files = 0;
    for (const sub of ["general", "projects", "notes", "profile"]) files += copyMd(path.join(SRC, sub), path.join(DST, sub));

    const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
    const { MemoryService } = require("../electron/backend/memory/service.cjs");
    const { LlmClient } = require("../electron/backend/memory/llm/client.cjs");
    const { MemoryTasks } = require("../electron/backend/memory/tasks.cjs");
    const frameworkConfig = require("../electron/backend/config.cjs");
    const { safeStorage } = require("electron");

    const cfg = new MemoryConfig(DST);
    cfg.load();
    cfg.set({ "storage.root": DST }, { local: true });
    const svc = new MemoryService(DST, cfg, { deviceId: "dev_live_check", onEvent: () => {} }).init();
    for (const rel of svc.store.walkMemoryFiles()) svc.reindexFile(rel);
    const indexed = svc.index.db.prepare("SELECT COUNT(*) c FROM mem").get().c;
    console.log("副本就绪：" + files + " 个 md，索引 " + indexed + " 行");

    const prov = (svc.flat()["models.providers"] || [])[0] || {};
    const keyOk = !!frameworkConfig.decryptSecret(prov.apiKeyRef);
    console.log("Key 解出：" + (keyOk ? "是" : "否（safeStorage 解不开，后面必然是 401）"));
    if (!keyOk) failures++;

    const llm = new LlmClient({ service: svc, getConfig: () => svc.flat(), emit: () => {}, gatewayResolver: () => ({ available: false }) });
    for (const task of ["extract", "distill"]) {
      const chain = llm.resolveCandidates(task, {}).map((c) => c.provider.name + "/" + c.model.modelId);
      const okChain = chain.length > 0;
      console.log("任务 " + task + " 的降级链：" + (chain.join(" → ") || "【无可用模型：标签或绑定没配好】"));
      if (!okChain) failures++;
    }

    const tasks = new MemoryTasks({ service: svc, client: llm, emit: () => {}, rootDir: DST });

    console.log("\n[1/2] 抽取结构化信息（真模型）");
    const ex = await tasks.runExtract(20);
    console.log("  结果：" + JSON.stringify(ex));
    if (/无法解析/.test(ex.detail || "") || !ex.updated) failures++;

    console.log("\n[2/2] L2 蒸馏（真模型，" + PROJECT + "）");
    const dr = await tasks.runDistill({ project: PROJECT });
    console.log("  结果：" + JSON.stringify(dr));
    const rows = svc.index.db.prepare("SELECT type, title, substr(summary,1,60) s FROM mem WHERE layer='l2'").all();
    console.log("  L2 行数：" + rows.length);
    for (const row of rows) console.log("    · [" + row.type + "] " + row.title + "｜" + row.s);
    if (!dr.updated || !rows.length) failures++;

    console.log("\nllm_call 明细：" + JSON.stringify(svc.index.db.prepare("SELECT task, model, ok, tokens_in, tokens_out, detail FROM llm_call ORDER BY ts DESC LIMIT 8").all(), null, 1));
    svc.close();
    fs.rmSync(DST, { recursive: true, force: true });
    console.log("\n" + (failures ? "联调自检：失败 " + failures + " 项" : "联调自检：全部通过") + "（副本已清理，真实库未改动）");
    app.exit(failures ? 1 : 0);
  } catch (e) {
    console.error("联调自检异常：" + (e && e.stack ? e.stack : String(e)));
    try { fs.rmSync(DST, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
    app.exit(1);
  }
});
