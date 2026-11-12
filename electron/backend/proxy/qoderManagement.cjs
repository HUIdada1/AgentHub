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
const os = require("node:os");
const qoderSites = require("./qoder/sites.cjs");
const cosy = require("./qoder/cosy.cjs");
/**
 * Cosy-MachineOS 的取值口径：客户端用 Windows 内核版本号（实测 "10.0.26200.0"）。
 * os.release() 直接给这个值；非 Windows 平台回落到 platform+arch（服务端只做存在性校验）。
 */
function osVersion() {
    try {
        return process.platform === "win32" ? os.release() : `${process.platform}-${os.arch()}`;
    }
    catch {
        return "";
    }
}
/** 静态兜底模型表（catalog 不可用时的最小可用集，全部实测 format=openai）。
 *
 *  ⚠️ 按 product 隔离：这两个产品的模型 key 并不通用（CN 与 intl 是两套上游目录，
 *  同一个 key 往往只在一边存在）。此前是模块级单表、两个 product 共用，于是
 *  「没拉取过目录的一侧」会凭空宣称拥有另一侧的全部模型——modelOwners 据此把请求
 *  failover 到该侧，上游回 400 code=11102「model [x] service info not found」，
 *  表现为「模型明明在列表里、本机也能用，却时不时报当前模型不可用」（issue #74）。
 *  故兜底集也必须分产品；未列出的产品不给静态兜底（宁缺勿错，靠拉取目录）。 */
const STATIC_MODELS_BY_PRODUCT = {
    // 对外 id = 官方客户端展示名（去空白），upstreamKey = 发往上游的 model_config.key。
    // 旧表只有内部 key，界面与客户端模型列表对不上（#179）；rate 为 price_factor 静态快照。
    qoder: [
        { id: "Qwen3.8-Flash", name: "Qwen3.8-Flash", upstreamKey: "qfmodel", rate: 0.1 },
        { id: "Qwen3.8-Max", name: "Qwen3.8-Max", upstreamKey: "qmodel_38max", rate: 0.5 },
        { id: "Auto", name: "Auto", upstreamKey: "auto", rate: 1 },
        { id: "Qwen3.7-Max", name: "Qwen3.7-Max", upstreamKey: "qmodel_latest", rate: 0.5 },
        { id: "Qwen3.7-Plus", name: "Qwen3.7-Plus", upstreamKey: "qmodel", rate: 0.1 },
        { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro", upstreamKey: "dmodel", rate: 0.8 },
        { id: "DeepSeek-Flash", name: "DeepSeek-Flash", upstreamKey: "dfmodel", rate: 0.2 },
        { id: "GLM-5.3", name: "GLM-5.3", upstreamKey: "gmodel", rate: 0.6 },
        { id: "Kimi-K2.8-Preview", name: "Kimi-K2.8-Preview", upstreamKey: "kmodel", rate: 0.3 },
        { id: "MiniMax-M3", name: "MiniMax-M3", upstreamKey: "mmodel", rate: 0.2 },
    ],
    // qoder_intl：无静态兜底（未实测过其目录；一旦误兜底就会把请求导向不存在的模型）
};
/** 按 product 取静态兜底集（未列出的产品为空——不跨产品借模型）。
 *  千问办公双站的兜底来自站点表（Agent2Providers `qwenwork_fallback_models`，
 *  2026-10-31 复核：上游当时只有 高级 / 标准 / Qwen3.8-Max 三个）。 */
function staticModelsOf(product) {
    const own = STATIC_MODELS_BY_PRODUCT[product];
    if (own) return own;
    const site = qoderSites.of(product);
    return (site && site.fallbackModels) || [];
}
/** 请求侧默认场景（签名头 Cosy-Scene 由 wasm 置为 assistant；目录按场景分组） */
const DEFAULT_SCENE = "assistant";
/** 目录条目没给上下文长度时的兜底（Agent2Providers qoder/models.rs 同口径） */
const DEFAULT_CONTEXT_WINDOW = 200000;
/** 上游目录信封：`{statusCodeValue, body:"{...}"}` / `{data:{...}}` / 裸对象 */
function catalogPayload(value) {
    let node = value;
    for (let depth = 0; depth < 4; depth++) {
        if (!node || typeof node !== "object")
            return null;
        const code = Number(node.statusCodeValue ?? node.code);
        if (Number.isFinite(code) && code !== 0 && code !== 200)
            throw new Error(`上游返回业务错误 ${code}: ${String(node.message || node.msg || "").slice(0, 200)}`);
        if (typeof node.body === "string" && node.body.trim().startsWith("{")) {
            try {
                node = JSON.parse(node.body);
                continue;
            }
            catch {
                return null;
            }
        }
        if (node.body && typeof node.body === "object") {
            node = node.body;
            continue;
        }
        if (node.qwork || node.chat)
            return node;
        if (node.data && typeof node.data === "object") {
            node = node.data;
            continue;
        }
        return node;
    }
    return node;
}
/** 上游目录行 → 统一模型条目。
 *  id/name 用官方客户端展示名（去空白），upstreamKey 才是发往上游的 model_config.key；
 *  Qoder 与千问办公共用这一份映射，差异只在场景与输出上限。 */
function modelsFromRemote(payload, site) {
    const sceneOrder = site.modelScene
        ? [site.modelScene, ...Object.keys(payload || {})]
        : [DEFAULT_SCENE, "chat", "quest", "developer", ...Object.keys(payload || {})];
    const rows = [];
    for (const scene of sceneOrder) {
        const list = payload && payload[scene];
        if (Array.isArray(list))
            rows.push(...list);
    }
    const models = new Map();
    for (const row of rows) {
        if (!row || typeof row !== "object")
            continue;
        const key = String(row.key || "").trim();
        const display = String(row.display_name || "").trim();
        if (!key || !display)
            continue;
        const id = display.replace(/\s+/g, "");
        if (!id || models.has(id.toLowerCase()))
            continue;
        const tiers = row.context_config && typeof row.context_config === "object" ? Object.values(row.context_config) : [];
        const ctxMax = tiers.reduce((max, tier) => Math.max(max, Number(tier && tier.token_count) || 0), 0);
        const efforts = row.thinking_config && row.thinking_config.enabled && row.thinking_config.enabled.efforts;
        models.set(id.toLowerCase(), {
            id,
            name: display,
            upstreamKey: key,
            rate: row.price_factor == null ? null : Number(row.price_factor),
            capabilities: { reasoning: !!row.is_reasoning, tools: true, images: !!row.is_vl },
            reasoning: efforts && typeof efforts === "object" && Object.keys(efforts).length
                ? { effort: null, defaultEffort: "", supportedEfforts: Object.keys(efforts) }
                : null,
            contextLength: ctxMax || Number(row.max_input_tokens) || (site.modelScene ? 0 : DEFAULT_CONTEXT_WINDOW),
            maxOutputTokens: site.modelScene ? 32768 : 0,
        });
    }
    return [...models.values()];
}
/** 单个会话/请求 id：Qoder 要求 request_id 唯一（重复会被 code 103 拒绝） */
const newId = () => crypto.randomUUID();
/**
 * 工厂：deps = { fetchStream, pumpSse, httpJson, rules, auth, signer, store }
 * product：qoder（CN）/ qoder_intl（国际版）
 */
function makeQoder(product, deps) {
    const { fetchStream, pumpSse, httpJson, rules, auth, signer, store, util } = deps;
    // util 为必填：用于 hasConsumableDelta（流中断时的本地出线判定）。
    // 缺省时退回 require（生产环境由 adapters.cjs 注入；单测可直接传 util）
    const U = util || require("./util.cjs");
    // 站点表是默认值，rules/headers.json 的同名段是**覆盖层**（用户可热改）。
    // 千问办公双站的常量绝大部分来自站点表（实测/推断都在那里标注），
    // rules 里只放需要按机器改的项（超时、UA 覆盖等）。
    const site = qoderSites.of(product) || qoderSites.SITES.qoder;
    const cfg = () => {
        const row = (rules.get("headers.json") || {})[product] || {};
        return {
            openApi: site.openApi,
            gateway: site.gateway,
            quotaPath: site.usagePath || "/api/v2/quota/usage",
            userAgent: site.userAgent || row.userAgent || "qoder/0.4.3",
            cosyVersion: site.cosyVersion,
            ...row,
        };
    };
    /** 把 /api/v2/quota/usage 的四族额度摊成逐包行（一族都没有 ⇒ 空数组，调用方回落账号级聚合）。
     *  三条字段事实（都不是猜的）：
     *   · **只有 dedicatedResourcePackages[] 自带到期**，且是 ISO 字符串
     *     （"2026-10-21T14:54:12.176671Z"）——与顶层那个毫秒 expiresAt 同名不同型，
     *     必须各走 normalizeExpiryMs（它同时认 ISO 与 ms；本文件原来的 num() 只认数字，
     *     拿它读 ISO 会得到 NaN→0，到期就静默消失了）。
     *   · 组织资源包的总额字段是 **cap** 而不是 total；只按 total 读会拿到 0（= 已用完）。
     *   · 专用包的 name/description 里带内部 campaign id，界面能认的只有 displayLabels[].title。
     *  到期归属：顶层 expiresAt 是**套餐级**到期，所以只挂「套餐额度」那一行；
     *  资源包/组织包上游不给到期 ⇒ 落 0 显示「长期」，不编日期。 */
    function creditPackagesOf(d, planExpiresAt, num) {
        const out = [];
        const push = (code, name, q, expiresAt) => {
            if (!q || typeof q !== "object")
                return;
            const hasTotal = Number.isFinite(Number(q.total)) || Number.isFinite(Number(q.cap));
            const total = !hasTotal ? -1 : (Number.isFinite(Number(q.total)) ? Number(q.total) : Number(q.cap));
            const r2 = (v) => Math.round(v * 100) / 100;
            out.push({
                code: String(code).slice(0, 128),
                name: String(name).slice(0, 128),
                // -1 在这里是「上游不给这一包的总额」（日历渲染「—」），不是「额度不限」
                total: r2(total),
                used: r2(num(q.used)),
                // 负剩余夹成 0：上游欠额时给的是负数，而 -1 是「不限」哨兵，透下去会把整号余额
                // 派生成无限并绕开 cost-first 路由
                remaining: r2(Math.max(0, num(q.remaining))),
                expiresAt: expiresAt || 0,
                ord: out.length,
            });
        };
        push("user", "套餐额度", d.userQuota, planExpiresAt);
        push("addon", "资源包", d.addOnQuota, 0);
        push("org", "组织资源包", d.orgResourcePackage, 0);
        for (const p of Array.isArray(d.dedicatedResourcePackages) ? d.dedicatedResourcePackages : []) {
            if (!p || typeof p !== "object")
                continue;
            // 只认显式 false：上游「包失效」时翻哪个字段没有样本可依据，宁多列一行也不误删
            if (p.available === false)
                continue;
            const label = (Array.isArray(p.displayLabels) && p.displayLabels[0] && p.displayLabels[0].title) || "专用资源包";
            push(p.id || `dedicated${out.length}`, label, p, U.normalizeExpiryMs(p.expiresAt));
        }
        return out;
    }
    // ===== 签名会话池 =====
    // 为什么需要池（两个动机）：
    //   1) 根治泄漏——原先 chat() 每请求 createSession 且**从不 free**（代码注释自己写着
    //      "先不 free"却没有后续释放路径），wasm 内存只能靠 FinalizationRegistry 靠 GC 兜底，
    //      长驻进程不可靠；fetchModels 虽有 free 但每请求实例化本身也是浪费。
    //   2) 省延迟——免掉每请求的 generate_runtime_auth_fields + QoderContext wasm 实例化。
    // 设计要点：
    //   · 键 = uid|machineId|token：refresh 轮换出新 token 后自然换新会话，旧条目按 LRU 淘汰
    //   · 容量淘汰只挑 inUse=0 的空闲条目——流式响应可持续数分钟，绝不 free 正在流式使用的实例
    //   · 全忙时允许暂超容量（本轮不淘汰），下轮 acquire 再收——宁多勿崩
    const sessionPool = new Map(); // key -> { session, at, inUse }
    const SESSION_POOL_MAX = 12;
    /**
     * 从池里取（或新建）签名会话，返回 { session, release }。
     * 调用方在用完后（流读完/解密完）必须调 release()——它只递减 inUse，不销毁实例；
     * 销毁只发生在容量淘汰时。签名器不可用抛出的错误带 503/qoderSignerDown 标记（渠道级故障，不罚账号）。
     */
    async function acquireSession(account, secrets) {
        const uid = (account && account.uid) || "";
        const machineId = (account && account.meta && account.meta.machineId) || account.machineId || "";
        const token = (secrets && secrets.token) || "";
        const k = `${uid}|${machineId}|${token}`;
        let entry = sessionPool.get(k);
        if (!entry) {
            let session;
            try {
                session = await signer.createSession({ product, token, uid, machineId });
            }
            catch (e) {
                // 截断上限 240：签名器不可用时会带上「客户端版本 / obf 体积 / 入口标记 / 内嵌 wasm /
                // 已命中特征 / 取证脚本」这段诊断（见 qoderSigner.buildPatchedModule），
                // 160 会把最后那段取证指引切掉——而它正是用户自助定位的唯一入口
                throw Object.assign(new Error(`Qoder 签名器不可用：${String((e && e.message) || e).slice(0, 240)}`), {
                    status: 503,
                    qoderSignerDown: true,
                });
            }
            // createSession 在途时同 key 请求可能已并发创建：命中则 free 新实例复用旧条目，
            // 否则先到的 entry 成孤儿 wasm 会话（release 只减自己的 inUse，销毁只发生在池淘汰）
            const existing = sessionPool.get(k);
            if (existing) {
                try {
                    session.free && session.free();
                }
                catch { /* 已释放 */ }
                entry = existing;
            }
            else {
                entry = { session, at: Date.now(), inUse: 0 };
                sessionPool.set(k, entry);
            }
            while (sessionPool.size > SESSION_POOL_MAX) {
                let evictKey = null;
                let oldest = Infinity;
                for (const [ek, ev] of sessionPool) {
                    if (ev.inUse > 0)
                        continue;
                    if (ev.at < oldest) {
                        oldest = ev.at;
                        evictKey = ek;
                    }
                }
                if (!evictKey)
                    break; // 全忙：暂超容量
                const ev = sessionPool.get(evictKey);
                sessionPool.delete(evictKey);
                try {
                    ev.session.free && ev.session.free();
                }
                catch { /* 已释放 */ }
            }
        }
        entry.inUse += 1;
        entry.at = Date.now();
        return {
            session: entry.session,
            release() {
                entry.inUse = Math.max(0, entry.inUse - 1);
                entry.at = Date.now();
            },
        };
    }
    /** 目录索引：从 rules/catalog.json 读（fetchModels 写入），带缓存 */
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
        const entry = all[product];
        const byKey = new Map();
        for (const m of (entry && Array.isArray(entry.models) ? entry.models : [])) {
            if (m && m.id)
                byKey.set(String(m.id).toLowerCase(), m);
        }
        catalogCache = { at: st, byKey, raw: entry || null };
        return catalogCache;
    }
    return {
        // 供自测校验逐包映射：纯函数，喂合成的 /api/v2/quota/usage 载荷即可，不需要签名会话
        __creditPackagesForTest: creditPackagesOf,
        id: product,
    readForwardContext(account) {
        return { machineId: String(account?.meta?.machineId || account?.machineId || "") };
    },
        refreshWindowSec: 86400, // token 30 天；提前 24h 预刷新（dt- 非 JWT，靠落库的 expiresAt 判断）
        cfg,
        /**
         * 模型 id 清单（同步；管理页/路由用）：
         *   · 已拉取过目录 → **只认目录**。目录是该产品上游的真实清单，静态兜底表只是历史快照，
         *     并集会重新引入「上游已下架/本产品根本没有的 key」（issue #74 的幽灵模型）；
         *   · 未拉取过目录（目录为空）→ 才退回本 product 的静态兜底，保证首次可用性。
         */
        models() {
            // 注意用 Map 本身取 size：Map.keys() 返回的是迭代器，迭代器没有 size
            // （写成 `catalogIndex().byKey.keys()` 再判 .size 会恒为 undefined → 永远走兜底）
            const byKey = catalogIndex().byKey;
            if (byKey.size)
                return [...byKey.keys()];
            return staticModelsOf(product).map((m) => m.id);
        },
        /**
         * 拉取官方目录。
         *   ① 远端（首选）：`GET {gateway}/algo/api/v2/model/list?Encode=1`，纯 Node crypto
         *      的 COSY 签名（不依赖本机客户端，Docker 环境同样可用）；
         *   ② Qoder 本机兜底：解密 catalog-v6（无网络环境 / 远端失败时）。
         * 目录 id 一律用官方客户端展示名（去空白），上游 key 放 upstreamKey——
         * 旧实现拿内部 key 当 id 且过滤 enable:false，界面与客户端对不上（#179）。
         */
        async fetchModels(account, secrets) {
            const uid = String((account && account.uid) || "");
            const token = String((secrets && secrets.token) || "");
            const machineId = String((account && ((account.meta && account.meta.machineId) || account.machineId)) || "");
            const remoteBase = String((cfg().gateway || site.gateway || "")).replace(/\/+$/, "");
            let remoteMessage = "";
            if (uid && token && remoteBase) {
                try {
                    const url = `${remoteBase}/algo/api/v2/model/list?Encode=1`;
                    const headers = cosy.buildAuthHeaders({
                        url, body: null,
                        identity: { uid, token, machineId },
                        site: {
                            ...site,
                            userAgent: cfg().userAgent || site.userAgent || (site.isQwenwork ? "qoderwork/1.1.0" : "qoder/0.4.8"),
                        },
                    });
                    headers.accept = "application/json";
                    const r = await httpJson(url, { method: "GET", headers })
                        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                    if (r.status === 401 || r.status === 403) {
                        remoteMessage = "远端模型目录拒绝了这份凭据（HTTP 401/403）";
                    }
                    else if (!r.ok || !r.data) {
                        remoteMessage = `远端模型目录请求失败 HTTP ${r.status || 0}`;
                    }
                    else {
                        const payload = catalogPayload(r.data);
                        const models = modelsFromRemote(payload, site);
                        if (models.length)
                            return { ok: true, models, source: "remote", scene: site.modelScene || DEFAULT_SCENE, modelCount: models.length };
                        remoteMessage = "远端模型目录为空或结构已变化";
                    }
                }
                catch (e) {
                    remoteMessage = String((e && e.message) || e).slice(0, 180);
                }
            }
            else {
                remoteMessage = !uid ? "缺少 uid，无法定位模型目录" : "缺少访问令牌";
            }
            // 千问办公没有本机 catalog-v6：远端失败就用站点静态兜底，不写假目录
            if (site.modelScene) {
                return { ok: false, message: `${site.product} 远端模型目录拉取失败：${remoteMessage || "未知原因"}；继续使用内置静态清单（${(site.fallbackModels || []).map((m) => m.name).join(" / ")}）` };
            }
            if (!uid)
                return { ok: false, message: "缺少 uid，无法定位模型目录缓存" };
            const blob = auth.readCatalogBlob(product, uid);
            if (!blob)
                return { ok: false, message: `本机无模型目录缓存（该客户端尚未登录使用过）；远端目录：${remoteMessage || "不可用"}` };
            let entry;
            try {
                entry = await acquireSession(account, secrets);
            }
            catch (e) {
                return { ok: false, message: `签名器不可用：${String((e && e.message) || e).slice(0, 120)}` };
            }
            let json;
            try {
                json = JSON.parse(entry.session.modelCacheDecrypt(blob, uid));
            }
            catch (e) {
                return { ok: false, message: `目录解密失败：${String((e && e.message) || e).slice(0, 120)}` };
            }
            finally {
                entry.release();
            }
            const seen = new Map();
            // 目录按场景分组，同一展示名在不同场景可能重复：assistant/chat 优先，其余补漏
            const order = [DEFAULT_SCENE, "chat", "quest", "developer", ...Object.keys(json)];
            for (const sc of order) {
                const arr = json[sc];
                if (!Array.isArray(arr))
                    continue;
                for (const m of arr) {
                    if (!m || !m.key || !m.display_name)
                        continue;
                    // enable 是「当前账号当前套餐能不能用」，不是「客户端展不展示」：
                    // 按它过滤会把目录从十几条砍到一两条（与客户端列表不符，见 #179）。
                    const id = String(m.display_name).replace(/\s+/g, "").trim();
                    if (!id || seen.has(id.toLowerCase()))
                        continue;
                    const ctxTiers = m.context_config && typeof m.context_config === "object" ? Object.values(m.context_config) : [];
                    const ctxMax = ctxTiers.reduce((n, t) => Math.max(n, Number((t && t.token_count) || 0)), 0);
                    const efforts = (() => {
                        const e = m.thinking_config && m.thinking_config.enabled && m.thinking_config.enabled.efforts;
                        return e && typeof e === "object" ? Object.keys(e) : [];
                    })();
                    seen.set(id.toLowerCase(), {
                        id,
                        name: String(m.display_name || id),
                        upstreamKey: String(m.key),
                        rate: m.price_factor != null ? Number(m.price_factor) : null,
                        capabilities: { reasoning: !!m.is_reasoning, tools: true, images: !!m.is_vl },
                        reasoning: efforts.length
                            ? { effort: null, defaultEffort: "", supportedEfforts: efforts }
                            : null,
                        contextLength: ctxMax || Number(m.max_input_tokens) || DEFAULT_CONTEXT_WINDOW,
                        maxOutputTokens: 0,
                        // 附加展示字段（管理页可用；不影响既有契约）
                        isFree: m.is_free === true || Number(m.price_factor) === 0,
                        scene: sc,
                    });
                }
            }
            const models = [...seen.values()];
            if (!models.length)
                return { ok: false, message: "目录为空（结构可能已变更）" };
            return { ok: true, models, source: "local", scene: DEFAULT_SCENE, modelCount: models.length };
        },
        /** 非签名基础头（签名头由 chat() 内 wasm 产出，禁止在此构造） */
        headers() {
            const c = cfg();
            return {
                "content-type": "application/json",
                accept: "text/event-stream",
                "user-agent": c.userAgent || "qoder/0.4.3",
            };
        },
        /**
         * 额度查询：GET {quotaBase}/api/v2/quota/usage?requestId=<uuid>（纯 Bearer，无需签名）。
         * ⚠ 两区端点域不同（实测）：CN 走 gateway 亦可，**INTL 只在 openapi**（gateway 返回 404）。
         *   故由 cfg.quotaBase 显式指定，回退顺序 gateway → openApi。
         * 口径：可用额度 = userQuota.remaining + addOnQuota.remaining（FIFO：先扣套餐再扣每日领取）。
         */
        async queryCredits(account, secrets) {
            const c = cfg();
            // 千问办公读的是另一份文档（Agent2Providers qoder/balance.rs qwenwork_usage）：
            //   账号上下文 {user, plan, quota} → quota.remaining 才是余额；
            //   个人账号（user.is_biz !== true）另有 /wallets 三档积分池，只作明细行、
            //   不再叠加进余额（那份余额本来就是三档之和）。
            // 个人账号的 quota.total / used 是 null —— 只报余额，不反推「已用占比」。
            if (site.isQwenwork) {
                const base = String(c.openApi || site.openApi).replace(/\/+$/, "");
                const path = site.usagePath || "/api/v1/adapter/user/account-context?include=user,plan,quota";
                const hdrs = { Authorization: `Bearer ${secrets.token}`, Accept: "application/json", "User-Agent": c.userAgent || "qoderwork/1.1.0", "Login-Version": "v2" };
                const r = await httpJson(`${base}${path}`, { method: "GET", headers: hdrs })
                    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                if (r.status === 401 || r.status === 403)
                    return { authError: true, message: "凭证失效（千问办公账号上下文拒绝该令牌）" };
                if (!r.ok || !r.data)
                    return { error: `额度查询失败 HTTP ${r.status || 0}${r.message ? " " + r.message : ""}` };
                const data = (r.data && r.data.data && typeof r.data.data === "object") ? r.data.data : r.data;
                const quota = (data && data.quota && typeof data.quota === "object") ? data.quota : null;
                if (!quota)
                    return { unavailable: true, message: "额度结构未识别（账号上下文里没有 quota）" };
                const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
                const remaining = Number.isFinite(Number(quota.remaining)) ? Number(quota.remaining) : 0;
                const total = Number.isFinite(Number(quota.total)) ? Number(quota.total) : -1;
                const used = Number.isFinite(Number(quota.used)) ? Number(quota.used) : (total >= 0 ? Math.max(total - remaining, 0) : -1);
                const plan = (data && data.plan && typeof data.plan === "object") ? data.plan : {};
                const expiresAt = U.normalizeExpiryMs(plan.next_refresh_date || plan.next_due_date) || 0;
                const packages = [{
                    code: "quota", name: "积分", total, used,
                    remaining: Math.max(remaining, 0), expiresAt, ord: 0,
                }];
                // 三档钱包（只有国内版个人账号有；读失败不阻断）
                if (site.walletsPath) {
                    const user = (data && data.user && typeof data.user === "object") ? data.user : {};
                    const isBiz = user.is_biz === true || user.isBiz === true;
                    if (!isBiz) {
                        const w = await httpJson(`${base}${site.walletsPath}`, { method: "GET", headers: hdrs }).catch(() => null);
                        const pools = w && w.ok && w.data ? (w.data.data || w.data) : null;
                        if (pools && typeof pools === "object") {
                            let ord = 1;
                            for (const [label, key] of [["每日积分", "daily"], ["每月积分", "monthly"], ["长期积分", "permanent"]]) {
                                const pool = pools[key] || (Array.isArray(pools.wallets) ? pools.wallets.find((x) => x && x.type === key) : null);
                                const bal = Number.isFinite(Number(pool && (pool.balance ?? pool.remaining))) ? Number(pool.balance ?? pool.remaining) : null;
                                if (bal == null) continue;
                                packages.push({ code: key, name: label, total: -1, used: -1, remaining: Math.max(bal, 0), expiresAt: 0, ord: ord++ });
                            }
                        }
                    }
                }
                return { credits: Math.round(remaining * 100) / 100, expiresAt, packages, planName: String(plan.name || ""), detail: { quota, plan } };
            }
            const bases = [c.quotaBase, c.gateway, c.openApi].filter(Boolean).filter((b, i, arr) => arr.indexOf(b) === i);
            let last = null;
            for (const base of bases) {
                const url = `${String(base).replace(/\/+$/, "")}${c.quotaPath || "/api/v2/quota/usage"}?requestId=${newId()}`;
                const r = await httpJson(url, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${secrets.token}`, Accept: "application/json", "user-agent": c.userAgent || "qoder/0.4.3" },
                }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                if (r.status === 401)
                    return { authError: true, message: "凭证失效（token is not active）" };
                if (r.ok && r.data) {
                    const d = r.data;
                    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
                    const remaining = num(d.userQuota && d.userQuota.remaining) + num(d.addOnQuota && d.addOnQuota.remaining);
                    const expiresAt = num(d.expiresAt);
                    if (d.userQuota || d.addOnQuota) {
                        return {
                            credits: Math.round(remaining * 100) / 100,
                            expiresAt,
                            packages: creditPackagesOf(d, expiresAt, num),
                            userType: d.userType || "",
                            detail: { userQuota: d.userQuota || null, addOnQuota: d.addOnQuota || null },
                        };
                    }
                    if (Number.isFinite(Number(d.credits)))
                        return { credits: Number(d.credits), expiresAt };
                    return { unavailable: true, message: "额度结构未识别（接口可能已变更）" };
                }
                last = r;
            }
            return { error: `额度查询失败 HTTP ${(last && last.status) || 0}（已试 ${bases.length} 个域）` };
        },
        /**
         * 每日领取 100 Credits（每日 10:00 UTC+8 刷新，领取后 30 天有效）。
         *
         * 实测打通的两步（2026-10-04 验证成功：addOnQuota 100→200，campaign CLAIMABLE→CLAIMED）：
         *   ① GET  {openApi}/sash/api/v1/me/campaigns
         *        → campaigns[] 里筛 actionType=CLAIM_BENEFIT && claimStatus=CLAIMABLE
         *   ② POST {openApi}/sash/api/v1/me/campaigns/{campaignId}/claim   body={}
         *        → {grantId, status:"CLAIMED", replayed:bool, benefit:{kind,amount,validity}}
         *
         * ⚠ 三个必须做对的地方（都是实测踩出来的）：
         *   · 路径参数是 **campaignId（UUID）**，不是 campaignKey（用 key 会 400 FIELD_VALIDATION_FAILED）
         *   · 必须带 **Cosy-ClientType** 这一组头，否则服务端**静默**返回 claimable:false
         *     （表现为"今天没有可领活动"，实际是鉴权降级——极易误判为无活动）
         *   · Cosy-Machine{Token,Type,Code} 由客户端自带 runtime-info.exe 生成（见 qoderAuth.readRiskIdentity）
         *
         * 幂等性：重复领取返回 replayed:true 且 status:"CLAIMED" —— 这是**成功**语义（已领过），
         * 必须按 already 处理，不能报错，否则每天第二次调用会误报失败。
         *
         * ⚠ 形态来源存疑（2026-10-28 REA 复核，见 docs/号池签到核对-20261028/11-qoder-zcode-签到核对.md §3.2 / §4.2.1 / §5）：
         *   上面 ① 的 campaigns[] / actionType=CLAIM_BENEFIT / claimStatus=CLAIMABLE / campaignId 形态，
         *   在本机 Qoder CN 0.4.8 与 INTL 0.1.8 的桌面端主进程里**都找不到**（全 asar 无 campaigns[]/campaignId/
         *   CLAIM_BENEFIT）；桌面端只消费 {showCampaign, claimable, campaignUrl}，真正的 claim 由 campaignUrl
         *   指向的远端活动页发出（主进程仅 installBeforeSendHeaders 注入 Cosy-* 头）。
         *   现有 campaigns[] 分支有实测记录、**保留不动**，同时兼容两种响应形态。
         */
        async checkin(account, secrets) {
            // 千问办公**没有**可领取的每日活动（Agent2Providers endpoints.rs supports_checkin=false：
            // 活动/签到接口是 Qoder 的 sash 一族，千问办公没有对应产品面）。
            // 如实回报 unavailable，不伪造「已领取」。
            if (site.supportsCheckin === false)
                return { ok: false, unavailable: true, message: "千问办公没有每日领取活动（该产品面只有账号上下文与额度）" };
            const c = this.cfg();
            // 兜底对齐 chat（auth.PRODUCTS[product].openApi）：INTL 配置缺失时不再拿 INTL token 打 CN 域必 401
            const base = c.openApi || c.quotaBase || auth.PRODUCTS[product].openApi || "https://openapi.qoder.com.cn";
            const uid = (account && account.uid) || "";
            const risk = auth.readRiskIdentity ? auth.readRiskIdentity(product, uid) : null;
            if (!risk) {
                // 风控身份拿不到（组件未装 / 组件在但执行失败）→ 如实回报，不降级尝试（降级必然 401/静默 false）。
                // 用 riskDiagnostic 区分两种原因：原来一律说「需安装客户端」，组件装好却生成失败的用户会被误导去重装。
                const hint = typeof auth.riskDiagnostic === "function"
                    ? auth.riskDiagnostic(product).hint
                    : "需安装 Qoder 客户端（领取接口要求其风控身份 runtime-info.exe）";
                return { ok: false, unavailable: true, message: hint };
            }
            const hdrs = {
                Authorization: `Bearer ${secrets.token}`,
                Accept: "application/json",
                "User-Agent": c.userAgent || "Qoder",
                "Cosy-ClientType": "10",
                // Cosy-Version 缺省值对齐 Qoder CN 0.4.8（客户端取 app.getVersion() = app.asar!package.json.version，
                // 升级客户端后需同步此处）；仍可被 cfg 的 cosyVersion 覆盖。见 11-qoder-zcode-签到核对.md §3.1 / §3.3、H2 判定
                "Cosy-Version": c.cosyVersion || "0.4.8",
                "Cosy-MachineId": (account.meta && account.meta.machineId) || account.machineId || "",
                "Cosy-MachineOS": osVersion(),
                "Cosy-MachineHostname": U.byteSafeHeaderValue(os.hostname()),
                "Cosy-MachineToken": risk.machineToken,
                "Cosy-MachineType": risk.machineType,
                "Cosy-MachineCode": risk.machineCode,
            };
            // 不带 ?forceRefresh=true：客户端 forceRefresh 只用于旁路本地 5 分钟缓存，不进 URL。
            // 见 11-qoder-zcode-签到核对.md §3.2 / C9
            const listUrl = `${String(base).replace(/\/+$/, "")}/sash/api/v1/me/campaigns`;
            let list;
            try {
                list = await httpJson(listUrl, { method: "GET", headers: hdrs });
            }
            catch (e) {
                return { ok: false, message: `活动列表请求失败：${(e && e.message) || e}` };
            }
            if (list.status === 401 || list.status === 403)
                return { authError: true, message: "凭证失效（活动接口不接受该 token）" };
            if (!list.ok || !list.data)
                return { ok: false, message: `活动列表 HTTP ${list.status}` };
            // 形态兼容：Qoder 桌面端主进程只认 {showCampaign, claimable, campaignUrl}（客户端 getStatus 归一化结果），
            // 全 asar 无 campaigns[] / campaignId / CLAIM_BENEFIT；号池现有 campaigns[] 分支来源存疑（可能旧版/Web 端），
            // 当前**保留不动**并兼容两种形态。见 11-qoder-zcode-签到核对.md §3.2 / §4.2.1 / §5
            const body = list.data;
            if (!Array.isArray(body.campaigns)
                && (typeof body.claimable === "boolean" || typeof body.showCampaign === "boolean" || typeof body.campaignUrl === "string")) {
                const campaignUrl = typeof body.campaignUrl === "string" ? body.campaignUrl.trim() : "";
                if (body.claimable === true && campaignUrl) {
                    return { ok: true, claimable: true, campaignUrl, message: "存在可领取活动（远端活动页）" };
                }
                return { ok: true, already: true, message: "当前没有可领取的活动" };
            }
            const campaigns = Array.isArray(list.data.campaigns) ? list.data.campaigns : [];
            const claimable = campaigns.filter((x) => x && x.actionType === "CLAIM_BENEFIT" && x.claimStatus === "CLAIMABLE" && x.campaignId);
            if (!claimable.length) {
                // 无 CLAIMABLE：先判「窗口未开」再判「已领完」。
                // 每日 Credits 的领取窗口每天 10:00（UTC+8）重置：10:00 前昨日实例仍显示 CLAIMED，
                // 此时若自动签到照常标记"今日已完成"，就会错过 10:05 起的新窗口（一天只跑一次的设计）。
                // 判据：存在与可领活动同类型（CLAIM_BENEFIT）且 endAt 在未来的已领实例
                //   → 返回 deferred + retryAt（= endAt + 5 分钟抖动），调度器据此延后重试。
                // 取**最早**的未来 endAt：列表混有其它活动的远期实例时，取错会把重试时刻
                // 带偏到几天后，连累其它渠道的每日签到一起停摆。
                const claimed = campaigns.filter((x) => x && x.claimStatus === "CLAIMED");
                const nowSec = Math.floor(Date.now() / 1000);
                let nextWindowSec = Infinity;
                for (const x of campaigns) {
                    if (!x || x.claimStatus !== "CLAIMED" || x.actionType !== "CLAIM_BENEFIT")
                        continue;
                    const end = Number(x.endAt);
                    if (end > nowSec && end < nextWindowSec)
                        nextWindowSec = end;
                }
                if (Number.isFinite(nextWindowSec)) {
                    const retryAt = nextWindowSec * 1000 + 5 * 60000;
                    return {
                        ok: true,
                        already: true,
                        deferred: true,
                        retryAt,
                        message: `当前窗口已领取；下一窗口开放后（每日 10:00 UTC+8）自动重试`,
                    };
                }
                return {
                    ok: true,
                    already: true,
                    message: claimed.length ? "今日已领取" : "当前没有可领取的活动",
                };
            }
            let claimedAny = 0;
            let replayedAny = 0;
            let lastMsg = "";
            for (const cmp of claimable) {
                const url = `${String(base).replace(/\/+$/, "")}/sash/api/v1/me/campaigns/${encodeURIComponent(cmp.campaignId)}/claim`;
                let r;
                try {
                    r = await httpJson(url, { method: "POST", headers: { ...hdrs, "Content-Type": "application/json" }, body: "{}" });
                }
                catch (e) {
                    lastMsg = `领取请求失败：${(e && e.message) || e}`;
                    continue;
                }
                if (r.status === 401 || r.status === 403)
                    return { authError: true, message: "凭证失效" };
                // 409 + ALREADY_CLAIMED 是上游并发/重放时的「今天已领过」成功语义（实测），
                // 落 !r.ok 会误报领取失败
                if (r.status === 409 && r.data && r.data.result === "ALREADY_CLAIMED") {
                    replayedAny += 1;
                    lastMsg = "今日已领取";
                    continue;
                }
                if (!r.ok || !r.data) {
                    const code = r.data && r.data.errorCode;
                    // GRANT_NOT_FOUND 是活动页预期的可重试分支（服务端状态未就绪），非致命
                    lastMsg = code === "GRANT_NOT_FOUND" ? "活动尚未就绪（GRANT_NOT_FOUND），请稍后重试" : `领取失败 HTTP ${r.status}${code ? ` ${code}` : ""}`;
                    continue;
                }
                if (r.data.replayed === true) {
                    // 幂等重复：服务端说"这次没发新额度"。必须标 already —— 否则上层会把"已领过"
                    // 当成"刚领到"，UI 每次点击都报"领取成功"。
                    replayedAny += 1;
                    lastMsg = "今日已领取";
                    continue;
                }
                if (r.data.status === "CLAIMED") {
                    claimedAny += 1;
                    const amt = r.data.benefit && Number(r.data.benefit.amount);
                    lastMsg = Number.isFinite(amt) ? `领取成功 +${amt} Credits` : "领取成功";
                }
                else {
                    lastMsg = `领取未生效（status=${r.data.status || "unknown"}）`;
                }
            }
            if (claimedAny > 0)
                return { ok: true, message: lastMsg || "领取成功" };
            // 全部命中 replayed：视为"今日已领取"（ok=true + already=true，UI 按幂等展示）
            if (replayedAny > 0)
                return { ok: true, already: true, message: lastMsg || "今日已领取" };
            return { ok: false, message: lastMsg || "领取失败" };
        },
        /**
         * 签到状态探测：读活动列表（与 checkin 同一接口），只判断有无可领，不触发领取。
         * 供号池页「一键签到」在真正领取前展示状态。
         */
        async checkinStatus(account, secrets) {
            if (site.supportsCheckin === false)
                return { unavailable: true, message: "千问办公没有每日领取活动" };
            const c = this.cfg();
            const base = c.openApi || auth.PRODUCTS[product].openApi || "https://openapi.qoder.com.cn";
            const uid = (account && account.uid) || "";
            const risk = auth.readRiskIdentity ? auth.readRiskIdentity(product, uid) : null;
            if (!risk)
                return { unavailable: true, message: "需安装 Qoder 客户端（风控身份不可用）" };
            const hdrs = {
                Authorization: `Bearer ${secrets.token}`,
                Accept: "application/json",
                "User-Agent": c.userAgent || "Qoder",
                "Cosy-ClientType": "10",
                // 同 checkin：缺省值对齐 Qoder CN 0.4.8，可被 cfg.cosyVersion 覆盖。见 11-qoder-zcode-签到核对.md §3.1 / §3.3
                "Cosy-Version": c.cosyVersion || "0.4.8",
                "Cosy-MachineId": (account.meta && account.meta.machineId) || account.machineId || "",
                "Cosy-MachineOS": osVersion(),
                "Cosy-MachineHostname": U.byteSafeHeaderValue(os.hostname()),
                "Cosy-MachineToken": risk.machineToken,
                "Cosy-MachineType": risk.machineType,
                "Cosy-MachineCode": risk.machineCode,
            };
            try {
                // 同 checkin：不带 ?forceRefresh=true，客户端不进 URL。见 11-qoder-zcode-签到核对.md §3.2 / C9
                const list = await httpJson(`${String(base).replace(/\/+$/, "")}/sash/api/v1/me/campaigns`, { method: "GET", headers: hdrs });
                if (list.status === 401 || list.status === 403)
                    return { authError: true, message: "凭证失效" };
                if (!list.ok || !list.data)
                    return { unavailable: true, message: `活动列表 HTTP ${list.status}` };
                // 形态兼容（同 checkin）：桌面端只认 {showCampaign, claimable, campaignUrl}。
                // 见 11-qoder-zcode-签到核对.md §3.2 / §4.2.1 / §5
                // 注：本方法统一「可领数量」语义，故此处返回数字 1（与 campaigns[] 分支类型一致）；
                // checkin 里的同名兼容分支返回布尔 true（那里是控制流信号，非展示用数量）
                const body = list.data;
                if (!Array.isArray(body.campaigns)
                    && (typeof body.claimable === "boolean" || typeof body.showCampaign === "boolean" || typeof body.campaignUrl === "string")) {
                    const campaignUrl = typeof body.campaignUrl === "string" ? body.campaignUrl.trim() : "";
                    if (body.claimable === true && campaignUrl) {
                        return { ok: true, claimable: 1, campaignUrl, message: "存在可领取活动（远端活动页）" };
                    }
                    return { ok: true, already: true, message: "当前没有可领取的活动" };
                }
                const campaigns = Array.isArray(list.data.campaigns) ? list.data.campaigns : [];
                const n = campaigns.filter((x) => x && x.actionType === "CLAIM_BENEFIT" && x.claimStatus === "CLAIMABLE").length;
                if (n > 0)
                    return { ok: true, claimable: n, message: `有 ${n} 个活动可领取` };
                const claimed = campaigns.filter((x) => x && x.claimStatus === "CLAIMED").length;
                return { ok: true, already: true, message: claimed ? "今日已领取" : "当前无可领取活动" };
            }
            catch (e) {
                return { unavailable: true, message: `活动列表请求失败：${(e && e.message) || e}` };
            }
        },
        /**
         * 续期：POST {openApi}/api/v1/deviceToken/refresh（见 qoderAuth.refreshDeviceToken）。
         * refresh_token 轮换制：新旧两个 token 必须同时返回并落库。
         */
        async refreshToken(account, secrets) {
            if (!secrets.refreshToken)
                return { ok: false, message: "无 refreshToken，请从本机重新导入" };
            const machineId = (account.meta && account.meta.machineId) || account.machineId || "";
            // target：千问办公续期要多带 target:"c"（site.refreshTarget，由 qoderAuth 内部取）
            const r = await auth.refreshDeviceToken(product, secrets.refreshToken, machineId);
            if (!r.ok)
                return { ok: false, message: r.message || `刷新失败 HTTP ${r.status}` };
            return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt, refreshTokenExpiresAt: r.refreshTokenExpiresAt };
        },
    };
}
module.exports = { makeQoder };
