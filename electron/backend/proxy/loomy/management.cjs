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
const balance = require("./balance.cjs");
const checkin = require("./checkin.cjs");
const models = require("./models.cjs");
function makeLoomy(deps) {
    const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
    const cfg = () => (rules.get("headers.json") || {}).loomy || {};
    const channel = "loomy";
    // session 即 auth.accessToken（与另外几家同一约定）
    function sessionOf(secrets) {
        return String((secrets && secrets.token) || "").trim();
    }
    return {
        id: channel,
        cfg,
        // 模型 id 清单（同步；管理页 / 路由用）：已拉取过目录只认目录（防幽灵模型），未拉取过为空
        // （本家无静态兜底，不编模型名 —— 与别家不同的一点）
        models() {
            return models.list(rules.rulesDir(), channel);
        },
        // 目录条目（含能力 / 倍率元数据），供模型管理与展示
        modelEntries() {
            return models.entries(rules.rulesDir(), channel);
        },
        // 拉取官方目录：GET {模型网关}/models，token + Bearer 双头；拉不到就如实报错（不编模型名）
        async fetchModels(account, secrets, opts) {
            const session = sessionOf(secrets);
            if (!session)
                return { ok: false, message: "该账号没有凭据" };
            return models.refresh({ session }, rules.rulesDir(), channel, !!(opts && opts.force), undefined, opts);
        },
        // 额度查询：双账户（永久 + 每日赠送），见 balance.cjs
        async queryCredits(account, secrets) {
            const session = sessionOf(secrets);
            if (!session)
                return { authError: true, message: "Loomy 账号缺少 session" };
            try {
                return await balance.queryBalance({ session });
            }
            catch (e) {
                if (e && e.authError)
                    return { authError: true, message: e.message };
                return { error: String((e && e.message) || e) };
            }
        },
        // 每日签到 = 每日首次登录刷新赠送积分（按天幂等报成功），见 checkin.cjs
        async checkin(account, secrets) {
            const session = sessionOf(secrets);
            if (!session)
                return { ok: false, authError: true, message: "Loomy 账号缺少 session" };
            return checkin.checkin({ session });
        },
        // 上游没有「今日是否已签」的查询接口：重复调用按天幂等，故这里只回口径说明，
        // 界面照实写「签到即每日首次登录积分刷新」，不假装查到了状态
        async checkinStatus() {
            return { ok: true, checkedIn: false, message: "Loomy 无独立签到查询接口：签到即每日首次登录积分刷新" };
        },
        // 没有续期（上游无 refresh 接口）：明确返回不可用，账号进入 relogin，界面提示重新短信登录
        async refreshToken() {
            return { ok: false, message: "Loomy 登录态 14 天有效、上游没有续期接口，请重新短信登录" };
        },
    };
}
module.exports = { makeLoomy };
