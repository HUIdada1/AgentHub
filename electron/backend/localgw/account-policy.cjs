"use strict";
const store = require("../proxy/store.cjs");
const pool = require("../proxy/pool.cjs");

function preview(channel, model) {
  return pool.accountPlan(String(channel || ""), undefined, [], 0, String(model || "")).map((r, index) => ({
    id: r.account.id, name: r.account.name || r.account.id, position: index + 1,
    eligible: r.eligible, reason: r.reason, bucket: r.bucket,
    credits: r.account.credits, inFlight: r.inFlight, limit: r.limit,
    billingKind: r.account.meta?.gateway?.billingKind || "unknown",
  }));
}

function save(id, policy) {
  if (!policy || typeof policy !== "object") return { ok: false, message: "缺少调度配置" };
  if (!["unknown", "free", "paid", "permanent"].includes(policy.billingKind)) return { ok: false, message: "不支持的额度分类" };
  const limit = Number(policy.maxInFlight);
  if (!Number.isInteger(limit) || limit < 0 || limit > 128) return { ok: false, message: "并发上限必须为 0–128 的整数，0 表示不限" };
  const row = store.getAccount(String(id));
  if (!row) return { ok: false, message: "账号不存在" };
  let meta;
  try { meta = JSON.parse(row.meta || "{}"); } catch { return { ok: false, message: "账号元数据损坏，未写入" }; }
  store.updateAccount(String(id), { meta: { ...meta, gateway: { ...meta.gateway, billingKind: policy.billingKind, maxInFlight: limit } } });
  return { ok: true };
}

function reorder(channel, ids) {
  if (!store.listAgents().some((a) => a.id === channel)) return { ok: false, message: "渠道不存在" };
  const accounts = store.accountRows(String(channel || ""));
  if (!Array.isArray(ids) || ids.length !== accounts.length || new Set(ids).size !== ids.length || accounts.some((a) => !ids.includes(a.id))) {
    return { ok: false, message: "排序必须包含本渠道的全部账号且不能重复，请刷新后重试" };
  }
  const db = store.open();
  try {
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < ids.length; index++) {
      const row = accounts.find((a) => a.id === ids[index]);
      const meta = JSON.parse(row.meta || "{}");
      store.updateAccount(row.id, { meta: { ...meta, gateway: { ...meta.gateway, priority: index } } });
    }
    if (!store.setPoolStrategy(channel, "manual")) throw new Error("渠道不存在");
    db.exec("COMMIT");
    return { ok: true };
  } catch {
    db.exec("ROLLBACK");
    return { ok: false, message: "排序保存失败，未修改队列" };
  }
}

module.exports = { preview, save, reorder };
