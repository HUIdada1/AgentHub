/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 用量统计增强自测：区间归一 / 粒度决策 / KPI 与序列 / 富字段排行 / 各 Key 用量 /
// 状态分桶 / Token 构成 / 明细模糊搜索与筛选汇总。
// 跑法：node scripts/test-proxy-stats.cjs
//   （store.cjs 优先用 node:sqlite；老版本 node 没有它时用
//     ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-proxy-stats.cjs）
// 纯临时沙箱（APPDATA / AGENT_SKILLS_HOME 指到 mkdtemp），不碰真实 stats.db、不联网、不起窗口。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-stats-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));
// 断言抛出时结尾的清理跑不到：库句柄留在进程里，父进程等管道会等不到头
process.on("exit", () => { try { store.close(); } catch { /* 报错退出，关不掉不影响结论 */ } });

let pass = 0, failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
function eq(actual, expect, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  ok(a === e, `${name}（实测 ${a}，期望 ${e}）`);
}

// 前置：新增导出没落地时报一条干净的红并退出——基线上跑这份自测能看到它在管真事
const API = ["normRange", "pickGranularity", "statsOverview", "statsSummary", "statsSeries", "statsTopRich", "statsKeys", "statsStatus", "statsTokenMix"];
const missing = API.filter((n) => typeof store[n] !== "function");
ok(missing.length === 0, `新增聚合面全部导出（缺：${missing.join(" ") || "无"}）`);
if (missing.length) { console.log("\nFAIL 统计自测：导出缺失，后续断言无从谈起"); process.exit(1); }

const DAY = 86400000;
const NOW = Date.now();
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// 数据落在「今天已经过去」的时段：原先固定写今天中午，上午/凌晨跑时会被「今天区间到 NOW」整段挡掉，
// 导致今日 4 条全部查不到（历史偶发红）。改成 NOW 往前 3 小时、且不早于今天 0 点 1 分，全天任意时刻都成立。
const T0 = Math.max(dayStart(NOW) + 60 * 1000, NOW - 3 * 3600000);
const TODAY_FROM = dayStart(NOW);
const TODAY_TO = NOW;

function put(o) {
  store.insertUsage({
    ts: o.ts == null ? T0 : o.ts,
    reqId: o.reqId || "r",
    keyId: o.keyId || "",
    keyName: o.keyName || "",
    channel: o.channel || "",
    accountId: o.accountId || "",
    accountName: o.accountName || "",
    model: o.model || "",
    promptTokens: o.promptTokens || 0,
    completionTokens: o.completionTokens || 0,
    cacheReadTokens: o.cacheReadTokens || 0,
    cacheCreationTokens: o.cacheCreationTokens || 0,
    ttftMs: o.ttftMs || 0,
    latencyMs: o.latencyMs || 0,
    status: o.status == null ? 200 : o.status,
    error: o.error || "",
  });
}

// ===== 夹具：今天 4 条（3 成功 + 1 个 429）、3 天前 1 条、10 天前 1 条 500 =====
put({ reqId: "a1", keyId: "k1", keyName: "主 Key", channel: "trae", accountId: "acc1", accountName: "主号", model: "m1", promptTokens: 100, completionTokens: 50, cacheReadTokens: 40, ttftMs: 100, latencyMs: 300 });
put({ reqId: "a2", keyId: "k1", keyName: "主 Key", channel: "trae", accountId: "acc1", accountName: "主号", model: "m1", promptTokens: 200, completionTokens: 80, ttftMs: 200, latencyMs: 500 });
put({ reqId: "a3", keyId: "k2", keyName: "备用 Key", channel: "workbuddy", accountId: "acc2", accountName: "备用号", model: "m2", promptTokens: 300, completionTokens: 120, ttftMs: 300, latencyMs: 700 });
put({ reqId: "a4", keyId: "k2", keyName: "备用 Key", channel: "workbuddy", accountId: "acc2", accountName: "备用号", model: "m2", promptTokens: 10, completionTokens: 0, status: 429, error: "rate limited" });
put({ reqId: "b1", ts: T0 - 3 * DAY, keyId: "k1", keyName: "主 Key", channel: "trae", accountId: "acc1", accountName: "主号", model: "m1", promptTokens: 1000, completionTokens: 400, ttftMs: 900, latencyMs: 1500 });
put({ reqId: "c1", ts: T0 - 10 * DAY, keyId: "k3", keyName: "老 Key", channel: "raccoon", accountId: "acc3", accountName: "老号", model: "m3", promptTokens: 5000, completionTokens: 2000, status: 500, error: "boom" });

// ===== ① 区间归一与粒度决策 =====
console.log("\n① 区间归一 / 粒度决策");
{
  const d = store.normRange(undefined, undefined);
  ok(Math.abs(d.to - d.from - 7 * DAY) < 2000, `缺省区间 = 近 7 天（实测跨度 ${Math.round((d.to - d.from) / DAY)} 天）`);
  const swap = store.normRange(TODAY_TO, TODAY_FROM);
  ok(swap.from === TODAY_FROM && swap.to === TODAY_TO, "from/to 颠倒时自动交换");
  const cap = store.normRange(NOW - 1000 * DAY, NOW);
  ok(Math.abs(cap.to - cap.from - 366 * DAY) < 2000, `超长区间封顶 366 天（实测 ${Math.round((cap.to - cap.from) / DAY)} 天）`);
  eq(store.pickGranularity(TODAY_FROM, TODAY_TO, "auto"), "hour", "auto：当天跨度 → 按小时");
  eq(store.pickGranularity(NOW - 7 * DAY, NOW, "auto"), "day", "auto：7 天跨度 → 按天");
  eq(store.pickGranularity(NOW - 10 * DAY, NOW, "hour"), "day", "显式要小时但跨度 10 天 → 回落按天（防桶爆炸）");
}

// ===== ② 区间 KPI：四类 token 分列、成功率、P50 =====
console.log("\n② 区间 KPI（statsSummary）");
{
  const s = store.statsSummary(TODAY_FROM, TODAY_TO);
  eq([s.req, s.ok, s.err, s.successRate], [4, 3, 1, 75], "今日请求 / 成功 / 失败 / 成功率");
  eq([s.promptTokens, s.completionTokens], [610, 250], "输入 / 输出 token 分列（缓存读是输入的子集，不进总量）");
  eq(s.totalTokens, 860, "总 token = 输入 + 输出");
  eq(s.cacheReadTokens, 40, "缓存读单独计量");
  eq(s.ttftP50, 200, "TTFT 中位数（100/200/300 三个样本取中位 200）");
  eq([s.channels, s.models, s.keys, s.accounts], [2, 2, 2, 2], "覆盖的去重渠道 / 模型 / Key / 账号数");
  const empty = store.statsSummary(NOW - 500 * DAY, NOW - 400 * DAY);
  eq([empty.req, empty.totalTokens, empty.successRate], [0, 0, 100], "空区间回全 0，成功率兜底 100");
}

// ===== ③ 时间序列：补零 + 粒度 =====
console.log("\n③ 时间序列（statsSeries）");
{
  const hour = store.statsOverview({ from: TODAY_FROM, to: TODAY_TO }).range;
  eq(hour.granularity, "hour", "总览：当天区间回按小时");
  const pts = store.statsSeries(TODAY_FROM, TODAY_TO, "hour");
  ok(pts.length >= new Date(NOW).getHours() + 1, `小时桶数合理（实测 ${pts.length} 个桶）`);
  eq(pts.reduce((a, p) => a + p.req, 0), 4, "小时序列请求数合计 = 今日 4 条（补零不影响合计）");
  const hh = String(new Date(T0).getHours()).padStart(2, "0");
  const hourBucket = pts.find((p) => p.label.endsWith(`${hh}:00`));
  ok(!!hourBucket && hourBucket.req === 4, "数据所在小时桶含全部 4 条请求（数据落在桶内，不是序列末桶）");
  const day7 = store.statsSeries(NOW - 6 * DAY, NOW, "day");
  eq(day7.length, 7, "7 天区间 → 7 个日桶（缺数日期补零）");
  eq(day7.reduce((a, p) => a + p.req, 0), 5, "7 天序列合计 = 今日 4 + 3 天前 1（10 天前那条被区间挡住）");
}

// ===== ④ 富字段排行：请求/响应 token 分列 =====
console.log("\n④ TOP 排行（statsTopRich）");
{
  const ch = store.statsTopRich("channel", TODAY_FROM, TODAY_TO);
  const trae = ch.find((r) => r.name === "trae");
  const wb = ch.find((r) => r.name === "workbuddy");
  eq([trae.req, trae.promptTokens, trae.completionTokens, trae.tokens], [2, 300, 130, 430], "trae：请求 / 请求 token / 响应 token / 总 token");
  eq([wb.req, wb.ok, wb.err, wb.successRate], [2, 1, 1, 50], "workbuddy：成功失败拆分与成功率");
  ok(ch.every((r) => r.name !== ""), "空渠道名的行被过滤");
  const models = store.statsTopRich("model", NOW - 30 * DAY, NOW);
  ok(models.some((m) => m.name === "m3"), "30 天区间能捞到 10 天前的模型 m3");
  const models7 = store.statsTopRich("model", NOW - 6 * DAY, NOW);
  ok(!models7.some((m) => m.name === "m3"), "7 天区间捞不到 10 天前的 m3（区间隔离生效）");
}

// ===== ⑤ 各 Key 用量 =====
console.log("\n⑤ 各 Key 用量（statsKeys）");
{
  const keys = store.statsKeys(TODAY_FROM, TODAY_TO);
  eq(keys.length, 2, "今日两把 Key");
  const k1 = keys.find((k) => k.keyId === "k1");
  eq([k1.name, k1.req, k1.tokens, k1.successRate], ["主 Key", 2, 430, 100], "k1：名称 / 请求 / 总 token / 成功率");
  ok(k1.lastTs > 0, "k1 带最近使用时间");
  eq(store.statsKeys(NOW - 30 * DAY, NOW).length, 3, "30 天区间三把 Key");
}

// ===== ⑥ 状态分桶与 Token 构成 =====
console.log("\n⑥ 状态分桶 / Token 构成");
{
  const st = store.statsStatus(TODAY_FROM, TODAY_TO);
  const m = Object.fromEntries(st.map((x) => [x.key, x.value]));
  eq([m.ok, m["4xx"], m["5xx"], m.other], [3, 1, 0, 0], "今日：成功 3 / 4xx 1 / 5xx 0 / 无响应 0");
  const st30 = Object.fromEntries(store.statsStatus(NOW - 30 * DAY, NOW).map((x) => [x.key, x.value]));
  eq([st30.ok, st30["4xx"], st30["5xx"]], [4, 1, 1], "30 天：500 落进 5xx 桶");
  const mix = store.statsTokenMix(TODAY_FROM, TODAY_TO);
  eq(mix.map((x) => [x.key, x.value]), [["prompt", 610], ["completion", 250]], "Token 构成 = 输入 / 输出两个互斥分量");
}

// ===== ⑦ 明细：模糊搜索 / 状态筛选 / 区间 / 筛选汇总 =====
console.log("\n⑦ 请求明细（statsDetail）");
{
  const all = store.statsDetail({ from: NOW - 30 * DAY, to: NOW, page: 1, pageSize: 50 });
  eq(all.total, 6, "30 天区间全部 6 条");
  eq([all.agg.req, all.agg.promptTokens, all.agg.completionTokens, all.agg.tokens], [6, 6610, 2650, 9260], "筛选汇总口径与行一致");

  const byKeyName = store.statsDetail({ from: NOW - 30 * DAY, to: NOW, key: "主" });
  eq(byKeyName.total, 3, "Key 名模糊搜索「主」命中 3 条（含 3 天前那条）");
  const byKeyId = store.statsDetail({ from: NOW - 30 * DAY, to: NOW, key: "k3" });
  eq(byKeyId.total, 1, "Key 搜索同时匹配 keyId（k3 命中 1 条）");
  const byModel = store.statsDetail({ from: NOW - 30 * DAY, to: NOW, model: "m2" });
  eq(byModel.total, 2, "模型模糊搜索「m2」命中 2 条");
  const byChannel = store.statsDetail({ from: NOW - 30 * DAY, to: NOW, channel: "workbuddy" });
  eq(byChannel.total, 2, "渠道精确筛选命中 2 条");
  eq(store.statsDetail({ from: NOW - 30 * DAY, to: NOW, status: "ok" }).total, 4, "状态桶 ok 命中 4 条");
  eq(store.statsDetail({ from: NOW - 30 * DAY, to: NOW, status: "4xx" }).total, 1, "状态桶 4xx 命中 1 条");
  eq(store.statsDetail({ from: NOW - 30 * DAY, to: NOW, status: "5xx" }).total, 1, "状态桶 5xx 命中 1 条");
  // LIKE 转义：用户敲一个 % 不能变成「匹配全表」
  eq(store.statsDetail({ from: NOW - 30 * DAY, to: NOW, key: "%" }).total, 0, "搜索里的 % 被转义成字面量（不命中全表）");
  eq(store.statsDetail({ from: NOW - 30 * DAY, to: NOW, key: "_" }).total, 0, "搜索里的 _ 被转义成字面量");
  // 分页（pageSize 有最小 5 的夹取：传 5 才是 5）
  const p2 = store.statsDetail({ from: NOW - 30 * DAY, to: NOW, page: 2, pageSize: 5 });
  eq([p2.total, p2.pageSize, p2.rows.length], [6, 5, 1], "分页：第 2 页拿余下 1 条");
  eq(store.statsDetail({ from: NOW - 30 * DAY, to: NOW, page: 1, pageSize: 1 }).pageSize, 5, "pageSize 下探被夹到最小值 5");
  // 区间隔离
  eq(store.statsDetail({ from: TODAY_FROM, to: TODAY_TO }).total, 4, "今日区间只剩 4 条");
  eq(store.statsDetail({ from: NOW - 6 * DAY, to: NOW }).total, 5, "7 天区间 5 条");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} 统计自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
