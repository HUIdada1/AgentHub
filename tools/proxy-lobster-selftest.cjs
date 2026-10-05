// LobsterAI（网易有道龙虾）渠道自测探针（离线为主；联网探针默认跳过）
// 跑法（必须用项目内 Electron 的 Node：加密实现在 Electron 运行时，系统 Node 无 safeStorage）：
//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-lobster-selftest.cjs
// 联网探针（可选，只打**公开只读**端点，不带任何账号凭据）：
//   LOBSTER_SELFTEST_LIVE=1 ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-lobster-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 自测沙箱：所有文件写操作落在临时目录，绝不碰真实 %APPDATA%\AgentHub
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "lobster-selftest-"));
process.env.APPDATA = SANDBOX;

const adapters = require("../electron/backend/proxy/adapters.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const store = require("../electron/backend/proxy/store.cjs");

let pass = 0;
let fail = 0;
const failures = [];
function T(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      fail++;
      failures.push(`${name}: ${(e && e.message) || e}`);
      console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
    });
}

const LIVE = !!process.env.LOBSTER_SELFTEST_LIVE;
const UPSTREAM = "https://lobsterai-server.youdao.com";

async function main() {
  console.log(`sandbox: ${SANDBOX}`);
  console.log(`driver note: run under ELECTRON_RUN_AS_NODE. live probes: ${LIVE ? "ON" : "off"}\n`);

  const ad = adapters.get("lobster");

  // ===== T1 渠道注册与三处同步 =====
  await T("T1 渠道已注册（adapters / store.CHANNELS 双表同步）", () => {
    assert.ok(ad, "adapters.get('lobster') 必须有适配器");
    assert.strictEqual(ad.id, "lobster");
    const ch = store.CHANNELS.find((c) => c.id === "lobster");
    assert.ok(ch, "store.CHANNELS 必须含 lobster");
    assert.ok(ch.display.includes("LobsterAI"), `display 应含 LobsterAI，实际 ${ch.display}`);
    // 双表同步红线：只加一边会让模型被判为「无归属」并路由到不存在的渠道
    assert.ok(adapters.ADAPTERS.lobster, "ADAPTERS 必须含 lobster");
  });

  // ===== T2 适配器接口完整性（编排层按这些方法调用） =====
  await T("T2 适配器接口完整（chat/models/mapModel/rewriteBody/queryCredits/checkin/refreshToken/userInfo）", () => {
    for (const m of ["cfg", "models", "mapModel", "rewriteBody", "chat", "fetchModels", "fetchModelsPublic", "queryCredits", "checkinStatus", "checkin", "trial", "refreshToken", "userInfo"]) {
      assert.strictEqual(typeof ad[m], "function", `缺方法 ${m}`);
    }
  });

  // ===== T3 配置项齐备（rules 热加载） =====
  await T("T3 headers.json.lobster 关键端点齐备", () => {
    const c = rules.get("headers.json").lobster;
    assert.ok(c, "headers.json 必须有 lobster 段");
    assert.strictEqual(c.chatUrl, `${UPSTREAM}/api/proxy/v1/chat/completions`);
    assert.strictEqual(c.modelsUrl, `${UPSTREAM}/api/models/available`);
    assert.strictEqual(c.balanceUrl, `${UPSTREAM}/api/user/profile-summary`);
    assert.strictEqual(c.exchangeUrl, `${UPSTREAM}/api/auth/exchange`);
    assert.strictEqual(c.refreshUrl, `${UPSTREAM}/api/auth/refresh`);
    assert.strictEqual(c.activitySlotUrl, `${UPSTREAM}/api/client-activities/slot`);
    assert.strictEqual(c.checkinPlacement, "desktop_sidebar");
    assert.ok(/^https:\/\/api-overmind\.youdao\.com\//.test(c.versionUrl), "版本号来源应是官方更新接口");
    assert.ok(/^\d{4}\.\d+/.test(c.clientVersion), `clientVersion 应是 2026.x 形态，实际 ${c.clientVersion}`);
  });

  // ===== T4 静态目录兜底（权威源：公开 pricing-catalog 实测） =====
  await T("T4 catalog.json.lobster 静态兜底目录非空且形态正确", () => {
    const ids = ad.models();
    assert.ok(Array.isArray(ids) && ids.length >= 25, `兜底模型数应 ≥25，实际 ${ids.length}`);
    for (const want of ["deepseek-flash", "glm-5.3-flash", "glm-5.3-flashx", "deepseek-v4-pro", "kimi-k3", "glm-5.2", "qwen3.8-max", "MiniMax-M3"]) {
      assert.ok(ids.includes(want), `兜底目录应含 ${want}`);
    }
  });

  // ===== T4b 上下文长度必须是真实值而非占位常量 =====
  await T("T4b 上下文长度取真实值（非 131072 占位；1M 档正确）", () => {
    const cat = rules.get("catalog.json").lobster;
    const by = (id) => cat.models.find((m) => m.id === id);
    // 官方公开端点实测：deepseek-flash / glm-5.3-flash 均为 1000000
    assert.strictEqual(by("deepseek-flash").contextLength, 1000000, "deepseek-flash 上下文应为 1M");
    assert.strictEqual(by("glm-5.3-flash").contextLength, 1000000, "glm-5.3-flash 上下文应为 1M");
    assert.strictEqual(by("deepseek-v4-pro").contextLength, 1000000, "deepseek-v4-pro 上下文应为 1M");
    assert.strictEqual(by("kimi-k3").contextLength, 1048576, "kimi-k3 上下文应为 1048576");
    assert.strictEqual(by("kimi-k2.7-code").contextLength, 262144, "kimi-k2.7-code 上下文应为 262144");
    assert.strictEqual(by("doubao-seed-2-1-turbo-260628").contextLength, 256000, "豆包 turbo 上下文应为 256000");
    // 服务端未标 contextWindow 的模型必须记 0（未知），绝不编造
    assert.strictEqual(by("glm-5.1").contextLength, 0, "未标窗口的模型应记 0（不编造默认值）");
    assert.strictEqual(by("qwen3.6-plus").contextLength, 0, "未标窗口的模型应记 0（不编造默认值）");
    // 全表不得出现 131072 这个第三方占位值
    const bogus = cat.models.filter((m) => m.contextLength === 131072);
    assert.strictEqual(bogus.length, 0, `不得残留 131072 占位值，实际 ${bogus.map((m) => m.id).join(",")}`);
  });

  // ===== T4c 能力位与倍率来自权威源 =====
  await T("T4c 能力位/倍率取自公开目录实测值", () => {
    const cat = rules.get("catalog.json").lobster;
    const by = (id) => cat.models.find((m) => m.id === id);
    assert.strictEqual(by("deepseek-flash").capabilities.images, true, "DeepSeek-V4.1-Flash 支持图片");
    assert.strictEqual(by("deepseek-v4-pro").capabilities.images, false, "DeepSeek-V4-Pro 不支持图片");
    assert.strictEqual(by("glm-5.3-flash").capabilities.images, true, "GLM-5.3-Flash 支持图片");
    assert.strictEqual(by("deepseek-flash").rate, 0.05, "deepseek-flash 倍率 0.05");
    assert.strictEqual(by("glm-5.3-flash").rate, 0.06, "glm-5.3-flash 倍率 0.06");
    assert.strictEqual(by("kimi-k3").rate, 20, "kimi-k3 倍率 20");
  });

  // ===== T4e 同系列易混模型必须都在表内且分档正确 =====
  // GLM-5.3-Flash 与 FlashX 是同模型的两个速度档（官方同一文档页、Model Code 并列），
  // 能力/上下文完全相同，只差速度与 2.5 倍价格。两者都要在目录里，倍率不得写反。
  await T("T4e 同系列易混模型齐备（Flash/FlashX、DeepSeek V4.1/V4、code/highspeed）", () => {
    const cat = rules.get("catalog.json").lobster;
    const by = (id) => cat.models.find((m) => m.id === id);
    for (const id of ["glm-5.3-flash", "glm-5.3-flashx", "deepseek-flash", "deepseek-v4-flash",
      "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "qwen3.8-flash", "qwen3.8-omni-flash"]) {
      assert.ok(by(id), `目录应含 ${id}`);
    }
    // FlashX = Flash 的 2.5 倍价，能力与窗口完全相同
    assert.strictEqual(by("glm-5.3-flashx").rate / by("glm-5.3-flash").rate, 2.5, "FlashX 应为 Flash 的 2.5 倍价");
    assert.strictEqual(by("glm-5.3-flashx").contextLength, by("glm-5.3-flash").contextLength, "Flash/FlashX 窗口应相同");
    assert.strictEqual(by("glm-5.3-flashx").capabilities.images, by("glm-5.3-flash").capabilities.images, "Flash/FlashX 图片能力应相同");
    // deepseek-flash 是 V4.1（多模态），deepseek-v4-flash 是 V4（纯文本）——两个不同模型
    assert.notStrictEqual(by("deepseek-flash").name, by("deepseek-v4-flash").name, "V4.1-Flash 与 V4-Flash 应是不同模型");
    assert.strictEqual(by("deepseek-flash").capabilities.images, true, "V4.1-Flash 支持图片");
    assert.strictEqual(by("deepseek-v4-flash").capabilities.images, false, "V4-Flash 不支持图片");
    // highspeed 是同模型的高速档，价格更高
    assert.ok(by("kimi-k2.7-code-highspeed").rate > by("kimi-k2.7-code").rate, "highspeed 应比标准版贵");
    // glm-5.3（非 Flash）是另一能力等级的旗舰：更贵且不支持图片
    assert.ok(by("glm-5.3").rate > by("glm-5.3-flashx").rate, "glm-5.3 旗舰应比 FlashX 贵");
    assert.strictEqual(by("glm-5.3").capabilities.images, false, "glm-5.3 旗舰不支持图片（与 Flash 系列不同）");
  });

  // ===== T16 <think> 思考链归一（MiniMax 系把思考塞在 content 里） =====
  // 实测三例对照：MiniMax-M3 / M3.1 用 content 内嵌 <think>…</think>；GLM / DeepSeek 用独立
  // reasoning_content 字段。通用层 server.cjs 只认后者，故适配器必须把前者归一。
  await T("T16 <think> 归一：跨帧标签切分正确、正文与思考分离", () => {
    const { createThinkSplitter, splitThinkDelta } = adapters.__lobsterThink || {};
    assert.ok(createThinkSplitter && splitThinkDelta, "应导出 think 归一工具供自测");
    // ① 单帧完整
    let sp = createThinkSplitter();
    let r = splitThinkDelta(sp, { role: "assistant", content: "<think>我在想</think>正文A" });
    assert.strictEqual(r.reasoning, "我在想", "单帧应抽出思考");
    assert.strictEqual(r.rest.content, "正文A", "单帧应保留正文");
    // ② 开标签被切成两帧（"<thi" + "nk>"）
    sp = createThinkSplitter();
    r = splitThinkDelta(sp, { content: "<thi" });
    assert.strictEqual(r.reasoning, "", "半个开标签不应产出思考");
    assert.ok(!r.rest.content, "半个标签不应作为正文下发");
    r = splitThinkDelta(sp, { content: "nk>思考中</think>答案" });
    assert.strictEqual(r.reasoning, "思考中", "跨帧拼回后应抽出思考");
    assert.strictEqual(r.rest.content, "答案", "跨帧拼回后应保留正文");
    // ③ 闭标签被切开（"</thi" + "nk>"）——注意疑似半截标签的尾巴会**推迟到下一帧**才交付，
    //    故按帧累积 reasoning（这正是调用方/通用层的用法）
    sp = createThinkSplitter();
    let acc = "";
    let body = "";
    for (const chunk of ["<think>思考内容</thi", "nk>正文B"]) {
      const x = splitThinkDelta(sp, { content: chunk });
      acc += x.reasoning;
      if (x.rest.content) body += x.rest.content;
    }
    assert.strictEqual(acc, "思考内容", `闭标签跨帧应正确闭合，实际 "${acc}"`);
    assert.strictEqual(body, "正文B", `闭合后正文应正确，实际 "${body}"`);
    // ④ 无标签内容原样透传（零改动，且不得误吞正文）
    sp = createThinkSplitter();
    r = splitThinkDelta(sp, { content: "普通正文" });
    assert.strictEqual(r.reasoning, "", "无标签不应产出思考");
    assert.strictEqual(r.rest.content, "普通正文", "无标签正文必须原样透传");
    // ⑤ 思考段内跨多帧累积
    sp = createThinkSplitter();
    splitThinkDelta(sp, { content: "<think>第一段" });
    r = splitThinkDelta(sp, { content: "第二段" });
    assert.strictEqual(r.reasoning, "第二段", "think 段内后续帧应继续归入思考");
    r = splitThinkDelta(sp, { content: "</think>正文C" });
    assert.strictEqual(r.rest.content, "正文C", "闭合后正文应正确");
    // ⑥ 思考链绝不出现在正文里（核心防回归）
    sp = createThinkSplitter();
    let allText = "";
    for (const chunk of ["<think>", "a", "b", "</thi", "nk>", "正文"]) {
      const x = splitThinkDelta(sp, { content: chunk });
      if (x.rest.content) allText += x.rest.content;
    }
    assert.strictEqual(allText, "正文", `正文不得混入思考链或标签，实际 "${allText}"`);
  });

  // ===== T17 畸形帧守卫（对齐 Qoder 踩过的 body:"null" 坑，提交 81cf50b） =====
  // Qoder 渠道实证：上游会在流中夹一帧字面量 null，JSON.parse 得 null 后访问 .choices
  // 抛 TypeError，整条流以内部异常中断（用户看到 "Cannot read properties of null"）。
  // `!data` 只挡 falsy，[] / "abc" / 123 这些 truthy 非对象值同样必须挡住。
  await T("T17 畸形帧守卫：null/数组/裸标量均不中断（Qoder body:\"null\" 同款坑）", () => {
    // 复刻 chat() 内的帧处理守卫（与 adapters.cjs 保持同款判据）
    const guard = (raw) => {
      let data = null;
      try { data = JSON.parse(raw); } catch { return null; }
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      return data;
    };
    // 真 falsy / 非对象 必须被挡；空对象是合法对象、放行（由后续字段判空自然丢弃）
    for (const raw of ["null", "[]", '"abc"', "123", "true"]) {
      assert.strictEqual(guard(raw), null, `畸形帧 ${raw} 应被守卫挡下`);
    }
    assert.deepStrictEqual(guard("{}"), {}, "空对象是合法对象，应放行（后续字段判空自然丢弃）");
    // 正常帧必须放行
    const ok = guard('{"choices":[{"delta":{"content":"hi"}}]}');
    assert.ok(ok && ok.choices, "正常帧必须放行");
    // 非法 JSON 不得抛
    assert.strictEqual(guard("{bad json"), null, "非法 JSON 应返回 null 而非抛异常");
  });

  // ===== T18 端点全部走配置（热加载，不硬编码） =====
  // 对齐 Qoder 的 5ced951：端点硬编码会让「不同区域域名差异」被巧合掩盖
  // （CN 的 gateway/openApi 恰好都通，掩盖了 INTL 只在 openapi 的差异）。
  await T("T18 端点全部走 headers.json 配置（无硬编码 URL）", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const seg = src.slice(src.indexOf('id: "lobster"'), src.indexOf("// ===== ZCode"));
    const urls = [...seg.matchAll(/["']https:\/\/[^"']+["']/g)].map((m) => m[0]);
    assert.strictEqual(urls.length, 0, `lobster 适配器内不得有硬编码 URL，实际 ${urls.join(", ")}`);
    // 用到的端点必须在配置里都有定义
    const cfg = rules.get("headers.json").lobster;
    for (const key of [...new Set([...seg.matchAll(/c\.([a-zA-Z]+Url)/g)].map((m) => m[1]))]) {
      assert.ok(cfg[key], `headers.json.lobster 应定义 ${key}`);
      assert.ok(/^https:\/\//.test(String(cfg[key])), `${key} 应是完整 https URL`);
    }
  });

  // ===== T19 预刷新窗口语义（对齐 raccoon 抢刷坑） =====
  await T("T19 预刷新窗口：lobster 用默认 24h（凭据独立，不与客户端共用文件）", () => {
    // raccoon 因与桌面端共用 auth.json 而必须把窗口压到 300s 防抢刷；
    // lobster 走独立回环 OAuth（AgentHub 持自己那份凭据），不存在共用文件问题，
    // 故沿用默认 24h。此断言锁住「不要照抄 raccoon 的 300s」。
    assert.strictEqual(ad.refreshWindowSec, undefined, "lobster 不应设 refreshWindowSec（走默认 24h）");
    // access token 实测 30 天有效，24h 窗口不会每轮都触发刷新
    const dec = require("../electron/backend/proxy/util.cjs").jwtDecode("x.eyJleHAiOjQxMDI0NDQ4MDB9.y");
    assert.ok(dec.exp > 0, "JWT exp 应可解析（用于临期判定）");
  });

  // ===== T20 uid 解析：yid 绝不污染 uid（对齐 5dda7af 的落库缺口） =====
  // 实测 yid = "urs-phoneyd.<hash>@163.com"（邮箱形态，**不是 uid**）。
  // 早期实现把 yid 列进 uid 候选，userId 缺失时退化成邮箱字符串 → 号池去重失效、
  // 反复登录生成重复行。uid 是去重与 credit_first 排序的依据，绝不能拿错字段顶替。
  await T("T20 resolveLobsterUid：yid 不污染 uid，优先级与兜底正确", () => {
    const d = require("../electron/backend/proxy/discovery.cjs");
    assert.strictEqual(typeof d.resolveLobsterUid, "function", "应导出 resolveLobsterUid 供自测");
    const JWT = (sub) => "eyJhbGciOiJIUzUxMiJ9." + Buffer.from(JSON.stringify({ sub })).toString("base64url") + ".sig";
    // 正常：userId 数字优先
    assert.strictEqual(d.resolveLobsterUid({ userId: "100001", yid: "urs-phoneyd.x@163.com" }, JWT("999")), "100001");
    // 只有 id
    assert.strictEqual(d.resolveLobsterUid({ id: "100002" }, "x.y.z"), "100002");
    // 只有 yid（邮箱）→ 必须为空，绝不退化成邮箱
    assert.strictEqual(d.resolveLobsterUid({ yid: "urs-phoneyd.<hash>@163.com" }, "x.y.z"), "", "yid 不得当 uid");
    // 全空 → 回落 JWT sub
    assert.strictEqual(d.resolveLobsterUid({}, JWT("999999")), "999999", "应回落 JWT sub");
    // 全空且 JWT 无效 → 空
    assert.strictEqual(d.resolveLobsterUid({}, ""), "");
    // userId 与 id 同时存在 → 取 userId
    assert.strictEqual(d.resolveLobsterUid({ userId: "111", id: "222" }, "x.y.z"), "111");
    // JWT 里是邮箱形态 → 同样拒绝
    assert.strictEqual(d.resolveLobsterUid({}, JWT("a@b.com")), "", "JWT 邮箱形态也应拒绝");
  });

  // ===== T21 空 uid 拒绝落库（防脏记录进号池） =====
  // 实测踩到：授权码被重复消费时 exchange 返回 200 但 user 为空 → uid 为空仍 addAccount，
  // 去重查找 find(a => a.uid === uid) 恒不命中 → 同一账号反复登录生成重复行。
  await T("T21 空 uid 拒绝落库（返回 ok:false 而非造脏记录）", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "electron", "backend", "proxy", "discovery.cjs"), "utf8");
    const seg = src.slice(src.indexOf("function saveLobsterAccount"), src.indexOf("async function beginLobsterOAuth"));
    assert.ok(/if \(!uid\) return \{ ok: false/.test(seg), "saveLobsterAccount 必须在 uid 为空时返回 ok:false");
    // token 非空校验（String(undefined) 会得到字面量 "undefined" 这个 truthy 值）
    assert.ok(/typeof token === "string" && token\.trim\(\)/.test(src), "token 必须校验为非空字符串");
  });

  // ===== T22 晚到回调的 state 宽限表（会话超时后授权码仍可救） =====
  // 实测场景：回环会话 3 分钟超时，但用户在浏览器里登录慢，回调晚到数分钟——
  // 授权码仍然有效（实测可成功 exchange），旧实现直接丢弃，用户白跑一趟。
  // 宽限表只接受**本进程生成过的** state（128 位随机 + 30min TTL），CSRF 防护不削弱。
  await T("T22 state 宽限表：会话关闭后仍认已签发 state，未知 state 仍被拒", async () => {
    const d = require("../electron/backend/proxy/discovery.cjs");
    assert.strictEqual(typeof d.submitLobsterCallback, "function", "应导出 submitLobsterCallback");
    const b = await d.beginOAuth("lobster", () => {});
    const state = String(b.url).match(/state=([a-f0-9]+)/)[1];
    d.cancelOAuth(); // 模拟会话超时关闭
    // 该 state 仍应被认出（错误来自授权码本身，而非 state 校验）
    const r1 = await d.submitLobsterCallback(`http://127.0.0.1:1/auth/callback?code=INVALID&state=${state}`);
    assert.ok(!/不属于本应用/.test(r1.message || ""), `会话关闭后仍应认得该 state，实际：${r1.message}`);
    // 未知 state 必须被拒（CSRF 防护）
    const r2 = await d.submitLobsterCallback("http://127.0.0.1:1/auth/callback?code=x&state=deadbeef000000000000000000000000");
    assert.strictEqual(r2.ok, false, "未知 state 必须拒绝");
    assert.ok(/不属于本应用/.test(r2.message || ""), "未知 state 应给出明确原因");
    // 缺 state 也必须拒
    const r3 = await d.submitLobsterCallback("http://127.0.0.1:1/auth/callback?code=x");
    assert.strictEqual(r3.ok, false, "缺 state 必须拒绝");
  });

  // ===== T23 tool_calls 透传（离线结构断言） =====
  // 实测（真实账号，见方案文档 §16）：tool_calls 以**流式分片**到达（一次调用切 6 片，
  // arguments 按片累积），且回路消息序列 user→assistant(tool_calls)→tool(tool_call_id)
  // 被上游正确接受。本项锁定适配器**不破坏** tool_calls 透传（它只做 think 归一，
  // 不得吞掉或改写 tool_calls 字段）。
  await T("T23 tool_calls 透传不被 think 归一破坏", () => {
    const { createThinkSplitter, splitThinkDelta } = adapters.__lobsterThink;
    const sp = createThinkSplitter();
    // 带 tool_calls 的 delta（无 content）必须原样透传
    const withTools = {
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":' } }],
    };
    const r1 = splitThinkDelta(sp, withTools);
    assert.strictEqual(r1.reasoning, "", "无 content 不应产出思考");
    assert.ok(r1.rest.tool_calls, "tool_calls 必须保留");
    assert.strictEqual(r1.rest.tool_calls[0].function.name, "get_weather", "tool_calls 内容不得被改写");
    // content + tool_calls 同时存在时，两者都要保留
    const both = {
      role: "assistant",
      content: "调用工具中",
      tool_calls: [{ index: 0, id: "call_y", type: "function", function: { name: "f", arguments: "{}" } }],
    };
    const r2 = splitThinkDelta(sp, both);
    assert.strictEqual(r2.rest.content, "调用工具中", "正文应保留");
    assert.ok(r2.rest.tool_calls, "同时存在时 tool_calls 也必须保留");
    // 分片累积语义：arguments 分多片到达，逐片透传后拼接应还原完整 JSON
    const sp2 = createThinkSplitter();
    const frags = [
      { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "get_weather", arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] },
      { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] },
    ];
    let acc = "";
    let name = "";
    for (const f of frags) {
      const r = splitThinkDelta(sp2, f);
      const tc = r.rest.tool_calls && r.rest.tool_calls[0];
      if (tc && tc.function) {
        if (tc.function.name) name = tc.function.name;
        if (tc.function.arguments) acc += tc.function.arguments;
      }
    }
    assert.strictEqual(name, "get_weather", "函数名应从分片还原");
    assert.deepStrictEqual(JSON.parse(acc), { city: "北京" }, "分片累积的 arguments 应是完整合法 JSON");
  });

  // ===== T4d 公开目录端点（无需鉴权，权威兜底源） =====
  await T("T4d LIVE 公开 pricing-catalog 可达且含真实 contextWindow", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const c = rules.get("headers.json").lobster;
    assert.ok(c.pricingCatalogUrl, "应配置公开目录端点");
    const r = await adapters.httpJson(c.pricingCatalogUrl, { method: "GET", headers: { accept: "application/json" } });
    assert.strictEqual(r.status, 200, `公开目录应 200（无需鉴权），实际 ${r.status}`);
    const tm = (r.data && r.data.data && r.data.data.textModels) || [];
    assert.ok(tm.length >= 25, `公开目录文本模型应 ≥25，实际 ${tm.length}`);
    const flash = tm.find((m) => m.modelId === "deepseek-flash");
    assert.ok(flash, "公开目录应含 deepseek-flash");
    assert.strictEqual(flash.contextWindow, 1000000, "deepseek-flash 上下文应为 1M");
    assert.ok(tm.some((m) => m.modelId === "glm-5.3-flash"), "公开目录应含 glm-5.3-flash");
    console.log(`      textModels=${tm.length}  imageModels=${(r.data.data.imageModels || []).length}  videoModels=${(r.data.data.videoModels || []).length}`);
    // 适配器的公开目录整形（Bearer 目录不可用时的兜底路径）：字段映射必须与静态表同口径
    const pub = await ad.fetchModelsPublic();
    assert.ok(pub.ok, `fetchModelsPublic 应成功，实际 ${pub.message}`);
    const by = (id) => pub.models.find((m) => m.id === id);
    assert.strictEqual(by("deepseek-flash").contextLength, 1000000, "公开目录整形：deepseek-flash 1M");
    assert.strictEqual(by("deepseek-flash").rate, 0.05, "公开目录整形：倍率 0.05");
    assert.strictEqual(by("glm-5.1").contextLength, 0, "公开目录整形：服务端未标窗口记 0（不编造）");
  });

  // ===== T5 强制流式（上游只支持 stream=true，非流式实测 500） =====
  await T("T5 rewriteBody 强制 stream=true + include_usage", () => {
    const out = ad.rewriteBody("deepseek-v4-pro", { model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.strictEqual(out.stream, true, "必须强制 stream=true（上游非流式返回 500）");
    assert.strictEqual(out.stream_options.include_usage, true, "应带 include_usage 以拿 usage");
    assert.strictEqual(out.model, "deepseek-v4-pro");
  });

  // ===== T6 内部字段剥离 + tool_choice 归一 =====
  await T("T6 rewriteBody 剥离内部字段并归一 tool_choice", () => {
    const out = ad.rewriteBody("glm-5.2", {
      model: "glm-5.2",
      messages: [],
      conversation_id: "x",
      conversationId: "y",
      prompt_cache_key: "z",
      tool_choice: "none",
      temperature: 0.3,
    });
    assert.strictEqual(out.conversation_id, undefined, "conversation_id 应被剥离");
    assert.strictEqual(out.conversationId, undefined, "conversationId 应被剥离");
    assert.strictEqual(out.prompt_cache_key, undefined, "prompt_cache_key 应被剥离");
    assert.strictEqual(out.tool_choice, undefined, "tool_choice='none' 应被删除");
    assert.strictEqual(out.temperature, 0.3, "标准字段应原样透传");
    // 对象形态的 tool_choice 必须保留
    const out2 = ad.rewriteBody("glm-5.2", { model: "glm-5.2", messages: [], tool_choice: { type: "function", function: { name: "f" } } });
    assert.ok(out2.tool_choice, "对象形态 tool_choice 应保留");
  });

  // ===== T7 模型名归一（下划线变体容错） =====
  await T("T7 mapModel 归一大小写/下划线变体", () => {
    assert.strictEqual(ad.mapModel("DeepSeek-V4-Pro"), "deepseek-v4-pro");
    assert.strictEqual(ad.mapModel("deepseek_v4_pro"), "deepseek-v4-pro");
    assert.strictEqual(ad.mapModel("GLM-5.2"), "glm-5.2");
    // 目录外模型原样透传（上游可能新增）
    assert.strictEqual(ad.mapModel("some-future-model"), "some-future-model");
  });

  // ===== T8 签到活动槽解析：slotState=empty 不算失败 =====
  await T("T8 fetchSlot 对 slotState=empty 的处理（版本门禁，非错误）", async () => {
    // 用假 token 打真实端点会被鉴权拦；这里只校验「无活动」分支的返回契约，
    // 通过直接注入假的 httpJson 不可行（模块私有），故走 LIVE 分支或跳过
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const r = await ad.fetchSlot({ token: "FAKE" }, "0.1.0");
    // 版本过旧：服务端返回 slotState=empty 且无 activity —— 必须被当成「无活动」而非错误
    assert.ok(r.ok, `旧版本应返回 ok:true + activity:null，实际 ${JSON.stringify(r)}`);
    assert.strictEqual(r.activity, null, "旧版本号应看不到活动");
  });

  // ===== T9 鉴权头形态（Bearer + 客户端能力/版本头） =====
  await T("T9 chatHeaders 头组正确", () => {
    const h = ad.chatHeaders("tok-123");
    assert.strictEqual(h.authorization, "Bearer tok-123");
    assert.ok(h["user-agent"].startsWith("LobsterAI/"), `UA 应是 LobsterAI/<ver>，实际 ${h["user-agent"]}`);
    assert.strictEqual(h["X-LobsterAI-Client-Capabilities"], "kimi-k3-agentic-v1");
    assert.ok(/^\d{4}\.\d+/.test(h["X-LobsterAI-Client-Version"]), "版本头应是 2026.x 形态");
    assert.ok(h.accept.includes("text/event-stream"), "对话头应接受 SSE");
  });

  // ===== T10 refreshToken 无 refreshToken 时明确报错 =====
  await T("T10 refreshToken 缺凭据时明确报错（不发请求）", async () => {
    const r = await ad.refreshToken({}, { token: "x", refreshToken: "" });
    assert.strictEqual(r.ok, false);
    assert.ok(/refreshToken/.test(r.message), `应提示缺 refreshToken，实际 ${r.message}`);
  });

  // ===== T11 trial 明确不可用 =====
  await T("T11 trial 返回不可用（龙虾无加油包）", async () => {
    const r = await ad.trial();
    assert.strictEqual(r.ok, false);
    assert.ok(/加油包/.test(r.message));
  });

  // ===== T12 版本号解析（LIVE：官方更新接口） =====
  await T("T12 refreshVersion 从官方更新接口取到 2026.x 版本号", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const v = await ad.refreshVersion();
    assert.ok(/^\d{4}\.\d+/.test(v), `版本号应形如 2026.9.23，实际 ${v}`);
    console.log(`      clientVersion = ${v}`);
  });

  // ===== T13 LIVE：签到活动元数据（公开只读，不带凭据） =====
  await T("T13 LIVE 签到活动存在且奖励 100 积分", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const version = await ad.refreshVersion();
    // 无鉴权即可读活动槽（服务端对未登录也返回活动元数据，只是 authenticated:false）
    const r = await adapters.httpJson(
      `${UPSTREAM}/api/client-activities/slot?placement=desktop_sidebar&clientVersion=${encodeURIComponent(version)}&containerApiVersion=2&platform=win32`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    assert.ok(r.ok, `slot 应可达，实际 HTTP ${r.status}`);
    const d = r.data && r.data.data;
    assert.strictEqual(d.slotState, "available", `新版本号应看到活动，实际 ${d.slotState}`);
    assert.ok(d.activity && d.activity.activityCode, "应返回活动");
    assert.strictEqual(d.activity.activityType, "daily_check_in");
    // 取活动状态，核对奖励金额
    const ctx = await adapters.httpJson(
      `${UPSTREAM}/api/client-activities/${encodeURIComponent(d.activity.activityCode)}/context?configRevision=${d.activity.configRevision}`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    assert.ok(ctx.ok, `context 应可达，实际 HTTP ${ctx.status}`);
    const st = ctx.data && ctx.data.data && ctx.data.data.state;
    assert.ok(st, "context 应带 state");
    assert.strictEqual(Number(st.rewardCredits), 100, `每日签到奖励应为 100，实际 ${st.rewardCredits}`);
    assert.ok(Array.isArray(ctx.data.data.actions) && ctx.data.data.actions.includes("check_in"), "actions 应含 check_in");
    console.log(`      activity=${d.activity.activityCode} reward=${st.rewardCredits} 周期=${d.activity.startAt}→${d.activity.endAt}`);
  });

  // ===== T14 LIVE：旧版本号被门禁隐藏（防回归） =====
  await T("T14 LIVE 旧版本号被服务端隐藏活动（版本门禁仍生效）", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    const r = await adapters.httpJson(
      `${UPSTREAM}/api/client-activities/slot?placement=desktop_sidebar&clientVersion=0.1.0&containerApiVersion=2&platform=win32`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    const d = r.data && r.data.data;
    assert.strictEqual(d.slotState, "empty", `旧版本号应拿到 slotState=empty，实际 ${d.slotState}`);
  });

  // ===== T15 LIVE：对话/目录端点存在（无鉴权 → 401，证明端点活着） =====
  await T("T15 LIVE 上游端点存在（无鉴权应 401 而非 404）", async () => {
    if (!LIVE) {
      console.log("      (跳过：需 LOBSTER_SELFTEST_LIVE=1)");
      return;
    }
    for (const u of [`${UPSTREAM}/api/proxy/v1/models`, `${UPSTREAM}/api/models/available`]) {
      const r = await adapters.httpJson(u, { method: "GET", headers: { accept: "application/json" } });
      assert.strictEqual(r.status, 401, `${u} 应返回 401（端点存在、仅缺鉴权），实际 ${r.status}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("selftest crashed:", e);
  process.exit(1);
});
