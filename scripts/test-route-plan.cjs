/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 选路计划与运行期状态的回归（route-plan.cjs / route-state.cjs）：
//   · 三种策略：位次 / 全队环绕 / 家内环绕；
//   · 四层：粘性置顶、限流垫底、失败退避、熔断（稳定分层，不重排同层）；
//   · 八种不可用原因：已试 / 禁用 / 限制器 / 冷却 / 并发满 / 无凭据 / 能力不足 / 非在线；
//   · 运行期状态：游标单调、粘性 TTL、退避指数封顶、成功清退避、垫底 TTL；
//   · 纯函数：不修改入参数组顺序。
//
// 跑法：node scripts/test-route-plan.cjs
// （本文件不依赖 node:sqlite，普通 node 即可）
"use strict";
const assert = require("node:assert/strict");

const state = require("../electron/backend/localgw/route-state.cjs");
const plan = require("../electron/backend/localgw/route-plan.cjs");

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  passed++;
  console.log(`PASS ${name}`);
}

const NOW = 1_800_000_000_000;

function account(id, overrides = {}) {
  return plan.adaptAccount({
    id, name: id, channel: overrides.provider || "ch-a",
    status: overrides.status || "online", hasToken: overrides.hasToken !== false,
    lastUsed: 0,
    meta: { gateway: { priority: overrides.priority ?? 0, maxInFlight: overrides.maxInFlight ?? 0 } },
    capabilities: overrides.capabilities || {},
  }, { inFlight: overrides.inFlight || 0 });
}

function ids(result) {
  return result.ordered.map((row) => row.id);
}

check("order：按 priority 升序，并列按加入时间与 id 稳定", () => {
  const a = account("a", { priority: 2 });
  const b = account("b", { priority: 1 });
  const c = account("c", { priority: 1 });
  const result = plan.buildPlan({ accounts: [a, b, c], strategy: "order", now: NOW });
  assert.deepEqual(ids(result), ["b", "c", "a"]);
  assert.equal(result.blocked.length, 0);
});

check("order：并入参数组顺序不变（纯函数）", () => {
  const list = [account("a", { priority: 2 }), account("b", { priority: 1 })];
  const before = list.map((item) => item.id);
  plan.buildPlan({ accounts: list, strategy: "order", now: NOW });
  assert.deepEqual(list.map((item) => item.id), before);
});

check("rotate：游标决定起点，绕一圈不丢人", () => {
  const a = account("a", { priority: 0 });
  const b = account("b", { priority: 1 });
  const c = account("c", { priority: 2 });
  const result = plan.buildPlan({ accounts: [a, b, c], strategy: "rotate", cursor: 1, now: NOW });
  assert.deepEqual(ids(result), ["b", "c", "a"]);
});

check("provider：家序固定，家内各自环绕", () => {
  const p1a = account("p1a", { provider: "p1", priority: 0 });
  const p2a = account("p2a", { provider: "p2", priority: 1 });
  const p1b = account("p1b", { provider: "p1", priority: 2 });
  const p2b = account("p2b", { provider: "p2", priority: 3 });
  const result = plan.buildPlan({
    accounts: [p1a, p2a, p1b, p2b], strategy: "provider",
    providerCursors: { p1: 1, p2: 0 }, now: NOW,
  });
  assert.deepEqual(ids(result), ["p1b", "p1a", "p2a", "p2b"]);
});

check("preserveOrder：沿用调用方已排好的顺序，不按 priority 重排", () => {
  const high = account("high", { priority: 9 });
  const low = account("low", { priority: 1 });
  const result = plan.buildPlan({ accounts: [high, low], strategy: "order", preserveOrder: true, now: NOW });
  assert.deepEqual(ids(result), ["high", "low"]);
});

check("粘性：命中号置顶，且 stickyHit 为真", () => {
  const a = account("a", { priority: 0 });
  const b = account("b", { priority: 1 });
  const result = plan.buildPlan({
    accounts: [a, b], strategy: "order", stickyKey: "conv-1",
    state: { sticky: { "conv-1": "b" } }, now: NOW,
  });
  assert.deepEqual(ids(result), ["b", "a"]);
  assert.equal(result.stickyHit, true);
  assert.equal(result.stickyCandidate, true);
});

check("粘性：命中但被垫底时 stickyHit 为假（调用方不应跳过轮转）", () => {
  const a = account("a", { priority: 0 });
  const b = account("b", { priority: 1 });
  const result = plan.buildPlan({
    accounts: [a, b], strategy: "order", stickyKey: "conv-1",
    state: { sticky: { "conv-1": "b" }, sunk: { b: NOW + 1000 } }, now: NOW,
  });
  assert.deepEqual(ids(result), ["a", "b"]);
  assert.equal(result.stickyCandidate, true);
  assert.equal(result.stickyHit, false);
});

check("四层修饰：垫底 → 退避 → 熔断，稳定分层", () => {
  const a = account("a", { priority: 0 });
  const b = account("b", { priority: 1 });
  const c = account("c", { priority: 2 });
  const d = account("d", { priority: 3 });
  const result = plan.buildPlan({
    accounts: [a, b, c, d], strategy: "order",
    state: { sunk: { c: NOW + 1000 }, open: ["b"] }, now: NOW,
  });
  assert.deepEqual(ids(result), ["a", "d", "c", "b"]);
});

check("不可用原因：八种状态各有明确文案", () => {
  const capable = { tools: true };
  const result = plan.buildPlan({
    accounts: [
      account("ok", { capabilities: capable }),
      account("tried", { capabilities: capable }),
      account("off", { status: "disabled", capabilities: capable }),
      account("limited", { capabilities: capable }),
      account("cool", { capabilities: capable }),
      account("busy", { maxInFlight: 1, inFlight: 1, capabilities: capable }),
      account("nocred", { hasToken: false, capabilities: capable }),
      account("nofeat", { capabilities: { tools: false } }),
      account("offline", { status: "cooling", capabilities: capable }),
    ],
    strategy: "order", excluded: ["tried"], limiter: ["limited"],
    cooling: { cool: NOW + 60_000 }, needs: { tools: true }, now: NOW,
  });
  const byState = Object.fromEntries(result.blocked.map((row) => [row.id, row.state]));
  assert.deepEqual(byState, {
    tried: "tried", off: "disabled", limited: "limiter", cool: "cooldown",
    busy: "concurrency", nocred: "no-credentials", nofeat: "capability", offline: "offline",
  });
  assert.match(result.blocked.find((row) => row.id === "cool").reason, /恢复$/);
  assert.match(result.blocked.find((row) => row.id === "busy").reason, /并发已满（1\/1）/);
});

check("能力：未声明的能力也要区分「未声明」与「不支持」", () => {
  const missing = plan.buildPlan({ accounts: [account("a")], needs: { images: true }, now: NOW });
  const denied = plan.buildPlan({ accounts: [account("b", { capabilities: { images: false } })], needs: { images: true }, now: NOW });
  assert.match(missing.blocked[0].reason, /未声明/);
  assert.match(denied.blocked[0].reason, /不支持图片输入/);
});

check("空候选：ordered 与 blocked 都为空，不抛错", () => {
  const result = plan.buildPlan({ accounts: [], strategy: "order", now: NOW });
  assert.deepEqual(result.ordered, []);
  assert.deepEqual(result.blocked, []);
});

check("adaptAccount：号池字段映射正确", () => {
  const row = plan.adaptAccount({
    id: "x1", name: "号一", channel: "workbuddy", status: "online", hasToken: true,
    meta: { gateway: { priority: 3, maxInFlight: 2 } },
    capabilities: { tools: true },
  }, { inFlight: 1 });
  assert.equal(row.provider, "workbuddy");
  assert.equal(row.priority, 3);
  assert.equal(row.maxConcurrent, 2);
  assert.equal(row.inFlight, 1);
  assert.equal(row.hasCredentials, true);
  assert.equal(row.capabilities.tools, true);
});

check("游标：rotateTake 单调递增，rotatePeek 不推进", () => {
  state.reset();
  assert.equal(state.rotateTake("m1"), 0);
  assert.equal(state.rotateTake("m1"), 1);
  assert.equal(state.rotatePeek("m1"), 2);
  assert.equal(state.rotateTake("m1"), 2);
});

check("会话键：同模型同首条消息稳定，换消息或换模型就变", () => {
  const base = { model: "gpt-x", messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "在" }] };
  const key1 = state.conversationKey(base);
  const key2 = state.conversationKey({ ...base, messages: [...base.messages, { role: "user", content: "继续" }] });
  assert.equal(key1, key2);
  assert.notEqual(key1, state.conversationKey({ ...base, messages: [{ role: "user", content: "别的" }] }));
  assert.notEqual(key1, state.conversationKey({ ...base, model: "gpt-y" }));
  assert.equal(
    state.conversationKey({ ...base, headers: { "X-Conversation-Id": "c-1" } }),
    state.conversationKey({ ...base, headers: { "x-conversation-id": "c-1" } }),
  );
});

check("粘性：TTL 到点自动放手", () => {
  state.reset();
  state.stickySet("k", "acc", NOW);
  assert.equal(state.stickyGet("k", NOW + 1000, 5000), "acc");
  assert.equal(state.stickyGet("k", NOW + 6000, 5000), "");
});

check("退避：15 分钟起翻倍，封顶 1 小时", () => {
  state.reset();
  const first = state.markFailure("acc", NOW);
  const second = state.markFailure("acc", NOW);
  const third = state.markFailure("acc", NOW);
  assert.equal(first.until - NOW, state.BACKOFF_BASE_MS);
  assert.equal(second.until - NOW, state.BACKOFF_BASE_MS * 2);
  assert.equal(third.until - NOW, state.BACKOFF_BASE_MS * 4);
  for (let index = 0; index < 10; index++) state.markFailure("acc", NOW);
  const snap = state.snapshot(NOW);
  assert.equal(snap.backoff.acc - NOW, state.BACKOFF_MAX_MS);
});

check("熔断：连续 3 次失败打开，连续 2 次成功关闭", () => {
  state.reset();
  state.markFailure("acc", NOW);
  state.markFailure("acc", NOW);
  assert.deepEqual(state.snapshot(NOW).open, []);
  state.markFailure("acc", NOW);
  assert.deepEqual(state.snapshot(NOW).open, ["acc"]);
  state.markSuccess("acc", NOW);
  assert.deepEqual(state.snapshot(NOW).open, ["acc"]);
  state.markSuccess("acc", NOW + 1);
  assert.deepEqual(state.snapshot(NOW + 1).open, []);
});

check("成功：清退避与垫底", () => {
  state.reset();
  state.markFailure("acc", NOW);
  state.markSunk("acc", NOW);
  assert.ok(state.snapshot(NOW).backoff.acc);
  assert.ok(state.snapshot(NOW).sunk.acc);
  state.markSuccess("acc", NOW);
  assert.equal(state.snapshot(NOW).backoff.acc, undefined);
  assert.equal(state.snapshot(NOW).sunk.acc, undefined);
});

check("垫底：30 分钟 TTL，到点从快照消失", () => {
  state.reset();
  state.markSunk("acc", NOW);
  assert.ok(state.snapshot(NOW + 1000).sunk.acc);
  assert.equal(state.snapshot(NOW + state.SINK_TTL_MS + 1).sunk.acc, undefined);
});

check("prune：过期项被清理，不残留", () => {
  state.reset();
  state.markFailure("acc", NOW);
  state.markSunk("acc", NOW);
  state.stickySet("k", "acc", NOW);
  state.prune(NOW + state.BACKOFF_MAX_MS + state.SINK_TTL_MS + state.STICKY_TTL_MS + 1);
  const stats = state.stats(NOW + state.BACKOFF_MAX_MS + state.SINK_TTL_MS + state.STICKY_TTL_MS + 1);
  assert.equal(stats.resting, 0);
  assert.equal(stats.sunken, 0);
  assert.equal(stats.sticky, 0);
});

state.reset();
console.log(`\n${passed} 项全部通过`);
