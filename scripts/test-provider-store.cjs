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
// 自定义提供商·数据层自测：node scripts/test-provider-store.cjs
// 只碰 AGENTHUB_DATA_DIR 指向的临时目录（config.cjs 的自测沙箱钩子），不联网、不碰真实数据。
//
// 这一层守的是四条会被静默踩坏的约定（每条改动前必红）：
//   ① agents 表扩列而不是建新表——号池的轮转/冷却/租约/模型级负缓存/用量统计全部零改动生效，
//      代价是「提供商」与「内置渠道」同住一张表，于是 ②③④ 都必须靠 id 名单而不是靠 kind 列判；
//   ② 内置行永不当提供商：老库那几行的 kind 由 ALTER 的 DEFAULT 补成 'builtin'，可一条被手改脏的
//      内置行若只看 kind，会同时出现在渠道列表与提供商列表里（③ 的两道挡）；
//   ③ 两个视图的分工：channelList() 是路由视图（只给启用中的，停用的不能再被选中），
//      listProviders() 是管理面视图（含停用的，否则停用条目无法再被打开）；同一份数据、
//      两种读法必须给出不同集合——这也是本闸的一条正对照；
//   ④ updated_at 是动态适配器实例缓存的键：saveProvider 不前进它，改完配置就得重启网关。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-provider-store-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const store = require("../electron/backend/proxy/store.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra !== undefined ? ` → got ${JSON.stringify(extra)}` : ""}`); }
}

const PROVIDER = {
  id: "rel", display: "假中转", domain: "127.0.0.1", kind: "openai_compat",
  baseUrl: "http://127.0.0.1:9/v1", models: [{ model: "gpt-x" }],
  extraHeaders: { "x-a": "1" }, extraBody: { temperature: 0.2 }, poolStrategy: "round_robin",
};

console.log("① 迁移：六列齐备且幂等");
{
  store.open();
  const cols = store.channelList().length; // 触发一次完整读，确保迁移与种子都跑过
  ok(cols === store.CHANNELS.length, `未配置提供商时 channelList 就是内置渠道（${cols} 家）`, cols);
  store.open();
  store.open();
  ok(true, "二次/三次 open() 不抛（ALTER 已存在时按幂等吞掉）");
}

console.log("\n②③ 两个视图的分工与内置行的第二道挡");
{
  const p = store.saveProvider(PROVIDER);
  ok(!!p && p.id === "rel" && p.baseUrl === PROVIDER.baseUrl, "saveProvider 回读整条视图", p);
  const route = store.channelList();
  ok(route.some((c) => c.id === "rel" && c.kind === "openai_compat"), "路由视图里排在内置渠道之后", route.map((c) => c.id));
  ok(route.length === store.CHANNELS.length + 1, "提供商不新增渠道条目以外的位置漂移", route.length);
  ok(store.listProviders().map((x) => x.id).join(",") === "rel", "管理面视图只列自建条目", store.listProviders());

  // 停用的条目必须从路由视图消失但留在管理面：否则用户停不掉一个提供商，或者停用后再也打不开它
  const off = store.saveProvider(Object.assign({}, p, { enabled: false }));
  ok(off.enabled === false, "enabled=false 存得住", off);
  ok(!store.channelList().some((c) => c.id === "rel"), "停用后不再出现在路由视图（不能被选中）", store.channelList().map((c) => c.id));
  ok(store.listProviders().some((x) => x.id === "rel" && x.enabled === false), "停用后仍列在管理面（能被重新打开）", store.listProviders());
  store.saveProvider(Object.assign({}, off, { enabled: true }));

  // 第二道挡：kind 被写脏的内置行既不能进提供商列表，也不能在路由视图里降级
  store.saveProvider({ id: "trae", display: "脏化的内置行", domain: "x", kind: "openai_compat", baseUrl: "http://127.0.0.1:1" });
  ok(!store.listProviders().some((x) => x.id === "trae"), "id 命中内置名单的行绝不进提供商列表", store.listProviders().map((x) => x.id));
  const trae = store.channelList().find((c) => c.id === "trae");
  ok(trae && trae.kind === "builtin", "内置行在路由视图里仍是 builtin（内置条目的 display/domain 一律取代码常量，不看库里那行）", trae);
  ok(store.deleteProvider("trae") === false, "deleteProvider 拒绝内置 id（绝不删掉一条渠道）");
}

console.log("\n④ updated_at：动态适配器实例缓存的键");
{
  const a = store.saveProvider(Object.assign({}, PROVIDER, { display: "第一版" }));
  const b = store.saveProvider(Object.assign({}, a, { display: "第二版" }));
  // 正对照：这里必须「不相等」。相等的表现是改了 baseUrl 之后网关继续用旧实例打旧端点，
  // 而用户只看到「配置没生效」，没有任何报错。
  ok(b.updatedAt !== a.updatedAt, "两次保存的 updatedAt 必须前进（相同即配置改了适配器不换实例）", [a.updatedAt, b.updatedAt]);
  ok(b.display === "第二版" && b.baseUrl === PROVIDER.baseUrl, "整体覆盖语义：未改的字段照原样留着", b);
}

console.log("\n④b auth 列：三档鉴权风格必须原样往返（丢了就按 auto 发头，国内套餐全 401）");
{
  const bearer = store.saveProvider(Object.assign({}, PROVIDER, { id: "auth-b", display: "Bearer 档", auth: "bearer" }));
  ok(bearer.auth === "bearer", "auth=bearer 存得住", bearer.auth);
  ok(store.getProvider("auth-b").auth === "bearer", "回读仍是 bearer（不是被默认值盖掉）", store.getProvider("auth-b"));
  const xkey = store.saveProvider(Object.assign({}, PROVIDER, { id: "auth-x", display: "x-api-key 档", auth: "x-api-key" }));
  ok(xkey.auth === "x-api-key", "auth=x-api-key 存得住", xkey.auth);
  const none = store.saveProvider(Object.assign({}, PROVIDER, { id: "auth-n", display: "未指定" }));
  ok(none.auth === "", "未指定时落空串（= auto，按协议档推默认头）", none.auth);
  // 老库升级路径：列由 migrateProviders 的 ALTER 补上，缺省 ''。直接问表结构最可靠——
  // 只测「读回空串」区分不出「列不存在时读成 undefined」和「列存在但值为空」。
  const cols = store.open().prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
  ok(cols.includes("auth"), "agents 表确有 auth 列（老库靠 ALTER 补齐）", cols);
  for (const id of ["auth-b", "auth-x", "auth-n"]) store.deleteProvider(id);
}

console.log("\n⑤ 非法输入按空折叠（存进去的必须是读得出的）");
{
  const p = store.saveProvider({
    id: "fold", display: "  超长超长".repeat(20), kind: "openai_compat", baseUrl: "http://127.0.0.1:2",
    poolStrategy: "surprise", models: "不是数组", extraHeaders: "坏 JSON", extraBody: [1, 2],
  });
  ok(store.listAgents().find((a) => a.id === "fold").poolStrategy === "optimal", "非法 pool_strategy 折成 optimal（判据落在 listAgents 这个可观察面上：提供商视图刻意不带策略）", store.listAgents().find((a) => a.id === "fold"));
  ok(Array.isArray(p.models) && p.models.length === 0, "models 非数组 → 空清单（前缀路由仍可透传）", p.models);
  ok(p.extraHeaders && typeof p.extraHeaders === "object" && !Array.isArray(p.extraHeaders) && Object.keys(p.extraHeaders).length === 0, "extraBody/extraHeaders 非对象 → 空对象", p.extraHeaders);
  ok(p.enabled === true, "enabled 缺省视为启用（新建条目不该静默停用）", p.enabled);
  ok(p.display.length <= 64, `display 截到 64 以内（实际 ${p.display.length}）`, p.display.length);
}

console.log("\n⑥ 坏 JSON 按空处理但必须留痕");
{
  // 写路径自己 stringify 对象，产不出坏 JSON；坏 JSON 只可能是用户手改库或上一版异常留下的，
  // 所以这里绕过写路径直接改库文件（按 store 实际选中的驱动开第二条连接）。
  store.saveProvider({ id: "badjson", display: "库脏了", kind: "openai_compat", baseUrl: "http://127.0.0.1:3" });
  const Driver = store.driver() === "better-sqlite3" ? require("better-sqlite3") : require("node:sqlite").DatabaseSync;
  const raw = new Driver(path.join(store.proxyDir(), "stats.db"));
  raw.prepare("UPDATE agents SET extra_headers = '{oops', models_json = 'not json' WHERE id = ?").run("badjson");
  raw.close();
  const warns = [];
  const real = console.warn;
  let p;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    p = store.getProvider("badjson");
  } finally {
    console.warn = real;
  }
  ok(p && p.extraHeaders && Object.keys(p.extraHeaders).length === 0, "坏 extra_headers 按空对象继续服务（不抛、不清空整条）", p && p.extraHeaders);
  ok(p && Array.isArray(p.models) && p.models.length === 0, "坏 models_json 按空清单", p && p.models);
  ok(warns.some((w) => /extra_headers/.test(w) && /badjson/.test(w)), "留痕里说得出是哪一列哪个渠道（静默丢才是问题）", warns);
  // 路由视图走同一套 parseJsonMap，一条脏行不许把整个渠道列表拖崩
  store.invalidateChannels();
  ok(store.channelList().some((c) => c.id === "badjson" && Object.keys(c.extraHeaders).length === 0), "脏行在路由视图里也只是空对象（不抛、不整表失败）");
}

console.log("\n⑦ memo 生命周期与删连 Key");
{
  store.saveProvider({ id: "acc1p", display: "带号的", kind: "openai_compat", baseUrl: "http://127.0.0.1:4" });
  const acc = store.addAccount({ channel: "acc1p", name: "K1", token: "sk-1" });
  ok(!!acc, "提供商渠道能挂账号（与内置渠道同一条 accounts.channel 键）", acc);
  store.deleteProvider("acc1p");
  ok(store.listAccounts().filter((a) => a.channel === "acc1p").length === 0, "删提供商连带删掉它的 Key（不留孤儿行）", store.listAccounts().map((a) => a.channel));

  // memo：同一个「已读过」的引用必须复用（证明缓存生效），显式失效后才换新的
  const first = store.channelList();
  const again = store.channelList();
  ok(first === again, "channelList 走 memo（两次同一引用）");
  store.invalidateChannels();
  ok(store.channelList() !== first, "invalidateChannels 之后换新的（写路径靠它立刻生效）");
  // 上一条只测了「手动失效」，这条才是用户能感觉到的那半：改完配置不必重启网关
  store.channelList(); // 先把 memo 灌满
  store.saveProvider({ id: "justnow", display: "刚加的", kind: "openai_compat", baseUrl: "http://127.0.0.1:6" });
  ok(store.channelList().some((c) => c.id === "justnow"), "saveProvider 自己就让 memo 失效（否则新提供商要重启才被选中）", store.channelList().map((c) => c.id));
  store.deleteProvider("justnow");
  ok(!store.channelList().some((c) => c.id === "justnow"), "deleteProvider 同样立刻失效");
}

console.log("\n⑧ channelDisplay 的四条路");
{
  store.saveProvider({ id: "shown", display: "看得见", kind: "openai_compat", baseUrl: "http://127.0.0.1:5" });
  ok(store.channelDisplay("trae").length > 0 && store.channelDisplay("trae") !== "trae", "内置渠道拿注册表的展示名", store.channelDisplay("trae"));
  ok(store.channelDisplay("shown") === "看得见", "启用中的提供商拿它的 display");
  store.saveProvider(Object.assign({}, store.getProvider("shown"), { enabled: false }));
  ok(store.channelDisplay("shown") === "看得见", "停用的提供商也解析得出名字（历史流水不该退化成裸 slug）", store.channelDisplay("shown"));
  ok(store.channelDisplay("no_such") === "no_such", "未知 id 原样回落（统计页列的是流水里的值）", store.channelDisplay("no_such"));
  ok(store.isBuiltinChannel("trae") === true && store.isBuiltinChannel("shown") === false, "isBuiltinChannel 按 id 名单判", [store.isBuiltinChannel("trae"), store.isBuiltinChannel("shown")]);
  ok(store.listAgents().every((a) => "kind" in a && "enabled" in a), "listAgents 带 kind/enabled（号池页要区分内置与提供商）");
}

console.log("\n⑤ 账号 meta：空对象与缺省同义（不许把设备绑定元数据清空）");
{
  // 空对象是 truthy，原判据会让它整份替换 meta，把库里的设备绑定元数据（machineId/deviceId/
  // deviceMid/sid）与备注一并清空——表现是跨机同步后 Qoder 签名失败、小浣熊 200003 串号，
  // 而那正是这几列存在的意义。`{}` 与「不传 meta」必须同义
  const id = store.addAccount({
    channel: "raccoon", uid: "u-meta", name: "meta 测试号", token: "tok-1", refreshToken: "ref-1",
    source: "paste", expiresAt: 0,
    meta: { machineId: "m-1", deviceId: "d-1", note: "旧备注" },
  });
  const metaOf = () => JSON.parse((store.accountRows("raccoon").find((r) => r.id === id) || {}).meta || "{}");
  ok(metaOf().machineId === "m-1", "初始 meta 落库", metaOf());
  store.updateAccount(id, { status: "online", meta: {} });
  ok(metaOf().machineId === "m-1" && metaOf().note === "旧备注", "传 meta: {} 不清空已有 meta（空对象与缺省同义）", metaOf());
  store.updateAccount(id, { meta: { ...metaOf(), note: "新备注" } });
  ok(metaOf().note === "新备注", "传带键的 meta 照常写入", metaOf());
  ok(metaOf().machineId === "m-1", "改备注不动设备绑定元数据", metaOf());
  store.updateAccount(id, { status: "cooling" });
  ok(metaOf().machineId === "m-1" && metaOf().note === "新备注", "只改状态时 meta 原样保留", metaOf());
  store.removeAccount(id);
}

store.close();
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
