/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 用量统计 · Qoder / Qoder CN 口径自测（离线、沙箱，不碰真实库与真实转录）
//
// 覆盖 2026-10-30 修复的口径问题：
//   ① Qoder 系官方模型额度点按固定率折算进 token 总量（1 credit ≈ 22,000 token；Antigravity 不折算）
//   ② 无 token 明细时命中率返回 null（前端显示 -，而不是伪造 0%）
//   ③ Qoder 转录递归采集 subagents（新版客户端把子代理转录写在 <会话>/subagents/ 下）
//   ④ Anthropic usage 归一：input 只含新鲜输入，入库补入 cache_read + cache_creation
// 另验证 10→11 存量迁移只执行一次（重复开库不二次累加）。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/usage-qoder-selftest.cjs
//   （需要 node:sqlite；scripts/run-all-tests.cjs 会自动选 electron）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-selftest-"));
process.on("exit", () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

let pass = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? `（实测 ${JSON.stringify(extra)}）` : ""}`); }
}

// ===== 一、db 聚合口径（临时库，覆盖 dbPath）=====
console.log("\n① 聚合口径：Qoder 额度按固定率折算进 token 总量 / 无 token 明细时命中率为 null");
const cfg = require(path.join(ROOT, "electron", "backend", "sync-config.cjs"));
const dbFile = path.join(WORK, "test.sqlite");
cfg.dbPath = () => dbFile;
const db = require(path.join(ROOT, "electron", "backend", "db.cjs"));
const { DatabaseSync } = require("node:sqlite");
const now = Date.now();
db.get();
db.upsertDevice("dev", "本机", "qoder,qoder-cn,zcode", now);
db.insertRecords([
  // Qoder 官方模型：本地 token 全 0，只有 credits
  ...[0, 1, 2].map((i) => ({
    id: `dev:qoder:q${i}`, deviceId: "dev", deviceName: "本机", source: "qoder",
    providerId: "Qoder", modelId: "qfmodel", inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, credits: 0.5, startedAt: now - i * 1000, status: "success",
  })),
  // Qoder CN BYOK：新口径（input 已含 cache_read 40 + cache_creation 10）
  {
    id: "dev:qoder-cn:cn1", deviceId: "dev", deviceName: "本机", source: "qoder-cn",
    providerId: "DeepSeek", modelId: "deepseek-v4-pro", inputTokens: 150, outputTokens: 20, reasoningTokens: 0,
    cacheCreationTokens: 10, cacheReadTokens: 40, startedAt: now - 10 * 1000, status: "success",
  },
  // 普通源（full 口径额外含推理 50）
  {
    id: "dev:zcode:z1", deviceId: "dev", deviceName: "本机", source: "zcode",
    providerId: "GLM", modelId: "glm-5", inputTokens: 2000, outputTokens: 200, reasoningTokens: 50,
    cacheCreationTokens: 0, cacheReadTokens: 800, startedAt: now - 20 * 1000, status: "success",
  },
]);
{
  const all = db.getSummary("full");
  // Qoder 3×0.5 = 1.5 credits → 1.5 × 22,000 = 33,000 折算 token；2420 + 33,000 = 35,420
  ok(all.totalTokens === 35420, "全部 totalTokens = token 之和 + Qoder 额度折算（35,420）", all.totalTokens);
  ok(Math.abs(all.credits - 1.5) < 1e-9, "credits 独立汇总（1.5）", all.credits);
  ok(Math.abs(all.cacheHitRate - (840 / 2150)) < 1e-9, "命中率 = 缓存读 / 总输入（840/2150，折算不进分母）", all.cacheHitRate);
  const q = db.getSummary("full", null, "qoder");
  ok(q.totalTokens === 33000, "Qoder：1.5 点额度按 22,000 折算 → 33,000", q.totalTokens);
  ok(q.cacheHitRate === null && q.todayCacheHitRate === null, "Qoder：命中率为 null（前端显示 -）", [q.cacheHitRate, q.todayCacheHitRate]);
  ok(Math.abs(q.credits - 1.5) < 1e-9, "Qoder：额度单独返回（1.5）", q.credits);
  ok(q.recordCount === 3, "Qoder：记录数 3", q.recordCount);
  const cn = db.getSummary("full", null, "qoder-cn");
  ok(cn.totalTokens === 170, "Qoder CN：token 真实（150+20，无额度折算）", cn.totalTokens);
  ok(Math.abs(cn.cacheHitRate - 40 / 150) < 1e-9, "Qoder CN：命中率 40/150", cn.cacheHitRate);
  const trend = db.getTrend("full", 7);
  ok(trend.reduce((s, r) => s + r.total, 0) === 35420, "trend total 含额度折算（35,420）", trend.map((r) => r.total));
  const heat = db.getHeatmap("full", "2000-01-01", "2100-01-01");
  ok(heat.reduce((s, r) => s + r.total, 0) === 35420, "heatmap total 含额度折算（35,420）", heat.map((r) => r.total));
  ok(Math.abs(heat.reduce((s, r) => s + (r.credits || 0), 0) - 1.5) < 1e-9, "heatmap 单独带 credits（1.5）", heat.map((r) => r.credits));
  const agg = db.getAggregate("full", "source", null, null);
  const qRow = agg.find((r) => r.key === "qoder");
  ok(!!qRow && qRow.totalTokens === 33000 && Math.abs(qRow.credits - 1.5) < 1e-9, "aggregate：qoder total=33,000 且 credits=1.5", qRow);
  const bd = db.getDeviceBreakdowns("dev", "full");
  ok(!!bd[0] && bd[0].totalTokens === 35420 && Math.abs(bd[0].credits - 1.5) < 1e-9, "deviceBreakdowns 口径一致", bd[0]);
  const devs = db.getDevices("dev", "full");
  ok(!!devs[0] && devs[0].totalTokens === 35420, "getDevices 口径一致", devs[0]);
}

// ===== 二、10→11 存量迁移（补入缓存桶，且只执行一次）=====
console.log("\n② 10→11 迁移：Qoder 历史行补入 cache_read/cache_creation，重复开库不二次累加");
db.close();
{
  const raw = new DatabaseSync(dbFile);
  raw.exec("PRAGMA user_version = 10");
  raw.prepare("UPDATE usage_record SET input_tokens = 100 WHERE id = 'dev:qoder-cn:cn1'").run();
  raw.close();
}
db.get(); // 触发迁移
{
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  const row = raw.prepare("SELECT input_tokens i FROM usage_record WHERE id = 'dev:qoder-cn:cn1'").get();
  ok(row.i === 150, "迁移后 input = 100 + 40 + 10 = 150", row.i);
  ok(raw.prepare("PRAGMA user_version").get().user_version === 11, "user_version 推进到 11");
  raw.close();
}
db.close();
db.get(); // 再开一次：不得重复累加
{
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  ok(raw.prepare("SELECT input_tokens i FROM usage_record WHERE id = 'dev:qoder-cn:cn1'").get().i === 150, "重复开库仍为 150（迁移幂等）");
  raw.close();
}
db.close();

// ===== 三、适配器：递归 subagents + Anthropic usage 归一 =====
console.log("\n③ Qoder 适配器：递归采集 subagents / input 补入缓存桶");
const qoder = require(path.join(ROOT, "electron", "backend", "adapter-qoder.cjs"));
const qoderCn = require(path.join(ROOT, "electron", "backend", "adapter-qoder-cn.cjs"));
{
  const home = path.join(WORK, "qoder-home");
  const proj = path.join(home, "projects", "P1");
  fs.mkdirSync(path.join(proj, "S1", "subagents"), { recursive: true });
  const line = (uuid, ts, usage) => JSON.stringify({
    type: "assistant", uuid, timestamp: ts, sessionId: "S1", entrypoint: "cli",
    message: { model: "qfmodel", stop_reason: "end_turn", usage },
  }) + "\n";
  fs.writeFileSync(path.join(proj, "S1.jsonl"), line("u-top", "2026-10-29T00:00:00.000Z", {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, credits: 0.5,
  }));
  fs.writeFileSync(path.join(proj, "S1", "subagents", "agent-a.jsonl"), line("u-sub", "2026-10-29T00:01:00.000Z", {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, credits: 0.25,
  }));
  // BYOK：Anthropic 语义 —— input 100 是新鲜输入，缓存读写另列
  fs.writeFileSync(path.join(proj, "S1", "subagents", "agent-b.jsonl"), JSON.stringify({
    type: "assistant", uuid: "u-byok", timestamp: "2026-10-29T00:02:00.000Z", sessionId: "S1", entrypoint: "cli",
    message: { model: "qoder-custom-abc/deepseek-v4-pro", stop_reason: "end_turn", usage: {
      input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 40,
    } },
  }) + "\n");

  process.env.QODER_DATA_HOME = home;
  process.env.QODERCN_DATA_HOME = home;
  const det = qoder.detect();
  ok(det === path.resolve(home), "夹具目录被 detect 命中", det);
  const recs = qoder.extract(det, "dev", "本机", 0);
  ok(recs.length === 3, "递归采集顶层 + subagents 共 3 条", recs.map((r) => r.id));
  ok(Math.abs(recs.reduce((s, r) => s + (r.credits || 0), 0) - 0.75) < 1e-9, "子代理额度入账（0.5+0.25）", recs.map((r) => r.credits));
  const byok = recs.find((r) => r.id.endsWith("u-byok"));
  ok(!!byok && byok.inputTokens === 150, "BYOK input 补入缓存（100+10+40=150）", byok && byok.inputTokens);
  ok(!!byok && byok.cacheReadTokens === 40 && byok.cacheCreationTokens === 10, "缓存读写桶保留原值", byok && { cr: byok.cacheReadTokens, cc: byok.cacheCreationTokens });
  ok(!!byok && byok.modelId === "deepseek-v4-pro" && byok.providerId !== "Qoder", "BYOK 模型名取 / 后真名且供应商非 Qoder", byok && { model: byok.modelId, provider: byok.providerId });
  ok(!!byok && byok.cacheReadTokens / byok.inputTokens <= 1, "BYOK 命中率不超 100%", byok && byok.cacheReadTokens / byok.inputTokens);
  delete process.env.QODER_DATA_HOME;
  delete process.env.QODERCN_DATA_HOME;
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} Qoder 口径自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
