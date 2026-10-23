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
// 为什么用「序号 + 丢弃」而不是 AbortController：
//   client.call 内部自己管超时（AbortController + timeoutSec），没有对外暴露 signal；
//   而产品语义与 WorkBuddy 一致——**前端取消只影响界面，主进程请求仍在跑但结果丢弃**。
//   于是这里记录「取消到了第几号请求」，请求返回时若发现自己已被取消就丢弃结果。
let seq = 0;
let cancelledUpTo = 0;

function cancel() {
  cancelledUpTo = seq;
  return { ok: true };
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

function postProcess(raw) {
  let s = String(raw == null ? "" : raw).trim();
  s = stripFence(s);
  s = stripWrappingQuotes(s);
  s = stripMetaLines(s);
  return s.trim();
}

// ===== 错误码映射 =====

/** 契约 §4.2 冻结的 8 个错误码；这里只产出 5 个（empty_input/too_long 在入口判定） */
function mapError(err) {
  const code = err && err.code;
  if (code === "no_model") return "no_model";
  const msg = String((err && err.message) || err || "");
  if (/abort|timeout|timed out|ETIMEDOUT|请求超时/i.test(msg)) return "timeout";
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

// ===== 主流程 =====

/**
 * 优化一段提示词。
 * 参数：text（必填）、styleId、以及可选的本次覆盖项（model/maxLength/temperature/maxTokens/timeoutSec/scenario）。
 * 返回：{ ok:true, text, styleName, model, elapsedMs, tokens } 或 { ok:false, code, message }
 */
async function optimize(args = {}) {
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
  const userPrompt = render(style.userTemplate || styles.USER_TEMPLATE, { input: text });

  const mySeq = ++seq;
  const started = Date.now();
  let client;
  try {
    client = getClient();
  } catch (e) {
    const code = mapError(e);
    history.add({
      styleId: style.id, styleName: style.name, model: preferModelId || "", inputText: text, outputText: "",
      elapsedMs: Date.now() - started, error: String((e && e.message) || e),
    });
    return { ok: false, code, message: code === "no_model" ? "尚未配置模型，请前往「设置 · 模型与网关」配置供应商与模型" : String((e && e.message) || e) };
  }

  let result = null;
  let err = null;
  try {
    result = await client.call({
      task: TASK,
      system,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens,
      temperature,
      timeoutSec,
      preferModelId,
    });
  } catch (e) {
    err = e;
  }

  const elapsedMs = Date.now() - started;

  // 取消：请求已经发出去了（主进程不感知前端取消），这里只负责丢弃结果
  if (cancelledUpTo >= mySeq) {
    return { ok: false, code: "cancelled", message: "已取消" };
  }

  if (err) {
    const code = mapError(err);
    const message = code === "no_model"
      ? "尚未配置模型，请前往「设置 · 模型与网关」配置供应商与模型"
      : code === "timeout"
        ? "模型响应超时，可在高级设置里调大超时时间"
        : String((err && err.message) || err);
    history.add({
      styleId: style.id, styleName: style.name, model: preferModelId || "", inputText: text, outputText: "",
      elapsedMs, error: message,
    });
    return { ok: false, code, message };
  }

  const rawText = (result && result.text) || "";
  const cleaned = postProcess(rawText);
  const usedModel = (result && result.modelId) || preferModelId || "";

  // 结果为空一律判失败：绝不清空输入框、也不把空串当成功（WorkBuddy 三层兜底里的同一原则）
  if (!cleaned) {
    history.add({
      styleId: style.id, styleName: style.name, model: usedModel, inputText: text, outputText: "",
      elapsedMs, error: "模型返回空内容",
    });
    return { ok: false, code: "empty_result", message: "模型返回了空内容，可换一个模型或稍后重试" };
  }

  // 结果与原文完全相同：不是错误，但要让用户知道「模型认为已经够清晰」，否则会以为功能坏了
  const unchanged = cleaned.trim() === text.trim();

  const rec = history.add({
    styleId: style.id, styleName: style.name, model: usedModel,
    inputText: text, outputText: cleaned, elapsedMs,
    tokens: result && result.usage ? { in: result.usage.input || 0, out: result.usage.output || 0 } : undefined,
  });

  return {
    ok: true,
    text: cleaned,
    styleName: style.name,
    model: usedModel,
    elapsedMs,
    tokens: result && result.usage ? { in: result.usage.input || 0, out: result.usage.output || 0 } : undefined,
    historyId: rec.id,
    unchanged,
    // 候选是否走了兜底（模型池里没有打 optimize 标签的模型时会用全部启用模型兜底）
    fallback: !!(result && result.source === "degrade"),
  };
}

module.exports = { optimize, cancel, render, postProcess, stripWrappingQuotes, stripMetaLines, stripFence, TASK };
