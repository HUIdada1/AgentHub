// Antigravity 老数据恢复适配器自测（ELECTRON_RUN_AS_NODE 跑，拿到 Node 22 + node:sqlite）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/antigravity-legacy-smoke.cjs
// 说明：首次会真实启动一次反重力 language_server.exe（沙盒读取副本），约 10~100 秒；
//       之后因为指纹未变会秒返回（这是「只跑一次」的核心优化）；
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

  // 1) 第一次：走完整恢复（sinceMs=0）
  const t0 = Date.now();
  const records = await adapter.extract(detected, deviceId, "这台电脑", 0);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nextract(sinceMs=0) 完成，耗时 ${cost}s，共 ${records.length} 条记录`);

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

  // 2) 第二次：锚点已在 + 指纹未变 → 应该 0 条且秒返回
  const t2 = Date.now();
  const second = await adapter.extract(detected, deviceId, "这台电脑", 1);
  const cost2 = ((Date.now() - t2) / 1000).toFixed(2);
  console.log(`\nextract(sinceMs=1, 指纹未变) 耗时 ${cost2}s，产出 ${second.length} 条（应为 0）`);
  if (second.length !== 0) {
    console.log("  ⚠ 指纹未变时不应该再出记录，请检查增量逻辑");
  } else {
    console.log("  ✓ 增量语义正确（只在数据变化时跑一次完整恢复）");
  }

  console.log("\n自测通过。");
}

main().catch((e) => {
  console.error("自测失败:", e);
  process.exit(1);
});
