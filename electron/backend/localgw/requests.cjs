"use strict";
const active = new Map();
const { authority } = require("../extensions/authority-watch.cjs");

function begin(id, controller, keyPrefix) {
  if (active.size >= 512) throw new Error("QUEUE_FULL");
  const item = { id, keyPrefix: keyPrefix || "", startedAt: Date.now(), phase: "读取请求", channel: "", model: "", attempts: 0, controller };
  active.set(id, item);
  return item;
}

function list() {
  return [...active.values()].map(({ controller, ...item }) => ({ ...item, elapsedMs: Date.now() - item.startedAt }));
}

function cancel(id) {
  const item = active.get(String(id));
  if (!item) return { ok: false, message: "请求已结束或不存在" };
  item.controller.abort(new Error("操作员取消请求"));
  item.phase = "正在取消";
  return { ok: true };
}

function end(id) { active.delete(id); }

module.exports = { begin, list, cancel, end, watchAuthority: authority.watch, recheckAuthority: authority.recheck };
