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

// ===== hasConsumableDelta：与 Aggregator.pushDelta 同口径的"已出线"判据 =====
console.log("\nhasConsumableDelta:");
const H = util.hasConsumableDelta;
ok("噪声帧不算出线", H(noise) === false, noise);
ok("纯思考算出线（防换号重发拼接正文）", H({ reasoning_content: "The" }) === true);
ok("空串思考不算出线", H({ reasoning_content: "" }) === false);
ok("空串正文不算出线", H({ content: "" }) === false);
ok("非空 tool_calls 算出线", H({ tool_calls: [{ index: 0 }] }) === true);
ok("空 tool_calls 不算出线", H({ tool_calls: [] }) === false);
// 上游私有的非空扩展字段：清洗后仍留有键，但聚合器消费不了，不得判成已出线
ok("非空扩展字段不算出线", H({ extra_fields: {} }) === false, { extra_fields: {} });
ok("null 输入 → false", H(null) === false);
// legacy function_call：噪声态恒为 null/空串（被 false 过滤），但旧协议兼容通道若真有
// {name, arguments} 对象输出，必须算出线——否则流中失败换号重发，客户端收到「半截旧调用 + 完整新调用」拼接
ok("legacy function_call 对象算出线（防换号拼接）", H({ function_call: { name: "get_weather", arguments: '{"city":"北京"}' } }) === true);
ok("legacy function_call:null 不算出线", H({ function_call: null }) === false);
ok("legacy function_call 空串名不算出线", H({ function_call: { name: "", arguments: "" } }) === false);

// ===== 真实 WorkBuddy 帧序列回放（2026-09-21 从 9527 实抓，非构造样本）=====
// 上游每个正文/思考片段后都夹一个全空噪声帧，这正是 Qoder 逐段换行的来源。
console.log("\n真实帧序列回放:");
const NOISE = { function_call: null, refusal: "", tool_calls: [], extra_fields: null };
const realStream = [
  { role: "assistant", function_call: null, refusal: "", tool_calls: [], extra_fields: null },
  { reasoning_content: "The" }, { ...NOISE },
  { reasoning_content: " user" }, { ...NOISE },
  { reasoning_content: " greeted" }, { ...NOISE },
  { reasoning_content: " me" }, { ...NOISE },
  { content: "你好" }, { ...NOISE },
  { content: "！" }, { ...NOISE },
  { content: "很高兴" }, { ...NOISE },
  { content: "见到" }, { ...NOISE },
  { content: "你" }, { ...NOISE },
];
// 模拟 emit 的出线决策：清洗后仍有键才 write；reasoning 帧走合批缓冲不算 write
let emitted = 0, sentDeltaHits = 0;
const outText = [];
for (const raw of realStream) {
  const rest = util.stripEmptyDelta(raw);
  delete rest.reasoning_content;
  if (util.hasConsumableDelta(raw)) sentDeltaHits++;
  if (Object.keys(rest).length) { emitted++; outText.push(rest.content || ""); }
}
ok("19 帧中 9 帧含可消费内容（4 思考 + 5 正文）", sentDeltaHits === 9, sentDeltaHits);
ok("19 帧仅 5 帧触发正文 write（噪声与思考帧各归其位）", emitted === 5, emitted);
ok("回放未丢正文", outText.filter(Boolean).join("") === "你好！很高兴见到你", outText.join(""));

// ===== Aggregator：tool_calls 空壳守卫与正常增量合并 =====
console.log("\nAggregator.pushDelta:");
const msgOf = (a) => a.result().choices[0].message;

const g1 = new util.Aggregator("r", "m");
g1.pushDelta({ tool_calls: [{}] });
ok("全空分片不建条目", g1.result().choices[0].message.tool_calls === undefined, msgOf(g1));

const g2 = new util.Aggregator("r", "m");
g2.pushDelta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] });
g2.pushDelta({ tool_calls: [{ index: 0, function: { arguments: '{"city":"上海"}' } }] });
const t2 = msgOf(g2).tool_calls;
ok("首片+增量片完整合并", !!t2 && t2.length === 1 && t2[0].function.name === "get_weather"
  && t2[0].function.arguments === '{"city":"上海"}', t2);

const g3 = new util.Aggregator("r", "m");
g3.pushDelta({ tool_calls: [{ index: 0, id: "c1", function: { name: "f" } }] });
g3.pushDelta({ tool_calls: [{}] });
const t3 = msgOf(g3).tool_calls;
ok("已建条目后的空片不破坏已有值", t3.length === 1 && t3[0].function.name === "f", t3);

const g4 = new util.Aggregator("r", "m");
g4.pushDelta({ tool_calls: [null, "x", { index: 0, function: { arguments: "{}" } }] });
const t4 = msgOf(g4).tool_calls;
ok("非法元素跳过、合法片保留", !!t4 && t4.length === 1 && t4[0].function.arguments === "{}", t4);

// 只带 arguments 的分片是合法增量（首片可能只有 id），不得被守卫误杀
const g5 = new util.Aggregator("r", "m");
g5.pushDelta({ tool_calls: [{ index: 0, id: "c9", function: { arguments: "a" } }] });
ok("arguments-only 分片仍建条目", msgOf(g5).tool_calls.length === 1, msgOf(g5));

// 正文与思考链聚合不受守卫改动影响
const g6 = new util.Aggregator("r", "m");
g6.pushDelta({ content: "你" }); g6.pushDelta({ content: "好" });
g6.pushDelta({ reasoning_content: "因为" });
ok("正文/思考聚合正常", msgOf(g6).content === "你好" && msgOf(g6).reasoning_content === "因为", msgOf(g6));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
