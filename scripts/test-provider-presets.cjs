/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *     此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 预设供应商目录闸：node scripts/test-provider-presets.cjs
//
// 这份目录是手写数据，出错的表现**全都不是报错**：
//   · id 写错 / 撞内置渠道  → 用户点预设，建不出来（或建出来把内置模型遮蔽了）
//   · 模型名没拆掉 "/"      → normalizeModels 直接拒，整个提供商存不下去
//   · 基址带 /v4 却没版本段规则 → 存得下、列表也对，但请求恒 404（最难查的一类）
//   · 缺 max_tokens 兜底    → 长回答被截断成 MAX_TOKENS，客户端只看到"回答不完整"
// 所以这里既验数据，也**真打一次环回上游**验出站 URL——只验数据会漏掉最后一类。
//
// 只碰 AGENTHUB_DATA_DIR 指向的临时目录与 127.0.0.1，不联网、不碰真实账号。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-provider-presets-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const catalog = require(path.join(ROOT, "electron/backend/proxy/provider-presets.cjs"));
const provider = require(path.join(ROOT, "electron/backend/proxy/provider.cjs"));
const store = require(path.join(ROOT, "electron/backend/proxy/store.cjs"));
const { makeAdapter } = require(path.join(ROOT, "electron/backend/localgw/standard/factory.cjs"));
const { compatUrl } = require(path.join(ROOT, "electron/backend/localgw/standard/openai-compat.cjs"));

let pass = 0;
let failed = 0;
function ok(cond, name, got) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}` + (got === undefined ? "" : ` → got ${JSON.stringify(got).slice(0, 300)}`));
  }
}

async function main() {
  // ===== ① 目录自身 =====
  console.log("① 目录完整性");
  {
    const problems = catalog.audit();
    ok(problems.length === 0, "audit() 零问题（标识 / 协议 / 鉴权 / 基址 / 模型名去重）", problems);
    ok(catalog.PRESETS.length === 34, "34 条（33 个渠道 + 基元律动）", catalog.PRESETS.length);

    const ids = catalog.PRESETS.map((p) => p.id);
    ok(new Set(ids).size === ids.length, "标识互不重复");
    ok(ids.every((id) => !store.isBuiltinChannel(id)), "不占内置渠道的标识", ids.filter((id) => store.isBuiltinChannel(id)));
    const reserved = new Set(["auto", "all", "v1", "models", "healthz", "status", "readyz"]);
    ok(ids.every((id) => !reserved.has(id)), "不占网关保留名", ids.filter((id) => reserved.has(id)));
    ok(catalog.PRESETS.every((p) => p.display && p.brand), "每条都有中文名与图标 key（缺了卡片是白块）");
    ok(catalog.PRESETS.filter((p) => p.models.length === 0).map((p) => p.id).join() === "tokenrhythm", "只有基元律动不预置模型（其余必须带清单）");

    const kinds = new Set(catalog.PRESETS.map((p) => p.kind));
    ok([...kinds].every((k) => catalog.KINDS.includes(k)), "协议档都落在 KINDS 内", [...kinds]);
    ok(kinds.size === 3, "三档协议都被用到（少一档说明有一批渠道被改成了别的协议）", [...kinds]);
    const byKind = [...kinds].map((k) => `${k}=${catalog.PRESETS.filter((p) => p.kind === k).length}`).join(" ");
    console.log(`     协议分布：${byKind}`);
  }

  // ===== ② 模型名拆分 =====
  console.log("\n② 模型名拆分（含 / 的必须拆成 model + upstream）");
  {
    const bad = [];
    for (const p of catalog.PRESETS) {
      for (const m of p.models) {
        const name = typeof m === "string" ? m : m.model;
        if (String(name).includes("/")) bad.push(`${p.id}/${name}`);
      }
    }
    ok(bad.length === 0, "没有残留带 / 的客户端模型名", bad);
    const or = catalog.get("openrouter");
    const sample = or.models.find((m) => m.upstream && m.upstream.includes("/"));
    ok(!!sample, "OpenRouter 至少有一条带厂商前缀的映射", or.models[0]);
    ok(sample.model === sample.upstream.split("/").pop(), "客户端名 = 上游 id 的末段", sample);
    const sf = catalog.get("siliconflow-cn");
    ok(sf.models.every((m) => m.upstream && m.upstream.includes("/")), "硅基流动全部保留完整 id 作为 upstream", sf.models);
  }

  // ===== ③ fill()：创建时的补全 =====
  console.log("\n③ fill() 补全（模型行必须带输出兜底，否则 Anthropic 档退 8192）");
  {
    const f = catalog.fill("zai-api", {});
    ok(f.kind === "anthropic_messages" && f.auth === "bearer" && f.id === "zai-api", "协议与鉴权按预设补", [f.kind, f.auth]);
    ok(f.models.length === 2 && f.models.every((m) => m.maxOutputTokens === 128000), "模型行写入 defaultMaxTokens", f.models);
    const custom = catalog.fill("zai-api", { id: "my-zai", baseUrl: "https://relay.example.com/v1", models: [{ model: "x" }] });
    ok(custom.id === "my-zai" && custom.baseUrl === "https://relay.example.com/v1", "用户显式给的 id / 地址优先", [custom.id, custom.baseUrl]);
    ok(custom.models.length === 1 && custom.models[0].model === "x", "用户显式给了模型清单就不再覆盖");
    ok(catalog.fill("nope", {}) === null, "未知预设回 null（调用方据此报错）");
  }

  // ===== ④ 真建一遍：34 条全部能落库 =====
  console.log("\n④ 逐条创建（点预设建不出来的，这里必红）");
  {
    const fails = [];
    for (const p of catalog.PRESETS) {
      const r = provider.create({ preset: p.id });
      if (!r.ok) { fails.push(`${p.id}: ${r.message}`); continue; }
      if (r.provider.kind !== p.kind) fails.push(`${p.id}: kind 存成 ${r.provider.kind}`);
      if (r.provider.auth !== p.auth) fails.push(`${p.id}: auth 存成 ${r.provider.auth}`);
      if (r.provider.models.length !== p.models.length) fails.push(`${p.id}: 模型数 ${r.provider.models.length}≠${p.models.length}`);
      if (!r.provider.domain) fails.push(`${p.id}: domain 为空`);
    }
    ok(fails.length === 0, "34 条全部创建成功且 kind/auth/模型数一致", fails);
    ok(store.listProviders().length === 34, "落库 34 行", store.listProviders().length);
    const again = provider.create({ preset: "zai-api" });
    ok(!again.ok && /已存在/.test(again.message), "同 id 重复创建被拒（标识即路由前缀）", again.message);
    const bogus = provider.create({ preset: "no-such-preset" });
    ok(!bogus.ok && /不存在/.test(bogus.message), "未知预设报「不存在」而不是静默建空行", bogus.message);
  }

  // ===== ⑤ 出站 URL：真打环回上游 =====
  console.log("\n⑤ 出站 URL（基址带 /v4 的拼错就是恒 404，只有真打能验出来）");
  {
    let last = null;
    const server = http.createServer((req, res) => {
      last = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;

    const bad = [];
    const urls = [];
    for (const p of catalog.PRESETS) {
      const norm = provider.normalizeBaseUrl(p.baseUrl);
      if (!norm.ok) { bad.push(`${p.id}: 基址不合法`); continue; }
      const localBase = origin + new URL(norm.url).pathname.replace(/\/$/, "");
      const ad = makeAdapter({ id: p.id, kind: p.kind, baseUrl: localBase, auth: p.auth, models: p.models.slice(0, 1), defaultMaxTokens: p.defaultMaxTokens }, { firstByteBudgetMs: () => 5000 });
      last = null;
      try {
        await ad.chat({ secrets: { token: "k" }, model: `${p.id}/${p.models.length ? (p.models[0].model || p.models[0]) : "m"}`, body: { messages: [{ role: "user", content: "ping" }] }, emit: () => {} });
      } catch (e) {
        bad.push(`${p.id}: 请求抛错 ${e && e.message}`);
        continue;
      }
      urls.push({ id: p.id, kind: p.kind, url: last });
      const leaf = p.kind === "anthropic_messages" ? "/v1/messages" : p.kind === "openai_responses" ? "/v1/responses" : "/chat/completions";
      if (!String(last).endsWith(leaf)) bad.push(`${p.id}: 端点 ${last} 不以 ${leaf} 结尾`);
      if (/\/v1\/v1\//.test(last) || /\/v[2-9]\d*\/v1\//.test(last)) bad.push(`${p.id}: 版本段重复 ${last}`);
    }
    ok(bad.length === 0, "34 条出站端点全部正确（无 /v1/v1、无 /v4/v1）", bad);

    const zai = urls.find((u) => u.id === "zai-standard-api");
    ok(zai && zai.url === "/api/paas/v4/chat/completions", "智谱 /api/paas/v4 不再补 /v1（方案 §3.2 的核心修复）", zai && zai.url);
    const big = urls.find((u) => u.id === "bigmodel-standard-api");
    ok(big && big.url === "/api/paas/v4/chat/completions", "BigModel 同一条规则", big && big.url);
    const ark = urls.find((u) => u.id === "volcengine-coding-plan");
    ok(ark && ark.url === "/api/coding/v1/messages", "火山 Coding Plan = /api/coding/v1/messages", ark && ark.url);
    const oc = urls.find((u) => u.id === "opencode-zen-responses");
    ok(oc && oc.url === "/zen/v1/responses", "OpenCode Zen Responses 端点", oc && oc.url);
    const sf = urls.find((u) => u.id === "siliconflow-cn");
    ok(sf && sf.url === "/v1/chat/completions", "硅基流动走标准 /v1", sf && sf.url);

    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  // ===== ⑥ 与 compatUrl 的口径一致（防止两处各写一份规则） =====
  console.log("\n⑥ 版本段规则与 compatUrl 同源");
  {
    ok(compatUrl("https://x.example.com/api/paas/v4", "chat/completions") === "https://x.example.com/api/paas/v4/chat/completions", "/v4 不补 /v1");
    ok(compatUrl("https://x.example.com/api/v3", "chat/completions") === "https://x.example.com/api/v3/chat/completions", "/v3 不补 /v1");
    ok(compatUrl("https://x.example.com", "chat/completions") === "https://x.example.com/v1/chat/completions", "无版本段的根仍补 /v1（存量行为不变）");
    ok(compatUrl("https://x.example.com/openai", "chat/completions") === "https://x.example.com/openai/v1/chat/completions", "带挂载路径的根仍补 /v1");
  }

  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
