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
// 出站指纹脱敏（proxy/sanitize.cjs）回归自测：纯函数、不联网、不碰任何真实数据。
// 断言口径对应 sanitize.cjs 注释里写明的实测行为：
//   · 预检大小写敏感、混合大小写表头由裸键名正则兜底；
//   · 改写层只换一个词、保留原有标点；
//   · 表头键值整段删除，残留裸键名做最小缩写；
//   · cc_ 键值循环清理（相邻键值清理后会暴露下一个）；
//   · 11128 一律改写为 11-128，相邻的 11148 / 11101 / 11115 / 99999 放行；
//   · 一个字节都没改时 sanitizeBody 返回 null（调用方据此零拷贝沿用原始 body）。
"use strict";
const sanitize = require("../electron/backend/proxy/sanitize.cjs");

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; return; }
  fails.push(name);
}
function eq(name, actual, expected) {
  if (actual === expected) { pass++; return; }
  fails.push(`${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
}

// ===== 1. 预检 =====
ok("预检：命中 11128", sanitize.hasFingerprint("错误码 11128"));
ok("预检：命中身份句前缀", sanitize.hasFingerprint("You are Claude Code, Anthropic's official"));
ok("预检：命中 cc_entrypoint=", sanitize.hasFingerprint("cc_entrypoint=cli;"));
ok("预检：命中反馈句链接", sanitize.hasFingerprint("see https://github.com/anthropics/claude-code/issues"));
ok("预检：混合大小写表头（裸键名兜底）", sanitize.hasFingerprint("X-Anthropic-Billing-Header"));
ok("预检：普通文本不命中", !sanitize.hasFingerprint("帮我写一个快速排序"));
ok("预检：空串不命中", !sanitize.hasFingerprint(""));
ok("预检：非字符串不命中", !sanitize.hasFingerprint(null));

// ===== 2. 改写层：只换一个词、保留标点 =====
{
  const hits = new Map();
  const out = sanitize.sanitizeText("You are Claude Code, Anthropic's official CLI for Claude.", hits);
  eq("身份句（CLI 版带句号）", out, "You are Claude Code, Anthropic's official CLI tool for Claude.");
}
{
  const hits = new Map();
  const out = sanitize.sanitizeText("You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", hits);
  eq("身份句（桌面版接逗号）", out, "You are Claude Code, Anthropic's official CLI tool for Claude, running within the Claude Agent SDK.");
}
{
  const hits = new Map();
  const out = sanitize.sanitizeText("Main branch (you will usually use this for PRs)", hits);
  eq("注入指令句", out, "Default branch (you will usually use this for PRs)");
}
{
  const hits = new Map();
  const out = sanitize.sanitizeText("You are a coding agent running in the Codex CLI, a terminal-based coding assistant.", hits);
  eq("Codex 首段", out, "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.");
}
{
  const hits = new Map();
  const out = sanitize.sanitizeText("To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues", hits);
  eq("反馈句 give→provide", out, "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues");
}

// ===== 3. 11128 数字指纹 =====
eq("裸 11128 → 11-128", sanitize.sanitizeText("code=11128", new Map()), "code=11-128");
eq("错误码 11128 中文上下文", sanitize.sanitizeText("错误码 11128 出现了", new Map()), "错误码 11-128 出现了");
eq("相邻 11148 放行", sanitize.sanitizeText("11148", new Map()), "11148");
eq("相邻 11101 放行", sanitize.sanitizeText("11101", new Map()), "11101");
eq("相邻 11115 放行", sanitize.sanitizeText("11115", new Map()), "11115");
eq("相邻 99999 放行", sanitize.sanitizeText("99999", new Map()), "99999");
eq("11128 前后缀不误伤（111280 不含裸 11128？）", sanitize.sanitizeText("111280", new Map()), "11-1280");

// ===== 4. 表头剥离 + 裸键名缩写 =====
{
  const out = sanitize.sanitizeText("x-anthropic-billing-header: abc; def", new Map());
  eq("表头键值整段删除（分号后的残留文本保留）", out, "def");
}
{
  const out = sanitize.sanitizeText("前缀 X-Anthropic-Billing-Header: v=1; 后缀", new Map());
  eq("混合大小写表头删除", out, "前缀 后缀");
}
{
  const out = sanitize.sanitizeText("引用 `x-anthropic-billing-header` 这个键名", new Map());
  eq("裸键名最小缩写", out, "引用 `x-anthropic-billing-hdr` 这个键名");
}

// ===== 5. cc_ 键值循环清理 =====
{
  const out = sanitize.sanitizeText("cc_version=1.0.0; cc_entrypoint=cli;", new Map());
  eq("连续 cc_ 键值全清", out, "");
}
{
  const out = sanitize.sanitizeText("保留这段 cc_version=1.0.0; 去掉中间", new Map());
  eq("夹在文本中的 cc_ 键值", out, "保留这段 去掉中间");
}
ok("cc_ 但非键值形态不改", sanitize.sanitizeText("cc_entrypoint", new Map()) === "cc_entrypoint");

// ===== 6. 命中标签统计 =====
{
  const hits = new Map();
  sanitize.sanitizeText("11128 与 11128 两次", hits);
  // 计数口径是「每条规则每次净化记 1 次」，不是「每个出现位置记 1 次」
  eq("同规则命中计数（按规则计，不按出现次数）", hits.get("11128"), 1);
}
{
  const body = { messages: [{ role: "user", content: "code=11128 and cc_entrypoint=cli;" }] };
  const r = sanitize.sanitizeBody(body);
  ok("sanitizeBody 命中返回对象", !!r && Array.isArray(r.hits) && r.hits.length > 0);
  ok("sanitizeBody 不改原对象", body.messages[0].content === "code=11128 and cc_entrypoint=cli;");
  // 标签取的是规则的 from 原串（11128），不是替换后的 11-128`n  ok("sanitizeBody 摘要可读", /11128/.test(sanitize.formatHits(r.hits)));
}
ok("formatHits 空输入返回空串", sanitize.formatHits([]) === "" && sanitize.formatHits(null) === "");

// ===== 7. 未命中 → null（零拷贝路径）=====
eq("无指纹的 body 返回 null", sanitize.sanitizeBody({ messages: [{ role: "user", content: "你好" }] }), null);
eq("无 messages 的 body 返回 null", sanitize.sanitizeBody({ input: "x" }), null);
eq("非对象返回 null", sanitize.sanitizeBody(null), null);
eq("数组返回 null", sanitize.sanitizeBody([]), null);

// ===== 8. 多模态 / reasoning_content / tool_calls 三条旁路都要净化 =====
{
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "code=11128" }, { type: "image_url", image_url: { url: "x" } }] },
    ],
  };
  const r = sanitize.sanitizeBody(body);
  ok("多模态 text 分片被净化", !!r && r.body.messages[0].content[0].text === "code=11-128");
  ok("多模态非 text 分片原样保留", !!r && r.body.messages[0].content[1].image_url.url === "x");
}
{
  const body = { messages: [{ role: "assistant", content: null, reasoning_content: "code=11128" }] };
  const r = sanitize.sanitizeBody(body);
  ok("reasoning_content 被净化", !!r && r.body.messages[0].reasoning_content === "code=11-128");
}
{
  // content 为 null 的工具调用轮：早期实现在 content 缺失时跳过整条消息，这里是回归钉子
  const body = { messages: [{ role: "assistant", content: null, tool_calls: [{ function: { name: "f", arguments: '{"cmd":"echo 11128"}' } }] }] };
  const r = sanitize.sanitizeBody(body);
  ok("content=null 时 tool_calls 仍被净化", !!r && r.body.messages[0].tool_calls[0].function.arguments === '{"cmd":"echo 11-128"}');
}
{
  const body = { messages: [{ role: "assistant", tool_calls: [{ function: { name: "f" } }] }] };
  eq("arguments 非字符串时不动", sanitize.sanitizeBody(body), null);
}

// ===== 9. 顺序敏感：改写层必须在表头剥离之前 =====
{
  // 同一段文本里既有身份句又有表头：两者都要处理，且身份句必须被完整匹配到
  const body = { messages: [{ role: "user", content: "You are Claude Code, Anthropic's official CLI for Claude.\nx-anthropic-billing-header: v=1;" }] };
  const r = sanitize.sanitizeBody(body);
  const text = r ? r.body.messages[0].content : "";
  ok("改写 + 剥离共存", text.includes("official CLI tool for Claude") && !text.includes("billing-header:"));
}

// ===== 10. hasBodyFingerprint 只判断不修改 =====
{
  const body = { messages: [{ role: "user", content: "code=11128" }] };
  ok("hasBodyFingerprint 命中", sanitize.hasBodyFingerprint(body) === true);
  ok("hasBodyFingerprint 不改原对象", body.messages[0].content === "code=11128");
  ok("hasBodyFingerprint 未命中", sanitize.hasBodyFingerprint({ messages: [{ role: "user", content: "你好" }] }) === false);
}

// ===== 汇总 =====
if (fails.length) {
  console.error(`✗ 指纹脱敏自测：${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 指纹脱敏自测：${pass} 项全部通过`);
