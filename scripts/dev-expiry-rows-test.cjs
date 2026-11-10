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
// 积分日历页行过滤/排序闸：钉住「默认隐藏已用完」「-1 不限不被当 0」「过期行不被误删」。
//
// 起因（2026-09-29）：用户反馈 0/100 这类已用完的包仍占着列表，且显示「剩 176 天」是纯噪音；
// 这类缺陷 vue-tsc 与原有 node 门禁全看不见——过滤逻辑写在 computed 里，只有运行时才算得出来。
// 所以把过滤/排序抽到 src/views/proxy/expiryRows.ts（纯函数），本脚本转译后直接断言。
//
// 2026-10-12 起还钉住三件事（都是同一页的产品口径，写错不会编译失败也不会测试失败）：
//   G/H 过期满 STALE_EXPIRED_DAYS 天的行退出默认档、且只在「历史过期积分」档回来（收起≠删除）；
//   I   上游不拆包的渠道按账号出聚合行（从未刷过额度的账号不得混进来）；
//   J   total=-1 是「上游不给总额」不是「不限」——两者混同会把 1,880 积分写成「1,880 / 不限」。
// 2026-10-13 起再加四节（新增「泳道时间轴」与「见底曲线」两个呈现档）：
//   L   泳道合并粒度（渠道×包名×面值）、远期桶、点大小只在渠道内归一、不丢包；
//   M   时间轴的源码接线钉——含「它是纯 DOM，没把 echarts 注册表撑大」这条；
//   N   见底曲线的台阶语义（台阶数=唯一到期日数、今天取值、腰斩/见底、不限不画假曲线）；
//   O   见底曲线的源码接线钉（三档独立可切、台阶路径单一出口、非等比 viewBox 配 non-scaling-stroke）。
// 本闸加载三份 TS 模块（expiryRows、format、expiryLanes），加载器必须 bundle 且每次换临时文件名。
//
// 跑法：node scripts/dev-expiry-rows-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TS = "src/views/proxy/expiryRows.ts";
const VIEW = "src/views/proxy/ProxyExpiryView.vue";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

/** 转译并加载 TS 纯函数模块（类型导入被 esbuild 抹掉，不会触发运行时 require）。
 *  必须 bundle 而不是 transform：src/views/proxy/format.ts 转出 `export { fmtCtx } from
 *  "../../utils/format"`，裸 transform 会把这条相对依赖原样留在产物里，从临时目录 require 必炸。
 *  临时文件名必须每次唯一：require 按路径缓存，复用同一个路径会让第二次加载直接拿到第一个模块
 *  （本闸加载 expiryRows 与 format 两份，写死路径时 format 的导出会静默变成 expiryRows 的） */
let loadSeq = 0;
function loadModule(rel) {
  const { outputFiles: [{ text: code }] } = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    write: false,
  });
  const tmp = path.join(os.tmpdir(), `expiry-rows-${process.pid}-${loadSeq++}.cjs`);
  fs.writeFileSync(tmp, code);
  try {
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

const DAY = 86400000;
const NOW = Date.now();
const FUTURE = NOW + 30 * DAY;
const PAST = NOW - DAY;

/** 造行：pkg 字段全部显式给，避免「漏字段」把断言喂成假绿 */
function row(channelId, display, account, pkg) {
  return { key: `${channelId}:${account}:${pkg.code}`, channelId, channelDisplay: display, accountName: account, pkg };
}
function pkg(code, remaining, total, expiresAt, extra = {}) {
  return { code, name: code, total, used: total - remaining, remaining, expiresAt, ...extra };
}

const ROWS = [
  // 生效中且有余额
  row("workbuddy_ai", "WorkBuddy AI", "peakjjbb", pkg("a", 100, 100, FUTURE)),
  // 已用完（剩余 0）——默认档必须滤掉
  row("workbuddy_ai", "WorkBuddy AI", "peakjjbb", pkg("b", 0, 100, FUTURE)),
  // 生效中、有余额（截图里的 99/500）
  row("workbuddy_ai", "WorkBuddy AI", "codejjbb", pkg("c", 99, 500, FUTURE)),
  // 已过期且剩余 0 —— 也滤掉（与「剩余 0 隐藏」一致）
  row("trae", "Trae SOLO CN", "t1", pkg("d", 0, 5, PAST, { expired: true })),
  // 不限额度（-1 哨兵）+ 长期有效 —— 绝不能当 0 滤掉
  row("trae", "Trae SOLO CN", "t1", pkg("e", -1, -1, 0)),
  // 已过期但仍有余额 —— 用户要保留过期行，这条必须在默认档里活下来
  row("workbuddy", "WorkBuddy CN", "w1", pkg("f", 2, 5, PAST, { expired: true })),
];
const ROWS_BY = (out) => out.map((r) => r.pkg.code).join(",");

function main() {
  const m = loadModule(TS);
  const {
    applyExpiryFilter, isUsedUp, statusOf, countByState, STATUS_OPTIONS, SORT_OPTIONS,
    isStaleExpired, expiredDays, STALE_EXPIRED_DAYS, aggregateRow, AGGREGATE_PKG_NAME,
  } = m;
  const filter = (o) => applyExpiryFilter(ROWS, { status: "usable", channelId: "all", sort: "expiryAsc", ...o });

  // ===== A. 哨兵与状态归类 =====
  check("① 剩余 0 = 已用完；剩余 -1（不限）不算已用完", isUsedUp(ROWS[1].pkg) && !isUsedUp(ROWS[4].pkg) && !isUsedUp(ROWS[5].pkg));
  check("② 状态归类：0/100 → 已用完", statusOf(ROWS[1].pkg) === "used");
  check("③ 过期优先于用完：过期且 0 余额 → 已过期（不是已用完）", statusOf(ROWS[3].pkg) === "expired");
  check("④ 不限 + 长期有效 → 生效中", statusOf(ROWS[4].pkg) === "ok");
  check("⑤ 四态计数与总数对得上", (() => {
    const c = countByState(ROWS);
    return c.expired === 2 && c.used === 1 && c.ok === 3 && c.soon === 0 && c.total === 6;
  })(), JSON.stringify(countByState(ROWS)));

  // ===== B. 默认档「有余额」：这正是用户要的「隐藏已用完」 =====
  const usable = filter({});
  check("⑥ 默认档滤掉 0/100 与过期 0/5（实得 " + ROWS_BY(usable) + "）", ROWS_BY(usable) === "f,a,c,e", ROWS_BY(usable));
  check("⑦ 默认档保留 -1 不限与 99/500", usable.some((r) => r.pkg.code === "e") && usable.some((r) => r.pkg.code === "c"));
  check("⑧ 默认档保留「已过期但仍有余额」的行（过期行不是用完行）", usable.some((r) => r.pkg.code === "f"));
  // 反向对照：不是恒等过滤 —— 切「全部」必须比默认档多，否则本闸自己就是空转
  const all = filter({ status: "all" });
  check(`⑨ 反向对照：全部 ${all.length} 行 > 默认档 ${usable.length} 行（证明过滤真的生效）`, all.length === 6 && usable.length === 4);

  // ===== C. 其余筛选档 =====
  check("⑩ 已用完档只留 0/100", ROWS_BY(filter({ status: "used" })) === "b");
  check("⑪ 已过期档留两条过期行（含仍有余额的 f）", ROWS_BY(filter({ status: "expired" })) === "f,d");
  check("⑫ 渠道过滤：trae 只剩 d/e", ROWS_BY(filter({ status: "all", channelId: "trae" })) === "d,e");
  check("⑬ 组合：已过期 + trae 只剩 d", ROWS_BY(filter({ status: "expired", channelId: "trae" })) === "d");
  check("⑭ 无匹配返回空数组（不是 null）", Array.isArray(filter({ status: "soon" })) && filter({ status: "soon" }).length === 0);

  // ===== D. 排序（用全量 6 行：f/d 同过期、a/c/b 同到期、e 长期，能同时验两个关键字） =====
  // 同关键字一律按剩余降序，所以 f(2) 在 d(0) 前、a(100) 在 c(99) 在 b(0) 前
  check("⑮ 到期升序：过期行最前，长期（0）排最后（实得 " + ROWS_BY(filter({ status: "all" })) + "）",
    ROWS_BY(filter({ status: "all" })) === "f,d,a,c,b,e");
  check("⑯ 到期降序：长期排最前，同到期仍按剩余降序（实得 " + ROWS_BY(filter({ status: "all", sort: "expiryDesc" })) + "）",
    ROWS_BY(filter({ status: "all", sort: "expiryDesc" })) === "e,a,c,b,f,d");
  check("⑰ 剩余降序：-1（不限）视为最大排最前，同剩余按到期升序（实得 " + ROWS_BY(filter({ status: "all", sort: "remainDesc" })) + "）",
    ROWS_BY(filter({ status: "all", sort: "remainDesc" })) === "e,a,c,f,d,b");
  check("⑱ 剩余升序：-1 排最后（实得 " + ROWS_BY(filter({ status: "all", sort: "remainAsc" })) + "）",
    ROWS_BY(filter({ status: "all", sort: "remainAsc" })) === "d,b,f,c,a,e");

  // ===== E. 源码接线钉：纯函数对了但模板没接上也白搭 =====
  const view = fs.readFileSync(path.join(ROOT, VIEW), "utf8");
  check("⑲ 默认档钉在 usable", /const statusFilter = ref<ExpiryStatusFilter>\("usable"\)/.test(view));
  check("⑳ 模板遍历的是过滤后的 rows，不是全量 allRows", /v-for="r in rows"/.test(view) && !/v-for="r in allRows"/.test(view));
  check("㉑ 下拉选项来自纯函数模块（不是视图里另抄一份）",
    /STATUS_OPTIONS/.test(view) && /SORT_OPTIONS/.test(view) && STATUS_OPTIONS.length === 6 && SORT_OPTIONS.length === 4);

  // ===== F. 侧栏「渠道额度」卡片的死渠道隐藏 —— 本 PR 不含 =====
  // fork 的侧栏会隐藏「全渠道都已过期且余额为 0」的卡片，判据是 visibleChannels 那个
  // some/every 混合式。上游 Sidebar.vue 没有这块，断言没有对象；它守的是「别用 some 语义
  // 连带藏掉仍有可用号的渠道」这条真判据，等侧栏那批改动一起提时再补回，不在此取消。

  // ===== G. 过期满 2 天自动收起（日历被过期好几天的包刷屏） =====
  // 独立夹具：上面 6 行的过期时刻是 1 天前，正好落在「保留」侧，所以本节的边界样本不能混进去。
  // 本节判据是**成员集合**（顺序另有 ⑮–⑱ 钉），免得把排序算进收起规则的断言里互相掩盖。
  const SET = (out) => out.map((r) => r.pkg.code).sort().join(",");
  const T = Date.now();
  const stale = (code, agoMs, over = {}) => row("trae", "Trae SOLO CN", "t1", pkg(code, 5, 10, T - agoMs, { expired: true, ...over }));
  const STALE = [
    stale("k0", DAY - 60000), // 过期 1 天差 1 分钟 → 留
    stale("k1", 2 * DAY - 60000), // 过期 1天23h59m → 留（差 1 分钟才满 2 天）
    stale("k2", 2 * DAY), // 正好满 2 天 → 收起（阈值含 2）
    stale("k3", 30 * DAY), // 过期一个月 → 收起
    row("trae", "Trae SOLO CN", "t1", pkg("k4", 5, 10, T + 5 * DAY, { expiringSoon: true })), // 未过期 → 留
    stale("k5", 10 * DAY, { remaining: 0 }), // 陈旧过期且已用完 → 收起
    row("trae", "Trae SOLO CN", "t1", pkg("k6", 5, 10, 0)), // 长期有效 → 永不算陈旧
  ];
  const sflt = (o) => applyExpiryFilter(STALE, { status: "all", channelId: "all", sort: "expiryAsc", ...o }, T);
  check("G1 默认「全部」档收起过期满 2 天的 k2/k3/k5，保留 k0/k1/k4/k6（实得 " + SET(sflt({})) + "）",
    SET(sflt({})) === "k0,k1,k4,k6", SET(sflt({})));
  check("G2 阈值含 2 天：差 1 分钟满 2 天的 k1 必须还在，正好 2 天的 k2 必须收起",
    sflt({}).some((r) => r.pkg.code === "k1") && !sflt({}).some((r) => r.pkg.code === "k2"));
  check("G3 切到「已过期」档也不召回陈旧的包（那是同一批行，收起规则先于状态档）",
    SET(sflt({ status: "expired" })) === "k0,k1", SET(sflt({ status: "expired" })));
  check("G4 长期有效（expiresAt=0）永不算陈旧过期", isStaleExpired(pkg("x", 5, 10, 0), T) === false);
  check("G5 expiredDays 按整天向下取整：满 2 天报 2、1 天零 1 小时报 1、不足 1 天报 0、未过期报 -1",
    expiredDays(pkg("a", 5, 10, T - 2 * DAY), T) === 2 &&
      expiredDays(pkg("b", 5, 10, T - DAY - 3600000), T) === 1 &&
      expiredDays(pkg("c", 5, 10, T - 60000), T) === 0 &&
      expiredDays(pkg("d", 5, 10, T + DAY), T) === -1);
  check("G6 STALE_EXPIRED_DAYS 就是 2（文案与判据共用同一个常量，改阈值必须同步改口径）", STALE_EXPIRED_DAYS === 2);

  // ===== H. 历史过期档：把收起的行全部放回来，一条都不丢 =====
  const hflt = (o) => applyExpiryFilter(STALE, { status: "all", channelId: "all", sort: "expiryAsc", history: true, ...o }, T);
  check("H1 历史档 = 全部已过期（含收起的 k2/k3/k5），且不含未过期的 k4/k6（实得 " + SET(hflt({})) + "）",
    SET(hflt({})) === "k0,k1,k2,k3,k5", SET(hflt({})));
  check("H2 反向对照：两档并集覆盖夹具全集（收起不等于删除），且默认档收起的正是 k2/k3/k5",
    new Set([...sflt({}), ...hflt({})].map((r) => r.pkg.code)).size === STALE.length &&
      SET(STALE.filter((r) => !sflt({}).includes(r))) === "k2,k3,k5",
    SET(STALE.filter((r) => !sflt({}).includes(r))));
  check("H3 历史档下 status 维度让位：切成「生效中」也照样只出已过期行",
    SET(hflt({ status: "ok" })) === "k0,k1,k2,k3,k5", SET(hflt({ status: "ok" })));
  check("H4 历史档仍认渠道筛选",
    ROWS_BY(applyExpiryFilter(STALE, { status: "all", channelId: "workbuddy", sort: "expiryAsc", history: true }, T)) === "");
  check("H5 已用完但过期满 2 天的包只在历史档可见（默认档收不起，历史档不丢）",
    !sflt({}).some((r) => r.pkg.code === "k5") && hflt({}).some((r) => r.pkg.code === "k5"));

  // ===== I. 账号级聚合行：上游不拆包的渠道也要能进日历 =====
  const acc = (over) => ({ id: "x1", name: "账号甲", credits: 1880, creditsAt: T - 1000, expiresAt: T + 40 * DAY, ...over });
  const agg = aggregateRow("catpaw", "CatPaw（美团）", acc({}));
  check("I1 聚合行落在 total=-1（上游不给总额）+ aggregate 标记，包名与逐包行区分得开",
    !!agg && agg.aggregate === true && agg.pkg.total === -1 && agg.pkg.remaining === 1880 && agg.pkg.name === AGGREGATE_PKG_NAME);
  check("I2 从未刷过额度的账号（creditsAt=0）不出聚合行——那时 credits/expiresAt 都是建号默认值",
    aggregateRow("catpaw", "CatPaw（美团）", acc({ creditsAt: 0 })) === null);
  check("I3 余额非数值不出聚合行", aggregateRow("catpaw", "CatPaw（美团）", acc({ credits: NaN })) === null);
  check("I4 无到期时间的账号仍出聚合行（落 0 → 显示「长期」），不因缺到期就被丢掉",
    (() => {
      const r = aggregateRow("lobster", "LobsterAI（有道）", acc({ expiresAt: 0 }));
      return !!r && r.pkg.expiresAt === 0 && statusOf(r.pkg) === "ok";
    })());
  check("I5 聚合行的 key 与逐包行不撞（同一账号既可能走包集也可能走聚合）", agg.key === "x1:agg");
  check("I6 未命名账号回落占位名", aggregateRow("catpaw", "CatPaw（美团）", acc({ name: "" })).accountName === "（未命名）");

  // ===== J. 「剩余 / 总额」单元格：不给总额 ≠ 不限 =====
  const fmt = loadModule("src/views/proxy/format.ts");
  const { fmtBalancePair, balanceUnit } = fmt;
  check("J1 上游不给总额（total=-1 且剩余有数值）渲染成「—」，绝不能渲染成「1,880 / 不限」",
    fmtBalancePair(1880, -1, "lobster") === "1,880 / — 积分", fmtBalancePair(1880, -1, "lobster"));
  check("J2 两头都是 -1 才是真·不限，且不缀单位", fmtBalancePair(-1, -1, "catpaw") === "不限 / 不限", fmtBalancePair(-1, -1, "catpaw"));
  // 断言写成「量级被换算了 + 单位跟着 balanceUnit 走」而不是钉死某一种字形：
  // 钉 "3 百万 / … Token" 是把某个格式化函数的输出抄进断言，换成上游的 fmtCnAmount
  // （"3.00 百万"）就红得莫名其妙，而真正要守的东西——别把三百万原样铺满一格、
  // 别把单位写死成单数——反而没测到。
  check("J3 正常逐包行：大额 Token 要换算成量级、单位取 balanceUnit（不是原样铺数字）",
    /^\d+(\.\d+)? (百万|千万|亿)$/.test(fmtBalancePair(3000000, 3000000, "zcode").split(" / ")[0])
    && fmtBalancePair(3000000, 3000000, "zcode").endsWith(balanceUnit("zcode")),
    fmtBalancePair(3000000, 3000000, "zcode"));
  check("J4 剩余不限、总额有数值时照实并列", fmtBalancePair(-1, 500, "trae") === "不限 / 500 积分", fmtBalancePair(-1, 500, "trae"));
  // 号池页的逐包明细表是**分列**渲染的（不走 fmtBalancePair），而第 4 条之后上游不给面值的包
  // 真的会带着 total=-1 进来（LobsterAI creditItems / Qoder 只给 remaining 的那几族），
  // 同一套哨兵口径必须在两张表都成立——只在日历里堵等于没堵。
  check("J5 号池总额格：total=-1 且剩余有数值 ⇒「—」，绝不能念成「不限」",
    fmt.fmtPkgTotal(-1, 1880, "lobster") === "—", fmt.fmtPkgTotal(-1, 1880, "lobster"));
  check("J6 号池总额格：两头都是 -1 才是真·不限",
    fmt.fmtPkgTotal(-1, -1, "raccoon") === "不限", fmt.fmtPkgTotal(-1, -1, "raccoon"));
  check("J7 号池总额格：有面值时与原口径逐字相同（新函数不得顺手改掉正常行）",
    fmt.fmtPkgTotal(500, 300, "trae") === fmt.fmtBalance(500, "trae"), fmt.fmtPkgTotal(500, 300, "trae"));
  check("J8 号池已用格：没有面值就没有「已用」可言 ⇒「—」；有面值照实",
    fmt.fmtPkgUsed(0, -1, "lobster") === "—" && fmt.fmtPkgUsed(5, 5, "trae") === fmt.fmtBalance(5, "trae"),
    fmt.fmtPkgUsed(0, -1, "lobster") + " / " + fmt.fmtPkgUsed(5, 5, "trae"));
  // ⚠ 这里原本还有 4 条（号池逐包表的「总额格 / 已用格」同一套哨兵口径）。那两张表来自
  // fork 的号池逐包列，本 PR 没带过来，断言没有对象就删掉了。**不是取消这条判据**：
  // total=-1 在两处必须同读成「—」而不是「不限」，等号池页那批一起补回。

  // ===== K. 新增行为的源码接线钉（纯函数对了但视图没接上一样白搭） =====
  check("K1 视图把 historyOpen 灌进过滤器（否则按钮只是个装饰）",
    /history:\s*historyOpen\.value/.test(view));
  check("K2 视图遍历聚合行：packages 为空时才走 aggregateRow，两者互斥所以不会重复计数",
    /aggregateRow\(/.test(view) && /packs\.length/.test(view));
  check("K3 总额单元格走 fmtBalancePair（回退成两个 fmtBalance 拼接会把「—」写成「不限」）",
    /fmtBalancePair\(/.test(view) && !/fmtBalance\(r\.pkg\.total/.test(view));
  check("K4 过期行报的是「过期 N 天」而不是光秃秃的「已过期」（用户要的就是知道过期多久）",
    /过期 \$\{gone\} 天|过期 \$\{gone\}天/.test(view));
  check("K5 收起条数的提示走 staleHidden，且阈值取自常量而不是写死 2",
    /staleHidden/.test(view) && /STALE_EXPIRED_DAYS/.test(view));
  check("K6 历史档下 status 下拉被换成说明标签，不是留一个点不动的下拉",
    /v-if="historyOpen"[\s\S]{0,80}hist-chip/.test(view) && /v-else v-model="statusFilter"/.test(view));
  check("K7 按钮文案就是「历史过期积分」，不带条数（条数归「已过期」徽标与「N 条已收起」提示，别三处各摆一份）",
    /: "历史过期积分"/.test(view) && !/历史过期积分 \$\{/.test(view));
  const poolView = fs.readFileSync(path.join(ROOT, "src/views/proxy/ProxyAgentsView.vue"), "utf8");
  // 判据必须落在**那张表本身**：整张表里 fmtPkgTotal/fmtPkgUsed 各出现两次（浮层里也拼了一份），
  // 只 grep 全文的话把明细格退回裸 fmtBalance，浮层那份还在，正则照样绿（实测漏网过一次）。
  const pr0 = poolView.indexOf('class="pkg-row"');
  const pkgBlock = pr0 < 0 ? "" : poolView.slice(pr0, poolView.indexOf("</table>", pr0) + 8);
  check("K8 号池逐包表的总额/已用两格接的是 fmtPkgTotal/fmtPkgUsed（退回裸 fmtBalance 会把「不给总额」念成「不限」）",
    !!pkgBlock && /fmtPkgTotal\(pkg\.total/.test(pkgBlock) && /fmtPkgUsed\(pkg\.used/.test(pkgBlock)
      && !/fmtBalance\(pkg\.(total|used)/.test(pkgBlock),
    pr0 < 0 ? "找不到 class=\"pkg-row\" 那张表" : pkgBlock.split("\n").filter((l) => /<td class="mono num">/.test(l)).join(" ⎫ "));
  check("K9 展开按钮真的驱动那张表（按钮与表读的是同一个 expandedIds，否则按钮是装饰）",
    /@click="togglePkg\(acc\.id\)"/.test(poolView) && /v-if="expandedIds\.has\(acc\.id\) && acc\.packages/.test(poolView));
  check("K10 没有包就不出展开按钮（出了点开是一张空表，用户只会以为功能坏了）",
    /v-if="acc\.packages && acc\.packages\.length"[\s\S]{0,260}pkg-caret/.test(poolView));
  check("K11 没有面值的包不画已用进度条（total=-1 时条宽是无意义的数，宁可只给数字）",
    /v-if="pkg\.total > 0"[\s\S]{0,200}pkg-bar/.test(poolView));

  // ===== L. 时间轴档：泳道合并、远期桶、点聚合与「渠道内归一」的尺寸尺 =====
  // 判据落在**合并语义与几何**上，不落在「我恰好那么写的字面」上。
  const LN = loadModule("src/views/proxy/expiryLanes.ts");
  const { buildExpiryLanes, buildDecaySeries, decayPath, decayAreaPath, lanePct, laneNormX, LANE_X_MIN, LANE_X_MAX, LANE_FAR_X, LANE_X_END, LANE_DOT_MIN, LANE_DOT_MAX } = LN;
  const T2 = Date.now();
  // 夹具里凡是「必须在今天这一格」的时间戳都不能写「相对现在几小时」：
  // 闸在午夜前后跑就会漂到前一天，变成时间依赖的假红/假绿。
  const D0 = (() => { const d = new Date(T2); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const NOON = (() => { const d = new Date(T2); d.setHours(12, 0, 0, 0); return d.getTime(); })();
  // pkg(code,…) 里 name 就等于 code，所以泳道键里的包名直接用同一个串
  const P = (ch, disp, acc, name, remaining, total, expiresAt, extra) => row(ch, disp, acc, pkg(name, remaining, total, expiresAt, extra));
  const LROWS = [
    // 同渠道 · 同包名 · 同面值的 3 个包，到期日分别 −3 / +5 / +200 天
    P("workbuddy", "WorkBuddy CN", "w1", "裂变包", 100, 100, T2 - 3 * DAY, { expired: true }),
    P("workbuddy", "WorkBuddy CN", "w2", "裂变包", 100, 100, T2 + 5 * DAY, { expiringSoon: true }),
    P("workbuddy", "WorkBuddy CN", "w3", "裂变包", 100, 100, T2 + 200 * DAY, {}),
    // 同名不同面值：两批钱，必须分行
    P("workbuddy", "WorkBuddy CN", "w1", "裂变包", 300, 300, T2 + 5 * DAY, { expiringSoon: true }),
    // 同面值不同渠道：也必须分行
    P("trae", "Trae SOLO CN", "t1", "签到奖励", 100, 100, T2 + 5 * DAY, { expiringSoon: true }),
    // 账号级聚合行（total=-1 = 上游不给总额）
    P("raccoon", "商汤小浣熊", "r1", "账号额度汇总", 1880, -1, T2 + 40 * DAY, {}),
    // 不限（remaining=-1）+ 长期有效
    P("trae", "Trae SOLO CN", "t2", "不限包", -1, -1, 0, {}),
    // 已用完
    P("trae", "Trae SOLO CN", "t3", "用完了", 0, 50, T2 + 9 * DAY, {}),
  ];
  const LNES = buildExpiryLanes(LROWS, T2);
  const laneOf = (k) => LNES.find((l) => l.key === k) || { dots: [], sum: "（缺行）", pkgCount: -1, key: "（缺）" };
  const dotsOf = (k) => laneOf(k).dots;
  const sumOf = (k) => laneOf(k).sum;
  // 缺点必须 FAIL 而不是抛异常：一旦抛错，闸停在「闸自身异常」，后面所有判据的红全隐身
  const NO_DOT = { x: NaN, far: "（缺点）", count: -1, sum: NaN, size: -1, state: "（缺点）", unlimited: "（缺点）", rows: [] };
  const dotAt = (k, x) => dotsOf(k).find((d) => d.x === x) || NO_DOT;
  const L100 = dotsOf("workbuddy|裂变包|100");
  check("L1 合并只减渲染点数不减包数：8 行 → 6 条泳道、Σdot.count 仍是 8",
    LNES.length === 6 && LNES.reduce((s, l) => s + l.dots.reduce((n, d) => n + d.count, 0), 0) === 8 &&
      LNES.reduce((s, l) => s + l.pkgCount, 0) === 8,
    LNES.length + " 道 / " + LNES.reduce((s, l) => s + l.pkgCount, 0) + " 包");
  check("L2 同包名不同面值分行（合成一行就看不出哪批钱先掉）",
    !!dotAt("workbuddy|裂变包|100", -3) && !!laneOf("workbuddy|裂变包|300").dots.length && L100.length === 3);
  check("L3 同面值不同渠道分行", !!laneOf("trae|签到奖励|100").dots.length && !!laneOf("workbuddy|裂变包|100").dots.length);
  check("L4 超出右界（+200 天）与长期有效（expiresAt=0）都折进远期桶，不在轴上拉出空档",
    dotAt("workbuddy|裂变包|100", LANE_FAR_X)?.far === true && dotAt("trae|不限包|-1", LANE_FAR_X)?.far === true,
    JSON.stringify(LN.laneX(200)));
  check("L5 反向对照：过去侧不折桶——过期 3 天的点照实落在 −3（很久以前过期与很久以后过期不是一回事）",
    !!dotAt("workbuddy|裂变包|100", -3) && dotAt("workbuddy|裂变包|100", -3).far === false);
  check("L6 左出窗钳位：过期 30 天的点落在轴起点而不是 −30（历史档下这是真实可达的）",
    (() => {
      const s = buildExpiryLanes([P("trae", "Trae SOLO CN", "t9", "陈旧包", 5, 10, T2 - 30 * DAY, { expired: true })], T2)[0];
      return s.dots[0].x === LANE_X_MIN && s.dots[0].far === false && s.dots.every((d) => lanePct(d.x) >= 0 && lanePct(d.x) <= 100);
    })(),
    JSON.stringify((() => { const s = buildExpiryLanes([P("trae", "T", "t9", "陈旧包", 5, 10, T2 - 30 * DAY, { expired: true })], T2)[0]; return [s.dots[0].x, s.dots[0].far]; })()));
  check("L7 尺寸尺只在渠道内归一：同为剩余 100，trae（该渠道峰值 100）必须比 workbuddy（峰值 300）大",
    dotAt("trae|签到奖励|100", 5).size > dotAt("workbuddy|裂变包|100", 5).size,
    dotAt("trae|签到奖励|100", 5).size + " vs " + dotAt("workbuddy|裂变包|100", 5).size);
  check("L8 「不限」钉到最大档并带标记，绝不被当成剩余 0 落进最小档",
    dotAt("trae|不限包|-1", LANE_FAR_X).unlimited === true && dotAt("trae|不限包|-1", LANE_FAR_X).size === LANE_DOT_MAX);
  check("L9 含「不限」的泳道合计为 null（加不出有意义的数），正常泳道合计是数值",
    sumOf("trae|不限包|-1") === null && sumOf("workbuddy|裂变包|100") === 300 && sumOf("trae|用完了|50") === 0,
    [sumOf("trae|不限包|-1"), sumOf("workbuddy|裂变包|100"), sumOf("trae|用完了|50")].join(" / "));
  check("L10 已用完的点不消失（落最小档），否则图上会「凭空少包」",
    dotAt("trae|用完了|50", 9).state === "used" && dotAt("trae|用完了|50", 9).size === LANE_DOT_MIN);
  check("L11 同一天到期的包必须并成一个点：61 个同日同值包 ⇒ 1 个点、count=61、合计 6100",
    (() => {
      const SAME = [];
      for (let i = 0; i < 61; i++) SAME.push(P("workbuddy", "WorkBuddy CN", "w" + i, "裂变包", 100, 100, T2 + 5 * DAY, { expiringSoon: true }));
      const l = buildExpiryLanes(SAME, T2)[0];
      return l.dots.length === 1 && l.dots[0].count === 61 && l.dots[0].sum === 6100 && l.dots[0].rows.length === 61 && l.maxCount === 61;
    })(),
    (() => { const S = []; for (let i = 0; i < 61; i++) S.push(P("workbuddy", "W", "w" + i, "裂变包", 100, 100, T2 + 5 * DAY, {})); const l = buildExpiryLanes(S, T2)[0]; return [l.dots.length, l.dots[0] && l.dots[0].count, l.dots[0] && l.dots[0].sum].join("/"); })());
  check("L12 并点后的紧急态取组内最紧急者（同日里有一个已过期，整点就该报已过期）",
    (() => {
      // 两包的 expiresAt 相同（今天 10:00，落在 x=0），但主进程快照一个是 expiringSoon、
      // 一个是 expired——快照本来就比实时慢一个刷新周期，合并后必须取更紧急的那个。
      // 时刻钉在当天中午前后：用「半小时前」的话，闸在 00:00~00:30 跑会翻到前一天。
      const past = NOON - 2 * 3600000;
      const s = buildExpiryLanes([
        P("trae", "Trae SOLO CN", "a", "同日混合", 10, 100, past, { expiringSoon: true }),
        P("trae", "Trae SOLO CN", "b", "同日混合", 10, 100, past, { expired: true }),
        P("trae", "Trae SOLO CN", "c", "同日混合", 10, 100, T2 + 20 * DAY, {}),
        P("trae", "Trae SOLO CN", "d", "同日混合", 10, 100, T2 + 20 * DAY, {}),
      ], T2)[0];
      const p0 = s.dots.find((d) => d.x === 0);
      const fut = s.dots.find((d) => d.x === 20);
      return !!p0 && p0.count === 2 && p0.state === "expired" && !!fut && fut.count === 2 && fut.state === "ok";
    })(),
    (() => { const s = buildExpiryLanes([P("trae", "T", "a", "同日混合", 10, 100, NOON - 2 * 3600000, { expiringSoon: true }), P("trae", "T", "b", "同日混合", 10, 100, NOON - 2 * 3600000, { expired: true })], T2)[0]; return s.dots.map((d) => d.state + "/" + d.count).join(","); })());
  check("L13 坐标换算单调且区间闭合：轴起点 0%、轴终点 100%、今天落在 −10 与 +10 之间",
    lanePct(LANE_X_MIN) === 0 && lanePct(LANE_X_END) === 100 && lanePct(-10) < lanePct(0) && lanePct(0) < lanePct(10));
  check("L14 窗口右界就是 45 天：出窗的远期包折进 LANE_FAR_X，轴再往右留一段余量收口",
    LANE_X_MAX === 45 && LANE_FAR_X > LANE_X_MAX && LANE_X_END > LANE_FAR_X);
  check("L15 包多的泳道排最前（刷屏来源先处理），同数按最近到期升序",
    !!LNES[0] && LNES[0].pkgCount === 3 && LNES[0].key === "workbuddy|裂变包|100", LNES[0] && LNES[0].key + "/" + LNES[0].pkgCount);
  check("L16 空输入返回空数组（不是 null / 抛错）", Array.isArray(buildExpiryLanes([], T2)) && buildExpiryLanes([], T2).length === 0);
  // 不丢包必须在**有重复**的输入上才有牙：无重复夹具下「按 key 去重」这类错也照样行数==点数。
  const BIG = [];
  for (let i = 0; i < 200; i++) {
    const ch = ["workbuddy", "trae", "zcode"][i % 3];
    BIG.push(P(ch, ch, `acc${i % 7}`, `包${i % 5}`, 100 + (i % 5) * 50, 100 + (i % 5) * 50, T2 + ((i % 40) - 5) * DAY, {}));
  }
  const BLANES = buildExpiryLanes(BIG, T2);
  check("L17 不丢包是硬不变量：200 行重度重复 ⇒ Σcount=200、泳道键不重复、且点数远少于行数（真合并了）",
    BLANES.length === 15 && BLANES.reduce((s, l) => s + l.pkgCount, 0) === 200 &&
      BLANES.reduce((s, l) => s + l.dots.length, 0) < 200 &&
      new Set(BLANES.map((l) => l.key)).size === BLANES.length,
    BLANES.length + " 道 / " + BLANES.reduce((s, l) => s + l.dots.length, 0) + " 点 / " + BLANES.reduce((s, l) => s + l.pkgCount, 0) + " 包");
  // 尺寸尺子的分母必须是「点装的那个量」（同簇求和），不能是单包峰值：
  // 聚合后同簇和会超过单包峰值 ⇒ sqrt>1 ⇒ 点冲破 LANE_DOT_MAX（真机实测 48px），
  // 大而密的点又互相挡住 tooltip，等于把聚合要修的问题造回来。
  const SIZES = BLANES.flatMap((l) => l.dots.map((d) => d.size));
  const OVER = SIZES.filter((s) => s > LANE_DOT_MAX + 1e-9);
  const CH_TOP = new Map();
  for (const l of BLANES) for (const d of l.dots) CH_TOP.set(l.channelId, Math.max(CH_TOP.get(l.channelId) || 0, d.size));
  check("L18 点尺寸的上界由「点」定尺：重度重复下没有任何点超过 LANE_DOT_MAX，且每渠道最大点恰好顶到上限",
    SIZES.length > 0 && OVER.length === 0 &&
      SIZES.every((s) => s >= LANE_DOT_MIN - 1e-9) &&
      [...CH_TOP.values()].every((v) => v === LANE_DOT_MAX),
    `${OVER.length} 颗越界 / 最大 ${Math.max(...SIZES)} / 各渠道峰值 ${[...CH_TOP.entries()].map(([k, v]) => k + "=" + v).join(" ")}`);
  // 分桶口径：日历日，不是「距此刻几个 24 小时」。后者会让同一批数据随打开页面的时刻漂
  // （真实号池实测 110↔120 个点），并把同一天的早晚两个包拆成两点、把不同天的并成一点。
  check("L19 分桶按日历日：同一天早晚差 12 小时的两个包必须并成一点，且此刻取 00:10 还是 23:50 结果逐字相同",
    (() => {
      const rows = [
        P("trae", "Trae SOLO CN", "a", "同日早晚", 10, 100, D0 + 9 * 3600000, {}),
        P("trae", "Trae SOLO CN", "b", "同日早晚", 10, 100, D0 + 21 * 3600000, {}),
        P("trae", "Trae SOLO CN", "c", "同日早晚", 10, 100, D0 + 25 * 3600000, {}),
      ];
      const shape = (mins) => {
        const l = buildExpiryLanes(rows, D0 + mins * 60000)[0];
        return l.dots.map((d) => d.x + ":" + d.count).sort().join(",");
      };
      const a = shape(10), b = shape(23 * 60 + 50);
      return a === b && a === "0:2,1:1";
    })(),
    (() => {
      const rows = [P("trae", "T", "a", "同日早晚", 10, 100, D0 + 9 * 3600000, {}), P("trae", "T", "b", "同日早晚", 10, 100, D0 + 21 * 3600000, {}), P("trae", "T", "c", "同日早晚", 10, 100, D0 + 25 * 3600000, {})];
      return [10, 23 * 60 + 50].map((m) => { const l = buildExpiryLanes(rows, D0 + m * 60000)[0]; return m + "min⇒" + l.dots.map((d) => d.x + ":" + d.count).sort().join(","); }).join(" | ");
    })());
  // 天数必须是整数：日历差算成「一侧取零点、另一侧用原始毫秒」时会掉出小数，
  // 轴位与角标都不会报错，但同一批包的桶位会随时钟连续漂移。
  check("L20 距今天数恒为整数（一天就是 1，不出现 0.7 这种半格）",
    [D0 + 10 * 60000, D0 + 13 * 3600000, D0 + 23 * 3600000 + 59 * 60000].every((now) =>
      [D0 - 34 * 3600000, D0 + 9 * 3600000, D0 + 21 * 3600000, D0 + 200 * 3600000].every((e) => {
        const v = LN.laneDayOffset(e, now);
        return v !== null && Number.isInteger(v);
      })),
    [D0 + 13 * 3600000, D0 - 34 * 3600000].map((t) => LN.laneDayOffset(t, D0 + 13 * 3600000)).join(" / "));
  // 行首要报的是「最挤的那天有多少包」，不是首簇也不是总包数（那两个都会误导集中度）
  check("L21 maxCount 取最大簇：+3 天两个包、+7 天五个包 ⇒ 5（不是首簇 2，也不是总数 7）",
    (() => {
      const R = [];
      for (let i = 0; i < 2; i++) R.push(P("trae", "T", "a" + i, "簇", 10, 100, T2 + 3 * DAY, {}));
      for (let i = 0; i < 5; i++) R.push(P("trae", "T", "b" + i, "簇", 10, 100, T2 + 7 * DAY, {}));
      const l = buildExpiryLanes(R, T2)[0];
      return l.maxCount === 5 && l.pkgCount === 7 && l.dots[0].count === 2 && l.dots.length === 2;
    })(),
    (() => { const R = []; for (let i = 0; i < 2; i++) R.push(P("trae", "T", "a" + i, "簇", 10, 100, T2 + 3 * DAY, {})); for (let i = 0; i < 5; i++) R.push(P("trae", "T", "b" + i, "簇", 10, 100, T2 + 7 * DAY, {})); const l = buildExpiryLanes(R, T2)[0]; return "max=" + l.maxCount + " pkg=" + l.pkgCount + " dots=" + l.dots.map((d) => d.count).join("/"); })());

  // ===== M. 时间轴的源码接线钉（只匹代码，不匹散文；且必须匹绑定处） =====
  // 圆点必须绑 lanePct(d.x)：角标已删（密集行 54 个角标撞 31 对，读不出来），
  // 所以这里只钉一处，另用 M1b 钉「角标真的不在了」——留着它就是留着那个可读性缺陷。
  check("M1 视图遍历 lanes，且圆点绑定 lanePct(d.x)",
    /v-for="l in lanes"/.test(view) && /v-for="d in l\.dots"/.test(view) &&
      /class="lane-dot"[\s\S]{0,240}?left: lanePct\(d\.x\) \+ '%'/.test(view));
  check("M1b ×N 角标元素与它的 CSS 都已摘除（点位上不再摆文字）",
    !/lane-dot-n/.test(view));
  check("M2 时间轴吃的是已过滤的 rows 且 now 走同一个时钟（写死 now 会让全部点折进远期桶）",
    /buildExpiryLanes\(rows\.value, nowMs\.value\)/.test(view) && !/buildExpiryLanes\(allRows/.test(view));
  check("M3 默认档仍是表格（新增档不打乱既有习惯）", /const viewMode = ref<[^>]*>\("table"\)/.test(view));
  check("M4 三档共用一份空态文案（各写一套就会有一处口径过期）",
    /const emptyText = computed/.test(view) && (view.match(/没有已过期记录/g) || []).length === 1);
  // 判据只能匹**代码**：视图 CSS 注释里写着「不引 echarts」，按全文正则会是假红（本闸第一、二版各红过一次）。
  // 原本这里还查了「按需注册表里没被加进 Scatter/Heatmark 系列」——那是 fork 的 echarts 按需化改造
  // 才有的文件（src/utils/echarts.ts），本 PR 没有那个注册表，所以只留下面这条真判据：
  // 日历这两个图形档是纯 DOM/SVG，视图里一次都不许出现 echarts。
  check("M5 时间轴是纯 DOM：视图不 import echarts",
    !/import[^;\n]*echarts/.test(view));
  check("M6 面值标签走 laneFace 且调用点在模板里（只匹函数体就会漏掉「定义了没接」）",
    /l\.total > 0 \? fmtBalance/.test(view) && /v-if="laneFace\(l\)"/.test(view) && /\{\{ laneFace\(l\) \}\}/.test(view));
  // 并包标记：绑了类名还不够——没有对应 CSS 规则的话它就是个隐形字符串。
  check("M7 并包标记绑在 d.count 上，且 CSS 里真有这条规则（不标的话「61 个同日包」和「1 个大额包」看着同一个点）",
    /d\.count > 1 \? ' is-cluster' : ''/.test(view) &&
      /\.lane-dot\.is-cluster\s*\{[\s\S]{0,160}?outline:/.test(view));
  check("M8 「一天最多 N」走泳道标签列并绑在 maxCount 上（点位上摆不下文字，就得在行首报这一个数）",
    /v-if="l\.maxCount > 1"/.test(view) && /一天最多 \{\{ l\.maxCount \}\}/.test(view));
  check("M9 「不限」标记不占用 outline（一个点可以既含不限又并了包，抢同一属性会静默吃掉一个）",
    /\.lane-dot\.is-unlimited\s*\{(?![\s\S]{0,200}?outline:)[\s\S]{0,200}?border-radius:/.test(view));

  // ===== N. 见底曲线档：台阶语义、长期地板、SVG 几何 =====
  const DC = buildDecaySeries(LROWS, T2);
  const dOf = (id) => DC.find((s) => s.channelId === id) || { channelId: "（缺渠道）", pts: [], total: "（缺渠道）", count: -1, floor: -1, unlimited: null, atToday: "（缺渠道）", halfAt: "（缺渠道）", zeroAt: "（缺渠道）" };
  check("N1 每渠道一条，「不限」那条排最后（它画不出曲线，摆在最前面是占位）",
    DC.length === 3 && DC[DC.length - 1].channelId === "trae" && DC[0].channelId === "raccoon",
    DC.map((s) => s.channelId).join(","));
  const SAME61 = [];
  for (let i = 0; i < 61; i++) SAME61.push(P("zcode", "ZCode", `z${i}`, "同日包", 100, 100, T2 + 5 * DAY, { expiringSoon: true }));
  const SAME_S = buildDecaySeries(SAME61, T2)[0];
  check("N2 台阶数 = 唯一到期日数（61 个同日到期只能算一级掉，不能画成 61 级）",
    SAME_S.pts.length === 3 && SAME_S.pts[1].dropped === 6100 && SAME_S.total === 6100,
    JSON.stringify([SAME_S.pts.length, SAME_S.pts[1] && SAME_S.pts[1].dropped, SAME_S.total]));
  check("N3 workbuddy 台阶形状：起点 −20 满量 → −3 掉 100 → +5 掉 400 → 远期桶归零 → 右端收口",
    (() => {
      const p = dOf("workbuddy").pts;
      return p.length === 5 && p[0].x === LANE_X_MIN && p[0].y === 600 &&
        p[1].x === -3 && p[1].y === 500 && p[2].x === 5 && p[2].y === 100 &&
        p[3].x === LANE_FAR_X && p[3].y === 0 && p[4].x === LANE_X_END && p[4].y === 0;
    })(),
    JSON.stringify((dOf("workbuddy").pts || []).map((q) => [q.x, q.y])));
  check("N4 atToday 取「今天这根线上曲线所在的值」：−3 天已过期的 100 必须已经扣掉",
    dOf("workbuddy").atToday === 500 && dOf("raccoon").atToday === 1880,
    dOf("workbuddy").atToday + " / " + dOf("raccoon").atToday);
  check("N5 腰斩与见底按台阶算，且远期折叠不能报成真实天数（+200 天要报「45 天以后」）",
    dOf("workbuddy").halfAt === 5 && dOf("workbuddy").zeroAt === LANE_FAR_X &&
      dOf("raccoon").halfAt === 40 && dOf("raccoon").zeroAt === 40,
    JSON.stringify([dOf("workbuddy").halfAt, dOf("workbuddy").zeroAt, dOf("raccoon").halfAt, dOf("raccoon").zeroAt]));
  check("N6 远期折叠报成 LANE_FAR_X 而不是真实天数",
    (() => {
      const s = buildDecaySeries([P("zcode", "ZCode", "z1", "远期包", 3000000, 3000000, T2 + 400 * DAY, {})], T2)[0];
      return s.zeroAt === LANE_FAR_X && s.halfAt === LANE_FAR_X && s.atToday === 3000000;
    })());
  check("N6b 全是已用完的包（total=0）⇒ 不报腰斩也不报见底：起点与收口点不算「掉」",
    (() => {
      const s = buildDecaySeries([P("zcode", "ZCode", "z1", "空包", 0, 100, T2 + 5 * DAY, {})], T2)[0];
      return s.total === 0 && s.halfAt === null && s.zeroAt === null && s.atToday === 0;
    })());
  // 这条是本轮审查抓出来的真缺陷：长期有效（expiresAt=0）曾被折进远期桶扣掉，
  // 于是聚合行念出「见底在 45 天以后」这种假话——它根本不会过期。
  check("N6c 长期有效不参与扣减：它是曲线的地板，绝不报「见底」",
    (() => {
      const s = buildDecaySeries([P("catpaw", "CatPaw（美团）", "c1", "账号额度汇总", 500, -1, 0, {})], T2)[0];
      return s.floor === 500 && s.zeroAt === null && s.halfAt === null &&
        s.pts[s.pts.length - 1].y === 500 && s.pts.every((p) => p.y === 500);
    })(),
    JSON.stringify((() => { const s = buildDecaySeries([P("catpaw", "C", "c1", "账号额度汇总", 500, -1, 0, {})], T2)[0]; return [s.floor, s.zeroAt, s.halfAt, s.pts.map((p) => [p.x, p.y])]; })()));
  check("N6d 地板与到期量混合：曲线只掉到地板为止，报腰斩不报见底",
    (() => {
      const s = buildDecaySeries([
        P("catpaw", "CatPaw（美团）", "c1", "长期底", 400, -1, 0, {}),
        P("catpaw", "CatPaw（美团）", "c1", "十日包", 400, 400, T2 + 10 * DAY, {}),
      ], T2)[0];
      return s.total === 800 && s.floor === 400 && s.zeroAt === null && s.halfAt === 10 && s.pts[s.pts.length - 1].y === 400;
    })());
  check("N7 含「不限」的渠道不出曲线：unlimited=true、pts 空、total null",
    dOf("trae").unlimited === true && dOf("trae").pts.length === 0 && dOf("trae").total === null && dOf("trae").count === 3);
  check("N8 归一坐标在 0~100 内、x 单调不减、且 py 单调不减（曲线只能往下走）",
    DC.every((s) => s.pts.length === 0 || (
      s.pts.every((p) => p.px >= 0 && p.px <= 100 && p.py >= 0 && p.py <= 100) &&
      s.pts.every((p, i) => i === 0 || p.px >= s.pts[i - 1].px) &&
      s.pts.every((p, i) => i === 0 || p.py >= s.pts[i - 1].py))),
    "翻转 py = p.y/maxY*100 会让本条红（N8 曾只查 y 不查 py，方向翻转全绿）");
  check("N8b 起点满量在顶（py=0）、全到期后落底（py=100）：方向锚死，不看实现输出回抄",
    (() => {
      const s = dOf("workbuddy");
      return s.pts[0].py === 0 && s.pts[s.pts.length - 1].py === 100;
    })(), JSON.stringify((dOf("workbuddy").pts || []).map((p) => [Math.round(p.px), Math.round(p.py)])));
  check("N9 空输入返回空数组", Array.isArray(buildDecaySeries([], T2)) && buildDecaySeries([], T2).length === 0);
  check("N10 两档同源：见底曲线的渠道集合与泳道的渠道集合完全一致",
    JSON.stringify(DC.map((s) => s.channelId).sort()) === JSON.stringify([...new Set(LNES.map((l) => l.channelId))].sort()));
  check("N11 全渠道合计 == 各行剩余之和（台阶不凭空造量也不吞量）",
    DC.filter((s) => !s.unlimited).reduce((a, s) => a + s.total, 0) ===
      LROWS.filter((r) => r.channelId !== "trae").reduce((a, r) => a + Math.max(0, r.pkg.remaining), 0));
  // 台阶方向：step-after 是「先水平走到那天再垂直掉」，step-before 等于把掉点提前一天。
  // 逐顶点比对 (x_i, y_{i-1}) → (x_i, y_i)，不写任何「或 true」这类兜底——那正是本闸在抓的空转形状。
  const DP = decayPath(dOf("workbuddy"));
  const DPV = DP.split(/[ML]/).filter(Boolean).map((seg) => seg.trim().split(/\s+/).map(Number));
  const WPTS = dOf("workbuddy").pts.map((p) => [Math.round(p.px * 100) / 100, Math.round(p.py * 100) / 100]);
  check("N12 台阶 path 严格 step-after：首点是 (x0,y0)，其后每两级共享同一个 x 且 y 沿用前一点",
    DPV.length === WPTS.length * 2 - 1 &&
      DPV[0][0] === WPTS[0][0] && DPV[0][1] === WPTS[0][1] &&
      WPTS.slice(1).every((w, i) => {
        const a = DPV[i * 2 + 1], b = DPV[i * 2 + 2];
        return a[0] === w[0] && a[1] === WPTS[i][1] && b[0] === w[0] && b[1] === w[1];
      }),
    DP.slice(0, 70));
  check("N13 area 路径以 Z 闭合且回到基线 y=100（不闭合就是漏一截填充）",
    (() => {
      const a = decayAreaPath(dOf("workbuddy"));
      return a.startsWith(DP) && / L[\d.]+ 100 L[\d.]+ 100 Z$/.test(a);
    })(), decayAreaPath(dOf("workbuddy")).slice(-30));
  check("N14 退化输入不产非法 path：单点/空 pts 一律返回空串而不是 NaN 坐标",
    decayPath({ pts: [] }) === "" && decayPath({ pts: [{ px: 0, py: 0 }] }) === "" &&
      !/NaN/.test(decayAreaPath(dOf("trae"))) && decayAreaPath(dOf("trae")) === "");
  check("N15 恰掉到半数算腰斩（<= 而不是 <）：正好一半的那一级必须报出来",
    (() => {
      const s = buildDecaySeries([
        P("trae", "Trae SOLO CN", "a", "半量包", 50, 100, T2 + 3 * DAY, {}),
        P("trae", "Trae SOLO CN", "b", "半量包", 50, 100, T2 + 20 * DAY, {}),
      ], T2)[0];
      return s.total === 100 && s.halfAt === 3 && s.zeroAt === 20;
    })());
  check("N16 今天到期（x=0）那一级必须计入 atToday 之后的余量，不能被当成「还没掉」",
    (() => {
      // 固定本地正午：23 点后 T2+1h 已是明天，不能拿跨日输入验证「今天」。
      const noon = new Date(T2); noon.setHours(12, 0, 0, 0);
      const today = noon.getTime();
      const s = buildDecaySeries([
        P("trae", "Trae SOLO CN", "a", "今到期", 700, 700, today + 3600000, {}),
        P("trae", "Trae SOLO CN", "b", "后到期", 300, 300, today + 30 * DAY, {}),
      ], today)[0];
      return s.atToday === 1000 && s.halfAt === 0 && s.zeroAt === 30;
    })());

  // ===== O. 见底曲线档的源码接线钉 =====
  check("O1 三档各自独立可切：三个按钮的 @click 动作都钉住（只钉 :class 比较式的话，按钮改成空动作仍全绿）",
    /@click="viewMode = 'table'"/.test(view) && /@click="viewMode = 'lane'"/.test(view) && /@click="viewMode = 'decay'"/.test(view));
  check("O2 曲线吃已过滤 rows + 同一时钟，且三档串成互斥链（表格那端是光秃秃的 v-else，也要钉住）",
    /buildDecaySeries\(rows\.value, nowMs\.value\)/.test(view) &&
      /<div v-if="viewMode === 'lane'"/.test(view) && /<div v-else-if="viewMode === 'decay'"/.test(view) &&
      /<div v-else class="tbl-wrap">/.test(view) &&
      (view.match(/v-(if|else-if)="viewMode ===/g) || []).length === 2);
  check("O3 台阶 path 由纯函数模块出，视图只绑定不调几何（视图内拼字符串就等于无判据）",
    /:d="decayPath\(s\)"/.test(view) && /:d="decayAreaPath\(s\)"/.test(view) && !/function decayLine/.test(view) && !/`M\$\{/.test(view));
  check("O4 非等比 viewBox 必须配 non-scaling-stroke，否则 1.6px 描边会被压成粗细不均",
    /preserveAspectRatio="none"/.test(view) && (view.match(/vector-effect="non-scaling-stroke"/g) || []).length >= 2);
  check("O5 SVG 内所有 x 坐标都出自 lanePct（viewBox 是 0~100 用户单位，塞 0~1 归一值会把「今天」线画到左边缘）",
    /:x1="lanePct\(0\)"/.test(view) && /:x="lanePct\(LANE_X_MAX\)"/.test(view) && !/px="|:x="laneNormX/.test(view));
  check("O6 见底曲线仍是内联 SVG，没为它引入 echarts",
    /<svg[^>]*class="decay-svg"/.test(view) && !/import[^;\n]*echarts/.test(view));
  check("O7 长期地板有文案出口：floor>0 时不报「见底」而是标出长期量",
    /s\.floor > 0 \? `其中 \$\{fmtBalance\(s\.floor/.test(view) && /dayPhrase\(s\.zeroAt, "见底"\)/.test(view));
  check("O8 三档按钮有 aria-pressed（选中态只靠 btn-primary 配色的话，辅助技术读不出来）",
    (view.match(/:aria-pressed="viewMode ===/g) || []).length === 3);
  check("O9 一次渲染只取一次时刻：三个 computed 共用 nowMs，不各自 Date.now()",
    /const nowMs = ref\(Date\.now\(\)\)/.test(view) &&
      /buildExpiryLanes\(rows\.value, nowMs\.value\)/.test(view) && /buildDecaySeries\(rows\.value, nowMs\.value\)/.test(view));

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 积分日历行过滤闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

try { main(); } catch (e) { console.error("闸自身异常:", e); process.exit(1); }
