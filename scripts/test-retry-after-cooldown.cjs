// 429 冷却「墙钟/时长」口径回归自测：Retry-After 必须换算成绝对时刻再进 resetMs
// 运行：node scripts/test-retry-after-cooldown.cjs
// 只 require 纯函数，不启服务、不碰网络/磁盘
//
// 背景：classifyUpstream 曾把 parseRateResetMs（返回墙钟时刻）与 e.retryAfterMs
// （parseRetryAfterHeaders 返回的剩余时长）混装进同一个 resetMs，而消费端
// applyCool → pool.coolAccountMs(accId, until) 把它当绝对时刻用：
// coolUntil = Math.max(resetMs, now+1s)。Retry-After: 7200 → resetMs=7200000
// → Math.max 兜成 7200000（1970 年，早已过去）→ 2 小时冷却实际只有 1 秒，墙钟对齐失效。
"use strict";
const { classifyUpstream } = require("../electron/backend/proxy/server.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

async function main() {
  console.log("\n[1] 只有 Retry-After 头（最常见形态）→ 时长必须换算成绝对时刻");
  {
    const t0 = Date.now();
    const cls = classifyUpstream({ status: 429, message: "rate limited", retryAfterMs: 7200000 }, false);
    const t1 = Date.now();
    ok(cls.kind === "rate" && cls.resetMs > 0, `归类 rate 且 resetMs>0（实际 ${cls.resetMs}）`);
    ok(cls.resetMs >= t0 + 7200000 && cls.resetMs <= t1 + 7200000,
      `resetMs = now+7200s（实际偏移 ${cls.resetMs - t0}ms，期望 ≈7200000ms）`);
    // 回归钉子：旧实现返回裸时长 7200000 —— 比 1970 年之后的任何 now 都小，冷却立失效
    ok(cls.resetMs > Date.now() + 3600000, "resetMs 在未来（裸时长 7200000 必然落在过去）");
  }

  console.log("\n[2] 报文带「将在…重置」墙钟 → 墙钟优先，时长后备");
  {
    const wall = Date.parse("2099-01-01T08:00:00+08:00");
    const cls = classifyUpstream(
      { status: 429, message: `当前额度将在 2099-01-01 08:00 重置（code 1113）`, retryAfterMs: 7200000 },
      false,
    );
    ok(cls.resetMs === wall, `resetMs = 报文墙钟（实际 ${new Date(cls.resetMs).toISOString()}）`);
    const cls2 = classifyUpstream({ status: 429, message: "将在 2099-01-01 08:00 重置" }, false);
    ok(cls2.resetMs === wall, "无 Retry-Only 头时墙钟同样命中");
  }

  console.log("\n[3] 两者皆缺 → resetMs=0，交回 applyCool 的 softBackoff 兜底");
  {
    const cls = classifyUpstream({ status: 429, message: "too many requests" }, false);
    ok(cls.kind === "rate" && cls.resetMs === 0, `resetMs=0（实际 ${cls.resetMs}）`);
  }

  console.log("\n[4] 消费端口径抽查：coolAccountMs 的 Math.max 不再吞掉冷却");
  {
    const t0 = Date.now();
    const cls = classifyUpstream({ status: 429, message: "limited", retryAfterMs: 7200000 }, false);
    const coolUntil = Math.max(Number(cls.resetMs) || 0, Date.now() + 1000);
    ok(coolUntil >= t0 + 7200000 - 50, `coolUntil ≈ now+7200s（实际偏移 ${coolUntil - t0}ms）`);
  }

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("回归自测崩溃：", (e && e.stack) || e);
  process.exit(2);
});
