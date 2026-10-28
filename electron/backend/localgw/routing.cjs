/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 渠道路由：策略、固定、故障转移、冷却
// 决策 1：首期只默认启用「号池已配置账号的渠道」；其余渠道收进扩展区，提示去号池补账号。
// 号池联动：本模块只读号池账号与冷却状态，不直接写号池；号池停用账号时本地熔断自然跟随。
// 与号池的语义差异：号池 channelEnabled 控制「是否在号池管家 UI 中可见」；
// 本模块 perChannel.enabled 控制「是否被网关路由选中」——两者独立，互不干扰。
"use strict";
const proxyStore = require("../proxy/store.cjs");
// 注意：这里**不能** require("../proxy/index.cjs")——那是号池的编排层，
// 顶层会连带装配 adapters/discovery/credits/poolsched/netproxy 并调用 setModelScopeRefresh，
// 而本模块只用到 pool 的只读查询。审查发现原代码 require 了它却从未使用（死引用 + 启动期副作用）。
// 同理 framework config.cjs 也只被下面那个从未被调用的 proxyCfg() 用到，已一并清理。
const pool = require("../proxy/pool.cjs");
const lgwConfig = require("./config.cjs");
// 出站策略摘要（channelMatrix 用）。outbound.cjs 不反向依赖本模块，故无循环依赖。
const outbound = require("./outbound.cjs");

/** 渠道 → 当前生效的 per-channel 冷却结束时刻（ms）；失败一次翻倍，封顶 cooldownCapMs */
const cooldownUntil = new Map();
/** 渠道连续失败次数（用于指数退避计算） */
const failCount = new Map();
/** round-robin 轮转游标（进程内；重启归零，不落盘——轮转只是负载分散，不是持久状态） */
let rrCursor = 0;

/** 决策 1 默认启集：号池里 distinct channel where status 是 active/idle */
function channelsWithAccounts() {
  try {
    const accounts = proxyStore.listAccounts();
    const on = new Set();
    for (const a of accounts) {
      // 号池 status 字段：online | cooling | exhausted | relogin | disabled
      if (a.status === "online" || a.status === "cooling") on.add(a.channel);
    }
    return [...on];
  } catch {
    return [];
  }
}

/** 渠道启闭状态（本模块的可见集合）：perChannel.enabled 缺省 = true */
function isChannelEnabled(id) {
  const c = lgwConfig.get();
  const v = c.routing.perChannelEnabled && c.routing.perChannelEnabled[id];
  // 缺省 = 启用
  return v === undefined ? true : !!v;
}
function setChannelEnabled(id, enabled) {
  const c = lgwConfig.get();
  const cur = c.routing.perChannelEnabled || {};
  const r = lgwConfig.patch({ routing: { ...c.routing, perChannelEnabled: { ...cur, [id]: enabled } } });
  return r && r.ok === false ? { ok: false, message: r.message } : { ok: true };
}

/** 是否在冷却中 */
function isCooling(id) {
  const until = cooldownUntil.get(id) || 0;
  if (Date.now() >= until) {
    if (until) { cooldownUntil.delete(id); failCount.delete(id); }
    return false;
  }
  return true;
}

/** 渠道失败：记录 + 进入指数退避冷却 */
function markFailed(id) {
  const c = lgwConfig.get();
  const n = (failCount.get(id) || 0) + 1;
  failCount.set(id, n);
  const base = c.routing.cooldownMs;
  const cap = c.routing.cooldownCapMs;
  // 指数退避：base * 2^(n-1)，封顶 cap
  const backoff = Math.min(cap, base * Math.pow(2, n - 1));
  cooldownUntil.set(id, Date.now() + backoff);
}

/** 渠道成功：解除冷却并重置计数 */
function markSucceeded(id) {
  cooldownUntil.delete(id);
  failCount.delete(id);
}

/** 打分排序（score 策略）：在线账号数 + 余额 / 1000 - 冷却惩罚 */
function score(channel, summary) {
  const acc = summary ? summary.onlineCount : 0;
  const credits = summary ? (summary.totalCredits || 0) : 0;
  const cool = isCooling(channel) ? -1000 : 0;
  return acc * 10 + credits / 1000 + cool;
}

/** 当前候选渠道列表（已经过 enabled / blocked / cooling / except 四重过滤）
 *  except: 本轮请求应额外排除的渠道（key scopes 未授权 / 故障转移已尝试）
 *  返回按 preferChannels → 分数 → 渠道 id 稳定排序后的数组（id 兜底保证同分时顺序确定，
 *  否则 round-robin 会在同分渠道间跳来跳去）。 */
function candidates(except) {
  const c = lgwConfig.get();
  const withAcc = new Set(channelsWithAccounts());
  const prefer = new Set(c.routing.preferChannels || []);
  const blocked = new Set([...(c.routing.blockedChannels || []), ...(except || [])]);
  const out = [];
  for (const id of withAcc) {
    if (blocked.has(id)) continue;
    if (!isChannelEnabled(id)) continue;
    if (isCooling(id)) continue;
    out.push(id);
  }
  // 摘要一次算齐：原实现把 channelSummary 放进比较器里，每次比较都查一遍库（N log N 次 DB 查询）
  const summaryCache = new Map();
  for (const id of out) summaryCache.set(id, channelSummary(id));
  out.sort((a, b) => {
    const pa = prefer.has(a) ? 0 : 1;
    const pb = prefer.has(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const sa = score(a, summaryCache.get(a));
    const sb = score(b, summaryCache.get(b));
    if (sb !== sa) return sb - sa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return out;
}

/** 号池侧的渠道汇总（打分用；失败时静默降级为空）。
 *  【审查修正】原实现从 store.channelList() 里取 row.summary —— 该接口返回的是
 *  {id, display, domain, kind, enabled}，根本没有 summary 字段，于是 score 恒为 0、
 *  score/smart 策略实际退化成"按 Set 顺序"。正确来源是 pool.poolSummary(channel)。 */
function channelSummary(id) {
  try {
    return pool.poolSummary(id);
  } catch {
    return null;
  }
}

/** 路由入口：返回选中的渠道 id；返回 null 表示没有可用渠道（调用方回 503）。
 *  except: 本轮请求应额外排除的渠道集合（key scopes / 故障转移已尝试渠道）
 *  策略语义（config.routing.strategy）：
 *   · fixed       固定渠道（fixedChannel），failover 关时命中不了就回 null
 *   · round-robin 候选内轮转，保证多渠道路由均衡
 *   · smart       preferChannels 优先，其余按 score
 *   · score       纯打分（preferChannels 不参与，用于"只看余额/在线数"的场景）
 *  模型级覆盖（models.overrides[model].channel）在所有策略之前生效——它是用户对单个模型的硬指定。 */
function pick(model, except) {
  const c = lgwConfig.get();
  const exceptSet = new Set(except || []);
  const usable = (id) => id && !exceptSet.has(id) && isChannelEnabled(id) && !isCooling(id);

  // 模型级覆盖：models.overrides[model].channel 优先
  const ov = c.models.overrides && c.models.overrides[model];
  if (ov && ov.channel) {
    if (usable(ov.channel)) return ov.channel;
    if (!c.routing.failover) return null;
  }

  if (c.routing.strategy === "fixed" && c.routing.fixedChannel) {
    if (usable(c.routing.fixedChannel)) return c.routing.fixedChannel;
    if (!c.routing.failover) return null;
  }

  let list = candidates([...exceptSet]);
  if (!list.length) return null;

  if (c.routing.strategy === "round-robin") {
    const idx = rrCursor++ % list.length;
    return list[idx];
  }
  if (c.routing.strategy === "score") {
    // candidates 已按 prefer→score 排好；score 策略刻意忽略 preferChannels
    const scored = list.slice().sort((a, b) => {
      const d = score(b, channelSummary(b)) - score(a, channelSummary(a));
      return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
    });
    return scored[0];
  }
  // smart（默认）：candidates 的 prefer → score 顺序即所需
  list = list.slice();
  return list[0];
}

/** 当前路由配置视图（IPC 返回） */
function routeState() {
  const c = lgwConfig.get();
  const withAcc = new Set(channelsWithAccounts());
  const perChannel = {};
  for (const id of withAcc) perChannel[id] = { enabled: isChannelEnabled(id) };
  return {
    strategy: c.routing.strategy,
    fixedChannel: c.routing.fixedChannel,
    enableFailover: c.routing.failover,
    cooldownMs: c.routing.cooldownMs,
    cooldownCapMs: c.routing.cooldownCapMs,
    preferChannels: c.routing.preferChannels,
    blockedChannels: c.routing.blockedChannels,
    perChannel,
  };
}

/** 写路由配置（深合并） */
function setRoute(patch) {
  const c = lgwConfig.get();
  const next = { ...c.routing };
  if (patch.strategy) next.strategy = patch.strategy;
  if (patch.fixedChannel !== undefined) next.fixedChannel = patch.fixedChannel;
  if (patch.enableFailover !== undefined) next.failover = !!patch.enableFailover;
  if (patch.cooldownMs !== undefined) next.cooldownMs = Number(patch.cooldownMs) || next.cooldownMs;
  if (patch.cooldownCapMs !== undefined) next.cooldownCapMs = Number(patch.cooldownCapMs) || next.cooldownCapMs;
  if (patch.preferChannels !== undefined) next.preferChannels = Array.isArray(patch.preferChannels) ? patch.preferChannels : [];
  if (patch.blockedChannels !== undefined) next.blockedChannels = Array.isArray(patch.blockedChannels) ? patch.blockedChannels : [];
  if (patch.perChannel) {
    // perChannel: { id: { enabled } } → 写回 perChannelEnabled
    const cur = next.perChannelEnabled || {};
    const out = { ...cur };
    for (const [id, v] of Object.entries(patch.perChannel)) {
      out[id] = !!(v && v.enabled);
    }
    next.perChannelEnabled = out;
  }
  const r = lgwConfig.patch({ routing: next });
  // 越界入参（如非法 strategy）由 config.patch 显式拒绝，这里如实上抛而不是假装成功
  if (r && r.ok === false) return { ok: false, message: r.message || "路由配置写入失败" };
  return { ok: true, ...routeState() };
}

/** 活跃渠道数（status IPC 用） */
function activeCount() {
  return candidates().length;
}

/** 渠道清单 + 各自生效策略摘要（IPC localgw_outbound_get 用；契约 §4.8）。
 *  【纯新增函数，不动本文件任何既有签名】
 *  为什么放在 routing 而不是 outbound：渠道清单（有哪些渠道、内置还是自定义、有几个账号）
 *  是路由与号池的知识；outbound.cjs 只管策略编译，不该反向依赖号池查询。 */
function channelMatrix() {
  const c = lgwConfig.get();
  // 账号数一次查全：per-channel 逐个查库是 N 次 DB 往返（本文件 candidates() 上已有同类教训）
  const counts = new Map();
  try {
    for (const a of proxyStore.listAccounts()) {
      if (!a || !a.channel) continue;
      counts.set(a.channel, (counts.get(a.channel) || 0) + 1);
    }
  } catch { /* 号池读不出来时账号数一律 0：这不影响用户编辑出站策略 */ }

  const seen = new Set();
  const rows = [];
  const push = (id, display, kind) => {
    const key = String(id || "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    // 单条渠道的策略摘要算不出来时只跳过这一条：outbound_get 整个挂掉会让配置面板
    // 永久显示"后端通道未接入"，而真实原因可能只是某个渠道 id 上有脏配置
    let d = { mode: "mimic", profileLabel: "", parts: [] };
    try { d = outbound.describePolicy(key, c); } catch { /* 保底摘要 */ }
    rows.push({
      id: key,
      display: display || key,
      kind: kind === "custom" ? "custom" : "builtin",
      accountCount: counts.get(key) || 0,
      policy: { mode: d.mode, profileLabel: d.profileLabel, parts: d.parts },
    });
  };

  try {
    for (const ch of proxyStore.channelList() || []) push(ch.id, ch.display, ch.kind);
  } catch { /* 渠道表读不出来时仍要列出已配策略的渠道，否则用户连删都删不掉 */ }
  // 已配策略但不在渠道清单里的 id（渠道被停用 / 手改 config.json 写了未知 id）也要列出来，
  // 否则那条配置在 UI 上永远看不见、也删不掉
  const per = c.outbound && c.outbound.perChannel;
  if (per && typeof per === "object") {
    for (const id of Object.keys(per)) push(id, "", "custom");
  }
  return rows;
}

/** 渠道测试（IPC: localgw_channel_test）
 *  【审查结论·收敛承诺】本函数**不谎报成功**。前端「路由与渠道」页有「测试」按钮、
 *  LocalgwRoute 类型里也声明了 balance?，所以"返回 ok:true 但没做任何探测"是界面承诺了
 *  后端没兑现——用户会以为渠道通了。真实探测需要复用号池的 credits.refreshAccount()
 *  （一次真实上游请求：会写库、会消耗一次调用、可能触发冷却/重登流程），
 *  风险与耗时都超出本次静态审查范围，故按方案 (b) 收敛承诺：
 *  只做**能确定**的本地检查，把结论如实放进 message，ok 恒为 false 直到接线完成。 */
async function testChannel(id) {
  try {
    if (!id) return { ok: false, message: "缺少渠道 id" };
    const t0 = Date.now();
    const withAcc = new Set(channelsWithAccounts());
    if (!withAcc.has(id)) {
      return { ok: false, message: `渠道 ${id} 在号池里没有可用账号，请先到号池管家添加` };
    }
    if (isCooling(id)) {
      const until = cooldownUntil.get(id) || 0;
      return { ok: false, message: `渠道 ${id} 正在冷却中（约 ${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s 后重试）` };
    }
    const summary = channelSummary(id);
    const cached = summary && Number.isFinite(summary.totalCredits) ? `，缓存余额 ${summary.totalCredits}` : "";
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      message: `渠道连通性测试尚未接线（本地检查通过：账号在线、未冷却${cached}）。接线阶段将复用号池 proxy_account_refresh 做真实探测。`,
    };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

module.exports = {
  pick,
  candidates,
  routeState,
  setRoute,
  setChannelEnabled,
  isChannelEnabled,
  isCooling,
  markFailed,
  markSucceeded,
  activeCount,
  testChannel,
  channelsWithAccounts,
  channelMatrix,
};
