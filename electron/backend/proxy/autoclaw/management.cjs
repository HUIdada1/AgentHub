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
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const headersMod = require("./headers.cjs");
const modelsMod = require("./models.cjs");
const balanceMod = require("./balance.cjs");
const checkinMod = require("./checkin.cjs");
const refreshMod = require("./refresh.cjs");
/**
 * 工厂：deps = { fetchStream, pumpSse, httpJson, rules, store, util, deviceIds, firstByteBudgetMs }
 * channel：autoclaw（国内版）/ autoclaw_intl（国际版）
 */
function makeAutoClaw(channel, deps) {
    const { fetchStream, pumpSse, httpJson, rules, util, deviceIds, firstByteBudgetMs } = deps;
    const cfg = () => (rules.get("headers.json") || {})[channel] || {};
    // ===== 进程级凭证缓存（刷新结果不落库不落文件，只进缓存）=====
    // baseToken 是缓存建立时的库内 token 指纹：库被更新（重登/手动改 token）即失效回落库值，
    // 避免「缓存遮蔽新登录态」。key 用账号 id。
    const credCache = new Map(); // accountId -> { token, refreshToken, expiresAt, baseToken }
    /** 取当前生效凭证：缓存命中且库内 token 未变 → 缓存值；否则库值。
     *  命中判据 = token 命中 baseToken（库未变）或 hit.token（401 重试链拿着上一次刷新的
     *  结果再来问，server.cjs 的 send 传的正是 r.token）——只认 baseToken 会把后者误判成
     *  「库已更换」删掉刚建立的缓存，后续请求又拿库内旧 token 再 401、再拿旧 rt 刷新
     *  （轮换制下旧 rt 可能已作废 → 掉登录）。二者都不命中才是真正的库更换（重登/手改）。 */
    function credentialsOf(account, secrets) {
        const hit = account && account.id ? credCache.get(account.id) : null;
        if (hit && hit.token && (secrets.token === hit.baseToken || secrets.token === hit.token)) {
            return { token: hit.token, refreshToken: hit.refreshToken || secrets.refreshToken || "" };
        }
        if (hit && secrets.token !== hit.baseToken && secrets.token !== hit.token)
            credCache.delete(account.id);
        return { token: secrets.token || "", refreshToken: secrets.refreshToken || "" };
    }
    /** 账号 device_id（64hex）：meta.deviceId（登录/导入时落）优先，否则按账号 id 派生稳定值 */
    function deviceIdOf(account) {
        const meta = (account && account.meta) || {};
        if (meta.deviceId)
            return String(meta.deviceId);
        if (typeof deviceIds === "function")
            return deviceIds(account).machineId;
        return crypto.createHash("sha256").update(`agenthub:machine:${(account && account.id) || "anon"}`).digest("hex");
    }
    /** userapi 域请求环境（签名头 + httpJson + deviceId），签到/余额/刷新/目录共用 */
    function userapiEnv(cfgv, token, account) {
        return {
            cfg: cfgv,
            token,
            headers: headersMod.signedAuthHeaders(cfgv, token),
            deviceId: deviceIdOf(account),
            httpJson,
        };
    }
    /** 目录索引（catalog.json，mtime 缓存）：models() / 路由解析共用 */
    let catalogCache = { at: 0, byKey: new Map(), raw: null };
    function catalogIndex() {
        const file = path.join(rules.rulesDir(), "catalog.json");
        let st = 0;
        try {
            st = fs.statSync(file).mtimeMs;
        }
        catch { /* 无缓存 */ }
        if (catalogCache.raw && catalogCache.at === st)
            return catalogCache;
        const all = (() => {
            try {
                return JSON.parse(fs.readFileSync(file, "utf8"));
            }
            catch {
                return {};
            }
        })();
        const entry = all[channel];
        const byKey = new Map();
        for (const m of (entry && Array.isArray(entry.models) ? entry.models : [])) {
            if (m && m.id)
                byKey.set(String(m.id).toLowerCase(), m);
        }
        catalogCache = { at: st, byKey, raw: entry || null };
        return catalogCache;
    }
    return {
        id: channel,
        cfg,
        // Internal host bridge: use this instance's noPersist cache, never a second adapter.
        readForwardCredentials(account, secrets) {
            return { ...secrets, ...credentialsOf(account, secrets) };
        },
        readForwardContext(account) {
            return { deviceId: deviceIdOf(account) };
        },
        // Read-only bridge over this ORIGINAL instance's existing catalog cache.
        // Routing interpretation and model requests remain outside management.
        modelEntries() {
            const entries = catalogIndex().byKey;
            return entries.size ? [...entries.values()] : modelsMod.STATIC_MODELS;
        },
        readForwardModels() {
            const byKey = catalogIndex().byKey;
            return (byKey.size ? [...byKey.values()] : modelsMod.STATIC_MODELS)
                .map(entry => ({ id: entry.id, name: entry.name, routeId: entry.routeId }));
        },
        /**
         * 模型 id 清单（同步；管理页/路由用）：已拉取过目录只认目录（防幽灵模型，qoder issue #74 同款），
         * 未拉取过回静态兜底（两地共用同一份，条目含 routeId）。
         */
        models() {
            const byKey = catalogIndex().byKey;
            if (byKey.size)
                return [...byKey.keys()];
            return modelsMod.STATIC_MODELS.map((m) => m.id);
        },
        /** 拉取官方目录：GET {userapi}{catalogPath}，签名头。响应顶层直接是 {models:[…]}（无信封）。 */
        async fetchModels(account, secrets) {
            const c = cfg();
            const { token } = credentialsOf(account, secrets);
            if (!token)
                return { ok: false, message: "该账号没有凭据" };
            const base = String(c.userapiBase || "").replace(/\/+$/, "");
            const r = await httpJson(`${base}${c.catalogPath || "/autoclaw-proxy/proxy/autoclaw-model-config"}`, {
                method: "GET",
                headers: headersMod.signedAuthHeaders(c, token),
            }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            if (r.status === 401)
                return { ok: false, authError: true, message: "登录态已失效，请重新登录或刷新凭证" };
            // 目录端点登录态失效也可能以 HTTP 200 + body 码表达（balance/checkin 同口径）：
            // 不认的话失效被报成「结构可能已变更」误导排障，且不触发 authError 链（不换号/不提示重登）
            const authCode = Number(r.data && (r.data.code ?? r.data.errorCode)) || 0;
            if (authCode === 410000 || authCode === 400000) {
                return { ok: false, authError: true, message: "登录态已失效，请重新登录或刷新凭证" };
            }
            const list = r.data && Array.isArray(r.data.models) ? r.data.models : null;
            if (!list) {
                return { ok: false, message: `模型目录 HTTP ${r.status}${r.data && r.data.message ? `：${r.data.message}` : "（无 models 数组，结构可能已变更）"}` };
            }
            if (!list.length)
                return { ok: false, message: "模型目录为空" };
            const models = list.map(modelsMod.normalizeCatalogEntry).filter(Boolean);
            if (!models.length)
                return { ok: false, message: "模型目录条目全部无法归一" };
            return { ok: true, models };
        },
        /** 非签名基础头（展示/预检用；LLM 认证头 X-Authorization 按 token 现场出，见 chat） */
        headers() {
            const c = cfg();
            return {
                "content-type": "application/json",
                accept: "*/*",
                "x-product": "autoclaw",
                "x-client-type": "pc",
                // 版本对齐（12 §6.4）：客户端 X-Version = app.getVersion() = 2.2.0（原兜底 1.17.8 已过期）
                "x-version": c.llmVersion || "2.2.0",
            };
        },
        /** 余额：钱包 v2 → v1 兜底 → 即将过期 → 订阅（协议细节见 balance.cjs）。 */
        async queryCredits(account, secrets) {
            const c = cfg();
            const { token } = credentialsOf(account, secrets);
            if (!token)
                return { authError: true, message: "该账号没有凭据" };
            try {
                return await balanceMod.queryBalance(userapiEnv(c, token, account));
            }
            catch (e) {
                if (e && e.authError)
                    return { authError: true, message: e.message };
                return { error: String((e && e.message) || e) };
            }
        },
        /** 每日签到：POST task-complete（daily_signin），判据看 reward/success 而非 HTTP 状态（checkin.cjs）。 */
        async checkin(account, secrets) {
            const c = cfg();
            const { token } = credentialsOf(account, secrets);
            if (!token)
                return { ok: false, authError: true, message: "该账号没有凭据" };
            const env = userapiEnv(c, token, account);
            const r = await checkinMod.checkin(env);
            // 签到（含「今天已签到」的幂等结果）后触发一次「登录活跃」，让活动福利入账：
            // 这类活动没有领取接口，只有 user-info 能触发（见 checkin.cjs 的 triggerLoginActive）。
            // 失败静默——附加收益，绝不改签到结论
            if (r && r.ok) {
                try {
                    await checkinMod.triggerLoginActive(env);
                }
                catch { /* 附加收益，失败不影响签到 */ }
            }
            return r;
        },
        /** 签到状态探测（只读 task-list） */
        async checkinStatus(account, secrets) {
            const c = cfg();
            const { token } = credentialsOf(account, secrets);
            if (!token)
                return { authError: true, message: "该账号没有凭据" };
            return checkinMod.checkinStatus(userapiEnv(c, token, account));
        },
        /**
         * 续期（只读不回写）：POST /userapi/v1/refresh，400002 降级 agent-refresh（refresh.cjs）。
         * 成功只更新进程缓存并带 noPersist 标记——server/credits 据此跳过 store.updateAccount 的
         * token/refreshToken 落库（服务端轮换 refresh_token，落库会与桌面端登录态互顶）。
         */
        async refreshToken(account, secrets) {
            const c = cfg();
            const cur = credentialsOf(account, secrets);
            if (!cur.refreshToken)
                return { ok: false, message: "无 refreshToken，请重新导入或登录" };
            const r = await refreshMod.refreshToken({ ...userapiEnv(c, cur.token, account), refreshToken: cur.refreshToken });
            if (!r.ok)
                return r;
            if (account && account.id) {
                credCache.set(account.id, { token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt || 0, baseToken: secrets.token || "" });
            }
            return r;
        },
    };
}
module.exports = { makeAutoClaw };
