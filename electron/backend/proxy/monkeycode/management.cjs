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
const regionStore = require("./region.cjs");
const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");
const models = require("./models.cjs");
const log = require("./log.cjs");
function makeMonkeyCode(channel, deps) {
    const { httpJson } = deps;
    const region = regionStore.byChannel(channel);
    const cfg = () => (rules.get("headers.json") || {})[channel] || {};
    // 子模块只需要三样：JSON 出站（走 adapters 的共用通道，因此自动继承出网代理与超时档）、
    // 排障日志、以及任务流的空闲预算（从规则文件读，缺省由 stream.cjs 兜底）
    const bundle = {
        httpJson,
        verbose: (text) => log.verbose(`[${region ? region.label : channel}] ${text}`),
        get streamIdleMs() {
            return Number(cfg().streamIdleMs) || 0;
        },
    };
    return {
        id: channel,
        cfg,
        models() {
            return models.ids(channel);
        },
        modelEntries() {
            return models.list(channel);
        },
    readForwardModels() {
        return models.list(channel).map(entry => ({
            id: entry.id, name: entry.name, model: entry.model, upstreamId: entry.upstreamId,
            interfaceType: entry.interfaceType, cliName: entry.cliName,
        }));
    },
    // Read-only bridge for the external execution plugin. The image id is
    // account metadata discovered by the original host flow; this accessor
    // does not discover, refresh, write, or alter any management operation.
    readForwardContext(account) {
        let meta = account && account.meta;
        if (typeof meta === "string") {
            try { meta = JSON.parse(meta); } catch { meta = {}; }
        }
        return { imageId: meta && typeof meta.imageId === "string" ? meta.imageId : "" };
    },
        readForwardCredentials(account, secrets) {
            const snap = credentials.snapshot(secrets);
            return { session: snap.session };
        },
        async fetchModels(account, secrets, opts) {
            if (!region)
                return { ok: false, message: "未知的 MonkeyCode 站点" };
            const snap = credentials.snapshot(secrets);
            return models.refresh(region, cfg(), bundle, snap.session, !!(opts && opts.force));
        },
        /** 没有余额接口：如实回 unavailable，账号保持可用、余额字段不动（回 0 会被判额度耗尽并自动切号） */
        async queryCredits() {
            return { unavailable: true, message: "MonkeyCode 上游没有可用的余额接口，额度以官网为准" };
        },
        async checkin() {
            return { ok: true, unavailable: true, message: "MonkeyCode 没有签到活动" };
        },
        async checkinStatus() {
            return { ok: true, checkedIn: false, unavailable: true, message: "MonkeyCode 没有签到活动" };
        },
        async refreshToken() {
            return {
                ok: false,
                noRefresh: true,
                message: `MonkeyCode 登录态没有刷新机制（会话 30 天、上游无续期接口）：请在浏览器重新取一次 ${endpoints.SESSION_COOKIE_NAME} 后在本页重新粘贴`,
            };
        },
    };
}
module.exports = { makeMonkeyCode };
