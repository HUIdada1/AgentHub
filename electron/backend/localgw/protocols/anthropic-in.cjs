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
// 反代网关 · 入站协议：Anthropic Messages（Claude Code / Anthropic SDK 直接打这里）
//
// 职责只有一个方向：把 `POST /v1/messages` 的请求体翻译成网关的内部规范形（OpenAI chat body），
// 响应的反向翻译在 anthropic-out.cjs。两者不共享代码，但共享同一张字段映射表——改一处必须同步另一处。
//
// 为什么 Anthropic 入站要单独一层：Claude Code 只讲 Messages 协议，
// 有了它，用户在客户端里填一个网关地址就能用到所有渠道，不再需要 CC Switch 在中间做协议翻译。
//
// 内部规范形就是 handleChat 一直在用的那套（model / messages / max_tokens / stream / tools /
// reasoning_effort…），所以这一层归一完之后，鉴权、别名、回退链、号池换号、冷却决策全部复用
// 同一条 handleChat——它只认 emit 词汇，不认客户端来自哪个协议。
"use strict";

// Anthropic thinking.budget_tokens → reasoning_effort 换算阈值（可调常量，对齐 util.EFFORT_RANK）。
// 派生出的 effort 走的是网关已有的档位管线（util.normalizeReasoningEffort 收敛 + 适配器按渠道改写），
// 因此这里只负责「把预算落成一档」，不负责判断上游吃不吃这一档。
const THINKING_BUDGET_THRESHOLDS = [
  { max: 4096, effort: "low" },      // 1 – 4096
  { max: 16384, effort: "medium" },  // 4097 – 16384
  { max: 32768, effort: "high" },    // 16385 – 32768
  { max: Infinity, effort: "max" },  // > 32768
];

/** thinking → 派生 effort。返回：
 *  · "off"        —— type=disabled 或 budget=0（关思考是个开关，不是一个档位）
 *  · "low/medium/high/max" —— 按预算落桶
 *  · undefined    —— 无 thinking / 没给预算 / 非法（负数、NaN）：当 enabled 无档，不派生 */
function budgetToEffort(thinking) {
  if (!thinking || typeof thinking !== "object") return undefined;
  if (String(thinking.type || "").trim().toLowerCase() === "disabled") return "off";
  const raw = thinking.budget_tokens;
  // 「没给预算」与「预算为 0」不是一回事，必须先分清楚再转数：Number(null) 与 Number("")
  // 都是 0，先转数会把 null/空串当成「显式关掉思考」，而客户端只是没填这个字段
  if (raw == null || raw === "") return undefined;
  const budget = Number(raw);
  if (budget === 0) return "off";
  if (!Number.isFinite(budget) || budget < 0) return undefined; // 非法/负 → enabled 无档，不派生
  for (const t of THINKING_BUDGET_THRESHOLDS) if (budget <= t.max) return t.effort;
  return "max";
}

/** 网关 Key：x-api-key 优先，回落 Authorization: Bearer；两者都在但不等价时判失败。
 *  这是刻意从严：静默挑一个用，等于让用户以为配错了也能跑，之后按哪个 Key 记账都会对不上。 */
function readKey(req) {
  const apiHeader = String(req.headers["x-api-key"] || "").trim();
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (apiHeader && bearer && apiHeader !== bearer) {
    return { error: "x-api-key 与 Authorization 指向两把不同的 Key，请只留一把（Claude Code 同时设置会告警）" };
  }
  return { key: apiHeader || bearer };
}

/** system：string 或 TextBlockParam[]，按序拼成一条 system（Anthropic 允许多块 + cache_control） */
function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((b) => (typeof b === "string" ? b : (b && typeof b.text === "string" ? b.text : ""))).filter(Boolean).join("\n");
}

/** image 块 → OpenAI image_url。Anthropic 的 source 有 base64 / url / file 三型，
 *  file 型走的是 Anthropic 文件存储，中转站听不懂，明确拒绝而不是悄悄丢图 */
function toImageUrl(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64") {
    if (!source.media_type || !source.data) return null;
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return null;
}

/** tool_result 的 content 摊平成字符串（OpenAI role:tool 的 content 只收文本/图片数组，
 *  摊平是通行做法：文本块拼接，图片转 data URI 交给多模态分支）。
 *  notes 透传：file 型图片与不识别的块在这里也要可追溯（与 text 分支的 image 处理同口径） */
function flattenToolResult(content, notes) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") parts.push(String(b.text || ""));
    else if (b.type === "image") {
      const u = toImageUrl(b.source);
      if (u) parts.push(`[image] ${u}`);
      else if (notes) notes.push("tool_result 内 image.source.type=file 无法转发，该图已丢弃");
    } else if (b.type) {
      if (notes) notes.push(`tool_result 内未识别的块类型 ${b.type}，已丢弃`);
    }
  }
  return parts.join("\n");
}

/**
 * Messages 请求体 → 内部 OpenAI chat body。
 * @returns {{ok:true, body:object, notes:string[]} | {ok:false, message:string}}
 *
 * notes 记录「这次转换丢了什么/降级了什么」，由调用方写进日志：
 * 语义损失本身无法避免（thinking 签名不可伪造、cache_control 无对应物），但必须可追溯。
 */
function toInternal(raw) {
  const notes = [];
  if (!raw || typeof raw !== "object") return { ok: false, message: "请求体必须是 JSON 对象" };
  const model = String(raw.model || "");
  if (!model) return { ok: false, message: "missing_model：model 不能为空" };
  if (!Number.isFinite(Number(raw.max_tokens)) || Number(raw.max_tokens) <= 0) {
    // Anthropic 把 max_tokens 列为必填（messages API 唯一必填的采样参数），缺失时客户端自己也不会发
    return { ok: false, message: `max_tokens 必填且需为正整数（Anthropic Messages 协议要求）` };
  }
  if (!Array.isArray(raw.messages) || !raw.messages.length) {
    return { ok: false, message: "messages 不能为空" };
  }

  const messages = [];
  const sys = systemText(raw.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of raw.messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    const blocks = Array.isArray(m.content) ? m.content : null;

    if (!blocks) {
      // 非字符串的 content（null / 数字 / 对象）与空串一样没有信息量：上游对
      // {role:"user",content:""} 的容忍度不一致（部分直接 400），别把空消息发出去
      const c = typeof m.content === "string" ? m.content : "";
      if (!c) continue;
      messages.push({ role, content: c });
      continue;
    }

    const textParts = [];
    const images = [];
    const toolCalls = [];
    // tool_result 收集成数组：Anthropic 允许单条 user 消息带多个 tool_result 块（并行工具调用的
    // 标准形态），单变量覆盖会只留最后一个，上游收到缺 response 的 tool_call 直接 400
    const toolResults = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") textParts.push(String(b.text || ""));
      else if (b.type === "image") {
        const u = toImageUrl(b.source);
        if (u) images.push({ type: "image_url", image_url: { url: u } });
        else notes.push("image.source.type=file 无法转发（Anthropic 文件存储无对应物），该图已丢弃");
      } else if (b.type === "tool_use" && role === "assistant") {
        // input 是对象，OpenAI 侧 arguments 是 JSON 字符串：序列化保真，call id 原样带上
        toolCalls.push({ id: String(b.id || ""), type: "function", function: { name: String(b.name || ""), arguments: safeStringify(b.input) } });
      } else if (b.type === "tool_result") {
        const tr = { role: "tool", tool_call_id: String(b.tool_use_id || ""), content: flattenToolResult(b.content, notes) };
        if (b.is_error) tr.content = `[error] ${tr.content}`;
        toolResults.push(tr);
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        // 不回投：signature 是 Anthropic 对上游思考的签名，伪造不了；多数 OpenAI 上游也不认这个字段。
        // 只把内容并进 reasoning_content 供目录/统计侧看，签名丢弃
        notes.push(b.type === "thinking" ? "thinking.signature 不回投上游" : "redacted_thinking 已丢弃");
      } else if (b.type === "document") {
        notes.push("document 块未转换（无 OpenAI chat 对应物），内容已丢弃");
      } else if (b.type) {
        notes.push(`未识别的内容块类型 ${b.type}，已丢弃`);
      }
    }

    if (toolResults.length) {
      for (const tr of toolResults) messages.push(tr);
      // tool_result 与 text 混排时（Claude Code 会这么发），文本另起一条 user 消息，别丢。
      // 同一条消息里收集到的图片也挂在它上面：图片既不在任何 tool_result 的 content 里
      // （那里的图由 flattenToolResult 处理），走不到下面那条 msg 分支，不带上就是无声丢图
      const extra = textParts.join("");
      if (extra && images.length) messages.push({ role: "user", content: [{ type: "text", text: extra }, ...images] });
      else if (extra) messages.push({ role: "user", content: extra });
      else if (images.length) messages.push({ role: "user", content: images });
      continue;
    }
    // 所有块都被丢弃（纯 thinking / redacted_thinking / document / 未知类型）时 textParts 为空，
    // 此时不能产出一条空消息：它不带任何信息，而上游对空 content 的容忍度不一致（部分直接 400）。
    // 有 tool_calls 或图片时照常保留——那些是实质内容，不是空壳
    const text = textParts.join("");
    if (!text && !images.length && !toolCalls.length) continue;
    const msg = { role, content: text };
    if (images.length) msg.content = [{ type: "text", text }, ...images];
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }

  const body = {
    model,
    messages,
    max_tokens: Math.max(1, Number(raw.max_tokens) || 1),
    stream: !!raw.stream,
  };
  if (raw.temperature != null) body.temperature = Number(raw.temperature);
  if (raw.top_p != null) body.top_p = Number(raw.top_p);
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length) body.stop = raw.stop_sequences;

  const tools = mapTools(raw.tools, notes);
  if (tools) body.tools = tools;
  const tc = mapToolChoice(raw.tool_choice);
  if (tc) body.tool_choice = tc;

  // thinking 原件必须跟着走：网关确实有一条 Anthropic 形态的出站——zcode 渠道走
  // zcodeAnthropic.toAnthropic，它直接读 body.thinking 的 type / budget_tokens。只发派生档位
  // 等于把用户给的精确预算换成一张写死的映射表（那边的 budgetMap）。
  // 原件与档位并存不是重复下发，两条路各喂一类上游：
  //   · Anthropic 形态出站读原件（预算精确值生效）
  //   · effort 档位型上游读 reasoning_effort（照常过 util.normalizeReasoningEffort 收敛）
  // 而且 body.thinking 不是这里新发明的私有键：「模型目录里改思考档」那条既有路径
  // （见 server.cjs 的 custom.reasoningEffort 分支）本来就同时写 reasoning_effort 与
  // thinking.{type}，两条通路同形。
  // off 也不在协议层删档：置 "off" 标记贯通管线——util.normalizeReasoningEffort 靠那条守卫
  // 认出「关思考是开关不是档位」（issue #128），util.injectThinking 靠原件抑制 enabled 注入。
  // 客户端若给出 max_tokens <= budget_tokens，那是 Anthropic 官方同样会 400 的组合，
  // 这里如实透传，不替用户偷偷改预算。
  if (raw.thinking) {
    body.thinking = raw.thinking;
    const eff = budgetToEffort(raw.thinking);
    if (eff === "off") {
      body.reasoning_effort = "off";
      notes.push("thinking disabled/budget=0：置 reasoning_effort=off（原件照常带上，由出站侧按渠道形态取舍）");
    } else if (eff) {
      body.reasoning_effort = eff;
      notes.push(`thinking.budget_tokens=${raw.thinking.budget_tokens} 派生 reasoning_effort=${eff}（原件同时保留）`);
    } else {
      // enabled 但预算非法/缺失：没有档位可派生，交给上游自己的默认行为
      notes.push("thinking 无有效 budget_tokens：不派生档位，按上游默认");
    }
  }
  // top_k / metadata 转不进内部规范形，也不硬塞：OpenAI chat 没有这两个位置，
  // 而唯一读 metadata 的出站（zcode）自己构造设备结构，塞进去会把那边的标识覆盖掉。
  if (raw.top_k != null) notes.push("top_k 未转发（无 OpenAI chat 对应字段）");
  if (raw.metadata) notes.push("metadata 未转发（无 OpenAI chat 对应字段；zcode 出站自造设备标识）");

  return { ok: true, body, notes };
}

/** tools: Anthropic {name,description,input_schema} → OpenAI {type:'function',function:{...}} */
function mapTools(tools, notes) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || !t.name) continue;
    out.push({
      type: "function",
      function: {
        name: String(t.name),
        description: t.description ? String(t.description) : "",
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    });
  }
  if (!out.length) return null;
  // Anthropic 工具名规则比 OpenAI 严（^[a-zA-Z0-9_-]{1,128}$），反向不成立：
  // 客户端若用了 Anthropic 不合法的名字，出站侧要做可逆改名——这里先记下，别静默改
  if (out.some((x) => !/^[a-zA-Z0-9_-]{1,128}$/.test(x.function.name))) notes.push("存在不符合 Anthropic 命名规则的工具名，发往 Anthropic 形态上游时需要改写");
  return out;
}

/** tool_choice: auto/any/tool/none → OpenAI 形态 */
function mapToolChoice(choice) {
  if (!choice) return null;
  if (typeof choice === "string") return choice === "any" ? "required" : choice;
  if (typeof choice !== "object") return null;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: String(choice.name) } };
  return null;
}

function safeStringify(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v == null ? {} : v);
  } catch {
    return "{}";
  }
}

/** POST /v1/messages/count_tokens：官方标注为可选（缺了客户端退化成字符估算），
 *  我们复用网关既有的 length/4 估算口径，保证与它自己的兜底同量级、不出现"两边数差很多" */
function countTokens(raw) {
  const util = require("../../proxy/util.cjs");
  // 官方把 count_tokens 列为可选端点，它的请求体里通常**没有** max_tokens（那不是它的必填项），
  // 而 toInternal 按 Messages 协议要求它必填——直接调会永远走 !ok 分支、拿原始 body 估算，
  // 口径与真实请求对不上（system 合并、块展平、图片展开都没算进去）。补一个占位值让它走
  // 同一条转换链，数字才与真正发出去的那次请求同量级
  const src = raw && typeof raw === "object" ? raw : {};
  const r = toInternal({ ...src, max_tokens: Number(src.max_tokens) > 0 ? src.max_tokens : 1 });
  const text = r.ok ? JSON.stringify(r.body.messages) : JSON.stringify(src);
  const n = util.estimateTokens(text);
  return { input_tokens: n };
}

module.exports = { readKey, toInternal, countTokens, _budgetToEffort: budgetToEffort };
