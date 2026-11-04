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
//   ⑤ 今日口径独立：全期可得但今天只有小浣熊时，todayCacheStatsAvailable=false（文案不能说「今日无 token 明细」）
//   ⑥ creation-only 源视为「缓存口径可得」：显示真实 0%（不是「-」），且参与全部平均
//   ⑦ 边界：空库 / 无记录设备 LEFT JOIN / source+device 双过滤不抛错、不返回脏数据
//   ⑧ 真实总量字段不被命中率口径污染（inputTokens/cacheReadTokens 仍是真值）
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

// 每个场景独立库：db 模块是单例，close() 后换 dbPath 再 get() 即可重开
let dbFile = path.join(WORK, "main.sqlite");
const cfg = require(path.join(ROOT, "electron", "backend", "sync-config.cjs"));
cfg.dbPath = () => dbFile;
const db = require(path.join(ROOT, "electron", "backend", "db.cjs"));

const now = Date.now();
const YESTERDAY = now - 86400000;
const rec = (o) => ({
  deviceId: "dev", deviceName: "本机", reasoningTokens: 0, cacheCreationTokens: 0, status: "success", ...o,
});

// ===== 库 1：主场景 =====
console.log("\n① getSummary：全部平均排除小浣熊 / 单源小浣熊命中率为 null / 真实总量不被口径污染");
db.get();
db.upsertDevice("dev", "本机", "raccoon,zcode", now);
db.insertRecords([
  // 小浣熊（raccoon）：本地只有 prompt/completion，缓存拆分恒 0 —— 命中率「取不到」
  rec({ id: "dev:raccoon:r1", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, startedAt: now - 1000 }),
  // 历史行同样恒 0：全期判定要能覆盖历史，别只看今天
  rec({ id: "dev:raccoon:r0", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, startedAt: YESTERDAY }),
  // 正常可统计的源：真实命中 100/200
  rec({ id: "dev:zcode:z1", source: "zcode", providerId: "GLM", modelId: "glm-5", inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, startedAt: now - 2000 }),
]);
{
  const all = db.getSummary("compact");
  ok(all.cacheHitRate !== null && near(all.cacheHitRate, 100 / 200), "全部命中率 = 100/200（小浣熊 1500 input 不进分母）", all.cacheHitRate);
  ok(all.cacheStatsAvailable === true, "全部：cacheStatsAvailable = true", all.cacheStatsAvailable);
  ok(all.todayCacheStatsAvailable === true, "全部：todayCacheStatsAvailable = true", all.todayCacheStatsAvailable);
  ok(all.cacheInputTokens === 200 && all.cacheReadTokens === 100, "全部：口径分子/分母只含可统计源", [all.cacheInputTokens, all.cacheReadTokens]);
  ok(all.inputTokens === 1700, "全部：inputTokens 仍是真实总量（含小浣熊 1500）", all.inputTokens);
  ok(all.todayInputTokens === 1200 && all.todayCacheInputTokens === 200, "全部：今日真实/口径输入分开给", [all.todayInputTokens, all.todayCacheInputTokens]);
  ok(all.totalTokens === 1820, "全部：token 总量仍含小浣熊，口径不误伤总量", all.totalTokens);
  ok(all.recordCount === 3, "全部：记录数 3", all.recordCount);

  const racc = db.getSummary("compact", null, "raccoon");
  ok(racc.cacheHitRate === null, "单源小浣熊：总计命中率 null（前端显示 -，不再是 0%）", racc.cacheHitRate);
  ok(racc.todayCacheHitRate === null, "单源小浣熊：今日命中率 null", racc.todayCacheHitRate);
  ok(racc.cacheStatsAvailable === false, "单源小浣熊：cacheStatsAvailable = false（前端可区分文案）", racc.cacheStatsAvailable);
  ok(racc.todayCacheStatsAvailable === false, "单源小浣熊：todayCacheStatsAvailable = false", racc.todayCacheStatsAvailable);
  ok(racc.recordCount === 2 && racc.inputTokens === 1500, "单源小浣熊：记录数/真实总量保留", [racc.recordCount, racc.inputTokens]);
  ok(racc.cacheInputTokens === 0, "单源小浣熊：口径分母 0", racc.cacheInputTokens);

  const z = db.getSummary("compact", null, "zcode");
  ok(z.cacheHitRate !== null && near(z.cacheHitRate, 0.5), "单源 zcode：命中率如实 100/200", z.cacheHitRate);
  ok(z.cacheStatsAvailable === true, "单源 zcode：cacheStatsAvailable = true", z.cacheStatsAvailable);
}

console.log("\n② getTrend / getHeatmap / getDeviceBreakdowns：四处同口径，真实分项保留");
{
  const t = db.getTrend("compact", 7);
  const today = t[t.length - 1];
  ok(today.cacheHitRate !== null && near(today.cacheHitRate, 0.5), "趋势今天：命中率 100/200（小浣熊不计入）", today.cacheHitRate);
  ok(today.inputTokens === 1200, "趋势今天：inputTokens 仍是真实总量（含小浣熊 1000）", today.inputTokens);
  const y = t.find((r) => r.date !== today.date);
  ok(!!y && y.cacheHitRate === null, "趋势昨天（只有小浣熊）：命中率 null → 曲线断点", y && y.cacheHitRate);

  const tr = db.getTrend("compact", 7, null, "raccoon");
  ok(tr.every((r) => r.cacheHitRate === null), "单源小浣熊趋势：所有点 null（不画 0% 曲线）", tr.map((r) => r.cacheHitRate));

  const h = db.getHeatmap("compact", "2000-01-01", "2100-01-01");
  const ht = h[h.length - 1];
  ok(ht.cacheHitRate !== null && near(ht.cacheHitRate, 0.5), "热力图今天：cacheHitRate = 0.5", ht.cacheHitRate);
  ok(ht.inputTokens === 1200 && ht.cacheInputTokens === 200, "热力图：真实 input 与口径分母分开给", [ht.inputTokens, ht.cacheInputTokens]);
  ok(!("cacheRead" in ht) && !("cacheInput" in ht), "热力图：内部口径列不漏进 IPC 契约", Object.keys(ht));
  const hy = h.find((r) => r.date !== ht.date);
  ok(!!hy && hy.cacheHitRate === null, "热力图昨天（只有小浣熊）：cacheHitRate null", hy && hy.cacheHitRate);
  const hr = db.getHeatmap("compact", "2000-01-01", "2100-01-01", null, "raccoon");
  ok(hr.every((r) => r.cacheHitRate === null), "单源小浣熊热力图：所有日期 null", hr.map((r) => r.cacheHitRate));

  const bd = db.getDeviceBreakdowns("dev", "compact");
  ok(!!bd[0] && bd[0].cacheHitRate !== null && near(bd[0].cacheHitRate, 0.5), "设备卡命中率 100/200（排小浣熊）", bd[0] && bd[0].cacheHitRate);
  ok(!!bd[0] && bd[0].inputTokens === 1700 && bd[0].cacheInputTokens === 200, "设备卡：真实 input（1700）与口径分母（200）分开", bd[0] && [bd[0].inputTokens, bd[0].cacheInputTokens]);
  const br = db.getDeviceBreakdowns("dev", "compact", null, "raccoon");
  ok(!!br[0] && br[0].cacheHitRate === null, "单源小浣熊：设备卡命中率 null", br[0] && br[0].cacheHitRate);
  // source + device 双过滤（参数顺序易错点）
  const both = db.getDeviceBreakdowns("dev", "compact", "dev", "zcode");
  ok(!!both[0] && both[0].inputTokens === 200 && near(both[0].cacheHitRate, 0.5), "source+device 双过滤：zcode 设备卡 200 / 0.5", both[0] && [both[0].inputTokens, both[0].cacheHitRate]);
  const bothR = db.getDeviceBreakdowns("dev", "compact", "dev", "raccoon");
  ok(!!bothR[0] && bothR[0].inputTokens === 1500 && bothR[0].cacheHitRate === null, "source+device 双过滤：raccoon 设备卡 1500 / null", bothR[0] && [bothR[0].inputTokens, bothR[0].cacheHitRate]);
}

console.log("\n③ 数据判定自适应：小浣熊日后能解析出缓存 → 写路径失效后自动恢复参与");
{
  db.insertRecords([
    rec({ id: "dev:raccoon:r2", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 50, outputTokens: 0, cacheReadTokens: 20, startedAt: now - 500 }),
  ]);
  const racc = db.getSummary("compact", null, "raccoon");
  ok(racc.cacheHitRate !== null && near(racc.cacheHitRate, 20 / 1550), "小浣熊出现缓存数据后：命中率按真实值 20/1550 计算", racc.cacheHitRate);
  ok(racc.cacheStatsAvailable === true, "小浣熊出现缓存数据后：cacheStatsAvailable = true", racc.cacheStatsAvailable);
  const all = db.getSummary("compact");
  ok(all.cacheHitRate !== null && near(all.cacheHitRate, 120 / 1750), "全部命中率随之纳入小浣熊：(100+20)/(200+1550)", all.cacheHitRate);
  ok(all.cacheInputTokens === 1750, "全部口径分母 = 200 + 1550（历史 0 缓存行一并进分母，符合注释）", all.cacheInputTokens);
  // 删除设备后：聚合与「不可得源集合」都必须失效重算
  db.deleteDeviceData("dev");
  const afterDel = db.getSummary("compact");
  ok(afterDel.recordCount === 0 && afterDel.cacheHitRate === null && afterDel.cacheStatsAvailable === false, "deleteDeviceData 后：汇总归零且缓存口径集合重算", [afterDel.recordCount, afterDel.cacheHitRate, afterDel.cacheStatsAvailable]);
}
db.close();

// ===== 库 2：全期可得 / 今日不可得（今日文案必须分开判断）=====
console.log("\n④ 今日口径独立：昨天 zcode（有缓存）、今天只有小浣熊");
{
  dbFile = path.join(WORK, "today-mixed.sqlite");
  db.get();
  db.upsertDevice("dev2", "本机", "zcode,raccoon", now);
  db.insertRecords([
    rec({ id: "dev2:zcode:z0", source: "zcode", providerId: "GLM", modelId: "glm-5", inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, startedAt: YESTERDAY }),
    rec({ id: "dev2:raccoon:r1", source: "raccoon", providerId: "商汤", modelId: "raccoon-chat", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, startedAt: now - 1000 }),
  ]);
  const s = db.getSummary("compact");
  ok(s.cacheStatsAvailable === true && s.cacheHitRate !== null && near(s.cacheHitRate, 0.5), "全期：可得（昨天 zcode），命中率 100/200", [s.cacheStatsAvailable, s.cacheHitRate]);
  ok(s.todayCacheStatsAvailable === false && s.todayCacheHitRate === null, "今日：不可得 → 命中率 null 且 todayCacheStatsAvailable=false", [s.todayCacheStatsAvailable, s.todayCacheHitRate]);
  const heatToday = db.getHeatmap("compact", "2000-01-01", "2100-01-01");
  ok(heatToday[heatToday.length - 1].cacheHitRate === null, "今日热力图：只有小浣熊 → 命中率 null", heatToday[heatToday.length - 1].cacheHitRate);
  db.close();
}

// ===== 库 3：creation-only 源视为可得（显示真实 0%，参与平均）=====
console.log("\n⑤ creation-only 源：缓存字段可解析 → 真实 0% 命中率，且参与全部平均");
{
  dbFile = path.join(WORK, "creation-only.sqlite");
  db.get();
  db.upsertDevice("dev3", "本机", "a,b", now);
  db.insertRecords([
    rec({ id: "dev3:a:1", deviceId: "dev3", source: "a-read", providerId: "P", modelId: "m", inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, startedAt: now - 1000 }),
    rec({ id: "dev3:b:1", deviceId: "dev3", source: "b-create", providerId: "P", modelId: "m", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 10, startedAt: now - 2000 }),
  ]);
  const all = db.getSummary("compact");
  ok(all.cacheStatsAvailable === true, "creation-only 源：cacheStatsAvailable = true", all.cacheStatsAvailable);
  ok(all.cacheHitRate !== null && near(all.cacheHitRate, 50 / 200), "全部命中率 = 50/200（creation-only 源计入分母，显示真实 0%）", all.cacheHitRate);
  const b = db.getSummary("compact", null, "b-create");
  ok(b.cacheHitRate === 0 && b.cacheStatsAvailable === true, "单源 creation-only：显示真实 0%（不是「-」）", [b.cacheHitRate, b.cacheStatsAvailable]);
  db.close();
}

// ===== 库 4：空库 / 无记录设备（LEFT JOIN）=====
console.log("\n⑥ 边界：空库与无记录设备不抛错、不返回脏数据");
{
  dbFile = path.join(WORK, "empty.sqlite");
  db.get();
  db.upsertDevice("empty-dev", "空机", "", now);
  const s = db.getSummary("compact");
  ok(s.recordCount === 0 && s.cacheHitRate === null, "空库：summary 全空且命中率 null", [s.recordCount, s.cacheHitRate]);
  ok(s.cacheStatsAvailable === false && s.todayCacheStatsAvailable === false, "空库：两个 available 均为 false", [s.cacheStatsAvailable, s.todayCacheStatsAvailable]);
  ok(Array.isArray(db.getDeviceBreakdowns("empty-dev", "compact")) && db.getDeviceBreakdowns("empty-dev", "compact").length === 0, "无记录设备：deviceBreakdowns = []（LEFT JOIN 空行被过滤）");
  ok(db.getTrend("compact", 7).length === 0, "空库：trend = []");
  ok(db.getHeatmap("compact", "2000-01-01", "2100-01-01").length === 0, "空库：heatmap = []");
  db.close();
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} 缓存命中率口径自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
