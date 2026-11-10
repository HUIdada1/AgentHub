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
// Shared management API envelope validation; no model response conversion.
"use strict";
const CatPawError = require("./errors.cjs");



/** `unwrapApiData`：`code` 可转成数值且不是 0/200 → 上游错误；有 `data` 成员则取出。
 *
 *  code 的判定口径：按**数值**判定（`Number(code)`），不按类型区分——原实现是 JS 严格比较
 *  （字符串 `"0"` 不等于数字 `0`，于是 `"0"` 会被误判成错误），上游改成「非数字 → 继续」。
 *  这里取两者的折中：字符串形态的数字按数值判定（`"0"` 成功、`"500"` 如实报错）。
 *  理由——上游若真回了字符串业务码，当成功放行会把一次失败伪装成正常流（客户端拿到空内容
 *  却记成 200），如实报错更安全；而畸形 code（完全非数字）走「继续」，不误伤正常流 */
function unwrapApiData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const code = value.code;
  if (code !== undefined && code !== null) {
    const codeNumber = Number(code);
    if (Number.isFinite(codeNumber) && codeNumber !== 0 && codeNumber !== 200) {
      const message = String(value.msg || value.message || "").trim() || `上游 API 返回错误 code=${codeNumber}`;
      const status = Number(value.httpStatus) || 502;
      throw new CatPawError(status >= 100 && status < 600 ? status : 502, message, {
        code: codeNumber,
        unifyCode: Number.isFinite(Number(value.unifyCode)) ? Number(value.unifyCode) : null,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "data")) return value.data;
  return value;
}
module.exports = { unwrapApiData };
