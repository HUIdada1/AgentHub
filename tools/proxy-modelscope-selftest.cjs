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
// 默认在沙箱里跑（绝不碰真实号池）。T27/T28 需要真实号池的账号来验证 Cookie 落地情况，
// 故提供显式开关 MODELSCOPE_SELFTEST_REAL_DATA=1：只把数据目录指到真实目录，
// 且这两项**只读**（绝不调用 checkin/点赞）。
const REAL_DATA = process.env.MODELSCOPE_SELFTEST_REAL_DATA === "1";
process.env.AGENTHUB_DATA_DIR = REAL_DATA ? path.join(process.env.APPDATA || "", "agenthub") : SANDBOX;

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

  // ===== T5b prompt_cache_key：与其它渠道行为对齐（上游不提供缓存字段，但仍注入） =====
  // 回归锁两件事：
  //  ① 注入形态正确（账号段硬隔离；会话段用消息指纹；不引入 conversation_id 等厂商私有字段）
  //  ② **rewriteBody 必须能接住 account 形参**——曾漏改签名导致运行时 ReferenceError
  //     （语法检查通过、但每次对话必 500）
  await T("T5b rewriteBody 注入 prompt_cache_key 且不引入 conversation_id", () => {
    const msg = [{ role: "user", content: "hi" }];
    const withAcc = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", messages: msg }, { uid: "msub_abc123" });
    assert.ok(withAcc.prompt_cache_key, "应注入 prompt_cache_key");
    assert.ok(withAcc.prompt_cache_key.startsWith("agenthub-msub_abc"), `账号段应为 uid 前 8 位，实际 ${withAcc.prompt_cache_key}`);
    // 厂商私有字段不得出现（严格的 OpenAI 兼容端点可能 400）
    assert.strictEqual(withAcc.conversation_id, undefined, "不应注入 conversation_id（WB/raccoon 私有字段）");

    // 会话段稳定：同一 messages 多次调用键相同；不同 messages 键不同
    const again = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", messages: msg }, { uid: "msub_abc123" });
    assert.strictEqual(again.prompt_cache_key, withAcc.prompt_cache_key, "同一会话键必须稳定");
    const other = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", messages: [{ role: "user", content: "别的" }] }, { uid: "msub_abc123" });
    assert.notStrictEqual(other.prompt_cache_key, withAcc.prompt_cache_key, "不同会话键应不同");

    // 跨账号硬隔离：uid 不同则键必不同（防命中错账号的前缀缓存）
    const otherAcc = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", messages: msg }, { uid: "msub_zzz999" });
    assert.notStrictEqual(otherAcc.prompt_cache_key, withAcc.prompt_cache_key, "跨账号键必须不同");

    // account 缺失不得抛错（换号前/异常路径）——锁住刚踩过的 ReferenceError
    const noAcc = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", messages: msg });
    assert.ok(noAcc.prompt_cache_key, "account 缺失也应降级注入（不得抛错）");

    // 调用方已给出 key 则尊重原值
    const preset = ad.rewriteBody("DeepSeek-V4.1-Flash", { model: "DeepSeek-V4.1-Flash", messages: msg, prompt_cache_key: "KEEP" }, { uid: "u" });
    assert.strictEqual(preset.prompt_cache_key, "KEEP", "已有 key 不应被覆盖");
  });

  // ===== T5c chat 必须把 account 传给 rewriteBody（签名与调用点同源） =====
  await T("T5c chat 调用点传入 account（防止签名改了、调用点漏改）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = src.indexOf("const modelscope = {");
    const j = src.indexOf("const lobster = {", i);
    const block = src.slice(i, j > i ? j : src.length);
    assert.ok(/this\.rewriteBody\(model, body, account\)/.test(block), "chat 内必须以 (model, body, account) 调用");
    assert.ok(/rewriteBody\(model, body, account\)\s*\{/.test(block), "rewriteBody 签名必须含 account 形参");
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

  // ===== T22 403 前置门槛识别（双账号实测发现：绑定≠可推理，还需实名） =====
  // 背景（2026-10-06 双账号实测）：账号 A 推理 200，账号 B 403。B 的完整错误为
  //   "To use API-Inference, please make sure your associated Aliyun account is real-name verified"
  // 两个账号的 userinfo / balance 都 200 —— 说明接入链路完好，被拒是上游的实名门槛。
  // 这类错误属「账号侧可自行修复」，必须给出可操作指引，不能混成通用 502。
  // 断言方式：源码级（这两条分支无法在无凭据环境下触发真实上游 403）。
  await T("T22 403 前置门槛（未实名/未绑云）被识别为可操作提示", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = src.indexOf("const modelscope = {");
    const body = src.slice(i, src.indexOf("const lobster = {", i));
    assert.ok(/real-name|realname|实名/i.test(body), "应识别实名认证错误（real-name verified）");
    assert.ok(/bind your Alibaba Cloud account|绑定阿里云/i.test(body), "应识别未绑定阿里云错误");
    assert.ok(/accountsettings/.test(body), "提示里应带可操作的修复链接（accountsettings）");
    // 必须发生在 fetchStream 抛错路径上（403 是非 2xx，SSE pump 不会执行）
    assert.ok(/HTTP 403/.test(body), "应针对 fetchStream 抛出的 HTTP 403 做判定（而非仅 SSE 帧）");
    assert.ok(/needRealName|needBind/.test(body), "应回报可区分的标记（供上层/UI 判断）");
  });

  // ===== T23 双账号共存的结构前提（uid 唯一 + 凭据独立） =====
  await T("T23 双账号共存前提：uid 取自 userinfo.sub、凭据按账号独立存取", () => {
    const disc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "discovery.cjs"), "utf8");
    const i = disc.indexOf("async function exchangeModelScopeCode");
    const body = disc.slice(i, i + 2500);
    assert.ok(/info\.sub/.test(body), "uid 应取 userinfo.sub（OAuth 场景最稳，实测 msub_<hash>）");
    assert.ok(!/\.yid|preferred_username\s*\|\|/.test(body) || /sub/.test(body), "不得用 preferred_username 当 uid（可能改名）");
    // 落库按 uid 去重（同 uid 更新、异 uid 新增）——这是多账号共存的关键
    const s = disc.indexOf("function saveModelScopeAccount");
    const sb = disc.slice(s, s + 1800);
    assert.ok(/find\(\(a\) => a\.uid === uid\)/.test(sb), "应按 uid 查重（同号更新、异号新增）");
    assert.ok(/store\.addAccount/.test(sb), "新 uid 应新增账号（多号共存）");
  });

  // ===== T24 Cookie 双凭据通道（方案 A1 的核心设计） =====
  // 背景（2026-10-06 实测穷尽四条路径确立）：魔搭端点分两族且严格互斥，
  //   「OAuth 可用族」推理 + 魔粒；「仅 Cookie/ms- 可用族」点赞 + 令牌管理。
  //   且 ms- 令牌能点赞但不触发 daily_active（参考项目实测注释：仅 Web 会话触发日活）
  //   ⇒ Cookie 是唯一两全的凭据。本组断言锁定这套分层不被后续改动破坏。
  await T("T24 Cookie 通道：星标族用 Cookie、日活靠 webTouch、OAuth 账号无凭据时如实提示", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = src.indexOf("const modelscope = {");
    const body = src.slice(i, src.indexOf("const lobster = {", i));

    // ① 星标族必须走 starHeaders（而非 apiHeaders/OAuth 令牌）
    const likeFn = body.slice(body.indexOf("async likeOne"), body.indexOf("async trial"));
    const tgtFn = body.slice(body.indexOf("async fetchLikeTargets"), body.indexOf("async likeOne"));
    assert.ok(/starHeaders/.test(likeFn), "点赞应用 starHeaders（Cookie 优先）");
    assert.ok(/starHeaders/.test(tgtFn), "列目标应用 starHeaders");
    assert.ok(!/this\.apiHeaders/.test(likeFn), "点赞不得再用 apiHeaders（OAuth 令牌会被上游 401）");

    // ② 日活必须靠 webTouch 触碰 Web 页面 + login/info（Bearer 不计日活）
    assert.ok(/async webTouch/.test(body), "应实现 webTouch");
    assert.ok(/cookieLoginEventPaths/.test(body), "webTouch 应触碰登录事件端点");
    const ck = body.slice(body.indexOf("async webTouch"), body.indexOf("models()", body.indexOf("async webTouch")));
    assert.ok(/cookie/.test(ck), "webTouch 必须带 Cookie 头");

    // ③ 无星标族凭据时如实提示（不得静默吞成「无可点赞目标」）
    const ckIn = body.slice(body.indexOf("async checkin("), body.indexOf("async fetchLikeTargets"));
    assert.ok(/hasStarCredential/.test(ckIn), "checkin 应判定星标族凭据");
    assert.ok(/需 Web 会话|重新 OAuth 授权/.test(ckIn), "无凭据时应给出可操作提示");

    // ④ Cookie 失效要能识别并提示重新授权
    assert.ok(/needReauth|已失效/.test(body), "Cookie 失效应提示重新授权");

    // ⑤ 配置齐备
    const c = rules.get("headers.json").modelscope;
    for (const k of ["cookieTouchPaths", "cookieLoginEventPaths", "cookieDomains", "cookieMetaKey"]) {
      assert.ok(c[k], `配置缺 ${k}`);
    }
    assert.strictEqual(c.cookieMetaKey, "msCookie");
  });

  // ===== T25 Cookie 采集与落库（授权窗采集 → 加密 → accountSecrets 透传） =====
  await T("T25 Cookie 采集链路：授权窗采集 + DPAPI 加密落库 + accountSecrets 解密透传", () => {
    // ① 授权窗提供 collectCookie（整组拼接，不是只取一个）
    const idx = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "index.cjs"), "utf8");
    assert.ok(/collectCookie/.test(idx), "授权窗应提供 collectCookie");
    assert.ok(/sess\.cookies\.get/.test(idx), "collectCookie 应读 partition 的 cookie jar");
    assert.ok(/join\("; "\)/.test(idx), "应整组拼接 Cookie（魔搭登录态由多个 cookie 共同构成）");

    // ② discovery 在回调时采集，并写进账号
    const disc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "discovery.cjs"), "utf8");
    assert.ok(/collectCookie/.test(disc), "discovery 应调用 collectCookie");
    assert.ok(/beginModelScopeOAuth\(ch, onDone, helpers\)/.test(disc), "beginOAuth 应把 helpers 传给 modelscope");
    assert.ok(/mode: "window"/.test(disc), "modelscope 应优先用应用内窗口（才能采 Cookie）");

    // ③ 落库加密 + 不动旧值
    const save = disc.slice(disc.indexOf("function saveModelScopeAccount"), disc.indexOf("async function importModelScopeToken"));
    assert.ok(/config\.encryptSecret\(cookie\)/.test(save), "Cookie 应经 encryptSecret 加密落库");
    assert.ok(/msCookie/.test(save), "应存到 meta.msCookie");
    assert.ok(/nextMeta\.msCookie = existing\.meta\.msCookie/.test(save), "未采到新 Cookie 时应保留旧值（不清空可用会话）");

    // ④ accountSecrets 解密透传
    const st = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "store.cjs"), "utf8");
    const secFn = st.slice(st.indexOf("function accountSecrets"), st.indexOf("function addAccount"));
    assert.ok(/meta/.test(secFn), "accountSecrets 应带出 meta（适配器据此取 Cookie）");
    assert.ok(/config\.decryptSecret\(meta\.msCookie\)/.test(secFn), "msCookie 应解密后透传");
  });

  // ===== T26 非流式响应必须单独处理（真实根因：Content-Type 不是 SSE） =====
  // 2026-10-06 实测（两轮定位，第一轮判错根因，记此以防重犯）：
  //   魔搭 stream:false 返回**单个 application/json 对象**（Content-Type: application/json），
  //   内容在 choices[0].message.content。若直接交给 pumpSse，SseScanner 只认 `data:` 行 →
  //   整个响应解析出 **0 帧** → 客户端拿到空回复（连 finish 都没有、usage 为 0）。
  //   ⚠ 第一轮误判为「delta 空壳顶掉 message」：那层形状判断本身没错，但它落在**永远不会
  //     执行到的路径**上（响应压根没进帧处理逻辑），修了等于没修——直到实测非流式仍为空才发现。
  //   ⇒ 教训：修「数据形状」问题前，先确认那段代码真的会被执行。
  await T("T26 非流式：按 Content-Type 分流（非 SSE 直接解析 JSON 并取 message）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = src.indexOf("const modelscope = {");
    const body = src.slice(i, src.indexOf("const lobster = {", i));
    assert.ok(/looksSse/.test(body), "应按 Content-Type 判定是否 SSE");
    assert.ok(/text\\\/event-stream/i.test(body), "应识别 text/event-stream");
    assert.ok(/await resp\.text\(\)/.test(body), "非 SSE 应整体读文本再解析");
    const branchStart = body.indexOf("if (!looksSse)");
    assert.ok(branchStart > 0, "应有非流式分支");
    const branch = body.slice(branchStart, branchStart + 2200);
    assert.ok(/choice\.message/.test(branch), "非流式应取 choice.message（真身）");
    assert.ok(/emit\(\{ type: "finish"/.test(branch), "非流式应补发 finish");
    assert.ok(/emit\(\{ type: "usage"/.test(branch), "非流式应补发 usage");
  });

  // ===== T26b 非流式分支必须在 pumpSse **之前**（路径可达性，直接锁上轮踩的坑） =====
  await T("T26b 非流式分支位于 pumpSse 调用之前（保证可达）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const i = src.indexOf("const modelscope = {");
    const body = src.slice(i, src.indexOf("const lobster = {", i));
    const chatStart = body.indexOf("async chat(");
    const chat = body.slice(chatStart, body.indexOf("async queryCredits", chatStart));
    const nonSse = chat.indexOf("if (!looksSse)");
    const pump = chat.indexOf("await pumpSse(");
    assert.ok(nonSse > 0 && pump > 0, "应同时存在非流式分支与 pumpSse 调用");
    assert.ok(nonSse < pump, "非流式分支必须在 pumpSse 之前（否则不可达，修了等于没修）");
    const seg = chat.slice(nonSse, pump);
    assert.ok(/return result;/.test(seg), "非流式分支应以 return result 提前结束");
  });


  // ===== T27 LIVE Cookie 已随 OAuth 入池（存在性；不依赖 DPAPI） =====
  // ⚠ RUN_AS_NODE 下 safeStorage(DPAPI) 不可用 → decryptSecret 对 enc:v1: 返回 ""，
  //   故这里只断言「meta.msCookie 已写入且非空」（密文也算），解密后的可用性验证
  //   放在 full-Electron 探针（tools/probe-modelscope-cookie.cjs）里做。
  await T("T27 LIVE OAuth 账号已落 Cookie（meta.msCookie 非空）", async () => {
    if (!LIVE) { console.log("      (跳过：需 LIVE)"); return; }
    const store = require(path.join(__dirname, "..", "electron", "backend", "proxy", "store.cjs"));
    const rulesMod = require(path.join(__dirname, "..", "electron", "backend", "proxy", "rules.cjs"));
    rulesMod.init(); store.open();
    const withCookie = store.listAccounts("modelscope").filter((a) => String((a.meta || {}).msCookie || "").length > 10);
    if (!withCookie.length) { console.log("      (跳过：号池内无带 Cookie 的账号——需在界面完成一次 OAuth 授权)"); return; }
    const a = withCookie[0];
    console.log(`      账号 ${a.name} 已存 Cookie（${String(a.meta.msCookie).length} 字符，cookieAt=${a.meta.cookieAt ? new Date(a.meta.cookieAt).toLocaleString() : "-"}）`);
    assert.ok(withCookie.length >= 1, "应至少一个账号带 Cookie");
  });

  // ===== T28 LIVE Cookie 可用性（login/info 200；仅当 DPAPI 可解密时执行） =====
  // 这是 A1 的核心承诺验证：Cookie 能调 /api/v1 族（OAuth/ms- 令牌都做不到的路径）。
  // 只读，不做点赞写动作。
  await T("T28 LIVE Cookie 可调 login/info（日活触发端点）", async () => {
    if (!LIVE) { console.log("      (跳过：需 LIVE)"); return; }
    const store = require(path.join(__dirname, "..", "electron", "backend", "proxy", "store.cjs"));
    const rulesMod = require(path.join(__dirname, "..", "electron", "backend", "proxy", "rules.cjs"));
    rulesMod.init(); store.open();
    const ad = adapters.get("modelscope");
    const accs = store.listAccounts("modelscope").filter((a) => {
      const s = store.accountSecrets(store.getAccount(a.id));
      return !!ad.cookieHeaderOf(s);
    });
    if (!accs.length) {
      console.log("      (跳过：DPAPI 不可用（RUN_AS_NODE）或无 Cookie——用 full-Electron 探针验证)");
      return;
    }
    const a = accs[0];
    const s = store.accountSecrets(store.getAccount(a.id));
    const c = rules.get("headers.json").modelscope;
    const base = String(c.apiBase).replace(/\/+$/, "");
    const ck = ad.cookieHeaderOf(s);
    const names = ck.split("; ").map((x) => x.split("=")[0]);
    // 整组性：魔搭登录态由多个 cookie 共同构成
    assert.ok(names.length >= 5, `Cookie 应为整组（实测 30 项），实际 ${names.length} 项`);
    assert.ok(names.some((n) => /m_session_id|csrf_token|_tb_token_|cookie2/i.test(n)), "应含登录态关键项");
    const r = await adapters.httpJson(`${base}/api/v1/users/login/info`, {
      method: "GET",
      headers: { cookie: ck, accept: "application/json", "user-agent": c.userAgent, origin: base, referer: base + "/my/overview" },
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    assert.strictEqual(r.status, 200, `Cookie 调 login/info 应 200，实际 ${r.status}`);
    assert.ok(!new RegExp(c.cookieDeadRe, "i").test(JSON.stringify(r.data || "")), "Cookie 不应失效");
    console.log(`      账号 ${a.name}：${names.length} 项 Cookie，login/info 200 ✅`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("\nfailures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})();
