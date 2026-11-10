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
// 数据源适配器注册表
// 所有已支持数据源的统一注册表
"use strict";
const zcode = require("./adapter-zcode.cjs");
const raccoon = require("./adapter-raccoon.cjs");
const mimo = require("./adapter-mimo.cjs");
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
const autoclaw = require("./adapter-autoclaw.cjs");
const loomy = require("./adapter-loomy.cjs");

const sources = [zcode, raccoon, mimo, codex, dsh, workbuddy, workbuddyAi, reasonix, codebuddy, qoder, qoderCn, antigravity, antigravityIde, antigravityLegacy, trae, traeCn, traeSolo, traeSoloCn, opensquilla, grok, autoclaw, loomy];

function byId(id) {
  return sources.find((s) => s.id === id);
}

module.exports = { sources, byId };
