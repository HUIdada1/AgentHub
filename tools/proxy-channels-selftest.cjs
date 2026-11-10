/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Accio / CodeArts / Loomy 三渠道纯函数自测（离线可跑，不打真上游）
// 覆盖：签名向量（CodeArts 尾斜杠 / 字符集 / Go 语义 URL 解析；Loomy 9 段拼接）、
//       Accio 协议翻译（Gemini 信封 / 思考档位落点 / sg_k）、SSE 首帧预读与流内错误、
//       CodeArts 流内错误信封与脱敏、目录归一与大小写查找。
"use strict";

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  ✗ ${label}\n    期望 ${e}\n    实际 ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

const signer = require("../electron/backend/proxy/codearts/signer.cjs");
const loomySign = require("../electron/backend/proxy/loomy/sign.cjs");
const accioProto = require(require("node:path").resolve(process.env.AGENTHUB_FORWARDING_PLUGIN_DIR || require("node:path").join(__dirname, "../../AgentHub_skill"), "src/providers/accio/protocol.cjs"));
const accioStream = require(require("node:path").resolve(process.env.AGENTHUB_FORWARDING_PLUGIN_DIR || require("node:path").join(__dirname, "../../AgentHub_skill"), "src/providers/accio/stream.cjs"));
const accioModels = require("../electron/backend/proxy/accio/models.cjs");
const caFault = require("../electron/backend/proxy/codearts/stream_fault.cjs");
const caRedact = require("../electron/backend/proxy/codearts/redact.cjs");

// ===== CodeArts 签名：尾斜杠 + 字符集 + Go 语义 =====
(function testCodeArtsSigner() {
  const cred = { access_key_id: "AK", secret_access_key: "SK", security_token: "STS", domain_id: "" };
  const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
  const m = signer.signMaterial("POST", url, [["Content-Type", "application/json"]], Buffer.from("{}"), cred, false);
  // canonicalURI 强制补尾斜杠
  ok(m.canonicalRequest.split("\n")[1].endsWith("/"), "CodeArts canonicalURI 补尾斜杠");
  ok(m.canonicalRequest.split("\n")[1] === "/api/v2/chat/completions/", "CodeArts canonicalURI 值");
  // Authorization 头格式
  const auth = m.headers.find(([k]) => k === "Authorization");
  ok(auth && auth[1].startsWith("SDK-HMAC-SHA256 Access=AK, SignedHeaders=") && auth[1].includes("Signature="),
    "CodeArts Authorization 头格式");
  // 空值不进头：domain_id 为空不带 X-Domain-Id
  ok(!m.headers.some(([k]) => k === "X-Domain-Id"), "CodeArts 空 domain_id 不进头");
  // Go 语义 query 解析：+ 是空格
  const q = signer.canonicalQueryString("a=1&b=x+y");
  ok(q.includes("b=x%20y"), "CodeArts query + 折成空格");
})();

// ===== Loomy 签名：9 段拼接 + 路径去尾斜杠 =====
(function testLoomySign() {
  eq(loomySign.buildEscapedPath("/login/phone/checkCode/"), "/login/phone/checkCode", "Loomy 路径去尾斜杠");
  eq(loomySign.buildEscapedPath("login/phone/sendMsgCode"), "/login/phone/sendMsgCode", "Loomy 路径补前导斜杠");
  const headers = loomySign.signedHeaders("POST", "/login/phone/checkCode", { base: {}, param: {} });
  ok(/^account [a-zA-Z0-9]+:[A-Za-z0-9+/=]+$/.test(headers.Authorization), "Loomy Authorization account 形态");
  ok(headers.Date && headers.Nonce && headers["Content-MD5"], "Loomy Date/Nonce/Content-MD5 齐备");
})();

// ===== Accio 协议翻译：Gemini 信封 + 思考档位落点 + sg_k =====
(function testAccioProtocol() {
  const body = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
    tools: [{ type: "function", function: { name: "read", description: "读", parameters: { type: "object", properties: {} } } }],
    temperature: 0.7, max_tokens: 1024,
  };
  const { body: up, thinking } = accioProto.buildUpstreamBody(body, "claude-sonnet-4-6", "TOKEN", "high", "top");
  eq(up.model, "claude-sonnet-4-6", "Accio model 透传");
  eq(up.token, "TOKEN", "Accio token 在 body");
  eq(up.tenant, "accio-agent", "Accio tenant");
  eq(typeof up.system_instruction, "string", "Accio system_instruction 是字符串");
  eq(up.system_instruction, "你是助手", "Accio system_instruction 值");
  eq(up.contents.length, 1, "Accio contents 合并 system 后剩 user 一轮");
  ok(up.contents[0].parts.some((p) => p.inline_data && p.inline_data.data === "AAAA"), "Accio data URI → inline_data");
  eq(typeof up.tools[0].parameters_json, "string", "Accio parameters_json 是字符串");
  eq(typeof up.tool_config, "string", "Accio tool_config 是字符串");
  eq(up.reasoning_effort, "high", "Accio 顶层 reasoning_effort（top 落点）");
  eq(up.properties.reasoning_effort, undefined, "Accio top 落点不写 properties");
  eq(thinking, true, "Accio thinking 标记");
  // properties 落点（OpenAI 系）
  const { body: up2 } = accioProto.buildUpstreamBody({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }, "gpt-5.4", "T", "low", "properties");
  eq(up2.properties.reasoning_effort, "low", "Accio properties 落点");
  eq(up2.reasoning_effort, undefined, "Accio properties 落点顶层留空");
  // sg_k = md5(requestId)
  const u = accioProto.generateContentUrl("https://gw/api/adk/llm", "abc");
  ok(/sg_k=[0-9a-f]{32}$/.test(u), "Accio sg_k=md5(requestId)");
})();

// ===== Accio SSE：首帧预读 + 流内错误 + 翻译 =====
(function testAccioStream() {
  const frame = accioStream.parseFrame('{"content":{"role":"model","parts":[{"text":"你"}]},"partial":true}');
  eq(frame.parts[0], { kind: "text", text: "你" }, "Accio text part");
  const thought = accioStream.parseFrame('{"content":{"role":"model","parts":[{"thought":true,"text":"想"}]}}');
  eq(thought.parts[0].kind, "thought", "Accio thought part");
  const errFrame = accioStream.parseFrame('{"errorCode":"400","errorMessage":"invalid params"}');
  ok(accioStream.frameIsError(errFrame), "Accio 错误帧判定（camelCase）");
  const snakeErr = accioStream.parseFrame('{"error_code":"401","error_message":"token expired"}');
  ok(accioStream.frameIsError(snakeErr), "Accio 错误帧判定（snake_case）");
  const done = accioStream.parseFrame("[DONE]");
  eq(done, null, "Accio [DONE] 返回 null");
  // Translator 聚合：工具调用分片拼接（argsJson 字符串里的双引号在 JSON 里要转义为 \"）
  const t = new accioStream.Translator("id", "m");
  t.consume(accioStream.parseFrame('{"content":{"parts":[{"functionCall":{"id":"c1","name":"read","argsJson":"{\\"p\\":\\""}}]}}'));
  t.consume(accioStream.parseFrame('{"content":{"parts":[{"functionCall":{"id":"c1","name":"read","argsJson":"1\\"}"}}]}}'));
  const calls = t.finalToolCalls();
  eq(calls.length, 1, "Accio 工具调用分片聚为一条");
  eq(calls[0].function.name, "read", "Accio 工具名");
  // turnComplete 收尾
  const t2 = new accioStream.Translator("id", "m");
  t2.consume(accioStream.parseFrame('{"turnComplete":true,"finishReason":"STOP","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}'));
  eq(t2.finalFinishReason(), "stop", "Accio finishReason STOP→stop");
  eq(t2.usage.prompt_tokens, 10, "Accio usage prompt");
  eq(t2.usage.completion_tokens, 5, "Accio usage completion");
})();

// ===== Accio 目录：v1 数组形态 + 大小写查找 + 思考档位落点 =====
(function testAccioModels() {
  const payload = { success: true, data: [{ provider: "openai", modelList: [
    { modelCode: "1Helix-X", modelName: "1Helix-X", modelDisplayName: "Claude Sonnet 4.6", visible: true, protocol: "responses", contextWindow: 1000000, multimodal: true, reasoningEfforts: ["low", "high"] },
    { modelCode: "gemini-3-flash", modelDisplayName: "Gemini 3 Flash", visible: true, protocol: "", reasoningEfforts: ["low", "high"] },
    { modelCode: "hidden-x", modelDisplayName: "Hidden", visible: false },
  ] }] };
  const parsed = accioModels.parseCatalog(payload);
  eq(parsed.length, 2, "Accio 目录过滤 visible:false");
  eq(parsed[0].id, "claude-sonnet-4-6", "Accio STABLE_IDS 接回老名字");
  eq(parsed[0].upstreamKey, "1Helix-X", "Accio upstreamKey 存代号");
  eq(parsed[0].protocolKind, "properties", "Accio protocol=responses → properties 落点");
  eq(parsed[1].protocolKind, "top", "Accio 空 protocol → top 落点");
})();

// ===== CodeArts 流内错误：额度信封 + 带内容不判故障 + 成功码 =====
(function testCodeArtsFault() {
  const quota = caFault.streamFrameFault('{"error_code":"InferHub.4291.200","error_msg":"insufficient quota","details":[{"error_code":"InferHub.4291.200","error_msg":"requestId: abc"}]}');
  eq(quota && quota.status, 403, "CodeArts 额度信封 → 403");
  const rate = caFault.streamFrameFault('{"error_code":"InferHub.4291.200","error_msg":"rate limit"}');
  eq(rate && rate.status, 429, "CodeArts 限流 → 429");
  eq(caFault.streamFrameFault('{"error_code":"0000","error_msg":"success"}'), null, "CodeArts 成功码不判故障");
  eq(caFault.streamFrameFault('{"error_code":"0","choices":[{"delta":{"content":"hi"}}]}'), null, "CodeArts 带内容不判故障");
  eq(caFault.streamFrameFault('{"choices":[{"index":0,"delta":{"content":"2"},"finish_reason":"stop"}]}'), null, "CodeArts 普通增量不判故障");
  eq(caFault.streamFrameFault('[DONE]'), null, "CodeArts [DONE] 不判故障");
})();

// ===== CodeArts 脱敏：三种拼法 + 后缀残段 =====
(function testCodeArtsRedact() {
  const secret = "AKIA-SECRET-VALUE-12345";
  const redacted = caRedact.redactValues(`auth=${secret} and ${secret.slice(0, 12)}`, [secret], true);
  ok(!redacted.includes(secret), "CodeArts 脱敏盖原文");
  ok(redacted.includes("[REDACTED]"), "CodeArts 脱敏占位");
})();

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
