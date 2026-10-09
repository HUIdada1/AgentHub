// 反代网关 · 日志脱敏：错误文本在落库前抹掉凭据形态的片段。
// 上游报错常回显请求头或回显体（Bearer xxx / accessToken=… / eyJ 开头的 JWT），
// 原样落 op_logs / 账号最近错误等于把凭据写进磁盘与日志页导出的 Excel。
// 只做「凭据形态」的部分打码：正常错误文案（模型名/状态码/中文提示）不受影响
"use strict";

// 三段式 JWT（eyJ 开头，header.payload.signature）
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
// Bearer 长串（请求头回显）
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
// 键值对形态：refreshToken=… / "accessToken": "…" / authorization: …（值取 token 形态长串；
// 键名后的闭引号一并保留；中文文案与短数字不受影响——\btoken\b 不会命中 "tokens"，
// 值不足 12 位不打码）
const KV_RE = /\b(access[-_]?token|refresh[-_]?token|api[-_]?key|authorization|password|secret|token|jwt)(["']?)(\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi;
// 裸空格形态：token 1234567890abcdef（无 :/= 分隔）。只打码十六进制长串，
// 避免 "token authentication failed" 这类正常英文文案被误伤
const BARE_RE = /\b(token|jwt|apikey|api[-_]key)\s+([A-Fa-f0-9]{16,})\b/g;

/** 抹掉文本里的凭据片段（任何落库的日志/错误文本都过这里） */
function redact(value) {
  const s = String(value == null ? "" : value);
  if (!s) return s;
  return s
    .replace(JWT_RE, "<redacted-jwt>")
    .replace(BEARER_RE, "$1 <redacted>")
    .replace(KV_RE, "$1$2$3<redacted>")
    .replace(BARE_RE, "$1 <redacted>");
}

module.exports = { redact };
