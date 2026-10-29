/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// MonkeyCode 协议层的排障日志：只在显式打开调试开关（环境变量 MONKEYCODE_DEBUG=1）时输出。
// 口径与号池其它渠道一致：只打元数据（任务 id、事件类型、正文长度），**不落 prompt 与工具参数正文**。
"use strict";

function enabled() {
  const v = process.env.MONKEYCODE_DEBUG;
  return !!v && v !== "0" && v !== "false";
}

function verbose(message) {
  if (!enabled()) return;
  try {
    console.log(`[MonkeyCode] ${message}`);
  } catch {
    /* 控制台不可用（打包后无 stdout）时静默 */
  }
}

module.exports = { verbose, enabled };
