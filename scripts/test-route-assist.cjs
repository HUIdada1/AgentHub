/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 选路辅助回归（route-assist.cjs）：
//   · 请求需求解析：tools / images / video 的三种载体（顶层 tools、tool_calls、内容块）；
//   · 能力匹配：声明 true 通过、false 拒绝、未声明也拒绝（要用户先确认）；
//   · 失败动作：额度类记垫底、5xx/超时记退避、出口问题与取消不罚账号；
//   · 原因映射：号池中文原因 → 计划状态码；
//   · 粘性开关：默认 auto；没有模型时不生成会话键。
//
// 跑法：node scripts/test-route-assist.cjs
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-route-assist-"));

const assist = require("../electron/backend/localgw/route-assist.cjs");

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  passed++;
  console.log(`PASS ${name}`);
}

check("需求：顶层 tools 数组 → 需要工具调用", () => {
  const needs = assist.requestNeeds({ tools: [{ type: "function" }], messages: [] });
  assert.equal(needs.tools, true);
  assert.equal(assist.hasNeeds(needs), true);
});

check("需求：消息里的 tool_calls / role=tool → 需要工具调用", () => {
  assert.equal(assist.requestNeeds({ messages: [{ role: "assistant", tool_calls: [{ id: "1" }] }] }).tools, true);
  assert.equal(assist.requestNeeds({ messages: [{ role: "tool", content: "ok" }] }).tools, true);
});

check("需求：内容块里的图片与视频分别识别", () => {
  const images = assist.requestNeeds({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] });
  const video = assist.requestNeeds({ messages: [{ role: "user", content: [{ type: "input_video", video_url: "x" }] }] });
  assert.equal(images.images, true);
  assert.equal(images.video, false);
  assert.equal(video.video, true);
});

check("需求：纯文本请求三项全假", () => {
  const needs = assist.requestNeeds({ messages: [{ role: "user", content: "你好" }] });
  assert.deepEqual(needs, { tools: false, images: false, video: false });
  assert.equal(assist.hasNeeds(needs), false);
});

check("能力：true 通过、false 拒绝、未声明也拒绝", () => {
  assert.equal(assist.supportsBinding({ capabilities: { tools: true } }, { tools: true }), true);
  assert.equal(assist.supportsBinding({ capabilities: { tools: false } }, { tools: true }), false);
  assert.equal(assist.supportsBinding({ capabilities: {} }, { tools: true }), false);
  assert.equal(assist.supportsBinding({}, { tools: false, images: false, video: false }), true);
});

check("失败动作：额度类垫底，5xx/超时退避，出口与取消不罚", () => {
  assert.equal(assist.failureAction("rate", "account"), "sunk");
  assert.equal(assist.failureAction("quota", "account"), "sunk");
  assert.equal(assist.failureAction("credit", "account"), "sunk");
  assert.equal(assist.failureAction("server", "account"), "rest");
  assert.equal(assist.failureAction("timeout", "account"), "rest");
  assert.equal(assist.failureAction("timeout", "egress"), "none");
  assert.equal(assist.failureAction("not_found", "account-model"), "none");
  assert.equal(assist.failureAction("cancelled", "invocation"), "none");
});

check("原因映射：号池中文原因 → 计划状态码", () => {
  assert.equal(assist.reasonState("本轮已尝试"), "tried");
  assert.equal(assist.reasonState("账号非在线状态"), "offline");
  assert.equal(assist.reasonState("缺少凭据"), "no-credentials");
  assert.equal(assist.reasonState("余额耗尽"), "exhausted");
  assert.equal(assist.reasonState("余额已过期"), "expired");
  assert.equal(assist.reasonState("该账号模型冷却中"), "cooldown");
  assert.equal(assist.reasonState("账号并发已满"), "concurrency");
  assert.equal(assist.reasonState("别的原因"), "blocked");
});

check("粘性：默认 auto；空模型不生成会话键", () => {
  assert.equal(assist.stickyMode(), "auto");
  assert.equal(assist.stickyKeyFor({ model: "" }, {}), "");
  const key = assist.stickyKeyFor({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }, {});
  assert.equal(typeof key, "string");
  assert.equal(key.length, 32);
});

console.log(`\n${passed} 项全部通过`);
