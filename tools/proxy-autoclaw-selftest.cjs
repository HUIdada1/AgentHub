// AutoClaw 双渠道专项自测：离线协议断言 + 本地假上游端到端链路。
// 运行：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-autoclaw-selftest.cjs
// 离线：X-Auth-Sign 签名向量 / 两域头集合互斥 / system 白名单规范化（幂等+改写表）/
//       max_tokens 归一 / 模型路由解析 / 目录条目归一 / 双区注册与配置。
// e2e：真 adapters + 假上游（随机端口）——对话 SSE 全链（头/body 断言）、目录拉取与
//      只认目录、余额聚合、签到幂等判据、刷新 400002 降级 + 不落库 + 凭证缓存生效。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");

// 独立数据目录：rules/config 落临时目录，绝不触碰真实 %APPDATA%（须在 require store/rules 之前设）
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-autoclaw-test-"));

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
};

const prompt = require("../electron/backend/proxy/autoclaw/prompt.cjs");
const headers = require("../electron/backend/proxy/autoclaw/headers.cjs");
const models = require("../electron/backend/proxy/autoclaw/models.cjs");
const rulesMod = require("../electron/backend/proxy/rules.cjs");
const storeMod = require("../electron/backend/proxy/store.cjs");

// ===== 离线协议断言 =====
function offline() {
  // ⓪ 主窗口 CSP 必须放行阿里云验证码 SDK（issue #105：v1.0.0 起 script-src 'self' 拦死
  //   o.alicdn.com，脚本加载即报「验证码组件加载失败」，国际版 OAuth 从未走通过）。
  //   这条护栏防止以后再改 CSP 时悄悄删掉放行项。SDK 实测触达：
  //   脚本 o.alicdn.com / XHR *.aliyuncs.com（动态拼端点）/ iframe+图片 *.alicdn.com / 内嵌 data: 字体
  {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const m = html.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
    assert(m, "index.html 存在 CSP meta");
    const dir = {};
    for (const part of m[1].split(";")) {
      const [k, ...v] = part.trim().split(/\s+/);
      if (k) dir[k] = v.join(" ");
    }
    assert((dir["script-src"] || "").includes("o.alicdn.com"), "CSP script-src 放行 o.alicdn.com（验证码 SDK 脚本）");
    assert((dir["connect-src"] || "").includes("*.aliyuncs.com"), "CSP connect-src 放行 *.aliyuncs.com（SDK XHR 验证端点）");
    assert((dir["connect-src"] || "").includes("*.alicdn.com"), "CSP connect-src 放行 *.alicdn.com（SDK 资源请求）");
    assert((dir["frame-src"] || "").includes("*.alicdn.com"), "CSP frame-src 放行 *.alicdn.com（SDK 会建 iframe）");
    assert((dir["font-src"] || "").includes("data:"), "CSP font-src 放行 data:（SDK 内嵌 iconfont）");
  }

  // ① X-Auth-Sign 签名向量（拼接 appId&秒级时间戳&appKey，MD5 小写）
  {
    const {ts, sign} = headers.authSign("100003", "38d2391985e2369a5fb8227d8e6cd5e5", 1760000000000);
    assert(ts === "1760000000", "签名时间戳取秒（1760000000000ms → 1760000000s）");
    const expect = crypto.createHash("md5").update(`100003&1760000000&38d2391985e2369a5fb8227d8e6cd5e5`).digest("hex");
    assert(sign === expect && sign === sign.toLowerCase(), "X-Auth-Sign = MD5(appId&ts&appKey) 小写");
    const neg = headers.authSign("100003", "38d2391985e2369a5fb8227d8e6cd5e5", -5);
    assert(neg.ts === "0", "负时间戳取 0（对齐参照实现 .max(0)）");
  }

  // ② 两域头集合（互斥断言是最易踩的三处）
  {
    const cfg = rulesMod.DEFAULTS["headers.json"].autoclaw;
    const llm = headers.llmHeaders(cfg, "tok-1", "zaicoding_glm-5.3");
    const api = headers.signedAuthHeaders(cfg, "tok-1");
    // LLM 域：X-Authorization 认证头（不是 Authorization）、禁发 X-Harness-Type、X-Tm 恒不为 linux
    assert(llm["x-authorization"] === "Bearer tok-1" && !("authorization" in llm), "LLM 域认证头是 X-Authorization");
    assert(!("x-harness-type" in llm), "LLM 域禁发 X-Harness-Type（上游对它 403 pay-view/406）");
    assert(llm["x-tm"] === "win" || llm["x-tm"] === "mac", "LLM 域 X-Tm 只发 mac/win（禁 linux）");
    assert(llm["x-request-model"] === "zaicoding_glm-5.3", "LLM 域 X-Request-Model = 完整路由 ID");
    assert(llm["x-version"] === "1.17.8", "LLM 域 X-Version = llmVersion");
    assert(llm.x_trace_id === "autoclaw-desktop", "LLM 域 trace 头照抄参照实现字面量");
    assert(/^[0-9a-f-]{36}$/.test(llm["x-request-id"]), "X-Request-Id 为 UUID 形态");
    // userapi 域：小写 authorization、必发 X-Harness-Type、签名三件套、版本门控头
    assert(api.authorization === "Bearer tok-1" && !("x-authorization" in api), "userapi 域认证头是小写 authorization");
    assert(api["x-harness-type"] === "zcode", "userapi 域必发 X-Harness-Type（客户端指纹）");
    assert(!!api["x-auth-sign"] && !!api["x-auth-timestamp"] && api["x-auth-appid"] === "100003", "userapi 域签名三件套齐备");
    assert(api["x-version"] === "1.18.5", "userapi 域 X-Version = apiVersion（版本门控）");
    assert(api["x-tm"] === "win" || api["x-tm"] === "linux", "userapi 域 X-Tm 按宿主平台如实发");
    // 匿名形态（登录链 token 空串）：整条 authorization 头不出现
    const anon = headers.signedAuthHeaders(cfg, "");
    assert(!("authorization" in anon), "匿名形态无 authorization 头");
    // 会话透传：客户端带才发，头名映射到上游三头
    const sess = headers.sessionPassthroughHeaders({
      "X-AutoClaw-Session-Id": " s1 ",
      "x-autoclaw-zcode-invocation-id": "inv-9",
      authorization: "Bearer evil",
    });
    assert(sess["X-Session-Id"] === "s1" && sess["X-ZCode-Invocation-Id"] === "inv-9" && !sess["X-Agent-Id"], "会话透传头 trim 后按映射转发");
    assert(!("Authorization" in sess), "客户端 authorization 绝不透传");
    assert(Object.keys(headers.sessionPassthroughHeaders(null)).length === 0, "无客户端头时透传为空");
  }

  // ③ system 白名单规范化
  {
    const ID = prompt.IDENTITY_LINE;
    // 中性 system：前置身份前缀，拼接形态 = 前缀 + "\n" + 原文
    const b1 = {messages: [{role: "system", content: "You are a helpful assistant."}, {role: "user", content: "hi"}]};
    prompt.normalizeSystemMessages(b1);
    assert(b1.messages[0].content.startsWith(ID + "\n\n## Tooling"), "中性 system 被前置身份前缀");
    assert(b1.messages[0].content.endsWith("\nYou are a helpful assistant."), "前缀与原文间以空行相接");
    assert(b1.messages[1].content === "hi", "user 消息一字不动");
    // 无 system：插入一条（不重排其余消息）
    const b2 = {messages: [{role: "user", content: "hi"}]};
    prompt.normalizeSystemMessages(b2);
    assert(b2.messages.length === 2 && b2.messages[0].role === "system" && b2.messages[0].content === prompt.IDENTITY_PREFIX, "无 system 时在首位插入身份前缀");
    // 幂等：重复调用不写两遍
    prompt.normalizeSystemMessages(b2);
    assert(b2.messages[0].content === prompt.IDENTITY_PREFIX, "幂等：前缀不重复");
    const b2b = {
      messages: [{
        role: "system",
        content: ID + "\n\n## Tooling\nAvailable tools are policy-filtered. Names are case-sensitive; call exactly as listed.\nextra"
      }]
    };
    prompt.normalizeSystemMessages(b2b);
    assert(b2b.messages[0].content.endsWith("extra") && b2b.messages[0].content.split(ID).length === 2, "已带身份句的 system 不重复前置");
    // 外来身份句改写（长前短后、大小写不敏感、user 消息不碰）
    const b3 = {
      messages: [
        {role: "system", content: "You are ZCode, an interactive coding agent. Follow rules."},
        {role: "system", content: [{type: "text", text: "You are Claude Code, do well."}]},
        {role: "user", content: "You are ZCode btw"},
      ]
    };
    prompt.normalizeSystemMessages(b3);
    assert(!/zcode/i.test(b3.messages[0].content), "外来身份句整名去掉（含前缀段不残留）");
    assert(b3.messages[0].content.includes("## Tooling"), "改写后仍前置 ## Tooling 段");
    assert(!/claude/i.test(b3.messages[1].content[0].text), "数组形态 system 同样被改写");
    assert(b3.messages[2].content === "You are ZCode btw", "user 消息里的身份句不碰（闸门只看 system/developer）");
    // CodeBuddy CLI 身份句改写：上游对 "You are CodeBuddy Code." 逐字指纹 406（桌面 Craft 形态
    // "You are CodeBuddy, a highly skilled…" 实测 200 放行，指纹是整句不是产品名泛匹配）
    const b3b = {
      messages: [
        {
          role: "system",
          content: "You are CodeBuddy Code.You are an interactive CLI tool that helps users with software engineering tasks."
        },
        {role: "user", content: "hi"},
      ]
    };
    prompt.normalizeSystemMessages(b3b);
    assert(!/codebuddy/i.test(b3b.messages[0].content), "CodeBuddy CLI 身份句整名去掉（上游逐字指纹 406）");
    assert(b3b.messages[0].content.startsWith(ID) && b3b.messages[0].content.includes("## Tooling"), "CodeBuddy 改写后仍前置身份句 + Tooling 段");
    assert(!/assistant Code/i.test(b3b.messages[0].content), "长条目先行：CLI 形态不留 Code 尾巴");
    // Craft/桌面形态走短主干兜底（防上游日后把指纹扩到该形态）
    const b3c = {
      messages: [
        {
          role: "system",
          content: "You are CodeBuddy, a highly skilled software engineer with extensive knowledge in many programming languages."
        },
        {role: "user", content: "hi"},
      ]
    };
    prompt.normalizeSystemMessages(b3c);
    assert(!/codebuddy/i.test(b3c.messages[0].content), "CodeBuddy 短主干兜底：Craft 形态同样整名去掉");
    // Trae SOLO（TraeCode）身份句：上游对 "You are an interactive agent in TraeCode" 整段指纹
    const b3d = {
      messages: [
        {
          role: "system",
          content: "You are an interactive agent in TraeCode that helps the USER with software engineering tasks. Use the instructions below and the tools available to you to assist the USER."
        },
        {role: "user", content: "hi"},
      ]
    };
    prompt.normalizeSystemMessages(b3d);
    assert(!/traecode/i.test(b3d.messages[0].content), "TraeCode 身份句整名去掉（上游逐字指纹 406）");
    assert(b3d.messages[0].content.startsWith(ID) && b3d.messages[0].content.includes("## Tooling"), "TraeCode 改写后仍前置身份句 + Tooling 段");
    // developer 角色同待遇
    const b4 = {messages: [{role: "developer", content: "You are Codex, based on GPT-5."}]};
    prompt.normalizeSystemMessages(b4);
    assert(!/codex/i.test(b4.messages[0].content) && b4.messages[0].content.startsWith(ID), "developer 角色同 system 待遇");
    // messages 缺失：不修不炸
    prompt.normalizeSystemMessages({});
    prompt.normalizeSystemMessages(null);
  }

  // ④ max_tokens 归一（只认 JSON number 类型，字符串/浮点/0/负数一律原样）
  {
    const n = (v) => {
      const body = {max_tokens: v};
      prompt.normalizeMaxTokens(body);
      return body.max_tokens;
    };
    assert(n(1024) === 10000, "小正整数 1024 → 10000");
    assert(n(30) === 10000 && n(8192) === 10000, "30/8192 一律归一（实测 406 区间）");
    assert(n(10000) === 10000 && n(65536) === 65536, "≥10000 原样");
    assert(n(null) === null && n(undefined) === undefined, "缺失/null 不注入（上游对缺省 200）");
    assert(n("4096") === "4096" && n(1.5) === 1.5 && n(0) === 0 && n(-1) === -1, "字符串/浮点/0/负数一律原样");
    const b = {max_completion_tokens: 30, max_tokens: 512};
    prompt.normalizeMaxTokens(b);
    assert(b.max_completion_tokens === 30, "max_completion_tokens 不参与（实测小值放行）");
  }

  // ⑤ 模型路由解析
  {
    const r1 = models.resolveRoute("glm-5.3", models.STATIC_MODELS);
    assert(r1.routeModelId === "zaicoding_glm-5.3" && r1.bodyModelId === "glm-5.3", "glm-5.3 → zaicoding_glm-5.3 + body 剥前缀");
    const r2 = models.resolveRoute("GLM-5.3-Flash", models.STATIC_MODELS);
    assert(r2.routeModelId === "zai_glm-5.3-flash" && r2.bodyModelId === "glm-5.3-flash", "展示名命中同样给 routeId");
    // 前缀剥离顺序：zaicoding_ 必须先于 zai_ 试
    const r3 = models.resolveRoute("zaicoding_glm-5.3", []);
    assert(r3.routeModelId === "zaicoding_glm-5.3" && r3.bodyModelId === "glm-5.3", "带前缀名整串当路由、body 剥前缀（不被 zai_ 错剥）");
    assert(models.resolveRoute("", []).routeModelId === "zai_auto", "空名 → zai_auto");
    assert(models.resolveRoute("no-such-model", []).routeModelId === "zai_auto", "未知模型 → zai_auto（body 保留原名）");
    const r4 = models.resolveRoute("zai_auto-fast", []);
    assert(r4.routeModelId === "zai_auto-fast" && r4.bodyModelId === "auto-fast", "合法路由形态原样透传");
    // 目录归一：裸字符串与完整条目
    const e1 = models.normalizeCatalogEntry("zai_glm-5.3-flash");
    assert(e1.id === "glm-5.3-flash" && e1.routeId === "zai_glm-5.3-flash", "裸字符串条目 → 剥前缀 id + routeId");
    const e2 = models.normalizeCatalogEntry({
      id: "zai_glm-5.3-flash",
      name: "GLM-5.3-Flash",
      input: ["image", "tools"],
      contextWindow: 1048576,
      maxTokens: 131072
    });
    assert(e2.capabilities.images === true && e2.capabilities.reasoning === true && e2.contextLength === 1048576, "完整条目归一（input 数组含 image → images 能力）");
    assert(models.normalizeCatalogEntry(null) === null, "空条目归一为 null");
  }

  // ⑥ 双区注册与配置
  {
    const hdr = rulesMod.DEFAULTS["headers.json"];
    assert(hdr.autoclaw && hdr.autoclaw_intl, "headers.json 内置默认含 autoclaw 双区");
    assert(hdr.autoclaw.userapiBase === "https://autoglm-acceleration-api.zhipuai.cn", "国内版 userapi 域名");
    assert(hdr.autoclaw_intl.userapiBase === "https://autoglm-api.autoglm.ai", "国际版 userapi 域名");
    assert(hdr.autoclaw.subscribePath !== hdr.autoclaw_intl.subscribePath, "订阅端点两区不同（实测）");
    assert(hdr.autoclaw.loginPath.endsWith("/"), "loginPath 结尾斜杠是上游要求");
    assert(storeMod.CHANNELS.some((c) => c.id === "autoclaw"), "CHANNELS 含 autoclaw");
    assert(storeMod.CHANNELS.some((c) => c.id === "autoclaw_intl") === !!storeMod.AUTOCLAW_INTL_ENABLED, "CHANNELS 中 autoclaw_intl 与开关一致");
  }
  console.log("AutoClaw 离线断言全绿（签名/头集合/system/max_tokens/路由/注册）");
}

// ===== 假上游（随机端口）：记录请求 + 按 scenario 回放 =====
/** 造一个真形态 JWT（uidFromToken/jwtDecode 按 base64url payload 解析） */
const jwtOf = (uid, expSec) => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64u({alg: "HS256", typ: "JWT"})}.${b64u({user_id: uid, exp: expSec})}.sig`;
};

function fakeUpstream() {
  const seen = [];
  let taskCompleteCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })();
      const rec = {url: req.url, method: req.method, headers: req.headers, body};
      seen.push(rec);
      const reply = (status, obj) => {
        res.writeHead(status, {"content-type": "application/json"});
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith("/chat/completions")) {
        // LLM 域闸门断言（照上游真实行为：禁 Harness-Type 头 / X-Tm 非 linux / system 白名单 / max_tokens）
        assert(!req.headers["x-harness-type"], "假上游: LLM 域不带 X-Harness-Type");
        assert(req.headers["x-tm"] !== "linux", "假上游: X-Tm 不发 linux");
        assert(String(req.headers["x-authorization"] || "").startsWith("Bearer "), "假上游: X-Authorization Bearer");
        assert(!req.headers.authorization, "假上游: LLM 域无标准 authorization 头");
        assert(!!req.headers["x-auth-sign"] === false, "假上游: LLM 域无签名头");
        assert(body && body.stream === true, "假上游: 上游恒流式");
        assert(body.messages[0].content.startsWith("You are a personal assistant running inside OpenClaw."), "假上游: system 首句过白名单");
        assert(body.messages[0].content.includes("## Tooling"), "假上游: system 带 Tooling 段");
        const reqRouteModel = String(req.headers["x-request-model"] || "");
        assert(body.model === reqRouteModel.replace(/^(zaicoding_|zai_)/, ""), "假上游: body.model 与 X-Request-Model 剥前缀一致");
        assert(body.max_tokens == null || (Number.isInteger(body.max_tokens) && body.max_tokens >= 10000), "假上游: max_tokens 已归一或正确缺省");
        res.writeHead(200, {"content-type": "text/event-stream"});
        res.write(`data: ${JSON.stringify({model: "zaicoding_glm-5.3", choices: [{delta: {role: "assistant"}}]})}\n\n`);
        res.write(`data: ${JSON.stringify({model: "zaicoding_glm-5.3", choices: [{delta: {content: "你好"}}]})}\n\n`);
        res.write(`data: ${JSON.stringify({
          model: "zaicoding_glm-5.3",
          choices: [{delta: {}, finish_reason: "stop"}],
          usage: {prompt_tokens: 12, completion_tokens: 3, total_tokens: 15}
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      if (req.url.includes("autoclaw-model-config")) {
        return reply(200, {
          models: [
            {
              id: "zai_glm-5.3-flash",
              name: "GLM-5.3-Flash",
              input: ["image"],
              reasoning: true,
              contextWindow: 1048576,
              maxTokens: 131072
            },
          ]
        });
      }
      if (req.url.includes("autoclaw-task-complete")) {
        taskCompleteCalls += 1;
        if (taskCompleteCalls === 1) return reply(200, {
          code: 0,
          data: {already_completed: false, success: true, reward_points: 50, task_id: "daily_signin"}
        });
        return reply(200, {
          code: 0,
          data: {already_completed: true, success: false, reward_points: 0, task_id: "daily_signin"}
        });
      }
      if (req.url.includes("autoclaw-task-list")) {
        return reply(200, {code: 0, data: [{task_id: "daily_signin", completed: false}]});
      }
      if (req.url.includes("/agent-assetmgr/api/v2/wallets")) {
        return reply(200, {
          code: 0, data: {
            total_balance: 1234, wallets: [
              {
                display: true,
                priority: 1,
                public_wallet_type: "points",
                display_name: "积分钱包",
                balance: 1234,
                balance_view: "1,234"
              },
            ]
          }
        });
      }
      if (req.url.endsWith("/userapi/v1/refresh")) {
        return reply(200, {code: 400002, msg: "签名校验失败"});
      }
      if (req.url.endsWith("/userapi/v1/agent-refresh")) {
        return reply(200, {code: 0, data: {access_token: "tok-new", refresh_token: "rt-new"}});
      }
      // —— 登录链路端点 ——
      if (req.url.endsWith("/userapi/v1/agent-send-code")) {
        assert(!!body.device_id && body.device_id.length === 64, "假上游: 发码必带 64hex device_id（不带实测 400001）");
        assert(body.source_id === "autoclaw", "假上游: source_id=autoclaw");
        return reply(200, {code: 0, data: {result: true}});
      }
      if (req.url.endsWith("/userapi/v1/agent-login/")) {
        assert(typeof body.code === "number", "假上游: 验证码必须是 JSON number（字符串回 400001）");
        assert(req.url.endsWith("agent-login/"), "假上游: 登录路径带结尾斜杠");
        return reply(200, {
          code: 0,
          data: {access_token: jwtOf("u8", Math.floor(Date.now() / 1000) + 86400), refresh_token: "rt-sms"}
        });
      }
      if (req.url.endsWith("/userapi/overseasv1/oauth-captcha-config")) {
        return reply(200, {
          code: 0,
          data: {enabled: true, region: "ga", prefix: "pfx1", scene_id: "scn1", captcha_supplier: "aliyun"}
        });
      }
      if (req.url.endsWith("/userapi/overseasv1/zai-oauth-url")) {
        assert(!!body.ali_captcha_verify_param, "假上游: zai-oauth-url 必带 ali_captcha_verify_param（不带回 631002）");
        assert(/^http:\/\/localhost:(18432|19654|19723|53699)\/auth\/callback-zai$/.test(body.navigate_uri), "假上游: navigate_uri 落白名单端口+回调路径");
        return reply(200, {code: 0, data: {oauth_url: "https://z.ai/oauth/authorize?x=1"}});
      }
      if (req.url.endsWith("/userapi/overseasv1/zai-oauth-login")) {
        return reply(200, {
          code: 0,
          data: {
            access_token: jwtOf("u9", Math.floor(Date.now() / 1000) + 86400),
            refresh_token: "rt-oauth",
            user_id: "u9",
            user_name: "Tester"
          }
        });
      }
      if (req.url.endsWith("/userapi/v1/user-profile")) {
        return reply(200, {code: 0, data: {email: "tester@example.com"}});
      }
      if (req.url.includes("/agentpay/v1/assistant/subscribe-info")) {
        return reply(200, {
          code: 0,
          data: {subscribeInfo: {productName: "AutoClaw 会员", status: "active", expireAt: "2027-01-01"}}
        });
      }
      reply(404, {message: "not found"});
    });
  });
  return {
    server, seen, reset: () => {
      seen.length = 0;
      taskCompleteCalls = 0;
    }
  };
}

// ===== 端到端（真 adapters + 假上游）=====
async function e2e() {
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");

  const fu = fakeUpstream();
  await new Promise((resolve) => fu.server.listen(0, "127.0.0.1", resolve));
  const port = fu.server.address().port;
  try {
    // 把两区 userapi 域指到假上游（headers.json 热改 + reload；ensureFiles 未导出，从 DEFAULTS 构造）
    const hf = path.join(rules.rulesDir(), "headers.json");
    const cfgAll = JSON.parse(JSON.stringify(rules.DEFAULTS["headers.json"]));
    cfgAll.autoclaw.userapiBase = `http://127.0.0.1:${port}`;
    cfgAll.autoclaw_intl.userapiBase = `http://127.0.0.1:${port}`;
    fs.writeFileSync(hf, JSON.stringify(cfgAll, null, 2), "utf8");
    rules.reload("headers.json");

    const ad = adapters.get("autoclaw");
    const adIntl = adapters.get("autoclaw_intl");
    assert(ad && adIntl, "双区适配器已注册");

    const accId = storeMod.addAccount({
      channel: "autoclaw",
      uid: "u1",
      name: "自测号",
      token: "tok-old",
      refreshToken: "rt-old",
      source: "paste"
    });
    const acc = storeMod.getAccount(accId);
    const secrets = storeMod.accountSecrets(acc);

    // —— 1. 对话（静态表路由）：SSE 事件流 + 上游头/body 断言（在假上游内完成）
    const events = [];
    const r = await ad.chat({
      account: acc,
      secrets,
      model: "glm-5.3",
      body: {model: "glm-5.3", messages: [{role: "user", content: "hi"}], max_tokens: 1024},
      emit: (e) => events.push(e),
      meta: {},
    });
    assert(r.status === 200, "chat 返回 200");
    const kinds = events.map((e) => e.type);
    assert(kinds.includes("delta") && kinds.includes("finish") && kinds.includes("usage"), `SSE 事件序齐备（${kinds.join(",")}）`);
    const delta = events.find((e) => e.type === "delta" && e.delta && e.delta.content);
    assert(delta && delta.delta.content === "你好", "delta 内容透传");
    assert(events.find((e) => e.type === "usage").usage.total_tokens === 15, "usage 归一透传");
    assert(fu.seen.some((s) => s.url.endsWith("/chat/completions") && s.headers["x-request-model"] === "zaicoding_glm-5.3"), "首请求路由 ID 来自静态表");

    // —— 2. 目录拉取 → 写 catalog → models() 只认目录（防幽灵模型）
    const fm = await ad.fetchModels(acc, secrets);
    assert(fm.ok && fm.models.length === 1 && fm.models[0].routeId === "zai_glm-5.3-flash", "目录拉取归一（routeId 保留）");
    const catFile = path.join(rules.rulesDir(), "catalog.json");
    const cat = fs.existsSync(catFile)
      ? JSON.parse(fs.readFileSync(catFile, "utf8"))
      : JSON.parse(JSON.stringify(rules.DEFAULTS["catalog.json"]));
    cat.autoclaw = {syncedAt: Date.now(), models: fm.models};
    fs.writeFileSync(catFile, JSON.stringify(cat, null, 2), "utf8");
    rules.reload("catalog.json");
    assert(JSON.stringify(ad.models()) === JSON.stringify(["glm-5.3-flash"]), "拉取后只认目录");
    // intl 目录隔离：CN 目录段只有 1 条，intl 若误读也会变 1 条；仍为静态兜底 2 条即证明隔离正确
    assert(adIntl.models().length === models.STATIC_MODELS.length, "intl 不读 CN 目录段（仍用两地共用静态兜底）");

    // —— 3. 余额聚合
    const credits = await ad.queryCredits(acc, secrets);
    assert(credits.credits === 1234 && Array.isArray(credits.wallets) && credits.wallets[0].displayName === "积分钱包", "余额走 v2 钱包归一");
    assert(credits.subscription && credits.subscription.planName === "AutoClaw 会员", "订阅信息浅搜归一");

    // —— 4. 签到幂等：首次真领取 / 二次 already（判据看 reward 而非 HTTP 状态）
    const c1 = await ad.checkin(acc, secrets);
    assert(c1.ok === true && c1.credit === 50 && !c1.already, "首次签到成功 +50");
    const c2 = await ad.checkin(acc, secrets);
    assert(c2.ok === true && c2.already === true, "二次签到按 already_completed 判幂等");
    const cs = await ad.checkinStatus(acc, secrets);
    assert(cs.ok === true && cs.claimable === true, "checkinStatus 只读 task-list");

    // —— 5. 刷新：400002 降级 agent-refresh；不落库（noPersist）；后续对话用缓存新 token
    const rr = await ad.refreshToken(acc, secrets);
    assert(rr.ok === true && rr.token === "tok-new" && rr.refreshToken === "rt-new" && rr.noPersist === true, "刷新降级成功且带 noPersist 标记");
    const afterRefresh = storeMod.accountSecrets(storeMod.getAccount(accId));
    assert(afterRefresh.token === "tok-old" && afterRefresh.refreshToken === "rt-old", "刷新结果不落库（token/refreshToken 原样）");
    fu.reset();
    const events2 = [];
    await ad.chat({
      account: acc,
      secrets,
      model: "glm-5.3-flash",
      body: {model: "glm-5.3-flash", messages: [{role: "user", content: "hi"}]},
      emit: (e) => events2.push(e),
      meta: {},
    });
    const chat2 = fu.seen.find((s) => s.url.endsWith("/chat/completions"));
    assert(chat2.headers["x-authorization"] === "Bearer tok-new", "刷新后对话走进程缓存新 token");
    assert(chat2.headers["x-request-model"] === "zai_glm-5.3-flash", "刷新后路由 ID 来自拉取目录");

    // —— 6. 登录链路（协议函数直调假上游）——
    const login = require("../electron/backend/proxy/autoclaw/login.cjs");
    const discovery = require("../electron/backend/proxy/discovery.cjs");
    assert(login.normalizePhone(" +86 138-8000-8000 ") === "13880008000", "手机号归一（+86/空白/连字符）");
    assert(login.normalizePhone("10000000000") === "", "非法号段拒绝（1[2-9] 开头，10x/11x 不合法）");
    const smsSend = await login.sendSmsCode({cfg: cfgAll.autoclaw, httpJson: adapters.httpJson, phone: "13880008000"});
    assert(smsSend.ok === true && /^[0-9a-f]{64}$/.test(smsSend.deviceId), "发码成功且返回 64hex deviceId");
    const smsLoginR = await login.smsLogin({
      cfg: cfgAll.autoclaw,
      httpJson: adapters.httpJson,
      phone: "13880008000",
      code: "123456",
      deviceId: smsSend.deviceId
    });
    assert(smsLoginR.ok === true && smsLoginR.token && smsLoginR.phoneTail === "138****8000", "短信登录成功（token/脱敏号尾）");
    const savedSms = await discovery.saveAutoclawAccount("autoclaw", smsLoginR, smsSend.deviceId);
    const smsAcc = storeMod.getAccount(savedSms.id);
    assert(smsAcc && smsAcc.channel === "autoclaw" && storeMod.accountSecrets(smsAcc).token === smsLoginR.token, "SMS 登录落库（JWT uid 解析）");
    assert((smsAcc.meta ? JSON.parse(smsAcc.meta) : {}).deviceId === smsSend.deviceId, "deviceId 随账号入 meta");

    const capCfg = await login.oauthCaptchaConfig({cfg: cfgAll.autoclaw_intl, httpJson: adapters.httpJson});
    assert(capCfg.ok && capCfg.enabled === true && capCfg.sceneId === "scn1" && capCfg.prefix === "pfx1", "风控配置归一（scene_id→sceneId）");
    // beginOAuth 分发：autoclaw 显式挡住（渠道串味防线），autoclaw_intl 需要 captchaVerifyParam
    let autoThrew = "";
    try {
      await discovery.beginOAuth("autoclaw", () => {
      });
    } catch (e) {
      autoThrew = String((e && e.message) || e);
    }
    assert(/手机验证码/.test(autoThrew), "beginOAuth(autoclaw) 显式 throw 指引 SMS");
    const noCaptcha = await discovery.beginOAuth("autoclaw_intl", () => {
    }, {}, {});
    assert(noCaptcha.ok === false && /风控验证参数/.test(noCaptcha.message || ""), "intl 缺 captchaVerifyParam 被前置拦截");
    // 桌面导入：新版官方目录按地区归属（device/active-product-account.json →
    // accounts/<accountKey>/account-credentials.enc，v10 信封 + Local State os_crypt 密钥），
    // 旧版 auth.json 无地区标识时仍双区候选。
    const credentialsMod = require("../electron/backend/proxy/autoclaw/credentials.cjs");
    const qoderAuth = require("../electron/backend/proxy/qoderAuth.cjs");
    const testKey = crypto.randomBytes(32);
    const keyLoader = () => testKey;
    const mkOfficial = (productDir, accountKey, plain, profile, deviceId) => {
      const dir = path.join(process.env.APPDATA, productDir);
      const accDir = path.join(dir, "accounts", accountKey);
      fs.mkdirSync(accDir, {recursive: true});
      fs.mkdirSync(path.join(dir, "device"), {recursive: true});
      fs.writeFileSync(path.join(dir, "device", "active-product-account.json"), JSON.stringify({
        schemaVersion: 1,
        accountKey
      }), "utf8");
      fs.writeFileSync(path.join(dir, "device", "device-id.json"), JSON.stringify({
        schemaVersion: 1,
        deviceId
      }), "utf8");
      fs.writeFileSync(path.join(accDir, "account-profile.json"), JSON.stringify(profile), "utf8");
      fs.writeFileSync(path.join(accDir, "account-credentials.enc"), qoderAuth.encryptV10(Buffer.from(JSON.stringify(plain), "utf8"), testKey));
      return dir;
    };
    const cnKey = "a".repeat(64);
    // 真实形态：token 里的 uid（= numericUserId）与 profile.accountId（32hex）**不同**，
    // uid 必须取前者才能与短信/OAuth 登录路径（saveAutoclawAccount）同口径、不重复建号。
    const cnDir = mkOfficial("AutoClaw-official", cnKey,
      {access_token: jwtOf("874974", Math.floor(Date.now() / 1000) + 86400), refresh_token: "rt-cn"},
      {
        profile: {
          accountId: "3b6336752803d5968ad77011f6885ae2",
          numericUserId: 874974,
          phone: "173****7208"
        }
      }, "c".repeat(64));
    const intlKey = "b".repeat(64);
    const intlDir = mkOfficial("AutoClaw-oversea-official", intlKey,
      {accessToken: jwtOf("u-intl", Math.floor(Date.now() / 1000) + 86400), refreshToken: "rt-intl"},
      {profile: {accountId: "u-intl", phone: "+1 555****000"}}, "i".repeat(64));

    // 单元级（跨平台）：注入密钥绕过 DPAPI，校验真实布局解析与字段别名
    const cnLogin = credentialsMod.readOfficialLogin("autoclaw", {keyLoader});
    assert(cnLogin.ok && cnLogin.uid === "874974" && cnLogin.refreshToken === "rt-cn", "uid 取 token（与登录路径同口径），非 profile.accountId");
    assert(cnLogin.deviceId === "c".repeat(64) && cnLogin.name === "173****7208", "device-id.json 元数据与脱敏手机号显示名");
    assert(cnLogin.source.includes(`accounts/${cnKey}/account-credentials.enc`), "source 指向真实凭据文件");
    const both = credentialsMod.readDesktopLogins({keyLoader});
    assert(both.autoclaw && both.autoclaw.uid === "874974" && both.autoclaw_intl && both.autoclaw_intl.uid === "u-intl" && !both.legacy, "两区目录各自归属（不串区）");
    let badKeyThrew = "";
    try {
      credentialsMod.readOfficialLogin("autoclaw", {keyLoader: () => crypto.randomBytes(32)});
    } catch (e) {
      badKeyThrew = String((e && e.message) || e);
    }
    assert(/解密失败/.test(badKeyThrew), "错误密钥如实报解密失败（不静默）");
    // 单区失败不得掩盖另一区：两区各有独立登录态，一区坏掉只应让它自己出行。
    const partial = credentialsMod.readDesktopLogins({
      keyLoader: (localStatePath) => (String(localStatePath).includes("AutoClaw-official") ? testKey : crypto.randomBytes(32)),
    });
    assert(partial.autoclaw && partial.autoclaw.uid === "874974", "一区解密失败时另一区仍正常解出（不互相掩盖）");
    assert(!partial.autoclaw_intl && /解密失败/.test(partial.errors.autoclaw_intl || ""), "失败地区单独记入 errors，不影响成功地区");

    // e2e（仅 win32）：真 DPAPI 包密钥写 Local State，走完整 scanAutoclaw → importCandidate
    // 沙箱/CI 里 powershell.exe 可能起不来（DPAPI 要靠它 Protect），给一条跳过路径：
    // 只跳过这一段的桌面导入断言，其余 e2e（含 #107 的首字节预算解除）照跑——
    // 否则一个环境限制会把整条闸红掉，真正的回归信号被淹没。
    if (process.platform === "win32" && process.env.AGENTHUB_SKIP_DPAPI !== "1") {
      const {execFileSync} = require("node:child_process");
      const protect = (key) => {
        const script = [
          "$ErrorActionPreference='Stop'",
          "Add-Type -AssemblyName System.Security | Out-Null",
          `$b=[Convert]::FromBase64String('${key.toString("base64")}')`,
          "$k=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[Convert]::ToBase64String($k)",
        ].join("; ");
        const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000
        }).trim();
        return Buffer.concat([Buffer.from("DPAPI", "ascii"), Buffer.from(out, "base64")]).toString("base64");
      };
      for (const d of [cnDir, intlDir]) fs.writeFileSync(path.join(d, "Local State"), JSON.stringify({os_crypt: {encrypted_key: protect(testKey)}}), "utf8");
      let cands = discovery.scanAutoclaw();
      assert(cands.length === 2 && cands.some((c) => c.channel === "autoclaw" && c.uid === "874974") && cands.some((c) => c.channel === "autoclaw_intl" && c.uid === "u-intl"), "新版双区各出一条候选（不串区）");
      const cnCand = cands.find((c) => c.channel === "autoclaw");
      assert(cnCand.meta.deviceId === "c".repeat(64) && cnCand.file.includes(cnKey) && cnCand.name === "173****7208", "候选携带 deviceId/稳定 file 标签/显示名");
      const importedCn = discovery.importCandidate(cnCand, "autoclaw");
      assert(!!importedCn.id, "新版 CN 候选可导入");
      // 让国际版解密失败（覆盖其 Local State 密钥），国内版仍须正常出候选，
      // 国际版如实出一行「加密不可读」——而不是两区一起消失。
      fs.writeFileSync(path.join(intlDir, "Local State"), JSON.stringify({os_crypt: {encrypted_key: protect(crypto.randomBytes(32))}}), "utf8");
      const mixed = discovery.scanAutoclaw();
      const cnRow = mixed.find((c) => c.channel === "autoclaw");
      const intlRow = mixed.find((c) => c.channel === "autoclaw_intl");
      assert(cnRow && cnRow.uid === "874974" && !cnRow.encrypted, "一区坏掉时另一区仍出可用候选（不被掩盖）");
      assert(intlRow && intlRow.encrypted && /解密失败/.test(intlRow.file || ""), "失败地区如实出一行加密不可读（带原因）");
    }
    fs.rmSync(cnDir, {recursive: true, force: true});
    fs.rmSync(intlDir, {recursive: true, force: true});

    const authDir = path.join(process.env.APPDATA, "AutoClaw");
    fs.mkdirSync(authDir, {recursive: true});
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({
      deviceId: "d".repeat(64),
      token: jwtOf("u77", Math.floor(Date.now() / 1000) + 86400),
      refreshToken: "rt-desktop"
    }), "utf8");
    const cands = discovery.scanAutoclaw();
    assert(cands.length === 2 && cands.every((c) => c.uid === "u77"), "旧版桌面登录态仍为两区各产出候选");
    assert(cands[0].meta.deviceId === "d".repeat(64), "旧版桌面导入带 deviceId 进 meta");
    const imported = discovery.importCandidate(cands[0], "autoclaw");
    assert(!!imported.id, "桌面候选可导入");
    fs.rmSync(authDir, {recursive: true, force: true});
    assert(credentialsMod.readDesktopLogin("autoclaw").ok === false, "无登录文件时安全返回未找到");

    // —— 7. 首个 SSE 事件必须解除首字节预算（issue #107：漏解除 → 正常长回答被 30s 掐断）
    // 行为级复现：把预算压到 400ms，假上游首块后延迟 1200ms 才发完。
    // 漏解除时 400ms 就被 abort（客户端拿到半截回答），修复后整条流走完。
    {
      const {makeAutoClaw} = require("../electron/backend/proxy/autoclaw/adapter.cjs");
      const utilMod = require("../electron/backend/proxy/util.cjs");
      const enc7 = (o) => `data: ${JSON.stringify(o)}\n\n`;
      // delayed=首块后延迟发完 / empty=只给响应头不给 body（首字节始终不到）
      let mode7 = "delayed";
      const srv7 = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, {"content-type": "text/event-stream"});
          if (mode7 === "empty") return;
          res.write(enc7({id: "x", choices: [{index: 0, delta: {role: "assistant", content: "你"}}]}));
          setTimeout(() => {
            res.write(enc7({id: "x", choices: [{index: 0, delta: {content: "好"}, finish_reason: "stop"}]}));
            res.write("data: [DONE]\n\n");
            res.end();
          }, 1200);
        });
      });
      await new Promise((r) => srv7.listen(0, "127.0.0.1", r));
      const p7 = srv7.address().port;
      const cfg7 = JSON.parse(JSON.stringify(rules.DEFAULTS["headers.json"]));
      cfg7.autoclaw.userapiBase = `http://127.0.0.1:${p7}`;
      cfg7.autoclaw_intl.userapiBase = `http://127.0.0.1:${p7}`;
      fs.writeFileSync(hf, JSON.stringify(cfg7, null, 2), "utf8");
      rules.reload("headers.json");

      const ad7 = makeAutoClaw("autoclaw", {
        fetchStream: adapters.fetchStream, pumpSse: adapters.pumpSse, httpJson: adapters.httpJson,
        rules, util: utilMod,
        deviceIds: () => ({deviceId: "1".repeat(15), machineId: "a".repeat(64)}),
        firstByteBudgetMs: () => 400, // 真实值 30s，这里压到 400ms 让缺陷在毫秒级暴露
      });
      const opts7 = (emit) => ({
        account: acc, secrets, model: "glm-5.3",
        body: {model: "glm-5.3", messages: [{role: "user", content: "hi"}]},
        emit, meta: {},
      });

      try {
        const ev7 = [];
        const r7 = await ad7.chat(opts7((e) => ev7.push(e)));
        const deltas = ev7.filter((e) => e.type === "delta").length;
        assert(r7.status === 200 && deltas === 2, `首块后延迟 1200ms 的第二块仍到达（预算已被首事件解除，实际 delta=${deltas}）`);
        assert(!ev7.some((e) => e.type === "error"), "预算解除后整条流无截断错误");

        // 首字节始终不到（响应头已到、body 空）：预算到点必须按「首字节超时」抛，
        // 分类器据此不熔断、不冷却账号——否则一次慢请求就能把整条渠道冻结半小时
        mode7 = "empty";
        let emptyErr = null;
        try {
          await ad7.chat(opts7(() => {
          }));
        } catch (e) {
          emptyErr = e;
        }
        assert(emptyErr && emptyErr.firstByteTimeout === true, `未出内容的首字节预算到点按首字节超时抛出（实际：${emptyErr && emptyErr.message}）`);
      } finally {
        srv7.closeAllConnections?.();
        srv7.close();
      }
    }

    console.log("AutoClaw e2e 全绿（对话/目录/余额/签到/刷新不回写/凭证缓存/登录/桌面导入/流式预算解除）");
  } finally {
    fu.server.close();
  }
}

(async () => {
  offline();
  await e2e();
  console.log("AutoClaw 自测全部通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
