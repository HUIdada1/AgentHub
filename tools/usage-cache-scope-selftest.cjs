/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-04
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 用量统计 · 缓存命中率口径自测（离线、沙箱，不碰真实库）
//
// 覆盖 2026-11-04 需求：商汤小浣熊这类「本地取不到缓存拆分」的源
//   ① 命中率不再伪造 0%：该源单独查看时 cacheHitRate / todayCacheHitRate 为 null（前端显示「-」）
//   ② 不计入「全部」平均：分子分母只算「缓存口径可得」的源，小浣熊的 input 不稀释整体命中率
//   ③ getTrend / getHeatmap / getDeviceBreakdowns 三处展示同一口径（总览页命中率曲线、点日期弹窗、设备卡）
//   ④ 判定来自数据而非写死源 id：该源日后能解析出缓存时自动恢复参与（写路径失效后立即生效）
//
// 跑法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/usage-cache-scope-selftest.cjs
//   （需要 node:sqlite；scripts/run-all-tests.cjs 会自动选 electron）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cache-scope-"));
process.on("exit", () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

let pass = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? `（实测 ${JSON.stringify(extra)}）` : ""}`); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

const cfg = require(path.join(ROOT, "electron", "backend", "sync-config.cjs"));
cfg.dbPath = () => path.join(WORK, "test.sqlite");
const db = require(path.join(ROOT, "electron", "backend", "db.cjs"));

const now = Date.now();
const YESTERDAY = now - 86400000;
db.get();
db.upsertDevice("dev", "本机", "raccoon,zcode", now);

const rec = (o) => ({
  deviceId: "dev", deviceName: "本机", reasoningTokens: 0, cacheCreationTokens: 0, status: "success", ...o,
});
db.insertRecords([
  // 小浣熊（raccoon）：本地只有 prompt/completion，缓存拆分恒 0 —— 命中率「取不到」
  rec({ id: "dev:raccoon:r1", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, startedAt: now - 1000 }),
  // 历史行同样恒 0：全期判定要能覆盖历史，别只看今天
  rec({ id: "dev:raccoon:r0", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, startedAt: YESTERDAY }),
  // 正常可统计的源：真实命中 100/200
  rec({ id: "dev:zcode:z1", source: "zcode", providerId: "GLM", modelId: "glm-5", inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, startedAt: now - 2000 }),
]);

console.log("\n① getSummary：全部平均排除小浣熊 / 单源小浣熊命中率为 null");
{
  const all = db.getSummary("compact");
  ok(all.cacheHitRate !== null && near(all.cacheHitRate, 100 / 200), "全部命中率 = 100/200（小浣熊 1500 input 不进分母）", all.cacheHitRate);
  ok(all.cacheStatsAvailable === true, "全部：cacheStatsAvailable = true（存在可统计的源）", all.cacheStatsAvailable);
  ok(all.inputTokens === 200 && all.cacheReadTokens === 100, "全部：命中率口径分子/分母只含可统计源", [all.inputTokens, all.cacheReadTokens]);
  ok(all.totalTokens === 1820, "全部：token 总量仍含小浣熊（1000+100 + 500 + 200+20），口径不误伤总量", all.totalTokens);
  ok(all.recordCount === 3, "全部：记录数 3", all.recordCount);

  const racc = db.getSummary("compact", null, "raccoon");
  ok(racc.cacheHitRate === null, "单源小浣熊：总计命中率 null（前端显示 -，不再是 0%）", racc.cacheHitRate);
  ok(racc.todayCacheHitRate === null, "单源小浣熊：今日命中率 null", racc.todayCacheHitRate);
  ok(racc.cacheStatsAvailable === false, "单源小浣熊：cacheStatsAvailable = false（前端可区分文案）", racc.cacheStatsAvailable);
  ok(racc.recordCount === 2 && racc.inputTokens === 0, "单源小浣熊：记录数/总量保留真实值，仅命中率口径为 0", [racc.recordCount, racc.inputTokens]);

  const z = db.getSummary("compact", null, "zcode");
  ok(z.cacheHitRate !== null && near(z.cacheHitRate, 0.5), "单源 zcode：命中率如实 100/200", z.cacheHitRate);
  ok(z.cacheStatsAvailable === true, "单源 zcode：cacheStatsAvailable = true", z.cacheStatsAvailable);
}

console.log("\n② getTrend：全部视图排除小浣熊；小浣熊独占的日期命中率断点（null）");
{
  const t = db.getTrend("compact", 7);
  const today = t[t.length - 1];
  ok(today.cacheHitRate !== null && near(today.cacheHitRate, 0.5), "趋势今天：命中率 100/200（小浣熊不计入）", today.cacheHitRate);
  ok(today.inputTokens === 1200, "趋势今天：inputTokens 仍是真实总量（含小浣熊 1000）", today.inputTokens);
  const y = t.find((r) => r.date !== today.date);
  ok(!!y && y.cacheHitRate === null, "趋势昨天（只有小浣熊）：命中率 null → 曲线断点", y && y.cacheHitRate);

  const tr = db.getTrend("compact", 7, null, "raccoon");
  ok(tr.every((r) => r.cacheHitRate === null), "单源小浣熊趋势：所有点 null（不画 0% 曲线）", tr.map((r) => r.cacheHitRate));
}

console.log("\n③ getHeatmap：行内 cacheHitRate 与总览同口径（DayModal 直接读，不再前端自算 0%）");
{
  const h = db.getHeatmap("compact", "2000-01-01", "2100-01-01");
  const today = h[h.length - 1];
  ok(today.cacheHitRate !== null && near(today.cacheHitRate, 0.5), "热力图今天：cacheHitRate = 0.5", today.cacheHitRate);
  const y = h.find((r) => r.date !== today.date);
  ok(!!y && y.cacheHitRate === null, "热力图昨天（只有小浣熊）：cacheHitRate null", y && y.cacheHitRate);
  const hr = db.getHeatmap("compact", "2000-01-01", "2100-01-01", null, "raccoon");
  ok(hr.every((r) => r.cacheHitRate === null), "单源小浣熊热力图：所有日期 null", hr.map((r) => r.cacheHitRate));
}

console.log("\n④ getDeviceBreakdowns：设备卡命中率同口径");
{
  const bd = db.getDeviceBreakdowns("dev", "compact");
  ok(!!bd[0] && bd[0].cacheHitRate !== null && near(bd[0].cacheHitRate, 0.5), "设备卡命中率 100/200（排小浣熊）", bd[0] && bd[0].cacheHitRate);
  const br = db.getDeviceBreakdowns("dev", "compact", null, "raccoon");
  ok(!!br[0] && br[0].cacheHitRate === null, "单源小浣熊：设备卡命中率 null", br[0] && br[0].cacheHitRate);
}

console.log("\n⑤ 数据判定自适应：小浣熊日后能解析出缓存 → 写路径失效后自动恢复参与");
{
  db.insertRecords([
    rec({ id: "dev:raccoon:r2", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 50, outputTokens: 0, cacheReadTokens: 20, startedAt: now - 500 }),
  ]);
  const racc = db.getSummary("compact", null, "raccoon");
  ok(racc.cacheHitRate !== null && near(racc.cacheHitRate, 20 / 1550), "小浣熊出现缓存数据后：命中率按真实值 20/1550 计算", racc.cacheHitRate);
  ok(racc.cacheStatsAvailable === true, "小浣熊出现缓存数据后：cacheStatsAvailable = true", racc.cacheStatsAvailable);
  const all = db.getSummary("compact");
  ok(all.cacheHitRate !== null && near(all.cacheHitRate, 120 / 1750), "全部命中率随之纳入小浣熊：(100+20)/(200+1550)", all.cacheHitRate);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} 缓存命中率口径自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
