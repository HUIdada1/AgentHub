/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Account management only. No model invocation or conversation entry points.
"use strict";
const rules = require("../rules.cjs");
const util = require("../util.cjs");
const credentials = require("./credentials.cjs");
const models = require("./models.cjs");
const balance = require("./balance.cjs");
const checkin = require("./checkin.cjs");
const endpoints = require("./endpoints.cjs");
const log = require("./log.cjs");
const CHANNEL = "kuku";
function makeKuku(deps) {
    const { fetchStream, pumpSse, httpJson, firstByteBudgetMs } = deps;
    const cfg = () => {
        const section = (rules.get("headers.json") || {})[CHANNEL] || {};
        // 形态常量放规则文件里就能热改（改完下一次调用生效），所以每次取配置时同步一次
        endpoints.configure(section);
        return section;
    };
    // 子模块共用的出站依赖：HTTP 三件套 + 首字节预算 + 随机 id + 排障日志
    const bundle = {
        httpJson,
        fetchStream,
        pumpSse,
        firstByteBudgetMs,
        uuid: () => util.uuid(),
        verbose: (text) => log.verbose(text),
    };
    /** 账号里的 token 存整段 Cookie 头；解不出有效 BDUSS 就是需要重新添加（401，不是 502） */
    function credentialOf(secrets) {
        const raw = String((secrets && secrets.token) || "").trim();
        const cred = credentials.parseCookieHeader(raw);
        if (!cred) {
            throw Object.assign(new Error("KukuAI 账号缺少有效的 BDUSS：请重新添加账号，或重新粘贴完整 Cookie（需包含 BDUSS、STOKEN、PTOKEN）"), { status: 401 });
        }
        cfg();
        return cred;
    }
    return {
        id: CHANNEL,
        cfg,
        // The original management parser is the only Cookie parser. The
        // forwarding plugin receives this bounded projection, never the raw
        // encrypted account value or a second parser implementation.
        readForwardCredentials(account, secrets) {
            const cred = credentials.parseCookieHeader(String((secrets && secrets.token) || "").trim());
            if (!cred) {
                throw Object.assign(new Error("KukuAI 账号缺少有效的 BDUSS：请重新添加账号，或重新粘贴完整 Cookie（需包含 BDUSS、STOKEN、PTOKEN）"), { status: 401 });
            }
            return {
                bduss: cred.bduss,
                stoken: cred.stoken,
                extras: cred.extras.map(([name, value]) => [name, value]),
                ptoken: credentials.ptokenOf(cred.extras),
            };
        },
        /** 静态兜底清单（离线也有 /v1/models 可列），拉过目录之后以远程清单为准 */
        models() {
            return models.ids();
        },
        modelEntries() {
            return models.entries();
        },
        /** 拉取上游目录：会话没建立时先换三件套；没账号不是失败，如实回跳过 */
        async fetchModels(account, secrets, opts) {
            if (!String((secrets && secrets.token) || "").trim()) {
                return { ok: true, skipped: true, models: models.ids(), message: "尚未添加账号，保留静态兜底清单" };
            }
            let cred = null;
            try {
                cred = credentialOf(secrets);
            }
            catch (e) {
                return { ok: false, authError: true, message: e.message };
            }
            return models.refresh(cred, bundle, !!(opts && opts.force));
        },
        async queryCredits(account, secrets) {
            let cred = null;
            try {
                cred = credentialOf(secrets);
            }
            catch (e) {
                return { authError: true, message: e.message };
            }
            try {
                return await balance.queryCredits(cred, bundle);
            }
            catch (e) {
                return { error: String((e && e.message) || e) };
            }
        },
        async checkin(account, secrets) {
            let cred = null;
            try {
                cred = credentialOf(secrets);
            }
            catch (e) {
                return { ok: false, authError: true, message: e.message };
            }
            try {
                return await checkin.checkin(cred, bundle);
            }
            catch (e) {
                const status = Number(e && e.status) || 0;
                return { ok: false, authError: status === 401 || status === 403, message: String((e && e.message) || e) };
            }
        },
        checkinStatus() {
            return checkin.checkinStatus();
        },
        // 上游没有续期接口：如实回不可用，让账号进「需重新登录」而不是白跑一次刷新
        async refreshToken() {
            return {
                ok: false,
                noRefresh: true,
                message: "KukuAI 的登录态就是百度通行证 Cookie，上游没有续期接口：请在浏览器重新登录后，重新粘贴包含 BDUSS/STOKEN/PTOKEN 的完整 Cookie",
            };
        },
    };
}
module.exports = { makeKuku };
