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
// Account management only. No model invocation or conversation entry points.
"use strict";
const rules = require("../rules.cjs");
const { MODELS } = require("./management-models.cjs");
const catalog = require("./catalog.cjs");
const balance = require("./balance.cjs");
const { resolveCredentials } = require("./credentials.cjs");
const { postJson, requestHeaders, upstreamBaseUrl } = require("./management-http.cjs");
/** 静态兜底模型清单（远程目录不可用时的 id 集） */
const STATIC_MODEL_IDS = MODELS.map((model) => model.id);
function makeCatPaw() {
    return {
        id: "catpaw",
        // Keep the original parser and token/uid source pairing in the management host.
        readForwardCredentials(account, secrets) {
            return { ...secrets, ...resolveCredentials(account, secrets) };
        },
        // Existing catalog facts only. No new fetch, parsing, refresh or writes.
        readForwardModels() {
            return catalog.list().map(({ id, name, modelType }) => ({ id, name, modelType }));
        },
        modelEntries() { return catalog.list(); },
        cfg() {
            return rules.get("headers.json").catpaw;
        },
        /** 模型清单：远程目录优先（catalog.list 已带静态表回落），去重保序 */
        models() {
            const ids = catalog.list().map((item) => String(item.id || "")).filter(Boolean);
            const out = [];
            for (const id of [...ids, ...STATIC_MODEL_IDS]) {
                if (!out.some((x) => x.toLowerCase() === id.toLowerCase()))
                    out.push(id);
            }
            return out;
        },
        /** 静态基础头（排障与契约用；真正的请求头由 upstreamHttp.requestHeaders 按凭据现场生成，
         *  含每请求新的 M-TRACEID） */
        headers() {
            return requestHeaders({}, "application/json");
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
            }
            catch (e) {
                return { ok: false, message: String((e && e.message) || e) };
            }
            let payload;
            try {
                payload = await postJson(upstreamBaseUrl(), catalog.MODEL_TYPES_PATH, credentials, catalog.MODEL_TYPES_BODY);
            }
            catch (e) {
                if (e && e.status === 401) {
                    return { ok: false, authError: true, message: "CatPaw 登录态已失效，请在账号页重新导入或重新登录" };
                }
                return { ok: false, message: String((e && e.message) || e) };
            }
            if (!Array.isArray(payload))
                return { ok: false, message: "上游返回的模型目录不是数组" };
            const models = payload.map((item) => catalog.normalizeEntry(item)).filter(Boolean);
            if (!models.length)
                return { ok: false, message: "上游返回的模型目录为空" };
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
