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
// 旧路径兼容：翻译器已搬进标准层（localgw/standard/anthropic-translate.cjs）。
// 保留这一行 re-export，避免以后有人按旧路径引用时拿到第二份实现（两份实现必然漂移）；
// 标准层不得反向 require 本文件（scripts/test-standard-provider-isolation.cjs 会拦）。
"use strict";

module.exports = require("../localgw/standard/anthropic-translate.cjs");
