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
// Account management only. No model invocation or conversation entry points.
"use strict";
const endpoints = require("./endpoints.cjs");
const models = require("./models.cjs");
const auth = require("./auth.cjs");
const oauth = require("./oauth.cjs");
const refreshMod = require("./refresh.cjs");
const balance = require("./balance.cjs");
function makeAccio(channel, deps) {
    const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
    const cfg = () => (rules.get("headers.json") || {})[channel] || {};
    const region = endpoints.regionOf(channel);
    function tokenOf(secrets) {
        return String((secrets && secrets.token) || "").trim();
    }
    return {
        id: channel,
        cfg,
        // 模型 id 清单（同步；管理页/路由用）：已拉取过目录只认目录（防幽灵模型），未拉取过回静态兜底
        models() {
            return models.list(channel).map((m) => m.id);
        },
        modelEntries() {
            return models.list(channel);
        },
        readForwardModels() {
            return models.list(channel).map(entry => ({
                id: entry.id, name: entry.name, upstreamKey: entry.upstreamKey || entry.id,
                protocolKind: entry.protocolKind, reasoningEfforts: Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [],
            }));
        },
        /** 拉取官方目录：POST /api/llm/config，body {token}，头带 x-package-region。用 v1 不用 v2（v1 更全）。 */
        async fetchModels(account, secrets, opts) {
            const token = tokenOf(secrets);
            if (!token)
                return { ok: false, message: "该账号没有凭据" };
            return models.refresh(channel, { token }, !!(opts && opts.force));
        },
        // 额度查询：用量百分比（不是积分），见 balance.cjs
        async queryCredits(account, secrets) {
            const token = tokenOf(secrets);
            if (!token)
                return { authError: true, message: "Accio 账号缺少 accessToken" };
            try {
                return await balance.queryBalance(channel, { token });
            }
            catch (e) {
                if (e && e.authError)
                    return { authError: true, message: e.message };
                return { error: String((e && e.message) || e) };
            }
        },
        // 续期：普通 refresh_token 路径，sid/sgcookie 不落库
        async refreshToken(account, secrets) {
            return refreshMod.refreshToken(channel, secrets);
        },
        // 无签到 / 奖励活动：如实回报「不适用」，界面据此不渲染签到入口（与 CatPaw / Cline 同口径）
        async checkin() {
            return { ok: true, unavailable: true, checkedIn: false, message: "Accio 无签到活动，无需操作" };
        },
        async checkinStatus() {
            return { ok: true, unavailable: true, message: "Accio 无签到活动，无需操作" };
        },
        // 登录：OAuth 2.0 授权码 + PKCE（S256），见 oauth.cjs
        async beginOAuth(returnUrl) {
            return oauth.beginLogin(channel, returnUrl);
        },
        async exchangeOAuthCode(code, state) {
            const pending = oauth.takePending(state);
            if (!pending)
                throw Object.assign(new Error("该回调不属于本应用发起的登录（state 不认识或已过期）"), { status: 400 });
            const creds = await oauth.exchangeCode(channel, code, pending.verifier, pending.redirectUri);
            let identity = { userId: "", name: "", email: "", deviceId: "" };
            try {
                identity = auth.profileIdentity(await auth.fetchProfile(channel, creds.accessToken));
            }
            catch { /* 拿不到资料不阻断 */ }
            return {
                token: creds.accessToken,
                refreshToken: creds.refreshToken,
                expiresAt: creds.expiresAt,
                uid: identity.userId || creds.accessToken.slice(0, 12),
                name: identity.name || identity.email || "",
                edition: region.edition,
            };
        },
        async submitCallbackUrl(input) {
            const q = typeof input === "string" ? new URLSearchParams(input.split("?")[1] || "") : new URLSearchParams(input || {});
            const { code, state } = oauth.parseCallback(Object.fromEntries(q.entries()));
            return this.exchangeOAuthCode(code, state);
        },
    };
}
module.exports = { makeAccio };
