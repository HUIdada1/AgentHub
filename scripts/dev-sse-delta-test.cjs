// 反代网关 SSE 噪声帧清洗自测：node scripts/dev-sse-delta-test.cjs
// 用 mktemp 造库，不碰真实数据；纯函数断言，无需上游网络。
"use strict";
const util = require("../electron/backend/proxy/util.cjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}

const S = util.stripEmptyDelta;

console.log("stripEmptyDelta:");

// 1. WorkBuddy 上游实测噪声帧（每片都带）应被整体清空
const noise = { role: "assistant", function_call: null, refusal: "", tool_calls: [], extra_fields: null };
ok("全空噪声帧 → {}", Object.keys(S(noise)).length === 0, S(noise));

// 2. 重复 role 必须剔除（首包由 server 统一发出，后续 role 会造成客户端分段）
ok("仅 role 的帧 → {}", Object.keys(S({ role: "assistant" })).length === 0, S({ role: "assistant" }));

// 3. 真实正文不得被误删
ok("保留 content", S({ content: "你好", refusal: "" }).content === "你好", S({ content: "你好", refusal: "" }));
ok("保留空串正文以外的 content（含 \\n）", S({ content: "\n\n" }).content === "\n\n", S({ content: "\n\n" }));
ok("保留 reasoning_content", S({ reasoning_content: "The" }).reasoning_content === "The", S({ reasoning_content: "The" }));

// 4. 非空 tool_calls 分片必须原样保留（多轮工具调用的增量）
const tcs = [{ index: 0, id: "c1", type: "function", function: { arguments: "{\"a\":1}" } }];
ok("保留非空 tool_calls", JSON.stringify(S({ tool_calls: tcs }).tool_calls) === JSON.stringify(tcs), S({ tool_calls: tcs }));

// 5. 噪声与真实字段混合：只留真实的
const mixed = S({ role: "assistant", content: "hi", function_call: null, refusal: "", tool_calls: [], extra_fields: null });
ok("混合帧只留 content", JSON.stringify(mixed) === JSON.stringify({ content: "hi" }), mixed);

// 6. 0 / false 这类合法假值不得当空删掉
ok("保留数字 0", S({ index: 0 }).index === 0, S({ index: 0 }));
ok("保留布尔 false", S({ flag: false }).flag === false, S({ flag: false }));

// 7. 边界：非对象输入不抛异常
ok("null 输入 → {}", Object.keys(S(null)).length === 0, S(null));
ok("undefined 输入 → {}", Object.keys(S(undefined)).length === 0, S(undefined));

// 8. 不得改动入参（emit 里 rest 与 d 共享引用，污染会影响聚合）
const orig = { content: "x", refusal: "", role: "assistant" };
S(orig);
ok("入参未被就地修改", JSON.stringify(orig) === JSON.stringify({ content: "x", refusal: "", role: "assistant" }), orig);

// 9. chunk() 产出的 SSE 帧结构仍合法
const frame = util.chunk("rid", "m1", { content: "你好" });
const payload = JSON.parse(frame.replace(/^data: /, "").replace(/\n\n$/, ""));
ok("chunk 仍为合法 OpenAI SSE", payload.choices[0].delta.content === "你好" && payload.choices[0].index === 0, payload);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
