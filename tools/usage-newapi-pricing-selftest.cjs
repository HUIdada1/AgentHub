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
// New API 内置价格源回归守卫（不联网，全部用本地 fixture）
//
// 锁五件事：
//   A. 官方倍率预设的表达式系数口径：p/c/cr/cc 系数即 $/1M 真实价格（new-api billingexpr 约定）
//   B. models.dev 预设：cost 字段即 $/1M，同名模型跨供应商取最便宜的非零输入价
//   C. 两个预设合并：官方预设优先，models.dev 只补空缺
//   D. 必须跳过的脏数据：按次计费（fixed）/ 表达式抽不到系数 / 显式 ratio 模式
//   E. 价格来源优先级：手动 > New API > 远程 > 内置，且低优先级段保留不删
//
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实用量库。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-newapi-"));
process.env.USERPROFILE = SANDBOX; // os.homedir() 在 Windows 上取 USERPROFILE，用量库随之进沙箱
process.env.APPDATA = path.join(SANDBOX, "appdata"); // 隔离真实 %APPDATA%

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const syncConfig = require("../electron/backend/sync-config.cjs");
const dbPath = syncConfig.dbPath();
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  用量库 = " + dbPath);
ok("用量库路径在沙箱内（绝不写真实库）",
  path.resolve(dbPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase()));
if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase())) {
  console.error("拒绝运行：用量库路径不在沙箱内"); process.exit(2);
}

const db = require("../electron/backend/db.cjs");
const billing = require("../electron/backend/billing.cjs");

// ===== fixture：贴近两个内置预设的真实结构 =====
// 官方倍率预设（ratio_config-v1-base.json）：billing_expr 表达式，系数就是 $/1M
const OFFICIAL_FIXTURE = {
  success: true,
  message: "",
  data: {
    billing_expr: {
      "gpt-4o": 'tier("standard", p * 2.5 + cr * 1.25 + cc * 3.125 + c * 10)',
      "claude-3-5-sonnet-20241022": 'tier("standard", p * 3 + c * 15)',
      "vendor/qwen3-max": 'tier("standard", p * 2 + c * 4)',
      // 阶梯：单价表只能存一组数，取首档（低上下文档）
      "tiered-model": 'len <= 512000 ? tier("0_512k", p * 0.3 + cr * 0.06 + c * 1.2) : tier("512k_plus", p * 0.6 + cr * 0.12 + c * 2.4)',
      // 分时：取表达式里第一个 tier
      "clock-model": 'weekday("UTC") >= 1 ? tier("peak", p * 0.3 + c * 1.2) : tier("off_peak", p * 0.15 + c * 0.6)',
      // 免费模型：系数全 0 是真实价格，保留
      "free-model": 'tier("standard", p * 0 + cr * 0 + c * 0)',
      // 按次计费：token 计价表达不了
      "mj_imagine": 'tier("image", fixed(0.0035)) * image_count',
      // 系数是变量：无法定价，必须跳过（按 0 写会严重低估）
      "bad-model": 'tier("standard", p * rate + c * 2)',
      // 显式 ratio 模式：表达式不生效
      "ratio-model": 'tier("standard", p * 9 + c * 9)',
    },
    billing_mode: {
      "gpt-4o": "tiered_expr",
      "claude-3-5-sonnet-20241022": "tiered_expr",
      "vendor/qwen3-max": "tiered_expr",
      "tiered-model": "tiered_expr",
      "clock-model": "tiered_expr",
      "free-model": "tiered_expr",
      "mj_imagine": "tiered_expr",
      "bad-model": "tiered_expr",
      "ratio-model": "ratio",
    },
  },
};

// models.dev 预设（api.json）：cost 字段即 $/1M
const MODELSDEV_FIXTURE = {
  openai: { models: { "gpt-4o": { cost: { input: 2.5, output: 10, cache_read: 1.25 } }, "o3-mini": { cost: { input: 1.1, output: 4.4 } } } },
  cheap: { models: { "gpt-4o": { cost: { input: 1.5, output: 6 } } } }, // 更便宜的非零价应胜出
  freebie: { models: { "gpt-4o": { cost: { input: 0, output: 0 } } } }, // 零价不覆盖非零
  nocost: { models: { mystery: {} } }, // 没有 cost 的记录跳过
};

console.log("");
console.log("=== A. 官方倍率预设：表达式系数即 $/1M ===");
const p1 = billing.parseBillingExprPreset(JSON.stringify(OFFICIAL_FIXTURE));
const gpt = p1.prices.get("gpt-4o");
ok("输入价 = p 系数 2.5", gpt && near(gpt.inputPerM, 2.5), JSON.stringify(gpt));
ok("输出价 = c 系数 10", gpt && near(gpt.outputPerM, 10), JSON.stringify(gpt));
ok("缓存读 = cr 系数 1.25", gpt && near(gpt.cacheReadPerM, 1.25), JSON.stringify(gpt));
ok("缓存写 = cc 系数 3.125", gpt && near(gpt.cacheWritePerM, 3.125), JSON.stringify(gpt));
ok("币种固定 USD", gpt && gpt.currency === "USD");

const claude = p1.prices.get("claude-3-5-sonnet-20241022");
ok("没单列缓存读 → 按输入价（new-api DefaultCacheRatio）", claude && near(claude.cacheReadPerM, 3), JSON.stringify(claude));
ok("没单列缓存写 → 输入价 × 1.25", claude && near(claude.cacheWritePerM, 3.75), JSON.stringify(claude));
ok("输出价 = 15", claude && near(claude.outputPerM, 15), JSON.stringify(claude));

const qwen = p1.prices.get("vendor/qwen3-max");
ok("供应商前缀原样保留（匹配阶段再归一化）", qwen && near(qwen.inputPerM, 2), JSON.stringify(qwen));

const tiered = p1.prices.get("tiered-model");
ok("阶梯表达式取首档（0.3 / 1.2）", tiered && near(tiered.inputPerM, 0.3) && near(tiered.outputPerM, 1.2), JSON.stringify(tiered));
ok("阶梯模型进 tiered 提示列表", p1.tiered.includes("tiered-model"), JSON.stringify(p1.tiered));
const clock = p1.prices.get("clock-model");
ok("分时表达式取第一个 tier", clock && near(clock.inputPerM, 0.3) && near(clock.outputPerM, 1.2), JSON.stringify(clock));
ok("免费模型（系数 0）保留为 0 价", p1.prices.get("free-model") && near(p1.prices.get("free-model").inputPerM, 0));

console.log("");
console.log("=== B. 必须跳过的脏数据（留给下层来源兜底）===");
ok("按次计费 fixed(...) 跳过", p1.skipped.request.includes("mj_imagine"), JSON.stringify(p1.skipped.request));
ok("系数是变量（p * rate）跳过", p1.skipped.invalid.includes("bad-model"), JSON.stringify(p1.skipped.invalid));
ok("显式 ratio 模式跳过", p1.skipped.invalid.includes("ratio-model"), JSON.stringify(p1.skipped.invalid));
ok("被跳过的模型不进价目表", !p1.prices.has("mj_imagine") && !p1.prices.has("bad-model") && !p1.prices.has("ratio-model"));
ok("可用模型共 6 个", p1.prices.size === 6, String(p1.prices.size));

console.log("");
console.log("=== C. models.dev 预设：cost 即 $/1M，同名取最便宜非零 ===");
const pDev = billing.parseModelsDev(JSON.stringify(MODELSDEV_FIXTURE));
const devGpt = pDev.prices.get("gpt-4o");
ok("同名跨供应商取最便宜非零输入价（1.5）", devGpt && near(devGpt.inputPerM, 1.5), JSON.stringify(devGpt));
ok("对应输出价 6", devGpt && near(devGpt.outputPerM, 6), JSON.stringify(devGpt));
ok("缺 cache_read → 按输入价", devGpt && near(devGpt.cacheReadPerM, 1.5), JSON.stringify(devGpt));
ok("零价候选不覆盖非零价", devGpt && devGpt.inputPerM !== 0, JSON.stringify(devGpt));
ok("普通模型原样解析", near(pDev.prices.get("o3-mini").outputPerM, 4.4));
ok("没有 cost 的记录跳过", !pDev.prices.has("mystery"));

console.log("");
console.log("=== D. 三套价格源：顺序、链接与格式 ===");
const SRC = billing.PRICING_SOURCES;
ok("共三套，顺序即优先级", SRC.length === 3 && SRC.map((s) => s.id).join(",") === "official,modelsdev,remote",
  SRC.map((s) => s.id).join(","));
ok("① 官方倍率预设（表达式）", SRC[0].url === "https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json" && SRC[0].format === "billing_expr");
ok("② models.dev 预设", SRC[1].url === "https://models.dev/api.json" && SRC[1].format === "models_dev");
ok("③ 远程价格表（LiteLLM，带 sha256 短路）",
  SRC[2].url === "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json"
  && SRC[2].format === "litellm" && /model_prices_and_context_window\.sha256$/.test(SRC[2].hashUrl));
ok("每套都有展示用域名", SRC.every((s) => typeof s.host === "string" && s.host.includes(".")));

// 三套各写各的 source 段，互不覆盖：优先级由 db 排序键决定
ok("三套来源标识互不相同", new Set(SRC.map((s) => s.id)).size === 3);

console.log("");
console.log("=== E. 模型名归一化（只收敛明显同义写法，不做模糊相似）===");
const nm = billing.normalizeModelName;
ok("去供应商前缀", nm("openai/gpt-4o") === "gpt-4o");
ok("小写化", nm("GPT-4O") === "gpt-4o");
ok("去日期后缀（紧凑）", nm("claude-3-5-sonnet-20241022") === "claude-3-5-sonnet", nm("claude-3-5-sonnet-20241022"));
ok("去日期后缀（带横线）", nm("gpt-4o-2024-08-06") === "gpt-4o", nm("gpt-4o-2024-08-06"));
ok("去 @ 版本后缀", nm("glm-4@20250807") === "glm-4", nm("glm-4@20250807"));
ok("去 :free 变体", nm("deepseek-chat:free") === "deepseek-chat");
ok("去 -latest", nm("gpt-4o-latest") === "gpt-4o");
ok("不误剥 -mini（关键：否则 gpt-4o-mini 会被算成 gpt-4o 的价）", nm("gpt-4o-mini") === "gpt-4o-mini");
ok("不误剥 -pro", nm("o1-pro") === "o1-pro");
ok("不误剥小数点版本", nm("glm-4.6") === "glm-4.6");

const index = billing.buildPriceIndex(p1.prices);
ok("原名精确匹配", billing.matchModel(index, "gpt-4o").via === "exact");
ok("大小写匹配", billing.matchModel(index, "GPT-4O").via === "case");
ok("归一化匹配（带日期）", billing.matchModel(index, "gpt-4o-2024-08-06").via === "normalized");
ok("归一化匹配（带供应商前缀）", billing.matchModel(index, "openai/claude-3-5-sonnet").via === "normalized");
ok("无对应模型返回 null", billing.matchModel(index, "gpt-4o-mini") === null);

// 同名带后缀与不带后缀并存时，通用价（无后缀者）优先接管未知日期
const dual = new Map([
  ["gpt-4o", { modelId: "gpt-4o", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 0, cacheWritePerM: 0, currency: "USD" }],
  ["gpt-4o-2024-08-06", { modelId: "gpt-4o-2024-08-06", inputPerM: 3, outputPerM: 12, cacheReadPerM: 0, cacheWritePerM: 0, currency: "USD" }],
]);
const dualIndex = billing.buildPriceIndex(dual);
ok("精确命中自己的日期版本", dualIndex && billing.matchModel(dualIndex, "gpt-4o-2024-08-06").row.inputPerM === 3);
ok("未知日期版本回落到通用价", billing.matchModel(dualIndex, "gpt-4o-2025-01-01").row.inputPerM === 2.5);

console.log("");
console.log("=== F. 来源优先级：手动 > New API > 远程 > 内置 ===");
const day = 24 * 60 * 60 * 1000;
function rec(id, model, provider, tokens, startedAt) {
  return {
    id, deviceId: "dev-a", deviceName: "测试机", source: "claude",
    providerId: provider, modelId: model,
    inputTokens: tokens, outputTokens: tokens, reasoningTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    startedAt: startedAt ?? Date.now(), status: "success",
  };
}
const currentOf = (m) => db.listCurrentPrices().find((p) => p.modelId === m);

db.savePrice({ modelId: "prio-model", providerId: null, inputPerM: 11, outputPerM: 22, currency: "USD", effectiveFrom: 0 }, "自测");
db.applySourcePricing([{ modelId: "prio-model", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 3.125, currency: "USD" }], "official");
db.applySourcePricing([{ modelId: "prio-model", inputPerM: 3, outputPerM: 12, cacheReadPerM: 0.3, cacheWritePerM: 0, currency: "USD" }], "remote");

let cur = currentOf("prio-model");
ok("三段并存时取手动价", cur && cur.source === "manual" && near(cur.inputPerM, 11), JSON.stringify(cur));
ok("sources 列出全部三个来源", cur && cur.sources.slice().sort().join(",") === "manual,official,remote", JSON.stringify(cur && cur.sources));

db.get().prepare("DELETE FROM model_price WHERE model_id = 'prio-model' AND COALESCE(source,'manual') = 'manual'").run();
cur = currentOf("prio-model");
ok("删掉手动价 → 官方预设接管", cur && cur.source === "official" && near(cur.inputPerM, 2.5), JSON.stringify(cur));

db.get().prepare("DELETE FROM model_price WHERE model_id = 'prio-model' AND COALESCE(source,'manual') = 'official'").run();
cur = currentOf("prio-model");
ok("再删官方预设 → 远程价兜底", cur && cur.source === "remote" && near(cur.inputPerM, 3), JSON.stringify(cur));

console.log("");
console.log("=== G. 计费视图确实按 New API 价算钱 ===");
db.applySourcePricing([{ modelId: "cost-model", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 3.125, currency: "USD" }], "official");
db.insertRecords([rec("cm1", "cost-model", "claude", 1000000)]);
const cost = db.get().prepare("SELECT cost_native AS c, cost_currency AS cur, price_id AS pid FROM v_record_cost WHERE model_id = 'cost-model'").get();
ok("100 万输入 + 100 万输出 = 2.5 + 10 = 12.5", cost && near(cost.c, 12.5), JSON.stringify(cost));
ok("费用币种取价格行币种 USD", cost && cost.cur === "USD", JSON.stringify(cost));
ok("命中价格行（不是无价 0）", cost && cost.pid != null, JSON.stringify(cost));

console.log("");
console.log("=== H. 托底：空响应 / 幂等 / 旧版覆盖自愈 ===");
const beforeSeg = db.countSourcePrices("official");
db.applySourcePricing([], "official");
ok("空数组不删除已有价格段", db.countSourcePrices("official") === beforeSeg, `${beforeSeg} -> ${db.countSourcePrices("official")}`);

const same = [{ modelId: "cost-model", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 3.125, currency: "USD" }];
const again = db.applySourcePricing(same, "official");
ok("同价重复应用 → 全部跳过（不产生新版本）", again.added === 0 && again.updated === 0 && again.skipped === 1, JSON.stringify(again));
ok("价格段数量未变（没有开新段）", db.countSourcePrices("official") === beforeSeg, `${beforeSeg} -> ${db.countSourcePrices("official")}`);

// 旧版客户端（不认识 newapi 来源）上传的价格表：整表覆盖后段丢失，锚点必须被清，下轮才会重拉
db.setMeta("pricing_official_hash", "deadbeef");
db.setMeta("pricing_official_at", "12345");
const legacyPayload = db.listAllPrices().filter((p) => p.source !== "official");
db.replacePrices(legacyPayload, Date.now(), undefined);
ok("旧版 payload 整表替换后在线定价段消失", db.countSourcePrices("official") === 0, String(db.countSourcePrices("official")));
ok("拉取锚点被清（下轮同步强制重拉）", !db.getMeta("pricing_official_hash") && db.getMeta("pricing_official_at") === "0",
  `${JSON.stringify(db.getMeta("pricing_official_hash"))} / ${JSON.stringify(db.getMeta("pricing_official_at"))}`);

// 新版客户端上传（含 newapi 段）时锚点不该被动
db.applySourcePricing(same, "official");
db.setMeta("pricing_official_hash", "cafebabe");
db.replacePrices(db.listAllPrices(), Date.now(), undefined);
ok("新版 payload 含在线定价段 → 锚点保留", db.getMeta("pricing_official_hash") === "cafebabe", JSON.stringify(db.getMeta("pricing_official_hash")));

console.log("");
console.log("=== I. 配置层：三套源默认值与旧配置迁移 ===");
const def = syncConfig.defaultConfig().billing;
const ds = def.sources || {};
ok("默认三套都在配置里", !!ds.official && !!ds.modelsdev && !!ds.remote);
ok("默认全关（用户主动开才拉）", ds.official.enabled === false && ds.modelsdev.enabled === false && ds.remote.enabled === false);
ok("默认间隔 24 小时", ds.official.intervalHours === 24 && ds.modelsdev.intervalHours === 24 && ds.remote.intervalHours === 24);
ok("不再需要填网址/地址（配置里没有 url/baseUrl/token）",
  !("url" in ds.remote) && !("baseUrl" in ds.official) && !("newApi" in def) && !("remotePricing" in def));

db.close();
console.log("");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
console.log("全部通过");
