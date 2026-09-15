// WorkBuddy 数据源适配器
// 用量来源：~/.workbuddy/projects/**/*.jsonl 会话转录（逐条 message.usage）
// 设备标识：~/.workbuddy/device-id
// 统计口径与两源差异说明见 adapter-workbuddy-common.cjs
"use strict";
const { makeWorkBuddyAdapter } = require("./adapter-workbuddy-common.cjs");

module.exports = makeWorkBuddyAdapter("workbuddy", "WorkBuddy", ".workbuddy", "WORKBUDDY_DATA_HOME");
