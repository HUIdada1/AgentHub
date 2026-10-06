// 决定性实验：魔搭 API-Inference 到底支不支持前缀缓存？prompt_cache_key 有没有用？
//
// 背景：用户观察到「魔搭的缓存命中是 0」。两种可能：
//   ① 上游本就不做前缀缓存（那 cached_tokens 恒为 0，属正常）
//   ② 上游支持但需要某个开关/字段（那我们的适配器漏了注入）
// 本探针用一个长公共前缀连发两次，读 usage.prompt_tokens_details.cached_tokens 判定。
//
// 用法：node tools/probe-modelscope-cache.cjs   （需 MODELSCOPE_TOKEN 环境变量）
"use strict";
const https = require("node:https");

const TOKEN = process.env.MODELSCOPE_TOKEN || "";
const HOST = "api-inference.modelscope.cn";
const MODEL = process.env.MODELSCOPE_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash";

function post(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = https.request(
      {
        hostname: HOST,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: 120000,
      },
      (rs) => {
        let d = "";
        rs.on("data", (c) => (d += c));
        rs.on("end", () => {
          let j = null;
          try { j = JSON.parse(d); } catch { /* 非 JSON */ }
          resolve({ status: rs.statusCode, json: j, raw: d });
        });
      }
    );
    r.on("error", (e) => resolve({ status: 0, json: null, raw: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, json: null, raw: "timeout" }); });
    r.write(payload);
    r.end();
  });
}

const brief = (u) => {
  if (!u) return "(无 usage)";
  const d = u.prompt_tokens_details || {};
  return `prompt=${u.prompt_tokens} completion=${u.completion_tokens} total=${u.total_tokens}` +
    ` | prompt_tokens_details=${JSON.stringify(d)}` +
    ` | cached=${d.cached_tokens ?? u.cache_read_input_tokens ?? "（字段不存在）"}`;
};

(async () => {
  if (!TOKEN) { console.error("需要 MODELSCOPE_TOKEN 环境变量"); process.exit(2); }
  // 构造约 8k 字符的长公共前缀（前缀缓存需要足够长的稳定前缀才会命中）
  const filler = ("这是一段用于触发前缀缓存的稳定文本，包含中文与 English mixed content 0123456789。\n").repeat(90);
  const messages = [
    { role: "system", content: "你是一个测试助手，请只回复两个字：正常。\n\n" + filler },
    { role: "user", content: "只回复两个字：正常" },
  ];
  console.log("请求规模：system 前缀约 " + Math.round(filler.length / 1024) + "KB\n");

  console.log("=== A) 不带 prompt_cache_key，连发 3 次（第 2、3 次才有机会命中） ===");
  for (let i = 1; i <= 3; i++) {
    const r = await post({ model: MODEL, stream: false, max_tokens: 32, messages });
    console.log(`  第 ${i} 次: HTTP ${r.status}  ${r.status === 200 ? brief(r.json.usage) : String(r.raw).slice(0, 140)}`);
  }

  console.log("\n=== B) 带 prompt_cache_key（固定值），连发 3 次 ===");
  for (let i = 1; i <= 3; i++) {
    const r = await post({ model: MODEL, stream: false, max_tokens: 32, messages, prompt_cache_key: "agenthub-probe-cache-test" });
    console.log(`  第 ${i} 次: HTTP ${r.status}  ${r.status === 200 ? brief(r.json.usage) : String(r.raw).slice(0, 140)}`);
  }

  console.log("\n=== C) 非流式与流式是否都返回 prompt_tokens_details ===");
  for (const stream of [false, true]) {
    const r = await post({ model: MODEL, stream, max_tokens: 16, messages: [{ role: "user", content: "只回复两个字：正常" }], ...(stream ? { stream_options: { include_usage: true } } : {}) });
    if (stream) {
      const frames = String(r.raw).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((x) => x && x !== "[DONE]");
      let last = null;
      for (const f of frames) { try { const j = JSON.parse(f); if (j.usage && j.usage.total_tokens) last = j.usage; } catch { /* */ } }
      console.log("  流式  : HTTP " + r.status + "  " + brief(last));
    } else {
      console.log("  非流式: HTTP " + r.status + "  " + brief(r.json && r.json.usage));
    }
  }
})();
