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
const credentials = require("./credentials.cjs");
const modelsMod = require("./models.cjs");
const balanceMod = require("./balance.cjs");
const refreshMod = require("./refresh.cjs");
const headersMod = require("./headers.cjs");
/** 家族启发式（context_window_for / reasoning_for 的回退口径）：
 *  目录里查不到的全新模型按 id 家族给窗口与思考开关，不写死一个数 */
function contextWindowHeuristic(id) {
    const name = String(id || "").toLowerCase();
    if (name.includes("deepseek-v4.1") || name.includes("1m") || name.includes("minimax") || name.includes("mimo"))
        return 1000000;
    if (name.includes("kimi") || name.includes("qwen3.8") || name.includes("glm-5"))
        return 256000;
    if (name.includes("claude") || name.includes("gpt-6") || name.includes("grok"))
        return 200000;
    return 128000;
}
/** 少数小模型没有 reasoning 输出（reasoning_for 同口径） */
function reasoningHeuristic(id) {
    const name = String(id || "").toLowerCase();
    return !(name.includes("solar-pro4") || name.includes("flash-lite"));
}
/**
 * 工厂：deps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs }
 * channel：cline_free（免费池）/ cline_pass（订阅池）；两池共用 headers.json 的 cline 段
 */
function makeCline(channel, deps) {
    const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
    const pool = channel === "cline_free" ? "free" : "pass";
    const cfg = () => (rules.get("headers.json") || {}).cline || {};
    // ===== 目录索引（catalog.json 对应渠道段，mtime 缓存；models 与 body 模型名归一共用）=====
    // at 初值 -1（mtimeMs 恒 ≥ 0）保证首次必读；判据**只看 mtime**、不看 entries.length——
    // 否则「该渠道目录段为空」时判据恒假，models() 每次调用都重复 stat + 读文件 + 解析
    let catalogCache = { at: -1, entries: [] };
    function catalogEntries() {
        const file = path.join(rules.rulesDir(), "catalog.json");
        let st = 0;
        try {
            st = fs.statSync(file).mtimeMs;
        }
        catch { /* 无缓存文件 */ }
        if (catalogCache.at === st)
            return catalogCache.entries;
        const all = (() => {
            try {
                return JSON.parse(fs.readFileSync(file, "utf8"));
            }
            catch { /* 文件缺失/损坏 */ }
            // 回退内存态（rules.get 链路自带内置 DEFAULTS 兜底）：删掉规则文件时模型清单不该变空
            return rules.get("catalog.json") || {};
        })();
        const entry = all[channel];
        const entries = (entry && Array.isArray(entry.models) ? entry.models : []).filter((m) => m && m.id);
        catalogCache = { at: st, entries };
        return entries;
    }
    /** 伪装头统一走 headers.cjs（对话/登录/续期三处同一实现），见下方 chat/headers 的 buildUpstreamHeaders 调用 */
    return {
        id: channel,
        cfg,
        /** 目录接口**无需登录态**（recommended-models 实测无 Authorization 也 200）：
         *  据此放宽 proxy_models_sync 的「号池必须有可用账号」前置条件——
         *  用户可在导入任何账号前先同步模型目录（其余渠道不声明，仍按「需要」处理） */
        modelsNeedAuth: false,
        /** 凭据临期窗口（秒）：access 实测 1 小时（exp-iat=3600），窗口 10 分钟（1/6）。
         *  与其它渠道同口径写死（qoder 86400 / raccoon 300），配置层不再放一份防双源漂移 */
        refreshWindowSec: 600,
        /** 余额 0 不是硬门禁：上游允许余额记负（实测欠费 -0.02 仍可用），真实门禁是
         *  每日额度的 429（带重置时间）与订阅 403，都已由错误分类按账号处置。号池调度
         *  的「余额 0 → exhausted」与 routeUsable 同口径据此跳过本渠道——否则余额恒 0 的
         *  账号（store 入库层把舍入后的 0 与 < -1 负值都归 0）会被锁死在调度外且永不复活 */
        zeroBalanceUsable: true,
        /** 模型 id 清单（带池前缀的完整上游 id；目录未就绪时为空数组——rules 默认值已含静态兜底） */
        models() {
            return catalogEntries().map((m) => String(m.id));
        },
        modelEntries() { return catalogEntries(); },
        /** 拉取官方目录（GET {apiBase}{modelsPath}，**无需鉴权**实测）→ 只回本池那一批。
         *  归池按响应分组（models.parseRecommended），cllineCloud 不收录（实测 403）。 */
        async fetchModels() {
            const c = cfg();
            const base = String(c.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
            const r = await httpJson(`${base}${c.modelsPath || "/ai/cline/recommended-models"}`, {
                method: "GET",
                // 伪装头走唯一实现（headers.json upstreamHeaders 覆盖层），与对话/登录/续期同一口径
                headers: headersMod.buildUpstreamHeaders(c, { accept: "application/json" }),
            }).catch((e) => ({ status: 0, ok: false, data: null, message: String((e && e.message) || e) }));
            if (!r.ok || !r.data)
                return { ok: false, message: `模型目录 HTTP ${r.status}${r.message ? `：${r.message}` : ""}` };
            const parsed = modelsMod.filterByPool(modelsMod.parseRecommended(r.data), pool);
            if (!parsed.length)
                return { ok: false, message: "模型目录为空（响应里没有本池可用模型）" };
            const models = parsed.map((m) => {
                // 元数据继承（先查表再启发式，两段式）：上游目录不回传元数据，
                // 硬编码 capabilities/0 会让「远程与静态两条路径给出不同的数」——同步后
                // solar-pro4 的思考开关从 false 跳 true、全部上下文长度归 0（刷新前后跳变）
                const hit = catalogEntries().find((e) => String(e.id || "").toLowerCase() === m.id.toLowerCase());
                const caps = hit && hit.capabilities && typeof hit.capabilities === "object"
                    ? { images: hit.capabilities.images !== false, reasoning: hit.capabilities.reasoning !== false, tools: hit.capabilities.tools !== false }
                    : { images: true, reasoning: reasoningHeuristic(m.id), tools: true };
                const ctx = hit && Number(hit.contextLength) > 0 ? Number(hit.contextLength) : contextWindowHeuristic(m.id);
                return { id: m.id, name: m.name, rate: null, capabilities: caps, contextLength: ctx, maxOutputTokens: 0 };
            });
            return { ok: true, models };
        },
        /** 非会话语义：标准 OpenAI 兼容单发请求 */
        headers() {
            const c = cfg();
            return headersMod.buildUpstreamHeaders(c, { "content-type": "application/json", accept: "text/event-stream" });
        },
        /** 余额（微 credit ÷1e6 + plan 404 正常态，见 balance.cjs）。 */
        async queryCredits(account, secrets) {
            const c = cfg();
            const token = credentials.ensureTokenPrefix(secrets && secrets.token);
            if (!token)
                return { authError: true, message: "该账号没有凭据" };
            try {
                return await balanceMod.queryBalance({
                    cfg: c,
                    token,
                    httpJson,
                    // uid 已在导入/登录时解析为 usr-...（外部 id）；没有时从 JWT 兜底
                    userId: String((account && account.uid) || ""),
                    jwtAccountId: credentials.accountIdFromJwt(secrets && secrets.token),
                    parseExpiresAt: credentials.parseExpiresAt,
                });
            }
            catch (e) {
                if (e && e.authError)
                    return { authError: true, message: e.message };
                return { error: String((e && e.message) || e) };
            }
        },
        /** 续期（轮换 + 裸 JWT 补前缀；single-flight 由 refreshTokenLocked 提供）。 */
        async refreshToken(account, secrets) {
            const c = cfg();
            const r = await refreshMod.refreshToken({
                cfg: c,
                token: credentials.ensureTokenPrefix(secrets && secrets.token),
                refreshToken: String((secrets && secrets.refreshToken) || ""),
                httpJson,
            });
            if (!r.ok)
                return r;
            return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt || 0 };
        },
        /** Cline 上游无签到/奖励活动：如实回报「不适用」（与 CatPaw 同口径，前端不渲染入口）。 */
        async checkin() {
            return { ok: true, unavailable: true, checkedIn: false, message: "Cline 无签到活动，无需操作" };
        },
        async checkinStatus() {
            return { ok: true, unavailable: true, message: "Cline 无签到活动，无需操作" };
        },
    };
}
module.exports = { makeCline };
