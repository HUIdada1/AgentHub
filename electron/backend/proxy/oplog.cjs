// 反代网关 · 操作日志：各项操作一条一条落库（op_logs 表，存储在 stats.db），写入永不抛错——
// 日志失败绝不能反噬业务动作本身（代理请求 / 签到 / 切号等照常完成）。
// 等级口径：info=成功/常规动作；warn=降级/需人工/4xx；error=失败/5xx/网络异常/ok:false。
// 查询 / 导出走 IPC（proxy_oplog_list / proxy_oplog_ops / proxy_oplog_export），
// 前端入口在反代网关「日志」页签（ProxyLogView.vue）。
"use strict";
const store = require("./store.cjs");
const redact = require("./redact.cjs");

/** 记一条操作日志。extra: { channel, target, detail }（可省）。
 *  message/detail 落库前过脱敏（上游报错常回显 Bearer/JWT，原样落库等于凭据进磁盘与导出 Excel） */
function log(level, op, message, extra) {
  try {
    store.insertOpLog({
      level,
      op,
      message: redact(message),
      channel: (extra && extra.channel) || "",
      target: (extra && extra.target) || "",
      detail: redact((extra && extra.detail) || ""),
    });
  } catch { /* 日志失败不影响业务 */ }
}

/** 分页列表（时间倒序）：{ from, to, level, op, limit, offset } → { rows, total } */
function list(filter) {
  try {
    return store.listOpLogs(filter || {});
  } catch {
    return { rows: [], total: 0 };
  }
}

/** 操作类型下拉（去重；失败返回空数组，不阻断筛选栏使用） */
function listOps() {
  try {
    return store.listOpLogOps();
  } catch {
    return [];
  }
}

/** 导出全集（与列表同一套筛选，无分页）；失败返回空数组由导出入口提示「没有记录」 */
function exportRows(filter) {
  try {
    return store.exportOpLogRows(filter || {});
  } catch {
    return [];
  }
}

module.exports = { log, list, listOps, exportRows };
