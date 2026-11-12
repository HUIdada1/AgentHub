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
// 自定义提供商 · 渲染层接线闸
//
// 为什么单独一条闸：这一段的产物主要是「接线」——一条 IPC 命令、一张词表、一个页签。
// 三处漂移的共同表现都不是报错而是静默：白名单漏登记 → 界面卡在加载态；档位词表漂了 →
// 思考档位下拉与实际降级不一致；页签没进 MODULES → 页面永远进不去。类型检查抓不到任何一条。
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let failed = 0;
function ok(cond, name, got) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}` + (got === undefined ? "" : ` → got ${JSON.stringify(got).slice(0, 260)}`));
  }
}

const PROVIDER_CMDS = [
  "proxy_provider_list",
  "proxy_provider_create",
  "proxy_provider_update",
  "proxy_provider_delete",
  "proxy_provider_add_key",
  "proxy_provider_remove_key",
  "proxy_provider_test",
  "proxy_provider_fetch_models",
];

// ===== ① IPC 三面一致：渲染层调用名 ⊆ preload 白名单，且每条都有主进程注册 =====
console.log("① IPC 三面一致（漏一处表现为界面假死，不是报错）");
{
  const preload = read("electron/preload.cjs");
  const allow = new Set([...preload.matchAll(/^\s+"([a-z0-9_]+)",/gm)].map((m) => m[1]));
  const ipc = read("src/api/ipc.ts");
  const index = read("electron/backend/proxy/index.cjs");
  const registered = new Set([...index.matchAll(/ipcMain\.handle\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  const called = new Set([...ipc.matchAll(/"(proxy_provider_[a-z_]+)"/g)].map((m) => m[1]));

  ok([...PROVIDER_CMDS].every((c) => called.has(c)), "渲染层把八条命令都封了函数", PROVIDER_CMDS.filter((c) => !called.has(c)));
  const missAllow = PROVIDER_CMDS.filter((c) => !allow.has(c));
  ok(missAllow.length === 0, "八条命令都在 preload 白名单里（漏登记＝「未授权的 IPC 命令」）", missAllow);
  const missReg = PROVIDER_CMDS.filter((c) => !registered.has(c));
  ok(missReg.length === 0, "八条命令都在主进程注册了", missReg);
  ok(called.size === PROVIDER_CMDS.length, "渲染层没有第九条 provider 命令（新增必须同步登记两处）", [...called]);

  // 装置自证：把一条不存在的命令塞进判据，必须被抓出来——否则上面几条绿得没有意义
  const fakeCheck = ["proxy_provider_list", "proxy_provider_zzz"].filter((c) => !allow.has(c));
  ok(fakeCheck.length === 1 && fakeCheck[0] === "proxy_provider_zzz", "漏登记的探测本身是有效的（能认出编造的命令）", fakeCheck);
}

// ===== ② 思考档位词表与后端同源（顺序也要一致：下拉按序展示） =====
console.log("\n② 档位词表同源（前端写死的那张表 vs util.EFFORT_RANK）");
{
  const view = read("src/views/localgw/LocalgwProvidersView.vue");
  const m = view.match(/const EFFORT_LEVELS = \[([^\]]*)\]/);
  const ui = m ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  const back = require(path.join(ROOT, "electron/backend/proxy/util.cjs")).EFFORT_LEVELS;
  ok(!!ui, "视图里能找到 EFFORT_LEVELS 常量（改名了就要同步改这条闸）", ui);
  ok(JSON.stringify(ui) === JSON.stringify(back), "前端档位表与后端逐字同序（漂移的表现是选了某档却被静默降级）", [ui, back]);
  ok(JSON.stringify(ui) !== JSON.stringify(back.slice(0, 5)), "同序判据不是恒真（截短一档必须不等）");
}

// ===== ③ 协议形态值集合与后端 KINDS 同源 =====
// 判据从「抠 provider.cjs 的字面量」改成「读预设目录模块」：协议档的单一真源已经搬到
// proxy/provider-presets.cjs（provider.cjs 只做 `new Set(presets.KINDS)`），继续按源码正则
// 抠字面量会得到 null —— 那不是漂移，是闸的解析方式过时了。现在改成解析「真源」，
// 并额外断言 provider.cjs 确实引用它（否则两边各自写死一份，才是真正要防的漂移）。
console.log("\n③ 上游协议形态值集合（types / 预设目录 / provider.cjs 三处同源）");
{
  const types = read("src/types/index.ts");
  const tm = types.match(/^export type ProxyProviderKind = ([^;]+);/m);
  const uiKinds = tm ? [...tm[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null;
  const catalog = require(path.join(ROOT, "electron/backend/proxy/provider-presets.cjs"));
  const backKinds = Array.isArray(catalog.KINDS) ? catalog.KINDS.slice() : null;
  const src = read("electron/backend/proxy/provider.cjs");
  ok(!!uiKinds, "types 里能解析出 ProxyProviderKind", uiKinds);
  ok(!!backKinds, "预设目录里能读到 KINDS", backKinds);
  ok(
    !!uiKinds && !!backKinds && uiKinds.slice().sort().join() === backKinds.slice().sort().join(),
    "两侧值集合完全相同（前端多一档会存下后端拒收的 kind，后端多一档前端选不到）",
    [uiKinds, backKinds],
  );
  ok(/new Set\(presets\.KINDS\)/.test(src), "provider.cjs 的 KINDS 取自预设目录而不是自己再写一份", src.match(/const KINDS[^\n]*/));
  ok(
    !!uiKinds && uiKinds.length === 3,
    "三档协议都在（少一档＝那批渠道点了预设就建不出来）",
    uiKinds,
  );
}

// ===== ③b 预设目录自检：数据错一条的表现是「点了没反应」，不是报错 =====
console.log("\n③b 预设目录完整性");
{
  const catalog = require(path.join(ROOT, "electron/backend/proxy/provider-presets.cjs"));
  const problems = catalog.audit();
  ok(problems.length === 0, "目录自检零问题（标识/协议/鉴权/基址/模型名去重）", problems);
  ok(catalog.PRESETS.length === 34, "预设条数 = 34（33 个渠道 + 基元律动）", catalog.PRESETS.length);
  const list = catalog.list();
  ok(list.every((p) => typeof p.modelCount === "number" && p.brand), "精简视图字段齐全（brand/modelCount 缺了卡片就是白块）", list[0]);
  ok(!JSON.stringify(list).includes('"models"'), "精简视图不含模型清单（307 条不该每次刷新列表都传一遍）");
  const idx = read("electron/backend/proxy/index.cjs");
  ok(/presets:\s*providerPresets\.list\(\)/.test(idx), "proxy_provider_list 顺带返回 presets（不新增第 9 条 provider IPC）", idx.match(/proxy_provider_list[^\n]*/));
}

// ===== ③c 视图侧：空态与工具栏（文案改动容易在重构里被带回去） =====
console.log("\n③c 列表页空态与工具栏");
{
  const view = read("src/views/localgw/LocalgwProvidersView.vue");
  ok(!/还没有自定义提供商/.test(view), "旧的空态长文案已删除", view.match(/还没有自定义提供商/g));
  ok(/暂无数据/.test(view), "空态是「暂无数据」");
  ok(/接入约定/.test(view), "接入约定入口还在（只是从卡片改成了弹窗）");
  ok(/providerLogo|PROVIDER_LOGOS/.test(view), "列表行用上了品牌图标解析");
}

// ===== ④ 页面可达：MODULES 页签 + App.vue 挂载三处都对得上 =====
console.log("\n④ 页面可达（页签注册 + 挂载，缺一处就是进不去或白屏）");
{
  const types = read("src/types/index.ts");
  // 作用域切到 proxy 模块那段 pages 数组：全文正则会撞上别的模块的同名 id，切不到即判红
  const pm = types.match(/key:\s*"localgw",[\s\S]*?pages:\s*\[([\s\S]*?)\]/);
  ok(!!pm, "能在 MODULES 里定位到本地网关模块的 pages 数组", pm && pm[1].slice(0, 60));
  const ids = pm ? [...pm[1].matchAll(/\{\s*id:\s*"([a-z]+)"/g)].map((x) => x[1]) : [];
  ok(ids.includes("providers"), "proxy 页签里含 providers", ids);
  ok(pm[1].includes('id: "providers", name: "自定义提供商"'), "本地网关页签有中文名（没 name 会渲染成空按钮）", pm && pm[1]);

  const app = read("src/App.vue");
  ok(/import\s+LocalgwProvidersView\s+from\s+"\.\/views\/localgw\/LocalgwProvidersView\.vue"/.test(app), "App.vue 引了该视图");
  const block = app.match(/<LocalgwProvidersView[^>]*\/>/);
  ok(!!block, "App.vue 里有该视图的挂载块", block && block[0]);
  const b = block ? block[0] : "";
  ok(
    /v-if="seen\('localgw', 'providers'\)"/.test(b) && /v-show="on\('localgw', 'providers'\)"/.test(b) && /'page-anim': on\('localgw', 'providers'\)/.test(b),
    "挂载块三处页签名一致（v-if 拼错＝永不挂载，v-show 拼错＝永远不显示）",
    b,
  );
}

// ===== ⑤ Key 列表的数据源：号池视图不含提供商，照 fork 写法会拿到空表 =====
console.log("\n⑤ 「Key 管理」的取数路径");
{
  const view = read("src/views/localgw/LocalgwProvidersView.vue");
  ok(!/api\.proxyPool\(\)/.test(view), "视图不调 proxyPool（那条视图按内置 CHANNELS 迭代，提供商恒不在其中）", view.match(/api\.proxyPool\(\)/g));
  ok(/\.keys\b/.test(view), "视图从 proxy_provider_list 的 keys 字段取 Key 列表");
  ok(/upstreamModels\.value = \(r\.models \|\| \[\]\)\.flatMap/.test(view), "上游模型对象按结构化目录项解析而非 String(object)");
  ok(/upstreamModel\?\.contextLength/.test(view) && /upstreamModel\?\.maxOutputTokens/.test(view), "导入时保留上游上下文与最大输出元数据");
  const provider = read("electron/backend/proxy/provider.cjs");
  ok(/keys,/.test(provider) && /pool\.poolAccounts\(p\.id\)/.test(provider), "后端 list() 确实带上了 keys（与号池同一个脱敏视图）");
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
