/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库 · 优化提示词（Prompt Enhancement）
//
// 对标 WorkBuddy 的「增强提示词」（逆向见 docs/提示词板块/01-*.md），沿用它的核心策略：
//   语言匹配为最高优先级 / 禁止元注释 / 只输出正文 / 不越界（不索要指南与代码、不推荐未提及技术、
//   不解释 HOW、不回答问题而是重写得更具体）/ 长度上限 / 已清晰则轻度润色 / 失败绝不清空输入。
//
// 模型来源：**直接复用记忆中枢的 client**（ProviderStore.client），
// 它背后就是「设置 · 模型与网关」的供应商与模型池，因此：
//   - 降级链、退避重试、参数不兼容自动剥离、用量记账全部现成，不另起一套 HTTP 调用；
//   - 记忆中枢板块停用时也能用（providerStore() 是惰性创建，与设置页同口径）。
"use strict";
const config = require("../config.cjs");
const styles = require("./styles.cjs");
const history = require("./history.cjs");

// 优化任务的标签：client 侧已登记 optimize（见 llm/client.cjs 的 DEFAULT_TASK_TAGS 与 TASK_ZH）
const TASK = "optimize";

// ===== 取消 =====
//
// 两套机制并存，各管一段：
//   1) runId → AbortController：流式下必须能真的停掉上游（否则白烧 token，用户还得多等）；
//      非流式也走它，因为 client.call 现在接受 signal 了。
//   2) 序号 + 丢弃（seq / cancelledUpTo）：兜底。万一某个供应商/环境 abort 没生效
//      （例如上游已经吐完、或 fetch 不响应中断），返回时发现「自己已被取消」就丢弃结果，
//      保证界面不会突然冒出一份用户已经放弃的结果。
let seq = 0;
let cancelledUpTo = 0;
const runControllers = new Map();

/** @param runId 前端生成的一次请求 id；不传则取消所有在途请求（兼容旧调用方） */
function cancel(runId) {
  cancelledUpTo = seq;
  let aborted = 0;
  if (runId) {
    const c = runControllers.get(String(runId));
    if (c) { try { c.abort(); aborted++; } catch { /* 已中止 */ } }
  } else {
    for (const c of runControllers.values()) {
      try { c.abort(); aborted++; } catch { /* 已中止 */ }
    }
  }
  return { ok: true, aborted };
}

// ===== 模板渲染 =====

/**
 * 占位符替换。
 * 必须用**函数形式**的 replace：字符串形式的第二参数里 `$&`、`$1`、`` $` `` 会被当成替换模式
 * 解释，用户提示词里一旦出现这些字符，写回去的正文就被悄悄改掉了。
 */
function render(tpl, vars) {
  let out = String(tpl == null ? "" : tpl);
  for (const key of Object.keys(vars)) {
    const re = new RegExp("\\{" + key + "\\}", "g");
    out = out.replace(re, () => String(vars[key] == null ? "" : vars[key]));
  }
  return out;
}

// ===== 结果后处理 =====
//
// 模型很爱输出「以下是优化后的提示词：」这类前言，以及「用户输入为中文 → 回复须用中文」这类
// 语言分析（WorkBuddy 的模板里专门给了 BAD/GOOD 对照就是踩过这个坑）。这些都不该进结果框。

const META_LINE_PATTERNS = [
  /^(用户输入|输入)(是|为)?\s*(中文|英文|日文|韩文|法语|德语|西班牙语)/,
  /^(回复|响应|输出|回答)(必须|须|应当|需要)?\s*(使用|用)?\s*(中文|英文|日文|韩文)/,
  /^user\s+input\s+is\s+in/i,
  /^(the\s+)?response\s+must\s+be\s+in/i,
  /^语言\s*(检测|分析|判断)/,
  /^language\s*(detection|analysis)/i,
  /^以下是(改写|优化|增强|润色)(后|过)?的?(提示词|版本)[：:]?\s*$/,
  /^(改写|优化|增强|润色)(后|过)?的?(提示词|版本)[：:]?\s*$/,
  /^(enhanced|optimized|improved)\s+prompt[：:]?\s*$/i,
  /^(here\s+is|below\s+is)\s+the\s+(enhanced|optimized|improved)/i,
  // 带 # 前缀的同义标题：模型很爱写「## 优化后的提示词」，上面几条因为 ^ 锚定匹配不到。
  // 注意只匹配「元标题」，不能碰「## 任务与成功判据」这类正文分节。
  /^#{1,6}\s*(以下是|下面是)?\s*(改写|优化|增强|润色)(后|过)?的?\s*(提示词|版本|结果)\s*[：:]?\s*$/,
  /^#{1,6}\s*(enhanced|optimized|improved)\s+prompt\s*[：:]?\s*$/i,
];

function stripWrappingQuotes(s) {
  let out = s.trim();
  // 成对才去：只去首尾同时存在引号的情况，避免把用户刻意保留的单个引号删掉
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
  ];
  for (const [a, b] of pairs) {
    if (out.startsWith(a) && out.endsWith(b) && out.length > a.length + b.length) {
      out = out.slice(a.length, out.length - b.length).trim();
    }
  }
  return out;
}

function stripFence(s) {
  const m = /^```[a-zA-Z0-9_+-]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(s.trim());
  return m ? m[1].trim() : s.trim();
}

function stripMetaLines(s) {
  const lines = s.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    return !META_LINE_PATTERNS.some((re) => re.test(t));
  });
  // 全被剥光说明判定过激（正文本身就像元注释），退回原文，宁可多留也不清空
  const out = kept.join("\n").trim();
  return out || s.trim();
}

/**
 * 抽出结尾的 <ASSUMPTIONS> 块（多角度补全风格用）。
 * **必须在 stripFence 之前调用**：stripFence 的正则要求围栏包裹整串，
 * 模型若输出「```…``` + <ASSUMPTIONS>…」，先 stripFence 必失败，围栏会留在结果里。
 * 容忍缺结束标签（模型偶尔只写开始标签），此时取到串尾。
 */
function extractAssumptions(raw) {
  const s = String(raw == null ? "" : raw);
  const m = /<ASSUMPTIONS>([\s\S]*?)(?:<\/ASSUMPTIONS>|$)/i.exec(s);
  if (!m) return { body: s, assumptions: [] };
  const body = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  const assumptions = String(m[1] || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•·]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => line.slice(0, 300));
  return { body, assumptions };
}

/** 结果后处理：返回 { text, assumptions }。assumptions 只在模型输出 <ASSUMPTIONS> 块时非空。 */
function postProcess(raw) {
  const split = extractAssumptions(raw);
  let s = split.body.trim();
  s = stripFence(s);
  s = stripWrappingQuotes(s);
  s = stripMetaLines(s);
  return { text: s.trim(), assumptions: split.assumptions };
}

// ===== 错误码映射 =====

/** 契约 §4.2 冻结的 8 个错误码；这里只产出 5 个（empty_input/too_long 在入口判定）。
 *  流式的内部码（stream_unsupported / stream_stall / stream_partial）一律归一到这 8 个之一，
 *  不扩契约——前端按 code 分支，多一个码就多一处漏判。 */
function mapError(err) {
  const code = err && err.code;
  if (code === "no_model") return "no_model";
  if (code === "cancelled") return "cancelled";
  const msg = String((err && err.message) || err || "");
  // stream_stall（上游长时间不吐字）本质上也是超时，文案交给 timeout 分支
  if (code === "stream_stall" || /abort|timeout|timed out|ETIMEDOUT|请求超时|没有返回新内容/i.test(msg)) return "timeout";
  return "model_error";
}

// ===== 模型客户端 =====

/** 惰性取用记忆中枢的 client：模块加载顺序与循环依赖都不影响调用时机 */
function getClient() {
  const memory = require("../memory/index.cjs");
  if (!memory || typeof memory.llmClient === "undefined" || !memory.llmClient) {
    const e = new Error("尚未配置模型");
    e.code = "no_model";
    throw e;
  }
  return memory.llmClient;
}

// ===== 入参归一 + 提示词渲染（非流式与流式两条路径共用）=====

/**
 * 校验与渲染。两条路径必须走同一份逻辑，否则「流式能过、非流式不能过」这类不一致会非常难查。
 * @returns { ok:false, code, message } 或 { ok:true, ctx }
 */
function prepare(args) {
  const cfg = (config.loadConfig().prompts) || {};
  const text = String(args.text == null ? "" : args.text);
  if (!text.trim()) return { ok: false, code: "empty_input", message: "请先输入需要优化的提示词" };

  // 超长保护：不静默截断（用户可能正是要优化长文），只给明确上限并让用户自己决定
  const maxChars = Math.max(4000, (Number(args.maxTokens) || cfg.maxTokens || 4096) * 6);
  if (text.length > maxChars) {
    return { ok: false, code: "too_long", message: `原文过长（${text.length} 字符，上限约 ${maxChars}），请分段优化或换用更大上下文的模型` };
  }

  const style = styles.getStyle(args.styleId || cfg.defaultStyleId);
  if (!style) return { ok: false, code: "model_error", message: "找不到可用的优化风格" };

  const maxLength = Math.min(20000, Math.max(100, Math.round(Number(args.maxLength) || style.maxLength || cfg.maxLength || 800)));
  const scenario = String(args.scenario || cfg.scenario || "通用 AI 助手").trim();
  const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : (style.temperature != null ? style.temperature : cfg.temperature);
  const maxTokens = Math.max(256, Math.round(Number(args.maxTokens) || cfg.maxTokens || 4096));
  const timeoutSec = Math.max(5, Math.round(Number(args.timeoutSec) || cfg.timeoutSec || 60));
  const preferModelId = String(args.model || cfg.defaultModel || "").trim() || undefined;

  const system = render(style.systemTemplate, { maxLength, scenario });
  // {extra} 的值是「自带前置空行与标题」的整块：为空时模板里只留原文，不会出现空标题。
  // 这样模板只需写 {input}{extra}，不必在渲染后做换行压缩（压缩会破坏原文里用户自己的空行）。
  const extra = String(args.extra == null ? "" : args.extra).trim();
  const extraBlock = extra ? `\n\n【本次额外要求】\n${extra}` : "";
  const userPrompt = render(style.userTemplate || styles.USER_TEMPLATE, { input: text, extra: extraBlock });

  return { ok: true, ctx: { cfg, text, style, maxLength, scenario, temperature, maxTokens, timeoutSec, preferModelId, system, userPrompt } };
}

/** 收尾：取消判定 → 错误落历史 → 后处理 → 成功落历史。两条路径共用同一份口径。 */
function settle(ctx, result, err, started, mySeq, extra = {}) {
  const elapsedMs = Date.now() - started;
  const style = ctx.style;
  const text = ctx.text;
  const preferModelId = ctx.preferModelId;

  // 取消兜底：即使 abort 没生效（上游已吐完 / fetch 不响应中断），返回时也要丢弃
  if (cancelledUpTo >= mySeq) return { ok: false, code: "cancelled", message: "已取消", ...extra };

  if (err) {
    const code = mapError(err);
    const message = code === "no_model"
      ? "尚未配置模型，请前往「设置 · 模型与网关」配置供应商与模型"
      : code === "timeout"
        ? (err && err.code === "stream_stall"
          ? String((err && err.message) || "上游长时间没有返回内容")
          : "模型响应超时，可在高级设置里调大超时时间")
        : String((err && err.message) || err);
    history.add({
      styleId: style.id, styleName: style.name, model: preferModelId || "", inputText: text, outputText: "",
      elapsedMs, error: message,
    });
    return { ok: false, code, message, ...extra };
  }

  const rawText = (result && result.text) || "";
  const processed = postProcess(rawText);
  const cleaned = processed.text;
  const usedModel = (result && result.modelId) || preferModelId || "";

  // 结果为空一律判失败：绝不清空输入框、也不把空串当成功（WorkBuddy 三层兜底里的同一原则）
  if (!cleaned) {
    history.add({
      styleId: style.id, styleName: style.name, model: usedModel, inputText: text, outputText: "",
      elapsedMs, error: "模型返回空内容",
    });
    return { ok: false, code: "empty_result", message: "模型返回了空内容，可换一个模型或稍后重试", ...extra };
  }

  // 结果与原文完全相同：不是错误，但要让用户知道「模型认为已经够清晰」，否则会以为功能坏了
  const unchanged = cleaned.trim() === text.trim();

  const rec = history.add({
    styleId: style.id, styleName: style.name, model: usedModel,
    inputText: text, outputText: cleaned, elapsedMs,
    assumptions: processed.assumptions,
    tokens: result && result.usage ? { in: result.usage.input || 0, out: result.usage.output || 0 } : undefined,
  });

  return {
    ok: true,
    text: cleaned,
    assumptions: processed.assumptions,
    styleName: style.name,
    model: usedModel,
    elapsedMs,
    tokens: result && result.usage ? { in: result.usage.input || 0, out: result.usage.output || 0 } : undefined,
    historyId: rec.id,
    unchanged,
    // 候选是否走了兜底（模型池里没有打 optimize 标签的模型时会用全部启用模型兜底）
    fallback: !!(result && result.source === "degrade"),
    // 本次是不是真走了流式；回退非流式时是 false（前端据此决定要不要提示）
    streamed: !!(result && result.streamed),
    ...extra,
  };
}

// ===== 主流程 =====

/**
 * 优化一段提示词（非流式）。
 * 参数：text（必填）、styleId、runId（可选，用于按 id 取消）、
 *      以及可选的本次覆盖项（model/maxLength/temperature/maxTokens/timeoutSec/scenario/extra）。
 * 返回：{ ok:true, text, assumptions, styleName, model, elapsedMs, tokens } 或 { ok:false, code, message }
 */
async function optimize(args = {}) {
  const prep = prepare(args);
  if (!prep.ok) return prep;
  const ctx = prep.ctx;

  const mySeq = ++seq;
  const runId = String(args.runId || "") || `run-${mySeq}`;
  const controller = new AbortController();
  runControllers.set(runId, controller);

  const started = Date.now();
  let client;
  try {
    client = getClient();
  } catch (e) {
    runControllers.delete(runId);
    const code = mapError(e);
    history.add({
      styleId: ctx.style.id, styleName: ctx.style.name, model: ctx.preferModelId || "", inputText: ctx.text, outputText: "",
      elapsedMs: Date.now() - started, error: String((e && e.message) || e),
    });
    return { ok: false, code, message: code === "no_model" ? "尚未配置模型，请前往「设置 · 模型与网关」配置供应商与模型" : String((e && e.message) || e) };
  }

  let result = null;
  let err = null;
  try {
    result = await client.call({
      task: TASK,
      system: ctx.system,
      messages: [{ role: "user", content: ctx.userPrompt }],
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      timeoutSec: ctx.timeoutSec,
      preferModelId: ctx.preferModelId,
      signal: controller.signal,
    });
  } catch (e) {
    err = e;
  } finally {
    runControllers.delete(runId);
  }

  return settle(ctx, result, err, started, mySeq);
}

// 流式推送的节流参数：IPC 每条消息都要序列化 + 跨进程拷贝，逐 token 推会把两端一起打满。
// 60ms 是「肉眼看着连贯」与「进程不被刷爆」的平衡点；120 字符是长句时的兜底（不必等满 60ms）。
const STREAM_FLUSH_MS = 60;
const STREAM_FLUSH_CHARS = 120;

/**
 * 优化一段提示词（流式）。
 * onDelta(chunk) 会被节流调用；最终仍返回与 optimize 完全相同的结构（前端只需处理一次收尾）。
 * 上游不支持流式时 client.callStream 内部会自动回退非流式，此时把全文当成一个 delta 推出去，
 * 前端不需要区分「真流式」与「回退」两条路径。
 */
async function optimizeStream(args = {}, onDelta) {
  const prep = prepare(args);
  if (!prep.ok) return prep;
  const ctx = prep.ctx;

  const mySeq = ++seq;
  const runId = String(args.runId || "") || `run-${mySeq}`;
  const controller = new AbortController();
  runControllers.set(runId, controller);

  const started = Date.now();
  let client;
  try {
    client = getClient();
  } catch (e) {
    runControllers.delete(runId);
    const code = mapError(e);
    history.add({
      styleId: ctx.style.id, styleName: ctx.style.name, model: ctx.preferModelId || "", inputText: ctx.text, outputText: "",
      elapsedMs: Date.now() - started, error: String((e && e.message) || e),
    });
    return { ok: false, code, message: code === "no_model" ? "尚未配置模型，请前往「设置 · 模型与网关」配置供应商与模型" : String((e && e.message) || e) };
  }

  let buf = "";
  let timer = null;
  let emitted = 0;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf) return;
    const chunk = buf;
    buf = "";
    emitted++;
    try { if (onDelta) onDelta(chunk); } catch { /* 回调异常不影响收流 */ }
  };
  const push = (t) => {
    if (!t) return;
    buf += t;
    if (buf.length >= STREAM_FLUSH_CHARS) { flush(); return; }
    if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS);
  };

  let result = null;
  let err = null;
  try {
    result = await client.callStream({
      task: TASK,
      system: ctx.system,
      messages: [{ role: "user", content: ctx.userPrompt }],
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      timeoutSec: ctx.timeoutSec,
      preferModelId: ctx.preferModelId,
      signal: controller.signal,
    }, push);

    // 回退到非流式：丢掉可能残留的缓冲，把全文一次推出去（前端照常「刷一下出现」）
    if (result && result.streamed === false) {
      buf = "";
      if (timer) { clearTimeout(timer); timer = null; }
      if (result.text) {
        emitted++;
        try { if (onDelta) onDelta(result.text); } catch { /* 忽略 */ }
      }
    }
  } catch (e) {
    err = e;
  } finally {
    flush();
    if (timer) { clearTimeout(timer); timer = null; }
    runControllers.delete(runId);
  }

  // partial：已经推过字了但最终失败 —— 前端必须清掉半截内容，不能留着当结果
  const failed = !!err || !(result && result.text);
  return settle(ctx, result, err, started, mySeq, { partial: emitted > 0 && failed });
}

module.exports = {
  optimize, optimizeStream, cancel, prepare, render, postProcess, extractAssumptions,
  stripWrappingQuotes, stripMetaLines, stripFence, mapError, TASK,
};
