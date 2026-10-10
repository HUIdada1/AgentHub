// CatPaw 协议层的排障日志：只在显式打开调试开关（环境变量 CATPAW_DEBUG=1）时输出到控制台。
//
// 为什么不进 oplog：op_logs 是给用户看的操作日志（网关启停 / 号池 / 签到 / 代理请求），
// 而这里都是协议层内部节点（轮次模式、增量条数、注册表写回、会话作废原因）——
// 每轮对话十来条，进用户日志只会刷屏。出问题时打开开关即可拿到与参照实现等价的诊断信息。
//
// 口径：只打元数据（模型档位 / 消息条数 / id 前 8 位 / 指纹条数），**不落消息正文与思考内容**。
"use strict";

function enabled() {
  const v = process.env.CATPAW_DEBUG;
  return !!v && v !== "0" && v !== "false";
}

function verbose(message) {
  if (!enabled()) return;
  try {
    console.log(`[CatPaw] ${message}`);
  } catch {
    /* 控制台不可用（打包后无 stdout）时静默 */
  }
}

module.exports = { verbose, enabled };
