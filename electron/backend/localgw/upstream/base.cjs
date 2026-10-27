/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 【已废弃 / 仅作占位】
// 本文件初版作为"localgw 渠道适配器基类"花费时间撰写，最终方案改为：转发完全委托给
// proxy/adapters.cjs 的成熟 chat()（与号池管理同源），localgw 只做调度壳，见 forwarder.cjs。
// 保留本文件是为了避免误引用：`upstream/base.cjs` 与 `upstream/index.cjs` 都不应再被使用。
// 若历史代码仍 require 本文件，请统一切到 require("../forwarder.cjs").forward。
"use strict";
module.exports = { deprecated: true, reason: "本模块已并入 forwarder.cjs / proxy/adapters.cjs，await forwarder.forward(...) 是现在的入口" };
