// WorkBuddy AI 数据源适配器（目录 ~/.workbuddy-ai，结构与 WorkBuddy 同构）
// 用量来源：~/.workbuddy-ai/projects/**/*.jsonl 会话转录（逐条 message.usage）
// 差异：无 device-id 文件（getDeviceId 返回 null，走 sync.cjs 回退链）；
//       projects 下项目目录名带会话启动时间戳（递归扫描天然兼容）。
// 统计口径见 adapter-workbuddy-common.cjs；接入依据见 docs/WorkBuddyAI数据源接入方案-2026-09-11.md
"use strict";
const { makeWorkBuddyAdapter } = require("./adapter-workbuddy-common.cjs");

module.exports = makeWorkBuddyAdapter("workbuddy-ai", "WorkBuddy AI", ".workbuddy-ai", "WORKBUDDY_AI_DATA_HOME");
