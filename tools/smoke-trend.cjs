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
// getTrend 冒烟：多天模式（含 cacheHitRate）+ 单日按小时模式（24 点补齐）
"use strict";
const db = require("../electron/backend/db.cjs");

function show(tag, rows) {
  console.log(`[${tag}] rows=${rows.length}`);
  const withData = rows.filter((r) => r.total > 0);
  console.log(`  非空点=${withData.length}`, JSON.stringify(withData.slice(0, 2)));
  // null 是合法值（该时段无缓存口径数据：取不到缓存拆分的源，或窗口内无 token 明细）
  const bad = rows.filter((r) => !(r.cacheHitRate === null || (typeof r.cacheHitRate === "number" && !Number.isNaN(r.cacheHitRate))));
  console.log(`  cacheHitRate 异常点=${bad.length}`);
}

const multi = db.getTrend("local", 7, null, null, null);
show("多天-7d", multi);

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const single = db.getTrend("local", 1, null, null, today);
console.log(`[单日 ${today}] rows=${single.length}（应为 24）`);
show("单日", single);
console.log("  首尾点 date:", single[0]?.date, "/", single[23]?.date);

// 空天（很久以前）也应补齐 24 点且全 0
const empty = db.getTrend("local", 1, null, null, "2020-01-01");
console.log(`[空天 2020-01-01] rows=${empty.length} 全零=${empty.every((r) => r.total === 0)}`);
