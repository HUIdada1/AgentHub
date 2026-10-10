// CatPaw 适配器：把会话式协议层接进 AgentHub 的渠道注册表
// （移植来源：参照实现 catpaw/adapter.rs）。
//
// 这一层只做「接线」：把编排层给的散装入参（原始 body、账号、凭据、emit、meta）装配成
// 会话式转发的入参，再转调 conversation.runConversation。任何「CatPaw 该怎么做」的判断
// 都属于协议层（messages/blocks/fingerprint/registry/decision/conversation/openai）。
//
// 与其它渠道的形态差异（为什么必须声明 stateful）：WorkBuddy / 小浣熊是「一次 HTTP 请求 = 一次对话」，
// 适配器把请求头与 body 拼好交给转发层就够了；CatPaw 的一个客户端请求会变成好几个上游请求
// （round → event → turn → 工具循环 → event），中间还有会话注册表与指纹链——这些装不进
// 单请求契约，因此 `stateful() === true`，server.cjs 走 chatSession。
//
// 凭证：X-Passport-Token（Cookie 形态）+ user-uid 独立请求头，且**无法刷新**——
// token 过期只能在桌面端重新登录（桌面端账号的凭证实时读 auth.json，重新登录立即恢复）。
// 因此 refreshToken() 如实回报「不支持自动刷新」，绝不假装能续期。
"use strict";
const rules = require("../rules.cjs");
const CatPawError = require("./errors.cjs");
const { MODELS } = require("./models.cjs");
const catalog = require("./catalog.cjs");
const balance = require("./balance.cjs");
const { resolveCredentials } = require("./credentials.cjs");
const { postJson, requestHeaders, upstreamBaseUrl } = require("./upstreamHttp.cjs");
const { runConversation } = require("./conversation.cjs");

/** 静态兜底模型清单（远程目录不可用时的 id 集） */
const STATIC_MODEL_IDS = MODELS.map((model) => model.id);

function makeCatPaw() {
  return {
    id: "catpaw",

    /** 会话式转发声明：server.cjs 据此改走 chatSession（契约见 adapters.cjs 顶部注释块） */
    stateful: () => true,

    cfg() {
      return rules.get("headers.json").catpaw;
    },

    /** 模型清单：远程目录优先（catalog.list 已带静态表回落），去重保序 */
    models() {
      const ids = catalog.list().map((item) => String(item.id || "")).filter(Boolean);
      const out = [];
      for (const id of [...ids, ...STATIC_MODEL_IDS]) {
        if (!out.some((x) => x.toLowerCase() === id.toLowerCase())) out.push(id);
      }
      return out;
    },

    /** 静态基础头（排障与契约用；真正的请求头由 upstreamHttp.requestHeaders 按凭据现场生成，
     *  含每请求新的 M-TRACEID） */
    headers() {
      return requestHeaders({}, "application/json");
    },

    /** 单请求路径**防御性报错**：CatPaw 走会话式转发。走到这里说明编排层的 stateful 分流坏了
     *  （或将来有人误加了调用点），报错比发一个语义不对的请求安全得多 */
    async chat() {
      throw new CatPawError(503, "CatPaw 走会话式转发，不走单请求路径（内部错误：编排层未按 stateful 分流）", { fatal: true });
    },

    /** 会话式转发入口（契约：ctx 同 chat，出参同形 {status, planLimit}） */
    chatSession(ctx) {
      return runConversation(ctx);
    },

    /** 余额 / 积分：GET catx.nocode.cn/api/gateway/credit/balance（凭证复用转发那条链） */
    queryCredits(account, secrets) {
      return balance.queryCredits(account, secrets);
    },

    /** 拉取远程模型目录：POST /api/agent/maas/model-types（index.cjs 负责写回 catalog.json）。
     *  401 单独回报 authError——这是最可能的一种失败，账号层据此标 relogin */
    async fetchModels(account, secrets) {
      let credentials;
      try {
        credentials = resolveCredentials(account, secrets);
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
      let payload;
      try {
        payload = await postJson(upstreamBaseUrl(), catalog.MODEL_TYPES_PATH, credentials, catalog.MODEL_TYPES_BODY);
      } catch (e) {
        if (e && e.status === 401) {
          return { ok: false, authError: true, message: "CatPaw 登录态已失效，请在账号页重新导入或重新登录" };
        }
        return { ok: false, message: String((e && e.message) || e) };
      }
      if (!Array.isArray(payload)) return { ok: false, message: "上游返回的模型目录不是数组" };
      const models = payload.map((item) => catalog.normalizeEntry(item)).filter(Boolean);
      if (!models.length) return { ok: false, message: "上游返回的模型目录为空" };
      return { ok: true, models };
    },

    /** CatPaw 无签到 / 无奖励活动：如实回报「不适用」（ok:true + unavailable），
     *  不假装签到成功、也不让「一键签到」弹一条红色失败 */
    async checkinStatus() {
      return { ok: true, unavailable: true, checkedIn: false, message: "CatPaw（美团）无签到活动，无需操作" };
    },

    async checkin() {
      return { ok: true, unavailable: true, message: "CatPaw（美团）无签到活动，无需操作" };
    },

    /** 没有刷新接口（凭证是桌面端会话 Cookie 值，不是 JWT）：如实回报不支持。
     *  恢复路径 = 在 CatPaw 客户端重新登录后重新导入/等待实时登录态生效 */
    async refreshToken() {
      return { ok: false, message: "CatPaw 凭证不支持自动刷新：请在 CatPaw 客户端重新登录后重新导入登录态" };
    },
  };
}

module.exports = { makeCatPaw };
