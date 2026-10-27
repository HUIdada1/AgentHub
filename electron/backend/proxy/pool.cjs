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
// 反代网关 · 号池服务：账号状态机 + 池内调度 + 错误分类冷却
// 状态机五态：online / cooling / exhausted / relogin / disabled；调度只挑 online
"use strict";
const store = require("./store.cjs");
// ===== 派生复活事件 =====
// cooling/exhausted 到期回 online 时，前端号池卡片靠「credits 事件 → 刷新」自然感知；
// 但「冷却结束」本身不是一次 credits 变更（账号可能本来就没积分）——故在派生复活处补发一个
// 「账号状态变化」事件（复用 events.cjs 的既有通道），让「解冷却/到点复活」后第一次渲染能
// 立刻反映，而不是等下一次 credits 刷新才顺带看见（审查整改 F15）。
const events = require("./events.cjs");

/** 「即将到期」窗口（天）：设置页可调，index.cjs 出号池视图前按 settings().expiringSoonDays 灌入。
 *  放本模块的模块级变量（仿 store.usageRetentionDays），避免让热路由模块依赖 config。
 *  默认 1 = 与本改动前 poolSummary 里那个硬编码 86400000 完全等价，不改变任何人的现有观感。
 *  账号级聚合（poolSummary.expiringSoon）与逐包（decoratePackageStates）共用这一个值。 */
let expiringSoonDays = 1;
function setExpiringSoonDays(n) {
  // 只认「数字」和「非空数字串」。不能写成 Number(n) 一把梭：Number(null) 和 Number("")
  // 都是合法的 0，会被下面这段当成「用户主动把预警调到 0=关闭」，于是缺字段 / 清空输入框
  // 会静默关掉预警，而且界面上一点痕迹都没有。
  const v = typeof n === "number" ? n
    : (typeof n === "string" && n.trim() !== "" ? Number(n) : NaN);
  if (Number.isFinite(v) && v >= 0 && v <= 3650) expiringSoonDays = v;
}
function expiringSoonMs() { return expiringSoonDays * 86400000; }

/**
 * 由积分包集派生账号级额度（包集是单一事实源时调用；无包则返回 null，调用方保留既有聚合值）。
 *  - 任一包 remaining = -1（上游「不限」哨兵）→ credits = -1（无限额度）
 *    ⚠ total = -1 **不**算不限——它表示「上游不给这一包的总额」，与「额度无限」是两回事。
 *    两者混为一谈时，producer 只要按「不知道总额」的口径写 total:-1，该号余额就会被
 *    派生成无限并绕开 cost-first 路由，所以这里只认 remaining。
 *  - 剩余 = Σ未过期包剩余；最近到期 = min(剩余>0 且未过期 的包到期)
 */
function deriveAccountCredits(packages, now) {
  if (!Array.isArray(packages) || !packages.length) return null;
  now = now || Date.now();
  const unlimited = packages.some((p) => Number(p.remaining) === -1);
  const valid = packages.filter((p) => !(Number(p.expiresAt) > 0 && Number(p.expiresAt) <= now));
  const credits = unlimited ? -1 : valid.reduce((s, p) => s + Math.max(0, Number(p.remaining) || 0), 0);
  const withRemain = valid.filter((p) => (Number(p.remaining) || 0) > 0 && Number(p.expiresAt) > 0);
  const expiresAt = withRemain.length ? Math.min(...withRemain.map((p) => Number(p.expiresAt))) : 0;
  // 全部过期的判定（审查整改 F19）：packages 里所有带到期时间的包都已过期、且没有任何
  // 「长期有效（expiresAt=0）或仍有余量」的包时，credits 是 0 但 expiresAt 也回 0 会被
  // pickAccount 的「余额已到期（expiresAt <= now）」判据放过——「全过期」与「长期有效」必须区分。
  // allExpired=true 由调用方（credits.cjs）按 exhausted 处理；无限账号不受影响。
  const hasPerpetual = packages.some((p) => !(Number(p.expiresAt) > 0));
  const allExpired = !unlimited && !hasPerpetual && valid.length === 0 && packages.some((p) => Number(p.expiresAt) > 0);
  return { credits, expiresAt, allExpired };
}

/**
 * 逐包时间态：给包集附 expired/expiringSoon。
 * 两个量故意不落库——把"今天"写进库就被刷新时刻冻结了，隔天再看全是旧的；每次出视图重算。
 * expiresAt = 0 是「长期有效」（normalizeExpiryMs 把远未来脏值归 0），既不算已过期也不算即将到期。
 */
function decoratePackageStates(packages, now) {
  const t = now || Date.now();
  const soonMs = expiringSoonMs();
  return (packages || []).map((p) => ({
    ...p,
    expired: p.expiresAt > 0 && p.expiresAt <= t,
    expiringSoon: p.expiresAt > t && p.expiresAt - t < soonMs,
  }));
}

/** 派生有效状态：cooling 到期自动回 online；exhausted 到次日 04:00 后给复活机会。
 *  只返回派生状态，不落库——落库时机由调用方 poolAccounts 统一收，避免双写 */
function effectiveStatus(acc, now) {
  now = now || Date.now();
  if (acc.status === "cooling" && acc.cool_until && acc.cool_until <= now) return "online";
  if (acc.status === "exhausted" && acc.cool_until && acc.cool_until <= now) return "online";
  return acc.status;
}

const memLastUsed = new Map(); // accId → 内存最近选号时间戳，消除选号高频同步写放大

/** 渠道号池视图（账号明细 + 派生状态 + 内存最新 lastUsed）。
 *  派生复活（cooling/exhausted 到期回 online）统一在这里落库，调度与视图读同一口径；
 *  必须保持「状态确实变化才写」，否则每轮 pickAccount 都对全池写一遍，SQLite 锁竞争放大 */
function poolAccounts(channel) {
  return store.listAccounts(channel).map((a) => {
    const eff = effectiveStatus(a);
    const before = a.status;
    if (before !== eff) {
      // cooling 到期的复活清冷却字段；exhausted 到期只回 online，保留 coolUntil（次日 04:00 锚点）
      store.updateAccount(a.id, before === "cooling" ? { status: "online", coolUntil: 0, coolReason: "" } : { status: "online" });
      // 复活事件（审查整改 F15）：号池页收到 credits 才刷新，但「复活」不是 credits 变更；
      // 发一个轻量事件让前端能立刻感知状态变化（事件不阻塞、失败静默）。
      try { events.emit({ type: "status" }); } catch { /* 事件失败不影响派生复活本身 */ }
    }
    const latestUsed = Math.max(a.lastUsed || 0, memLastUsed.get(a.id) || 0);
    return { ...a, status: eff, lastUsed: latestUsed };
  });
}

/** 渠道是否声明「余额 0 不是硬门禁」（Cline：上游允许余额记负——实测欠费 -0.02 仍可用，
 *  真实门禁是每日额度的 429（带重置时间）与订阅 403，都已由错误分类按账号处置）。
 *  对这类渠道，「余额 0 → exhausted」会把免费池账号锁死：store 入库层把两位小数舍入后的
 *  0 与 < -1 的负值都归 0，复活条件 credits > 0 在余额恒 0 时永不满足。
 *  惰性 require：adapters.cjs 装配重，避免顶层 require 改变加载顺序（本仓反代依赖惯例） */
function zeroBalanceUsable(channel) {
  try {
    const ad = require("./adapters.cjs").get(channel);
    return !!(ad && ad.zeroBalanceUsable);
  } catch { return false; }
}

/**
 * 池内选号：expire_first（默认，积分先到期先用）/ credit_first / round_robin
 * 两种自动切换（不发请求、调度期前置生效）：
 *  ① 余额不足自动切换——已查到余额为 0 的账号直接标记耗尽并跳过，不再浪费一次上游 402
 *     （声明 zeroBalanceUsable 的渠道豁免——余额 0 不是它的硬门禁，判定见上）；
 *  ② 余额到期自动切换——到期时间已过的账号余额视为失效，标记并跳过；
 *     搭配默认 expire_first 策略：快到期账号永远排在最前优先消耗（到期前榨干），过期即自动切走。
 * 被跳过的账号等下次额度刷新拿到新余额/新到期时间后自动复活（credits.cjs）。
 * maxInFlight > 0 时在途数已达上限的账号不参与候选（租约语义），
 * 全部忙时降级取在途最小者（不过载拒绝）；100ms 内刚选中过的账号让位给其他候选（防惊群）。
 */
function pickAccount(channel, strategy, excludeIds, maxInFlight) {
  const now = Date.now();
  const exclude = new Set(excludeIds || []);
  const candidates = [];
  for (const a of poolAccounts(channel)) {
    if (a.status !== "online" || !a.hasToken || exclude.has(a.id)) continue;
    // credits === -1 = 企业版无限额度哨兵，不参与耗尽判定；
    // 声明 zeroBalanceUsable 的渠道（Cline）同样豁免——余额 0 不是它的硬门禁，
    // 真实门禁（每日额度 429）由错误分类落冷却处置，这里误标只会把账号锁死在调度外
    if (a.creditsAt > 0 && a.credits === 0 && !zeroBalanceUsable(channel)) {
      // ① 已知余额不足：标记耗尽（次日 04:00 给复活机会），自动切换下一账号
      store.updateAccount(a.id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: "余额不足，已自动切换" });
      continue;
    }
    // ③ 全部过期（审查整改 F19）：包集给出 allExpired=true 的账号，expiresAt 被 credits.cjs
    //    写成「刚刚过期」（now-1），本条「余额已到期」判据会把它抓住；若 expiresAt 仍是 0
    //    （如 adapter 未走 packages 派生路径），allExpired 标记在账号 meta 上，同样拦下。
    if (a.expiresAt > 0 && a.expiresAt <= now) {
      // ② 余额已到期：标记失效（靠额度刷新复活），自动切换下一账号。
      // coolUntil 不能写 0：effectiveStatus 的派生复活判据要求 cool_until 非 0，写 0 会让
      // 这类 exhausted 永远失去「次日 04:00 复活」兜底，只剩余额刷新一条独木桥（#152）
      store.updateAccount(a.id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: "余额已到期，已自动切换" });
      continue;
    }
    candidates.push(a);
  }
  if (!candidates.length) return null;
  // 并发租约：在途数达上限的账号让位；全忙时取在途最小者（不过载拒绝）
  let pool2 = candidates;
  const limit = Number(maxInFlight) > 0 ? Number(maxInFlight) : 0;
  if (limit) {
    const idle = candidates.filter((a) => (inFlight.get(a.id) || 0) < limit);
    if (idle.length) {
      pool2 = idle;
    } else {
      let min = Infinity;
      for (const a of candidates) {
        const c = inFlight.get(a.id) || 0;
        if (c < min) { min = c; pool2 = [a]; }
      }
    }
  }
  switch (strategy) {
    case "credit_first":
      pool2.sort((a, b) => b.credits - a.credits);
      break;
    case "round_robin":
      pool2.sort((a, b) => a.lastUsed - b.lastUsed);
      break;
    case "expire_first":
    default:
      // 先到期的先用；没查过到期时间的排最后（不失效优先消耗快过期的）
      pool2.sort((a, b) => (a.expiresAt || Number.MAX_SAFE_INTEGER) - (b.expiresAt || Number.MAX_SAFE_INTEGER));
      break;
  }
  let picked = pool2[0];
  // 防惊群：100ms 内刚选中过同一账号且还有其他候选 → 让位重选（并发突发不再集中打一个号）
  if (pool2.length > 1 && now - (lastPickAt.get(picked.id) || 0) < 100) {
    const alt = pool2.find((a) => now - (lastPickAt.get(a.id) || 0) >= 100);
    if (alt) picked = alt;
  }
  lastPickAt.set(picked.id, now);
  memLastUsed.set(picked.id, now);
  picked.lastUsed = now;
  return picked;
}

/** 次日 04:00（402 积分耗尽的长冷却点，对齐 HardCredit） */
function nextDay4AM() {
  const d = new Date();
  d.setHours(4, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ===== 模型级负缓存（账号×模型，内存态 + 落库持久化）=====
// 实测：6004 = 模型级限流（换模型即豁免）、11102 = 该账号不支持此模型。
// 这两类错误罚"账号×模型"组合而不是整个账号——账号对其他模型仍可用。
// 6004 对齐墙钟可达数小时、11102 封顶 24h，纯内存态重启即丢 → 每次重启都白撞一次
// 上游 429 才能重建负缓存（2026-09-21 实测），故写穿 model_cooldowns 表
const modelCool = new Map(); // `${accId}∥${modelId小写}` → untilMs

function modelCoolKey(accId, model) {
  return `${accId}∥${model}`.toLowerCase();
}

/** 惰性从库恢复未过期的模型级冷却（首次访问时一次）；库不可用时纯内存降级 */
let modelCoolHydrated = false;
function ensureModelCoolHydrated() {
  if (modelCoolHydrated) return;
  modelCoolHydrated = true;
  try {
    for (const row of store.listModelCooldowns()) {
      // 与 modelCoolKey 同口径：整个 key（含 accId）小写，避免非 UUID 账号 id 大小写错位
      modelCool.set(`${row.accId}∥${row.model}`.toLowerCase(), { until: row.until, reason: row.reason || "" });
    }
  } catch { /* 库不可用：降级为纯内存 */ }
}

/** 模型级冷却/负缓存：untilMs 之后自动豁免；定期清扫防内存膨胀。
 *  opts.backoff = 11102 指数退避（BlockModelBackoff）：命中次数递增，base→cap 封顶 */
function coolAccountModel(accId, model, untilMs, reason, opts) {
  ensureModelCoolHydrated();
  if (modelCool.size > 20000) {
    const now = Date.now();
    for (const [k, v] of modelCool) if (v.until <= now) modelCool.delete(k);
  }
  const key = modelCoolKey(accId, model);
  const lowerModel = String(model).toLowerCase();
  if (opts && opts.backoff) {
    const now = Date.now();
    const cur = modelCool.get(key);
    const hits = cur && cur.until > now ? (cur.hits || 0) + 1 : 0;
    const base = Number(opts.baseMs) > 0 ? Number(opts.baseMs) : untilMs;
    const cap = Number(opts.capMs) > 0 ? Number(opts.capMs) : base * 4;
    const until = Math.min(base * Math.pow(2, hits), cap);
    modelCool.set(key, { until, reason: reason || "", hits });
    store.upsertModelCooldown(accId, lowerModel, until, reason);
    return;
  }
  modelCool.set(key, { until: untilMs, reason: reason || "" });
  store.upsertModelCooldown(accId, lowerModel, untilMs, reason);
}

/** 该账号此模型是否在负缓存中 */
function isModelCooled(accId, model) {
  ensureModelCoolHydrated();
  const hit = modelCool.get(modelCoolKey(accId, model));
  if (!hit) return false;
  if (hit.until <= Date.now()) {
    modelCool.delete(modelCoolKey(accId, model));
    store.deleteModelCooldowns(accId, String(model).toLowerCase());
    return false;
  }
  return true;
}

/** 错误分类冷却：402→exhausted 至次日 04:00；429→60s；5xx→10min；401→relogin */
function coolAccount(id, kind, detail) {
  const now = Date.now();
  // 冷却原因归一：只认非空字符串。调用方（localgw/forwarder.cjs）写的是 `cls.detail || {}`，
  // 而 classifyUpstream 的结果里**没有** detail 字段 ⇒ 实际传进来的恒是空对象；
  // 原样透传给 store.updateAccount 会 String({}) 成 "[object Object]"，直接显示在号池详情与
  // 操作日志的冷却原因里。归一后非法形态回落各分支的默认文案。
  const why = typeof detail === "string" && detail.trim() ? detail : "";
  switch (kind) {
    case "credit": // 402 积分耗尽
      store.updateAccount(id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: why || "积分耗尽" });
      break;
    case "rate": // 429 限流
      store.updateAccount(id, { status: "cooling", coolUntil: now + 60000, coolReason: why || "上游限流" });
      break;
    case "server": // 5xx / 网络异常
      store.updateAccount(id, { status: "cooling", coolUntil: now + 600000, coolReason: why || "上游异常" });
      break;
    case "relogin": // 401 刷新失败
      store.updateAccount(id, { status: "relogin", coolUntil: 0, coolReason: why || "凭证失效，需重新登录" });
      break;
    case "account_blocked": // 11140 账号级风控拦截（WB）：拦截时长上游不给，按小时级冷却
      // 档位不能取默认的 60s——风控状态不会自己好，1 分钟后被重新选中又是一次白撞；
      // 也不能学 relogin 直接判死：实测该状态与账号本身无关（目录/计费端点照常 200），
      // 换会话后可能就恢复了。2h 是「别把整池拖下水」与「别误判成永久失效」的折中
      store.updateAccount(id, { status: "cooling", coolUntil: now + 2 * 3600000, coolReason: why || "账号被上游风控拦截" });
      break;
    default:
      store.updateAccount(id, { status: "cooling", coolUntil: now + 60000, coolReason: why });
  }
}

/** 按绝对时刻冷却（429 对齐上游重置墙钟 / Retry-After / 指数退避等场景需要精确 until）。
 *  opts.soft = true 时给 detail 追加「(软限流 #N，退避 Xs)」说明（审查整改 O18：
 *  否则 oplog/详情里只能看到 429 文案，看不出是哪次退避、第几次连续） */
function coolAccountMs(id, untilMs, detail, opts) {
  // 与 coolAccount 同一道归一：非字符串 detail（如调用方写 `x || {}`）不得变成 "[object Object]"
  let msg = typeof detail === "string" ? detail : "";
  if (opts && opts.soft && opts.streak) {
    const ms = Math.max(0, (Number(untilMs) || 0) - Date.now());
    msg = `${msg}${msg ? " " : ""}(软限流 #${opts.streak}，退避 ${Math.round(ms / 1000)}s)`.slice(0, 400);
  }
  store.updateAccount(id, { status: "cooling", coolUntil: Math.max(Number(untilMs) || 0, Date.now() + 1000), coolReason: msg });
}

// ===== 并发租约 / 防惊群 / 软限流指数 / 会话判定计数（内存态） =====

const inFlight = new Map(); // accId → 在途请求数
const lastPickAt = new Map(); // accId → 上次被 pickAccount 选中的时间戳
const softStreaks = new Map(); // accId → 连续 429（无明示重置时间）次数
const sessionDeadFails = new Map(); // accId → 连续凭证失效次数（3 次才判废）
const serverFails = new Map(); // accId → 连续 5xx/网络失败次数（熔断器：3 次起 30m 指数封顶 6h）

function acquireAccount(id) { inFlight.set(id, (inFlight.get(id) || 0) + 1); }
function releaseAccount(id) {
  const n = (inFlight.get(id) || 1) - 1;
  if (n <= 0) inFlight.delete(id);
  else inFlight.set(id, n);
}
function inFlightCount(id) {
  return inFlight.get(id) || 0;
}

/** 429 无明示重置时间时的有界指数退避：60s 基数翻倍封顶 2h（CooldownSoftRate 语义）。
 *  档位可调（审查整改 O17）：setCooldownTunables({softBaseMs, softCapMs}) 由 index.cjs 从设置灌入。 */
let softBaseMs = 60000;
let softCapMs = 2 * 3600000;
let breakerThreshold = 3;
let breakerBaseMs = 30 * 60000;
let breakerCapMs = 6 * 3600000;

/** 熔断/软退避档位注入（纯 setter，不写配置；非法值忽略） */
function setCooldownTunables(t) {
  if (!t || typeof t !== "object") return;
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const sb = num(t.softBaseMs, 1000, 3600000); if (sb) softBaseMs = sb;
  const sc = num(t.softCapMs, 60000, 86400000); if (sc) softCapMs = sc;
  const bt = num(t.breakerThreshold, 1, 20); if (bt) breakerThreshold = Math.round(bt);
  const bb = num(t.breakerBaseMs, 60000, 7200000); if (bb) breakerBaseMs = bb;
  const bc = num(t.breakerCapMs, 300000, 86400000); if (bc) breakerCapMs = bc;
}

function softBackoffMs(id) {
  const n = softStreaks.get(id) || 0;
  softStreaks.set(id, n + 1);
  return Math.min(softBaseMs * Math.pow(2, Math.min(n, 7)), softCapMs);
}

/** 凭证失效计数：返回是否已达判废阈值（连续 N 次，默认 3） */
function noteSessionDead(id) {
  const n = (sessionDeadFails.get(id) || 0) + 1;
  sessionDeadFails.set(id, n);
  return n >= breakerThreshold;
}

/** 5xx/网络熔断（breaker：连续 N 次起 base 指数封顶 cap，默认 3 次/30m/6h）。
 *  返回冷却截止时刻；未达触发阈值返回 0（调用方走基础冷却） */
function noteServerError(id) {
  const n = (serverFails.get(id) || 0) + 1;
  serverFails.set(id, n);
  if (n < breakerThreshold) return 0;
  return Date.now() + Math.min(breakerBaseMs * Math.pow(2, Math.min(n - breakerThreshold, 3)), breakerCapMs);
}

/** 成功收尾：清软限流 streak / 凭证失效计数 / 熔断计数 / 该账号该模型的负缓存（NoteSuccess 语义） */
function noteSuccess(id, model) {
  if (id == null) return;
  softStreaks.delete(id);
  sessionDeadFails.delete(id);
  serverFails.delete(id);
  if (model) {
    modelCool.delete(modelCoolKey(id, model));
    store.deleteModelCooldowns(id, String(model).toLowerCase());
  }
}

/** 状态机唯一写入口（审查整改 F3）：所有「把账号从冷却/耗尽/重登录拉回 online」的动作
 *  必须走这里，不允许任何调用方直接 store.updateAccount({status:"online", coolUntil:0, coolReason:""})。
 *  两条铁律：
 *   ① 模型级负缓存（6004/11102 只罚账号×模型、不落账号状态）必须与账号级一并豁免——
 *      只解账号级的话调度照样跳过，等于没解（releaseCool 已实现）；
 *   ② 写操作只此一处，保证「派生复活（cooling/exhausted 到期回 online）在 poolAccounts 统一收」
 *      与「手动解冷却」两条路径的清理口径不会分叉。
 *  返回值同 releaseCool；无冷却可解时返回 { ok:false, message:"该账号不在冷却中" }
 *
 *  patch（可选）：显式声明本次要落的状态字段。**「启用被停用的账号」必须走它**——
 *  releaseCool 只收 cooling/exhausted/relogin 三态，disabled 不在其中；只传 id 时它返回
 *  ok:false 且一个字节都不写库，按钮就成了静默空操作（点「启用」→ 刷新后仍是停用）。
 *  传 patch 时：先做 releaseCool 的清理（模型级负缓存 + 冷却三态归位），再补写 patch——
 *  仍然只有这一个写入口，不会绕过模型级负缓存清理。 */
function updateStatus(id, patch) {
  const r = releaseCool(id);
  const hasPatch = patch && typeof patch === "object" && Object.keys(patch).length > 0;
  if (!hasPatch) return r;
  // 账号不存在时不写库：updateAccount 对不存在的行静默返回 false，报 ok:true 会骗调用方
  if (!store.getAccount(id)) return { ok: false, message: "账号不存在" };
  store.updateAccount(id, patch);
  return { ok: true, releasedModels: r.releasedModels || 0 };
}

/** 解除冷却/恢复可用（审查整改 F3：状态机唯一写入口，供「解冷却」按钮 / 账号启用 / 人机校验通过等
 *  一切「拉回 online」的动作调用）。三类非 online 状态一起收：
 *   - cooling：冷却到期被手动提前解除；
 *   - exhausted：402/余额不足被标耗尽（次日 04:00 才自动复活）；
 *   - relogin：凭证失效待重登（人工已重新导入凭据或 OAuth 重登成功后）。
 *  统一动作：清模型级负缓存（内存 + 落库）→ 账号级归 online 并清冷却字段。
 *  只 cooling 时旧行为保留；exhausted / relogin 以前没有手动出口，一并补上。
 *  返回值：{ ok, releasedModels?, message? } */
function releaseCool(id) {
  ensureModelCoolHydrated();
  const acc = store.getAccount(id);
  if (!acc) return { ok: false, message: "账号不存在" };
  // key 存的是 toLowerCase 后的 `${accId}∥${model}`，前缀匹配同样 lower
  const prefix = `${String(id).toLowerCase()}∥`;
  let releasedModels = 0;
  for (const k of modelCool.keys()) {
    if (k.startsWith(prefix)) {
      modelCool.delete(k);
      releasedModels++;
    }
  }
  store.deleteModelCooldowns(id, null); // 库里的模型级负缓存一并清（重启后不复活）
  if (acc.status === "cooling" || acc.status === "exhausted" || acc.status === "relogin") {
    store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "" });
    return { ok: true, releasedModels };
  }
  // 账号级已 online 但存在模型级负缓存（6004/11102 只罚"账号×模型"，不落账号状态）：
  // 同样允许解除，否则墙钟冷却期间用户没有手动出口（持久化后负缓存跨重启存活）
  if (releasedModels > 0) return { ok: true, releasedModels };
  return { ok: false, message: "该账号不在冷却中" };
}

/** 该账号当前生效的模型级负缓存列表（号池页展示 + 解冷却入口判断）：
    6004/11102 只罚"账号×模型"不落账号状态，前端靠它才能看见并手动解除 */
function accountModelCool(id) {
  ensureModelCoolHydrated();
  const prefix = `${String(id).toLowerCase()}∥`;
  const now = Date.now();
  const out = [];
  for (const [k, v] of modelCool) {
    if (!k.startsWith(prefix)) continue;
    if (v.until <= now) continue;
    out.push({ model: k.slice(prefix.length), until: v.until, reason: v.reason || "" });
  }
  return out;
}

/** 号池聚合视图（号池卡片顶部：总余额/账号数/可用/最早到期/今日消耗，单一数据源实时推导） */
function poolSummary(channel) {
  const accs = poolAccounts(channel);
  const now = Date.now();
  const online = accs.filter((a) => a.status === "online" && a.hasToken);
  const expires = accs.map((a) => a.expiresAt).filter((t) => t > 0);
  return {
    channel,
    // -1 = 无限额度哨兵：不进总量（不是负数也不是真余额）
    totalCredits: online.reduce((s, a) => s + (a.credits > 0 ? a.credits : 0), 0),
    // 池内存在 -1 无限账号：cost-first 路由排序把它按超大余额参与（现状 totalCredits 不含 -1，
    // 全无限账号的渠道打分恒为 1 会垫底，付费反而排在免费后面）
    unlimited: online.some((a) => a.credits === -1),
    accountCount: accs.length,
    onlineCount: online.length,
    earliestExpire: expires.length ? Math.min(...expires) : 0,
    expiringSoon: accs.some((a) => a.expiresAt > 0 && a.expiresAt - now < expiringSoonMs()),
    todayReq: accs.reduce((s, a) => s + a.todayReq, 0),
    todayTokens: accs.reduce((s, a) => s + a.todayTokens, 0),
    lastCreditsAt: accs.reduce((m, a) => Math.max(m, a.creditsAt || 0), 0),
  };
}

module.exports = {
  effectiveStatus, deriveAccountCredits, decoratePackageStates, setExpiringSoonDays, expiringSoonMs, poolAccounts, pickAccount, coolAccount, coolAccountMs,
  coolAccountModel, isModelCooled, accountModelCool, poolSummary, nextDay4AM,
  acquireAccount, releaseAccount, inFlightCount, softBackoffMs, noteSessionDead, noteServerError, noteSuccess,
  releaseCool, updateStatus, zeroBalanceUsable, setCooldownTunables,
};
