/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-28
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * 本地网关 · 出站伪装与清洗（outbound）独立验证脚本
 * 判定依据：docs/localgw-outbound-contract.md §6（v1.4）
 *
 * 【本脚本的立场】验证者脚本，只读 electron/** 与 src/**，不改任何被测代码。
 * 与 T1 自测的区别：样本、断言、对拍基线全部自建，不复用 T1 的 tmp 脚本。
 *
 * 已覆盖：
 *   A 零回归：util.byteSafeHeaders 与改动前（git HEAD 版本）逐字节对拍
 *   B passthrough 短路（同一引用）+ 空配置生效 mode = mimic
 *   C 规则引擎：literal / regex / rewrites→keywords / 5 种 scope / flags / $1
 *   D 降级路径：坏正则 / 超 200 条 / 非法 scope / 非对象 perChannel / §4.5.1 删除语义
 *   E 头覆盖：覆盖 / 新增 / 移除 / 大小写 / Authorization 与 x-api-key 不被破坏 / 不改入参
 *
 * 跑法：
 *   node tools/verify/outbound/run.cjs            # 人读输出
 *   node tools/verify/outbound/run.cjs --assert   # 有失败则 exit 1
 *   node tools/verify/outbound/run.cjs --json     # 末尾追加机器可读结果
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../../..");

// ===== 被测模块（只读）=====
const util = require(path.join(ROOT, "electron/backend/proxy/util.cjs"));
const hook = require(path.join(ROOT, "electron/backend/proxy/outbound-hook.cjs"));
const outbound = require(path.join(ROOT, "electron/backend/localgw/outbound.cjs"));
const lgwConfig = require(path.join(ROOT, "electron/backend/localgw/config.cjs"));

// ===== 结果收集 =====
const results = [];
let pass = 0;
let fail = 0;

function assertCheck(name, cond, details) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    results.push({ name, ok: true });
    return true;
  }
  fail++;
  console.log(`  ✗ ${name}${details ? "\n      -> " + String(details).replace(/\n/g, "\n      ") : ""}`);
  results.push({ name, ok: false, details: details ? String(details) : "" });
  return false;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/** 深扫：对象里是否含 null（§4.5.1 硬不变式） */
function findNullPaths(v, at = "$", acc = []) {
  if (v === null) { acc.push(at); return acc; }
  if (Array.isArray(v)) { v.forEach((x, i) => findNullPaths(x, `${at}[${i}]`, acc)); return acc; }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) findNullPaths(v[k], `${at}.${k}`, acc);
  }
  return acc;
}

/** 与后端同款的 mergeDeep（从被测模块取，保证「模拟 patch」用的就是生产语义） */
const mergeDeep = lgwConfig.mergeDeep;

/** 模拟 localgw_config_patch 的写入路径：mergeDeep(当前段落, 补丁) → normalize() */
function simulatePatch(currentSection, patchObj) {
  return lgwConfig.normalize(mergeDeep(currentSection || {}, patchObj || {}));
}

// ==========================================================================
// A. 零回归：byteSafeHeaders 与改动前逐字节对拍
// ==========================================================================

/** 取 git HEAD 版本的 util.cjs 落盘（用 execSync 拿 Buffer，避开 PowerShell 重定向的 UTF-16 陷阱）。
 *  改动前的 util.cjs 只依赖 node:crypto、无任何相对路径 require，因此放在 tmp 下也能直接 require。 */
function materializeBaseline() {
  const dir = path.join(ROOT, "tmp", "outbound-verify");
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, "orig-util.cjs");
  const buf = execSync("git show HEAD:electron/backend/proxy/util.cjs", {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!buf || !buf.length) throw new Error("git show 返回空内容，无法取得基线");
  fs.writeFileSync(dst, buf);
  return dst;
}

/** header 结果指纹：键序 + 值字符串 + 值 UTF-8 字节。三者全等才算「逐字节一致」。 */
function fingerprint(v) {
  if (v === null) return "NULL";
  if (v === undefined) return "UNDEF";
  if (typeof v !== "object") return `${typeof v}:${String(v)}`;
  const parts = [];
  for (const k of Object.keys(v)) {
    const s = String(v[k]);
    parts.push(`${JSON.stringify(k)}\u0001${s}\u0001${Buffer.from(s, "utf8").toString("hex")}`);
  }
  return `OBJ{${parts.join("\u0002")}}`;
}

/** A 项样本集：覆盖中文 / emoji / 超长 / 空对象 / null / 非 Latin-1 边界 / 大小写混排 / 空键 / 含空格键 */
function headerCorpus() {
  const protoPolluted = {};
  Object.defineProperty(protoPolluted, "__proto__", { value: "污染值中文", enumerable: true, configurable: true, writable: true });
  return [
    { name: "空对象", value: {} },
    { name: "纯 ASCII", value: { "content-type": "application/json", accept: "*/*" } },
    { name: "中文值", value: { a: "中文" } },
    { name: "emoji 值", value: { a: "🎉🚀" } },
    { name: "中文键+中文值", value: { "中键": "值" } },
    { name: "超长 ASCII（5000）", value: { "user-agent": "x".repeat(5000) } },
    { name: "超长中文（3000）", value: { "x-long": "中".repeat(3000) } },
    { name: "超长键（300）", value: { ["k".repeat(300)]: "v" } },
    { name: "null 入参", value: null },
    { name: "undefined 入参", value: undefined },
    { name: "字符串入参", value: "not-an-object" },
    { name: "数字入参", value: 42 },
    { name: "空键", value: { "": "empty-key-value" } },
    { name: "键含首尾空格", value: { " x-spaced ": "v" } },
    { name: "大小写混排同名键", value: { "X-Case": "v1", "x-case": "v2", "X-CASE": "v3" } },
    { name: "混合类型值", value: { num: 123, bool: true, nil: null, undef: undefined } },
    { name: "对象值", value: { nested: { a: 1 } } },
    { name: "数组值", value: { arr: [1, 2, 3] } },
    { name: "Latin-1 上界外 é(0xE9)", value: { latin1: "é" } },
    { name: "Latin-1 边界 0xFF", value: { boundary: "\u00ff" } },
    { name: "Latin-1 越界 0x100", value: { boundary2: "\u0100" } },
    { name: "空值串", value: { a: "", b: "0" } },
    { name: "Authorization 含中文", value: { Authorization: "Bearer 中文token", "x-api-key": "密钥" } },
    { name: "自有 __proto__ 键", value: protoPolluted },
    { name: "代理头组合", value: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "中文", host: "a.b" } },
  ];
}

function runZeroRegression() {
  section("A. 零回归：byteSafeHeaders 与 git HEAD 版本逐字节对拍");
  const baselinePath = materializeBaseline();
  const orig = require(baselinePath);
  console.log(`  基线文件：${path.relative(ROOT, baselinePath)}（${fs.statSync(baselinePath).size} bytes，来自 git HEAD）`);

  assertCheck("基线 byteSafeHeaders 可用（改动前版本可独立 require）", typeof orig.byteSafeHeaders === "function");

  const corpus = headerCorpus();
  const diffs = [];
  let identityMismatch = [];
  for (const c of corpus) {
    let a, b, ea = null, eb = null;
    try { a = orig.byteSafeHeaders(c.value); } catch (e) { ea = e; }
    try { b = util.byteSafeHeaders(c.value); } catch (e) { eb = e; }
    if (!!ea !== !!eb) {
      diffs.push(`[${c.name}] 抛错行为不一致：orig=${ea ? ea.message : "无"} / new=${eb ? eb.message : "无"}`);
      continue;
    }
    if (ea) continue; // 两边同样抛错 = 行为一致
    const fa = fingerprint(a);
    const fb = fingerprint(b);
    if (fa !== fb) diffs.push(`[${c.name}]\n  orig=${fa}\n  new =${fb}`);
    // 「无非 Latin-1 项时返回同一引用」的零分配约定也必须一致
    const ia = a === c.value;
    const ib = b === c.value;
    if (ia !== ib) identityMismatch.push(`[${c.name}] orig同一引用=${ia} / new同一引用=${ib}`);
  }
  assertCheck(
    `A1 全部 ${corpus.length} 个样本输出指纹逐字节一致`,
    diffs.length === 0,
    diffs.join("\n")
  );
  assertCheck("A2 「无转换项时返回同一引用」语义一致", identityMismatch.length === 0, identityMismatch.join("\n"));

  // A3：ALS 上下文退出后不得残留（上下文泄漏会让号池自身链路被改头）
  const probe = { "user-agent": "probe/1.0", Authorization: "Bearer abc" };
  const policy = outbound.policyFor("leak-test", {
    outbound: { defaults: { mode: "mimic" }, perChannel: { "leak-test": { headers: { "user-agent": "LEAKED/9" } } } },
  });
  let inside = null;
  hook.run(policy, () => { inside = util.byteSafeHeaders({ "user-agent": "probe/1.0", Authorization: "Bearer abc" }); });
  const after = util.byteSafeHeaders({ "user-agent": "probe/1.0", Authorization: "Bearer abc" });
  assertCheck("A3 ALS 上下文内确实改头（说明 A1 不是因为 applyHeaders 恒空转）", inside && inside["user-agent"] === "LEAKED/9", JSON.stringify(inside));
  assertCheck(
    "A4 ALS 退出后无残留：上下文外输出与基线一致",
    fingerprint(after) === fingerprint(orig.byteSafeHeaders({ "user-agent": "probe/1.0", Authorization: "Bearer abc" })),
    `after=${JSON.stringify(after)}`
  );
  assertCheck("A5 上下文外 applyHeaders 返回同一引用", hook.applyHeaders(probe) === probe && hook.current() === null);

  // A6：并发场景下号池自身调用（无上下文）与 localgw 调用（有上下文）互不干扰
  // —— 用同步交错的微任务制造重叠窗口，断言每次「无上下文」调用都拿到原样对象
  let leaked = 0;
  const jobs = [];
  for (let i = 0; i < 40; i++) {
    const tag = `ch${i}`;
    const p = outbound.policyFor(tag, {
      outbound: { perChannel: { [tag]: { headers: { "x-tag": tag } } } },
    });
    jobs.push(
      hook.run(p, async () => {
        await new Promise((r) => setImmediate(r));
        // 有上下文：必须看到自己的 tag（串台则看到别人的 tag）
        const h = hook.applyHeaders({ base: "1" });
        if (h["x-tag"] !== tag) leaked++;
        // 无上下文对照：另起一个不属于任何上下文的调用
        return h;
      })
    );
  }
  // 交错执行一批「无上下文」调用，与上面的上下文任务并发
  const bareJobs = [];
  for (let i = 0; i < 40; i++) {
    bareJobs.push(
      (async () => {
        await new Promise((r) => setImmediate(r));
        const h = hook.applyHeaders({ bare: String(i) });
        if (h["x-tag"] !== undefined || h.bare !== String(i)) leaked++;
      })()
    );
  }
  return Promise.all([Promise.all(jobs), Promise.all(bareJobs)]).then(() => {
    assertCheck("A6 并发交错下 ALS 不串台（40 组上下文 + 40 组无上下文）", leaked === 0, `串台/污染计数=${leaked}`);
  });
}

// ==========================================================================
// B. passthrough 短路 + 空配置默认
// ==========================================================================

function runPassthrough() {
  section("B. passthrough 短路（同一引用）+ 空配置生效 mode");
  const body = {
    model: "m",
    messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude" }],
  };

  // B1：空配置 → mimic（§6-3 v1.4 澄清），且内置脱敏/抖动仍开
  const empty = outbound.policyFor("", {});
  assertCheck("B1 policyFor(\"\", {}) 生效 mode = mimic（不是 passthrough）", empty.mode === "mimic", `实际=${empty.mode}`);
  assertCheck(
    "B2 空配置保持改动前默认行为：builtinSanitize=true 且 jitter=true",
    empty.builtinSanitize === true && empty.jitter === true,
    `builtinSanitize=${empty.builtinSanitize} jitter=${empty.jitter}`
  );
  const emptySan = outbound.sanitizeBody(body, empty);
  // 判据不用「子串消失」这种猜测，而是与 sanitize.cjs 直调结果逐字节对拍：
  // 空配置下 outbound 的内置脱敏必须**恰好等于**改动前 applyFingerprintSanitize 的效果。
  const sanitize = require(path.join(ROOT, "electron/backend/proxy/sanitize.cjs"));
  const direct = sanitize.sanitizeBody(JSON.parse(JSON.stringify(body)));
  assertCheck(
    "B3 空配置下内置脱敏仍生效，且结果与 sanitize.cjs 直调逐字节一致",
    emptySan.changed === true &&
      emptySan.body !== body &&
      JSON.stringify(emptySan.body) === JSON.stringify(direct.body),
    `changed=${emptySan.changed}\n  outbound=${JSON.stringify(emptySan.body)}\n  direct  =${JSON.stringify(direct.body)}`
  );

  // B4：显式 passthrough（渠道级）
  const pPer = outbound.policyFor("ch-pass", { outbound: { perChannel: { "ch-pass": { mode: "passthrough" } } } });
  assertCheck("B4 渠道级 passthrough 生效", pPer.mode === "passthrough");
  const sanPer = outbound.sanitizeBody(body, pPer);
  assertCheck("B5 passthrough 下 sanitizeBody 返回同一 body 引用", sanPer.body === body, `sameRef=${sanPer.body === body}`);
  assertCheck("B6 passthrough 下 changed=false 且 hits=\"\"", sanPer.changed === false && sanPer.hits === "", JSON.stringify(sanPer));

  const hdrs = { Authorization: "Bearer x", "user-agent": "orig" };
  const applied = hook.run(pPer, () => hook.applyHeaders(hdrs));
  assertCheck("B7 passthrough 下 applyHeaders 返回同一引用", applied === hdrs, `sameRef=${applied === hdrs}`);

  // B8：passthrough 短路一切（即使配了 headers/规则也不生效）
  const pFull = outbound.policyFor("ch-full", {
    outbound: {
      perChannel: {
        "ch-full": {
          mode: "passthrough",
          headers: { "user-agent": "SHOULD-NOT-APPLY" },
          keywords: [{ id: "k", label: "L", pattern: "Claude Code", replace: "X" }],
        },
      },
    },
  });
  const h2 = hook.run(pFull, () => hook.applyHeaders({ "user-agent": "orig" }));
  const s2 = outbound.sanitizeBody(body, pFull);
  assertCheck("B8 passthrough 短路一切：headers 与 keywords 均不生效", h2["user-agent"] === "orig" && s2.body === body);
  assertCheck(
    "B9 passthrough 下 policy.jitter=false（server 不再加抖动）",
    pFull.jitter === false && pFull.builtinSanitize === false && pFull.headerOverride === false
  );

  // B10：全局 defaults 配 passthrough（未单独配置的渠道继承）
  const pDef = outbound.policyFor("any-ch", { outbound: { defaults: { mode: "passthrough" } } });
  assertCheck("B10 defaults.mode=passthrough 时未配置渠道也透传", pDef.mode === "passthrough");

  // B11：defaults=passthrough 但渠道级改回 mimic
  const pMix = outbound.policyFor("ch-mimic", {
    outbound: { defaults: { mode: "passthrough" }, perChannel: { "ch-mimic": { mode: "mimic" } } },
  });
  assertCheck("B11 perChannel.mode=mimic 可覆盖 defaults 的 passthrough", pMix.mode === "mimic");

  // B12：policy 为 null / undefined 时 sanitizeBody 原样返回
  assertCheck(
    "B12 policy 为 null/undefined 时 sanitizeBody 原样返回同一引用",
    outbound.sanitizeBody(body, null).body === body && outbound.sanitizeBody(body, undefined).body === body
  );

  // B13：无上下文时 applyHeaders 原样返回
  assertCheck("B13 无 ALS 上下文时 applyHeaders 原样返回同一引用", hook.applyHeaders(hdrs) === hdrs);
}

// ==========================================================================
// C. 规则引擎
// ==========================================================================

function pol(cid, ob) {
  return outbound.policyFor(cid, { outbound: ob, fingerprintObfuscation: true, humanizeJitter: true });
}

/** 用一条关键词规则洗一段文本，返回结果串 */
function applyOne(text, rule, scope) {
  const p = pol("c", { defaults: { builtinSanitize: false }, keywords: [rule] });
  return outbound.sanitizeText(text, p, scope);
}

function runRuleEngine() {
  section("C. 规则引擎：literal / regex / 顺序 / scope / flags / $1");

  // C1 literal 全量替换
  const c1 = applyOne("aTOKbTOKc", { id: "k1", label: "T", mode: "literal", pattern: "TOK", replace: "-" });
  assertCheck("C1 literal 全量替换（出现 2 次都换）", c1.text === "a-b-c", JSON.stringify(c1));

  // C2 literal 不做 $1 展开（契约 §2）
  const c2 = applyOne("xTOKx", { id: "k2", label: "T", mode: "literal", pattern: "TOK", replace: "$1" });
  assertCheck("C2 literal 模式不做 $1 展开（原样输出 $1）", c2.text === "x$1x", JSON.stringify(c2));

  // C3 regex 允许 $1 展开
  const c3 = applyOne("key=abc", { id: "k3", label: "T", mode: "regex", pattern: "key=(\\w+)", replace: "k:$1" });
  assertCheck("C3 regex 模式允许 $1 展开", c3.text === "k:abc", JSON.stringify(c3));

  // C4 flags 白名单：非法字符被剔除
  const pFlags = pol("c", {
    defaults: { builtinSanitize: false },
    keywords: [{ id: "k4", label: "T", mode: "regex", pattern: "abc", flags: "qxgi", replace: "Z" }],
  });
  const c4 = outbound.sanitizeText("ABC abc", pFlags, "all");
  assertCheck("C4 flags 剔除非法字符且强制带 g（qxgi → gi，大小写不敏感全量替换）", c4.text === "Z Z", JSON.stringify(c4));

  // C5 flags 只给 i 时被强制补 g（防「只换第一处」的静默漏洗）
  const pFlagsI = pol("c", {
    defaults: { builtinSanitize: false },
    keywords: [{ id: "k5", label: "T", mode: "regex", pattern: "abc", flags: "i", replace: "Z" }],
  });
  const c5 = outbound.sanitizeText("abc ABC abc", pFlagsI, "all");
  assertCheck("C5 flags=\"i\" 被强制补 g，三处全换", c5.text === "Z Z Z", JSON.stringify(c5));

  // C6 顺序：rewrites 先于 keywords（正向：rewrite A→B，keyword B→C ⇒ 期望 C）
  const pOrder1 = pol("c", {
    defaults: { builtinSanitize: false },
    rewrites: [{ id: "r1", label: "R", from: "AAA", to: "BBB", scope: "all" }],
    keywords: [{ id: "k6", label: "K", mode: "literal", pattern: "BBB", replace: "CCC", scope: "all" }],
  });
  const c6 = outbound.sanitizeText("AAA", pOrder1, "all");
  assertCheck("C6 rewrites 先于 keywords（AAA→BBB→CCC）", c6.text === "CCC", `实际=${c6.text}（若为 BBB 则 keywords 先跑）`);

  // C7 顺序反向样本：keyword X→Y，rewrite Y→Z ⇒ rewrites 先跑则 Y→Z 先发生，X 之后才变 Y ⇒ 期望 Y
  const pOrder2 = pol("c", {
    defaults: { builtinSanitize: false },
    rewrites: [{ id: "r2", label: "R", from: "YYY", to: "ZZZ", scope: "all" }],
    keywords: [{ id: "k7", label: "K", mode: "literal", pattern: "XXX", replace: "YYY", scope: "all" }],
  });
  const c7 = outbound.sanitizeText("XXX", pOrder2, "all");
  assertCheck("C7 顺序反向样本（rewrites 先跑 ⇒ 结果 YYY 而非 ZZZ）", c7.text === "YYY", `实际=${c7.text}`);

  // C8 跨引擎顺序：自定义规则先于内置 sanitize（否则用户替换身份句永远匹配不上）
  const pCross = pol("c", {
    rewrites: [
      { id: "r3", label: "身份句", from: "You are Claude Code, Anthropic's official CLI for Claude", to: "You are CodeBuddy", scope: "all" },
    ],
  });
  const crossBody = { messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude" }] };
  const c8 = outbound.sanitizeBody(crossBody, pCross);
  assertCheck(
    "C8 自定义 rewrite 能命中身份句原文（证明自定义规则先于内置 sanitize）",
    c8.changed === true && c8.body.messages[0].content === "You are CodeBuddy",
    JSON.stringify(c8.body.messages[0].content)
  );

  // C9 五种 scope：角色判定
  const mkBody = () => ({
    model: "m",
    messages: [
      { role: "system", content: "TOK" },
      { role: "user", content: "TOK" },
      {
        role: "assistant",
        content: "TOK",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"q":"TOK"}' } }],
      },
      { role: "tool", content: "TOK", tool_call_id: "c1" },
    ],
  });
  const scopeExpect = {
    all: [true, true, true, true, true],
    system: [true, false, false, false, false],
    user: [false, true, false, false, false],
    assistant: [false, false, true, false, false],
    tool: [false, false, false, true, true],
  };
  const scopeFails = [];
  for (const [scope, exp] of Object.entries(scopeExpect)) {
    const p = pol("c", {
      defaults: { builtinSanitize: false },
      keywords: [{ id: "ks", label: "S", mode: "literal", pattern: "TOK", replace: "HIT", scope }],
    });
    const r = outbound.sanitizeBody(mkBody(), p);
    const got = [
      r.body.messages[0].content === "HIT",
      r.body.messages[1].content === "HIT",
      r.body.messages[2].content === "HIT",
      r.body.messages[3].content === "HIT",
      r.body.messages[2].tool_calls[0].function.arguments.includes("HIT"),
    ];
    if (JSON.stringify(got) !== JSON.stringify(exp)) {
      scopeFails.push(`scope=${scope} 期望=${JSON.stringify(exp)} 实际=${JSON.stringify(got)}`);
    }
  }
  assertCheck("C9 5 种 scope 的角色判定全部符合 §2（含 tool_calls.arguments 归 tool）", scopeFails.length === 0, scopeFails.join("\n"));

  // C10 tool scope 不得误伤 assistant 的 content
  const pTool = pol("c", {
    defaults: { builtinSanitize: false },
    keywords: [{ id: "kt", label: "T", mode: "literal", pattern: "TOK", replace: "HIT", scope: "tool" }],
  });
  const c10 = outbound.sanitizeBody(mkBody(), pTool);
  assertCheck(
    "C10 tool scope 只动 tool 消息与 tool_calls，不动 assistant.content",
    c10.body.messages[2].content === "TOK" && c10.body.messages[3].content === "HIT" && c10.body.messages[2].tool_calls[0].function.arguments.includes("HIT")
  );

  // C11 多模态 content 数组
  const pArr = pol("c", {
    defaults: { builtinSanitize: false },
    keywords: [{ id: "ka", label: "A", mode: "literal", pattern: "TOK", replace: "HIT", scope: "all" }],
  });
  const arrBody = {
    messages: [{ role: "user", content: [{ type: "text", text: "TOK" }, { type: "image_url", image_url: { url: "http://x/TOK.png" } }] }],
  };
  const c11 = outbound.sanitizeBody(arrBody, pArr);
  assertCheck(
    "C11 多模态数组：只改 text 分片，不动 image_url",
    c11.body.messages[0].content[0].text === "HIT" && c11.body.messages[0].content[1].image_url.url === "http://x/TOK.png"
  );

  // C12 reasoning_content 也被清洗
  const rcBody = { messages: [{ role: "assistant", content: "ok", reasoning_content: "TOK" }] };
  const c12 = outbound.sanitizeBody(rcBody, pArr);
  assertCheck("C12 reasoning_content 被清洗", c12.body.messages[0].reasoning_content === "HIT");

  // C13 hits 摘要串格式（落 oplog 的 sensitiveHits）
  const pHits = pol("c", {
    defaults: { builtinSanitize: false },
    keywords: [
      { id: "h1", label: "甲", mode: "literal", pattern: "TOK", replace: "X", scope: "all" },
      { id: "h2", label: "乙", mode: "literal", pattern: "QQ", replace: "Y", scope: "all" },
    ],
  });
  const c13 = outbound.sanitizeBody({ messages: [{ role: "user", content: "TOK TOK QQ" }] }, pHits);
  assertCheck("C13 命中摘要为格式化串（多命中带 ×N）", typeof c13.hits === "string" && c13.hits.includes("甲×2") && c13.hits.includes("乙"), `hits=${JSON.stringify(c13.hits)}`);

  // C14 未命中时原样返回同一引用（零拷贝）
  const noHitBody = { messages: [{ role: "user", content: "nothing here" }] };
  const c14 = outbound.sanitizeBody(noHitBody, pHits);
  assertCheck("C14 规则未命中时返回同一 body 引用且 changed=false", c14.body === noHitBody && c14.changed === false);

  // C15 数组形态 body（非对象）不炸、原样返回
  const c15in = [{ role: "user", content: "TOK" }];
  const c15 = outbound.sanitizeBody(c15in, pHits);
  assertCheck("C15 body 为数组（非对象）时原样返回同一引用且不抛错", c15.body === c15in && c15.changed === false, JSON.stringify(c15.changed));

  // C16 content 为 null 且 tool_calls 存在：tool_calls 仍须被清洗
  const nullContentBody = {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c9", type: "function", function: { name: "f", arguments: '{"q":"TOK"}' } }],
      },
    ],
  };
  const pTool2 = pol("c", {
    defaults: { builtinSanitize: false },
    keywords: [{ id: "kt2", label: "T", mode: "literal", pattern: "TOK", replace: "HIT", scope: "tool" }],
  });
  const c16 = outbound.sanitizeBody(nullContentBody, pTool2);
  assertCheck(
    "C16 content=null 且 tool_calls 存在时，tool_calls.arguments 仍被清洗",
    c16.changed === true && c16.body.messages[0].content === null && c16.body.messages[0].tool_calls[0].function.arguments.includes("HIT"),
    JSON.stringify(c16.body.messages[0])
  );

  // C17 清洗不得改写入参（调用方仍持有原对象）
  const origBody = { messages: [{ role: "user", content: "TOK" }] };
  const snapshot = JSON.stringify(origBody);
  outbound.sanitizeBody(origBody, pHits);
  assertCheck("C17 sanitizeBody 不改写入参 body", JSON.stringify(origBody) === snapshot);
}

// ==========================================================================
// D. 降级路径 + §4.5.1 删除语义
// ==========================================================================

function runDegradation() {
  section("D. 降级路径与 §4.5.1 删除语义");

  // D1 坏正则在 normalize 里被丢弃，不抛错
  let d1err = null;
  let n1 = null;
  try {
    n1 = lgwConfig.normalize({
      outbound: {
        keywords: [
          { id: "bad", label: "坏", mode: "regex", pattern: "([", replace: "x" },
          { id: "good", label: "好", mode: "literal", pattern: "ok", replace: "y" },
        ],
      },
    });
  } catch (e) { d1err = e; }
  assertCheck(
    "D1 坏正则在 normalize 里被丢弃、不抛错，好规则保留",
    !d1err && n1 && n1.outbound.keywords.length === 1 && n1.outbound.keywords[0].id === "good",
    d1err ? d1err.message : JSON.stringify(n1 && n1.outbound.keywords)
  );

  // D2 未归一化的坏正则直接喂 policyFor：也不抛错且不生效
  let d2err = null;
  let d2 = null;
  try {
    const p = pol("c", {
      defaults: { builtinSanitize: false },
      keywords: [{ id: "bad", label: "坏", mode: "regex", pattern: "([", replace: "x" }],
    });
    d2 = outbound.sanitizeText("abc", p, "all");
  } catch (e) { d2err = e; }
  assertCheck("D2 坏正则直接喂 policyFor 不抛错且规则被丢弃", !d2err && d2 && d2.text === "abc", d2err ? d2err.message : JSON.stringify(d2));

  // D3 超 200 条截断
  const many = [];
  for (let i = 0; i < 260; i++) many.push({ id: `k${i}`, label: `L${i}`, mode: "literal", pattern: `P${i}`, replace: "x" });
  const n3 = lgwConfig.normalize({ outbound: { keywords: many, rewrites: many.map((r) => ({ id: r.id, label: r.label, from: r.pattern, to: "y" })) } });
  assertCheck(
    "D3 超 200 条被截断到 200（keywords 与 rewrites 各自）",
    n3.outbound.keywords.length === 200 && n3.outbound.rewrites.length === 200,
    `keywords=${n3.outbound.keywords.length} rewrites=${n3.outbound.rewrites.length}`
  );
  const p3 = pol("c", { defaults: { builtinSanitize: false }, keywords: many });
  assertCheck("D4 未归一化的 260 条在 policyFor 里也被截断到 200", p3.keywords.length === 200, `实际=${p3.keywords.length}`);

  // D5 非法 scope 回 "all"
  const n5 = lgwConfig.normalize({
    outbound: { keywords: [{ id: "s", label: "S", mode: "literal", pattern: "a", replace: "b", scope: "root" }] },
  });
  assertCheck("D5 非法 scope 在 normalize 里回 \"all\"", n5.outbound.keywords[0].scope === "all", `实际=${n5.outbound.keywords[0].scope}`);
  const p5 = pol("c", { defaults: { builtinSanitize: false }, keywords: [{ id: "s", label: "S", mode: "literal", pattern: "a", replace: "b", scope: "root" }] });
  assertCheck("D6 未归一化的非法 scope 在 policyFor 里回 \"all\"（不静默永不命中）", p5.keywords[0].scope === "all", `实际=${p5.keywords[0].scope}`);

  // D7 perChannel 非对象
  const n7a = lgwConfig.normalize({ outbound: { perChannel: "oops" } });
  const n7b = lgwConfig.normalize({ outbound: { perChannel: ["a", "b"] } });
  assertCheck(
    "D7 perChannel 为字符串/数组时回退为纯对象（不抛错）",
    JSON.stringify(n7a.outbound.perChannel) === "{}" && JSON.stringify(n7b.outbound.perChannel) === "{}",
    `str=${JSON.stringify(n7a.outbound.perChannel)} arr=${JSON.stringify(n7b.outbound.perChannel)}`
  );

  // D8 keywords / rewrites 非数组
  const n8 = lgwConfig.normalize({ outbound: { keywords: "nope", rewrites: { a: 1 } } });
  assertCheck("D8 keywords/rewrites 非数组时回退为 []", Array.isArray(n8.outbound.keywords) && n8.outbound.keywords.length === 0 && Array.isArray(n8.outbound.rewrites) && n8.outbound.rewrites.length === 0);

  // D9 规则缺 id 时按下标补
  const n9 = lgwConfig.normalize({ outbound: { keywords: [{ mode: "literal", pattern: "a" }], rewrites: [{ from: "b" }] } });
  assertCheck("D9 规则缺 id 时按下标补 k0 / r0", n9.outbound.keywords[0].id === "k0" && n9.outbound.rewrites[0].id === "r0", JSON.stringify([n9.outbound.keywords[0].id, n9.outbound.rewrites[0].id]));

  // D10 pattern/from 为空 → 丢弃该条
  const n10 = lgwConfig.normalize({ outbound: { keywords: [{ id: "e", pattern: "" }, { id: "n", pattern: 123 }], rewrites: [{ id: "e2", from: "" }] } });
  assertCheck("D10 pattern/from 非字符串或空 → 丢弃该条", n10.outbound.keywords.length === 0 && n10.outbound.rewrites.length === 0, JSON.stringify(n10.outbound));

  // D11 mode 非法 → mimic
  const n11 = lgwConfig.normalize({ outbound: { defaults: { mode: "chaos" } } });
  assertCheck("D11 非法 mode 纠偏为 mimic", n11.outbound.defaults.mode === "mimic", `实际=${n11.outbound.defaults.mode}`);

  // D12 §4.5.1 硬不变式：normalize 结果里绝不含 null（deep scan）
  const n12 = lgwConfig.normalize({
    outbound: {
      defaults: { mode: null, profile: null, builtinSanitize: null },
      perChannel: { a: null, b: { headers: { x: null, y: "1" } }, c: "bad" },
      keywords: null,
      rewrites: [{ id: "r", from: "f", to: "t", scope: null }],
      profiles: { custom: { p1: null, p2: { label: null, headers: { h: null, k: "v" } } } },
    },
  });
  const nullPaths = findNullPaths(n12.outbound);
  assertCheck("D12 §4.5.1 不变式：normalize 结果深扫无 null", nullPaths.length === 0, nullPaths.join(", "));

  // D13 删除语义 4 处（走真实 patch 路径：mergeDeep → normalize）
  const base = lgwConfig.normalize({
    outbound: {
      perChannel: { ch1: { mode: "passthrough", headers: { "x-a": "1", "x-b": "2" }, removeHeaders: ["x-c"] } },
      profiles: { custom: { p1: { label: "P1", userAgent: "UA", headers: { "h-a": "1", "h-b": "2" } } } },
    },
  });
  const afterAll = simulatePatch(base, {
    outbound: {
      perChannel: { ch1: { headers: { "x-a": null } } },
      profiles: { custom: { p1: { headers: { "h-a": null } } } },
    },
  });
  assertCheck(
    "D13-③ perChannel[cid].headers[key]=null 删除该头覆盖",
    !("x-a" in afterAll.outbound.perChannel.ch1.headers) && afterAll.outbound.perChannel.ch1.headers["x-b"] === "2",
    JSON.stringify(afterAll.outbound.perChannel.ch1.headers)
  );
  assertCheck(
    "D13-④ profiles.custom[id].headers[key]=null 删除该档案头覆盖",
    !("h-a" in afterAll.outbound.profiles.custom.p1.headers) && afterAll.outbound.profiles.custom.p1.headers["h-b"] === "2",
    JSON.stringify(afterAll.outbound.profiles.custom.p1.headers)
  );
  const afterPer = simulatePatch(afterAll, { outbound: { perChannel: { ch1: null } } });
  assertCheck("D13-① perChannel[cid]=null 删除该渠道策略（回继承）", !("ch1" in afterPer.outbound.perChannel), JSON.stringify(afterPer.outbound.perChannel));
  const afterProf = simulatePatch(afterPer, { outbound: { profiles: { custom: { p1: null } } } });
  assertCheck("D13-② profiles.custom[id]=null 删除该自定义档案", !("p1" in afterProf.outbound.profiles.custom), JSON.stringify(afterProf.outbound.profiles.custom));
  assertCheck("D14 四次删除后深扫仍无 null", findNullPaths(afterProf.outbound).length === 0, findNullPaths(afterProf.outbound).join(", "));

  // D15 清理必须范围受限：数组元素给 null 不应被当删除语义处理（契约：数组整体替换）
  const afterArr = simulatePatch(base, { outbound: { keywords: [{ id: "k", pattern: "a", replace: "b" }, null] } });
  assertCheck(
    "D15 keywords 数组里的 null 元素被丢弃而不是当删除信号（数组整体替换语义）",
    afterArr.outbound.keywords.length === 1 && findNullPaths(afterArr.outbound).length === 0,
    JSON.stringify(afterArr.outbound.keywords)
  );

  // D16 循环引用 body 不炸
  const circ = { messages: [{ role: "user", content: "TOK" }] };
  circ.self = circ;
  const p16 = pol("c", { defaults: { builtinSanitize: false }, keywords: [{ id: "k", label: "K", mode: "literal", pattern: "TOK", replace: "X" }] });
  let d16err = null;
  let d16 = null;
  try { d16 = outbound.sanitizeBody(circ, p16); } catch (e) { d16err = e; }
  assertCheck("D16 循环引用 body 不抛错且原样放行", !d16err && d16.body === circ && d16.changed === false, d16err ? d16err.message : JSON.stringify(d16.changed));

  // D17 无 messages 的 body 原样返回
  const nm = { model: "m" };
  assertCheck("D17 body 无 messages 数组时原样返回同一引用", outbound.sanitizeBody(nm, p16).body === nm);

  // D18 policyFor 容忍畸形 cfg
  const badCfgs = [null, undefined, "str", 42, [], { outbound: "x" }, { outbound: { defaults: "x", perChannel: 7 } }];
  const d18errs = [];
  for (const c of badCfgs) {
    try { const p = outbound.policyFor("c", c); if (!p || p.mode !== "mimic") d18errs.push(`cfg=${JSON.stringify(c)} → mode=${p && p.mode}`); }
    catch (e) { d18errs.push(`cfg=${JSON.stringify(c)} 抛错: ${e.message}`); }
  }
  assertCheck("D18 policyFor 对畸形 cfg 一律回退 mimic 且不抛错", d18errs.length === 0, d18errs.join("\n"));

  // D19 listProfiles / describePolicy 不抛错（坏配置下 UI 面板不能整体挂）
  let d19err = null;
  let profs = null;
  let desc = null;
  try {
    profs = outbound.listProfiles({ outbound: { profiles: { custom: { p: null } } } });
    desc = outbound.describePolicy("c", { outbound: { perChannel: { c: { headers: { a: null } } } } });
  } catch (e) { d19err = e; }
  assertCheck(
    "D19 listProfiles/describePolicy 在脏配置下不抛错",
    !d19err && Array.isArray(profs) && profs.length > 0 && desc && typeof desc.mode === "string",
    d19err ? d19err.message : JSON.stringify(desc)
  );
}

// ==========================================================================
// E. 头覆盖
// ==========================================================================

function runHeaderOverride() {
  section("E. 头覆盖：覆盖 / 新增 / 移除 / 大小写 / 鉴权头 / 不改入参");

  const withPolicy = (ob, cid, headers) => hook.run(pol(cid || "c", ob), () => hook.applyHeaders(headers));

  // E1 覆盖已存在的头：大小写不敏感命中，写回原键名（不产生重复头）
  const e1in = { "user-agent": "orig/1", "content-type": "application/json" };
  const e1 = withPolicy({ perChannel: { c: { headers: { "User-Agent": "X-Test/1.0" } } } }, "c", e1in);
  const e1keys = Object.keys(e1).map((k) => k.toLowerCase());
  assertCheck(
    "E1 覆盖已存在头：命中原键名、无重复键、值已更新",
    e1["user-agent"] === "X-Test/1.0" && e1keys.filter((k) => k === "user-agent").length === 1,
    JSON.stringify(e1)
  );
  assertCheck("E2 覆盖返回新对象且不改写入参", e1 !== e1in && e1in["user-agent"] === "orig/1", `sameRef=${e1 === e1in} in=${JSON.stringify(e1in)}`);

  // E3 新增不存在的头
  const e3 = withPolicy({ perChannel: { c: { headers: { "x-brand-new": "v1" } } } }, "c", { a: "1" });
  assertCheck("E3 新增不存在的头", e3["x-brand-new"] === "v1" && e3.a === "1", JSON.stringify(e3));

  // E4 removeHeaders 大小写不敏感
  const e4 = withPolicy({ perChannel: { c: { removeHeaders: ["X-Forwarded-For", "USER-AGENT"] } } }, "c", {
    "x-forwarded-for": "1.2.3.4",
    "User-Agent": "ua",
    keep: "me",
  });
  assertCheck("E4 removeHeaders 大小写不敏感", !("x-forwarded-for" in e4) && !("User-Agent" in e4) && e4.keep === "me", JSON.stringify(e4));

  // E5 鉴权头不被破坏
  const e5in = { authorization: "Bearer secret-token", "x-api-key": "sk-abc", "user-agent": "orig" };
  const e5 = withPolicy({ perChannel: { c: { headers: { "user-agent": "X-Test/1.0" }, removeHeaders: ["accept-encoding"] } } }, "c", e5in);
  assertCheck(
    "E5 Authorization 与 x-api-key 不被破坏",
    e5.authorization === "Bearer secret-token" && e5["x-api-key"] === "sk-abc",
    JSON.stringify(e5)
  );

  // E6 套档案时鉴权头同样保留（profile 是 merge 不是 replace）
  const e6 = withPolicy(
    { perChannel: { c: { profile: "claude-code" } } },
    "c",
    { authorization: "Bearer t", "x-api-key": "k", "content-type": "application/json" }
  );
  assertCheck(
    "E6 档案 merge 不 replace：鉴权头保留、形态头被套上",
    e6.authorization === "Bearer t" && e6["x-api-key"] === "k" && e6["content-type"] === "application/json" && String(e6["User-Agent"]).startsWith("claude-cli/") && e6["x-app"] === "cli",
    JSON.stringify(e6)
  );

  // E7 移除胜出（同一头既 set 又 remove）
  const e7 = withPolicy({ perChannel: { c: { headers: { "x-conflict": "v" }, removeHeaders: ["X-Conflict"] } } }, "c", { "x-conflict": "orig", keep: "1" });
  assertCheck("E7 同一头同时 set 与 remove 时移除胜出", !("x-conflict" in e7) && e7.keep === "1", JSON.stringify(e7));

  // E8 headers 值为 null/undefined → 视为删除
  const e8 = withPolicy({ perChannel: { c: { headers: { "x-drop": null, "x-drop2": undefined, "x-set": "v" } } } }, "c", { "x-drop": "a", "x-drop2": "b" });
  assertCheck("E8 headers 值为 null/undefined 视为删除该头", !("x-drop" in e8) && !("x-drop2" in e8) && e8["x-set"] === "v", JSON.stringify(e8));

  // E9 数字/布尔值转串
  const e9 = withPolicy({ perChannel: { c: { headers: { "x-num": 5, "x-bool": true } } } }, "c", {});
  assertCheck("E9 非字符串头值一律 String() 转换", e9["x-num"] === "5" && e9["x-bool"] === "true", JSON.stringify(e9));

  // E10 键名含首尾空格：记录真实行为
  const e10 = withPolicy({ perChannel: { c: { headers: { "  x-pad  ": "v" } } } }, "c", {});
  assertCheck(
    "E10 头键名首尾空格被 trim 后写入（不留含空格键名）",
    !Object.keys(e10).some((k) => k !== k.trim()) && e10["x-pad"] === "v",
    JSON.stringify(e10)
  );

  // E11 headerOverride=false → 原样返回
  const e11in = { a: "1" };
  const e11 = withPolicy({ perChannel: { c: { headerOverride: false, headers: { a: "2" } } } }, "c", e11in);
  assertCheck("E11 headerOverride=false 时原样返回同一引用", e11 === e11in, JSON.stringify(e11));

  // E12 无头操作时原样返回同一引用（零分配）
  const e12in = { a: "1" };
  const e12 = withPolicy({ perChannel: { c: {} } }, "c", e12in);
  assertCheck("E12 无头操作时原样返回同一引用", e12 === e12in);

  // E13 非对象入参不炸
  const e13 = hook.run(pol("c", { perChannel: { c: { headers: { a: "1" } } } }), () => [hook.applyHeaders(null), hook.applyHeaders(undefined), hook.applyHeaders("str")]);
  assertCheck("E13 applyHeaders 对 null/undefined/字符串入参原样返回且不抛错", e13[0] === null && e13[1] === undefined && e13[2] === "str");

  // E14 与 byteSafeHeaders 串联：头覆盖 + 中文值转码都要对
  const e14in = { "user-agent": "orig", "x-cn": "中文" };
  const e14 = hook.run(pol("c", { perChannel: { c: { headers: { "user-agent": "X-Test/1.0" } } } }), () => util.byteSafeHeaders(e14in));
  assertCheck(
    "E14 与 util.byteSafeHeaders 串联：覆盖生效且中文值按 UTF-8→Latin-1 转码",
    e14["user-agent"] === "X-Test/1.0" && e14["x-cn"] === Buffer.from("中文", "utf8").toString("latin1") && e14in["user-agent"] === "orig",
    JSON.stringify(e14)
  );

  // E15 空配置下头覆盖不生效（默认 headerOverride=true 但无操作）
  const e15in = { "user-agent": "orig" };
  assertCheck("E15 空配置下头不被改动（同一引用）", hook.run(outbound.policyFor("", {}), () => hook.applyHeaders(e15in)) === e15in);

  // E16 头键大小写混排 + 配置侧也是混排
  const e16 = withPolicy({ perChannel: { c: { headers: { "X-MIXED-CASE": "v" } } } }, "c", { "x-Mixed-Case": "orig" });
  assertCheck(
    "E16 配置侧与入参侧大小写混排都能命中同一头",
    e16["x-Mixed-Case"] === "v" && Object.keys(e16).length === 1,
    JSON.stringify(e16)
  );
}

// ==========================================================================
// G. 前后端形状一致性（默认值逐字段 + TS 类型 vs 后端实际返回 + channels 跨模块契约）
// ==========================================================================

/** 去掉 JS/TS 行注释（跟踪字符串状态，避免误删字符串里的 //） */
function stripLineComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += src[i + 1] || ""; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** 从源码里取 `anchor` 之后第一个 `outbound:` 的对象字面量并求值 */
function extractOutboundDefaults(src) {
  const anchor = src.indexOf("export const LOCALGW_CONFIG_DEFAULTS");
  if (anchor < 0) return null;
  const i = src.indexOf("outbound:", anchor);
  if (i < 0) return null;
  const start = src.indexOf("{", i);
  let depth = 0;
  let end = -1;
  let quote = null;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === "\\") { j++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return null;
  const code = stripLineComments(src.slice(start, end + 1));
  // eslint-disable-next-line no-new-func
  return new Function(`return (${code});`)();
}

/** 取 TS 类型声明体（`export interface X {` 或 `export type X = {` 两种写法都要支持） */
function tsTypeBody(src, name) {
  const re = new RegExp(`export (?:interface|type) ${name}\\s*(?:=\\s*)?\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // 指向 '{'
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start + 1, i); }
  }
  return null;
}

/** 取对象类型体里**仅第 0 层**的字段名（嵌套 policy 块里的键不计入） */
function tsObjectMembers(body) {
  if (!body) return null;
  const keys = [];
  let depth = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "");
    if (depth === 0) {
      const m = line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/);
      if (m) keys.push(m[1]);
    }
    const cleaned = line
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    for (const ch of cleaned) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return keys;
}

/** 组合：直接取某个 TS 类型的顶层字段名 */
function tsTypeMembers(src, name) {
  return tsObjectMembers(tsTypeBody(src, name));
}

/** 结构化差异：键集合 + 标量值 + 数组长度/元素 */
function structuralDiff(a, b, at = "$", acc = []) {
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { acc.push(`${at}: 类型不同 前端=${ta} 后端=${tb}`); return acc; }
  if (ta === "array") {
    if (a.length !== b.length) acc.push(`${at}: 数组长度不同 前端=${a.length} 后端=${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) structuralDiff(a[i], b[i], `${at}[${i}]`, acc);
    return acc;
  }
  if (ta === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const onlyA = ka.filter((k) => !kb.includes(k));
    const onlyB = kb.filter((k) => !ka.includes(k));
    if (onlyA.length) acc.push(`${at}: 前端多出键 [${onlyA.join(", ")}]`);
    if (onlyB.length) acc.push(`${at}: 后端多出键 [${onlyB.join(", ")}]`);
    for (const k of ka.filter((x) => kb.includes(x))) structuralDiff(a[k], b[k], `${at}.${k}`, acc);
    return acc;
  }
  if (a !== b) acc.push(`${at}: 值不同 前端=${JSON.stringify(a)} 后端=${JSON.stringify(b)}`);
  return acc;
}

/** 在 Electron node 下真跑 routing.channelMatrix()（纯 node 16 无 node:sqlite，拿不到真实渠道清单） */
function probeChannelMatrixViaElectron() {
  const bin = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  if (!fs.existsSync(bin)) return { ok: false, reason: "electron 可执行文件不存在，无法真跑 channelMatrix()" };
  const code = `
    const routing = require(${JSON.stringify(path.join(ROOT, "electron/backend/localgw/routing.cjs"))});
    const rows = routing.channelMatrix();
    process.stdout.write("@@JSON@@" + JSON.stringify({ ok: true, rows }));
  `;
  const r = spawnSync(bin, ["-e", code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = String(r.stdout || "");
  const i = out.indexOf("@@JSON@@");
  if (i < 0) return { ok: false, reason: `electron 子进程未返回 JSON（status=${r.status}）：${(out + String(r.stderr || "")).slice(-400)}` };
  try {
    return JSON.parse(out.slice(i + "@@JSON@@".length));
  } catch (e) {
    return { ok: false, reason: `JSON 解析失败：${e.message}` };
  }
}

function runFrontendParity() {
  section("G. 前后端形状一致性（默认值 / TS 类型 / channels 跨模块契约）");

  const typesSrc = fs.readFileSync(path.join(ROOT, "src/types/index.ts"), "utf8");
  const ipcSrc = fs.readFileSync(path.join(ROOT, "src/api/ipc.ts"), "utf8");
  const backendOutbound = lgwConfig.LOCALGW_DEFAULTS.outbound;

  // G1 默认值逐字段对拍
  let feDefaults = null;
  let g1err = null;
  try { feDefaults = extractOutboundDefaults(typesSrc); } catch (e) { g1err = e; }
  assertCheck("G1 能从 src/types/index.ts 提取 LOCALGW_CONFIG_DEFAULTS.outbound", !g1err && !!feDefaults, g1err ? g1err.message : "");
  if (feDefaults) {
    const diffs = structuralDiff(feDefaults, backendOutbound);
    assertCheck("G2 前端默认值与后端 LOCALGW_DEFAULTS.outbound 逐字段一致（键集合+值）", diffs.length === 0, diffs.join("\n"));
    assertCheck(
      "G3 defaults 恰好是契约 §2 的 7 个字段",
      JSON.stringify(Object.keys(feDefaults.defaults).sort()) ===
        JSON.stringify(["builtinSanitize", "headerOverride", "jitter", "keywordSanitize", "mode", "profile", "rewriteSanitize"].sort()),
      `实际=${JSON.stringify(Object.keys(feDefaults.defaults))}`
    );
    assertCheck(
      "G4 outbound 顶层键集合 = defaults/perChannel/keywords/rewrites/profiles",
      JSON.stringify(Object.keys(feDefaults).sort()) === JSON.stringify(["defaults", "keywords", "perChannel", "profiles", "rewrites"].sort()),
      JSON.stringify(Object.keys(feDefaults))
    );
  }

  // G5 TS 类型成员 vs 后端实际返回对象的键
  const policyMembers = tsTypeMembers(typesSrc, "LocalgwOutboundPolicy");
  const kwMembers = tsTypeMembers(typesSrc, "LocalgwKeywordRule");
  const rwMembers = tsTypeMembers(typesSrc, "LocalgwRewriteRule");
  const profMembers = tsTypeMembers(typesSrc, "LocalgwProfile");
  assertCheck(
    "G5 TS 接口成员全部解析到（LocalgwOutboundPolicy / KeywordRule / RewriteRule / Profile）",
    !!(policyMembers && kwMembers && rwMembers && profMembers),
    JSON.stringify({ policyMembers, kwMembers, rwMembers, profMembers })
  );

  const realPolicy = outbound.policyFor("c", {});
  const missingInPolicy = policyMembers ? policyMembers.filter((k) => !(k in realPolicy)) : [];
  assertCheck(
    "G6 policyFor() 返回的 Policy 覆盖 TS LocalgwOutboundPolicy 的每个字段",
    missingInPolicy.length === 0,
    `TS 声明但运行时不存在的字段：[${missingInPolicy.join(", ")}]`
  );
  const extraInPolicy = policyMembers ? Object.keys(realPolicy).filter((k) => !policyMembers.includes(k) && !k.startsWith("__")) : [];
  assertCheck("G7 Policy 无未声明的公开字段（`__` 内部字段除外）", extraInPolicy.length === 0, `运行时多出：[${extraInPolicy.join(", ")}]`);

  const nKw = lgwConfig.normalize({ outbound: { keywords: [{ pattern: "a", replace: "b", scope: "user" }] } }).outbound.keywords[0];
  const nRw = lgwConfig.normalize({ outbound: { rewrites: [{ from: "a", to: "b", scope: "user" }] } }).outbound.rewrites[0];
  const nProf = lgwConfig.normalize({ outbound: { profiles: { custom: { p: { label: "L" } } } } }).outbound.profiles.custom.p;
  assertCheck(
    "G8 KeywordRule 归一化后的键集合 == TS LocalgwKeywordRule",
    kwMembers && JSON.stringify(Object.keys(nKw).sort()) === JSON.stringify([...kwMembers].sort()),
    `后端=${JSON.stringify(Object.keys(nKw).sort())} 前端=${JSON.stringify(kwMembers && [...kwMembers].sort())}`
  );
  assertCheck(
    "G9 RewriteRule 归一化后的键集合 == TS LocalgwRewriteRule",
    rwMembers && JSON.stringify(Object.keys(nRw).sort()) === JSON.stringify([...rwMembers].sort()),
    `后端=${JSON.stringify(Object.keys(nRw).sort())} 前端=${JSON.stringify(rwMembers && [...rwMembers].sort())}`
  );
  assertCheck(
    "G10 Profile 归一化后的键集合 == TS LocalgwProfile",
    profMembers && JSON.stringify(Object.keys(nProf).sort()) === JSON.stringify([...profMembers].sort()),
    `后端=${JSON.stringify(Object.keys(nProf).sort())} 前端=${JSON.stringify(profMembers && [...profMembers].sort())}`
  );

  // G11 档案下拉项（listProfiles 返回项）vs TS LocalgwOutboundProfileOption
  const profileOptMembers = tsTypeMembers(ipcSrc, "LocalgwOutboundProfileOption");
  const realOpt = outbound.listProfiles({})[0];
  assertCheck(
    "G11 listProfiles() 返回项键集合 == TS LocalgwOutboundProfileOption",
    profileOptMembers && realOpt && JSON.stringify(Object.keys(realOpt).sort()) === JSON.stringify([...profileOptMembers].sort()),
    `后端=${JSON.stringify(realOpt && Object.keys(realOpt).sort())} 前端=${JSON.stringify(profileOptMembers && [...profileOptMembers].sort())}`
  );

  // G12 channels 跨模块形状：后端真跑 vs TS LocalgwOutboundChannelRow
  const rowKeys = tsTypeMembers(ipcSrc, "LocalgwOutboundChannelRow");
  const policyInnerKeys = tsObjectMembers(tsTypeBody(ipcSrc, "LocalgwOutboundChannelRow") || "")
    ? (() => {
        const body = tsTypeBody(ipcSrc, "LocalgwOutboundChannelRow");
        const m = body.match(/policy\s*:\s*\{([\s\S]*?)\n\s*\}/);
        return m ? tsObjectMembers(m[1]) : null;
      })()
    : null;
  assertCheck(
    "G12 TS LocalgwOutboundChannelRow 解析到 5 个顶层字段 + policy 3 个字段",
    !!rowKeys && rowKeys.length === 5 && !!policyInnerKeys && policyInnerKeys.length === 3,
    JSON.stringify({ rowKeys, policyInnerKeys })
  );

  const probe = probeChannelMatrixViaElectron();
  if (!probe.ok) {
    assertCheck("G13 真跑 routing.channelMatrix() 取到渠道清单", false, probe.reason);
    assertCheck("G14 channels 行形状与 TS 类型一致", false, "无法判定：未取到真实渠道清单");
  } else {
    const rows = probe.rows || [];
    assertCheck("G13 真跑 routing.channelMatrix() 取到渠道清单（Electron node）", rows.length > 0, `rows=${rows.length}`);
    const shapeBad = [];
    for (const r of rows) {
      const rk = Object.keys(r).sort();
      if (JSON.stringify(rk) !== JSON.stringify([...rowKeys].sort())) shapeBad.push(`id=${r.id} 行键=${JSON.stringify(rk)}`);
      const pk = Object.keys(r.policy || {}).sort();
      if (JSON.stringify(pk) !== JSON.stringify([...policyInnerKeys].sort())) shapeBad.push(`id=${r.id} policy键=${JSON.stringify(pk)}`);
      if (typeof r.id !== "string" || typeof r.display !== "string") shapeBad.push(`id=${r.id} id/display 非字符串`);
      if (r.kind !== "builtin" && r.kind !== "custom") shapeBad.push(`id=${r.id} kind 非法=${r.kind}`);
      if (typeof r.accountCount !== "number") shapeBad.push(`id=${r.id} accountCount 非数字`);
      if (typeof r.policy.mode !== "string" || typeof r.policy.profileLabel !== "string") shapeBad.push(`id=${r.id} policy.mode/profileLabel 非字符串`);
      if (!Array.isArray(r.policy.parts) || r.policy.parts.some((x) => typeof x !== "string")) shapeBad.push(`id=${r.id} policy.parts 非 string[]`);
    }
    assertCheck(
      `G14 channels 全部 ${rows.length} 行的字段形状与 TS LocalgwOutboundChannelRow 一致`,
      shapeBad.length === 0,
      shapeBad.join("\n")
    );
    const kinds = [...new Set(rows.map((r) => r.kind))];
    assertCheck("G15 kind 取值落在 builtin|custom 内", kinds.every((k) => k === "builtin" || k === "custom"), kinds.join(","));
    console.log(`      [信息] channels=${rows.length}，kind 分布=${JSON.stringify(kinds)}，首行=${JSON.stringify(rows[0])}`);
  }
}

// ==========================================================================
// I. §4.8 IPC 三处登记一致性（index.cjs handler ↔ preload.cjs 白名单 ↔ ipc.ts 调用）
// ==========================================================================

function runIpcWiring() {
  section("I. §4.8 IPC 三处登记一致性（缺一处 = 渲染层调用被静默拒绝）");
  const idxSrc = fs.readFileSync(path.join(ROOT, "electron/backend/localgw/index.cjs"), "utf8");
  const preloadSrc = fs.readFileSync(path.join(ROOT, "electron/preload.cjs"), "utf8");
  const ipcSrc = fs.readFileSync(path.join(ROOT, "src/api/ipc.ts"), "utf8");

  const handlers = new Set();
  let m;
  const reH = /ipcMain\.handle\s*\(\s*["'](localgw_[a-z0-9_]+)["']/g;
  while ((m = reH.exec(idxSrc))) handlers.add(m[1]);
  const allowed = new Set();
  const reA = /["'](localgw_[a-z0-9_]+)["']/g;
  while ((m = reA.exec(preloadSrc))) allowed.add(m[1]);
  const calls = new Set();
  const reC = /call\s*<[^>]*>\s*\(\s*["'](localgw_[a-z0-9_]+)["']/g;
  while ((m = reC.exec(ipcSrc))) calls.add(m[1]);

  const outboundChannels = ["localgw_outbound_get", "localgw_outbound_set", "localgw_outbound_preview"];
  assertCheck(
    "I1 index.cjs 注册了 3 条 outbound handler",
    outboundChannels.every((c) => handlers.has(c)),
    `缺失：[${outboundChannels.filter((c) => !handlers.has(c)).join(", ")}]`
  );
  assertCheck(
    "I2 preload.cjs 白名单同步登记了 3 条 outbound 通道",
    outboundChannels.every((c) => allowed.has(c)),
    `缺失：[${outboundChannels.filter((c) => !allowed.has(c)).join(", ")}]`
  );
  assertCheck(
    "I3 前端 ipc.ts 调用的 localgw_* 全部在 handler 与白名单里",
    [...calls].every((c) => handlers.has(c) && allowed.has(c)),
    `未注册：[${[...calls].filter((c) => !handlers.has(c) || !allowed.has(c)).join(", ")}]`
  );
  const reg = idxSrc.match(/return\s*\{\s*ok:\s*true,\s*channels:\s*(\d+)\s*\}/);
  assertCheck(
    `I4 register() 返回的 channels 计数与真实 handler 数一致（声明=${reg && reg[1]}，实际=${handlers.size}）`,
    !!reg && Number(reg[1]) === handlers.size,
    `声明=${reg && reg[1]} 实际=${handlers.size}`
  );
}

// ==========================================================================
// 主入口
// ==========================================================================

async function runCheck(isAssert = false) {
  console.log("=== [outbound-verify] 本地网关出站伪装与清洗 · 独立验证（第一批 A–E）===");
  await runZeroRegression();
  runPassthrough();
  runRuleEngine();
  runDegradation();
  runHeaderOverride();
  runFrontendParity();
  runIpcWiring();

  console.log(`\n--- 汇总：${pass} 通过 / ${fail} 失败 ---`);
  if (fail) {
    console.log("失败项：");
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`);
  }
  if (process.argv.includes("--json")) {
    console.log("\n===JSON===");
    console.log(JSON.stringify({ pass: pass, fail: fail, results: results }, null, 2));
  }
  if (isAssert && fail > 0) process.exit(1);
  return { pass, fail, results };
}

if (require.main === module) {
  runCheck(process.argv.includes("--assert")).catch((e) => {
    console.error("验证脚本自身异常：", e && e.stack ? e.stack : e);
    process.exit(2);
  });
}

module.exports = { runCheck };
