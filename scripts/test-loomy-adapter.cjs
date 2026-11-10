/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-06
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Loomy 数据源适配器口径自测（沙箱临时库，不碰真实 C:\Users\Public\Loomy）
// 运行：node scripts/test-loomy-adapter.cjs
//
// 守的几条口径（改坏任何一条都会让总量/命中率失真，而不是简单报错）：
//   1. input 含 cache.read（全系统基线），total = input + output + reasoning + cache.write；
//   2. 五桶全 0 / 非 assistant / data 损坏的行不进库；
//   3. providerID=imodel 归一到「Loomy」，自建供应商保留原文；
//   4. finish=error/aborted 落成 error/cancelled，其余 success；
//   5. since 锚点按 startedAt 过滤，id 幂等键含 messageId。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-loomy-test-"));
process.env.LOOMY_HOME = TMP;

const adapter = require("../electron/backend/adapter-loomy.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

/** 造一个 opencode 形态的最小库：只要 message 表（适配器只读这张） */
function buildDb() {
  const dir = path.join(TMP, "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`);
  const insert = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)");
  const T0 = 1793957000000;
  const rows = [
    // 正常轮次：input 100 + cache.read 300 应并成 400，total 435
    ["msg_ok", "ses_a", T0, T0 + 900, JSON.stringify({
      role: "assistant", mode: "loomy", agent: "loomy", variant: "high",
      providerID: "imodel", modelID: "GLM-5.3-Flash", finish: "stop",
      tokens: { total: 435, input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 10 } },
      time: { created: T0, completed: T0 + 900 },
    })],
    // 自建供应商：provider 保留原文
    ["msg_custom", "ses_a", T0 + 1000, T0 + 1500, JSON.stringify({
      role: "assistant", providerID: "my-provider", modelID: "deepseek-v4-pro",
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: T0 + 1000, completed: T0 + 1500 },
    })],
    // 失败轮次
    ["msg_err", "ses_a", T0 + 2000, T0 + 2100, JSON.stringify({
      role: "assistant", providerID: "imodel", modelID: "GLM-5.3-Flash", finish: "error", error: { name: "APIError" },
      tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: T0 + 2000 },
    })],
    ["msg_abort", "ses_a", T0 + 3000, T0 + 3100, JSON.stringify({
      role: "assistant", providerID: "imodel", modelID: "GLM-5.3-Flash", finish: "aborted",
      tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: T0 + 3000 },
    })],
    // 五桶全 0：不采集
    ["msg_zero", "ses_a", T0 + 4000, T0 + 4100, JSON.stringify({
      role: "assistant", providerID: "imodel", modelID: "GLM-5.3-Flash", finish: "stop",
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: T0 + 4000 },
    })],
    // 用户消息带 tokens：不采集
    ["msg_user", "ses_a", T0 + 5000, T0 + 5100, JSON.stringify({
      role: "user", tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: T0 + 5000 },
    })],
    // 半截 JSON：跳过不抛错
    ["msg_broken", "ses_a", T0 + 6000, T0 + 6100, '{"role":"assistant","tokens":{'],
    // 创建得早、结算得晚：锚点已越过 created，但 time_updated 仍在窗口内 → 必须补采
    ["msg_late", "ses_a", T0 - 60000, T0 + 7000, JSON.stringify({
      role: "assistant", providerID: "imodel", modelID: "GLM-5.3-Flash", finish: "stop",
      tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: T0 - 60000, completed: T0 + 7000 },
    })],
  ];
  for (const r of rows) insert.run(...r);
  db.close();
  return T0;
}

const T0 = buildDb();

console.log("Loomy 适配器口径自测");
ok(adapter.detect() === TMP, "detect 命中 LOOMY_HOME 沙箱");
ok(adapter.validate(TMP) === true, "validate 识别 opencode.db");
ok(adapter.getDeviceId(TMP) === null, "无安装 ID 时返回 null（交上层回退链）");

const recs = adapter.extract(TMP, "dev1", "测试机", 0);
ok(recs.length === 5, `只采集有消耗的 assistant 消息（实际 ${recs.length}）`);

const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
const okRec = byId["dev1:loomy:msg_ok"];
ok(!!okRec, "幂等键为 deviceId:loomy:messageId");
ok(okRec.inputTokens === 400, "input 并入 cache.read（100+300=400）");
ok(okRec.cacheReadTokens === 300 && okRec.cacheCreationTokens === 10, "缓存读/写分桶保留");
ok(okRec.inputTokens + okRec.outputTokens + okRec.reasoningTokens + okRec.cacheCreationTokens === 435, "五桶之和 = 源端 total");
ok(okRec.providerId === "Loomy", "providerID=imodel 归一到 Loomy");
ok(okRec.modelId === "glm-5.3-flash", "模型名走全项目 normalizeModel");
ok(okRec.mode === "loomy" && okRec.agent === "loomy" && okRec.variant === "high", "mode/agent/variant 保留");
ok(okRec.status === "success" && okRec.sessionId === "ses_a", "正常轮次状态与会话号");
ok(okRec.completedAt === T0 + 900 && okRec.startedAt === T0, "起止时间取 data.time");

ok(byId["dev1:loomy:msg_custom"].providerId === "my-provider", "自建供应商不冒充官方");
ok(byId["dev1:loomy:msg_err"].status === "error", "finish=error → error");
ok(byId["dev1:loomy:msg_abort"].status === "cancelled", "finish=aborted → cancelled");

const later = adapter.extract(TMP, "dev1", "测试机", T0 + 900);
ok(later.length === 4 && !later.some((r) => r.id.endsWith("msg_ok")), "since 锚点按 time_updated 过滤");
ok(later.some((r) => r.id.endsWith("msg_late")), "创建早、结算晚的轮次过锚点后仍补采");

// 数据库缺失时的行为：抛出带路径的错误，由 sync 层记日志跳过该源
process.env.LOOMY_HOME = path.join(TMP, "not-exists");
ok(adapter.detect() === null, "目录缺失时 detect 返回 null");
let threw = false;
try {
  adapter.extract(path.join(TMP, "not-exists"), "dev1", "测试机", 0);
} catch (e) {
  threw = /未找到 Loomy 数据库/.test(e.message);
}
ok(threw, "库缺失时 extract 报可读错误");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
