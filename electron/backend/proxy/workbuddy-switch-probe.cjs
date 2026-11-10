/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";
// Management-only pre-switch check. There is deliberately no user body/model/URL
// parameter, content callback, model response conversion or general chat method.
const crypto = require("node:crypto");
const rules = require("./rules.cjs");
const util = require("./util.cjs");
const { fetchStream, pumpSse, firstByteBudgetMs } = require("../network/http.cjs");

function blocked(error) {
  if (!error) return false;
  if (Number(error.code) === 11140) return true;
  const text = String(error.body || error.message || "");
  return /\b11140\b/.test(text) || /request illegal/i.test(text);
}

function fixedPayload(account) {
  const messages = [
    { role: "system", content: "You are CodeBuddy, an AI coding assistant." },
    { role: "user", content: "hi" },
  ];
  const replacements = rules.get("wb_template_map.json") || {};
  const cleaned = messages.map(message => {
    let text = message.content;
    for (const [from, to] of Object.entries(replacements)) {
      if (from) text = text.split(from).join(to);
    }
    text = text.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "")
      .replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "")
      .replace(/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr");
    return { role: message.role, content: text };
  });
  const conversation = util.stableConvId(messages) || util.uuid();
  return JSON.stringify({
    model: "default-model", max_tokens: 1, messages: cleaned,
    stream: true, stream_options: { include_usage: true },
    conversation_id: conversation,
    prompt_cache_key: util.promptCacheKey((account && account.uid) || "", conversation),
  });
}

function probeHeaders() {
  const request = crypto.randomBytes(16).toString("hex");
  const message = crypto.randomBytes(16).toString("hex");
  return {
    "x-conversation-request-id": request,
    "x-conversation-message-id": message,
    "x-request-id": message,
    "x-root-request-id": request,
    "x-trace-id": request,
    "x-b3-traceid": request,
    "x-b3-spanid": message.slice(0, 16),
    "x-b3-sampled": "1",
  };
}

// These two functions are internal management dependencies, not RPC parameters.
// The caller retains the existing regional configuration and credential headers.
function createSwitchProbe({ getConfig, readHeaders }) {
  if (typeof getConfig !== "function" || typeof readHeaders !== "function") {
    throw new TypeError("Switch probe requires management configuration and headers");
  }
  return async function probeChat(account, secrets) {
    let cancelTimer = () => {};
    let streamError = null;
    try {
      const config = getConfig();
      const payload = fixedPayload(account);
      const headers = { ...readHeaders(account, secrets), ...probeHeaders() };
      let response = null;
      let lastError = null;
      for (const url of [config.chatUrl, config.consoleChatUrl].filter(Boolean)) {
        try {
          const result = await fetchStream(url, {
            method: "POST", headers, body: payload,
            firstByteMs: firstByteBudgetMs(payload),
          });
          response = result.resp;
          cancelTimer = result.cancelTimer;
          break;
        } catch (error) {
          lastError = error;
          if (!error || (error.status !== 404 && error.status !== 405)) throw error;
        }
      }
      if (!response) throw lastError || new Error("上游不可达");
      let firstEvent = true;
      await pumpSse(response, (_event, raw) => {
        if (firstEvent) { firstEvent = false; cancelTimer(); }
        if (raw === "[DONE]") return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        if (data && data.error) {
          // Match the original last-error behavior. No model content escapes.
          streamError = {
            code: Number(data.error.code) || 0,
            message: String(data.error.message || "") || "insufficient credits",
          };
        }
      });
    } catch (error) {
      if (blocked(error)) return { ok: false, blocked: true, message: String((error && error.message) || error) };
      return { ok: false, inconclusive: true, message: String((error && error.message) || error) };
    } finally {
      cancelTimer();
    }
    if (streamError && blocked(streamError)) return { ok: false, blocked: true, message: String(streamError.message || "") };
    return { ok: true };
  };
}

module.exports = { createSwitchProbe };
