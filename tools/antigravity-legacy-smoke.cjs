// Antigravity 老数据恢复适配器自测（ELECTRON_RUN_AS_NODE 跑，拿到 Node 22 + node:sqlite）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/antigravity-legacy-smoke.cjs
// 说明：会真实启动一次反重力 language_server.exe（沙盒读取副本），约 30~90 秒；
//       只读原始 .pb，不改动用户任何文件；结束后自动清理 %TEMP% 沙盒。
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const adapter = require(path.join(__dirname, "..", "electron", "backend", "adapter-antigravity-legacy.cjs"));

function ts(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

async function main() {
  console.log("=== Antigravity 老数据恢复适配器自测 ===");
  console.log("id:", adapter.id, "| name:", adapter.name);

  const detected = adapter.detect();
  console.log("detect():", detected);
  if (!detected) {
    console.log("未检测到老 .pb 数据，退出");
    return;
  }
  console.log("validate():", adapter.validate(detected));
  const deviceId = adapter.getDeviceId();
  console.log("deviceId:", deviceId);

  const t0 = Date.now();
  const records = await adapter.extract(detected, deviceId, "这台电脑", 0);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nextract() 完成，耗时 ${cost}s，共 ${records.length} 条记录`);

  if (!records.length) {
    console.log("没有记录产出（可能没有可解会话）");
    return;
  }

  const sum = records.reduce((a, r) => ({
    input: a.input + r.inputTokens,
    output: a.output + r.outputTokens,
    reasoning: a.reasoning + r.reasoningTokens,
  }), { input: 0, output: 0, reasoning: 0 });

  console.log("\n--- 汇总 ---");
  console.log("输入 token:", sum.input.toLocaleString());
  console.log("输出 token:", sum.output.toLocaleString());
  console.log("思考 token:", sum.reasoning.toLocaleString());
  console.log("合计:", (sum.input + sum.output + sum.reasoning).toLocaleString());

  const byMonth = {};
  for (const r of records) {
    const m = ts(r.startedAt).slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { n: 0, input: 0, output: 0, reasoning: 0 };
    byMonth[m].n++;
    byMonth[m].input += r.inputTokens;
    byMonth[m].output += r.outputTokens;
    byMonth[m].reasoning += r.reasoningTokens;
  }
  console.log("\n--- 按月份 ---");
  for (const [m, v] of Object.entries(byMonth).sort()) {
    console.log(`  ${m}: ${v.n} 条，输入 ${v.input.toLocaleString()} / 输出 ${v.output.toLocaleString()} / 思考 ${v.reasoning.toLocaleString()}`);
  }

  console.log("\n--- 前 3 条样本 ---");
  for (const r of records.slice(0, 3)) {
    console.log(`  ${ts(r.startedAt)} | ${r.modelId} | in=${r.inputTokens} out=${r.outputTokens} think=${r.reasoningTokens} | session=${r.sessionId}`);
    console.log(`    id=${r.id}`);
  }
  console.log("\n自测通过。");
}

main().catch((e) => {
  console.error("自测失败:", e);
  process.exit(1);
});
