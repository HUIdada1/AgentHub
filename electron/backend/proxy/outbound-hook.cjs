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
// 本地网关 · 出站上下文（AsyncLocalStorage）
//
// ── 为什么单独立一个文件，且不 require 任何 proxy 业务模块 ──────────
// proxy/util.cjs 被号池几乎所有模块引用，而它要在 byteSafeHeaders() 里取「当前出站策略」。
// 若把策略实现直接放进 util 能 require 到的位置，localgw/outbound.cjs 就会被拖进号池的
// 加载图，形成 proxy ←→ localgw 的循环依赖。本文件只依赖 node:async_hooks、无副作用，
// 因此可以被 util.cjs **顶层** require（省掉每请求一次函数内 require 的开销）。
//
// ── 职责边界：hook 只做机械执行，不做任何策略判定 ──────────────────
// 头覆盖的纯逻辑在 localgw/outbound.cjs；它把**已编译好**的头操作塞进 policy 的
// __headerOps 字段（内部字段，下划线前缀），hook 只读它。这样「用户怎么配」与
// 「怎么套用到请求头」两件事互不牵连，也便于单测。
//
// ── 零回归是最高优先级 ───────────────────────────────────────────
// 号池自身出站请求根本不带 ALS 上下文，applyHeaders 必须**原样返回同一引用**，
// 使 util.byteSafeHeaders 的行为逐字节不变。
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();

/** 在 ALS 上下文里执行 fn；policy 为空时等价于直通执行（不进上下文，省掉一层开销）。
 *
 *  ⚠ 使用约定（独立验证时实测到的语义边界，给将来的人看）：
 *  ALS 的上下文会被 fn 内部**创建的一切异步资源**继承，包括 fn 返回之后才触发的
 *  定时器回调与 Promise 续体。因此：
 *   · **不得**在 run() 内创建跨越请求生命周期的后台任务（setInterval、长延时 setTimeout、
 *     常驻事件监听器等）——它们会在请求结束后仍带着本次渠道的 policy 去改出站请求头，
 *     把某个渠道的伪装头套到号池自身的请求上。
 *   · 现状已排查：proxy/ 下两个 setInterval（index.cjs 的签到、poolsched.cjs 的调度）都在
 *     模块 boot 期创建、不在任何 ALS 上下文内；forwarder.forward 的 finally 在 await run()
 *     之后、上下文外执行。所以当前**没有**触发路径。
 *   · 需要「请求结束后继续跑」的任务时，请在 run() **之外**启动，或在回调里显式重新进入
 *     所需的上下文。
 */
function run(policy, fn) {
  if (!policy) return fn();
  return als.run(policy, fn);
}

/** 当前生效的 policy；无上下文返回 null */
function current() {
  return als.getStore() || null;
}

/**
 * 依据当前 policy 覆盖/移除出站请求头。
 *
 * 无上下文 / policy 为空 / mode==="passthrough" / headerOverride===false →
 * **原样返回入参（同一引用）**；有头操作时返回**新对象**，绝不改写入参。
 */
function applyHeaders(headers) {
  const policy = als.getStore();
  if (!policy) return headers;
  if (policy.mode === "passthrough") return headers;
  if (policy.headerOverride === false) return headers;
  const ops = policy.__headerOps;
  if (!ops) return headers;

  const remove = ops.remove;
  const setMap = ops.set;
  if (!headers || typeof headers !== "object") return headers;
  const hasRemove = !!(remove && remove.size);
  const setKeys = setMap ? Object.keys(setMap) : [];
  if (!hasRemove && !setKeys.length) return headers;

  // ① 搬运并剔除要删的头。比较一律小写：HTTP 头名本身不区分大小写。
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (hasRemove && remove.has(k.toLowerCase())) continue;
    out[k] = v;
  }

  // ② 覆盖：大小写不敏感命中已有键时写回**原键名**——另起一个不同大小写的同名键
  //    会在线上变成重复头（`User-Agent` 与 `user-agent` 并存），上游行为不可预期；
  //    命中不了才用配置里的键名新增。
  const index = new Map();
  for (const k of Object.keys(out)) index.set(k.toLowerCase(), k);
  for (const key of setKeys) {
    const lower = key.toLowerCase();
    // 移除优先（契约 §3）：同一个头既被要求移除又被要求设值时，移除胜出。
    // 两者语义强度不同——「不要发这个头」是用户显式的保守意图：少发一个头不会让请求
    // 变成伪造形态，多发一个可能。
    if (hasRemove && remove.has(lower)) continue;
    const hit = index.get(lower);
    if (hit !== undefined) { out[hit] = setMap[key]; continue; }
    out[key] = setMap[key];
    index.set(lower, key);
  }
  return out;
}

module.exports = { run, current, applyHeaders };
