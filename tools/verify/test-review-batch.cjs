/**
 * 自动化测试：待确认收件箱各队列与全局一键推荐处理验证
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const reviewPanelPath = path.join(__dirname, "../../src/components/memory/MemReviewPanel.vue");
const content = fs.readFileSync(reviewPanelPath, "utf8");

console.log("1. 验证方法定义存在性...");
assert.ok(content.includes("async function batchConfirmSupersede()"), "应当包含 batchConfirmSupersede 方法");
assert.ok(content.includes("async function batchConfirmClassify()"), "应当包含 batchConfirmClassify 方法");
assert.ok(content.includes("async function batchConfirmDedup()"), "应当包含 batchConfirmDedup 方法");
assert.ok(content.includes("async function batchConfirmAll()"), "应当包含 batchConfirmAll 方法");
console.log("   ✓ 四个批量处理函数定义完备");

console.log("2. 验证推荐动作逻辑与 API 调用对齐...");
// 事实失效推荐: confirm
assert.ok(content.includes('api.memoryReviewResolve(item.id, "confirm")'), "事实失效推荐动作必须是 confirm");
// 项目归类推荐: assign
assert.ok(content.includes('api.memoryReviewResolve(item.id, slug ? "assign" : "dismiss"'), "项目归类推荐动作必须是 assign/dismiss");
// 记忆去重推荐: adoptNew
assert.ok(content.includes('api.memoryDedupReviewResolve(item.id, "adoptNew")'), "记忆去重推荐动作必须是 adoptNew");
console.log("   ✓ 各队列推荐动作与后端接口完全匹配");

console.log("3. 验证模板按钮挂载...");
assert.ok(content.includes("@click=\"batchConfirmSupersede\""), "模板中应挂载 batchConfirmSupersede 按钮");
assert.ok(content.includes("@click=\"batchConfirmClassify\""), "模板中应挂载 batchConfirmClassify 按钮");
assert.ok(content.includes("@click=\"batchConfirmDedup\""), "模板中应挂载 batchConfirmDedup 按钮");
assert.ok(content.includes("@click=\"batchConfirmAll\""), "模板中应挂载 batchConfirmAll 按钮");
console.log("   ✓ 三个队列与总头部的一键推荐按钮全部挂载就绪");

console.log("4. 验证编码与闭合性...");
assert.ok(content.includes("一键推荐确认失效"), "文案应包含一键推荐确认失效且无乱码");
assert.ok(content.includes("一键推荐确认归入"), "文案应包含一键推荐确认归入且无乱码");
assert.ok(content.includes("一键推荐采纳新记忆"), "文案应包含一键推荐采纳新记忆且无乱码");
assert.ok(content.includes("一键推荐处理全部"), "文案应包含一键推荐处理全部且无乱码");
console.log("   ✓ UTF-8 中文编码完好");

console.log("\n[PASS] MemReviewPanel 一键推荐处理自动化测试全部通过！");
