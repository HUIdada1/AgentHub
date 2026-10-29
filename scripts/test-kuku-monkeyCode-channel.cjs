/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// KukuAI / MonkeyCode 两个渠道的离线自测（护仓闸内，纯函数 + 假上游，不联网）
// 运行：node scripts/test-kuku-monkeyCode-channel.cjs
//
// 守的是几条最容易在重构里静默坏掉的协议事实：
//   · KukuAI 四跳链的**顺序与形态**（分配算力那一跳挂在 /wenchain/genflow/ 而不是 genflowpro；
//     show_text / client_added 必须是字符串字段；顶层 session_id 与 uk 恒空）；
//   · KukuAI 的多轮拍平口径（单条消息不加角色前缀、兜底串、段间空行）；
//   · MonkeyCode 建任务体（system 走独立字段且只取第一条、resource 与任务流总时长同口径）
//     与 ACP 翻译（工具调用 id 合成规则、tool_call_update 增量路由、usage 是累计值）；
//   · 双表一致性：CHANNELS 与 ADAPTERS 必须同时有三个新渠道 id，漏一边启动期就该红。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-kuku-monkey-"));
process.env.AGENTHUB_DATA_DIR = TMP;

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 300)}` : "");
  }
}

const P = "../electron/backend/proxy";

async function main() {
  // ──────────────────────────────────────────────────────────────
  console.log("\n[1] 渠道注册表（双表一致性）");
  {
    const store = require(`${P}/store.cjs`);
    const adapters = require(`${P}/adapters.cjs`);
    const ids = store.CHANNELS.map((c) => c.id);
    for (const id of ["kuku", "monkeycode", "monkeycode_intl"]) {
      ok(ids.includes(id), `CHANNELS 含 ${id}`);
      ok(typeof adapters.get(id) === "object" && adapters.get(id) !== null, `ADAPTERS 含 ${id}`);
    }
    const report = adapters.consistencyReport();
    ok(report.channelsWithoutAdapter.length === 0, "没有「有渠道无适配器」的缺口", report);
    ok(report.adaptersWithoutChannel.length === 0, "没有「有适配器无渠道」的缺口", report);
    for (const id of ["kuku", "monkeycode", "monkeycode_intl"]) {
      const ad = adapters.get(id);
      const missing = adapters.REQUIRED_ADAPTER_METHODS.filter((m) => typeof ad[m] !== "function");
      ok(missing.length === 0, `${id} 适配器必需方法齐全`, missing);
    }
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[2] KukuAI 凭据：Cookie 解析与出站头");
  {
    const credentials = require(`${P}/kuku/credentials.cjs`);

    const fromHeader = credentials.credentialsFromPayload("BDUSS=abc123456789; STOKEN=st1; PTOKEN=pt1; BAIDUID=bid; gfprotpl=other");
    ok(fromHeader.bduss === "abc123456789", "Cookie 头形态取到 BDUSS", fromHeader);
    ok(fromHeader.stoken === "st1", "Cookie 头形态取到 STOKEN");
    ok(!fromHeader.extras.some(([n]) => n.toLowerCase() === "gfprotpl"), "恒附加项 gfprotpl 不入库", fromHeader.extras);
    ok(
      credentials.ptokenOf(fromHeader.extras) === "pt1",
      "PTOKEN 从 extras 里取到（业务令牌换发的必要材料）",
      credentials.ptokenOf(fromHeader.extras),
    );
    // 序列化顺序是协议形态的一部分：BDUSS → STOKEN → extras → 恒定项
    ok(
      credentials.cookieHeader(fromHeader) ===
        "BDUSS=abc123456789; STOKEN=st1; PTOKEN=pt1; BAIDUID=bid; gfprotpl=genflowpro",
      "Cookie 头按固定顺序序列化且恒附加项在最后",
      credentials.cookieHeader(fromHeader),
    );
    // 落库形态就是这一段串：再解一次必须等价（幂等，不能越解越多）
    const again = credentials.parseCookieHeader(credentials.cookieHeader(fromHeader));
    ok(again && credentials.cookieHeader(again) === credentials.cookieHeader(fromHeader), "Cookie 头解↔拼幂等");

    const fromArray = credentials.credentialsFromPayload([
      { name: "BDUSS", value: "arr123456789" },
      { name: "STOKEN", value: "arrst" },
    ]);
    ok(fromArray.bduss === "arr123456789" && fromArray.stoken === "arrst", "Cookie 编辑器 JSON 数组形态可解", fromArray);

    const fromNested = credentials.credentialsFromPayload({ auth: "BDUSS=nest1234567; STOKEN=nestst" });
    ok(fromNested.bduss === "nest1234567" && fromNested.stoken === "nestst", "嵌套 {auth:{…}} 形态可解", fromNested);

    let shortRejected = false;
    try {
      credentials.credentialsFromPayload("BDUSS=tiny; STOKEN=x");
    } catch {
      shortRejected = true;
    }
    ok(shortRejected, "BDUSS 过短直接拒（不给「看起来添加成功了」的假象）");

    const headers = credentials.requestHeaders(fromHeader, "application/json, text/plain, */*");
    ok(headers.Origin === "https://kuku.baidu.com" && headers.Referer === "https://kuku.baidu.com/genflowpro", "同源 Origin/Referer", headers);
    ok(/Chrome\/146\.0\.0\.0/.test(headers["User-Agent"]), "UA 锁定网页客户端那一份（默认 UA 会被判非官方客户端）", headers["User-Agent"]);
    ok(!Object.keys(headers).some((k) => k.toLowerCase().startsWith("sec-")), "不手写 sec-* 头（上游不读，多写反而与客户端形态不一致）", Object.keys(headers));
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[3] KukuAI 多轮拍平与模型归一");
  {
    const chat = require(`${P}/kuku/chat.cjs`);
    const models = require(`${P}/kuku/models.cjs`);

    ok(chat.buildPrompt([{ role: "system", content: "只要事实" }]) === "只要事实", "单条消息不加角色前缀（含 system）");
    ok(chat.buildPrompt([]) === "你好" && chat.buildPrompt(null) === "你好", "空/缺 messages 用兜底串");
    ok(
      chat.buildPrompt([
        { role: "system", content: "S" },
        { role: "user", content: "U1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "U2" },
      ]) === "[系统指令] S\n\nU1\n\n[助手之前的回复] A1\n\nU2",
      "多条时按角色标注并以空行连接",
      chat.buildPrompt([
        { role: "system", content: "S" },
        { role: "user", content: "U1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "U2" },
      ]),
    );
    ok(
      chat.buildPrompt([{ role: "user", content: [{ type: "text", text: "部件一" }, { type: "text", text: "部件二" }] }]) === "部件一\n部件二",
      "content 数组按 text 部件收集",
    );
    ok(
      chat.buildPrompt([
        { role: "user", content: "  " },
        { role: "tool", content: "T" },
      ]) === "T",
      "纯空白消息被丢弃、未知角色不标注",
    );

    ok(models.resolveModel("kuku/glm-5.3") === "glm-5.3", "点名的 kuku/ 前缀被剥掉");
    ok(models.resolveModel("gateway-glm-5.3-flash") === "gateway-glm-5.3-flash", "清单内的模型名原样透传");
    ok(models.resolveModel("不存在的模型") === "auto", "未知名显式回退 auto（上游对未知名是静默降级的）");
    ok(models.resolveModel("") === "auto", "空名回退 auto");
    ok(models.FALLBACK_MODEL_IDS[0] === "auto" && models.FALLBACK_MODEL_IDS.length === 13, "静态兜底清单 13 项且首位是 auto", models.FALLBACK_MODEL_IDS.length);
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[4] KukuAI 四跳链：顺序、URL 与请求体形态");
  {
    const chat = require(`${P}/kuku/chat.cjs`);
    const session = require(`${P}/kuku/session.cjs`);
    const endpoints = require(`${P}/kuku/endpoints.cjs`);

    const calls = [];
    const emitted = [];
    const makeDeps = () => ({
      httpJson: async (url, opts) => {
        calls.push({ url, method: (opts && opts.method) || "GET", body: opts && opts.body });
        if (url.includes(endpoints.PATHS.userReport)) {
          return { ok: true, status: 200, data: { errno: 0, data: { bdstoken: "BST", uinfo: "U1", uk: 88001 } } };
        }
        if (url.includes(endpoints.PATHS.sendMsg)) {
          return { ok: true, status: 200, data: { status: { code: 0, msg: "ok" }, data: { session_id: "S1", reply_id: "R1" } } };
        }
        return { ok: true, status: 200, data: { status: { code: 0 }, errno: 0, data: {} } };
      },
      fetchStream: async (url, opts) => {
        calls.push({ url, method: "POST(SSE)", body: opts && opts.body, headers: opts && opts.headers });
        return { resp: { __sse: true }, cancelTimer: () => {}, budgetFired: () => false };
      },
      pumpSse: async (resp, onEvent) => {
        for (const frame of [
          { type: "TEXT_BLOCK_DELTA", data: { delta: "你好" } },
          { type: "TEXT_BLOCK_DELTA", data: { delta: "" } },
          { type: "SOMETHING_UNKNOWN", data: {} },
          { type: "DIALOGUE_END" },
        ]) {
          onEvent("", JSON.stringify(frame));
        }
      },
      firstByteBudgetMs: () => 30000,
      uuid: () => "11111111-2222-4444-8888-999999999999",
      verbose: () => {},
    });

    const cred = { bduss: "B".repeat(20), stoken: "ST", extras: [["PTOKEN", "PT"]] };
    calls.length = 0;
    emitted.length = 0;
    const result = await chat.runChat({
      deps: makeDeps(),
      credential: cred,
      body: { model: "glm-5.3", messages: [{ role: "user", content: "说一句你好" }] },
      model: "glm-5.3",
      emit: (ev) => emitted.push(ev),
    });
    ok(result && result.status === 200, "chat 返回 {status:200}");

    const paths = calls.map((c) => c.url);
    ok(
      paths[0].includes("/api/genflowpro/common/userreport") &&
        paths[1].includes("/wenchain/genflowpro/sendmsg") &&
        paths[2].includes("/wenchain/genflow/idallochstr") &&
        paths[3].includes("/api/genflowpro/workspace/sessionswitch") &&
        paths[4].includes("/wenchain/genflowpro/sse/getchatcontent"),
      "四跳顺序正确，且分配算力挂在 /wenchain/genflow/ 下",
      paths,
    );
    ok(paths[1].includes("bdstoken=BST&uinfo=U1&uk=88001"), "会话三件套原样拼进 query（数字形态的 uk 也收下）", paths[1]);
    ok(session.tokenQuery({ bdstoken: "a", uinfo: "b", uk: "c" }) === "&bdstoken=a&uinfo=b&uk=c", "tokenQuery 拼装形状");

    const sendBody = JSON.parse(calls[1].body);
    ok(sendBody.session_id === "" && sendBody.uk === "", "建会话体里顶层 session_id / uk 恒空（真值在 client_added）", {
      session_id: sendBody.session_id,
      uk: sendBody.uk,
    });
    ok(typeof sendBody.data.show_text === "string" && typeof sendBody.data.client_added === "string", "show_text / client_added 是字符串字段", {
      show_text: typeof sendBody.data.show_text,
      client_added: typeof sendBody.data.client_added,
    });
    const added = JSON.parse(sendBody.data.client_added);
    ok(
      added.app_id === endpoints.APP_ID && added.clienttype === 400 && added.web === 1 && added.channel === "chunlei" && added.version === "1.4.4",
      "client_added 带齐客户端形态字段",
      added,
    );
    ok(added.bdstoken === "BST" && added.uinfo === "U1" && String(added.uk) === "88001", "client_added 里的三件套是真值", added);
    ok(sendBody.channel === "kuku_web_genflowpro_v1" && sendBody.data.think_mode === 3, "会话通道名与思考档位按内置口径发", {
      channel: sendBody.channel,
      think_mode: sendBody.data.think_mode,
    });
    ok(/^[0-9a-f]{24}$/.test(sendBody.v), "v 是 24 位小写十六进制随机串", sendBody.v);
    ok(sendBody.client_session_id === added.client_session_id, "client_session_id 两处一致", sendBody.client_session_id);

    const chatBody = JSON.parse(calls[4].body);
    ok(chatBody.session_id === "S1" && chatBody.reply_id === "R1", "取回请求带上会话与回复标识", { s: chatBody.session_id, r: chatBody.reply_id });
    ok(!("client_added" in chatBody), "取回请求体不带 client_added（那是建会话那一跳的字段）");
    ok(calls[4].headers.Cookie.includes("BDUSS=") && calls[4].headers.Accept === "text/event-stream", "SSE 请求带 Cookie 与 text/event-stream", calls[4].headers && calls[4].headers.Accept);

    const deltas = emitted.filter((e) => e.type === "delta").map((e) => e.delta.content).join("");
    ok(deltas === "你好", "空增量与未知事件都不产帧，正文只有一条「你好」", deltas);
    const last = emitted[emitted.length - 1];
    ok(last && last.type === "finish" && last.reason === "stop", "上游给了结束帧 → 收尾 finish/stop", last);

    // ctx.model 是网关按目录/别名解析后的"要转发给上游的那一个"，body.model 可能是统一虚拟名。
    // 取错一侧的后果是：虚拟名不在清单里 → 静默回退 auto，用户看到"选了 A、实际用的是自动选路"
    calls.length = 0;
    await chat.runChat({
      deps: makeDeps(),
      credential: cred,
      body: { model: "AgentHub-统一名", messages: [{ role: "user", content: "x" }] },
      model: "gateway-glm-5.2",
      emit: () => {},
    });
    const alignedCall = calls.find((c) => c.url.includes(endpoints.PATHS.sendMsg));
    const aligned = JSON.parse(alignedCall.body);
    ok(aligned.data.model_name === "gateway-glm-5.2", "转发用 ctx.model，统一虚拟名不会退化成 auto", aligned.data.model_name);
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[5] KukuAI 流内错误与空回答的定性");
  {
    const chat = require(`${P}/kuku/chat.cjs`);
    const endpoints = require(`${P}/kuku/endpoints.cjs`);
    const cred = { bduss: "B".repeat(20), stoken: "ST", extras: [] };

    const baseDeps = (frames) => ({
      httpJson: async (url) =>
        url.includes(endpoints.PATHS.userReport)
          ? { ok: true, status: 200, data: { errno: 0, data: { bdstoken: "BST", uinfo: "U", uk: "1" } } }
          : url.includes(endpoints.PATHS.sendMsg)
            ? { ok: true, status: 200, data: { status: { code: 0 }, data: { session_id: "S", reply_id: "R" } } }
            : { ok: true, status: 200, data: { status: { code: 0 }, errno: 0 } },
      fetchStream: async () => ({ resp: {}, cancelTimer: () => {}, budgetFired: () => false }),
      pumpSse: async (_resp, onEvent) => {
        for (const f of frames) onEvent("", JSON.stringify(f));
      },
      firstByteBudgetMs: () => 30000,
      uuid: () => "u",
      verbose: () => {},
    });

    // 一个字都没答就 ERROR：此刻还没有任何字节下发，必须抛错（编排层据此落真实状态码并换号）。
    // 只报流内 error 事件等于把一次账号失效伪装成"这次回答失败了"，跨账号降级链不会被触发。
    let streamErr = null;
    const emittedA = [];
    try {
      await chat.runChat({
        deps: baseDeps([{ type: "ERROR", data: { message: "额度用尽" } }]),
        credential: cred,
        body: { messages: [{ role: "user", content: "hi" }] },
        model: "auto",
        emit: (e) => emittedA.push(e),
      });
    } catch (e) {
      streamErr = e;
    }
    ok(streamErr && Number(streamErr.status) === 502 && /额度用尽/.test(streamErr.message), "无内容 + 流内 ERROR → 抛 502 并带上游文案（不静默 emit）", streamErr && streamErr.message);
    ok(emittedA.length === 0, "抛错路径上一个字节都没下发（换号无损）", emittedA);

    // 已经答出来过内容：只收尾，不再把已有内容改判成错误
    const emittedB = [];
    await chat.runChat({
      deps: baseDeps([{ type: "TEXT_BLOCK_DELTA", data: { delta: "半句" } }, { type: "ERROR", data: { message: "后面断了" } }]),
      credential: cred,
      body: { messages: [{ role: "user", content: "hi" }] },
      model: "auto",
      emit: (e) => emittedB.push(e),
    });
    ok(
      emittedB.filter((e) => e.type === "delta").length === 1 &&
        emittedB.some((e) => e.type === "error") &&
        emittedB[emittedB.length - 1].type === "finish",
      "有内容 + 流内 ERROR → 保留内容、如实发错误帧、并以 finish 收尾（头已发出，只能进流内）",
      emittedB,
    );

    // 上游干净地关了流却一个字没答 → 抛错（此刻还没下发字节，编排层可以换号）
    let threwEmpty = false;
    try {
      await chat.runChat({
        deps: baseDeps([]),
        credential: cred,
        body: { messages: [{ role: "user", content: "hi" }] },
        model: "auto",
        emit: () => {},
      });
    } catch (e) {
      threwEmpty = Number(e.status) === 502;
    }
    ok(threwEmpty, "空回答抛 502，不当成功返回");
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[6] KukuAI 会话失效自愈与积分口径");
  {
    const session = require(`${P}/kuku/session.cjs`);
    const balance = require(`${P}/kuku/balance.cjs`);
    const endpoints = require(`${P}/kuku/endpoints.cjs`);

    // errno=-6 且没有 PTOKEN（换不了业务令牌）→ 401，并在文案里指出根因
    // 用独立 BDUSS + force=true：会话槽按 BDUSS 缓存，前面的用例已经为同值建过槽，
    // 复用它就会命中缓存、根本不发请求（那等于什么都没测）
    let err = null;
    try {
      await session.ensureTriple(
        { bduss: "PASSPORTLEVEL".padEnd(20, "x"), stoken: "passportlevel", extras: [] },
        {
          httpJson: async () => ({ ok: true, status: 200, data: { errno: -6, show_msg: "未登录" } }),
          verbose: () => {},
        },
        true,
      );
    } catch (e) {
      err = e;
    }
    ok(err && Number(err.status) === 401 && /errno=-6/.test(err.message), "会话校验未通过 → 401 且带上 errno", err && err.message);

    // 积分字符串形态要能读（上游 totalPoint 是 "1100" 这种）
    const credits = await balance.queryCredits(
      { bduss: "B".repeat(20), stoken: "S", extras: [] },
      {
        httpJson: async () => ({
          ok: true,
          status: 200,
          data: { status: { code: 0, msg: "success" }, data: { list: [{ assetName: "duration", totalPoint: "9" }, { assetName: "token", totalPoint: "1100" }] } },
        }),
        verbose: () => {},
      },
    );
    ok(credits.credits === 1100, "按 assetName 取 token 资产而不是第一项", credits);
    ok(credits.expiresAt === 0, "expiresAt 恒 0 = 不过期（回填假到期会把账号锁成余额已到期）", credits.expiresAt);
    ok(!endpoints.POINTS_QUERY.includes("app_id"), "积分接口不带 app_id（该接口不认它）", endpoints.POINTS_QUERY);

    // 读不到积分时必须说「查不到」，绝不能回 0：号池把 0 判成额度耗尽并自动切号
    const bad = await balance.queryCredits({ bduss: "B".repeat(20), stoken: "S", extras: [] }, { httpJson: async () => ({ ok: true, status: 200, data: { status: { code: 0 }, data: {} } }) });
    ok(bad.unavailable === true && bad.credits === undefined, "结构变化时回 unavailable 而不是 0", bad);
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[7] MonkeyCode 凭据粘贴形态与站点身份");
  {
    const credentials = require(`${P}/monkeycode/credentials.cjs`);
    const regionStore = require(`${P}/monkeycode/region.cjs`);
    const endpoints = require(`${P}/monkeycode/endpoints.cjs`);

    ok(credentials.normalizeSession("monkeycode_ai_session=abc.def.ghi") === "abc.def.ghi", "cookie 名前缀被剥成裸值（整行发上去会稳定 401）");
    ok(credentials.normalizeSession("Cookie: other=1; monkeycode_ai_session=xyz123; z=2") === "xyz123", "整行 Cookie 里能捞出本渠道的值");
    ok(credentials.normalizeSession("raw-token-value") === "raw-token-value", "裸值原样收下");
    ok(credentials.normalizeSession('{"accessToken":"from-json"}') === "from-json", "JSON 对象的键名别名可解");
    ok(credentials.normalizeSession(JSON.stringify([{ name: "monkeycode_ai_session", value: "from-array" }])) === "from-array", "Cookie 数组形态可解");
    ok(credentials.normalizeSession("monkeycode_ai_team_session=abc") === "", "团队 cookie 不当普通 session 用");
    ok(credentials.normalizeSession("x".repeat(9000)) === "", "超长粘贴判为无效（基本是把整段 Cookie 表或文件贴进来了）");
    ok(credentials.normalizeSession("other_cookie=somevalue") === "", "别的 cookie 名不误当本渠道 session");

    const cn = regionStore.byChannel("monkeycode");
    const intl = regionStore.byChannel("monkeycode_intl");
    ok(cn.siteOrigin === "https://monkeycode-ai.com" && intl.siteOrigin === "https://monkeycode-ai.net", "双站域名分离", [cn.siteOrigin, intl.siteOrigin]);
    ok(regionStore.ORDER[0] === cn, "国内版排在前面（同名模型归给先出现的站点）");

    const url = endpoints.taskStreamUrl(cn, {}, "task/uuid", "new");
    ok(url === "wss://monkeycode-ai.com/api/v1/users/tasks/stream?id=task%2Fuuid&mode=new", "任务流地址：scheme 转换 + id 编码 + mode=new", url);

    const rest = endpoints.jsonHeaders(cn, {});
    ok(rest.Origin === cn.siteOrigin && rest.Referer === `${cn.siteOrigin}/`, "Origin/Referer 按站点真身（改基址不改来源判定）", rest);
    ok(rest["User-Agent"] === "monkeycode-local-proxy", "UA 是可辨识的网关自报形态，不冒充浏览器", rest["User-Agent"]);
    const ws = endpoints.wsHeaders(cn, "S1", {});
    ok(ws.Cookie === "monkeycode_ai_session=S1" && !("Referer" in ws), "握手头带 Cookie 但不带 Referer", ws);
    ok(!Object.keys(ws).some((k) => k.toLowerCase().startsWith("sec-websocket")), "不手写 Sec-WebSocket-*（必须与库的掩码状态一致）", Object.keys(ws));
    ok(endpoints.cliNameFor("OpenAI_Responses") === "codex" && endpoints.cliNameFor("anthropic") === "claude" && endpoints.cliNameFor("") === "opencode", "interface_type → coding agent 映射，未知回最通用一档");
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[8] MonkeyCode 建任务体与错误码表");
  {
    const task = require(`${P}/monkeycode/task.cjs`);
    const regionStore = require(`${P}/monkeycode/region.cjs`);

    const p = task.buildPrompt([
      { role: "system", content: "第一条系统提示" },
      { role: "system", content: "第二条应被忽略" },
      { role: "user", content: "改一下登录 bug" },
      { role: "assistant", content: "我看下代码" },
      { role: "tool", content: "工具结果原文" },
    ]);
    ok(p.systemPrompt === "第一条系统提示", "system 只取第一条非空的，且不进正文", p);
    ok(
      p.prompt === "[User]\n改一下登录 bug\n\n[Assistant]\n我看下代码\n\n工具结果原文",
      "角色前缀与段间空行；未知角色不标注",
      p.prompt,
    );

    let bad = null;
    try {
      task.buildPrompt([{ role: "user", content: [] }]);
    } catch (e) {
      bad = e;
    }
    ok(bad && Number(bad.status) === 400, "没有可发送文本时 400（上游不收空 content）", bad && bad.status);

    const calls = [];
    const deps = {
      httpJson: async (url, opts) => {
        calls.push({ url, body: opts && opts.body, headers: opts && opts.headers });
        return { ok: true, status: 200, text: "", data: { code: 0, msg: "success", data: { id: "task-uuid-1" } } };
      },
      verbose: () => {},
    };
    const region = regionStore.byChannel("monkeycode");
    const taskId = await task.createTask({
      region,
      section: {},
      deps,
      session: "S",
      prompt: p,
      target: { modelId: "model-uuid", cliName: "opencode", model: "gpt-4o" },
      imageId: "image-uuid",
    });
    ok(taskId === "task-uuid-1", "任务 id 从 data.id 取出", taskId);
    const sent = JSON.parse(calls[0].body);
    ok(sent.content === p.prompt && sent.system_prompt === "第一条系统提示", "正文与 system_prompt 分字段发", Object.keys(sent));
    ok(
      sent.host_id === "public_host" && sent.image_id === "image-uuid" && sent.model_id === "model-uuid" && sent.cli_name === "opencode",
      "建任务体的四个标识字段各归各位",
      sent,
    );
    ok(sent.resource.life === 3600 && sent.resource.memory === 1073741824, "资源限额与任务流总时长同口径", sent.resource);
    ok(sent.repo.branch === "master" && sent.repo.repo_url === "", "repo 段固定空仓库 + master（上游要求字段存在）", sent.repo);
    ok(calls[0].headers["Content-Type"] === "application/json" && calls[0].headers.Cookie === "monkeycode_ai_session=S", "建任务请求头齐", calls[0].headers);

    const ud = JSON.parse(task.userInputData("说一句你好"));
    ok(ud.content === Buffer.from("说一句你好", "utf8").toString("base64") && Array.isArray(ud.attachments), "起始 user-input 用 base64 + attachments 的新上行格式", ud);

    ok(task.statusError(402, "").status === 402 && /额度不足/.test(task.statusError(402, "").message), "HTTP 402 → 额度不足文案");
    ok(task.businessError(10811, "").status === 409, "业务码 10811（同账号已有任务）→ 409 而不是账号故障", task.businessError(10811, ""));
    ok(task.businessError(40100, "").status === 401, "业务码 40100 → 401 重新粘贴 session");
    ok(task.businessError(50000, "").status === 502, "业务码 50000 → 502（可重试）");
    ok(task.statusError(503, "").status === 502, "上游 5xx 归一成 502，与 4xx 的参数/权限问题分开");
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[9] MonkeyCode ACP 事件翻译");
  {
    const stream = require(`${P}/monkeycode/stream.cjs`);
    const t = new stream.Translator("task-uuid-1", "siliconflow/gpt-4o", true);

    ok(t.handleAcp({ type: "agent_message_chunk", text: "正文" }).deltas[0].content === "正文", "agent_message_chunk → delta.content");
    ok(t.handleAcp({ type: "agent_thought_chunk", content: "想法" }).deltas[0].reasoning_content === "想法", "agent_thought_chunk → delta.reasoning_content（思考通道，不拼进正文）");

    const call = t.handleAcp({ type: "tool_call", tool_name: "edit_file", tool_input: { path: "a.ts" } }).deltas[0];
    ok(call.tool_calls[0].id === "call_0_task-uuid-1", "ACP 不带工具调用 id → 按「call_<序号>_<任务 id>」合成，客户端才能配对结果", call.tool_calls[0]);
    ok(call.tool_calls[0].function.arguments === '{"path":"a.ts"}', "tool_input 是对象时按 JSON 串下发", call.tool_calls[0].function.arguments);

    const upd = t.handleAcp({ type: "tool_call_update", tool_name: "edit_file", delta: ",more" }).deltas[0];
    ok(upd.tool_calls[0].index === 0 && upd.tool_calls[0].function.arguments === ",more", "tool_call_update 按增量下发并按名回到最近一次同名调用", upd);
    ok(t.tools[0].arguments === '{"path":"a.ts"},more', "增量累积进该次调用的 arguments", t.tools[0].arguments);
    ok(t.handleAcp({ type: "tool_call_update", delta: "无名字且有上次的调用" }).deltas.length === 1, "无 tool_name 时回落到最近一次调用");
    ok(t.handleAcp({ type: "tool_call_update", tool_name: "没见过的工具", delta: "x" }).deltas.length === 0, "名字对不上任何调用就不造帧");

    t.handleAcp({ type: "usage_update", input_tokens: 30, output_tokens: 5, total_tokens: 35 });
    t.handleAcp({ type: "usage_update", input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    ok(t.usage.prompt_tokens === 30 && t.usage.total_tokens === 35, "usage_update 是累计值：非零才覆盖，0 视为上游没说话", t.usage);

    ok(t.handleAcp({ type: "plan" }).deltas.length === 0 && t.handleAcp({ type: "available_commands_update" }).deltas.length === 0, "plan / available_commands_update 只记录不造帧");
    ok(t.handleAcp({ type: "完全未知的事件" }).deltas.length === 0, "未知事件忽略");

    const q1 = stream.questionReply(JSON.stringify({ request_id: "rq-1" }));
    ok(q1.type === "reply-question" && JSON.parse(q1.data).request_id === "rq-1" && JSON.parse(q1.data).cancelled === false, "Agent 提问自动回复（空答案 + 不取消），否则任务停在提问处", q1);
    const q2 = stream.questionReply(Buffer.from(JSON.stringify({ id: "rq-2" }), "utf8").toString("base64"));
    ok(q2 && JSON.parse(q2.data).request_id === "rq-2", "提问 data 的 base64 形态也认", q2);
    ok(stream.questionReply("不是 JSON 也不是 base64 的东西") === null, "认不出提问结构时回 null（不硬回一个空 request_id 糊弄）");

    ok(stream.errorDetail("上游给的原文") === "上游给的原文", "task-error 字符串形态直接做人话");
    ok(/上游未给原因/.test(stream.errorDetail({ foo: 1 })), "task-error 结构认不出时给默认文案");
    ok(stream.TASK_TOTAL_MS === 3600000 && stream.TASK_TOTAL_MS === 60 * 60 * 1000, "任务流总时长与 resource.life 同口径");
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[10] MonkeyCode 适配器：装配链路与能力如实声明");
  {
    const stream = require(`${P}/monkeycode/stream.cjs`);
    const models = require(`${P}/monkeycode/models.cjs`);
    const { makeMonkeyCode } = require(`${P}/monkeycode/adapter.cjs`);
    // 现造一个挂假 HTTP 的适配器实例：注册表里那一份走真网络，离线自测不能依赖它
    // （[1] 已经验过三个 id 都在注册表里、契约方法齐全，这里只验装配链路）
    const httpCalls = [];
    const ad = makeMonkeyCode("monkeycode", {
      httpJson: async (url, opts) => {
        httpCalls.push({ url, body: opts && opts.body, headers: opts && opts.headers });
        return { ok: true, status: 200, text: "", data: { code: 0, msg: "success", data: { id: "task-uuid-9" } } };
      },
      fetchStream: async () => ({ resp: {}, cancelTimer: () => {}, budgetFired: () => false }),
      pumpSse: async () => {},
      firstByteBudgetMs: () => 30000,
    });

    ok((await ad.queryCredits()).unavailable === true, "没有余额接口 → 如实 unavailable（绝不回 0，那会被判额度耗尽）");
    ok((await ad.refreshToken()).noRefresh === true, "没有续期接口 → noRefresh");
    ok((await ad.checkin()).unavailable === true, "没有签到活动 → unavailable");
    ok(ad.classifyError({ status: 409 }).switchable === true, "「同账号已有任务」可换号（并发不是故障）");
    ok(ad.classifyError({ status: 409 }).kind === "rate", "409 走限流档：短冷却 + 换号，而不是把账号判成坏号");
    ok(ad.classifyError({ status: 401 }).kind === "relogin", "401 走需重登档");
    ok(ad.classifyError({ status: 402 }).kind === "credit", "402 走额度档");
    ok(ad.classifyError({ status: 500 }) === null, "其余交给通用分类器");

    // 缺 session / 缺镜像 id / 目录未拉取 三种前置失败
    let e1 = null;
    try {
      await ad.chat({ secrets: { token: "" }, body: { model: "x", messages: [{ role: "user", content: "hi" }] }, emit: () => {} });
    } catch (e) {
      e1 = e;
    }
    ok(e1 && Number(e1.status) === 401, "缺 session 直接 401，不发任何上游请求", e1 && e1.message);

    let e2 = null;
    try {
      await ad.chat({ secrets: { token: "monkeycode_ai_session=S" }, account: { id: "a1" }, body: { model: "x", messages: [{ role: "user", content: "hi" }] }, emit: () => {} });
    } catch (e) {
      e2 = e;
    }
    ok(e2 && Number(e2.status) === 400 && /镜像 id/.test(e2.message), "缺镜像 id 明确拒并说清怎么补（不拿空值去建任务碰运气）", e2 && e2.message);

    // 目录里有模型 + 桩掉任务流 → 走完整链路，事件按本仓库口径回流
    const refreshed = await models.refresh(
      require(`${P}/monkeycode/region.cjs`).byChannel("monkeycode"),
      {},
      { httpJson: async () => ({ ok: true, status: 200, data: { code: 0, data: { models: [{ id: "uuid-1", model: "gpt-4o", provider: "siliconflow", display_name: "GPT-4o", interface_type: "openai_chat", is_default: true }] } } }), verbose: () => {} },
      "S",
      true,
    );
    ok(refreshed.ok && refreshed.models[0] === "siliconflow/gpt-4o", "目录条目 id 用 provider/model 形态", refreshed.models);
    const entries = models.list("monkeycode");
    ok(entries[0].upstreamId === "uuid-1" && entries[0].cliName === "opencode" && entries[0].supportsToolCall === true && entries[0].supportsImages === false, "能力位：工具是 agent 固有给 true，图片没依据保守 false", entries[0]);

    const seen = {};
    const original = stream.runTaskStream;
    stream.runTaskStream = async (opts) => {
      seen.taskId = opts.taskId;
      seen.requestedModel = opts.requestedModel;
      seen.includeUsage = opts.includeUsage;
      opts.emit({ type: "delta", delta: { content: "搞定" } });
      opts.emit({ type: "finish", reason: "stop" });
      return { summary: () => "测试" };
    };
    try {
      const emitted = [];
      const r = await ad.chat({
        secrets: { token: "S", meta: { imageId: "img-1" } },
        account: { id: "a1" },
        model: "siliconflow/gpt-4o",
        body: { model: "siliconflow/gpt-4o", messages: [{ role: "user", content: "修个 bug" }], stream_options: { include_usage: true } },
        emit: (e) => emitted.push(e),
        meta: { signal: null },
      });
      ok(r.status === 200 && emitted.length === 2, "chat 走「建任务 → 任务流」并把事件原样回流", emitted);
      ok(seen.taskId === "task-uuid-9", "任务流挂在建任务返回的 id 上", seen.taskId);
      const sentTask = httpCalls.find((c) => String(c.url).endsWith("/api/v1/users/tasks"));
      ok(
        sentTask && sentTask.url === "https://monkeycode-ai.com/api/v1/users/tasks" && JSON.parse(sentTask.body).model_id === "uuid-1",
        "建任务打到国内站，并把目录里的模型 UUID（不是模型名）当 model_id 发出去",
        { calls: httpCalls.map((c) => c.url), body: sentTask && sentTask.body },
      );
      ok(seen.requestedModel === "siliconflow/gpt-4o" && seen.includeUsage === true, "下发给客户端的模型名用客户端请求的那一个（统一名不改写）", seen);
    } finally {
      stream.runTaskStream = original;
    }

    // 镜像 id 不在登录态里，号池编辑面也没有输入位：转发时从「最近任务」发现一次并落账号 meta
    const saved = [];
    const callOrder = [];
    const ad2 = makeMonkeyCode("monkeycode", {
      httpJson: async (url) => {
        callOrder.push(url);
        if (url.includes("/api/v1/users/tasks?page=1&size=5")) {
          return { ok: true, status: 200, text: "", data: { code: 0, data: { tasks: [{ image: { id: "img-found" } }] } } };
        }
        return { ok: true, status: 200, text: "", data: { code: 0, data: { id: "task-2" } } };
      },
      fetchStream: async () => ({ resp: {}, cancelTimer: () => {}, budgetFired: () => false }),
      pumpSse: async () => {},
      firstByteBudgetMs: () => 30000,
      store: {
        getAccount: (id) => ({ id, meta: JSON.stringify({ note: "既有备注" }) }),
        updateAccount: (id, patch) => {
          saved.push({ id, patch });
          return true;
        },
      },
    });
    stream.runTaskStream = async () => ({});
    try {
      await ad2.chat({
        secrets: { token: "S" },
        account: { id: "a2" },
        model: "siliconflow/gpt-4o",
        body: { model: "siliconflow/gpt-4o", messages: [{ role: "user", content: "hi" }] },
        emit: () => {},
        meta: {},
      });
    } finally {
      stream.runTaskStream = original;
    }
    ok(
      callOrder[0].endsWith("/api/v1/users/tasks?page=1&size=5") && callOrder[1] === "https://monkeycode-ai.com/api/v1/users/tasks",
      "先发现镜像 id，再建任务",
      callOrder,
    );
    ok(
      saved.length === 1 && saved[0].patch.meta.imageId === "img-found" && saved[0].patch.meta.note === "既有备注",
      "镜像 id 落库时保留既有 meta（updateAccount 收的是对象，序列化由 store 负责；它是整份替换语义，必须先读回再合并）",
      saved,
    );

    // 国际站目录一格都没填过：先自动刷一次再判可用性。让用户"先去模型页点一下再回来"不是
    // 不可能，只是无谓的往返；刷完仍空才如实报 503。
    // 同时验模型名口径：ctx.model（解析后的上游名）优先于 body.model（这里的统一虚拟名）。
    const intlCalls = [];
    const adIntl = makeMonkeyCode("monkeycode_intl", {
      httpJson: async (url) => {
        intlCalls.push(url);
        if (url.includes("/api/v1/users/models")) {
          return {
            ok: true,
            status: 200,
            text: "",
            data: { code: 0, data: { models: [{ id: "mu-1", model: "kimi-k2", provider: "moonshot", interface_type: "openai_chat" }] } },
          };
        }
        return { ok: true, status: 200, text: "", data: { code: 0, data: { id: "t-intl" } } };
      },
      fetchStream: async () => ({ resp: {}, cancelTimer: () => {}, budgetFired: () => false }),
      pumpSse: async () => {},
      firstByteBudgetMs: () => 30000,
      store: { getAccount: () => null, updateAccount: () => true },
    });
    stream.runTaskStream = async () => ({});
    try {
      await adIntl.chat({
        secrets: { token: "S", meta: { imageId: "img-2" } },
        account: { id: "a3" },
        model: "moonshot/kimi-k2",
        body: { model: "AgentHub-统一名", messages: [{ role: "user", content: "hi" }] },
        emit: () => {},
        meta: {},
      });
    } finally {
      stream.runTaskStream = original;
    }
    ok(
      String(intlCalls[0]).startsWith("https://monkeycode-ai.net/api/v1/users/models"),
      "目录没拉过时先自动刷新一次（走的是国际站域名）",
      intlCalls[0],
    );
    ok(
      intlCalls.some((u) => u === "https://monkeycode-ai.net/api/v1/users/tasks"),
      "刷新完就能按 ctx.model 解析出的上游名建任务——统一虚拟名不会被判「目录里找不到」",
      intlCalls,
    );
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[11] 号池导入：两家的凭据形态与账号身份");
  {
    const proxy = require(`${P}/index.cjs`);

    // KukuAI 的自然粘贴形态就是浏览器里复制到的 Cookie（平铺对象），不是 {"token":"…"}
    const kukuParsed = proxy.parseAccountsJson(JSON.stringify({ BDUSS: "b".repeat(24), STOKEN: "st", PTOKEN: "pt" }), "kuku");
    ok(kukuParsed.list.length === 1, "kuku 的 Cookie 对象形态能进「粘贴 JSON」这条路", kukuParsed);
    const kukuToken = (kukuParsed.list[0] || {}).token || "";
    ok(/BDUSS=/.test(kukuToken) && /STOKEN=st/.test(kukuToken) && /gfprotpl=genflowpro/.test(kukuToken), "归一成整段 Cookie 头（与适配器解析同一份口径）", kukuToken);
    ok(/^[0-9a-f]{16}$/.test((kukuParsed.list[0] || {}).uid || ""), "凭据哈希当 uid：号池按 (渠道,uid) 去重，留空会把同一个号反复导入", kukuParsed.list[0] && kukuParsed.list[0].uid);

    const mcParsed = proxy.parseAccountsJson(JSON.stringify([{ session: "sess-aaa" }, { accessToken: "sess-bbb" }]), "monkeycode");
    ok(mcParsed.list.length === 2, "session / accessToken 两种键名都能导入", mcParsed);
    ok(
      mcParsed.list.length === 2 && mcParsed.list[0].uid !== mcParsed.list[1].uid,
      "两个不同的号不会被并成同一个 uid",
      mcParsed.list.map((a) => a.uid),
    );

    // 结构不对时按「这一条不合格」计入 invalid，而不是抛错打断整包
    const bad = proxy.parseAccountsJson(JSON.stringify({ note: "没有凭据" }), "kuku");
    ok(bad.list.length === 0 && bad.invalid === 1, "缺 BDUSS 的条目计入 invalid（不抛错、不拖垮整包导入）", bad);
  }

  // ──────────────────────────────────────────────────────────────
  console.log("\n[12] MonkeyCode 任务流：真 WebSocket 握手与帧序（本地桩服务，不联上游）");
  {
    const http = require("node:http");
    const crypto = require("node:crypto");
    const { makeMonkeyCode } = require(`${P}/monkeycode/adapter.cjs`);

    // 只实现到够用：服务端→客户端不掩码、单帧不续帧；客户端→服务端按 RFC6455 解掩码。
    // 目的不是当协议库用，是把「握手头 + 客户端发的帧序 + 回程事件翻译 + 收尾」整条链跑通。
    function parseFrames(buf, onFrame) {
      let i = 0;
      while (buf.length - i >= 2) {
        const opcode = buf[i] & 0x0f;
        const masked = (buf[i + 1] & 0x80) !== 0;
        let len = buf[i + 1] & 0x7f;
        let p = i + 2;
        if (len === 126) {
          if (buf.length - p < 2) break;
          len = buf.readUInt16BE(p);
          p += 2;
        } else if (len === 127) {
          if (buf.length - p < 8) break;
          len = Number(buf.readBigUInt64BE(p));
          p += 8;
        }
        let key = null;
        if (masked) {
          if (buf.length - p < 4) break;
          key = buf.subarray(p, p + 4);
          p += 4;
        }
        if (buf.length - p < len) break;
        let payload = buf.subarray(p, p + len);
        if (key) {
          const out = Buffer.allocUnsafe(len);
          for (let k = 0; k < len; k += 1) out[k] = payload[k] ^ key[k % 4];
          payload = out;
        }
        onFrame(opcode, payload.toString("utf8"));
        i = p + len;
      }
      return buf.subarray(i);
    }

    function sendText(sock, text) {
      const payload = Buffer.from(String(text), "utf8");
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
      else if (payload.length < 65536) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      sock.write(Buffer.concat([header, payload]));
    }

    const seen = { headers: null, frames: [], url: "" };
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, msg: "success", data: { id: "ws-task-1" } }));
    });
    server.on("upgrade", (req, socket) => {
      seen.headers = req.headers;
      seen.url = req.url;
      const accept = crypto.createHash("sha1")
        .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      let buf = Buffer.alloc(0);
      // 状态机必须**按客户端的回复推进**：一次性把 6 条下行帧都发出去的话，task-ended 会先于
      // 心跳回复与提问回复到达，Promise 当场收尾并关连接，那两帧根本来不及发——测出来的是假失败。
      let stage = 0;
      const send = (text) => {
        try {
          sendText(socket, text);
        } catch {
          /* 客户端已收尾 */
        }
      };
      socket.on("data", (chunk) => {
        buf = parseFrames(Buffer.concat([buf, chunk]), (opcode, text) => {
          if (opcode === 8) {
            socket.end();
            return;
          }
          if (opcode !== 1) return;
          seen.frames.push(text);
          if (stage === 0 && text.includes("auto-approve")) {
            stage = 1;
            return;
          }
          if (stage === 1 && text.includes("user-input")) {
            stage = 2;
            send(JSON.stringify({ type: "ping" }));
            return;
          }
          if (stage === 2 && text.includes('"type":"ping"')) {
            stage = 3;
            send(JSON.stringify({ type: "task-started" }));
            send(JSON.stringify({ type: "task-running", kind: "acp_event", data: JSON.stringify({ type: "agent_message_chunk", text: "正在改" }) }));
            send(JSON.stringify({ type: "task-running", kind: "acp_ask_user_question", data: JSON.stringify({ request_id: "q1" }) }));
            return;
          }
          if (stage === 3 && text.includes("reply-question")) {
            stage = 4;
            send(JSON.stringify({ type: "task-running", kind: "acp_event", data: JSON.stringify({ type: "usage_update", input_tokens: 12, output_tokens: 7, total_tokens: 19 }) }));
            send(JSON.stringify({ type: "task-ended", data: {} }));
          }
        });
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    process.env.MONKEYCODE_BASE_URL = `http://127.0.0.1:${port}`;

    const emitted = [];
    const adLocal = makeMonkeyCode("monkeycode", {
      httpJson: async () => ({ ok: true, status: 200, text: "", data: { code: 0, data: { id: "ws-task-1" } } }),
      fetchStream: async () => ({ resp: {}, cancelTimer: () => {}, budgetFired: () => false }),
      pumpSse: async () => {},
      firstByteBudgetMs: () => 30000,
      store: { getAccount: () => null, updateAccount: () => true },
    });
    let streamError = null;
    try {
      await adLocal.chat({
        secrets: { token: "monkeycode_ai_session=real-session-value", meta: { imageId: "img-ws" } },
        account: { id: "a-ws" },
        model: "siliconflow/gpt-4o",
        body: { model: "siliconflow/gpt-4o", messages: [{ role: "user", content: "修登录 bug" }], stream_options: { include_usage: true } },
        emit: (e) => emitted.push(e),
        meta: {},
      });
    } catch (e) {
      streamError = e;
    }
    delete process.env.MONKEYCODE_BASE_URL;
    server.close();

    ok(!streamError, "任务流整条链跑通（无异常）", streamError && streamError.message);
    ok(/id=ws-task-1&mode=new$/.test(seen.url), "握手 URL 带任务 id 与 mode=new", seen.url);
    ok(seen.headers && seen.headers.cookie === "monkeycode_ai_session=real-session-value", "握手把 session 放进 Cookie 头", seen.headers && seen.headers.cookie);
    ok(seen.headers && seen.headers["user-agent"] === "monkeycode-local-proxy", "握手 UA 是可辨识形态", seen.headers && seen.headers["user-agent"]);
    ok(seen.headers && seen.headers.referer === undefined, "握手不发 Referer（站点前端的形态）", seen.headers && seen.headers.referer);
    ok(!!(seen.headers && seen.headers["sec-websocket-key"]), "Sec-WebSocket-Key 由 WebSocket 库生成（不是手写）");
    ok(seen.frames.length >= 4 && seen.frames[0] === '{"type":"auto-approve"}', "第一帧必是 auto-approve（缺它任务会停在第一个工具调用）", seen.frames[0]);
    const userInput = JSON.parse(seen.frames[1] || "{}");
    ok(
      userInput.type === "user-input" &&
        typeof userInput.data === "string" &&
        // data 里的 content 是**建任务时同一份拍平正文**（带 [User] 前缀），不是原始 message
        JSON.parse(userInput.data).content === Buffer.from("[User]\n修登录 bug", "utf8").toString("base64"),
      "第二帧是 user-input 且 data 为 base64 的 JSON 串（与建任务 content 同源）",
      seen.frames[1],
    );
    ok(seen.frames.some((f) => f === '{"type":"ping"}'), "收到上游 ping 后镜像回一条 ping", seen.frames.filter((f) => f.includes("ping")));
    const replied = seen.frames.find((f) => f.includes("reply-question"));
    ok(replied && JSON.parse(replied).data.includes('"request_id":"q1"') && JSON.parse(replied).data.includes('"cancelled":false'), "Agent 提问自动回复（空答案 + 不取消），任务因此不卡在提问处", replied);
    const texts = emitted.filter((e) => e.type === "delta").map((e) => e.delta.content).join("");
    ok(texts === "正在改", "acp_event 正文按 delta.content 回流", texts);
    const usage = emitted.find((e) => e.type === "usage");
    ok(usage && usage.usage.prompt_tokens === 12 && usage.usage.total_tokens === 19, "usage_update 的累计值在收尾时上报", usage && usage.usage);
    ok(emitted[emitted.length - 1].type === "finish", "task-ended → finish 收尾（客户端等得到结束帧）", emitted[emitted.length - 1]);
  }

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("\n自测自身异常：", e && e.stack ? e.stack : e);
  process.exit(1);
});
