// ModelScope（魔搭）渠道自测：离线结构断言 + LIVE 只读探针
// 跑法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-modelscope-selftest.cjs
//      LIVE 探针需 LOBSTER_SELFTEST_LIVE=1 风格的环境变量：MODELSCOPE_SELFTEST_LIVE=1 + MODELSCOPE_TOKEN
//
// ⚠ 本自测**绝不调用 checkin()**——那会执行最多 20 次公开星标（有对外可见副作用）。
//   只验证只读路径（queryCredits / checkinStatus / fetchModels / fetchLikeTargets）与结构契约。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ms-selftest-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

const LIVE = process.env.MODELSCOPE_SELFTEST_LIVE === "1";
const TOKEN = process.env.MODELSCOPE_TOKEN || "";

let pass = 0;
let fail = 0;
const failures = [];
async function T(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${(e && e.message) || e}`);
    console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

(async () => {
  const rules = require("../electron/backend/proxy/rules.cjs");
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  rules.init();
  store.open();
  const ad = adapters.get("modelscope");

  console.log(`sandbox: ${SANDBOX}\n`);

  // ===== T1 注册一致性（红线：CHANNELS 与 ADAPTERS 必须同步） =====
  await T("T1 modelscope 已在 CHANNELS 与 ADAPTERS 双注册", () => {
    assert.ok(store.CHANNELS.some((c) => c.id === "modelscope"), "CHANNELS 应含 modelscope");
    assert.ok(adapters.ADAPTERS.modelscope, "ADAPTERS 应含 modelscope");
    const ch = store.CHANNELS.map((c) => c.id);
    const ap = Object.keys(adapters.ADAPTERS);
    assert.deepStrictEqual(ch.filter((x) => !ap.includes(x)), [], "CHANNELS 有渠道缺适配器");
    assert.deepStrictEqual(ap.filter((x) => !ch.includes(x)), [], "ADAPTERS 有渠道未注册");
  });

  // ===== T2 适配器接口完整性 =====
  await T("T2 适配器实现必需接口（models/mapModel/chat/queryCredits/checkinStatus/checkin/fetchModels）", () => {
    for (const m of ["models", "mapModel", "chat", "queryCredits", "checkinStatus", "checkin", "fetchModels"]) {
      assert.strictEqual(typeof ad[m], "function", `${m} 应为函数`);
    }
  });

  // ===== T3 mapModel：含斜杠 id 与简写回退 =====
  await T("T3 mapModel 处理斜杠 id 与简写", () => {
    assert.strictEqual(ad.mapModel("deepseek-ai/DeepSeek-V4.1-Flash"), "deepseek-ai/DeepSeek-V4.1-Flash", "全名应原样");
    assert.strictEqual(ad.mapModel("DeepSeek-V4.1-Flash"), "deepseek-ai/DeepSeek-V4.1-Flash", "简写应补 owner");
    assert.strictEqual(ad.mapModel("GLM-5.3-Flash"), "ZhipuAI/GLM-5.3-Flash", "GLM 简写应补 owner");
    assert.strictEqual(ad.mapModel("unknown-model-x"), "unknown-model-x", "未知模型原样透传（不猜）");
  });

  // ===== T4 静态目录：GLM-5.3-Flash 必须在（清单≠全集的补偿） =====
  await T("T4 静态目录含 GLM-5.3-Flash（不在上游 /v1/models 但直调可用）", () => {
    const ids = ad.models();
    assert.ok(ids.includes("ZhipuAI/GLM-5.3-Flash"), "目录应含 ZhipuAI/GLM-5.3-Flash");
    assert.ok(ids.includes("deepseek-ai/DeepSeek-V4.1-Flash"), "目录应含 DeepSeek-V4.1-Flash");
    assert.ok(ids.length >= 20, `目录模型数应 ≥20，实际 ${ids.length}`);
  });

  // ===== T5 rewriteBody：max_completion_tokens 翻译 + stream_options 注入（usage 修复的回归锁） =====
  await T("T5 rewriteBody 注入 stream_options.include_usage（usage 恒为 0 的修复）", () => {
    const out = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", stream: true, max_completion_tokens: 128 });
    assert.strictEqual(out.max_tokens, 128, "max_completion_tokens 应翻译为 max_tokens");
    assert.strictEqual(out.max_completion_tokens, undefined, "max_completion_tokens 应删除");
    assert.deepStrictEqual(out.stream_options, { include_usage: true }, "流式必须注入 include_usage");
    assert.strictEqual(out.model, "deepseek-ai/DeepSeek-V4.1-Flash", "model 应归一");
    // 非流式不应注入（无意义且可能被上游拒）
    const out2 = ad.rewriteBody("GLM-5.3-Flash", { stream: false });
    assert.strictEqual(out2.stream_options, undefined, "非流式不应注入 stream_options");
  });

  // ===== T6 apiHeaders：三头同发 + 浏览器上下文（风控必需） =====
  await T("T6 apiHeaders 三头同发且带 Origin/Referer/UA", () => {
    const h = ad.apiHeaders("ms-test-token");
    assert.strictEqual(h.authorization, "Bearer ms-test-token");
    assert.strictEqual(h["OpenAPI-Token"], "ms-test-token", "OpenAPI-Token 头必需");
    assert.strictEqual(h["X-Modelfun-Token"], "ms-test-token", "X-Modelfun-Token 头必需");
    assert.ok(h.origin && h.referer && h["user-agent"], "浏览器上下文头必需（缺则被风控忽略）");
  });

  // ===== T7 配置键齐备 =====
  await T("T7 rules 配置键齐备（魔粒控制面 + 任务规则键 + 安全阀）", () => {
    const c = rules.get("headers.json").modelscope;
    for (const k of ["chatUrl", "modelsUrl", "apiBase", "balancePath", "earnRulesPath", "transactionsPath", "mcpServersPath", "starPathPrefix", "ruleDailyActive", "ruleAliyunBind", "ruleLike", "likeHardCap"]) {
      assert.ok(c[k] !== undefined && c[k] !== "", `配置缺 ${k}`);
    }
    assert.strictEqual(c.ruleDailyActive, "daily_active");
    assert.strictEqual(c.ruleLike, "interaction_like");
    assert.ok(Number(c.likeHardCap) >= 20, "点赞安全阀应 ≥ 每日上限");
  });

  // ===== T8 状态与动作分离（红线：checkinStatus 不得有副作用） =====
  // ⚠ 注意：必须先在源码里定位 `const modelscope = {` 块再在其内查找——
  //   全文件 indexOf("async checkin(...)") 会命中 trae（文件里第一个实现），
  //   断言会张冠李戴（本测试初版即踩此坑）。
  const srcAll = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
  const msStart = srcAll.indexOf("const modelscope = {");
  const msEnd = srcAll.indexOf("const lobster = {", msStart);
  const msSrc = msStart > 0 && msEnd > msStart ? srcAll.slice(msStart, msEnd) : "";
  const fnBody = (name, nextName) => {
    const a = msSrc.indexOf(name);
    const b = msSrc.indexOf(nextName, a);
    return a >= 0 && b > a ? msSrc.slice(a, b) : (a >= 0 ? msSrc.slice(a) : "");
  };

  await T("T8 checkinStatus 与 checkin 是两个方法（状态只读，动作有副作用）", () => {
    assert.ok(msSrc.length > 0, "应能定位 modelscope 适配器块");
    assert.notStrictEqual(ad.checkinStatus, ad.checkin, "必须分离");
    const body = fnBody("async checkinStatus(account, secrets) {", "async checkin(account, secrets) {");
    assert.ok(body.length > 0, "应能定位 checkinStatus 函数体");
    assert.ok(!/likeOne\(/.test(body), "checkinStatus 不得调用 likeOne（会产生公开星标）");
    assert.ok(!/method:\s*"PUT"/.test(body), "checkinStatus 不得发 PUT（只读契约）");
  });

  // ===== T9 点赞幂等设计（读 today_used 决定次数） =====
  await T("T9 checkin 幂等：按 today_used/today_remain 计算剩余额度", () => {
    const body = fnBody("async checkin(account, secrets) {", "async fetchLikeTargets");
    assert.ok(body.length > 0, "应能定位 checkin 函数体");
    assert.ok(/today_used/.test(body), "checkin 应读 today_used");
    assert.ok(/remain/.test(body), "checkin 应算剩余额度");
    assert.ok(/likeHardCap/.test(body), "checkin 应受安全阀约束");
  });

  // ===== T10 离线：非对象帧守卫存在（本仓库既有约定） =====
  await T("T10 chat 含非对象帧守卫（防 null/数组帧中断整条流）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = src.indexOf("const modelscope = {");
    const body = src.slice(i, i + 12000);
    assert.ok(/typeof data !== "object"/.test(body), "应有非对象帧类型判断");
    assert.ok(/Array\.isArray\(data\)/.test(body), "应排除数组帧");
  });

  // ===== T11 LIVE：余额（只读） =====
  await T("T11 LIVE queryCredits 返回魔粒余额", async () => {
    if (!LIVE || !TOKEN) { console.log("      (跳过：需 MODELSCOPE_SELFTEST_LIVE=1 + MODELSCOPE_TOKEN)"); return; }
    const r = await ad.queryCredits({ id: "probe" }, { token: TOKEN });
    assert.ok(Number.isFinite(r.credits), `余额应为数字，实际 ${JSON.stringify(r)}`);
    console.log(`      余额 = ${r.credits} 魔粒`);
  });

  // ===== T12 LIVE：签到状态（只读，不得产生副作用） =====
  await T("T12 LIVE checkinStatus 返回每日任务进度（纯只读）", async () => {
    if (!LIVE || !TOKEN) { console.log("      (跳过：需 LIVE + TOKEN)"); return; }
    const r = await ad.checkinStatus({ id: "probe" }, { token: TOKEN });
    assert.strictEqual(r.ok, true, `应成功：${r.message}`);
    assert.ok(typeof r.likeRemain === "number", "应报告点赞剩余额度");
    assert.ok(r.message && r.message.length > 0, "应有可读描述");
    console.log(`      ${r.message}`);
  });

  // ===== T13 LIVE：上游模型清单 =====
  await T("T13 LIVE fetchModels 拉到上游清单（≥30）", async () => {
    if (!LIVE || !TOKEN) { console.log("      (跳过：需 LIVE + TOKEN)"); return; }
    const r = await ad.fetchModels({ id: "probe" }, { token: TOKEN });
    assert.strictEqual(r.ok, true, `应成功：${r.message || ""}`);
    assert.ok(r.models.length >= 30, `模型数应 ≥30，实际 ${r.models.length}`);
    console.log(`      上游清单 ${r.models.length} 个`);
  });

  // ===== T14 LIVE：点赞目标发现（只读） =====
  await T("T14 LIVE fetchLikeTargets 发现未星标目标（只读）", async () => {
    if (!LIVE || !TOKEN) { console.log("      (跳过：需 LIVE + TOKEN)"); return; }
    const tg = await ad.fetchLikeTargets({ token: TOKEN }, 5);
    assert.ok(Array.isArray(tg), "应返回数组");
    if (tg.length) {
      assert.ok(tg[0].path && tg[0].name, "目标应含 path/name");
      console.log(`      取到 ${tg.length} 个：${tg.map((t) => t.key).join(", ")}`);
    } else { console.log("      (无未星标目标——今日可能已点满)"); }
  });

  // ===== T15 LIVE：真实对话（含 usage 修复回归） =====
  await T("T15 LIVE chat 出流且 usage 非 0（stream_options 修复回归）", async () => {
    if (!LIVE || !TOKEN) { console.log("      (跳过：需 LIVE + TOKEN)"); return; }
    let txt = "", usage = null, err = null;
    await ad.chat({ account: { id: "probe" }, secrets: { token: TOKEN }, model: "deepseek-ai/DeepSeek-V4.1-Flash",
      body: { model: "deepseek-ai/DeepSeek-V4.1-Flash", stream: true, max_tokens: 200, messages: [{ role: "user", content: "只回复两个字：正常" }] },
      emit: (ev) => {
        if (ev.type === "delta" && ev.delta && typeof ev.delta.content === "string") txt += ev.delta.content;
        else if (ev.type === "usage") usage = ev.usage;
        else if (ev.type === "error") err = ev;
      } });
    assert.ok(!err, `不应有错误：${JSON.stringify(err)}`);
    assert.ok(txt.trim().length > 0, "应有正文");
    assert.ok(usage && usage.completion_tokens > 0, `usage 应非 0，实际 ${JSON.stringify(usage)}`);
    console.log(`      正文="${txt.trim().slice(0, 10)}" usage=${JSON.stringify(usage)}`);
  });

  // ===== T16 OAuth 配置齐备（动态注册 + 端点 + scope） =====
  await T("T16 OAuth 配置齐备（动态注册端点 / authorize / token / userinfo / scope）", () => {
    const c = rules.get("headers.json").modelscope;
    for (const k of ["oauthAuthorizeUrl", "oauthTokenUrl", "oauthUserinfoUrl", "oauthRegisterUrl", "oauthScopes", "tokenPageUrl", "oauthTokenPrefix"]) {
      assert.ok(c[k] !== undefined && c[k] !== "", `OAuth 配置缺 ${k}`);
    }
    assert.ok(/api-inference/.test(c.oauthScopes), "scope 必须含 api-inference（调用推理的授权项）");
    assert.ok(/openid/.test(c.oauthScopes), "scope 必须含 openid（OAuth 规范必选）");
    assert.strictEqual(c.oauthTokenPrefix, "ms_oauth", "OAuth 令牌前缀实测为 ms_oauth");
  });

  // ===== T17 OAuth 错误藏在 HTTP 200 里（本渠道最易踩的坑） =====
  await T("T17 源码级断言：OAuth 换令牌/续期必须检查 body.error（不能只看状态码）", () => {
    const disc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "discovery.cjs"), "utf8");
    const fnBody = (name, nextName) => {
      const a = disc.indexOf(name);
      const b = nextName ? disc.indexOf(nextName, a) : a + 3000;
      return a >= 0 && b > a ? disc.slice(a, b) : (a >= 0 ? disc.slice(a, a + 3000) : "");
    };
    const ex = fnBody("async function exchangeModelScopeCode", "async function refreshModelScopeToken");
    const rf = fnBody("async function refreshModelScopeToken", "function saveModelScopeAccount");
    assert.ok(ex.length > 0 && rf.length > 0, "应能定位两个 OAuth 函数");
    assert.ok(/d\.error/.test(ex), "exchangeModelScopeCode 必须检查 body.error");
    assert.ok(/d\.error/.test(rf), "refreshModelScopeToken 必须检查 body.error");
  });

  // ===== T18 refresh 轮换持久化（一次性轮换的回归锁） =====
  await T("T18 refresh 轮换：适配器声明 rotated 且续期后回写新 refresh", () => {
    const adSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = adSrc.indexOf("const modelscope = {");
    const body = adSrc.slice(i, adSrc.indexOf("const lobster = {", i));
    assert.ok(/async refreshToken/.test(body), "适配器应有 refreshToken");
    assert.ok(/rotated/.test(body), "应回报 rotated（轮换语义）");
    assert.ok(/oauthClientId/.test(body) && /oauthClientSecret/.test(body), "应读 meta 里的 OAuth 客户端信息");
    // 循环依赖防线：适配器不得 require discovery
    assert.ok(!/require\(["']\.\/discovery/.test(adSrc), "adapters.cjs 不得 require discovery（循环依赖）");
    assert.ok(/setModelScopeRefresh/.test(adSrc), "应有注入点 setModelScopeRefresh");
  });

  // ===== T19 令牌形态判别（OAuth vs 自建令牌） =====
  await T("T19 令牌形态判别：ms_oauth 走 OAuth，ms- 走粘贴", () => {
    const disc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "discovery.cjs"), "utf8");
    const i = disc.indexOf("async function importModelScopeToken");
    const body = disc.slice(i, i + 2000);
    assert.ok(/oauthTokenPrefix/.test(body), "粘贴路径应识别 OAuth 令牌前缀并拒绝");
    assert.ok(/userInfoPath/.test(body), "粘贴路径应校验令牌有效性（打 users/me）");
    assert.ok(/username/.test(body), "uid 应取自真实 username（不能用路径回显）");
  });

  // ===== T20 LIVE：OAuth 动态注册（只读探测，不产生账号） =====
  await T("T20 LIVE OAuth 动态注册可用（POST /oauth/register）", async () => {
    if (!LIVE) { console.log("      (跳过：需 MODELSCOPE_SELFTEST_LIVE=1)"); return; }
    const c = rules.get("headers.json").modelscope;
    const body = JSON.stringify({
      client_name: "AgentHub selftest",
      redirect_uris: ["http://127.0.0.1:18099/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
    const r = await adapters.httpJson(c.oauthRegisterUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": c.userAgent },
      body,
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    assert.strictEqual(r.status, 200, `注册应 200，实际 ${r.status} ${r.message || ""}`);
    assert.ok(r.data && r.data.client_id, "应返回 client_id");
    assert.ok(r.data && r.data.client_secret, "应返回 client_secret");
    console.log(`      client_id=${String(r.data.client_id).slice(0, 8)}… ✅`);
  });

  // ===== T21 LIVE：OIDC 元数据可达 =====
  await T("T21 LIVE OIDC 元数据可达且声明 authorization_code + refresh_token", async () => {
    if (!LIVE) { console.log("      (跳过：需 LIVE)"); return; }
    const c = rules.get("headers.json").modelscope;
    const r = await adapters.httpJson(c.oidcMetadataUrl, { method: "GET", headers: { accept: "application/json", "user-agent": c.userAgent } })
      .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    assert.strictEqual(r.status, 200, `元数据应 200，实际 ${r.status}`);
    assert.ok(r.data && r.data.authorization_endpoint, "应声明 authorization_endpoint");
    assert.ok(Array.isArray(r.data.grant_types_supported) && r.data.grant_types_supported.includes("refresh_token"), "应支持 refresh_token");
    console.log(`      issuer=${r.data.issuer}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("\nfailures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})();
