// CatPaw 消息指纹与指纹链（移植来源：参照实现 catpaw/fingerprint.rs，其上游是
// catpaw-upstream-messages.mjs 的 messageFingerprint 与 catpaw-upstream-client.mjs 的增量定位）。
//
// 指纹的用途：CatPaw 上游是**有状态会话协议**，同一客户端会话复用同一个 conversationId，
// 后续轮次的 round 只提交「增量消息」。代理要回答「客户端这次提交的历史里哪一段上游已经见过」，
// 办法是给每条归一化消息算稳定指纹，把已同步的指纹按序存在会话注册表里，
// 新请求到达时用最后一条已同步指纹在客户端历史里定位，之后的部分就是增量。
//
// serialization 必须与上游/参照实现逐字对齐：先摊平成字符串数组再 JSON.stringify 后取 SHA-256，
// 不对消息对象直接 stringify（那会把字段顺序、messageId 卷进来）。参与指纹的字段只有
// type/role、块的 type/text/toolCallId/toolName/toolParams/toolResult；
// 不参与的有 messageId（归一化对缺失 id 会生成随机 UUID，塞进去等于每条都不稳定）、
// finished、reasoningContent、图片 URL。
"use strict";
const crypto = require("node:crypto");

/** JS 真值判定（`x || y` / `if (x)` 语义）：null/undefined/false/0/""/NaN 为假 */
function jsTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  return true;
}

/** 空 text 块判定：`type === 'text' && !text && !reasoningContent` 才跳过。
 *  上游返回的纯工具调用消息常带一个空 text 块，而客户端回显时会把它丢掉（content 为 null），
 *  保留会让同一条消息两边指纹不同、误判历史被改写 */
function isBlankTextBlock(block) {
  if (!block || typeof block !== "object" || block.type !== "text") return false;
  return !jsTruthy(block.text) && !jsTruthy(block.reasoningContent);
}

/** 单条**归一化后**消息的指纹（64 位十六进制小写）。
 *  对应原实现 `createHash('sha256').update(JSON.stringify(parts)).digest('hex')` */
function messageFingerprint(message) {
  const parts = [];
  parts.push(jsTruthy(message && message.type) ? message.type : (jsTruthy(message && message.role) ? message.role : ""));
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      parts.push("");
      continue;
    }
    if (isBlankTextBlock(block)) continue;
    parts.push(jsTruthy(block.type) ? block.type : "");
    if (block.text !== undefined) parts.push(block.text);
    if (jsTruthy(block.toolCallId)) parts.push(block.toolCallId);
    if (jsTruthy(block.toolName)) parts.push(block.toolName);
    if (block.toolParams !== undefined) parts.push(block.toolParams);
    if (block.toolResult !== undefined) parts.push(String(block.toolResult));
  }
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** 一串归一化消息的指纹链 */
function fingerprintsFor(messages) {
  return (Array.isArray(messages) ? messages : []).map(messageFingerprint);
}

/** 在客户端本次的归一化消息里定位增量起点。
 *  只取注册表存的**最后一条**已同步指纹做从后往前查找：其位置之后即为增量。
 *  不做逐条前缀比对——客户端压缩历史是正常行为，只要最后一条能对上，
 *  中间的差异会被「整段增量重新提交」覆盖，逐条比对反而把可续接的会话判成失效 */
function locateIncrement(messages, synced) {
  const list = Array.isArray(synced) ? synced : [];
  const lastSynced = list.length ? list[list.length - 1] : "";
  if (!jsTruthy(lastSynced)) return { kind: "incremental", start: 0 };
  const fingerprints = fingerprintsFor(messages);
  for (let i = fingerprints.length - 1; i >= 0; i--) {
    if (fingerprints[i] === lastSynced) return { kind: "incremental", start: i + 1 };
  }
  return { kind: "mismatch" };
}

module.exports = { jsTruthy, messageFingerprint, fingerprintsFor, locateIncrement };
