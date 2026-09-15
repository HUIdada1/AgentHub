// Qoder CN 数据源适配器（中国版，目录 ~/.qoder-cn，结构与国际版同构）
// 用量来源：~/.qoder-cn/projects/**/*.jsonl 会话转录，统计口径见 adapter-qoder-common.cjs
"use strict";
const { makeQoderAdapter } = require("./adapter-qoder-common.cjs");

module.exports = makeQoderAdapter("qoder-cn", "Qoder CN", ".qoder-cn", "QODERCN_DATA_HOME");
