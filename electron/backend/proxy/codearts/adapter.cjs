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
// 反代网关 · CodeArts 渠道适配器（华为云 AI 代码助手 / snap-access）
//
// 上游不是 OpenAI 协议：请求要用 SDK-HMAC-SHA256 签名，会话是有状态的（每账号只有 3 路并发），
// 凭据是 OAuth/PKCE 换来的临时三元组、到期前 15 分钟就要续。对话要先过本地准入再占会话、签名发送、
// 首包门把响应按住（空回答当失败，否则降级链永不触发）、透传/折叠，结束时释放会话。
//
// 三块必须写成可单独调用的纯函数的逻辑（流内错误 / 首包门 / 聚合）：
//   * 流内错误信封不能当内容发出去（stream_fault.cjs）——判错就丢账号；
//   * 首包门：发出第一字节之前把响应按住；流干净结束却一个字都没答 → 空回答当失败；
//   * 聚合：非流式把 SSE 折叠成一条 completion，只有 reasoning 没有 content 的回复按「有内容」计
//     （max_tokens 给小值时上游只吐 reasoning，按 content 判空会把一次成功报成失败）。
//
// 签名参与三个必带模型头（model-id / model-name / x-model-id，值都是上游模型名），福利模型额外带
// maas_type: benefit；这些头**参与签名**，必须与 body 一起决定。
"use strict";

const signer = require("./signer.cjs");
const credentials = require("./credentials.cjs");
const session = require("./session.cjs");
const streamFault = require("./stream_fault.cjs");
const models = require("./models.cjs");
const balance = require("./balance.cjs");
const welfare = require("./welfare.cjs");
const redact = require("./redact.cjs");
const oauth = require("./oauth.cjs");

const CHAT_PATH = "/api/v2/chat/completions";
const DEFAULT_PLUGIN_NAME = "snap_vscode";
const DEFAULT_PLUGIN_VERSION = "26.9.101";
const DEFAULT_LANGUAGE = "en-us";

function makeCodeArts(deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs, store } = deps;
  const cfg = () => (rules.get("headers.json") || {}).codearts || {};
  const channel = "codearts";

  // 对话请求的三个必带模型头 + 客户端指纹 + 福利标记（全部参与签名，故与 body 一起构造）
  function chatHeaders(c, upstreamModel, benefit) {
    const headers = [
      ["Content-Type", "application/json"],
      ["Accept", "text/event-stream"],
      ["X-Plugin-Version", `Vscode_${c.pluginVersion || DEFAULT_PLUGIN_VERSION}`],
      ["X-Language", c.language || DEFAULT_LANGUAGE],
      ["plugin-name", c.pluginName || DEFAULT_PLUGIN_NAME],
      ["plugin-version", c.pluginVersion || DEFAULT_PLUGIN_VERSION],
      ["model-id", upstreamModel],
      ["model-name", upstreamModel],
      ["x-model-id", upstreamModel],
    ];
    if (benefit) headers.push(["maas_type", "benefit"]);
    return headers;
  }

  // 解析 catalog.json 的 codearts 段为目录数组（含 source / 元数据）
  function catalogEntries() {
    try {
      const file = `${rules.rulesDir()}/catalog.json`;
      const all = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
      const entry = all && all[channel];
      return entry && Array.isArray(entry.models) ? entry.models : [];
    } catch {
      return [];
    }
  }

  /** 上游基址：签名、Host 与各调用点都取同一份（headers.json 可覆盖） */
  const baseOf = () => String(cfg().base || "https://snap-access.cn-north-4.myhuaweicloud.com").replace(/\/+$/, "");

  /** 续期拿到的新凭据必须回写账号记录：不回写时进程重启后仍拿旧 AK/SK 打上游，
   *  而 refresh token 已被轮换（同一 token 只能换一次）→ 该账号只能重新登录。 */
  function persist(account, fresh) {
    if (!fresh || !fresh.refreshed || !fresh.fields || !account || !account.id) return;
    try {
      store.updateAccount(account.id, fresh.fields);
    } catch { /* 落盘失败不阻断本次请求：手上这份凭据还能用 */ }
  }

  /** 统一的凭据取用：临期主动续期 + 回写，调用点不必各自记着这一步 */
  async function credentialOf(account, secrets, force) {
    const fresh = await credentials.ensureFresh(account, secrets, !!force);
    if (fresh.ok) persist(account, fresh);
    return fresh;
  }

  return {
    id: channel,
    cfg,

    /** stateful：先占会话槽 + 签名 + 首包门 + 流内信封判定，单请求路径装不下 */
    stateful: () => true,

    models() {
      return catalogEntries().map((m) => m.id);
    },
    modelEntries() {
      return catalogEntries();
    },

    // 防御性报错：CodeArts 走会话式转发，不走单请求路径
    async chat() {
      throw Object.assign(new Error("CodeArts 走会话式转发，不走单请求路径（内部错误：编排层未按 stateful 分流）"), { status: 503 });
    },

    /**
     * 会话式转发：占槽 → 签名发送 → 首包门 → 透传/折叠，结束时释放会话。
     * 顺序有意的：先过本地准入再占上游会话（反过来满员账号会白占一个槽位立刻释放，把并发闸变成噪声）。
     */
    async chatSession({ account, secrets, model, body, emit, meta }) {
      const c = cfg();
      const base = baseOf();

      // ① 凭据（临期主动续期 + 回写，见 credentialOf）
      const fresh = await credentialOf(account, secrets, false);
      if (!fresh.ok) {
        throw Object.assign(new Error(fresh.message), { status: fresh.status || 503 });
      }
      const credential = fresh.credential;
      if (!credentials.valid(credential)) {
        throw Object.assign(new Error("CodeArts 账号缺少可用的临时凭据，请重新登录"), { status: 503 });
      }

      // ② 模型名归一：客户端习惯小写，上游要真名；福利模型带 maas_type；trial 账号不兜底
      const catalog = catalogEntries();
      if (!catalog.length) {
        throw Object.assign(new Error("CodeArts 模型目录还没拉取过：请先在模型页对该账号执行一次「获取模型」"), { status: 503 });
      }
      const upstreamModel = models.resolveModelId(catalog, model);
      if (!upstreamModel) {
        throw Object.assign(new Error(`CodeArts 目录里没有模型「${model}」（大小写已归一，仍匹配不到）`), { status: 404 });
      }
      const benefit = models.isBenefitId(catalog, upstreamModel);

      // ③ 本地准入（满员回 409，不冷却账号）；身份优先 domain+user，退账号行 id；读账号 maxConcurrent
      const identity = session.identityOf(credential, account && account.id);
      const gateOverride = account && account.maxConcurrent;
      const permit = session.acquire(identity, gateOverride);
      if (!permit.acquired) {
        throw Object.assign(new Error(permit.message), { status: 409, switchable: false });
      }

      const headers = chatHeaders(c, upstreamModel, benefit);
      const payload = Buffer.from(JSON.stringify({ ...body, model: upstreamModel, stream: true }), "utf8");
      const url = `${base}${c.chatPath || CHAT_PATH}`;
      const firstByteMs = firstByteBudgetMs(payload.toString("utf8"));

      // 签名（include_host=false，snap-access 不带 Host 进签名）
      const signedHeaders = signer.sign("POST", url, headers, payload, credential, false);

      let resp = null;
      let cancelTimer = () => {};
      let settled = false;
      let sawAnyAnswer = false; // 首包门 + 聚合共用
      let reasoningBuf = "";
      let contentBuf = "";
      const toolAccum = [];
      const result = { status: 200 };
      let streamErr = null;

      try {
        const r = await fetchStream(url, {
          method: "POST",
          headers: Object.fromEntries(signedHeaders),
          body: payload,
          firstByteMs,
        });
        resp = r.resp;
        cancelTimer = r.cancelTimer;
      } catch (e) {
        permit.release();
        throw e;
      }

      try {
        await pumpSse(resp, (_event, raw) => {
          if (!settled) { settled = true; cancelTimer(); }
          if (!raw) return;
          if (raw === streamFault.DONE_SENTINEL) {
            emit({ type: "finish", reason: toolAccum.length ? "tool_calls" : "stop" });
            return;
          }
          // 流内错误信封：不能当内容发出去（判错就丢账号）
          const fault = streamFault.streamFrameFault(raw);
          if (fault) {
            streamErr = streamFault.faultToError(fault);
            emit({ type: "error", status: streamErr.status, code: streamErr.code, message: redact.redactValues(streamErr.message, redact.secretMaterial(credential)) });
            return;
          }
          let chunk = null;
          try { chunk = JSON.parse(raw); } catch { return; }
          if (!chunk || typeof chunk !== "object") return;
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          const delta = (choice && choice.delta) || {};
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoningBuf += delta.reasoning_content;
            sawAnyAnswer = true;
            emit({ type: "delta", delta: { reasoning_content: delta.reasoning_content } });
          }
          if (typeof delta.content === "string" && delta.content) {
            contentBuf += delta.content;
            sawAnyAnswer = true;
            emit({ type: "delta", delta: { content: delta.content } });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const idx = Number(call.index) || toolAccum.length;
              toolAccum[idx] = toolAccum[idx] || { id: "", name: "", arguments: "" };
              const slot = toolAccum[idx];
              if (call.id) slot.id = call.id;
              if (call.function && call.function.name) slot.name = call.function.name;
              if (call.function && typeof call.function.arguments === "string") slot.arguments += call.function.arguments;
            }
            if (delta.tool_calls.length) {
              sawAnyAnswer = true;
              emit({ type: "delta", delta: { tool_calls: delta.tool_calls } });
            }
          }
          if (choice && choice.finish_reason) {
            emit({ type: "finish", reason: choice.finish_reason });
          }
          if (chunk.usage) {
            emit({
              type: "usage",
              usage: {
                ...chunk.usage,
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              },
            });
          }
        });
      } finally {
        cancelTimer();
        permit.release(); // 两条收尾路径都必须走到 release（出错分支显式释放）
      }

      // 首包门 + 聚合判空：流干净结束却一个字都没答（连 reasoning 都没有）→ 空回答当失败，
      // 否则跨账号降级链永远不会被触发；只有 reasoning 没有 content 按「有内容」计（max_tokens 小值时上游只吐 reasoning）。
      if (!sawAnyAnswer && !streamErr) {
        throw Object.assign(new Error("CodeArts 上游返回了空回答（流结束但没有任何内容）"), { status: 502 });
      }
      return result;
    },

    // 上游错误分类（扩展点）：额度 → 403 换号；限流 → 429；AK/SK 失效 → 401 续期
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      if (status === 403 || (e && e.code === "insufficient_quota")) return { kind: "quota", switchable: true, status: 403 };
      if (status === 429) return { kind: "quota", switchable: true, status: 429 };
      if (status === 401 || status === 403) return { kind: "auth", switchable: false, status: 401 };
      return null;
    },

    // 拉模型目录（三源合并，见 models.cjs）；写回 catalog.json 的 codearts 段
    async fetchModels(account, secrets, opts) {
      const c = cfg();
      const base = String(c.base || "https://snap-access.cn-north-4.myhuaweicloud.com").replace(/\/+$/, "");
      const fresh = await credentials.ensureFresh(account, secrets, false);
      if (!fresh.ok) return { ok: false, message: fresh.message };
      const credential = fresh.credential;
      if (!credentials.valid(credential)) return { ok: false, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };

      // agent 源：列账号可见 agent，逐个 detail 取 gpts.models
      const agentModels = [];
      try {
        const list = await models.signedJson(credential, base, "GET",
          "/v1/agent-center/agents/useragents?offset=0&limit=100&is_primary_agent=true&supported_client=VSCODE&min_compatible_plugin_version=26.9.101");
        const agents = list.data && Array.isArray(list.data.agents) ? list.data.agents : [];
        for (const agent of agents) {
          const id = agent && agent.agent_id;
          if (!id) continue;
          const detail = await models.signedJson(credential, base, "GET", `/v1/agent-center/agents/detail?agent_id=${encodeURIComponent(id)}`);
          const gpts = detail.data && detail.data.gpts;
          if (gpts && Array.isArray(gpts.models)) {
            for (const m of gpts.models) agentModels.push({ id: m.model_id || m.modelId || m.id, name: m.model_name || m.name });
          }
        }
      } catch { /* agent 源失败不阻断其它源 */ }

      // builtin 源：必须 Agent-Type: PromptCenter（多模态模型只在这里）
      const builtinModels = [];
      try {
        const url = `${base}/v1/model/builtin`;
        const payload = null;
        const signed = signer.sign("GET", url, [["Content-Type", "application/json"], ["Agent-Type", "PromptCenter"]], Buffer.alloc(0), credential, false);
        const resp = await (globalThis.fetch)(url, { method: "GET", headers: Object.fromEntries(signed) });
        if (resp.ok) {
          const data = await resp.json().catch(() => null);
          const list = data && Array.isArray(data.models) ? data.models : (Array.isArray(data) ? data : []);
          for (const m of list) builtinModels.push({ id: m.model_id || m.id, name: m.model_name || m.name, images: m.multimodal === true });
        }
      } catch { /* builtin 源失败不阻断 */ }

      // benefit 源：先总开关，开了才取
      const benefitModels = [];
      try {
        const sw = await models.signedJson(credential, base, "GET", "/v1/benefit-gateway-config");
        if (sw.ok && sw.data && sw.data.enabled !== false) {
          const bg = await models.signedJson(credential, base, "GET", "/api/v1/gateway/config");
          const list = bg.data && Array.isArray(bg.data.models) ? bg.data.models : [];
          for (const m of list) benefitModels.push({ id: m.model_id || m.id, name: m.model_name || m.name });
        }
      } catch { /* benefit 源失败不阻断 */ }

      const merged = models.mergeCatalog(agentModels, builtinModels, benefitModels);
      if (!merged.length) return { ok: false, message: "CodeArts 三个目录源都为空（trial 账号可能无模型，不兜底）" };

      // 写回 catalog.json（整段覆盖 codearts 段）
      try {
        const fs = require("node:fs");
        const file = `${rules.rulesDir()}/catalog.json`;
        let all = {};
        try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 新建 */ }
        all[channel] = { syncedAt: Date.now(), models: merged };
        fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf8");
      } catch { /* 落盘失败不阻断，内存态已生效 */ }

      return { ok: true, added: merged.length, count: merged.length };
    },

    // 额度查询：两份账（订阅统计 + 福利池），见 balance.cjs
    async queryCredits(account, secrets) {
      const fresh = await credentialOf(account, secrets, false);
      if (!fresh.ok) return { authError: true, message: fresh.message };
      const credential = fresh.credential;
      if (!credentials.valid(credential)) return { authError: true, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
      try {
        return await balance.queryBalance(baseOf(), credential);
      } catch (e) {
        if (e && e.authError) return { authError: true, message: e.message };
        return { error: String((e && e.message) || e) };
      }
    },

    // 每日福利（三段式：领取 → 确认 → 回读核实，见 welfare.cjs）。
    // 本家没有独立签到接口，签到中心那一行就是这条每日福利
    async claimWelfare(account, secrets) {
      const fresh = await credentialOf(account, secrets, false);
      if (!fresh.ok) return { ok: false, message: fresh.message };
      const credential = fresh.credential;
      if (!credentials.valid(credential)) return { ok: false, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
      return welfare.claimWelfare(baseOf(), credential, store, account);
    },
    async checkin(account, secrets) {
      return this.claimWelfare(account, secrets);
    },
    async checkinStatus(account, secrets) {
      // 没有「今日是否已签」的上游查询：活动列表里的 CONFIRMED 不带确认日期（上一期的会一直显示到今天），
      // 故只回本地台账口径，让界面照实说「签到即领取每日福利」
      const ledger = (account && account.meta && account.meta.welfareLedger) || null;
      const attempts = ledger && ledger.day === welfare.todayKey() ? ledger.attempts : 0;
      return {
        ok: true,
        checkedIn: false,
        message: attempts
          ? `CodeArts 无独立签到查询：今日已发起过福利领取（${attempts} 次）`
          : "CodeArts 无独立签到查询：签到即领取每日福利（领取入口在号池页）",
      };
    },

    // 只读探测：界面在领取前先看清有什么可领（写请求仍然只有 claim 一条路）
    async previewWelfare(account, secrets) {
      const fresh = await credentialOf(account, secrets, false);
      if (!fresh.ok) return { ok: false, message: fresh.message };
      if (!credentials.valid(fresh.credential)) return { ok: false, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
      return welfare.previewWelfare(baseOf(), fresh.credential, account);
    },

    // 续期：提前 15 分钟、凭据整块回写。返回通用形态（token/refreshToken）交给编排层的
    // 单飞与落库路径——CodeArts 的凭据是一整块，故 token 列存的是整块 JSON（见 credentials.cjs）
    async refreshToken(account, secrets) {
      const fresh = await credentialOf(account, secrets, true);
      if (!fresh.ok) return { ok: false, message: fresh.message };
      return { ok: true, ...fresh.fields };
    },
  };
}

module.exports = { makeCodeArts };
