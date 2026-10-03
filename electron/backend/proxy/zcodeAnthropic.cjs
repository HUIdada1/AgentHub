// 反代网关 · ZCode 上游协议翻译：OpenAI Chat Completions ↔ Anthropic Messages
//
// zcode 上游（coding-plan 与 start-plan 统一）是 Anthropic Messages 协议：
//   POST {base}/v1/messages + anthropic-version: 2023-06-01，SSE 事件流。
// 本模块只做纯函数/纯状态机翻译，不发请求：
//   toAnthropic()      OpenAI 请求体 → Anthropic 请求体
//   createSseBridge()  Anthropic SSE 事件 → 适配器统一 emit 事件（delta/usage/finish/error）
// 事实基线：zcode-api src/translator/* 与 zcode2api app/agent.py 的请求形态互证。
"use strict";

/** OpenAI content（string | parts[]）→ Anthropic content blocks */
function toBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url && part.image_url.url) {
      const url = String(part.image_url.url);
      // data URL → base64 source；http(s) → url source
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      else out.push({ type: "image", source: { type: "url", url } });
    }
  }
  return out;
}

/** tool 角色的 OpenAI 消息 → Anthropic user 消息内的 tool_result block */
function toolResultBlock(msg) {
  return {
    type: "tool_result",
    tool_use_id: String(msg.tool_call_id || msg.toolCallId || ""),
    content: toBlocks(msg.content),
  };
}

/**
 * OpenAI body → Anthropic body。
 * 要点：system 消息抽出合并为顶层 system；assistant 的 tool_calls → tool_use blocks；
 * tool 角色消息并入 user 消息的 tool_result blocks；max_tokens 必填
 * （客户端未传时用调用方给的 defaultMaxTokens——它来自官方客户端的模型元数据表；
 *  再没有才退回 8192。**不要**在缺省时一律 8192：Anthropic 协议必填 max_tokens，
 *  写死小值会把长回答硬截断，客户端表现为 MAX_TOKENS「响应因达到最大 token 限制而被截断」，
 *  WorkBuddy 就是不传 max_tokens 的那类客户端）；
 * stream 恒 true（非流式由 server.cjs 聚合器兜）。
 */
function toAnthropic(model, body, opts) {
  const b = body || {};
  const out = { model: String(model || ""), messages: [], stream: true };
  const systems = [];
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  for (const msg of msgs) {
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "");
    if (role === "system" || role === "developer") {
      const text = typeof msg.content === "string" ? msg.content : toBlocks(msg.content).filter((x) => x.type === "text").map((x) => x.text).join("\n");
      if (text) systems.push(text);
      continue;
    }
    if (role === "tool") {
      // 并入上一条 user 消息（Anthropic 要求 tool_result 在 user 回合）；没有则新开一条
      const block = toolResultBlock(msg);
      const last = out.messages[out.messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.messages.push({ role: "user", content: [block] });
      continue;
    }
    if (role === "assistant") {
      const blocks = toBlocks(msg.content);
      // thinking 回放：多轮里带 reasoning_content 的 assistant 消息翻成 thinking block
      // （GLM 系上游对开启思考的多轮会话要求 thinking 块存在，与 deepseek backfill 同语义）
      const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
      const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const merged = [];
      if (reasoning) merged.push({ type: "thinking", thinking: reasoning, signature: "" });
      merged.push(...blocks);
      for (const tc of tcs) {
        if (!tc || typeof tc !== "object") continue;
        const fn = tc.function && typeof tc.function === "object" ? tc.function : {};
        let input = {};
        try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { input = {}; }
        merged.push({ type: "tool_use", id: String(tc.id || ""), name: String(fn.name || ""), input });
      }
      out.messages.push({ role: "assistant", content: merged.length ? merged : [{ type: "text", text: "" }] });
      continue;
    }
    if (role === "user") {
      const blocks = toBlocks(msg.content);
      out.messages.push({ role: "user", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    }
  }
  // Anthropic 会话必须以 user 开头：历史首条是 assistant（客户端裁剪过的会话）时补一条空 user
  if (out.messages.length && out.messages[0].role !== "user") {
    out.messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }
  if (systems.length) out.system = systems.join("\n\n");
  // 客户端未传 max_tokens 时：优先用调用方按官方模型元数据给出的上限（GLM-5.3-Flash = 128000），
  // 否则退回 8192。三个别名都认：max_tokens / max_completion_tokens / max_output_tokens
  const mt = Number(b.max_tokens ?? b.max_completion_tokens ?? b.max_output_tokens);
  const def = Number(opts && opts.defaultMaxTokens);
  const fallback = Number.isFinite(def) && def > 0 ? Math.floor(def) : 8192;
  out.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.floor(mt) : fallback;
  if (typeof b.temperature === "number") out.temperature = b.temperature;
  if (typeof b.top_p === "number") out.top_p = b.top_p;
  const stop = b.stop;
  if (typeof stop === "string" && stop) out.stop_sequences = [stop];
  else if (Array.isArray(stop) && stop.length) out.stop_sequences = stop.map(String).filter(Boolean).slice(0, 8);
  if (Array.isArray(b.tools) && b.tools.length) {
    const tools = [];
    for (const t of b.tools) {
      const fn = t && t.type === "function" && t.function && typeof t.function === "object" ? t.function : t;
      if (!fn || typeof fn.name !== "string" || !fn.name) continue;
      tools.push({
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
      });
    }
    if (tools.length) out.tools = tools;
  }
  const tc = b.tool_choice;
  if (tc != null && out.tools) {
    if (tc === "auto" || tc === "none") out.tool_choice = { type: tc };
    else if (tc === "required") out.tool_choice = { type: "any" };
    else if (typeof tc === "object" && tc.function && tc.function.name) out.tool_choice = { type: "tool", name: String(tc.function.name) };
  }
  if (b.thinking && typeof b.thinking === "object") {
    if (b.thinking.type === "enabled") {
      out.thinking = {
        type: "enabled",
        budget_tokens: Number(b.thinking.budget_tokens || b.thinking.budgetTokens) || 2048,
      };
    } else if (b.thinking.type === "disabled") {
      out.thinking = { type: "disabled" };
    }
  } else if (b.reasoning_effort === "off") {
    out.thinking = { type: "disabled" };
  } else if (typeof b.reasoning_effort === "string" && b.reasoning_effort) {
    const budgetMap = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };
    out.thinking = {
      type: "enabled",
      budget_tokens: budgetMap[b.reasoning_effort] || 4096,
    };
  }
  return out;
}

/**
 * Anthropic SSE → 适配器 emit 桥（状态机）。
 * emit 事件与现有适配器约定一致：
 *   {type:"delta", delta:{content?|reasoning_content?|tool_calls?}}
 *   {type:"usage", usage:{prompt_tokens, completion_tokens, total_tokens}}
 *   {type:"finish", reason}
 *   {type:"error", status, code, message}
 * 返回 { onEvent(event, raw), result }；result 收集 planLimit（额度耗尽语义由 server.cjs 换号链消费）。
 */
function createSseBridge(emit) {
  const toolAcc = new Map(); // content_block index → { id, name, argsJson, emittedHead, toolIndex }
  let nextToolIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // usage 数值扩展字段（cache_read_input_tokens / cache_creation_input_tokens 等）：透传防丢，
  // 与 adapters.cjs 各渠道 usage 出口同模式——展开在前、标准字段覆盖在后。
  // Anthropic 原名的 input/output_tokens 与标准字段语义重复，排除掉避免每个响应永久冗余两字段
  const usageBaseKeys = new Set(["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens"]);
  let usageExtra = {};
  // 缓存 token（Anthropic 语义：input_tokens 不含缓存读，故 prompt_tokens 需按 OpenAI 口径合计）
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let stopReason = "";
  const result = { planLimit: false, sawError: false };

  const finishReasonMap = (r) => {
    const s = String(r || "");
    if (s === "end_turn" || s === "stop_sequence") return "stop";
    if (s === "max_tokens") return "length";
    if (s === "tool_use") return "tool_calls";
    return s || "stop";
  };

  function emitToolHead(index) {
    const acc = toolAcc.get(index);
    if (!acc || acc.emittedHead) return;
    acc.emittedHead = true;
    emit({ type: "delta", delta: { tool_calls: [{ index: acc.toolIndex, id: acc.id || undefined, type: "function", function: { name: acc.name, arguments: "" } }] } });
  }

  function onEvent(event, raw) {
    const data = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (!data || typeof data !== "object") return;
    const type = String(data.type || event || "");

    if (type === "message_start") {
      const usage = data.message && data.message.usage;
      if (usage) {
        inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens) || inputTokens;
        for (const [k, v] of Object.entries(usage)) if (typeof v === "number" && !usageBaseKeys.has(k)) usageExtra[k] = v;
        // 部分上游把 usage 放在 message_start（实测 zcode/GLM 此处为占位 0，真值在 message_delta）
        cacheReadTokens = Number(usage.cache_read_input_tokens) || cacheReadTokens;
        cacheCreationTokens = Number(usage.cache_creation_input_tokens) || cacheCreationTokens;
      }
      return;
    }
    if (type === "content_block_start") {
      const idx = Number(data.index) || 0;
      const block = data.content_block || {};
      if (block.type === "tool_use") {
        const toolIndex = nextToolIndex++;
        toolAcc.set(idx, { id: String(block.id || ""), name: String(block.name || ""), argsJson: "", emittedHead: false, toolIndex });
      }
      return;
    }
    if (type === "content_block_delta") {
      const idx = Number(data.index) || 0;
      const d = data.delta || {};
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        emit({ type: "delta", delta: { content: d.text } });
      } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
        emit({ type: "delta", delta: { reasoning_content: d.thinking } });
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json) {
        const acc = toolAcc.get(idx);
        if (acc) {
          emitToolHead(idx);
          acc.argsJson += d.partial_json;
          emit({ type: "delta", delta: { tool_calls: [{ index: acc.toolIndex, function: { arguments: d.partial_json } }] } });
        }
      }
      return;
    }
    if (type === "content_block_stop") {
      return; // tool_use 收尾无需动作（arguments 已按增量发出）
    }
    if (type === "message_delta") {
      const usage = data.usage || {};
      outputTokens = Number(usage.output_tokens ?? usage.completion_tokens) || outputTokens;
      for (const [k, v] of Object.entries(usage)) if (typeof v === "number" && !usageBaseKeys.has(k)) usageExtra[k] = v;
      // 实测 zcode/GLM 的真实 usage 只在 message_delta：message_start 的 input_tokens 恒为 0，
      // 而这里同时带 input_tokens 与 cache_read_input_tokens / cache_creation_input_tokens
      inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens) || inputTokens;
      cacheReadTokens = Number(usage.cache_read_input_tokens) || cacheReadTokens;
      cacheCreationTokens = Number(usage.cache_creation_input_tokens) || cacheCreationTokens;
      const sr = data.delta && data.delta.stop_reason;
      if (sr) stopReason = sr;
      return;
    }
    if (type === "message_stop") {
      if (inputTokens || outputTokens || cacheReadTokens) {
        // OpenAI 口径：prompt_tokens 为输入总量（Anthropic 的 input_tokens 不含缓存读，需合计）；
        // 缓存命中另放 prompt_tokens_details.cached_tokens（标准位置，下游按此显示命中率），
        // Anthropic 原名字段由上面的 usageExtra 透传保留
        const promptTotal = inputTokens + cacheReadTokens + cacheCreationTokens;
        const usage = {
          ...usageExtra,
          prompt_tokens: promptTotal,
          completion_tokens: outputTokens,
          total_tokens: promptTotal + outputTokens,
        };
        if (cacheReadTokens || cacheCreationTokens) {
          usage.prompt_tokens_details = { cached_tokens: cacheReadTokens };
          usage.cache_read_input_tokens = cacheReadTokens;
          usage.cache_creation_input_tokens = cacheCreationTokens;
        }
        emit({ type: "usage", usage });
      }
      emit({ type: "finish", reason: finishReasonMap(stopReason) });
      return;
    }
    if (type === "error") {
      const err = data.error || {};
      const message = String(err.message || data.message || "上游错误");
      const code = Number(err.code ?? data.code) || 0;
      // 额度耗尽语义：402 / 1005 / 上游欠费文案（1113 Insufficient balance 等实测形态）→ planLimit
      const isQuota = code === 1005 || code === 1113 || /insufficient|quota|balance|余额|额度|recharge/i.test(message);
      const status = isQuota ? 402 : code === 3007 ? 502 : code >= 3002 && code <= 3010 ? 429 : 502;
      if (isQuota) result.planLimit = true;
      result.sawError = true;
      emit({ type: "error", status, code, message });
      return;
    }
    // ping / 其他事件：忽略
  }

  return { onEvent, result };
}

module.exports = { toAnthropic, createSseBridge };
