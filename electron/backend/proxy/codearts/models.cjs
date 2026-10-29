/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · CodeArts 模型目录：三个源合并（agent / builtin / benefit），按 id 先到先得
//
// 三个源（各自独立，缺一个都要如实补）：
//   1. agent（Agent Center）：/v1/agent-center/agents/useragents 列账号可见 agent，再逐个
//      /v1/agent-center/agents/detail?agent_id=… 取 gpts.models —— 账号实际可用的那批；
//   2. builtin（/v1/model/builtin，**必须** Agent-Type: PromptCenter）：内置清单，换别的 agent 类型
//      上游给受限视图（看着像「这账号没有模型」）；多模态模型只在这里出现；
//   3. benefit（福利网关）：先 {base}/v1/benefit-gateway-config 看总开关，开了才去福利网关取模型。
//
// 两条实测坑：
//   * trial 账号的 agent detail 会 200 但完全没有 gpts.models —— 绝不能硬编码兜底，否则广告出一批
//     「列出来但一调就 400」的幽灵模型；
//   * 模型 id 大小写敏感（GLM-5.2 ≠ glm-5.2），客户端习惯写小写 → 需大小写无关查找并返回上游真名。
//
// 目录缓存 5 分钟（有告警时 30 秒），重启后从 catalog.json 读回不丢（含福利模型）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const signer = require("./signer.cjs");

const CACHE_TTL_MS = 5 * 60 * 1000;

// 出站统一走它：签名、脱敏与错误信封只在这一处发生，调用点不必各自重复
async function signedJson(credential, base, method, p, body, fetchImpl) {
  const url = `${base}${p}`;
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
  const headers = [["Content-Type", "application/json"]];
  const signed = signer.sign(method, url, headers, payload || Buffer.alloc(0), credential, false);
  // snap-access 的路由头（Agent-Type/X-Language）不参与签名：签进去反而验不过，必须在签名后追加
  for (const [k, v] of Object.entries({ "Agent-Type": "PromptCenter", "X-Language": "zh-cn" })) signed.push([k, v]);
  const fetchFn = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let resp;
  try {
    resp = await fetchFn(url, {
      method,
      headers: Object.fromEntries(signed),
      body: payload || undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, message: String((e && e.message) || e) };
  }
  clearTimeout(timer);
  let data = null;
  try { data = await resp.json(); } catch { /* 非 JSON */ }
  return { ok: resp.ok, status: resp.status, data };
}

// 归一一条模型为目录形态；source 标记来自哪一源（agent / builtin / benefit）
function normalizeEntry(id, source, extra) {
  return {
    id: String(id || "").trim(),
    name: String((extra && extra.name) || id || "").trim(),
    rate: null,
    capabilities: {
      images: !!(extra && extra.images),
      reasoning: !!(extra && extra.reasoning),
      tools: true,
    },
    contextLength: Number((extra && extra.contextLength) || 0),
    maxOutputTokens: 0,
    source,
  };
}

// 三源合并：先 agent、再 builtin、最后 benefit，按 id 大小写不敏感先到先得
function mergeCatalog(agentModels, builtinModels, benefitModels) {
  const out = [];
  const seen = new Set();
  const push = (list, source) => {
    for (const m of list || []) {
      const id = String((m && (m.id || m.model_id || m.modelId)) || "").trim();
      if (!id) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalizeEntry(id, source, m));
    }
  };
  push(agentModels, "agent");
  push(builtinModels, "builtin");
  push(benefitModels, "benefit");
  return out;
}

// 福利模型判定（大小写无关）：命中即本批全是福利模型（冷却时整组冷却）
function isBenefitId(catalog, modelId) {
  const key = String(modelId || "").toLowerCase();
  return (catalog || []).some((m) => m.source === "benefit" && String(m.id).toLowerCase() === key);
}

// 大小写无关查找并返回上游真名（客户端小写 glm-5.2 → 上游 GLM-5.2）
function resolveModelId(catalog, requested) {
  const key = String(requested || "").trim().toLowerCase();
  if (!key) return null;
  const hit = (catalog || []).find((m) => String(m.id).toLowerCase() === key);
  return hit ? hit.id : null;
}

module.exports = { signedJson, mergeCatalog, isBenefitId, resolveModelId, normalizeEntry, CACHE_TTL_MS };
