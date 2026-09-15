// TRAE SOLO CN 数据源适配器
// 用量来源：%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\database.db（SQLCipher，chat_turn.context.token_usage）
// 统计口径与解密细节见 adapter-trae-common.cjs
"use strict";
const { makeTraeAdapter } = require("./adapter-trae-common.cjs");

module.exports = makeTraeAdapter("trae-solo-cn", "TRAE SOLO CN", "TRAE SOLO CN", "TRAESOLOCN_DATA_HOME");
