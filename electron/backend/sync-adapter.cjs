// 数据源适配器注册表
// 所有已支持数据源的统一注册表
"use strict";
const zcode = require("./adapter-zcode.cjs");
const raccoon = require("./adapter-raccoon.cjs");
const codex = require("./adapter-codex.cjs");
const dsh = require("./adapter-dsh.cjs");
const workbuddy = require("./adapter-workbuddy.cjs");
const workbuddyAi = require("./adapter-workbuddy-ai.cjs");
const reasonix = require("./adapter-reasonix.cjs");
const codebuddy = require("./adapter-codebuddy.cjs");
const qoder = require("./adapter-qoder.cjs");
const qoderCn = require("./adapter-qoder-cn.cjs");
const antigravity = require("./adapter-antigravity.cjs");
const antigravityIde = require("./adapter-antigravity-ide.cjs");
const antigravityLegacy = require("./adapter-antigravity-legacy.cjs");
const trae = require("./adapter-trae.cjs");
const traeCn = require("./adapter-trae-cn.cjs");
const traeSoloCn = require("./adapter-trae-solo-cn.cjs");
const traeSolo = require("./adapter-trae-solo.cjs");
const opensquilla = require("./adapter-opensquilla.cjs");
const grok = require("./adapter-grok.cjs");

const sources = [zcode, raccoon, codex, dsh, workbuddy, workbuddyAi, reasonix, codebuddy, qoder, qoderCn, antigravity, antigravityIde, antigravityLegacy, trae, traeCn, traeSolo, traeSoloCn, opensquilla, grok];

function byId(id) {
  return sources.find((s) => s.id === id);
}

module.exports = { sources, byId };
