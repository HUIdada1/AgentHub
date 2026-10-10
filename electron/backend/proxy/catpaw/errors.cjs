// CatPaw 协议层错误（移植来源：参照实现 catpaw/models.rs 的 CatPawError）。
// 与通用 Error 的差别：上游失败时除了文案还要回报 `event(status, failReason, failCode, unifyCode)`，
// 两个业务码来自上游错误体的 code / unifyCode，上游侧排障靠它们。
//
// 与 AgentHub 现有适配器的接口约定：抛出的错误对象带 `status` 字段（server.cjs 的
// classifyUpstream 会读 e.status / e.code），`fatal` 决定是否直接透传不再换号：
// 入参错误（400）与「上游明确拒绝本次请求」属 fatal，账号故障类（401/5xx）不设。
"use strict";

class CatPawError extends Error {
  constructor(status, message, { code = null, unifyCode = null, fatal = false } = {}) {
    super(String(message));
    this.name = "CatPawError";
    this.status = Number(status) || 502;
    this.code = code;
    this.unifyCode = unifyCode;
    this.fatal = fatal;
  }

  /** 入参错误（400，客户端可见中文文案，不换号不重试） */
  static badRequest(message) {
    return new CatPawError(400, message, { fatal: true });
  }

  /** 上游/传输错误（502） */
  static upstream(message) {
    return new CatPawError(502, message);
  }

  /** 上游 HTTP 错误：4xx 原样、其余折成 502（照抄参照实现的归一规则）。
   *  401 交给通用分类器走刷新/换号；403/404 等保留原状态码便于排障 */
  static http(status, message, extra = {}) {
    const mapped = status >= 400 && status < 500 ? Number(status) : 502;
    return new CatPawError(mapped, message, extra);
  }
}

module.exports = CatPawError;
