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
// 积分包到期数据层闸
//  ① util.normalizeExpiryMs：秒/毫秒判别、纯日期补 23:59:59、远未来脏值→长期(0)
//  ② pool.deriveAccountCredits：Σ未过期剩余、最近到期取 remaining>0、不限哨兵、无包→null
//  ③ store 包集整体替换：DELETE+INSERT 原子替换、-1 保留、负值归 0、ord 排序、删号清包
//  ④ pool.decoratePackageStates：expired/expiringSoon 的边界（时间态每次出视图重算，不落库）
//  ⑤ store.listAllCreditPackages：一次全量分桶，与逐账号读逐字段等价（号池视图走这条）
//  ⑥ 端到端一条链：落包 → 全量读 → 时间态 → 派生账号额度
//  ⑦ 同步往返：exportPool 带包集 + mergeSnapshot 的新增/LWW/旧版本三条分支各就各位
//  ⑧ 静态接线：建表 / 刷新链路落包并派生 / poolView 附包集 / 导出面齐全
//  ⑨ 到期阈值可配：默认值等于改动前的硬编码、账号级与逐包共用同一旋钮、非法值忽略
// 纯 Node、临时沙箱、零副作用（不开真库、不联网）
// 跑法（store.cjs 用 node:sqlite，系统 node 没有这个内建模块）：
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/dev-credit-packages-test.cjs
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-credpkg-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const util = require(path.join(ROOT, "electron", "backend", "proxy", "util.cjs"));
const pool = require(path.join(ROOT, "electron", "backend", "proxy", "pool.cjs"));
const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));

// 断言抛出时结尾的 store.close() 就跑不到：库句柄留在进程里，父进程等管道会等不到头。
// 挂 exit 钩子，让「失败退出」和「成功退出」放句柄的路径一致。
process.on("exit", () => { try { store.close(); } catch { /* 已经在报错退出，关不掉不影响结论 */ } });

let n = 0;
const pass = (m) => { n++; console.log(`  ${String(n).padStart(2)}. ${m}`); };
const DAY = 86400000;

// ===== ① normalizeExpiryMs 归一 =====
{
  const ms = Date.now() + 50 * DAY;
  assert.strictEqual(util.normalizeExpiryMs(ms), ms, "① 毫秒时间戳应原样返回");
  const sec = Math.floor((Date.now() + 50 * DAY) / 1000);
  assert.strictEqual(util.normalizeExpiryMs(sec), sec * 1000, "① 秒级时间戳应 ×1000");
  const ds = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
  assert.strictEqual(util.normalizeExpiryMs(ds), Date.parse(ds + "T23:59:59"),
    "① 纯日期串应补到当天 23:59:59（否则取到 00:00 会被误判提前一天过期）");
  const far = new Date(Date.now() + 8 * 365 * DAY).toISOString().slice(0, 10);
  assert.strictEqual(util.normalizeExpiryMs(far), 0, "① 远未来脏值（>5 年）应归 0=长期有效");
  assert.strictEqual(util.normalizeExpiryMs(""), 0, "① 空串→0");
  assert.strictEqual(util.normalizeExpiryMs(null), 0, "① null→0");
  pass("① normalizeExpiryMs：秒/毫秒判别、纯日期补 23:59:59、远未来→0、空→0");
}

// ===== ② deriveAccountCredits 派生 =====
{
  const T = Date.now();
  const pkgs = [
    { remaining: 100, total: 100, expiresAt: T + 10 * DAY },
    { remaining: 50, total: 50, expiresAt: T + 5 * DAY },
    { remaining: 200, total: 200, expiresAt: T - 1 * DAY }, // 已过期，不计
  ];
  const d = pool.deriveAccountCredits(pkgs, T);
  assert.strictEqual(d.credits, 150, "② 剩余=Σ未过期包剩余（100+50，过期的 200 不计）");
  assert.strictEqual(d.expiresAt, T + 5 * DAY, "② 最近到期=min(剩余>0 且未过期 的包到期)");

  const unl = pool.deriveAccountCredits([...pkgs, { remaining: -1, total: -1, expiresAt: 0 }], T);
  assert.strictEqual(unl.credits, -1, "② 任一包不限(remaining=-1) ⇒ credits=-1 哨兵");

  // total=-1 是「上游不给这一包的总额」，不是「额度无限」。混为一谈时，只缺面值的包会把
  // 整号余额派生成无限，并绕开 cost-first 路由。
  const noTotal = pool.deriveAccountCredits(
    [{ remaining: 500, total: -1, expiresAt: 0 }, { remaining: 100, total: 100, expiresAt: T + 3 * DAY }], T);
  assert.strictEqual(noTotal.credits, 600, "② total=-1（不给总额）不得派生成不限：剩余照常累加");
  assert.strictEqual(noTotal.expiresAt, T + 3 * DAY, "② 无面值包无到期(0) ⇒ 最近到期只看有到期的包");

  const withPerpetual = pool.deriveAccountCredits(
    [{ remaining: 30, total: 30, expiresAt: 0 }, { remaining: 50, total: 50, expiresAt: T + 5 * DAY }], T);
  assert.strictEqual(withPerpetual.credits, 80, "② 无到期(0)包剩余计入余额");
  assert.strictEqual(withPerpetual.expiresAt, T + 5 * DAY, "② 最近到期忽略无到期(0)的包");

  const noRemain = pool.deriveAccountCredits(
    [{ remaining: 0, total: 100, expiresAt: T + 2 * DAY }, { remaining: 0, total: 10, expiresAt: 0 }], T);
  assert.strictEqual(noRemain.credits, 0, "② 全无剩余 ⇒ credits=0");
  assert.strictEqual(noRemain.expiresAt, 0, "② 无 remaining>0 的包 ⇒ 最近到期=0");

  assert.strictEqual(pool.deriveAccountCredits([], T), null, "② 空包集 ⇒ null（调用方保留既有聚合值）");
  assert.strictEqual(pool.deriveAccountCredits(undefined, T), null, "② 非数组 ⇒ null");
  pass("② deriveAccountCredits：Σ未过期剩余 / 最近到期取 remaining>0 / 不限哨兵只认 remaining / 空→null");
}

// ===== ③ store 包集整体替换 =====
{
  const T = Date.now();
  const id = store.addAccount({ channel: "trae", uid: "u-pkg", name: "包测账号", token: "tk", refreshToken: "", source: "paste" });
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 新账号包集应为空");

  store.setCreditPackages(id, "trae", [
    { code: "b", name: "包B", total: 200, used: 50, remaining: 150, expiresAt: T + 5 * DAY, ord: 1 },
    { code: "a", name: "包A", total: 100, used: 10, remaining: 90, expiresAt: T + 2 * DAY, ord: 0 },
    { code: "u", name: "不限包", total: -1, used: 0, remaining: -1, expiresAt: 0, ord: 2 },
    { code: "neg", name: "脏值包", total: -5, used: -3, remaining: -9, expiresAt: 0, ord: 3 },
  ]);
  const list = store.listCreditPackages(id);
  assert.strictEqual(list.length, 4, "③ 应落 4 个包");
  assert.deepStrictEqual(list.map((p) => p.code), ["a", "b", "u", "neg"], "③ 应按 ord 升序");
  assert.strictEqual(list[2].remaining, -1, "③ -1 不限哨兵应保留");
  assert.strictEqual(list[2].total, -1, "③ -1 总额哨兵应保留");
  assert.strictEqual(list[3].remaining, 0, "③ 小于 -1 的负值应归 0");
  assert.strictEqual(list[3].total, 0, "③ 负总额应归 0");

  // 整体替换：换一个更小的集合，旧包必须全部消失（不是 upsert 叠加）
  store.setCreditPackages(id, "trae", [{ code: "only", name: "唯一包", total: 10, used: 1, remaining: 9, expiresAt: T + DAY }]);
  const list2 = store.listCreditPackages(id);
  assert.strictEqual(list2.length, 1, "③ 整体替换后只剩新集合（不残留旧包）");
  assert.strictEqual(list2[0].code, "only", "③ 新集合内容正确");

  // 传空数组 = 清空
  store.setCreditPackages(id, "trae", []);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 传空数组应清空包集");

  // 非数组入参：不得抛，也不得残留旧包（producer 给 null 时整条刷新链路要能继续）
  store.setCreditPackages(id, "trae", [{ code: "k", name: "k", total: 1, used: 0, remaining: 1, expiresAt: 0 }]);
  store.setCreditPackages(id, "trae", null);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 非数组入参按空处理：不残留旧包、不抛");

  // 删号必须连带清包（防孤儿行）
  store.setCreditPackages(id, "trae", [{ code: "x", name: "x", total: 1, used: 0, remaining: 1, expiresAt: 0 }]);
  store.removeAccount(id);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 删号后包集应被清除");
  assert.strictEqual(store.listAllCreditPackages().get(id), undefined, "③ 删号后全量读里也不该再有这个账号");
  pass("③ store 整体替换：ord 排序 / -1 保留 / 负值归 0 / 换集不残留 / 空与非数组清空 / 删号清包");
}

// ===== ④ decoratePackageStates：时间态的边界 =====
{
  const T = 1700000000000; // 钉死时钟，断言与脚本运行时刻无关
  const st = (expiresAt, now) => pool.decoratePackageStates(
    [{ code: "c", name: "n", total: 10, used: 0, remaining: 10, expiresAt }], now)[0];

  const forever = st(0, T);
  assert.strictEqual(forever.expired, false, "④ expiresAt=0 是长期有效，不得判成已过期");
  assert.strictEqual(forever.expiringSoon, false, "④ expiresAt=0 不得判成即将到期（0 距 now 是个巨大负数）");

  assert.strictEqual(st(T - 1, T).expired, true, "④ 过期 1ms ⇒ expired");
  assert.strictEqual(st(T, T).expired, true, "④ 正好到此刻 ⇒ expired（<= 边界含等号）");
  assert.strictEqual(st(T + 1, T).expired, false, "④ 晚 1ms ⇒ 未过期");

  assert.strictEqual(st(T + DAY - 1, T).expiringSoon, true, "④ 窗口内差 1ms ⇒ expiringSoon");
  assert.strictEqual(st(T + DAY, T).expiringSoon, false, "④ 恰好一天 ⇒ 不算即将到期");
  assert.strictEqual(st(T + DAY + 1, T).expiringSoon, false, "④ 窗口外 ⇒ 不算即将到期");

  // 两态必须互斥：同时为真会让「已过期」和「即将到期」两个标记一起点亮
  for (const e of [0, T - DAY, T - 1, T, T + 1, T + DAY - 1, T + DAY, T + DAY + 1]) {
    const s = st(e, T);
    assert.ok(!(s.expired && s.expiringSoon), `④ 同一包不得既 expired 又 expiringSoon（expiresAt=${e}）`);
  }

  // 入参不得被改写：同一批包对象还会流向派生与导出，原地附加会让别处拿到脏对象
  const src = [{ code: "c", name: "n", total: 10, used: 0, remaining: 10, expiresAt: T + 5 * DAY }];
  const out = pool.decoratePackageStates(src, T);
  assert.strictEqual(src.expired, undefined, "④ 入参包对象不应被附上时间态");
  assert.notStrictEqual(out[0], src[0], "④ 出的是新对象");
  assert.strictEqual(out[0].code, "c", "④ 原有字段照常带出");

  assert.deepStrictEqual(pool.decoratePackageStates(undefined, T), [], "④ 非数组 ⇒ 空数组，不抛");
  pass("④ decoratePackageStates：长期(0)不误判 / 三处边界 / 两态互斥 / 不改入参 / 非数组→[]");
}

// ===== ⑤ listAllCreditPackages：一次全量分桶 == 逐账号读 =====
{
  const T = Date.now();
  const a1 = store.addAccount({ channel: "trae", uid: "u-all-1", name: "全量1", token: "tk", refreshToken: "", source: "paste" });
  const a2 = store.addAccount({ channel: "zcode", uid: "u-all-2", name: "全量2", token: "tk", refreshToken: "", source: "paste" });
  store.setCreditPackages(a1, "trae", [
    { code: "z", name: "z包", total: 3, used: 0, remaining: 3, expiresAt: T + 9 * DAY, ord: 2 },
    { code: "y", name: "y包", total: 2, used: 0, remaining: 2, expiresAt: T + 8 * DAY, ord: 1 },
  ]);
  store.setCreditPackages(a2, "zcode", [
    { code: "x", name: "x包", total: 1, used: 0, remaining: 1, expiresAt: T + 7 * DAY, ord: 0 },
  ]);

  const all = store.listAllCreditPackages();
  assert.deepStrictEqual(all.get(a1).map((p) => p.code), ["y", "z"],
    "⑤ 分桶内顺序与逐账号读一致（ord 升序，不靠 SQL 返回顺序碰巧）");
  assert.deepStrictEqual(all.get(a2).map((p) => p.code), ["x"], "⑤ 另一账号只出它自己的包（不串号）");
  assert.deepStrictEqual(all.get(a1), store.listCreditPackages(a1),
    "⑤ 全量读与逐账号读逐字段等价——两条路必须同口径，否则号池视图和账号详情会给出不同数字");
  assert.strictEqual(all.get("不存在的账号"), undefined, "⑤ 无包的账号不进 Map（调用方按 || [] 兜底）");
  assert.ok(!(all.get(a1) || []).some((p) => "accountId" in p), "⑤ accountId 只做分桶键，不漏进对外包对象");
  store.removeAccount(a1);
  store.removeAccount(a2);
  pass("⑤ listAllCreditPackages：一次全量按账号分桶，与逐账号读逐字段等价且顺序一致");
}

// ===== ⑥ 端到端一条链：落包 → 全量读 → 时间态 → 派生账号额度 =====
{
  const T = Date.now();
  const id = store.addAccount({ channel: "trae", uid: "u-e2e", name: "端到端", token: "tk", refreshToken: "", source: "paste" });
  store.setCreditPackages(id, "trae", [
    { code: "ok", name: "在用", total: 100, used: 40, remaining: 60, expiresAt: T + 3 * DAY, ord: 0 },
    { code: "dead", name: "已过期", total: 500, used: 0, remaining: 500, expiresAt: T - 2 * DAY, ord: 1 },
    { code: "soon", name: "快到期", total: 20, used: 0, remaining: 20, expiresAt: T + 0.5 * DAY, ord: 2 },
  ]);

  const decorated = pool.decoratePackageStates(store.listAllCreditPackages().get(id) || [], T);
  assert.deepStrictEqual(decorated.map((p) => p.code), ["ok", "dead", "soon"],
    "⑥ 出包顺序按 ord（0/1/2 = ok/dead/soon），不按到期日重排——日历的排序是展示层的事");
  assert.deepStrictEqual(
    decorated.map((p) => [p.expired, p.expiringSoon]),
    [[false, false], [true, false], [false, true]],
    "⑥ 三个包的时间态各归各位");

  const derived = pool.deriveAccountCredits(decorated, T);
  assert.strictEqual(derived.credits, 80, "⑥ 派生剩余只算未过期包（60+20，已过期的 500 不计）");
  assert.strictEqual(derived.expiresAt, T + 0.5 * DAY, "⑥ 最近到期就是那个即将到期的包");

  // 同一条库记录、隔 3 天再读必须自动改态——这是「时间态不落库」的直接收益
  store.setCreditPackages(id, "trae", [{ code: "tom", name: "明天看", total: 10, used: 0, remaining: 10, expiresAt: T + 2 * DAY, ord: 0 }]);
  assert.strictEqual(pool.decoratePackageStates(store.listCreditPackages(id), T)[0].expired, false,
    "⑥ 写入当天读：未过期");
  assert.strictEqual(pool.decoratePackageStates(store.listCreditPackages(id), T + 3 * DAY)[0].expired, true,
    "⑥ 同一记录三天后再读：已过期（若把 expired 落库，这里会永远停在写入那天的 false）");
  store.removeAccount(id);
  pass("⑥ 端到端：落包→全量读→时间态→派生 80/3天，且同记录隔 3 天重读自动改态");
}

// ===== ⑦ 同步往返：包集随快照走，且只在 creditsAt 更新时才被盖 =====
{
  const psync = require(path.join(ROOT, "electron", "backend", "proxy", "poolsync.cjs"));
  const T = Date.now();
  const uid = "u-sync";
  const mk = (code, rem, days) => ({ code, name: code, total: rem, used: 0, remaining: rem, expiresAt: T + days * DAY });

  const src = store.addAccount({ channel: "trae", uid, name: "同步源", token: "tk", refreshToken: "", source: "paste" });
  store.updateAccount(src, { creditsAt: T, credits: 130 });
  store.setCreditPackages(src, "trae", [mk("s1", 100, 6), mk("s2", 30, 20)]);
  const snap = psync.exportPool("trae");
  const snapAcc = snap.accounts.find((a) => a.uid === uid);
  assert.deepStrictEqual((snapAcc.packages || []).map((p) => p.code), ["s1", "s2"],
    "⑦ 导出必须带包集（不带的话对端拿到的是「有余额、无日历」的半号，而且看不出来）");

  // 本机整号缺失 → 走「新增」分支：连包集一起收
  store.removeAccount(src);
  assert.deepStrictEqual(store.listCreditPackages(src), [], "⑦ 前置：删号后本机无包");
  const r1 = psync.mergeSnapshot(snap, "trae");
  assert.strictEqual(r1.added, 1, "⑦ 前置：本机无同身份账号，应走新增分支");
  const reborn = store.listAccounts().find((a) => a.uid === uid);
  assert.ok(reborn, "⑦ 新增分支应把账号入池");
  assert.deepStrictEqual(store.listCreditPackages(reborn.id).map((p) => p.code), ["s1", "s2"],
    "⑦ 新增分支必须同时写入包集（漏了就只有账号没有日历）");

  // 本机已有同身份账号、且本机 creditsAt 更新 → 远端那份更旧的包集不得盖掉本机
  store.setCreditPackages(reborn.id, "trae", [mk("local-newer", 7, 3)]);
  store.updateAccount(reborn.id, { creditsAt: T + 2 * DAY });
  psync.mergeSnapshot(snap, "trae");
  assert.deepStrictEqual(store.listCreditPackages(reborn.id).map((p) => p.code), ["local-newer"],
    "⑦ 远端 creditsAt 更旧时包集必须保持本机版本（写在这门外就是「旧快照倒灌」）");

  // 本机 creditsAt 更旧 → 远端包集整体替换本机
  store.updateAccount(reborn.id, { creditsAt: T - 2 * DAY });
  psync.mergeSnapshot(snap, "trae");
  assert.deepStrictEqual(store.listCreditPackages(reborn.id).map((p) => p.code), ["s1", "s2"],
    "⑦ 远端 creditsAt 更新时以远端包集整体替换（不是叠加：本机那个 local-newer 必须消失）");

  // 快照里没有 packages 字段（对端是旧版本）→ 本机包集原样保留，不得被清成空
  const legacySnap = {
    ...snap,
    accounts: snap.accounts.map((a) => {
      if (a.uid !== uid) return a;
      const copy = { ...a, updatedAt: Date.now() + 9 * DAY, creditsAt: Date.now() + 9 * DAY };
      delete copy.packages; // 旧版本对端根本不认识这个字段
      return copy;
    }),
  };
  assert.strictEqual(legacySnap.accounts.find((a) => a.uid === uid).packages, undefined,
    "⑦ 前置：这份快照确实没有 packages");
  psync.mergeSnapshot(legacySnap, "trae");
  assert.deepStrictEqual(store.listCreditPackages(reborn.id).map((p) => p.code), ["s1", "s2"],
    "⑦ 对端旧版本快照不带 packages 时，本机包集不得被清掉（缺字段 ≠ 清空指令）");

  store.removeAccount(reborn.id);
  pass("⑦ 同步往返：导出带包集 / 新增分支同写 / 更旧不倒灌 / 更新整体替换 / 缺字段不清空");
}

// ===== ⑧ 静态接线（不联网、不开真库网关） =====
{
  const read = (f) => fs.readFileSync(path.join(ROOT, "electron", "backend", "proxy", f), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS credit_packages/.test(read("store.cjs")),
    "⑧ store.cjs 必须建 credit_packages 表（不建表则首次 setCreditPackages 就炸）");

  const cred = read("credits.cjs");
  assert.ok(/setCreditPackages/.test(cred) && /deriveAccountCredits/.test(cred),
    "⑧ credits.cjs 刷新链路必须落包集并用 deriveAccountCredits 派生（否则包集永远不写、账号额度与逐包不同源）");

  // trae「包集要不要交出去」这个守卫：不限量账号的 credits 是 -1，守卫若还写在 credits>0 上，
  // 刚解析出来的包会在 return 前被整个丢掉。它在 queryCredits 的 HTTP 流程里，运行时测不到，
  // 只能钉字面——判据落到 return t 这一行自己的条件上，不匹「文件里有没有 packages.length」。
  const traeGuard = (read("management-adapters.cjs").match(/^[ \t]*if \(([^\r\n]*)\)[ \t]*\r?\n[ \t]*return t;[ \t]*$/m) || ["(找不到 trae 的 return t 守卫)"])[0];
  assert.ok(/packages\.length/.test(traeGuard),
    `⑧ trae 交出包集的守卫必须看 packages.length（credits>0 会把不限量号吞掉）（实测: ${traeGuard.trim()}）`);

  // poolView 的包集来源必须是「一次全量读」，不是逐账号查。
  // 只 grep 文件里有没有 listAllCreditPackages 是抓不住的：把下面这行换回逐账号查，
  // 全量读那行仍然留在文件里，正则照样过——判据必须落到 packages: 这一行本身。
  const idx = read("index.cjs");
  const pkgLine = (idx.match(/^[ \t]*packages:[^\r\n]*/m) || ["(找不到 packages: 这一行)"])[0];
  assert.ok(/decoratePackageStates\(/.test(pkgLine), `⑧ poolView 的 packages: 必须过 decoratePackageStates 附时间态（实测: ${pkgLine.trim()}）`);
  assert.ok(!/store\.listCreditPackages\(/.test(pkgLine), `⑧ poolView 不得逐账号查包（N+1）（实测: ${pkgLine.trim()}）`);
  assert.ok(/listAllCreditPackages\(\)/.test(idx), "⑧ poolView 必须先做一次全量读，否则分桶 Map 没有来源");

  // 导出面：漏一个导出不是构建期错误，是运行期 undefined is not a function
  // 判据写成「模块 → 该模块必须露出的函数名」一张表，条数由表自己算——
  // 手写「N 个导出齐全」这句话在加一行断言后就会说谎，而它说谎时测试照样是绿的
  const psync = require(path.join(ROOT, "electron", "backend", "proxy", "poolsync.cjs"));
  const EXPORTS = [
    ["store", store, ["setCreditPackages", "listCreditPackages", "listAllCreditPackages"]],
    ["pool", pool, ["deriveAccountCredits", "decoratePackageStates", "setExpiringSoonDays", "expiringSoonMs"]],
    ["util", util, ["normalizeExpiryMs"]],
    // 后两个是 ⑦ 的入口；漏导出的话 ⑦ 只会以 TypeError 崩，红得不指向任何一条判据
    ["poolsync", psync, ["exportPool", "mergeSnapshot"]],
  ];
  let exportCount = 0;
  for (const [mod, obj, names] of EXPORTS)
    for (const fn of names) {
      assert.strictEqual(typeof obj[fn], "function", `⑧ ${mod} 必须导出 ${fn}`);
      exportCount++;
    }
  // 阈值这条链的两个接线点，缺一处就是「设置页改了没用」：
  //  · index.cjs 出视图前必须把设置灌进 pool（否则 expiringSoonDays 永远是模块默认值）
  //  · 设置页的钳制必须用 Number.isFinite 而不是 ||，否则用户填 0（=关闭预警）会被跳回默认
  assert.ok(/setExpiringSoonDays\(settings\(\)\.expiringSoonDays\)/.test(idx),
    "⑧ poolView 必须每次把 settings().expiringSoonDays 灌进 pool（漏了就是改了设置不生效）");
  const vue = fs.readFileSync(path.join(ROOT, "src", "components", "config", "ConfigProxySection.vue"), "utf8");
  const clampLine = (vue.match(/^[^\n]*expiringSoonDays = Math\.min[^\n]*/m) || ["(找不到设置页的钳制行)"])[0];
  assert.ok(/Number\.isFinite/.test(clampLine),
    `⑧ 设置页对 expiringSoonDays 的钳制必须走 Number.isFinite（实测: ${clampLine.trim().slice(0, 110)}）——用 || 会把合法的 0 跳回默认`);

  pass(`⑧ 静态接线：建表 / 刷新链路落包并派生 / packages: 行走全量读+时间态 / 阈值两处接线 / ${exportCount} 个导出齐全`);
}

// ===== ⑨ 阈值可配：账号级徽标与逐包共用同一个值，且默认值等于改动前那个硬编码 =====
{
  const T = 1700000000000;
  const soonAt = (days, now) => pool.decoratePackageStates(
    [{ code: "c", name: "n", total: 10, used: 0, remaining: 10, expiresAt: now + days * DAY }], now)[0].expiringSoon;

  // 默认必须仍是 1 天：本条 PR 不改任何人的现有观感，只是把这个数变成可调
  assert.strictEqual(pool.expiringSoonMs(), DAY, "⑨ 默认阈值必须等于改动前 poolSummary 里硬编码的 86400000");
  assert.strictEqual(soonAt(0.5, T), true, "⑨ 默认 1 天：半天内到期 ⇒ 即将到期");
  assert.strictEqual(soonAt(1.5, T), false, "⑨ 默认 1 天：1.5 天不算（改动前就是这个口径）");

  pool.setExpiringSoonDays(7);
  assert.strictEqual(pool.expiringSoonMs(), 7 * DAY, "⑨ setter 生效");
  assert.strictEqual(soonAt(1.5, T), true, "⑨ 调到 7 天后，同一个包翻成即将到期（逐包侧吃到新阈值）");

  // 账号级徽标必须跟同一个旋钮：两处不同值就会出现「号池卡片说不到期、日历说快到期」
  const acc = store.addAccount({ channel: "trae", uid: "u-thr", name: "阈值账号", token: "tk", refreshToken: "", source: "paste", expiresAt: Date.now() + 3 * DAY });
  assert.strictEqual(pool.poolSummary("trae").expiringSoon, true,
    "⑨ 阈值 7 天时，3 天后到期的账号级徽标必须一起亮（两处共用 expiringSoonMs 的证明）");
  pool.setExpiringSoonDays(1);
  assert.strictEqual(pool.poolSummary("trae").expiringSoon, false,
    "⑨ 阈值收回 1 天，账号级徽标同步熄灭——不是只有逐包那侧跟着变");

  // 非法输入：保留现值，不崩、也不写进荒谬值（半天或 9999 年都不会是用户想要的）
  // null 与 "" 单独点名：Number(null)===Number("")===0，一把梭的 Number() 会把它们
  // 当成「用户主动关闭预警」，于是缺字段或清空输入框就静默关掉了预警
  for (const bad of ["abc", NaN, -1, 99999, undefined, null, "", "   ", true, false, {}, []]) {
    pool.setExpiringSoonDays(bad);
    assert.strictEqual(pool.expiringSoonMs(), DAY, `⑨ 非法阈值 ${JSON.stringify(bad)} 必须被忽略而不是改写现值`);
  }
  pool.setExpiringSoonDays("7");
  assert.strictEqual(pool.expiringSoonMs(), 7 * DAY, "⑨ 数字串照收（IPC 传字符串的情况）");
  pool.setExpiringSoonDays(1);
  pool.setExpiringSoonDays(0);
  assert.strictEqual(pool.expiringSoonMs(), 0, "⑨ 0 合法：关闭预警");
  assert.strictEqual(soonAt(0.5, T), false, "⑨ 阈值为 0 时任何包都不算即将到期");
  pool.setExpiringSoonDays(1); // 复原，别让本节的模块状态泄漏给后面的判据
  store.removeAccount(acc);
  pass("⑨ 阈值可配：默认=原硬编码 / 逐包与账号级共用同一旋钮 / 非法值忽略 / 0=关闭 / 状态复原");
}

// ===== ⑩ 五个渠道的逐包映射 =====
// 夹具是按「适配器代码读哪些键」造的**合成**样本，不是抓包响应。因此本节证明的是
// 「给定这些键，包行算得对」（口径、单位、哨兵、兜底），不证明「上游真的返回这些键」——
// 后者要靠真账号验，本闸做不到，也不假装做得到。
{
  const adapters = require(path.join(ROOT, "electron", "backend", "proxy", "management-adapters.cjs"));
  const SEC = Math.floor((Date.now() + 20 * DAY) / 1000);

  // —— Trae：remaining = limit - used；秒级到期换算成毫秒；不限量包不再丢弃 ——
  const tr = adapters.traeCredits([
    { entitlement_pack_id: "A", display_desc: "月包", end_time: SEC, quota: { credits_limit: 100, credits_amount: 30 } },
    { entitlement_pack_id: "B", display_desc: "用完了", end_time: SEC, quota: { credits_limit: 50, credits_amount: 50 } },
    { entitlement_pack_id: "Z", display_desc: "无面值", quota: { credits_limit: 0 } },
  ]);
  assert.deepStrictEqual(tr.packages.map((p) => p.code), ["A", "B"], "⑩ Trae：只认「有面值」的包（credits_limit 缺字段或为 0 = 不属于该号）");
  assert.strictEqual(tr.packages[0].remaining, 70, "⑩ Trae：剩余 = limit - used");
  assert.strictEqual(tr.packages[0].total, 100, "⑩ Trae：面值取 credits_limit");
  assert.strictEqual(tr.packages[0].name, "月包", "⑩ Trae：包名取 display_desc");
  assert.strictEqual(tr.packages[1].remaining, 0, "⑩ Trae：用完的包剩余 0 但仍出一行（日历要看得见它的到期）");
  assert.ok(Math.abs(tr.packages[0].expiresAt - SEC * 1000) < 2000, "⑩ Trae：秒级 end_time 要换成毫秒（落库与比较都用毫秒）");
  assert.strictEqual(tr.credits, 70, "⑩ Trae：账号级 credits = Σ 包剩余（无限时才是哨兵）");

  // 不限量包：credits_limit < 0 是上游「不限」哨兵，旧判据 `limit <= 0` 把它整条丢掉
  const tu = adapters.traeCredits([
    { entitlement_pack_id: "U", display_desc: "不限量包", end_time: SEC, quota: { credits_limit: -1, credits_amount: 0 } },
    { entitlement_pack_id: "V", display_desc: "普通包", end_time: SEC, quota: { credits_limit: 100, credits_amount: 40 } },
  ]);
  assert.deepStrictEqual(tu.packages.map((p) => p.code), ["U", "V"],
    "⑩ Trae：credits_limit<0 的不限量包必须出包——旧判据连它那一行日历和它的到期一起吞掉");
  assert.strictEqual(tu.packages[0].remaining, -1, "⑩ Trae：不限量包剩余落 -1（deriveAccountCredits 认的「不限」判据）");
  assert.strictEqual(tu.packages[0].total, -1, "⑩ Trae：不限量包没有面值，total 同落 -1");
  assert.strictEqual(tu.credits, -1, "⑩ Trae：任一包不限 ⇒ 账号级落 -1，不是把 -1 当欠款加进 60");
  assert.ok(tu.expiresAt > 0, "⑩ Trae：不限量包的到期照样参与最近到期折叠");
  // 同一批包换个顺序：不限量包排在**最后**。上面那条夹具里 -1 恰好是第一个包，
  // 「把 -1 当欠款加进和里」会凑出 -1 蒙对；这条把巧合堵掉。
  const tu2 = adapters.traeCredits([
    { entitlement_pack_id: "V2", display_desc: "普通包", end_time: SEC, quota: { credits_limit: 100, credits_amount: 40 } },
    { entitlement_pack_id: "U2", display_desc: "不限量包", end_time: SEC, quota: { credits_limit: -1, credits_amount: 0 } },
  ]);
  assert.strictEqual(tu2.credits, -1,
    "⑩ Trae：不限量包排在最后也要把整号折成 -1（它在首位时，把 -1 当欠款加进去凑巧也得到 -1，抓不住漏赋值）");

  // 两处余额口径同数：适配器自己那份 fold 与 credits.cjs 落库用的 pool.deriveAccountCredits。
  // 两个公式各写一遍、都往 acc.credits 方向走，不同数就等于「同一个号两个余额」。
  assert.strictEqual(pool.deriveAccountCredits(tr.packages).credits, tr.credits,
    "⑩ Trae：没有过期包时，适配器 fold 与派生层必须给同一个数");
  assert.strictEqual(pool.deriveAccountCredits(tu2.packages).credits, tu2.credits,
    "⑩ Trae：不限量时两处也要同数（都落 -1，不能一处 -1 一处 59）");

  // 三条过滤（隐藏 / 已取消 / 兑换码包）+ 「没有那层嵌套就不误伤」
  const tf = adapters.traeCredits([
    { entitlement_pack_id: "H", entitlement_base_info: { is_hide: true }, quota: { credits_limit: 100 } },
    { entitlement_pack_id: "C", entitlement_base_info: { status: 3 }, quota: { credits_limit: 100 } },
    { entitlement_pack_id: "P", entitlement_base_info: { product_type: 3 }, quota: { credits_limit: 100 } },
    { entitlement_pack_id: "OK", entitlement_base_info: { status: 1, product_type: 1, is_hide: false }, quota: { credits_limit: 100, credits_amount: 10 } },
    { entitlement_pack_id: "NOBASE", quota: { credits_limit: 100, credits_amount: 10 } },
  ]);
  assert.deepStrictEqual(tf.packages.map((p) => p.code), ["OK", "NOBASE"],
    "⑩ Trae：隐藏/已取消/兑换码三种包被滤掉；老响应没有 entitlement_base_info 这层时照常出包（不误伤）");
  assert.strictEqual(tf.credits, 180, "⑩ Trae：只有过滤后剩下的包才进账号级余额");

  // 到期归一：远未来哨兵 → 长期(0)；纯日期串 → 当天末尾（不再用裸 toMs）
  const tfar = adapters.traeCredits([{ entitlement_pack_id: "F", quota: { credits_limit: 100, credits_amount: 0 }, end_time: "9999-12-31" }]).packages[0];
  assert.strictEqual(tfar.expiresAt, 0, "⑩ Trae：远未来到期归一为 0（长期）——不归一会在日历排出一行「还剩几万年」");
  const tdate = adapters.traeCredits([{ entitlement_pack_id: "D", quota: { credits_limit: 100, credits_amount: 0 }, end_time: "2030-01-15" }]).packages[0];
  assert.ok(tdate.expiresAt > Date.UTC(2030, 0, 14) && tdate.expiresAt < Date.UTC(2030, 0, 17),
    `⑩ Trae：纯日期串按当天末尾理解（实测 ${new Date(tdate.expiresAt).toISOString()}），不当 0 丢掉`);

  // —— zcode：三种剩余字段口径 + 欠额负值必须夹 0 + plan 名 join ——
  const zp = adapters.zcodeCreditPackages([
    { plan_id: "p1", total_units: 1000, used_units: 400 },              // 缺 remaining → 退 total-used
    { plan_id: "p2", remaining_units: 50 },
    { plan_id: "p3", available_units: 60 },
    { plan_id: "p4", remaining_units: -1 },                              // 欠额 -1：绝不能当「不限」
    null,
  ], [{ plan_id: "p1", name: "专业版年度" }]);
  assert.strictEqual(zp.length, 4, "⑩ zcode：非对象条目被滤掉，其余四条都在");
  assert.strictEqual(zp[0].remaining, 600, "⑩ zcode：缺 remaining_units 时退回 total-used，不读成 0");
  assert.strictEqual(zp[0].name, "专业版年度", "⑩ zcode：包名从 plans 按 plan_id join 过来");
  assert.strictEqual(zp[1].remaining, 50, "⑩ zcode：remaining_units 直接取");
  assert.strictEqual(zp[2].remaining, 60, "⑩ zcode：available_units 也认");
  assert.strictEqual(zp[3].remaining, 0, "⑩ zcode：欠额的 -1 必须夹成 0——-1 是「不限」哨兵，透下去整号变无限");

  // —— Lobster：上游不给逐包面值 ⇒ total=-1；ISO 与空格形式到期；远未来哨兵归 0 ——
  const lp = adapters.lobsterCreditPackages([
    { type: "MONTHLY", label: "月度积分", creditsRemaining: 5297, expiresAt: "2027-01-01T00:00:00Z" },
    { type: "GIFT", creditsRemaining: -3, expiresAt: "2099-01-01 00:00:00" },
    { type: "BAD", creditsRemaining: "abc" },
  ]);
  assert.strictEqual(lp.length, 2, "⑩ Lobster：剩余读不出数字的那条滤掉（不能当 0 上屏）");
  assert.strictEqual(lp[0].total, -1, "⑩ Lobster：上游不下发逐包面值 ⇒ total=-1=「不给总额」（渲染「—」），不是额度不限");
  assert.ok(lp[0].expiresAt > Date.now(), "⑩ Lobster：ISO 字符串到期要能被解析成未来毫秒");
  assert.strictEqual(lp[1].remaining, 0, "⑩ Lobster：欠额负剩余夹 0（同 zcode 的哨兵理由）");
  assert.strictEqual(lp[1].expiresAt, 0, "⑩ Lobster：2099 这类远未来占位归 0=长期有效，且空格形式日期串得能认");
  assert.deepStrictEqual(adapters.lobsterCreditPackages(undefined), [], "⑩ Lobster：非数组 ⇒ []（调用方回落账号级聚合行）");

  // —— WorkBuddy：Accounts 循环里的 r/u/s 此前只在 return 被折成标量，现在逐包带出 ——
  const wb = adapters.parseWbResource({
    Accounts: [
      { PackageCode: "pk1", PackageName: "算力包一", CapacitySize: 300, CapacityUsed: 100, CapacityRemain: 200, PackageEndTime: Date.now() + 9 * DAY },
      { PackageCode: "pk2", CycleCapacitySize: 50, CycleCapacityRemain: 50, CycleEndTime: Date.now() + 3 * DAY },
    ],
  }, false);
  assert.strictEqual(wb.credits, 250, "⑩ WorkBuddy：账号级剩余口径不变（200+50）");
  assert.deepStrictEqual(wb.packages.map((p) => p.code), ["pk1", "pk2"], "⑩ WorkBuddy：每个 Account 出一条包行");
  assert.strictEqual(wb.packages[0].remaining, 200, "⑩ WorkBuddy：单包剩余沿用循环里已算出的 r");
  assert.strictEqual(wb.packages[0].total, 300, "⑩ WorkBuddy：单包面值沿用循环里已算出的 s（此前被丢弃）");
  assert.strictEqual(wb.packages[1].total, 50, "⑩ WorkBuddy：Cycle 期套餐走 CycleCapacity* 那一套字段");
  assert.strictEqual(wb.packages[1].remaining, 50, "⑩ WorkBuddy：Cycle 期套餐走 CycleCapacity* 那一套字段（剩余）");
  assert.ok(Math.abs(wb.packages[1].expiresAt - (Date.now() + 3 * DAY)) < 5000,
    "⑩ WorkBuddy：包行到期取自 CycleEndTime（不是 PackageEndTime）");
  assert.strictEqual(adapters.parseWbResource({ Accounts: [] }, false), null, "⑩ WorkBuddy：空 Accounts 仍返回 null（不改现有语义）");

  // —— Qoder：四族额度；组织族总额字段是 cap 不是 total；只有专用包自带 ISO 到期 ——
  // 到期基准必须先存成变量再同时喂给夹具和断言：两边各写一次 Date.now()+40*DAY 的话，
  // 跨过 1ms 边界就会红，而且红的是这条无关断言——它会偷走别的作用域的变异归属。
  const PLAN_EXP = Date.now() + 40 * DAY;
  const { makeQoder } = require(path.join(ROOT, "electron", "backend", "proxy", "qoderAdapter.cjs"));
  const qRows = makeQoder("qoder", { rules: new Map(), util }).__creditPackagesForTest(
    {
      userQuota: { remaining: 100, total: 500, used: 400 },
      addOnQuota: { remaining: 30 },
      orgResourcePackage: { cap: 80, used: 20, remaining: -5 },
      dedicatedResourcePackages: [
        { id: "d1", displayLabels: [{ title: "活动包" }], total: 10, remaining: 4, used: 6, expiresAt: "2027-03-01T00:00:00Z" },
        { id: "d2", available: false, total: 9, remaining: 9 },
      ],
    },
    PLAN_EXP,
    (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  );
  assert.deepStrictEqual(qRows.map((r) => r.name), ["套餐额度", "资源包", "组织资源包", "活动包"],
    "⑩ Qoder：四族各成一行，不可用的专用包(d2)被排除");
  assert.strictEqual(qRows[0].expiresAt, PLAN_EXP, "⑩ Qoder：顶层套餐到期只挂「套餐额度」那行");
  assert.strictEqual(qRows[1].expiresAt, 0, "⑩ Qoder：资源包上游不给到期 ⇒ 0=长期，不编日期");
  assert.strictEqual(qRows[2].total, 80, "⑩ Qoder：组织资源包总额字段是 cap；按 total 读会得到 0=已用完");
  assert.strictEqual(qRows[2].remaining, 0, "⑩ Qoder：欠额的负剩余必须夹 0（-1 是「不限」哨兵，透下去整号变无限）");
  assert.strictEqual(qRows[1].total, -1, "⑩ Qoder：既无 total 也无 cap ⇒ -1=「不给总额」");
  assert.ok(qRows[3].expiresAt > Date.now(), "⑩ Qoder：专用包的 ISO 到期必须被解析（用只认数字的 num() 会得到 NaN→0，到期静默消失）");
  assert.strictEqual(qRows[3].name, "活动包", "⑩ Qoder：包名取 displayLabels[].title（name/description 里是内部 campaign id）");
  pass("⑩ 五渠道逐包映射：面值/剩余/单位换算/负值夹 0/-1 两种含义/到期归属/字段兜底");
}

// ===== ⑪ 复活链路（唯一要 await 的一节 ⇒ 整闸的收尾挂在它下面，它不跑完就不会印 OK） =====
// 为什么这条必须真跑 refreshAccount 而不是静态正则：`credits === -1` 的豁免一旦接错变量
// （接成适配器原始的 r.credits 而不是派生后的 credits），源码里那行字面照样在、正则照样绿，
// 而线上「无限额度的号被误标 exhausted 后永远刷不回来」照样发生。
(async () => {
  const adapters = require(path.join(ROOT, "electron", "backend", "proxy", "management-adapters.cjs"));
  const credits = require(path.join(ROOT, "electron", "backend", "proxy", "credits.cjs"));
  const realGet = adapters.get;
  adapters.get = () => ({
    refreshWindowSec: 1,
    // 一个「不限量包」：上游给不出数值余额，包集里 remaining=-1
    queryCredits: async () => ({
      credits: 0, expiresAt: 0,
      packages: [{ code: "u", name: "不限量包", total: -1, used: 0, remaining: -1, expiresAt: 0 }],
    }),
  });
  try {
    const id = store.addAccount({ channel: "trae", uid: "u-revive", name: "被误标的无限号", token: "tk", refreshToken: "", source: "paste" });
    store.updateAccount(id, { status: "exhausted", credits: 0 });
    await credits.refreshAccount(id);
    const after = store.getAccount(id);
    assert.strictEqual(Number(after.credits), -1,
      "⑪ 包集里有 remaining=-1 ⇒ 落库余额必须是 -1（不限），不是 0");
    assert.strictEqual(after.status, "online",
      "⑪ 无限额度的号被误标 exhausted 后，额度刷新必须把它复活（revive 判据漏掉 credits===-1 就永远刷不回来）");

    // 派生出「长期/无到期」(0) 必须直接落库，不得回填旧的账号级到期：
    // 混合包场景（有限包过期 + 不限量包在库）下，回填会让 pickAccount 的
    // 「余额已到期」把不限量号永久标死，跟上面的复活判据打乒乓。
    // 这条必须是运行时判据：`fromPackages ? expiresAt : …` 若退回 `expiresAt || cur.expires_at`，
    // 字面改动极小、静态正则抓不住，只有真跑 store.updateAccount 才能钉住。
    store.updateAccount(id, { expiresAt: Date.now() - 3 * 86400000 }); // 库里留一个已过期的旧到期
    await credits.refreshAccount(id);
    const after2 = store.getAccount(id);
    assert.strictEqual(Number(after2.expires_at), 0,
      "⑪ 包集派生 expiresAt=0（长期/无在用到期）必须如实落 0，不得回填库里旧的过期值");
  } finally {
    adapters.get = realGet;
  }
  pass("⑪ 复活链路：stub 适配器走完整 refreshAccount（-1 余额落库 + exhausted→online + 派生 0 不回填旧到期）");
})().then(() => {
  store.close();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
  console.log(`\nOK 积分包到期数据层闸全过（${n} 项）`);
}, (e) => {
  console.error(`\nFAIL ⑪ ${String((e && e.message) || e)}`);
  process.exitCode = 1;
});
