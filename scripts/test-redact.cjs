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
// 日志脱敏回归（审查整改 M9）：redact.cjs 四段正则（JWT / Bearer / 键值对 / 裸十六进制）
// 必须挡住四类凭据形态，同时不误伤正常错误文案。
// 这是「错误文本落 op_logs 与 Excel 导出」的唯一闸门，正则被改宽/改窄都必须在这里显形。
// 跑法：node scripts/test-redact.cjs
"use strict";
const path = require("node:path");
const { redact } = require(path.join(__dirname, "..", "electron", "backend", "proxy", "redact.cjs"));

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ""}`); }
}

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const cases = [
  // [输入, 必须包含的脱敏标记, 必须不残留的原文片段, 说明]
  [`failed: Bearer ${JWT}`, "<redacted-jwt>", JWT.slice(0, 30), "裸 JWT（eyJ 三段式）"],
  [`auth header: bearer abcdefghijklmnopqrstuvwxyz`, "<redacted>", "abcdefghijklmnopqrstuvwxyz", "Bearer 长串"],
  [`{"accessToken": "${JWT}"}`, "<redacted", JWT.slice(0, 20), "JSON 形态 accessToken"],
  [`refresh_token=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`, "<redacted>", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "snake_case refresh_token="],
  [`clientSecret: "supersecretvalue123456"`, "<redacted>", "supersecretvalue123456", "camelCase clientSecret"],
  [`authorization=0123456789abcdef0123`, "<redacted>", "0123456789abcdef0123", "authorization 键"],
  [`token 0123456789abcdef0123456789abcdef`, "<redacted>", "0123456789abcdef0123456789abcdef", "裸十六进制 token"],
  [`password: "hunter2hunter2"`, "<redacted>", "hunter2hunter2", "password 键"],
];

console.log("[1] 必须挡住四类凭据形态");
for (const [input, mustMark, mustNot, label] of cases) {
  const out = redact(input);
  ok(out.includes(mustMark), `${label}：输出含 ${mustMark}`, out);
  ok(!out.includes(mustNot), `${label}：原文片段已清除`, out);
}

console.log("\n[2] 不误伤正常错误文案");
const benign = [
  "上游 429：请求过于频繁，请稍后重试",
  "model not found: gpt-4o-mini",
  "token authentication failed（token 后无长串）",
  "余额不足，剩余 0.00 credits",
  "HTTP 403 request illegal / code 11140",
  "签到成功，获得 20 积分",
  "stream idle timeout (30s)",
];
for (const s of benign) {
  const out = redact(s);
  ok(out === s, `未被改动：${s.slice(0, 30)}`, out);
}

console.log("\n[3] 短值不打码（避免把版本号/长度数字抹掉）");
{
  const s = "token=abc123";
  ok(redact(s) === s, "短于 12 位的值不脱敏");
}

console.log("\n[4] 空值 / null / undefined 安全");
{
  ok(redact(null) === "", "null → 空串");
  ok(redact(undefined) === "", "undefined → 空串");
  ok(redact("") === "", "空串 → 空串");
}

console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
