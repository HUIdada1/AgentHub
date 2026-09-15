// Qoder 数据源适配器（国际版）
// 用量来源：~/.qoder/projects/**/*.jsonl 会话转录，统计口径见 adapter-qoder-common.cjs
"use strict";
const { makeQoderAdapter } = require("./adapter-qoder-common.cjs");

module.exports = makeQoderAdapter("qoder", "Qoder", ".qoder", "QODER_DATA_HOME");
