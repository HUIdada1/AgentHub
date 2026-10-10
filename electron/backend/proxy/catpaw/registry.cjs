// CatPaw 会话注册表：x-session-id → conversationId 映射 + 指纹链 + 工具续接索引 + 账号身份归属
// （移植来源：参照实现 catpaw/registry/{mod,identity,cleanup}.rs，其上游是 session-registry.mjs）。
// **纯内存数据结构：不读盘、不发网络请求、不持锁**。
//
// 它记住什么 / 回答什么：
//   | 记住什么                     | 回答什么问题                                   |
//   | x-session-id → conversationId | 这次请求该复用哪个 conversation（还是新建）     |
//   | 已同步消息的指纹链             | 客户端历史里哪一段上游已经见过（增量从哪开始）   |
//   | modelType                     | 模型换了没有（换了必须重建：不同模型不可续接）   |
//   | 待响应的 tool_call_id          | 这次请求是「工具续接」（turn 提交 tool 结果）    |
//   | 在途占用                       | 同 session 已有流式请求在跑（新请求走独立会话）  |
//
// 这些状态只在进程内：进程重启后注册表为空，客户端下一轮自然走「全新会话全量 round」，
// 功能不受影响，只是那一轮多传一次历史。
//
// 账号身份归属有两个维度，都只做相等判定，空值不是通配：
//   · accountId（账号记录 id；空 = 无账号身份：环境变量旁路 / 默认登录态）；
//   · userId（本次实际使用凭证里的 uid/loginName）——桌面端实时登录态由 CatPaw 客户端自己维护，
//     用户可以在客户端里换号登录，那时 accountId 不变、只有 uid 变了，靠这个维度识别。
"use strict";

const log = require("./log.cjs");

/** 长会话（带 x-session-id 的普通轮次）存活时间：2 小时 —— 用户对话的「连续感」窗口 */
const CLIENT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** **工具续接**会话存活时间：10 分钟 —— 工具结果紧接着就要提交，超时说明这一轮已放弃 */
const CLIENT_TOOL_SESSION_TTL_MS = 10 * 60 * 1000;
/** 注册表容量上限：客户端每次都发新 session id 时（工具型客户端）防止无界增长 */
const MAX_CLIENT_SESSIONS = 200;

/** 一条会话记录（原实现的 clientSessions / pendingClientToolSessions 在那边是两个 Map，这里合成一个类型） */
function sessionRecord({
  conversationId,
  fingerprints,
  modelType,
  accountId,
  createdAt,
  inflight = false,
  sessionId,
  pendingCallIds = [],
  turnRequestId = null,
}) {
  return {
    conversationId: String(conversationId || ""),
    fingerprints: Array.isArray(fingerprints) ? fingerprints : [],
    modelType: Number(modelType) || 0,
    accountId: String(accountId || ""),
    createdAt: Number(createdAt) || 0,
    lastActiveAt: 0,
    inflight: !!inflight,
    sessionId: String(sessionId || ""),
    pendingCallIds: Array.isArray(pendingCallIds) ? pendingCallIds : [],
    turnRequestId: turnRequestId || null,
  };
}

/** 记录的 TTL：带客户端会话 id 的一律 2 小时（工具会话只要挂在长会话上就跟着走）；
 *  只有匿名工具会话（客户端没给 session id、纯靠 tool_call_id 续接）才是 10 分钟 */
function ttlMs(record) {
  return record.sessionId ? CLIENT_SESSION_TTL_MS : CLIENT_TOOL_SESSION_TTL_MS;
}

function isExpired(record, now) {
  return now >= record.lastActiveAt + ttlMs(record);
}

function isAwaitingToolResults(record) {
  return record.pendingCallIds.length > 0;
}

/** 账号身份（两个维度都只做相等判定） */
function identityOf(accountId, userId) {
  return { accountId: String(accountId || ""), userId: String(userId || "") };
}

function identityMatches(a, b) {
  return a.accountId === b.accountId && a.userId === b.userId;
}

const REASONS = {
  SyncMismatch: "sync-mismatch",
  ModelMismatch: "model-mismatch",
  AccountMismatch: "account-mismatch",
  IdentityChanged: "identity-changed",
  Expired: "expired",
  EvictedCapacity: "evicted-capacity",
  Replaced: "replaced-by-new-conversation",
  AccountSwitch: "account-switch",
  UpstreamRejected: "upstream-rejected",
  Explicit: "explicit",
};

class SessionRegistry {
  constructor() {
    this.sessions = new Map(); // x-session-id → record
    this.anonymous = new Map(); // conversationId → record（客户端没给 session id 的匿名工具会话）
    this.callIndex = new Map(); // tool_call_id → conversationId（工具续接索引）
    this.inflight = new Set(); // 在途占用的 session id（权威来源）
    this.recordIdentities = new Map(); // conversationId → identity（建立时的账号身份）
    this.currentIdentities = new Map(); // accountId → identity（本次请求实际使用的身份）
    this.inflightIdentities = new Map(); // sessionId → identity（占用时捕获）
    this.sequence = 0; // LRU 单调序号（毫秒时间戳同毫秒会打平，单调序号让淘汰完全确定）
    this.lastSequence = new Map(); // conversationId → 序号
    this.generation = 0; // 整表作废次数（排障用）
  }

  /** 这次请求能不能占用该会话。false = 同一 session id 已有流式请求在跑，调用方必须改走独立 conversation。
   *  session id 为空时不占用、返回 true（无状态请求不受并发保护约束） */
  markInflight(sessionId, identity) {
    if (!sessionId) return true;
    if (this.inflight.has(sessionId)) return false;
    this.inflight.add(sessionId);
    // 占用与「本轮用哪个身份出网」是同一时刻的事，而登记发生在流结束之后——
    // 中间用户可能在客户端换了号。按占用捕获，收尾时才知道这条会话是用哪个身份建的
    this.inflightIdentities.set(sessionId, identity || identityOf("", ""));
    const record = this.sessions.get(sessionId);
    if (record) record.inflight = true;
    return true;
  }

  /** 释放占用（RAII 语义由调用方的 finally 保证幂等） */
  releaseInflight(sessionId) {
    if (!sessionId) return false;
    const removed = this.inflight.delete(sessionId);
    this.inflightIdentities.delete(sessionId);
    const record = this.sessions.get(sessionId);
    if (record) record.inflight = false;
    return removed;
  }

  isInflight(sessionId) {
    return !!sessionId && this.inflight.has(sessionId);
  }

  /** 解析「这次请求该复用还是重建」：先清理过期 → 查 session id → 模型/账号/身份三项一致判定 */
  resolve(sessionId, modelType, accountId) {
    const now = Date.now();
    this._cleanupExpired(now);
    if (!sessionId) return { kind: "rebuild", reason: null };
    const record = this.sessions.get(sessionId);
    if (!record) return { kind: "rebuild", reason: null };
    if (record.modelType !== Number(modelType)) {
      this._invalidate(sessionId, REASONS.ModelMismatch);
      return { kind: "rebuild", reason: REASONS.ModelMismatch };
    }
    if (record.accountId !== String(accountId || "")) {
      this._invalidate(sessionId, REASONS.AccountMismatch);
      return { kind: "rebuild", reason: REASONS.AccountMismatch };
    }
    if (!this._identityConsistent(record)) {
      this._invalidate(sessionId, REASONS.IdentityChanged);
      return { kind: "rebuild", reason: REASONS.IdentityChanged };
    }
    record.lastActiveAt = now;
    record.inflight = this.inflight.has(sessionId);
    this.sessions.set(sessionId, record);
    this._touch(record.conversationId);
    return { kind: "reuse", record };
  }

  /** 登记（覆盖写）一条会话记录：先顶替同 session 的旧记录 → 表满淘汰 LRU → 写入 + 重建 call 索引。
   *  身份从表里取（占用捕获优先，其次账号级对账写下的本次身份），两条都没有则不记身份（比记错好） */
  register(record) {
    const now = Date.now();
    record.lastActiveAt = now;
    const identity = this.inflightIdentities.get(record.sessionId)
      || this.currentIdentities.get(record.accountId);
    if (identity) this.recordIdentities.set(record.conversationId, identity);
    if (!record.sessionId) {
      this._registerAnonymous(record);
      return;
    }
    const previous = this.sessions.get(record.sessionId);
    if (previous) {
      if (previous.conversationId !== record.conversationId) {
        this._invalidate(record.sessionId, REASONS.Replaced);
      } else {
        this._clearCallIndex(previous);
      }
    }
    if (this.sessions.size >= MAX_CLIENT_SESSIONS && !this.sessions.has(record.sessionId)) {
      this._evictLru();
    }
    record.inflight = this.inflight.has(record.sessionId);
    this._touch(record.conversationId);
    this._indexCalls(record);
    this.sessions.set(record.sessionId, record);
  }

  /** 按 tool_call_id 找待响应的会话（工具续接判定用）。身份不符的记录不返回
   *  （让调用方走全新会话，比把 tool 结果提交到上一个用户的会话里安全） */
  lookupByCallId(callId) {
    if (!callId) return null;
    const conversationId = this.callIndex.get(callId);
    if (!conversationId) return null;
    let record = null;
    for (const item of this.sessions.values()) {
      if (item.conversationId === conversationId) {
        record = item;
        break;
      }
    }
    if (!record) record = this.anonymous.get(conversationId) || null;
    if (!record) return null;
    if (!this._identityConsistent(record)) return null;
    return record;
  }

  /** 按 conversationId 找记录（排障与将来的显式续接入口用） */
  lookupByConversation(conversationId) {
    if (!conversationId) return null;
    for (const record of this.sessions.values()) {
      if (record.conversationId === conversationId) return record;
    }
    return this.anonymous.get(conversationId) || null;
  }

  /** 作废一条客户端会话（同时清 call 索引——少了这一步，下次带旧 tool_call_id 的请求会命中已消失的会话） */
  invalidate(sessionId, reason) {
    if (!sessionId) return null;
    return this._invalidate(sessionId, reason);
  }

  /** 按 conversationId 作废（只拿得到 conversationId 的入口用） */
  invalidateByConversation(conversationId, reason) {
    if (!conversationId) return null;
    for (const [sessionId, record] of this.sessions) {
      if (record.conversationId === conversationId) return this._invalidate(sessionId, reason);
    }
    return this._removeAnonymous(conversationId, reason);
  }

  /** 整表作废（全局重置语义），返回清掉的条数 */
  clearAll() {
    const count = this.sessions.size + this.anonymous.size;
    this.sessions.clear();
    this.anonymous.clear();
    this.callIndex.clear();
    this.lastSequence.clear();
    this.recordIdentities.clear();
    this.generation += 1;
    return count;
  }

  /** 只作废属于某账号的记录（多账号并存的精细版）。accountId 为空 = 作废无账号身份的记录 */
  clearAccount(accountId) {
    const wanted = String(accountId || "");
    let count = 0;
    const sessionIds = [];
    for (const [sessionId, record] of this.sessions) {
      if (record.accountId === wanted) sessionIds.push(sessionId);
    }
    for (const sessionId of sessionIds) {
      if (this._invalidate(sessionId, REASONS.AccountSwitch)) count += 1;
    }
    const anonymousIds = [];
    for (const [conversationId, record] of this.anonymous) {
      if (record.accountId === wanted) anonymousIds.push(conversationId);
    }
    for (const conversationId of anonymousIds) {
      if (this._removeAnonymous(conversationId, REASONS.AccountSwitch)) count += 1;
    }
    return count;
  }

  /** 账号身份对账（转发选路时调）：本次实际使用的凭证身份与注册表里记着的该账号身份比对，
   *  不一致 = 用户在客户端侧换了号（accountId 不变），该账号名下的会话全部作废。
   *  身份没变时 O(1) 早退（一次 Map 查 + 一次比较），不扫表 */
  reconcileIdentity(identity) {
    const accountId = String((identity && identity.accountId) || "");
    const known = this.currentIdentities.get(accountId);
    if (known && identityMatches(known, identity)) return 0;
    const previous = this.currentIdentities.has(accountId);
    this.currentIdentities.set(accountId, identity);
    if (!previous) {
      // 第一次见到该账号：表里那些记录没有身份信息（本进程还没学过它的身份），
      // 不能假定它们属于谁——只记身份，不动记录（它们由 resolve 的账号维度判定）
      return 0;
    }
    let count = 0;
    const victims = [];
    for (const [sessionId, record] of this.sessions) {
      if (record.accountId !== accountId) continue;
      const recorded = this.recordIdentities.get(record.conversationId);
      if (recorded && !identityMatches(recorded, identity)) victims.push(sessionId);
    }
    for (const sessionId of victims) {
      if (this._invalidate(sessionId, REASONS.IdentityChanged)) count += 1;
    }
    const anonymousVictims = [];
    for (const [conversationId, record] of this.anonymous) {
      if (record.accountId !== accountId) continue;
      const recorded = this.recordIdentities.get(conversationId);
      if (recorded && !identityMatches(recorded, identity)) anonymousVictims.push(conversationId);
    }
    for (const conversationId of anonymousVictims) {
      if (this._removeAnonymous(conversationId, REASONS.IdentityChanged)) count += 1;
    }
    return count;
  }

  stats() {
    return {
      generation: this.generation,
      sessions: this.sessions.size,
      anonymousToolSessions: this.anonymous.size,
      inflight: this.inflight.size,
    };
  }

  // ===== 内部 =====

  _cleanupExpired(now) {
    const expired = [];
    for (const [sessionId, record] of this.sessions) {
      if (isExpired(record, now)) expired.push(sessionId);
    }
    for (const sessionId of expired) this._invalidate(sessionId, REASONS.Expired);
    const expiredAnonymous = [];
    for (const [conversationId, record] of this.anonymous) {
      if (isExpired(record, now)) expiredAnonymous.push(conversationId);
    }
    for (const conversationId of expiredAnonymous) this._removeAnonymous(conversationId, REASONS.Expired);
  }

  _invalidate(sessionId, reason) {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    this.sessions.delete(sessionId);
    this._clearCallIndex(record);
    this.lastSequence.delete(record.conversationId);
    this.recordIdentities.delete(record.conversationId);
    logRemoval(record, reason);
    return record;
  }

  _removeAnonymous(conversationId, reason) {
    const record = this.anonymous.get(conversationId);
    if (!record) return null;
    this.anonymous.delete(conversationId);
    this._clearCallIndex(record);
    this.lastSequence.delete(conversationId);
    this.recordIdentities.delete(conversationId);
    logRemoval(record, reason);
    return record;
  }

  _evictLru() {
    let victim = null;
    let victimSequence = Infinity;
    for (const record of this.sessions.values()) {
      const seq = this.lastSequence.has(record.conversationId) ? this.lastSequence.get(record.conversationId) : -1;
      if (seq < victimSequence) {
        victimSequence = seq;
        victim = record.sessionId;
      }
    }
    if (victim) this._invalidate(victim, REASONS.EvictedCapacity);
  }

  _registerAnonymous(record) {
    const conversationId = record.conversationId;
    const previous = this.anonymous.get(conversationId);
    this.anonymous.set(conversationId, record);
    if (previous) this._clearCallIndex(previous);
    this._touch(conversationId);
    this._indexCalls(record);
  }

  _indexCalls(record) {
    for (const callId of record.pendingCallIds) {
      if (callId) this.callIndex.set(callId, record.conversationId);
    }
  }

  _clearCallIndex(record) {
    for (const callId of record.pendingCallIds) {
      if (this.callIndex.get(callId) === record.conversationId) this.callIndex.delete(callId);
    }
  }

  _touch(conversationId) {
    this.sequence += 1;
    this.lastSequence.set(conversationId, this.sequence);
  }

  /** 身份维度的**唯一判据**：resolve（按 session id 续接）与 lookupByCallId（按 tool_call_id 续接）
   *  必须给同一结论。两侧任一缺失即视为一致（没有可比对的两方时，退回账号维度比误判成换号安全） */
  _identityConsistent(record) {
    const recorded = this.recordIdentities.get(record.conversationId);
    const current = this.currentIdentities.get(record.accountId);
    if (recorded && current) return identityMatches(recorded, current);
    return true;
  }
}

/** 会话被移除时的日志：只打元数据（id 前 8 位、指纹条数、原因），不含消息正文（隐私口径） */
function logRemoval(record, reason) {
  log.verbose(`session-remove reason=${reason} sessionId=${shortId(record.sessionId)} conversationId=${shortId(record.conversationId)} syncedCount=${record.fingerprints.length}`);
}

function shortId(value) {
  const text = String(value || "");
  if (!text) return "-";
  return text.slice(0, 8);
}

// 进程级单例：会话映射必须跨请求共享（适配器本身是无状态单例）
const singleton = new SessionRegistry();

module.exports = {
  SessionRegistry,
  registry: singleton,
  sessionRecord,
  isExpired,
  ttlMs,
  isAwaitingToolResults,
  identityOf,
  shortId,
  CLIENT_SESSION_TTL_MS,
  CLIENT_TOOL_SESSION_TTL_MS,
  MAX_CLIENT_SESSIONS,
  REASONS,
};
