/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-26
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库 · 自测脚本（纯函数层，不联网、不写真实数据）
// 用法：node tools/prompts-smoke.cjs
//
// 覆盖：内置风格完整性 / {extra} 渲染 / <ASSUMPTIONS> 剥离 / 后处理顺序 / 元标题清洗
"use strict";

const styles = require("../electron/backend/prompts/styles.cjs");
const optimize = require("../electron/backend/prompts/optimize.cjs");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  fail++;
  failures.push(name + (extra !== undefined ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  return false;
}

// ===== 1. 内置风格 =====
console.log("\n[1] 内置风格");
const builtin = styles.builtinStyles();
const ids = builtin.map((s) => s.id);
check("内置风格数量 ≥ 6", builtin.length >= 6, builtin.length);
check("含 builtin-multiangle", ids.includes("builtin-multiangle"), ids.join(","));
check("含 builtin-general（默认兜底）", ids.includes("builtin-general"));

const ma = builtin.find((s) => s.id === "builtin-multiangle");
check("多角度：名称正确", ma && ma.name === "多角度补全", ma && ma.name);
check("多角度：systemTemplate 非空", !!(ma && ma.systemTemplate.trim()));
check("多角度：userTemplate 含 {input}", !!(ma && ma.userTemplate && ma.userTemplate.includes("{input}")));
check("多角度：userTemplate 含 {extra}", !!(ma && ma.userTemplate && ma.userTemplate.includes("{extra}")));
check("多角度：{extra} 紧贴 {input}（不留空标题）", !!(ma && ma.userTemplate.includes("{input}{extra}")));
check("多角度：含 <ASSUMPTIONS> 约定", !!(ma && ma.systemTemplate.includes("<ASSUMPTIONS>")));
check("多角度：9 个角度都写了", ["目标", "受众", "场景", "素材", "内容维度", "形式", "边界", "失败模式", "交付与验收"]
  .every((k) => ma.systemTemplate.includes(k)));
check("多角度：5 段骨架都写了", ["任务与成功判据", "输入与素材", "输出规格", "约束与禁区", "交付与验收"]
  .every((k) => ma.systemTemplate.includes(k)));
check("多角度：假设上限写死为 3 条", ma.systemTemplate.includes("假设总数不超过 3 条"));
check("多角度：禁止编造具体事实", ma.systemTemplate.includes("一律不得生成"));
check("多角度：maxLength 合理（800~3000）", ma.maxLength >= 800 && ma.maxLength <= 3000, ma.maxLength);

const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
check("风格 id 无重复", dupIds.length === 0, dupIds);

// 所有内置风格的占位符必须落在白名单内（否则「保存为风格」会被前端拦下）
const ALLOWED = new Set(["input", "maxLength", "scenario", "extra"]);
const badPlaceholders = [];
for (const s of builtin) {
  for (const tpl of [s.systemTemplate, s.userTemplate || ""]) {
    const re = /\{\s*([A-Za-z0-9_]+)\s*\}/g;
    let m;
    while ((m = re.exec(tpl))) if (!ALLOWED.has(m[1])) badPlaceholders.push(`${s.id}:{${m[1]}}`);
  }
}
check("所有内置风格占位符合法", badPlaceholders.length === 0, badPlaceholders);

// ===== 2. {extra} 渲染 =====
console.log("\n[2] {extra} 渲染");
const tpl = styles.USER_TEMPLATE;
const empty = optimize.render(tpl, { input: "写个周报", extra: "" });
check("extra 为空：不出现「本次额外要求」", !empty.includes("本次额外要求"));
check("extra 为空：原文完整保留", empty.includes("写个周报"));

const withExtra = optimize.render(tpl, { input: "写个周报", extra: "\n\n【本次额外要求】\n面向老板，300 字内" });
check("extra 非空：出现标题", withExtra.includes("【本次额外要求】"));
check("extra 非空：内容落地", withExtra.includes("面向老板，300 字内"));
check("extra 非空：原文仍在", withExtra.includes("写个周报"));
check("extra 非空：无连续三空行", !/\n{3,}/.test(withExtra));

// 占位符替换必须是函数形式：正文里的 $& 不能被当成替换模式
const dollar = optimize.render("A{input}B", { input: "价格 $& 与 $1" });
check("替换不受 $& / $1 影响", dollar === "A价格 $& 与 $1B", dollar);

// 老模板（没有 {extra}）必须向后兼容
const oldTpl = "【待改写】\n{input}\n\n请改写。";
const oldRendered = optimize.render(oldTpl, { input: "abc", extra: "\n\n【本次额外要求】\nx" });
check("老模板无 {extra}：不报错且 extra 被忽略", oldRendered === "【待改写】\nabc\n\n请改写。", oldRendered);

// ===== 3. <ASSUMPTIONS> 剥离 =====
console.log("\n[3] <ASSUMPTIONS> 剥离");
const withBlock = "## 任务与成功判据\n写周报\n\n<ASSUMPTIONS>\n- 面向上级 ｜ 若不成立：语气要改\n- 400 字内 ｜ 若不成立：篇幅要改\n</ASSUMPTIONS>";
const r1 = optimize.postProcess(withBlock);
check("正文不含 <ASSUMPTIONS>", !r1.text.includes("<ASSUMPTIONS>"));
check("正文不含闭合标签", !r1.text.includes("</ASSUMPTIONS>"));
check("假设条数 = 2", r1.assumptions.length === 2, r1.assumptions);
check("假设去掉了列表符号", r1.assumptions[0] === "面向上级 ｜ 若不成立：语气要改", r1.assumptions[0]);
check("正文保留 5 段标题", r1.text.includes("## 任务与成功判据"));

const noClose = "正文\n<ASSUMPTIONS>\n- 只有开始标签";
const r2 = optimize.postProcess(noClose);
check("缺结束标签也能切", r2.text === "正文" && r2.assumptions.length === 1, r2);

const noBlock = "只有正文，没有假设块";
const r3 = optimize.postProcess(noBlock);
check("没有假设块：assumptions 为空数组", Array.isArray(r3.assumptions) && r3.assumptions.length === 0);
check("没有假设块：正文不变", r3.text === noBlock, r3.text);

const onlyAssumptions = "<ASSUMPTIONS>\n- 只有假设\n</ASSUMPTIONS>";
const r4 = optimize.postProcess(onlyAssumptions);
check("只有假设块：正文为空（判失败，不写空串）", r4.text === "", r4.text);

// 围栏 + 假设块同时存在：必须先切假设再剥围栏
console.log("\n[4] 后处理顺序（围栏 + 假设块）");
const fenced = "```markdown\n## 任务与成功判据\n写周报\n```\n<ASSUMPTIONS>\n- 默认中文\n</ASSUMPTIONS>";
const r5 = optimize.postProcess(fenced);
check("围栏被剥掉", !r5.text.includes("```"), r5.text.slice(0, 40));
check("围栏语言标签也没了", !r5.text.startsWith("markdown"));
check("正文保留分节标题", r5.text.includes("## 任务与成功判据"));
check("假设仍被切出", r5.assumptions.length === 1, r5.assumptions);

// ===== 5. 元标题清洗 =====
console.log("\n[5] 元标题清洗");
const p = (s) => optimize.postProcess(s).text;
check("裸「以下是优化后的提示词：」被删", !p("以下是优化后的提示词：\n正文内容").includes("以下是"));
check("裸「优化后的提示词」被删", !p("优化后的提示词\n正文内容").includes("优化后的提示词"));
check("带 # 的「## 优化后的提示词」被删", !p("## 优化后的提示词\n正文内容").includes("优化后的提示词"));
check("带 # 的「### 以下是改写后的版本」被删", !p("### 以下是改写后的版本\n正文内容").includes("以下是"));
check("正文分节「## 任务与成功判据」不被误杀", p("## 任务与成功判据\n正文").includes("## 任务与成功判据"));
check("正文分节「## 约束与禁区」不被误杀", p("## 约束与禁区\n正文").includes("## 约束与禁区"));
check("正文分节「## 输出规格」不被误杀", p("## 输出规格\n正文").includes("## 输出规格"));
check("语言分析行被删", !p("用户输入为中文，回复须用中文\n正文").includes("用户输入为中文"));
check("全部被剥光时退回原文（不清空）", p("用户输入为中文") === "用户输入为中文", p("用户输入为中文"));

// ===== 6. 包裹引号 =====
console.log("\n[6] 包裹引号");
check("成对中文引号被去", optimize.stripWrappingQuotes("“内容”") === "内容");
check("单个引号保留", optimize.stripWrappingQuotes("“内容") === "“内容");
check("成对英文引号被去", optimize.stripWrappingQuotes('"内容"') === "内容");

// ===== 7. 流式 SSE 解码（三格式） =====
console.log("\n[7] 流式 SSE 解码");
const llm = require("../electron/backend/memory/llm/client.cjs");

// chat_completions
check("chat：字符串 delta", llm.streamTextOf("chat_completions", { choices: [{ delta: { content: "你好" } }] }) === "你好");
check("chat：数组形式 delta",
  llm.streamTextOf("chat_completions", { choices: [{ delta: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } }] }) === "甲乙");
check("chat：usage 帧（choices 为空数组）不报错且无文本",
  llm.streamTextOf("chat_completions", { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) === "");
check("chat：reasoning_content 不进正文",
  llm.streamTextOf("chat_completions", { choices: [{ delta: { reasoning_content: "想一想" } }] }) === "");
check("chat：没有 choices 不炸", llm.streamTextOf("chat_completions", {}) === "");

// anthropic
check("anthropic：text_delta",
  llm.streamTextOf("anthropic", { type: "content_block_delta", delta: { type: "text_delta", text: "甲" } }) === "甲");
check("anthropic：thinking_delta 不进正文",
  llm.streamTextOf("anthropic", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "想" } }) === "");
check("anthropic：signature_delta 不进正文",
  llm.streamTextOf("anthropic", { type: "content_block_delta", delta: { type: "signature_delta", signature: "x" } }) === "");
check("anthropic：message_stop 是结束",
  llm.streamDoneOf("anthropic", { type: "message_stop" }) === true);
check("anthropic：content_block_start 不是结束",
  llm.streamDoneOf("anthropic", { type: "content_block_start" }) === false);

// responses（事件名与文本字段容易搞混：事件名是 response.output_text.delta，文本在 evt.delta）
check("responses：文本取 evt.delta",
  llm.streamTextOf("responses", { type: "response.output_text.delta", delta: "甲" }) === "甲");
check("responses：reasoning 摘要不进正文",
  llm.streamTextOf("responses", { type: "response.reasoning_summary_text.delta", delta: "想" }) === "");
check("responses：completed 是结束",
  llm.streamDoneOf("responses", { type: "response.completed" }) === true);

// 用量
const uChat = { input: 0, output: 0 };
llm.streamUsageOf("chat_completions", { usage: { prompt_tokens: 11, completion_tokens: 7 } }, uChat);
check("chat：用量解析", uChat.input === 11 && uChat.output === 7, uChat);

const uAnt = { input: 0, output: 0 };
llm.streamUsageOf("anthropic", { type: "message_start", message: { usage: { input_tokens: 12 } } }, uAnt);
llm.streamUsageOf("anthropic", { type: "message_delta", usage: { output_tokens: 9 } }, uAnt);
check("anthropic：用量分两处取", uAnt.input === 12 && uAnt.output === 9, uAnt);

const uResp = { input: 0, output: 0 };
llm.streamUsageOf("responses", { type: "response.completed", response: { usage: { input_tokens: 13, output_tokens: 8 } } }, uResp);
check("responses：用量解析", uResp.input === 13 && uResp.output === 8, uResp);

check("未知格式不抛错", llm.streamTextOf("whatever", { choices: [] }) === "");

// ===== 8. 错误码归一（不扩契约） =====
console.log("\n[8] 错误码归一");
const mapError = optimize.mapError;
check("no_model 原样透出", mapError(Object.assign(new Error("x"), { code: "no_model" })) === "no_model");
check("取消不被当成超时", mapError(Object.assign(new Error("已取消"), { code: "cancelled" })) === "cancelled");
check("上游卡住归到 timeout", mapError(Object.assign(new Error("上游超过 20s 没有返回新内容"), { code: "stream_stall" })) === "timeout");
check("AbortError 归到 timeout", mapError(new Error("This operation was aborted")) === "timeout");
check("其他归到 model_error", mapError(new Error("HTTP 500")) === "model_error");
const frozen = new Set(["empty_input", "too_long", "no_model", "model_error", "timeout", "cancelled", "empty_result", "unknown"]);
const produced = [
  mapError(Object.assign(new Error("x"), { code: "no_model" })),
  mapError(Object.assign(new Error("x"), { code: "cancelled" })),
  mapError(Object.assign(new Error("x"), { code: "stream_stall" })),
  mapError(new Error("boom")),
];
check("产出的码都在契约的 8 个里", produced.every((c) => frozen.has(c)), produced);

// ===== 9. 入参校验（两条路径共用 prepare） =====
console.log("\n[9] 入参校验");
check("空原文 → empty_input", optimize.prepare({ text: "  " }).code === "empty_input");
const tooLong = optimize.prepare({ text: "字".repeat(30000), maxTokens: 1000 });
check("超长 → too_long", tooLong.code === "too_long", tooLong.code);
const okPrep = optimize.prepare({ text: "帮我写个周报", styleId: "builtin-multiangle" });
check("正常入参 → ok", okPrep.ok === true);
check("正常入参：system 已渲染 maxLength", okPrep.ok && !okPrep.ctx.system.includes("{maxLength}"), okPrep.ok && okPrep.ctx.system.slice(0, 30));
check("正常入参：user 已渲染 input", okPrep.ok && okPrep.ctx.userPrompt.includes("帮我写个周报"));
check("空 extra：user 里没有额外要求标题", okPrep.ok && !okPrep.ctx.userPrompt.includes("本次额外要求"));
const prepExtra = optimize.prepare({ text: "写周报", styleId: "builtin-multiangle", extra: "面向老板" });
check("有 extra：标题与内容都在", prepExtra.ok && prepExtra.ctx.userPrompt.includes("【本次额外要求】") && prepExtra.ctx.userPrompt.includes("面向老板"));

// ===== 10. 读帧器（跨 chunk 分帧 / 噪声帧 / 错误帧） =====
// 用一个假的 Response 喂 chunk，验证真实网络下最容易出错的三件事：
//   1) 一行 data 被切成两个 chunk（TCP 不保证按行到达）；
//   2) 一个 chunk 里塞多帧；
//   3) 心跳注释行、event: 行、[DONE] 的处理。
function fakeRes(chunks) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    body: {
      getReader() {
        return {
          read() {
            if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) });
          },
          cancel() { i = chunks.length; return Promise.resolve(); },
        };
      },
    },
  };
}

async function runAsync() {
  console.log("\n[10] 读帧器");

  // 一行被切成两半：只有拼起来才能解析出完整 JSON
  const split = await llm.pumpSse(fakeRes([
    'data: {"choices":[{"delta":{"con',
    'tent":"你好"}}]}\n',
    "data: [DONE]\n",
  ]), "chat_completions", () => {});
  check("跨 chunk 半行能拼回", split.text === "你好", split.text);

  // 一个 chunk 多帧 + 心跳注释 + event: 行
  const multi = await llm.pumpSse(fakeRes([
    ': keep-alive\n\n',
    'event: message\ndata: {"choices":[{"delta":{"content":"甲"}}]}\n',
    'data: {"choices":[{"delta":{"content":"乙"}}]}\n',
    "data: [DONE]\n",
  ]), "chat_completions", () => {});
  check("多帧顺序拼接", multi.text === "甲乙", multi.text);
  check("心跳与 event 行被忽略", multi.text === "甲乙");

  // 回调收到的是增量片段（前端 append 的依据）
  const seen = [];
  await llm.pumpSse(fakeRes([
    'data: {"choices":[{"delta":{"content":"一"}}]}\n',
    'data: {"choices":[{"delta":{"content":"二"}}]}\n',
    "data: [DONE]\n",
  ]), "chat_completions", (t) => seen.push(t));
  check("onText 逐段回调", seen.join("") === "一二" && seen.length === 2, seen);

  // anthropic：结束靠 message_stop，没有 [DONE]
  const ant = await llm.pumpSse(fakeRes([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"甲"}}\n',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}\n',
    'data: {"type":"message_delta","usage":{"output_tokens":2}}\n',
    'data: {"type":"message_stop"}\n',
  ]), "anthropic", () => {});
  check("anthropic：只收正文", ant.text === "甲", ant.text);
  check("anthropic：用量两侧都取到", ant.usage.input === 3 && ant.usage.output === 2, ant.usage);

  // responses：文本在 evt.delta
  const resp = await llm.pumpSse(fakeRes([
    'data: {"type":"response.output_text.delta","delta":"甲"}\n',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"想"}\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":1}}}\n',
  ]), "responses", () => {});
  check("responses：只收正文", resp.text === "甲", resp.text);
  check("responses：用量", resp.usage.input === 4 && resp.usage.output === 1, resp.usage);

  // 流中错误帧必须抛，不能当空结果
  let thrown = null;
  try {
    await llm.pumpSse(fakeRes([
      'data: {"type":"error","error":{"message":"上游限流"}}\n',
    ]), "anthropic", () => {});
  } catch (e) { thrown = e; }
  check("流内错误帧抛出", !!thrown && String(thrown.message).includes("上游限流"), thrown && thrown.message);

  // 坏 JSON 帧跳过，不影响后续
  const bad = await llm.pumpSse(fakeRes([
    'data: {坏掉的json\n',
    'data: {"choices":[{"delta":{"content":"甲"}}]}\n',
    "data: [DONE]\n",
  ]), "chat_completions", () => {});
  check("坏帧跳过、后续正常", bad.text === "甲", bad.text);

  // 没有 body 直接判「不支持流式」，交给上层回退
  let noBody = null;
  try { await llm.pumpSse({ body: null }, "chat_completions", () => {}); } catch (e) { noBody = e; }
  check("无 body → stream_unsupported", !!noBody && noBody.code === "stream_unsupported", noBody && noBody.code);

  // ===== 11. 端到端：本地假上游（真 fetch / 真 SSE / 真取消） =====
  // 纯函数测不出「content-type 判断、回退、取消」这三件事，这里起一个本地 HTTP 服务喂真实响应。
  console.log("\n[11] 端到端（本地假上游）");
  const http = require("http");
  const { LlmClient } = llm;
  let mode = "sse";
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(": ping\n\n");
        res.write('data: {"choices":[{"delta":{"content":"甲"}}]}\n\n');
        setTimeout(() => {
          res.write('data: {"choices":[{"delta":{"content":"乙"}}]}\n\n');
          res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        }, 30);
        return;
      }
      if (mode === "json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "整包结果" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }));
        return;
      }
      // slow：发一段后不再发，等着被取消
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const mkClient = () => {
    const c = Object.create(LlmClient.prototype);
    c.quirksMemo = {};
    c.emit = () => {};
    c._log = () => {};
    c.getConfig = () => ({ "models.maxRetries": 0, "models.timeout": 10 });
    c.resolveCandidates = () => [{
      source: "custom",
      provider: { id: "fake", name: "fake", apiFormat: "chat_completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" },
      model: { id: "m1", modelId: "fake-model", maxTokens: 100, temperature: 0.2 },
    }];
    return c;
  };

  // 1) 正常流式
  const chunks = [];
  const r1 = await mkClient().callStream(
    { task: "optimize", system: "s", messages: [{ role: "user", content: "hi" }], timeoutSec: 10 },
    (t) => chunks.push(t),
  );
  check("E2E：流式全文", r1.text === "甲乙", r1.text);
  check("E2E：回调分段到达", chunks.length >= 2, chunks);
  check("E2E：usage 取到", r1.usage.input === 5 && r1.usage.output === 2, r1.usage);
  check("E2E：streamed=true", r1.streamed === true);

  // 2) 上游无视 stream（回整包 JSON）→ 自动回退非流式
  mode = "json";
  const c2 = mkClient();
  const r2 = await c2.callStream(
    { task: "optimize", system: "s", messages: [{ role: "user", content: "hi" }], timeoutSec: 10 },
    () => {},
  );
  check("E2E：回退非流式拿到全文", r2.text === "整包结果", r2.text);
  check("E2E：回退时 streamed=false", r2.streamed === false);
  check("E2E：回退后记住 noStream", !!(c2.quirksMemo.fake && c2.quirksMemo.fake.noStream), c2.quirksMemo);

  // 3) 中途取消：必须抛 cancelled，不能是 timeout / stream_partial
  mode = "slow";
  const c3 = mkClient();
  const ac = new AbortController();
  const p3 = c3.callStream(
    { task: "optimize", system: "s", messages: [{ role: "user", content: "hi" }], timeoutSec: 10, signal: ac.signal },
    () => {},
  );
  setTimeout(() => ac.abort(), 80);
  let e3 = null;
  try { await p3; } catch (e) { e3 = e; }
  check("E2E：取消抛 cancelled", !!e3 && e3.code === "cancelled", e3 && e3.code);

  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));

  // ===== 12. 线上目录（内置基线 / 查询 / 导入 / 重置） =====
  // 用临时目录替掉 dataDir，避免把测试数据写进真实的应用数据目录。
  console.log("\n[12] 线上目录");
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const frameworkConfig = require("../electron/backend/config.cjs");
  const tmpRoot = path.join(os.tmpdir(), `agenthub-catalog-smoke-${Date.now()}`);
  const origDataDir = frameworkConfig.dataDir;
  frameworkConfig.dataDir = () => tmpRoot;
  const catalog = require("../electron/backend/prompts/catalog.cjs");
  catalog.resetCache();

  const idxData = catalog.index();
  check("内置：8 个分类", idxData.categories.length === 8, idxData.categories.length);
  check("内置：10 套模板", idxData.templates.length === 10, idxData.templates.length);
  check("内置：版本号 1", idxData.version === 1, idxData.version);
  check("内置：来源是 builtin", idxData.source === "builtin", idxData.source);

  const all = catalog.list({ pageSize: 200 });
  check("内置：60 条", all.total === 60, all.total);
  check("内置：分页返回全量", all.items.length === 60, all.items.length);
  check("内置：分类计数合计 60", Object.values(all.counts).reduce((a, b) => a + b, 0) === 60, all.counts);
  check("列表不下发正文（省 IPC）", all.items.every((i) => i.body === undefined));
  check("列表带变量数与前 3 个变量名", all.items.every((i) => typeof i.variableCount === "number" && Array.isArray(i.variableNames)));

  const oneItem = catalog.get(all.items[0].id);
  check("详情带正文", oneItem.ok && oneItem.item.body.length > 100, oneItem.ok && oneItem.item.body.length);
  check("详情带变量表", oneItem.ok && Array.isArray(oneItem.item.variables));
  check("详情带许可（合规要求）", oneItem.ok && !!oneItem.item.license, oneItem.ok && oneItem.item.license);
  check("不存在的 id 返回 ok:false", catalog.get("no-such-id").ok === false);

  const byCat = catalog.list({ category: "coding" });
  check("按分类筛：coding 8 条", byCat.total === 8, byCat.total);
  const bySub = catalog.list({ category: "coding", subcategory: "review" });
  check("按二级筛不炸", bySub.ok === true && bySub.total <= 8, bySub.total);
  const byTpl = catalog.list({ templateId: "tpl-code-review" });
  check("按模板筛", byTpl.ok === true && byTpl.total >= 1, byTpl.total);
  const byQ = catalog.list({ q: "周报" });
  check("搜索命中标题/正文", byQ.total >= 1, byQ.total);
  const byQ2 = catalog.list({ q: "绝对不存在的词xyz" });
  check("搜索无结果不报错", byQ2.ok === true && byQ2.total === 0, byQ2.total);

  // 模板的 itemIds 必须都真实存在，否则抽屉里「关联案例」会指空
  const allIds = new Set(all.items.map((i) => i.id));
  const dangling = [];
  for (const t of idxData.templates) for (const id of t.itemIds) if (!allIds.has(id)) dangling.push(`${t.id}→${id}`);
  check("模板 itemIds 无悬空引用", dangling.length === 0, dangling);

  // 每条 required 变量都必须真的出现在正文里，否则用户填了也没用
  const badVars = [];
  for (const it of all.items) {
    const detail = catalog.get(it.id).item;
    for (const v of detail.variables) {
      if (v.required && !detail.body.includes(`{{${v.name}}}`)) badVars.push(`${it.id}:${v.name}`);
    }
  }
  check("required 变量都出现在正文里", badVars.length === 0, badVars);

  // 统计
  const st = catalog.stats();
  check("stats：条数与来源", st.stats.count === 60 && st.stats.source === "builtin", st.stats);
  check("stats：远程地址已配置", String(st.stats.remote).startsWith("https://"), st.stats.remote);

  // 导入：裸数组 / {items} / {prompts} 三种形状都要认
  const imp1 = catalog.importData([{ id: "x-a", title: "甲", body: "正文甲 {{v1}}", variables: [{ name: "v1", required: true }] }], "a.json");
  check("导入裸数组", imp1.ok && imp1.imported === 1, imp1);
  const imp2 = catalog.importData({ prompts: [{ id: "x-b", title: "乙", body: "正文乙" }] }, "b.json");
  check("导入 {prompts}", imp2.ok && imp2.imported === 1, imp2);
  const imp3 = catalog.importData({ items: [{ id: "x-a", title: "甲2", body: "重复 id" }] }, "c.json");
  check("导入同 id 自动加后缀不覆盖", imp3.ok && imp3.imported === 1, imp3);
  check("导入后总数 63", catalog.list({ pageSize: 200 }).total === 63, catalog.list({ pageSize: 200 }).total);
  check("导入条目带来源标记", catalog.get("x-a").item.license.includes("用户导入"), catalog.get("x-a").item.license);
  check("导入后 stats.imported=3", catalog.stats().stats.imported === 3, catalog.stats().stats.imported);

  const badImp = catalog.importData({ nope: 1 }, "d.json");
  check("格式不对返回 ok:false", badImp.ok === false, badImp.message);
  const emptyImp = catalog.importData([{ title: "无 id 无正文" }], "e.json");
  check("全被跳过时返回 ok:false", emptyImp.ok === false, emptyImp.message);

  // 清空导入层：只清导入，不动内置
  const cleared = catalog.clearImported();
  check("清空导入后回到 60 条", cleared.ok && cleared.total === 60, cleared.total);

  // 重置远程缓存：内置基线不受影响
  const resetR = catalog.reset();
  check("重置后仍是 60 条", resetR.ok && resetR.total === 60, resetR.total);
  check("重置后来源仍是 builtin", catalog.index().source === "builtin");

  frameworkConfig.dataDir = origDataDir;
  catalog.resetCache();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无所谓 */ }

  // ===== 13. IPC 通道 ↔ preload 白名单一致性 =====
  // 这一类错最阴：通道注册了但没进白名单，运行时只报「方法不存在」，开发时完全看不出来。
  // 用静态比对兜住它，以后加通道忘了同步白名单会直接在这里红。
  console.log("\n[13] IPC 通道一致性");
  const readText = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const backendSrc = readText("electron/backend/prompts/index.cjs");
  const preloadSrc = readText("electron/preload.cjs");

  const registered = new Set();
  for (const m of backendSrc.matchAll(/handle\(\s*"(prompts_[a-z0-9_]+)"/g)) registered.add(m[1]);

  // preload 里的白名单是一个纯字符串数组：抓所有 "prompts_xxx" 字面量
  const allowed = new Set();
  for (const m of preloadSrc.matchAll(/"(prompts_[a-z0-9_]+)"/g)) allowed.add(m[1]);

  const missingInPreload = [...registered].filter((c) => !allowed.has(c));
  check("后端注册的通道都在 preload 白名单里", missingInPreload.length === 0, missingInPreload);
  check("后端至少注册了 30 个通道", registered.size >= 30, registered.size);
  check("流式通道已注册", registered.has("prompts_optimize_stream"));
  check("目录通道已注册（8 个）",
    ["prompts_catalog_index", "prompts_catalog_list", "prompts_catalog_get", "prompts_catalog_stats",
      "prompts_catalog_refresh", "prompts_catalog_import", "prompts_catalog_clear_imported", "prompts_catalog_reset"]
      .every((c) => registered.has(c)));

  // 前端封装面（ipc.ts）也要有同名导出，否则页面拿到的是 undefined
  const ipcSrc = readText("src/api/ipc.ts");
  // prompts_optimize_stream → promptsOptimizeStream（首段保留，后续段首字母大写）
  const camel = (ch) => ch.split("_").map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  const missingInApi = [...registered].filter((ch) => !new RegExp(`export const ${camel(ch)}\\b`).test(ipcSrc));
  check("每个通道都有 ipc.ts 封装", missingInApi.length === 0, missingInApi);

  // 新通道必须补 mock，否则 dev:web 会抛「未知命令」
  const mockSrc = readText("src/api/mock.ts");
  const missingInMock = [...registered].filter((ch) => !mockSrc.includes(`"${ch}"`));
  check("每个通道都有 mock 分支", missingInMock.length === 0, missingInMock);

  // ===== 汇总 =====
  console.log(`\n${fail === 0 ? "全部通过" : "存在失败"}：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  -", f);
    process.exitCode = 1;
  }
}

runAsync().catch((e) => {
  console.error("自测脚本异常：", e);
  process.exitCode = 1;
});
