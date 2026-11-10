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
// 反代网关 · 渠道适配器（IR 内核 + 协议事实基线）
// 进线 OpenAI body → 归一 → 渠道改写 → 上游 fetch → SSE 事件流转换 → 统一 OpenAI 输出
// 三渠道（trae / workbuddy / workbuddy_ai）差异收敛为「配置（rules/headers.json）+ 改写函数」，
// WorkBuddy CN 与国际版共享适配器核心，配置层隔离、代码零复制
// Management-only registry, awaiting unified production cutover.
"use strict";
const { createSwitchProbe } = require("./workbuddy-switch-probe.cjs");
const crypto = require("node:crypto");
const rules = require("./rules.cjs");
const store = require("./store.cjs");
const util = require("./util.cjs");
const raccoonAuth = require("./raccoonAuth.cjs");
const config = require("../config.cjs");
const platform = require("./platform/index.cjs");
function proxyConfig() {
    try {
        return (config.loadConfig && config.loadConfig().proxy) || {};
    }
    catch {
        return {};
    }
}
/** 渠道启闭（「上游启闭」弹窗）：配置里显式 false = 关闭，其余（缺省/非布尔）= 启用。
 *  cfg 已在调用方就绪时直接传入，避免循环内重复读盘 */
function channelOn(channel, cfg) {
    const c = cfg || proxyConfig();
    const v = (c.channelEnabled || {})[channel];
    return v !== false;
}
// 管理请求与标准执行器共用通用网络工具，不在这里维护第二套超时逻辑。
const { timeoutMs, estimateInputTokens, firstByteBudgetMs, fetchStream, httpJson, pumpSse, FIRST_BYTE_MS, FIRST_BYTE_MAX_MS } = require("../network/http.cjs");
/** 账号级稳定指纹：device_id（自然分布 15 位数字，首位非零，消除连续补零假特征）/ machine_id（64 hex），同账号多次请求保持一致 */
function deviceIds(account) {
    const seed = String((account && (account.id || account.uid)) || "anon");
    const h = crypto.createHash("sha256").update(`agenthub:device:${seed}`).digest();
    let digits = String((h[0] % 9) + 1); // 首位保证 1~9
    let zeroCount = 0;
    for (let i = 1; i < 15; i++) {
        let d = h[i] % 10;
        if (d === 0) {
            zeroCount++;
            if (zeroCount >= 3) {
                d = (h[i] % 9) + 1; // 连续 0 达到 2 个以上时强制扰动为 1~9，根除连续 0 聚集
                zeroCount = 0;
            }
        }
        else {
            zeroCount = 0;
        }
        digits += String(d);
    }
    const machineId = crypto.createHash("sha256").update(`agenthub:machine:${seed}`).digest("hex");
    return { deviceId: digits, machineId };
}
/** Trae `req_source`：SOLO 包（SOLO_CN / SOLO_I18N / SOLO_CN_ENTERPRISE）= 2，普通 TRAE IDE = 1。
 *  客户端 status 与 claim 的 body 都是 `{"req_source":N}`（12 §3.2 逐字证据）。 */
function traeReqSource(c) {
    const n = Number((c && c.checkinReqSource) ?? 2);
    return Number.isFinite(n) && n > 0 ? n : 2;
}
/** Trae 设备头组：客户端从 commonParams 取，**有值才发**。
 *  取值来自 rules 配置（默认只填已知的 app_version）；brand/type/os-version 的客户端实际取值
 *  尚未取到（12 §9 U2，需抓包），**留空即不发**，避免发送与真实客户端不符的值。 */
function traeDeviceHeaders(c) {
    const h = {};
    const cfg = c || {};
    if (cfg.deviceBrand)
        h["x-device-brand"] = String(cfg.deviceBrand);
    if (cfg.deviceType)
        h["x-device-type"] = String(cfg.deviceType);
    if (cfg.osVersion)
        h["x-os-version"] = String(cfg.osVersion);
    if (cfg.appVersion)
        h["x-app-version"] = String(cfg.appVersion);
    return h;
}
/** 权威目录（rules/catalog.json）：渠道 → Map(模型id小写 → 条目{id,name,rate,capabilities,contextLength,...}) */
function catalogMap(channel) {
    const cat = rules.get("catalog.json") || {};
    const sec = cat[channel] || {};
    const map = new Map();
    for (const m of Array.isArray(sec.models) ? sec.models : []) {
        if (m && m.id)
            map.set(String(m.id).toLowerCase(), m);
    }
    return map;
}
function modelMetadata(model, channel, cache) {
    const row = store.channelList().find((c) => c.id === channel);
    let map = cache?.get(channel);
    if (!map) {
        map = row?.kind !== "builtin" && row ? providerCatalogMap(row) : catalogMap(channel);
        cache?.set(channel, map);
    }
    const meta = map.get(String(model).toLowerCase());
    return {
        rate: util.finiteRate(meta?.rate), capabilities: meta?.capabilities || {},
        contextLength: Number(meta?.contextLength) || 0, maxOutputTokens: Number(meta?.maxOutputTokens) || 0,
        metadataScope: "binding", rateSource: row?.kind !== "builtin" && row ? "provider-config" : "catalog",
    };
}
/**
 * 通用模态嗅探：在"结构未知"的上游模型条目里找是否支持图片输入。
 * 用于字段名未逆向清楚/上游改版的渠道（如 Trae）：按 key 名（vision/image/multimodal/modalit）
 * 递归找布尔或数组信号。**找不到时返回 undefined**（=未声明，绝不写成 false——false 会主动禁止客户端附图）。
 */
const IMG_KEY_RE = /^(supports?|has|is|accepts?)(vision|image|multimodal)|(^|_)(vision|image|multimodal|modalit)|modalit/i;
/** 排噪声：与"生成/尺寸/字节数"相关的键不代表"能读图输入"（如 image_gen / imagePixelBudget / text-to-image） */
const IMG_KEY_DENY = /image_?(gen|generation|size|pixel|max|budget|bytes|count|edit)|text_?to_?image|imagePixel|imageMax/i;
const isImgKey = (k) => IMG_KEY_RE.test(k) && !IMG_KEY_DENY.test(k);
function sniffImages(item) {
    let found; // true 最强；false 仅在没有任何 true 信号时采用；undefined = 无信号
    const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 4)
            return;
        if (Array.isArray(node)) {
            for (const v of node)
                visit(v, depth + 1);
            return;
        }
        for (const [k, v] of Object.entries(node)) {
            if (!isImgKey(k)) {
                if (v && typeof v === "object")
                    visit(v, depth + 1);
                continue;
            }
            if (typeof v === "boolean") {
                if (v)
                    found = true;
                else if (found === undefined)
                    found = false;
            }
            else if (Array.isArray(v)) {
                if (v.some((x) => /image|vision/i.test(String(x))))
                    found = true;
            }
            else if (typeof v === "string") {
                if (/^(image|vision|multimodal)$/i.test(v))
                    found = true;
            }
            else if (v && typeof v === "object")
                visit(v, depth + 1);
        }
    };
    visit(item, 0);
    return found;
}
/** 由嗅探结果构造能力对象（未声明时不写 images 键） */
function capsWithImages(img, base) {
    const caps = { ...(base || {}) };
    if (img !== undefined)
        caps.images = img;
    return caps;
}
/**
 * 把上游给的 token 上限归一成非负整数：非法/缺失一律返回 0（=未知）。
 * 模型上限类字段**绝不给编造的默认值**——下游客户端会拿它比对用量，
 * 假值会把正常回答误判成上下文溢出（详见 trae.fetchModels 的注释）。
 */
function tokenLimit(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/**
 * Trae 目录条目的上下文/输出上限（字段结构实证自 2026-10-03 抓取的 get_detail_param 原始响应）：
 *
 *   {
 *     context_window_tokens: { dev: 200000, max: 268000 },   // 上下文窗口，**按环境分档的字典**
 *     model_detail_list: [
 *       { model_name: "xxx__dev", prompt_max_tokens: 168000, max_tokens: 32000 },
 *       { model_name: "xxx__max", prompt_max_tokens: 240000, max_tokens: 32000 },
 *     ],
 *   }
 *
 * 要点：① 窗口是字典而非标量（43 个模型里 10 个有 dev/max 两档，个别为空）；
 * ② 输出上限在 model_detail_list 里，且**每个档位一个条目**（取 [0] 会取错档）；
 * ③ prompt_max_tokens 恒等于「上下文窗口 − max_tokens」（给输出预留），故窗口直接取
 *    context_window_tokens，输出取 max_tokens，两者语义不重叠。
 * 多档位时取最大值，与合并视图「取各来源最大声明」的口径一致，避免少报。
 */
function traeLimits(it) {
    const o = it && typeof it === "object" ? it : {};
    let contextLength = 0;
    const cw = o.context_window_tokens;
    if (cw && typeof cw === "object" && !Array.isArray(cw)) {
        for (const v of Object.values(cw))
            contextLength = Math.max(contextLength, tokenLimit(v));
    }
    else {
        contextLength = tokenLimit(cw);
    }
    let maxOutputTokens = 0;
    if (Array.isArray(o.model_detail_list)) {
        for (const det of o.model_detail_list)
            maxOutputTokens = Math.max(maxOutputTokens, tokenLimit(det && det.max_tokens));
    }
    return { contextLength, maxOutputTokens };
}
/**
 * 能力合并：images 采用 **OR** 语义（任一来源声明支持即支持），undefined 不覆盖已有值；
 * 其余能力沿用后者覆盖。用于修掉"某渠道的 false 把共享模型名的 true 顶掉"的问题
 * （glm-5.3-flash 曾因 zcode 的 false 在合并视图里被当成纯文本，实际它支持图片）。
 */
function mergeCapabilities(base, add) {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(add || {})) {
        if (v === undefined)
            continue;
        if (k === "images") {
            if (v === true || out[k] === undefined)
                out[k] = v;
            continue;
        }
        out[k] = v;
    }
    return out;
}
/** 目录 id 并集去重（大小写不敏感）：catalog 优先，旧文件兜底不丢 */
function unionIds(catalogIds, legacyIds) {
    const out = [];
    for (const id of [...catalogIds, ...legacyIds]) {
        const s = String(id);
        if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase()))
            out.push(s);
    }
    return out;
}
/** 按 key 深度优先找数组（util.dig 只取标量，包列表这类结构要单独挖） */
function findList(node, key, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 5)
        return null;
    if (Array.isArray(node)) {
        for (const v of node) {
            const hit = findList(v, key, (depth || 0) + 1);
            if (hit)
                return hit;
        }
        return null;
    }
    if (Array.isArray(node[key]))
        return node[key];
    for (const v of Object.values(node)) {
        const hit = findList(v, key, (depth || 0) + 1);
        if (hit)
            return hit;
    }
    return null;
}
/** 渠道上游候选域：accountOrigins 优先，其次 creditsUrl / exchangeUrl 的 origin */
function candidateOrigins(c, extra) {
    const out = [];
    for (const o of Array.isArray(c.accountOrigins) ? c.accountOrigins : []) {
        const s = String(o || "").replace(/\/+$/, "");
        if (s && !out.includes(s))
            out.push(s);
    }
    for (const u of [c.creditsUrl, c.exchangeUrl, extra]) {
        try {
            const o = new URL(String(u)).origin;
            if (!out.includes(o))
                out.push(o);
        }
        catch { /* 配置缺项跳过 */ }
    }
    return out;
}
// ===== Trae SOLO CN =====
/** 订阅包取余量：CN 档位优先级 100(CNExpress) > 6 > 5 > 4 > 1 > 9 > 8 > 0，命中即用 */
const TRAE_PACK_PRIORITY = [100, 6, 5, 4, 1, 9, 8, 0];
function pickEntitlementPack(packs) {
    const shaped = packs.map((p) => ({
        productType: Number(util.dig(p, /^product_type$/i)) || 0,
        credits: Number(util.dig(p, /remain|balance|left|available|total_credit|credits|quota/i)) || 0,
        expiresAt: util.toMs(util.dig(p, /end_time|expire|deadline|valid_until/i)),
    }));
    for (const want of TRAE_PACK_PRIORITY) {
        const hit = shaped.find((s) => s.productType === want);
        if (hit)
            return hit;
    }
    // 档位都不认识（上游加了新套餐）：退化成余量最大的那个包
    return shaped.reduce((a, b) => (b.credits > a.credits ? b : a), { productType: 0, credits: 0, expiresAt: 0 });
}
/** Trae 逐包 + 账号级折叠：user_entitlement_pack_list → 到期日历的包行（纯函数，自测直接喂合成样本）。
 *  返回 { packages, credits, expiresAt }；调用点只看 packages.length 决定要不要用这份结果。
 *  两条 -1 的分工与 pool.deriveAccountCredits 同口径：remaining=-1 才是「额度不限」，
 *  total=-1 只是「上游不给这一包的面值」，混了会把整号派生成无限并绕开 cost-first。 */
function traeCredits(packs) {
    const packages = [];
    for (const p of Array.isArray(packs) ? packs : []) {
        // 上游 trae 的三条过滤：隐藏包、已取消(status=3)、兑换码包(product_type=3)。
        // 只在 entitlement_base_info 这一层**直接读**（字段就在那），且只在结构存在时生效——
        // 老响应没这层嵌套时照常出包，不做全域 dig（那会误吃到别的 status）。
        const base = p && typeof p.entitlement_base_info === "object" && p.entitlement_base_info ? p.entitlement_base_info : null;
        if (base) {
            if (base.is_hide === true)
                continue;
            if (Number(base.status) === 3)
                continue;
            if (Number(base.product_type) === 3)
                continue;
        }
        const limit = Number(util.dig(p, /^credits_limit$/i));
        if (!Number.isFinite(limit) || limit === 0)
            continue; // 无该字段 / 面值为 0 = 这份包不属于该号
        const used = Number(util.dig(p, /^credits_amount$/i)) || 0;
        // limit < 0 是上游「不限量」哨兵。旧判据 `limit <= 0 continue` 把这种包**整条丢掉**
        // ⇒ 日历少一行、连带丢掉它的到期。翻成本仓形状：total/remaining 各落 -1（分工见函数头）。
        const unlimited = limit < 0;
        packages.push({
            code: String(util.dig(p, /^entitlement_pack_id$|^pack_id$|^id$/i) || `pack${packages.length}`).slice(0, 128),
            name: String(util.dig(p, /^display_desc$|^name$|^pack_name$/i) || "资源包").slice(0, 128),
            total: unlimited ? -1 : limit,
            used,
            remaining: unlimited ? -1 : Math.max(limit - used, 0),
            // 与 lobster / qoder 那两族同口径走 normalizeExpiryMs（纯日期串补当天末尾、远未来脏值当长期
            // 有效），不再用裸 toMs——不限量包最可能带的就是哨兵型到期，不归一会在日历排出一行「还剩几万年」。
            expiresAt: util.normalizeExpiryMs(util.dig(p, /end_time|expire|deadline|valid_until/i)),
        });
    }
    // 账号级折叠：任一包 remaining=-1 ⇒ 整号「不限」（与 pool.deriveAccountCredits 同判据），
    // 且此后不再累加——把 -1 当欠款加进和里会得到 59 这种「既不是数也不是哨兵」的值。
    // ⚠ 这里不按到期过滤（沿用本渠道既有口径）；落库那份由 credits.cjs 用
    // pool.deriveAccountCredits 覆盖成「Σ 未过期包剩余」。两处口径不同是有意的，
    // 但同一批包在没有过期包时必须给同一个数——闸里钉着这条。
    let credits = 0;
    let expiresAt = 0;
    for (const p of packages) {
        if (p.remaining === -1)
            credits = -1;
        else if (credits !== -1)
            credits += p.remaining;
        if (p.expiresAt > Date.now() && (!expiresAt || p.expiresAt < expiresAt))
            expiresAt = p.expiresAt;
    }
    return { credits, expiresAt, packages };
}
/** zcode（JWT 侧）逐包：balances 一条 = 一个套餐额度（纯函数，自测直接喂合成样本）。
 *  plan 的名字在 plans 里，按 plan_id join 过来，否则日历每行只能显示一串 id。
 *  ⚠ remaining 一律夹成 >=0：上游欠额时给的是负数，而 store 的入库归一只把 **< -1** 夹成 0、
 *  原样保留 -1（-1 是「额度不限」哨兵）。不夹的话一个欠额到 -1 的包会把整个账号的余额
 *  派生成无限，并绕开 cost-first 路由——这个坑在 lobster 那侧已经踩过一次。 */
function zcodeCreditPackages(balances, plans) {
    const planName = {};
    for (const pl of Array.isArray(plans) ? plans : []) {
        const pid = String((pl && (pl.plan_id || pl.planId)) || "");
        if (pid)
            planName[pid] = String((pl && pl.name) || pid);
    }
    return (Array.isArray(balances) ? balances : []).map((b, idx) => {
        if (!b || typeof b !== "object")
            return null;
        const total = Number(b.total_units);
        const used = Number(b.used_units);
        const raw = b.remaining_units != null ? Number(b.remaining_units)
            : (b.available_units != null ? Number(b.available_units) : NaN);
        const pid = String(b.plan_id || b.planId || b.entitlement_id || "");
        const remaining = Number.isFinite(raw) ? raw
            // 缺 remaining 时退回 total-used：与本渠道账号级 credits 同口径，少一个字段不至于把整包读成 0
            : (Number.isFinite(total) && Number.isFinite(used) ? total - used : 0);
        return {
            code: (pid || `pack${idx}`).slice(0, 128),
            name: String(b.show_name || b.name || planName[pid] || pid || "套餐额度").slice(0, 128),
            total: Number.isFinite(total) ? total : 0,
            used: Number.isFinite(used) ? used : 0,
            remaining: Math.max(0, remaining),
            expiresAt: util.toMs(b.expires_at ?? b.expiresAt),
        };
    }).filter(Boolean);
}
const trae = {
    id: "trae",
    cfg() {
        return rules.get("headers.json").trae;
    },
    models() {
        const catalog = [...catalogMap("trae").values()].map((m) => String(m.id));
        return unionIds(catalog, Object.keys(rules.get("model_map.json") || {}));
    },
    /** 拉取官方模型目录：get_detail_param（实测：config_info_list[].config_name + display_config.display_name），
     *  镜像域优先（与对话出口同域），失败回退官方域 */
    async fetchModels(account, secrets) {
        const c = this.cfg();
        const body = JSON.stringify({
            function: "solo_work_lite",
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
        });
        let lastErr = "";
        for (const url of [c.modelsUrl, c.mirrorModelsUrl].filter(Boolean)) {
            const headers = { ...this.headers(account, secrets), referer: url };
            const r = await httpJson(url, { method: "POST", headers, body })
                .catch((e) => ({ ok: false, status: 0, message: String((e && e.message) || e) }));
            if (!r.ok || !r.data) {
                lastErr = r.status === 401 ? "账号登录态失效（401），请重新登录" : `HTTP ${r.status || 0} ${r.message || ""}`.trim();
                continue;
            }
            const list = findList(r.data, "config_info_list", 0) || [];
            const models = [];
            for (const it of list) {
                const id = it && (it.config_name || it.configName);
                if (typeof id !== "string" || !id)
                    continue;
                // 目录里混着三类「不是模型」的条目（对 38 条实测目录校准）：
                //   ① is_invisible_to_user = true  → 内部 subagent / 实验通道
                //      （browser_use_subagent / file_search_agent / sagitta / aquila …）
                //   ② display_config.display_name 为空 → 租户自定义模型的**占位模板**
                //      （custom_model_* / summary …），能出现在表里但不可选
                //   ③ config_switch = false → 已下线开关
                // 三者的判据一律「缺省 = 可见」（字段缺失/非 false 都放行）：上游删字段时若把整张表
                // 滤空，用户看到的是「上游没模型了」，而真相是本机判空判错了——这是最坏的失效方式。
                // 只做布尔严格判定（=== true / === false），不做真值转换，避免 "false" 字符串误杀。
                if (it.is_invisible_to_user === true || it.isInvisibleToUser === true)
                    continue;
                const disp = it.display_config || {};
                const dispName = disp.display_name ?? disp.displayName ?? disp.name ?? "";
                if (!String(dispName).trim())
                    continue;
                if (it.config_switch === false || it.configSwitch === false)
                    continue;
                const name = dispName;
                if (!models.some((m) => m.id === id)) {
                    // 上限取自官方目录条目，字段结构实证自 2026-10-03 抓取的原始响应（详见 traeLimits 注释）。
                    // 取不到写 0（=未知，与 workbuddy 系列静态兜底一致）。**原先无条件写 131072 是凭空捏造**：
                    // 下游客户端（如 DSH 的 pi-ai）会拿它比对用量 —— isContextOverflow 的
                    // 「stop 且 usage.input + cacheRead > contextWindow」分支 —— 把 30 万 token 的正常回答
                    // 误判成 CONTEXT_WINDOW_EXCEEDED，整个 turn 失败（且溢出恢复的摘要请求同样超限，二次失败）。
                    models.push({
                        id,
                        name: String(name),
                        rate: null,
                        capabilities: capsWithImages(sniffImages(it)),
                        ...traeLimits(it),
                    });
                }
            }
            if (models.length)
                return { ok: true, models };
            lastErr = "官方目录解析为空（接口可能已变更）";
        }
        return { ok: false, message: lastErr || "目录拉取失败" };
    },
    /** 完整请求头指纹（逐字段对齐实测抓包，缺任何一项都可能被上游风控识别为非官方客户端） */
    headers(account, secrets) {
        const c = this.cfg();
        const { deviceId, machineId } = deviceIds(account);
        const tid = util.traceId(); // "00-<hex32>-<hex32>-01"
        const h = {
            "content-type": "application/json",
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9",
            "user-agent": c.userAgent,
            "authorization": `Cloud-IDE-JWT ${secrets.token}`,
            "x-ide-token": secrets.token,
            "x-cloudide-token": secrets.token,
            "x-app-id": c.appId,
            "x-app-version": "default",
            "x-app-version-code": c.ideVersionCode,
            "x-ide-version": c.ideVersion,
            "x-ide-version-code": c.ideVersionCode,
            "x-ide-version-type": "stable",
            "x-device-type": "windows",
            "x-device-brand": c.deviceBrand || "CREFG-XX",
            "x-device-cpu": "Intel",
            "x-device-id": deviceId,
            "x-machine-id": machineId,
            "x-os-version": c.osVersion || "Windows 11 Home China",
            "request-traffic-type": "prod",
            "package-type": "stable_cn",
            "x-lgw-req-sdk-type": "3",
            "x-lscbd-aid": "787976",
            "x-lscbd-platform": "windows",
            "x-ss-dp": "787976",
            "app-version": c.ideVersion,
            "x-custom-trace-id": tid.slice(3, 19),
            "x-flow-traceparent": `04-${tid.slice(3, 35)}-${crypto.randomBytes(16).toString("hex")}-01`,
            "x-tt-trace-id": tid,
            "x-request-id": `req_${crypto.randomUUID().replace(/-/g, "")}`,
            // referer 在 chat() 里按实际请求 URL 覆盖（同源伪装）
        };
        // X-Uid 官方客户端恒带（SOLOHeaders 实证），缺了是风控识别点
        if (account && account.uid)
            h["x-uid"] = String(account.uid);
        return h;
    },
    /**
     * 额度查询：CN 现行口径是 v2 pay 接口（v1 兜底），空体请求（实测）；
     * 余额 = 全部订阅包 (credits_limit - usage.credits_amount) 求和（老实现只取单一档位包，口径错）。
     * 实测关键：pay/ug 域对部分账号（scope=marscode 等）整体拒绝，HTTP 401 + code 1001，
     * 但同一 token 在 GetUserInfo/对话域完全正常 —— 这是「积分服务不开放」，不是凭证失效，
     * 返回 unavailable 而不是 authError，避免把好号打成 relogin
     */
    async queryCredits(account, secrets) {
        const c = this.cfg();
        const { deviceId } = deviceIds(account);
        const headers = { ...this.headers(account, secrets), "x-user-region": "CN", "x-device-id": deviceId };
        const body = "{}";
        let lastErr = "";
        for (const base of candidateOrigins(c)) {
            for (const path of ["/trae/api/v2/pay/ide_user_ent_usage", "/trae/api/v1/pay/ide_user_ent_usage"]) {
                const r = await httpJson(base + path, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                const code = Number((r.data && r.data.code) || 0);
                if ((r.status === 401 || r.status === 403) && code === 1001) {
                    return { credits: 0, unavailable: true, message: "积分服务未对该账号开放（官方接口 code 1001）" };
                }
                if (r.status === 401)
                    return { authError: true };
                if (!r.ok || !r.data) {
                    lastErr = `HTTP ${r.status}${r.message ? ` ${r.message}` : ""}`;
                    continue;
                }
                const packs = findList(r.data, "user_entitlement_pack_list") || [];
                if (packs.length) {
                    const t = traeCredits(packs);
                    // 守卫从 `credits > 0` 换成 `packages.length`：不限量账号的 credits 是 -1，沿用旧守卫
                    // 会掉进下面「退回旧档位口径」，把刚解析出来的包整个扔掉——正是本条要修的那个丢失。
                    if (t.packages.length)
                        return t;
                    // 三条过滤把全部包都滤掉 / 新版字段缺失时，退回旧档位口径（单一包 remain）
                    const best = pickEntitlementPack(packs);
                    if (best.credits > 0)
                        return { credits: best.credits, expiresAt: best.expiresAt };
                    return { credits: 0, expiresAt: t.expiresAt };
                }
                lastErr = "上游未返回订阅包";
            }
        }
        throw new Error(`额度查询失败：${lastErr || "上游无可用响应"}`);
    },
    /** 签到状态：**POST + Cloud-IDE-JWT** 为主（与官方客户端一致），GET+did+Bearer 降为兜底；
     *  code 1001 = 签到服务对该账号不开放。
     *
     *  客户端事实（TRAE SOLO CN 0.1.69，见 docs/号池签到核对-20261028/12 §3.2）：
     *  status 与 claim **都是 POST**、**都用 Cloud-IDE-JWT**、**body 都带 `req_source`**
     *  （SOLO 包=2 / 普通 TRAE IDE=1）、status **不带 `?did=`**。原实现三处全错，已按客户端对齐。 */
    async checkinStatus(account, secrets) {
        const c = this.cfg();
        const { deviceId } = deviceIds(account);
        const base = c.checkinBase || "https://api.trae.cn";
        const reqSource = traeReqSource(c);
        const devHeaders = traeDeviceHeaders(c);
        const tries = [
            {
                url: `${base}/trae/api/v2/ug/checkin_credits/status`,
                method: "POST",
                body: JSON.stringify({ req_source: reqSource }),
                headers: {
                    authorization: `Cloud-IDE-JWT ${secrets.token}`,
                    origin: "https://www.trae.cn",
                    referer: "https://www.trae.cn/",
                    "x-app-type": "trae",
                    "x-device-id": deviceId,
                    "x-user-region": "CN",
                    ...devHeaders,
                },
            },
            {
                url: `${base}/trae/api/v2/ug/checkin_credits/status?did=${encodeURIComponent(deviceId)}`,
                method: "GET",
                headers: {
                    authorization: `Bearer ${secrets.token}`,
                    origin: "https://www.trae.cn",
                    referer: "https://www.trae.cn/",
                    "x-app-type": "trae",
                    "x-device-id": deviceId,
                    "x-user-region": "CN",
                    ...devHeaders,
                },
            },
        ];
        let lastMsg = "";
        for (const t of tries) {
            const opts = { method: t.method, headers: { "content-type": "application/json", accept: "application/json", ...t.headers } };
            if (t.body)
                opts.body = t.body;
            const r = await httpJson(t.url, opts).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            const code = Number((r.data && r.data.code) ?? 0);
            const msg = String((r.data && r.data.message) || r.message || "");
            if (code === 1001)
                return { ok: true, unavailable: true, checkedIn: false, message: "签到服务未对该账号开放（官方接口 code 1001）" };
            if (code !== 0 && code !== 200) {
                lastMsg = msg || `HTTP ${r.status}`;
                continue;
            }
            if (!r.ok || !r.data) {
                lastMsg = `HTTP ${r.status}`;
                continue;
            }
            const d = (r.data && r.data.data) || r.data;
            return {
                ok: true,
                checkedIn: !!(d.checked_in ?? d.checkedIn),
                // 客户端用它做「已领过」短路（防重复领取）；原实现未读（见 12 §3.2）
                didCheckedIn: !!(d.did_checked_in ?? d.didCheckedIn),
                enable: !!(d.enable),
                credits: Number((d.credits ?? d.total_credits) || 0),
                // 客户端读；原实现未读
                extraCredits: Number((d.extra_credits ?? d.extraCredits) || 0),
                consecutiveDays: Number((d.consecutive_days ?? d.consecutiveDays) || 0),
                creditsEarnedToday: Number((d.credits_earned_today ?? d.creditsEarnedToday) || 0),
                checkinDate: String(d.checkin_date ?? d.checkinDate ?? ""),
                message: d.checked_in ? `今日已签到 · 共 ${d.credits ?? 0} 积分` : "今日未签到",
            };
        }
        return { ok: false, message: lastMsg || "查询签到状态失败" };
    },
    /** 签到领取：code 1001 = 服务不开放；「已签到」文案 = 幂等成功。
     *  body 与 status 同为 `{"req_source":N}`（客户端两者一致），并补发设备头。 */
    async checkin(account, secrets) {
        const c = this.cfg();
        const { deviceId } = deviceIds(account);
        const base = c.checkinBase || "https://api.trae.cn";
        const r = await httpJson(`${base}/trae/api/v2/ug/checkin_credits/claim`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Cloud-IDE-JWT ${secrets.token}`,
                "x-user-region": "CN",
                "x-device-id": deviceId,
                origin: "https://www.trae.cn",
                referer: "https://www.trae.cn/",
                "x-app-type": "trae",
                ...traeDeviceHeaders(c),
            },
            body: JSON.stringify({ req_source: traeReqSource(c) }),
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const code = Number((r.data && r.data.code) ?? 0);
        const msg = String((r.data && r.data.message) || r.message || "");
        if (code === 1001)
            return { ok: true, unavailable: true, message: "签到服务未对该账号开放（官方接口 code 1001）" };
        if (code !== 0 && code !== 200) {
            const already = /已签到|已经签到|already/i.test(msg);
            return { ok: already, already, message: msg || `签到失败 HTTP ${r.status}` };
        }
        if (!r.ok || !r.data)
            return { ok: false, message: msg || `签到失败 HTTP ${r.status}` };
        // 领取后回查状态拿积分明细
        const st = await this.checkinStatus(account, secrets);
        return { ok: true, already: false, message: (r.data.message || "签到成功"), status: st.ok ? st : null };
    },
    /**
     * Token 刷新：ExchangeToken（对齐上游：ClientID + RefreshToken + ClientSecret "-"，x-cloudide-token 空串）。
     * 上游多域时依次尝试，避免某个域被墙/维护就整条链路失效；
     * extraOrigins（OAuth 回调 loginHost 的 origin）排最前——官方回调会指定换令牌的域
     */
    async refreshToken(account, secrets, extraOrigins) {
        const c = this.cfg();
        if (!secrets.refreshToken)
            return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
        const headers = { "content-type": "application/json", "user-agent": c.userAgent, "x-cloudide-token": "" };
        const body = JSON.stringify({ ClientID: c.clientId, RefreshToken: secrets.refreshToken, ClientSecret: "-", UserID: "" });
        const bases = candidateOrigins(c);
        const candidates = [
            ...(Array.isArray(extraOrigins) ? extraOrigins.filter((x) => x && !bases.includes(x)) : []),
            ...bases,
        ];
        let lastErr = "";
        for (const base of candidates) {
            const r = await httpJson(`${base}/cloudide/api/v3/trae/oauth/ExchangeToken`, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            // 响应嵌套 Result.Token / Result.RefreshToken（实测），兼容扁平字段
            const d = (r.data && (r.data.Result || r.data.result || r.data.data || r.data)) || null;
            const rawToken = d && (d.Token || d.access_token || d.accessToken);
            if (r.ok && rawToken) {
                const token = String(rawToken).replace(/^Cloud-IDE-JWT\s+/i, "");
                const newRefresh = d.RefreshToken || d.refresh_token || d.refreshToken;
                return {
                    ok: true,
                    token,
                    refreshToken: newRefresh ? String(newRefresh) : secrets.refreshToken,
                };
            }
            const errMsg = r.data && (r.data.ResponseMetadata && r.data.ResponseMetadata.Error && r.data.ResponseMetadata.Error.Message);
            lastErr = errMsg || (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
        }
        return { ok: false, message: lastErr };
    },
    /** 用户信息（OAuth 回调后补全 uid/昵称） */
    async userInfo(token) {
        const c = this.cfg();
        const r = await httpJson(c.userInfoUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Cloud-IDE-JWT ${token}`, "user-agent": c.userAgent },
            body: "{}",
        });
        const d = r.data && (r.data.data || r.data);
        if (r.ok && d) {
            return {
                uid: String(d.id || d.user_id || d.uid || util.jwtDecode(token).uid || ""),
                name: String(d.name || d.nickname || d.user_name || ""),
            };
        }
        const dec = util.jwtDecode(token);
        return { uid: dec.uid, name: "" };
    }
};
// ===== WorkBuddy CN / AI 双实例（共享适配器核心） =====
/**
 * 计费响应 → { credits, expiresAt }。
 * 个人口径 get-user-resource 把额度拆成 Response.Data.Accounts[] 多个套餐包，
 * 正确余额 = 全部包的剩余求和（老实现只取第一个包，实测 CN 981 vs 129、AI 588 vs 527）。
 * 企业口径 get-enterprise-user-usage 返回 limit_num / used_num 一套（无 Accounts）。
 * credits = -1 表示企业无限额度哨兵（调用方与 UI 识别，不参与求和）。
 */
function parseWbResource(data, isEnterprise) {
    if (isEnterprise) {
        // 企业端点两层 data 都可能（data.data / data 直接挂字段），宽容取
        const d = (data && (data.data || data)) || data;
        const limit = Number(util.dig(d, /^limit_num$|^limitnum$/i));
        if (!Number.isFinite(limit))
            return null;
        const used = Number(util.dig(d, /^used_num$|^usednum$|^credit$/i)) || 0;
        return {
            credits: limit < 0 ? -1 : Math.max(limit - used, 0),
            expiresAt: util.toMs(util.dig(d, /cycle_end_time|cycle_reset_time|end_time|expire/i)),
        };
    }
    const accounts = findList(data, "Accounts") || [];
    if (!accounts.length)
        return null;
    let remain = 0;
    let used = 0;
    let size = 0;
    let earliestEnd = 0;
    const packages = [];
    const num = (a, re) => Number(util.dig(a, re)) || 0;
    for (const a of accounts) {
        // 单包口径（上游 packageRemainUsed）：Cycle 期套餐优先，缺 Cycle 退回 Capacity 三字段
        let r, u, s;
        const cycSize = num(a, /^CycleCapacitySize(Precise)?$/i);
        if (cycSize > 0) {
            r = num(a, /^CycleCapacityRemain(Precise)?$/i);
            s = cycSize;
            r = Math.max(0, Math.min(r, s));
            u = Math.max(s - r, num(a, /^CycleCapacityUsed(Precise)?$/i));
        }
        else {
            r = num(a, /^CapacityRemain(Precise)?$/i);
            u = num(a, /^CapacityUsed(Precise)?$/i);
            s = num(a, /^CapacitySize(Precise)?$/i);
            if (!u && s > r)
                u = s - r;
        }
        remain += r;
        used += u;
        size += s;
        const end = util.toMs(util.dig(a, /^PackageEndTime$|^CycleEndTime$|^CycleResetTime$/i));
        // 只取未来的到期时间：响应里混着已过期的历史包（Status=3），取其到期会把账号误判成「余额已到期」
        if (end && end > Date.now() && (!earliestEnd || end < earliestEnd))
            earliestEnd = end;
        // 逐包明细：上面三个数（r/u/s）与到期本来就是**按包**算出来的，此前只在 return 里被折成
        // 账号级两个标量。per-pack 的到期刻意不做「只取未来」过滤——已过期的包正是要在日历里看得见。
        packages.push({
            code: String(util.dig(a, /^PackageCode$|^SubProductCode$|^ProductCode$/i) || `pack${packages.length}`).slice(0, 128),
            name: String(util.dig(a, /^PackageName$|^SubProductName$|^ProductName$/i) || "资源包").slice(0, 128),
            total: s,
            used: u,
            remaining: r,
            expiresAt: end,
        });
    }
    // TotalDosage 作 size 下限（已消耗的总量不该小于套餐总量）
    const dosage = Number(util.dig(data, /^TotalDosage$/i)) || 0;
    if (dosage > size) {
        size = dosage;
        if (size - remain > used)
            used = size - remain;
    }
    else if (size > 0 && size - remain > used) {
        used = size - remain;
    }
    return { credits: Math.max(remain, 0), expiresAt: earliestEnd, packages };
}
/** X-Device-Token 文件兜底（≤1KB、5min 缓存） */
let deviceTokenCache = { at: 0, value: "" };
function readDeviceTokenFile() {
    if (deviceTokenCache.at && Date.now() - deviceTokenCache.at < 5 * 60000)
        return deviceTokenCache.value;
    try {
        const raw = require("node:fs").readFileSync(require("node:path").join(store.proxyDir(), "device_token.txt"), "utf8");
        deviceTokenCache.value = String(raw).trim().slice(0, 1024);
    }
    catch {
        deviceTokenCache.value = "";
    }
    deviceTokenCache.at = Date.now();
    return deviceTokenCache.value;
}
function makeWorkBuddy(channelId) {
    return {
        id: channelId,
        cfg() {
            return rules.get("headers.json")[channelId];
        },
        models() {
            const catalog = [...catalogMap(channelId).values()].map((m) => String(m.id));
            const legacy = (rules.get("wb_models.json") || {})[channelId];
            return unionIds(catalog, Array.isArray(legacy) ? legacy : []);
        },
        /** 拉取官方模型目录：v3/config 主路（三段式 CLI UA 否则 400 code 12403；含倍率 credits/能力/上下文）
         *  + console models 备路，两路结果按 id 合并、v3 权威；非对话模型（nes-/completion-/maxOutput≤256/文生图）剔除 */
        async fetchModels(account, secrets) {
            const c = this.cfg();
            const baseHeaders = this.headers(account, secrets);
            const parseRate = (v) => {
                const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(v ?? ""));
                return m ? Number(m[1]) : null;
            };
            const shape = (it) => {
                if (!it || typeof it !== "object")
                    return null;
                const id = it.id || it.model || it.name;
                if (typeof id !== "string" || !id)
                    return null;
                if (/^(nes-|completion-|codewise-)/i.test(id))
                    return null;
                const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
                const maxOut = Number(it.maxOutputTokens ?? it.max_output_tokens) || 0;
                if (maxOut && maxOut <= 256)
                    return null;
                if (tags.some((t) => /text-to-image|image-gen|embedding/i.test(t)))
                    return null;
                return {
                    id,
                    name: String(it.name || it.display_name || id),
                    rate: parseRate(it.credits),
                    capabilities: (() => {
                        // 官方字段优先；缺失时退回通用嗅探（不写 false，避免把"未声明"当"不支持"）
                        const explicit = it.supportsImages ?? it.supports_images;
                        const img = typeof explicit === "boolean" ? explicit : sniffImages(it);
                        const base = {
                            reasoning: !!(it.supportsReasoning ?? it.supports_reasoning),
                            tools: !!(it.supportsToolCall ?? it.supports_tool_call),
                        };
                        return capsWithImages(img, base);
                    })(),
                    // reasoning 元数据（effort 降级原料）：supportedEfforts/defaultEffort 必须随目录落盘，
                    // 否则 deepseek 系 reasoning_effort 档位无法按模型收敛，只认 high 的模型请求 low 会 400
                    reasoning: it.reasoning && typeof it.reasoning === "object"
                        ? {
                            effort: it.reasoning.effort ?? null,
                            defaultEffort: String(it.reasoning.defaultEffort ?? it.reasoning.default_effort ?? ""),
                            supportedEfforts: Array.isArray(it.reasoning.supportedEfforts ?? it.reasoning.supported_efforts)
                                ? (it.reasoning.supportedEfforts ?? it.reasoning.supported_efforts).map(String)
                                : [],
                        }
                        : null,
                    contextLength: Number(it.maxInputTokens ?? it.max_input_tokens ?? it.context_length) || 0,
                    maxOutputTokens: maxOut,
                };
            };
            const merged = new Map();
            const ingest = (data, authoritative) => {
                const list = findList(data, "models", 0);
                if (!Array.isArray(list))
                    return;
                for (const raw of list) {
                    const m = shape(raw);
                    if (!m)
                        continue;
                    const key = m.id.toLowerCase();
                    if (!merged.has(key) || authoritative)
                        merged.set(key, m);
                }
            };
            const [alt, v3] = await Promise.all([
                httpJson(c.modelsUrl, { method: "GET", headers: baseHeaders })
                    .catch(() => ({ ok: false, status: 0 })),
                httpJson(c.modelsV3Url, {
                    method: "GET",
                    headers: { ...baseHeaders, "user-agent": c.catalogUA || baseHeaders["user-agent"], "x-codebuddy-request": "1" },
                }).catch(() => ({ ok: false, status: 0 })),
            ]);
            if (alt.ok && alt.data)
                ingest(alt.data, false); // 备路先入
            if (v3.ok && v3.data)
                ingest(v3.data, true); // 主路权威覆盖
            const models = [...merged.values()];
            if (!models.length) {
                return { ok: false, message: `目录拉取失败（v3 HTTP ${v3.status || 0} / console HTTP ${alt.status || 0}）` };
            }
            return { ok: true, models };
        },
        /** chat 出站头组：逐字段对齐官方 WorkBuddy 桌面端（逆向实证）。
         *  渠道白名单校验（400 code 11128 "unapproved channel"）按这套指纹认客户端：
         *  ① 三段式 UA（WorkBuddy/ver 平台/ver CLI/ver，AI 版平台段必须 WorkBuddy AI 否则 11140）；
         *  ② X-CodeBuddy-Request: 1 风控闸门头全请求必带；
         *  ③ 用量归属头组 X-Agent-Purpose/X-IDE-Name/Type/Version/X-Product（官方 banner 白名单同形，
         *     旧版 x-product=SaaS 就是"网关特征"，11128 的直接诱因）；
         *  ④ X-Machine-ID/X-Session-ID 按 uid 稳定派生（每账号一台固定虚拟设备）；
         *  ⑤ Origin/Referer 按域名（CN=codebuddy.cn，AI=workbuddy.ai）；
         *  ⑥ 缺省字段 X-No-* 占位（X-Domain 有值才发、无值改发 X-No-Department-Info，二者不并存）。
         *  红线：chat 请求绝不携带 X-Refresh-Token（仅允许出现在刷新端点） */
        headers(account, secrets) {
            const c = this.cfg();
            const origin = c.origin || (channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");
            const ideName = c.ideName || "WorkBuddy";
            const h = {
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
                "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
                "user-agent": c.userAgent,
                "origin": origin,
                "referer": origin + "/",
                "x-requested-with": "XMLHttpRequest",
                "x-codebuddy-request": "1",
                "authorization": `Bearer ${secrets.token}`,
                // 用量归属头组：伪造官方桌面端，缺了就是上游用量统计里的「网关特征」
                "x-agent-purpose": "conversation",
                "x-ide-name": ideName,
                "x-ide-type": ideName,
                "x-ide-version": c.clientVersion || "5.6.2",
                "x-product": ideName,
            };
            // 设备风控头（auth 每号 > config 全局 > 文件兜底），空则不注入
            const devToken = (account && account.deviceToken) || c.deviceToken || readDeviceTokenFile();
            if (account && account.uid) {
                h["x-user-id"] = account.uid;
                // 每账号一台固定虚拟设备：跨重启稳定、账号间互异（防设备指纹缺失/漂移关联风控）
                const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
                h["x-machine-id"] = stable("machine");
                h["x-session-id"] = stable("session");
            }
            else {
                h["x-no-user-id"] = "1";
            }
            if (devToken)
                h["x-device-token"] = devToken;
            if (channelId === "workbuddy_ai") {
                // 国际版个人号无企业 ID：显式声明 + 国际版域（对齐官方国际客户端形态）
                h["x-no-enterprise-id"] = "1";
                h["x-domain"] = "www.workbuddy.ai";
            }
            else {
                const ent = account.enterpriseId || "";
                if (ent)
                    h["x-enterprise-id"] = ent;
                else
                    h["x-no-enterprise-id"] = "1";
                const domain = account.domain || "";
                if (domain)
                    h["x-domain"] = domain;
                else
                    h["x-no-department-info"] = "1";
            }
            return h;
        },
        /** billing 域请求头（余额/签到/上报）：官方白名单头组 = 单段 UA WorkBuddy/<ver> + X-CodeBuddy-Request。
         *  UA 不能用三段式（官方计费/banner 接口显式覆写为单段形态，多带 CLI 段反而不像） */
        billingHeaders(account, secrets) {
            const c = this.cfg();
            const h = {
                "content-type": "application/json",
                "accept": "application/json",
                "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
                "user-agent": c.billingUA || `WorkBuddy/${c.clientVersion || "5.6.2"}`,
                "x-codebuddy-request": "1",
                "authorization": `Bearer ${secrets.token}`,
            };
            if (account.uid)
                h["x-user-id"] = account.uid;
            const ent = account.enterpriseId || "";
            if (ent) {
                h["x-enterprise-id"] = ent;
                h["x-tenant-id"] = ent;
            }
            const domain = account.domain || "";
            if (domain)
                h["x-domain"] = domain;
            const devToken = (account && account.deviceToken) || c.deviceToken || readDeviceTokenFile();
            if (devToken)
                h["x-device-token"] = devToken;
            return h;
        },
        async probeChat(account, secrets) {
            return createSwitchProbe({ getConfig: () => this.cfg(), readHeaders: (a, sec) => this.headers(a, sec) })(account, secrets);
        },
        /**
         * 额度查询：billing/meter 计费域。
         * 个人账号走 get-user-resource（p_tcaca，全部套餐包求和），企业成员的个人资源恒为空、
         * 必须走 get-enterprise-user-usage（空体 + X-Enterprise-Id 头，返回 limit_num/used_num）。
         * 计费域与对话域不同（CN 计费在 www.codebuddy.cn），主域失败时回退插件域
         */
        async queryCredits(account, secrets) {
            const c = this.cfg();
            const bases = [];
            for (const b of [c.billingBase, c.pluginBase]) {
                const s = String(b || "").replace(/\/+$/, "");
                if (s && !bases.includes(s))
                    bases.push(s);
            }
            const ent = account.enterpriseId || "";
            const path = ent ? "/billing/meter/get-enterprise-user-usage" : "/billing/meter/get-user-resource";
            // 请求体对齐实测结论：分页 + p_tcaca + 有效期区间；
            // 企业版官方客户端发空体 {}
            const now = new Date();
            const p2 = (n) => String(n).padStart(2, "0");
            const fmtTime = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
            const body = ent
                ? "{}"
                : JSON.stringify({
                    PageNumber: 1,
                    PageSize: 100,
                    ProductCode: "p_tcaca",
                    Status: [0, 3],
                    PackageEndTimeRangeBegin: fmtTime(now),
                    PackageEndTimeRangeEnd: fmtTime(new Date(now.getTime() + 365 * 101 * 86400000)),
                });
            let lastErr = "";
            for (const base of bases) {
                for (const p of [path, "/v2" + path]) {
                    const r = await httpJson(`${base}${p}`, {
                        method: "POST",
                        headers: this.billingHeaders(account, secrets),
                        body,
                    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                    if (r.status === 401)
                        return { authError: true };
                    if (!r.ok || !r.data) {
                        lastErr = `HTTP ${r.status}`;
                        continue;
                    }
                    const shaped = parseWbResource(r.data, !!ent);
                    if (shaped)
                        return shaped;
                    lastErr = "上游未返回可用额度字段";
                }
            }
            throw new Error(`额度查询失败：${lastErr || "上游无可用响应"}`);
        },
        /** 计费域 JSON 请求：paths 候选依次尝试（非 v2 优先、/v2 兜底），401 先换 token 再试一次 */
        async billingCall(account, secrets, paths, body) {
            const c = this.cfg();
            const bases = [];
            for (const b of [c.billingBase, c.pluginBase]) {
                const s = String(b || "").replace(/\/+$/, "");
                if (s && !bases.includes(s))
                    bases.push(s);
            }
            let creds = secrets;
            for (let pass = 0; pass < 2; pass++) {
                for (const base of bases) {
                    for (const p of paths) {
                        const r = await httpJson(`${base}${p}`, {
                            method: "POST",
                            headers: this.billingHeaders(account, creds),
                            body: body || "{}",
                        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                        if (r.status === 401 && pass === 0)
                            break; // 换 token 后重来
                        return r;
                    }
                }
                // 401 走单飞刷新（与 server/credits 侧共享互斥，防并发轮换互相践踏）
                const rr = await refreshTokenLocked(this.id, account, creds).catch(() => ({ ok: false }));
                if (!rr.ok)
                    return { ok: false, status: 401, data: null, message: rr.message };
                creds = { token: rr.token, refreshToken: rr.refreshToken };
            }
            return { ok: false, status: 0, data: null, message: "上游无可用响应" };
        },
        // ===== 【已移除】国际版「每日活跃」三件套（keepalive）=====
        // 移除日期：2026-10-28。依据：docs/号池签到核对-20261028/12 §5 与 05-pool-probing-audit.md R-4。
        // 原实现含三条「制造活跃」的请求，现全部删除：
        //   ① 活跃上报 POST /v2/report（构造 chat_request_send 事件）—— **端点已在 WorkBuddy 5.6.2 中消失**
        //      （全量字节扫描 0 命中），且属伪造行为事实；
        //   ② 桌面端免费模型最小对话保活 —— 为满足活动判定条件而制造的调用；
        //   ③ 网页通道建会话 —— 原路径 `/console/as/conversations/` 与 body 均与客户端不符
        //      （客户端为 `POST /v2/as/conversations/` + `{agentId, conversationOrigin?}`）。
        // 三条都是「为领取每日奖励而补齐判定通道」的自动化行为，属探测类能力，非账号管理；
        // 且 ①② 的端点已失效 → 移除零功能损失。国际版每日签到（daily-checkin）本身不受影响。
        /** ② 【已移除】桌面端免费模型保活（pokeActivity）—— 制造调用以满足活跃判定，属探测类能力。 */
        /** ③ 【已移除】网页通道建会话（webConversation）—— 原路径/body 与客户端不符，且属制造活跃。 */
        /**
         * 每日签到状态：checkin-activity-status（新）→ checkin-status（旧）逐路径降级。
         * 实测：code===0 为成功；code!=0 为业务失败（如已签到/未开放）
         */
        async checkinStatus(account, secrets) {
            const r = await this.billingCall(account, secrets, [
                "/billing/meter/checkin-activity-status",
                "/v2/billing/meter/checkin-activity-status",
                "/billing/meter/checkin-status",
                "/v2/billing/meter/checkin-status",
            ], "{}");
            const d = (r.data && (r.data.data || r.data)) || null;
            const code = Number((r.data && r.data.code) ?? 0);
            if (!r.ok || !d || (code !== 0 && code !== 200)) {
                return {
                    ok: false,
                    unavailable: /已签到|already|未开启|未开放|已过期/i.test(String((r.data && (r.data.message || r.data.msg)) || r.message || "")),
                    message: String((r.data && (r.data.message || r.data.msg)) || r.message || `HTTP ${r.status}`),
                };
            }
            const b = (k1, k2) => {
                const v = d[k1] ?? d[k2];
                if (typeof v === "boolean")
                    return v;
                if (typeof v === "number")
                    return v !== 0;
                return false;
            };
            return {
                ok: true,
                active: b("active", "Active"),
                checkedIn: b("today_checked_in", "todayCheckedIn"),
                streakDays: Number(d.streak_days ?? d.streakDays ?? 0) || 0,
                dailyCredit: Number(d.daily_credit ?? d.dailyCredit ?? 0) || 0,
                todayCredit: Number(d.today_credit ?? d.todayCredit ?? 0) || 0,
                checkinDates: Array.isArray(d.checkin_dates ?? d.checkinDates) ? (d.checkin_dates ?? d.checkinDates).map(String) : [],
                weekProgress: Array.isArray(d.week_progress) ? d.week_progress.map(Boolean) : [],
                // ===== 客户端会读、原实现漏掉的 12 个字段（WorkBuddy 5.6.2，见 12 §4 与 §9）
                // 用途：连登奖励判断与活动展示（is_streak_day 决定今天是否连登奖励日）
                isStreakDay: b("is_streak_day", "isStreakDay"),
                nextStreakDay: Number(d.next_streak_day ?? d.nextStreakDay ?? 0) || 0,
                streakBonusDays: Number(d.streak_bonus_days ?? d.streakBonusDays ?? 0) || 0,
                streakBonusCredit: Number(d.streak_bonus_credit ?? d.streakBonusCredit ?? 0) || 0,
                totalCredits: Number(d.total_credits ?? d.totalCredits ?? 0) || 0,
                startTime: Number(d.start_time ?? d.startTime ?? 0) || 0,
                endTime: Number(d.end_time ?? d.endTime ?? 0) || 0,
                themeName: String(d.theme_name ?? d.themeName ?? ""),
                season: String(d.season ?? ""),
                activityName: String(d.activity_name ?? d.activityName ?? ""),
                claimButtonText: String(d.claim_button_text ?? d.claimButtonText ?? ""),
                actionButton: String(d.action_button ?? d.actionButton ?? ""),
            };
        },
        /** 每日签到领取：daily-checkin（code!=0 且幂等码/「已签到」文案 → already，不算失败） */
        async checkin(account, secrets) {
            const r = await this.billingCall(account, secrets, [
                "/billing/meter/daily-checkin",
                "/v2/billing/meter/daily-checkin",
            ], "{}");
            const code = Number((r.data && r.data.code) ?? 0);
            const msg = String((r.data && (r.data.message || r.data.msg)) || r.message || "");
            const d = (r.data && (r.data.data || r.data)) || null;
            if (r.ok && (code === 0 || code === 200)) {
                return {
                    ok: true,
                    success: d && d.success != null ? !!d.success : true,
                    message: (d && d.message) || "签到成功",
                    credit: Number((d && (d.credit ?? d.today_credit ?? d.todayCredit)) ?? 0) || 0,
                    streakDays: Number((d && (d.streak_days ?? d.streakDays)) ?? 0) || 0,
                    reward: (d && d.reward) || null,
                    // 客户端会读、原实现漏掉（12 §4）：requestId 在响应顶层，is_streak_day 在 data 或顶层
                    requestId: String((r.data && r.data.requestId) || ""),
                    isStreakDay: !!(d && (d.is_streak_day ?? d.isStreakDay)),
                };
            }
            const already = /\b(10001|14001)\b/.test(msg) || /已签到|今日已签到|already/i.test(msg);
            return { ok: already, already, message: msg || `签到失败 HTTP ${r.status}` };
        },
        /** 国际版一次性 trial 加油包（CN 无此端点）：幂等码 14051 = 已领过 */
        async trial(account, secrets) {
            const r = await this.billingCall(account, secrets, ["/billing/ide/trial", "/v2/billing/ide/trial"], "{}");
            const code = Number((r.data && r.data.code) ?? 0);
            const msg = String((r.data && (r.data.message || r.data.msg)) || r.message || "");
            if (r.ok && (code === 0 || code === 200))
                return { ok: true, claimed: true, message: msg || "加油包领取成功" };
            if (/\b14051\b/.test(msg) || /已领取|已领过|already/i.test(msg))
                return { ok: true, claimed: false, already: true, message: msg || "已领取过" };
            return { ok: false, message: msg || `领取失败 HTTP ${r.status}` };
        },
        /** Token 刷新：X-Refresh-Token 头 + 空体 {}（该头只允许出现在此端点）。
         *  头组对齐上游 RefreshHeaders：CommonHeaders 完整形态（origin/referer/风控闸门/机器指纹）
         *  + refresh 专属头；X-Auth-Refresh-Source 走 rules 配置（实测后固化为 "workbuddy"） */
        async refreshToken(account, secrets) {
            const c = this.cfg();
            if (!secrets.refreshToken)
                return { ok: false, message: "无 refreshToken，请重新登录或从本机导入" };
            const bases = [];
            for (const b of [c.billingBase, c.pluginBase]) {
                const s = String(b || "").replace(/\/+$/, "");
                if (s && !bases.includes(s))
                    bases.push(s);
            }
            const origin = c.origin || (channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");
            const headers = {
                "content-type": "application/json",
                accept: "application/json",
                origin,
                referer: origin + "/",
                "user-agent": c.userAgent,
                "x-requested-with": "XMLHttpRequest",
                "x-codebuddy-request": "1",
                "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
                "x-refresh-token": secrets.refreshToken,
                "x-auth-refresh-source": c.refreshSource || "plugin",
            };
            if (account && account.uid) {
                const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
                headers["x-machine-id"] = stable("machine");
                headers["x-session-id"] = stable("session");
            }
            if (account && account.enterpriseId)
                headers["x-enterprise-id"] = account.enterpriseId;
            let lastErr = "";
            for (const base of bases) {
                const r = await httpJson(`${base}/v2/plugin/auth/token/refresh`, {
                    method: "POST",
                    headers,
                    body: "{}",
                }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
                const d = r.data && (r.data.data || r.data);
                if (r.ok && d && (d.accessToken || d.access_token)) {
                    return {
                        ok: true,
                        token: String(d.accessToken || d.access_token),
                        refreshToken: d.refreshToken || d.refresh_token ? String(d.refreshToken || d.refresh_token) : secrets.refreshToken,
                    };
                }
                lastErr = (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
            }
            return { ok: false, message: lastErr };
        }
    };
}
const workbuddy = makeWorkBuddy("workbuddy");
const workbuddy_ai = makeWorkBuddy("workbuddy_ai");
// ===== 商汤小浣熊（Raccoon AI 桌面端，渠道 id: raccoon） =====
// 协议事实基线见 docs/raccoon-反代/会话1~5（静态逆向，asar 解包 + PyInstaller 反汇编）。
// 防伪强度低：无请求签名/HMAC/证书 pinning/混淆。鉴权 = JWT Bearer + x-client-* 六头 + 受信设备绑定。
// 关键结论：
//   · 上行 LLM 是纯 OpenAI Chat Completions（上游疑似 LiteLLM 网关），1:1 透传即可；
//   · SenseNova 方言（XML 伪 tool_calls/reasoning_content）是客户端后处理，反代无需实现；
//   · 纯对话/积分调用不触发受信设备绑定（X-Client-Device-ID 大写头只出现在 bind/heartbeat），
//     LLM 只带小写 x-client-device-id（遥测性质）；号池每号独立指纹即可；
//   · 积分/配额查询全在渲染层（/points/v1、/office/v3/setting_info），主进程/box-agent 不参与。
// 指纹注入：x-client-* 六头按号隔离（会话2 §6），deviceId 每号一个随机 UUID 入池固定。
/** raccoon 账号级稳定指纹：复用 store.meta 里的画像，缺省时按 uid/id 派生随机 UUID 兜底（不编码序号/日期防风控识别） */
function raccoonIdentity(account) {
    const meta = (account && account.meta) || {};
    const seed = crypto.createHash("sha256").update(`agenthub:raccoon:${(account && (account.uid || account.id)) || "anon"}`).digest("hex");
    // 由 hash 派生一个合法 UUID v4 形态（8-4-4-4-12），账号内稳定、账号间互异
    const uuid = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
    return {
        deviceId: meta.deviceId || uuid,
        deviceName: meta.deviceName || "DESKTOP-" + seed.slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X"),
        osVersion: meta.osVersion || "10.0.26200",
        platform: meta.clientPlatform || "desktop-windows-x64",
        platformNoArch: String(meta.clientPlatform || "desktop-windows-x64").replace(/-(x64|arm64)$/i, ""),
        officeIdentity: String(meta.officeIdentity || "").trim(),
    };
}
/** 浏览器域请求头（积分/配额/账号类）：渲染层 fetchWithAuth 形态（X-Client-* 大写、不带架构、版本带 v）
 *
 *  对齐小浣熊 v1.1.3（见 docs/号池签到核对-20261028/10 §3）：
 *   · `X-Client-Version` 客户端取 `"v" + app.getVersion()` → 本机为 **v1.1.3**（原硬编码 v1.0.35 已过期）；
 *   · 新增 `X-Raccoon-Language`（值来自本地 `electron_i18nextLng`，**客户端所有 fetchWithAuth 请求都带**）；
 *   · `X-Client-Platform`：客户端在**余额/设置/刷新**这类请求上发 `web`，只有 grant 那条显式覆盖为
 *     `desktop-windows`（10 §3，属**强推断**，尚未抓包坐实）→ 故这里做成 per-call 可覆盖，
 *     默认保持 `desktop-windows`（不改既有行为），由调用点按端点显式传 `{ platform: "web" }`。
 */
function raccoonWebHeaders(c, account, secrets, opts) {
    const idn = raccoonIdentity(account);
    const platform = (opts && opts.platform) || idn.platformNoArch;
    const h = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${secrets.token}`,
        "X-Client-Platform": platform,
        "X-Client-Version": c.webClientVersion || "v1.1.3",
        "X-Client-Device-ID": idn.deviceId,
        // 客户端默认语义为 zh（本地 i18n 语言）；缺失是异常信号，故始终显式发送
        "X-Raccoon-Language": String((account && account.meta && account.meta.language) || "zh"),
    };
    if (idn.officeIdentity && idn.officeIdentity !== "personal")
        h["X-Org-Code"] = idn.officeIdentity;
    return h;
}
/** 刷新端点专用头（会话1 §1.3：只凭 refresh_token，不带旧 access）。
 *  不复用 raccoonWebHeaders 再 delete authorization——那种写法依赖键名恰好小写，一旦头名风格
 *  变化 delete 会静默失效，把已过期的 access 一起发上去，服务端完全可能因此 401 */
function raccoonRefreshHeaders(c, account) {
    const idn = raccoonIdentity(account);
    const h = {
        "content-type": "application/json",
        accept: "application/json",
        "X-Client-Platform": idn.platformNoArch,
        "X-Client-Version": c.webClientVersion || "v1.1.3",
        "X-Client-Device-ID": idn.deviceId,
    };
    if (idn.officeIdentity && idn.officeIdentity !== "personal")
        h["X-Org-Code"] = idn.officeIdentity;
    return h;
}
/** 手机端身份头（仅首次手机端登录奖励 mobileGrantUrl 用）：官方手机 App 壳的请求形态
 *  （从官方安卓包逆向实测）：platform 报 app-android、版本报 App 侧 v1.0.3。
 *  手机端端点认的也是桌面端登录签发的同一把 Bearer token（token 无平台绑定），
 *  报哪端只影响走哪条端点，不影响凭证 —— 每个号两条一次性奖励各领一次。 */
function raccoonMobileHeaders(c, account, secrets) {
    const idn = raccoonIdentity(account);
    const h = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${secrets.token}`,
        "X-Client-Platform": "app-android",
        "X-Client-Version": "v1.0.3",
    };
    if (idn.officeIdentity && idn.officeIdentity !== "personal")
        h["X-Org-Code"] = idn.officeIdentity;
    return h;
}
/** 兜底取新凭据：从远端号池拉一次（只拉取合并，preferKeys 让本号优先采纳远端那份），
 *  返回合并后本机这一号的凭据。用于「refresh 被服务端拒绝」——另一台设备可能刚轮换出新值。
 *  WebDAV 未配置 / 别的同步在进行 / 网络失败 / 超时一律回 { pulled:false }：刷新链路绝不能被
 *  远端拖死；pulled 只是「确实发起过拉取」，决定失败文案是「已尝试过但没取到」还是「没试成」，
 *  免得对用户谎报动作。 */
async function pullRaccoonCreds(account) {
    if (!account || !account.id)
        return { pulled: false };
    try {
        const poolsync = require("./poolsync.cjs");
        const r = await Promise.race([
            poolsync.pullChannel("raccoon", { preferKeys: new Set([poolsync.accountKeyOf(account)]) }),
            new Promise((res) => {
                const t = setTimeout(() => res({ ok: false, message: "拉取远端号池超时" }), 8000);
                if (t.unref)
                    t.unref();
            }),
        ]);
        if (!r || !r.ok)
            return { pulled: false };
        const row = store.getAccount(account.id);
        if (!row)
            return { pulled: true };
        const s = store.accountSecrets(row);
        return { pulled: true, token: s.token || "", refreshToken: s.refreshToken || "" };
    }
    catch {
        return { pulled: false };
    }
}
/** access 是否已过期（本地解 exp，留 60s 余量；解不出当过期） */
function raccoonAccessExpired(token) {
    const exp = Number(util.jwtDecode(token).exp || 0);
    return !exp || exp * 1000 <= Date.now() + 60000;
}
/** 账号 meta 读成对象（行里 meta 是 JSON 串、调用方手里的可能是对象，两形状都收） */
function raccoonMetaOf(account) {
    try {
        const raw = account && account.meta;
        if (raw && typeof raw === "object")
            return raw;
        const p = JSON.parse(String(raw || "{}"));
        return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    }
    catch {
        return {};
    }
}
/** 刷新成功后比对 sid（会话6 §2.3 的欠账）：sid 是同一次登录会话的标识，刷新不该改变它；
 *  变了说明该账号在别处被重新登录过（服务端按 sid 互踢，旧会话可能被作废）。
 *  只留一条可诊断的警告、不改账号状态——这一刻的凭据是可用的，真实影响由下一次刷新结果说了算。 */
function noteRaccoonSid(account, token) {
    try {
        if (!account || !account.id)
            return false;
        const sid = String((util.jwtDecode(token).payload || {}).sid || "");
        if (!sid)
            return false;
        const row = store.getAccount(account.id);
        if (!row)
            return false;
        const meta = raccoonMetaOf(row);
        const prev = String(meta.sid || "");
        if (prev === sid)
            return false;
        store.updateAccount(account.id, { meta: { ...meta, sid } });
        // 首次记录不算异常，只有「换过」才是
        if (prev) {
            store.noteError(account.id, "会话标识(sid)已变化：该账号疑似在其他设备或客户端重新登录过（同号多会话会被服务端互踢）。若别处已掉登录，请勿在多台机器重复登录同一个号");
        }
        return !!prev;
    }
    catch {
        return false;
    }
}
/** 刷新失败文案分流：把服务端给的拒绝码翻成用户能照做的下一步。
 *  triedPull 只表示「确实发起过远端拉取」——没配 WebDAV / 别的同步占着 / 网络失败时不能
 *  对用户说「已尝试从其他设备拉取」，那是在谎报动作。 */
function raccoonRefreshFailHint(rejectCode, triedPull) {
    const why = rejectCode === 200822
        ? "（服务端返回 200822：该 refresh_token 已被并发刷新替换）"
        : "";
    const tail = triedPull
        ? "；已从其他设备拉取过最新凭据但没取到更新的一份——若确实在别的设备重新登录过该账号，本机也需重新登录一次"
        : "；若刚在小浣熊客户端点过「退出登录」，服务端凭据会被吊销，号池内该账号需重新导入或登录";
    return why + tail;
}
const raccoon = {
    id: "raccoon",
    readForwardContext(account) {
        const identity = raccoonIdentity(account);
        return { deviceId: identity.deviceId, osVersion: identity.osVersion, platform: identity.platform,
            clientChannel: String(account?.meta?.clientChannel || "stable"), officeIdentity: identity.officeIdentity };
    },
    // 临期预刷新窗口（credits.cjs 用）：小浣熊 access 仅 3h（会话1 §2），若沿用默认 24h，
    // 每轮额度刷新（含定时 30min 一轮）都会触发一次刷新——与桌面端抢同一个 refresh_token
    // 互相作废（掉登录根因）。贴官方 300s 惰性语义，把主动轮换压到接近到期才发生
    refreshWindowSec: 300,
    cfg() {
        return rules.get("headers.json").raccoon;
    },
    models() {
        const catalog = [...catalogMap("raccoon").values()].map((m) => String(m.id));
        return unionIds(catalog, [this.cfg().defaultModel]);
    },
    /** 拉取官方模型目录：GET /model_catalog，返回 {default_model, models:[{name,...,params:{context_window,max_tokens},points_multiplier}]}
     *  access 仅 3h，401 时就地刷新一次再重试（chat/额度链路都有，目录拉取原来没有） */
    async fetchModels(account, secrets) {
        let r = await this.fetchModelsOnce(account, secrets);
        if (r.authError) {
            const rr = await refreshTokenLocked(this.id, account, secrets).catch(() => ({ ok: false }));
            if (rr.ok) {
                if (account && account.id) {
                    store.updateAccount(account.id, { token: rr.token, refreshToken: rr.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
                }
                r = await this.fetchModelsOnce(account, { token: rr.token, refreshToken: rr.refreshToken });
            }
        }
        if (r.authError)
            return { ok: false, message: "账号登录态失效（401），请重新登录" };
        return r;
    },
    async fetchModelsOnce(account, secrets) {
        const c = this.cfg();
        const headers = raccoonWebHeaders(c, account, secrets);
        const r = await httpJson(c.modelsUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401)
            return { ok: false, authError: true, message: "登录态已过期（HTTP 401）" };
        const list = findList(r.data, "models", 0);
        if (!r.ok || !Array.isArray(list) || !list.length) {
            return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）${r.message ? " " + r.message : ""}` };
        }
        const models = [];
        for (const raw of list) {
            const id = raw && (raw.name || raw.id || raw.model);
            if (typeof id !== "string" || !id || raw.visible === false)
                continue;
            const params = (raw && raw.params) || {};
            models.push({
                id,
                name: String(raw.display_name || raw.description || raw.name || id),
                rate: util.finiteRate(raw.points_multiplier ?? raw.billing_effective_multiplier ?? raw.billing_multiplier),
                capabilities: (() => {
                    // 官方 tags 会归一成 "vision"（逆向文档：image/image-understanding → vision）；缺失时退回嗅探
                    const byTag = (Array.isArray(raw.tags) ? raw.tags : []).some((t) => /image|vision/i.test(String(t)));
                    const img = byTag ? true : sniffImages(raw);
                    return capsWithImages(img, { reasoning: true, tools: true });
                })(),
                contextLength: Number(raw.context_window ?? params.context_window) || 0,
                maxOutputTokens: Number(raw.max_tokens ?? params.max_tokens) || 0,
            });
        }
        if (!models.length)
            return { ok: false, message: "目录为空或无可对话模型" };
        return { ok: true, models };
    },
    /** 积分余额：GET /points/v1/balance。返回 {available_points,...}，号池取 available_points 作余额。
     *  顶层 code 非 0/200 或 HTTP 401 → authError（会话4 §1：统一 {code,data} 信封） */
    async queryCredits(account, secrets) {
        const c = this.cfg();
        const headers = raccoonWebHeaders(c, account, secrets);
        const r = await httpJson(c.balanceUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401)
            return { authError: true };
        const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        if (code === 200003 || /authorization_verify_error/i.test(String((r.data && r.data.message) || "")))
            return { authError: true };
        if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
            throw new Error(`额度查询失败：HTTP ${r.status}${r.data && r.data.message ? " " + r.data.message : ""}${r.message ? " " + r.message : ""}`);
        }
        const d = r.data.data || r.data;
        const credits = Number(d.available_points ?? d.availablePoints) || 0;
        return { credits, raw: d };
    },
    /** 签到状态：小浣熊无独立"签到状态"接口，每日积分随登录自动发放，标 unavailable 说明查询不适用 */
    async checkinStatus(account, secrets) {
        try {
            const r = await this.queryCredits(account, secrets);
            if (r.authError)
                return { ok: false, message: "凭证失效，请重新登录" };
            return { ok: true, unavailable: true, checkedIn: false, credits: r.credits, message: `小浣熊无独立签到查询，每日登录自动发放（当前积分 ${r.credits}）` };
        }
        catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
        }
    },
    /** 每日积分 = 两步懒结算：先 GET setting_info「激活」当日 Web 会话，再 POST grant 领取。
     *
     *  实测（2026-10-07 00:11，双账号、客户端未启动）：跳过第 1 步时 grant 恒返回
     *  granted:false 且积分明细（/points/v1/bills）当日无 daily_grant 单据——即服务端
     *  并未发放；补上 setting_info 后 grant 立即 granted:true，单据 created_at=调用时刻、
     *  grant_at=当日 00:00（账期归属）、expire_at=+7 天。
     *
     *  官方规则页写的「00:00 自动发放、无需登录触发」指 grant_at 的账期归属；实际入库
     *  是懒结算——要等当天首次 Web 会话活动（setting_info 正是客户端启动时的必调项）。
     *  granted=false 语义 = 当日已发放（幂等），非失败。 */
    async checkin(account, secrets) {
        const c = this.cfg();
        const headers = raccoonWebHeaders(c, account, secrets);
        // 第 1 步：setting_info 激活当日 Web 会话（懒结算前置；失败不阻断，由 grant 自行暴露）
        //  ⚠ 注释订正（2026-10-28，见 docs/号池签到核对-20261028/10 §3）：
        //  客户端代码里**不存在**「先 setting_info 再 grant」的顺序约束——setting_info 由另一个组件
        //  在 window focus/visibilitychange 时调用。因此这是**号池自己实测出来的服务端前置条件**，
        //  不是「客户端必调项」，不要在注释里声称是客户端行为。
        //  该端点客户端按 `web` 平台发（grant 那条才覆盖为 desktop-windows）→ 这里显式传 platform。
        //  团队版走 org 路径（10 §3 R4）：个人版 `/api/web/office/v3/setting_info`，
        //  团队版 `/api/web/org/user/office/v1/setting_info`（**版本段也不同**，不能只加 X-Org-Code）。
        const idn = raccoonIdentity(account);
        const isTeam = !!idn.officeIdentity && idn.officeIdentity !== "personal";
        const settingUrl = isTeam
            ? String(c.settingUrlOrg || String(c.settingUrl).replace(/\/api\/web\/office\/v\d+\/setting_info.*$/, "/api/web/org/user/office/v1/setting_info"))
            : c.settingUrl;
        await httpJson(settingUrl, { method: "GET", headers: raccoonWebHeaders(c, account, secrets, { platform: "web" }) }).catch(() => null);
        // 第 2 步：领取
        const r = await httpJson(c.grantUrl, { method: "POST", headers, body: "{}" }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401)
            return { ok: false, message: "凭证失效，请重新登录" };
        const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
            return { ok: false, message: (r.data && r.data.message) || r.message || `签到失败 HTTP ${r.status}` };
        }
        const granted = !!(r.data.data && r.data.data.granted);
        return { ok: true, already: !granted, claimed: granted, message: granted ? "已领取每日积分" : "今日已领取过" };
    },
    /**
     * 首次登录奖励（一次性新手福利，桌面端与手机端各一条端点，同一把 Bearer token、各领一次）。
     * 契约与 raccoon.checkin 的每日 grant 同形：`{code:0,data:{granted,popup?:{points}}}`；
     * granted=false = 此前已发放（幂等成功，不重复加分）。两条端点互不共享额度：
     * 桌面端早已领过的账号，手机端那条照样能拿满。
     *
     * 台账（已领取标记）存账号 meta.onboardingGrants（key → 结算时刻）：
     *   · 台账已结算的任务不发请求 —— 落了标记后续恒跳过（「后续不再领取」）；
     *   · 探测成功（无论 granted 真假）都算落定，返回 settled 增量由编排层写台账 ——
     *     两种结果都代表奖励已落定，这一步就是「已领取」标记的写入口径；
     *   · 探测失败（网络/5xx）不落台账，下次签到/自动签到自然重试（「直到领取成功」）；
     *   · 401 = 凭证失效，整体失败（不落台账，也不对每条任务各撞一次 401）。
     * 串行探测（与签到同一条防风控口径）。实际入账分值以响应 popup.points 为准，
     * 取不到按名义值 3000 兜底（仅用于界面展示与流水摘要）。
     */
    async claimOnboarding(account, secrets) {
        const c = this.cfg();
        const meta = (account && account.meta) || {};
        const ledger = meta.onboardingGrants && typeof meta.onboardingGrants === "object" ? meta.onboardingGrants : {};
        const tasks = [
            { key: "desktop_login_grant", title: "首次电脑端登录奖励", path: c.grantUrl, headers: raccoonWebHeaders(c, account, secrets) },
            { key: "mobile_login_grant", title: "首次手机端登录奖励", path: c.mobileGrantUrl, headers: raccoonMobileHeaders(c, account, secrets) },
        ];
        const now = Date.now();
        const settled = {};
        const results = [];
        let claimed = 0, already = 0, failed = 0, claimedPoints = 0;
        for (const t of tasks) {
            if (Number(ledger[t.key]) > 0 || ledger[t.key] === -1)
                continue;
            const r = await httpJson(t.path, { method: "POST", headers: t.headers, body: "{}" }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            if (r.status === 401)
                return { ok: false, message: "凭证失效，请重新登录" };
            // 端点已不存在（404/410）→ 记 -1（「已下线」哨兵），后续不再重试。
            // 依据 10-raccoon-签到核对.md §3：手机端端点 `mobile/v1/login/points/grant` 在本机桌面产物
            // 17,873 个文件里 0 命中，真实性**未知**（本机无安卓包）。若确已下线，原实现会每轮白打一次
            // 并让界面长期显示「1 项领取失败」——这里改为一次即停，如实告知。
            if (r.status === 404 || r.status === 410) {
                settled[t.key] = -1;
                results.push({ key: t.key, title: t.title, ok: false, gone: true, error: `端点已不存在（HTTP ${r.status}），已停止重试` });
                continue;
            }
            const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
            if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
                failed++;
                results.push({ key: t.key, title: t.title, ok: false, error: (r.data && r.data.message) || r.message || `HTTP ${r.status}` });
                continue;
            }
            const granted = !!(r.data.data && r.data.data.granted);
            const points = granted ? Number(r.data.data.popup && r.data.data.popup.points) || 3000 : 0;
            settled[t.key] = now;
            claimed++;
            claimedPoints += points;
            if (!granted)
                already++; // granted=false = 此前已发放，本轮幂等落定（不再入账）
            results.push({ key: t.key, title: t.title, ok: true, already: !granted, points });
        }
        return { ok: failed === 0, settled, results, claimed, already, failed, claimedPoints };
    },
    /** 加油包领取：raccoon 加油包为付费购买（无免费"领取"动作），不支持 → 返回不可用提示 */
    async trial() {
        return { ok: false, message: "小浣熊加油包为付费购买，无免费领取动作" };
    },
    /** Token 刷新：POST /auth/v1/refresh，body 仅 {refresh_token}（会话1 §1.3）。
     *  与桌面端共用 ~/.box-agent/config/auth.json：刷前以文件里的最新 refresh_token 为准
     *  （桌面端可能刚刷过并旋转，用号池快照里的旧值会吃 401 —— 掉登录根因），
     *  刷新成功后原子写回，让两边始终持同一份凭据；文件归属校验不过则绝不碰文件。
     *
     *  refresh_token 是**单副本、用后轮换作废**的凭据，于是"谁手里的是旧值"这件事必然发生
     *  （同机是与桌面端抢，跨机是与同步过去的另一台抢）。被拒后按三级兜底依次尝试，
     *  全都不成立才判失效：
     *   ① 本机共用文件：重读 auth.json，值变了就用新值再试（同机并发刷新竞态）；
     *   ② 跨机号池：拉一次远端号池取另一台刚轮换出来的凭据——新 refresh 就用它重试；
     *      对端 refresh 与手里这份相同但 access 还没过期，则直接采用（省一次刷新与一次轮换，
     *      避免两台机器互相把对方轮换掉）；
     *   ③ access 双保险：refresh 被拒但当前 access 仍在线（userInfo 验通）就不判失效。
     *  成功刷新后触发一次去抖回传（poolsync.pushSoon）：不推的话对端手里的 refresh 立刻作废，
     *  下次同步之前它都是"需重新登录"。 */
    async refreshToken(account, secrets) {
        const c = this.cfg();
        const uid = account && account.uid;
        const own0 = raccoonAuth.ownedTokens(uid, secrets && secrets.refreshToken);
        let refreshToken = (own0 && own0.refreshToken) || (secrets && secrets.refreshToken) || "";
        if (!refreshToken)
            return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
        const headers = raccoonRefreshHeaders(c, account);
        let pulledRemote = false; // 跨机兜底只做一次（重试预算有限，也避免反复打 WebDAV）
        let triedPull = false; // 是否已经试过拉远端（供失败文案区分「试过没取到」与「压根没试成」）
        let rejectCode = 0; // 401 / 200822，用于失败文案分流
        for (let attempt = 0; attempt < 3; attempt++) {
            const body = JSON.stringify({ refresh_token: refreshToken });
            const r = await httpJson(c.refreshUrl, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            const d = (r.data && (r.data.data || r.data)) || null;
            const token = d && (d.access_token || d.accessToken || d.token);
            if (r.ok && token) {
                // 服务端旋转 refresh 就覆盖，不返回则保留旧的（会话1 §1.3；协议支持旋转但不强制）
                const nextRefresh = d.refresh_token || d.refreshToken ? String(d.refresh_token || d.refreshToken) : refreshToken;
                // 回写共用文件（仅当文件确属本号）：桌面端下次刷新读到新值，不再拿旧 refresh 撞 401
                const own = raccoonAuth.ownedTokens(uid, nextRefresh);
                if (own)
                    raccoonAuth.writeTokens({ accessToken: String(token), refreshToken: nextRefresh });
                // 本轮凭据已轮换，对端手里那份作废：就近回传一次，别让它一路跌到"需重新登录"
                try {
                    require("./poolsync.cjs").pushSoon();
                }
                catch { /* 回传是尽力而为 */ }
                const sidChanged = noteRaccoonSid(account, String(token));
                return { ok: true, token: String(token), refreshToken: nextRefresh, sidChanged };
            }
            const rejected = r.status === 401 || (r.status === 400 && Number(r.data && r.data.code) === 200822);
            if (!rejected)
                return { ok: false, message: (d && (d.message || d.msg)) || r.message || `刷新失败 HTTP ${r.status}` };
            rejectCode = Number(r.data && r.data.code) === 200822 ? 200822 : 401;
            // ① 本机共用文件：同机并发刷新可能刚把它换掉
            const own = raccoonAuth.ownedTokens(uid, refreshToken);
            const latest = (own && own.refreshToken) || "";
            if (latest && latest !== refreshToken) {
                refreshToken = latest;
                continue; // 值变了，再试一次
            }
            // ② 跨机号池：另一台设备可能刚轮换掉这份
            if (!pulledRemote && !triedPull) {
                triedPull = true;
                const got = await pullRaccoonCreds(account);
                pulledRemote = !!got.pulled; // 只有真拉成了，失败文案才能说「已尝试过」
                if (got.refreshToken && got.refreshToken !== refreshToken) {
                    refreshToken = got.refreshToken;
                    continue; // 取到对端的新 refresh，再试一次
                }
                // 对端 refresh 与手里这份相同（它也没换过）：但它的 access 还没过期就直接用——
                // 两台机器各刷一次只会互相作废，能省掉的轮换就省掉
                if (got.token && got.token !== (secrets && secrets.token) && !raccoonAccessExpired(got.token)) {
                    return { ok: true, token: got.token, refreshToken: got.refreshToken || refreshToken, adopted: true };
                }
            }
            // ③ 双保险容错：如果当前 access_token 依然有效（未过期且 user_info 正常），绝不误判为 expired！
            if (secrets && secrets.token) {
                const u = await this.userInfo(secrets.token, account).catch(() => null);
                if (u && u.uid && String(u.uid) === String(uid)) {
                    // 当前 access_token 仍然在线，仅 refresh_token 存在单侧冲突，继续保持 online 态
                    return { ok: true, token: secrets.token, refreshToken };
                }
            }
            return { ok: false, expired: true, message: `登录态已过期，请重新登录${raccoonRefreshFailHint(rejectCode, pulledRemote)}` };
        }
        return { ok: false, expired: true, message: `登录态已过期（重试后仍被服务端拒绝），请重新登录${raccoonRefreshFailHint(rejectCode, pulledRemote)}` };
    },
    /** 用户信息（导入后补全 uid/昵称）：GET /auth/v1/user_info（会话4 §6）。
     *  兼容单参 userInfo(token)（discovery 签名）与双参 userInfo(token, account)（OAuth 上下文） */
    async userInfo(token, account) {
        const c = this.cfg();
        const acc = account || {};
        const headers = raccoonWebHeaders(c, acc, { token });
        const r = await httpJson(c.userInfoUrl, { method: "GET", headers }).catch(() => ({ ok: false, status: 0, data: null }));
        const d = r.data && (r.data.data || r.data);
        if (r.ok && d) {
            return {
                uid: String(d.id || d.user_id || d.uid || ""),
                name: String(d.name || d.nickname || d.user_name || ""),
            };
        }
        // 接口不可用时本地解码兜底：小浣熊 JWT 顶层的 sub 才是账号 ID（iss 是签发方常量、sid 是会话 ID），
        // util.jwtDecode 读不出，必须用 raccoon 自己的口径（tokenUid 的 sub 链，与 discovery.scanRaccoon
        // 完全一致），否则 uid 恒空、或与 OAuth 登录落库的口径不一致导致号池去重失效
        return { uid: raccoonAuth.tokenUid(token), name: "" };
    }
};
// ===== LobsterAI（网易有道龙虾，渠道 id: lobster） =====// 协议事实（2026-10-05 本机实测，见 docs/lobster-反代）：
//   · 鉴权 = Bearer JWT（OAuth 授权码换发；回环回调 http://127.0.0.1:<port>/auth/callback）
//   · 对话 = 原生 OpenAI Chat Completions，但**上游只接受 stream=true**（非流式实测 500）
//   · 业务错误可能藏在 HTTP 200 的 SSE 流里（event:error 帧）→ 必须窥探首块
//   · 签到 = client-activities 三段式（slot → context → actions/check_in），活动按 clientVersion 门禁
//   · 积分 = /api/user/profile-summary 的 totalCreditsRemaining（/api/user/quota 不含活动积分）
const LOBSTER_UA_FALLBACK = "2026.9.23";
// 版本号缓存：签到活动按 clientVersion 下发，旧版本号会拿到 slotState=empty（实测 0.1.0 被隐藏）。
// 1h TTL，失败 10min 后重试（同口径）
let lobsterVersionCache = { val: "", at: 0, failedAt: 0 };
// ===== ModelScope（魔搭 · 阿里）：官方 OpenAI 兼容 + 魔粒每日任务 =====
// 与其它渠道的本质差异：这是**官方公开 API**（非逆向），对话面零签名零客户端依赖；
// 但「魔粒」任务面在 www.modelscope.cn 的 openapi 上，鉴权是三头同发 + 浏览器上下文，
// 且点赞是有副作用的公开动作（PUT 星标），故 checkin 的动作面与状态面严格分离：
//   checkinStatus = 纯只读（读 earn/rules 与 balance，不产生任何写入）
//   checkin       = 会话触碰（保 daily_active）+ 按剩余额度点赞（幂等：读 today_used 决定次数）
/** ModelScope 地区表：地区 → 站点身份的唯一事实来源（与 zcode/region.cjs 同构）。
 *  地区差异（依据 Agent2Providers modelscope/region.rs，逐条有据）：
 *    · 推理：CN api-inference.modelscope.cn/v1、INTL api-inference.modelscope.ai/v1；
 *    · 网页站（身份/魔粒/签到/OAuth）：CN modelscope.cn / www.modelscope.cn、INTL www.modelscope.ai；
 *    · 一个 ms- key 两用（Bearer + Cookie m_session_id）；两站账号体系独立。 */
function makeModelScope(channel) {
  const channelId = channel === "modelscope_intl" ? "modelscope_intl" : "modelscope";
  return {
    id: channelId,
    cfg() {
        // 规则段按渠道 id 取（modelscope / modelscope_intl 各一段），INTL 缺失项回落到 CN 段
        const all = rules.get("headers.json") || {};
        const base = all.modelscope || {};
        const override = channelId === "modelscope" ? {} : (all[channelId] || {});
        return { ...base, ...override };
    },
    /** 对话头：官方网关只认 Bearer（实测三头对 api-inference 非必需，但带上无害且与站点一致） */
    chatHeaders(token) {
        const c = this.cfg();
        return {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
        };
    },
    /** 魔粒控制面头：**三头同发 + 浏览器上下文**——缺 UA/Origin/Referer 会被风控中间件
     *  静默忽略（实测：只带 Authorization 时 earn/rules 返回空/异常，补齐后才稳定 200） */
    apiHeaders(token, refererPath) {
        const c = this.cfg();
        const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
        return {
            authorization: `Bearer ${token}`,
            "OpenAPI-Token": token,
            "X-Modelfun-Token": token,
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "user-agent": c.userAgent || "Mozilla/5.0",
            origin: base,
            referer: `${base}${refererPath || c.refererPath || "/my/overview"}`,
        };
    },
    /** Cookie 头（/api/v1 族专用）。
     *
     *  为什么有这个：魔搭端点分两族且**严格互斥**（实测确立，见 rules.cjs 注释）：
     *    「OAuth 可用族」推理 /v1/chat + 魔粒 /openapi/v1/*
     *    「仅 Cookie/ms- 可用族」点赞 /api/v1/mcpServers/* + 令牌管理 /api/v1/users/tokens*
     *  且 ms- 令牌虽能点赞却不触发 daily_active（实测注释：
     *  只有 Web 会话（Cookie）活动才触发日活奖励）⇒ **Cookie 是唯一两全的凭据**。 */
    cookieHeaderOf(secrets) {
        const meta = (secrets && (secrets.meta || secrets.accountMeta)) || {};
        return String(meta[this.cfg().cookieMetaKey] || "").trim();
    },
    // 【已移除】原「星标族头」starHeaders（点赞/列目标共用）—— 2026-10-28 随自动点赞一并移除（R-2）。
    // 保留的 hasStarCredential 仍用于「无 Cookie 时如实提示日活拿不到」的降级文案。
    /** 是否有可用于星标族的凭据（Cookie 或 ms- 令牌；OAuth 令牌不算） */
    hasStarCredential(secrets) {
        if (this.cookieHeaderOf(secrets))
            return true;
        const tk = String((secrets && secrets.token) || "");
        return !!tk && !tk.startsWith(String(this.cfg().oauthTokenPrefix || "ms_oauth"));
    },
    /** Web 会话触碰（触发 daily_active）。
     *
     *  daily_active 即「注册并登陆，每日登录即可获取」——HAR 抓包确认前端每次页面加载
     *  都会调 /api/v1/users/login/info，故必须**真的走 Web 请求**才算登录事件；纯 OpenAPI
     *  （Bearer）调用不计入日活（实测记录）。
     *
     *  返回 { ok, touched, dead }：dead=true 表示 Cookie 已失效（供上层提示重新授权）。 */
    async webTouch(secrets) {
        const c = this.cfg();
        const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
        const cookie = this.cookieHeaderOf(secrets);
        if (!cookie)
            return { ok: false, touched: 0, dead: false, message: "无 Web 会话 Cookie" };
        const ua = c.userAgent || "Mozilla/5.0";
        const htmlHeaders = {
            cookie,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "user-agent": ua,
            referer: `${base}/`,
        };
        let touched = 0;
        let dead = false;
        const deadRe = new RegExp(c.cookieDeadRe || "not logged in", "i");
        // ① Web 页面触碰（触发 Web 端活跃埋点中间件）
        for (const p of (c.cookieTouchPaths || ["/my/overview", "/"])) {
            const r = await httpJson(`${base}${p}`, { method: "GET", headers: htmlHeaders }).catch(() => ({ ok: false, status: 0 }));
            if (r.status === 401 || r.status === 403)
                dead = true;
            if (r.ok)
                touched++;
        }
        // ② 登录事件端点（daily_active 的关键——HAR 抓包确认前端必调）
        const jsonHeaders = { ...htmlHeaders, accept: "application/json, text/plain, */*" };
        for (const p of (c.cookieLoginEventPaths || [])) {
            const r = await httpJson(`${base}${p}`, { method: "GET", headers: jsonHeaders }).catch(() => ({ ok: false, status: 0, data: null }));
            if (r.status === 401 || r.status === 403)
                dead = true;
            if (deadRe.test(JSON.stringify((r && r.data) || "")))
                dead = true;
            if (r.ok)
                touched++;
        }
        // ③ OpenAPI 轻量端点（魔粒系统激活，Cookie 同样可调）
        for (const p of (c.cookieOpenapiPaths || [])) {
            const r = await httpJson(`${base}${p}`, { method: "GET", headers: jsonHeaders }).catch(() => ({ ok: false }));
            if (r.ok)
                touched++;
        }
        return { ok: touched > 0 && !dead, touched, dead };
    },
    models() {
        // 按渠道 id 取目录：INTL 的清单是**独立一份**（两站目录差异未实测，
        // 不把 CN 实测清单抄给 INTL —— 见 rules.cjs catalog 段的注释）
        return unionIds([...catalogMap(this.id).values()].map((m) => String(m.id)), []);
    },
    /** 拉取模型目录：GET /v1/models（需 Bearer）。⚠ 清单是「按热度精选」而非全集
     *  （实测 35 个；GLM-5.3-Flash 不在清单内但直调 200）——故清单只用于展示，
     *  不用于可用性判定。返回 {ok, models:[{id,name,...}]} */
    async fetchModels(account, secrets) {
        const c = this.cfg();
        const r = await httpJson(c.modelsUrl, { method: "GET", headers: this.chatHeaders(secrets.token) })
            .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { ok: false, authError: true, message: "凭证失效，请重新登录" };
        if (!r.ok || !r.data)
            return { ok: false, message: `模型目录拉取失败：HTTP ${r.status}${r.message ? " " + r.message : ""}` };
        const list = Array.isArray(r.data.data) ? r.data.data : [];
        const models = [];
        for (const raw of list) {
            const id = raw && (raw.id || raw.modelId);
            if (typeof id !== "string" || !id)
                continue;
            models.push({
                id,
                name: String((raw && (raw.name || raw.modelName)) || id),
                rate: null, // 魔粒按 tier 计费，非倍率制；不编造 rate
                capabilities: (() => {
                    const key = id.toLowerCase();
                    const generation = ["qwen/qwen-image", "qwen/qwen-image-2512", "tongyi-mai/z-image-turbo", "tongyi-mai/z-image"].includes(key);
                    const editing = ["qwen/qwen-image-edit", "qwen/qwen-image-edit-2509", "qwen/qwen-image-edit-2511"].includes(key);
                    return generation || editing ? { images: editing, tools: false } : { tools: true };
                })(),
                contextLength: tokenLimit(raw && (raw.contextLength || raw.contextWindow)),
                maxOutputTokens: tokenLimit(raw && (raw.maxOutputTokens || raw.max_output_tokens)),
            });
        }
        if (!models.length)
            return { ok: false, message: "模型目录为空" };
        return { ok: true, models };
    },
    /** 魔粒余额：GET /openapi/v1/magicubes/balance → data.total_balance */
    async queryCredits(account, secrets) {
        const r = await this.magicubesGet(secrets, this.cfg().balancePath);
        if (r.authError)
            return { authError: true };
        if (!r.ok)
            throw new Error(r.message || "魔粒余额查询失败");
        const d = (r.data && r.data.data) || {};
        const credits = Number(d.total_balance ?? d.available_balance ?? d.balance) || 0;
        return { credits, raw: d };
    },
    /** 魔粒控制面 GET 封装：统一三头 + 错误语义（401/403 → authError，供上层触发重登） */
    async magicubesGet(secrets, path, query) {
        const c = this.cfg();
        const base = String(c.apiBase || "https://www.modelscope.cn").replace(/\/+$/, "");
        const url = `${base}${path}${query ? (path.includes("?") ? "&" : "?") + query : ""}`;
        const r = await httpJson(url, { method: "GET", headers: this.apiHeaders(secrets.token) })
            .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { ok: false, authError: true, message: "凭证失效，请重新登录" };
        if (!r.ok || !r.data)
            return { ok: false, message: r.message || `HTTP ${r.status}` };
        // 站点信封：{success:true,data:…}；openapi 直出数据时 data 字段即业务体
        if (r.data.success === false)
            return { ok: false, message: r.data.message || "上游返回失败" };
        return { ok: true, data: r.data };
    },
    /** 读任务规则表（28 条）：返回原始数组 */
    async fetchEarnRules(secrets) {
        const r = await this.magicubesGet(secrets, this.cfg().earnRulesPath);
        if (!r.ok)
            return r;
        const list = Array.isArray(r.data && r.data.data) ? r.data.data : [];
        return { ok: true, rules: list };
    },
    /** 读取最近的魔粒发放记录。官网当前使用 type=EARN + page/page_size。 */
    async fetchEarnTransactions(secrets, pageSize) {
        const query = new URLSearchParams({ type: "EARN", page: "1", page_size: String(Number(pageSize) || 20) }).toString();
        const r = await this.magicubesGet(secrets, this.cfg().transactionsPath, query);
        if (!r.ok)
            return r;
        const d = (r.data && r.data.data) || {};
        const records = Array.isArray(d.records) ? d.records : (Array.isArray(d.list) ? d.list : []);
        return { ok: true, records };
    },
    transactionKey(row) {
        if (!row || typeof row !== "object")
            return "";
        return String(row.id || row.transaction_id || row.request_id || [row.gmt_created, row.rule_key, row.amount, row.description].join("|"));
    },
    /** 动作后等待上游结算：规则计数、余额、EARN 发放记录任一前进即确认到账。 */
    async waitMagicubeReward(secrets, before, attempts) {
        const max = Math.max(1, Number(attempts) || 4);
        for (let i = 0; i < max; i++) {
            if (i > 0)
                await new Promise((resolve) => setTimeout(resolve, 1200));
            const [rulesResult, balanceResult, txResult] = await Promise.all([
                this.fetchEarnRules(secrets),
                this.magicubesGet(secrets, this.cfg().balancePath),
                this.fetchEarnTransactions(secrets, 20),
            ]);
            const like = rulesResult.ok ? this.ruleOf(rulesResult.rules, this.cfg().ruleLike) : null;
            const used = Number(like && like.today_used) || 0;
            const balance = Number(balanceResult.ok && balanceResult.data && balanceResult.data.data && balanceResult.data.data.total_balance) || 0;
            // before.transactionKeys 为 null = 基线那次拉取失败：不能把「全量记录」当增量，
            // 否则第一轮轮询会把历史 EARN 记录整体误判成新到账（宁可少一个信号，不可假确认）
            const newTransactions = txResult.ok && before.transactionKeys
                ? txResult.records.filter((row) => !before.transactionKeys.has(this.transactionKey(row)))
                : [];
            if (used > before.likeUsed || balance > before.balance || newTransactions.length) {
                return { confirmed: true, used, balance, newTransactions };
            }
        }
        return { confirmed: false, used: before.likeUsed, balance: before.balance, newTransactions: [] };
    },
    /** 从规则表里取某个 rule_key */
    ruleOf(rules, key) {
        return (rules || []).find((x) => String(x && x.rule_key) === String(key)) || null;
    },
    /** 签到状态（**纯只读，零副作用**）：报告每日任务的领取情况与点赞剩余额度。
     *  返回结构对齐其它渠道：{ok, checkedIn, already, reward, message}，
     *  额外带 detail 供号池页展示「200 登录 / 50 绑云 / 40 点赞」的分解。 */
    async checkinStatus(account, secrets) {
        try {
            const c = this.cfg();
            const rr = await this.fetchEarnRules(secrets);
            if (rr.authError)
                return { ok: false, message: "凭证失效，请重新登录" };
            if (!rr.ok)
                return { ok: false, message: rr.message || "任务规则查询失败" };
            const rules = rr.rules;
            const daily = this.ruleOf(rules, c.ruleDailyActive);
            const bind = this.ruleOf(rules, c.ruleAliyunBind);
            const like = this.ruleOf(rules, c.ruleLike);
            const likeCap = Number(like && like.daily_cap) || 0;
            const likeUsed = Number(like && like.today_used) || 0;
            const likeRemain = Math.max(likeCap - likeUsed, 0);
            const likeAmount = Number(like && like.amount) || 2;
            // 「已签到」判定：两条每日任务都已领取（daily_cap=1 时 today_remain=0）
            const dailyDone = !!daily && Number(daily.today_remain) === 0 && Number(daily.today_used) > 0;
            const bindDone = !!bind && Number(bind.today_remain) === 0 && Number(bind.today_used) > 0;
            const checkedIn = dailyDone;
            const reward = (Number(daily && daily.amount) || 0) + (Number(bind && bind.amount) || 0);
            const parts = [];
            parts.push(dailyDone ? `登录奖励 ${Number(daily.amount) || 200} 已领` : `登录奖励 ${Number(daily && daily.amount) || 200} 待领`);
            parts.push(bindDone ? `绑云奖励 ${Number(bind && bind.amount) || 50} 已领` : `绑云奖励 ${Number(bind && bind.amount) || 50} 待领`);
            parts.push(likeRemain > 0 ? `点赞可领 ${likeRemain}×${likeAmount}=${likeRemain * likeAmount} 魔粒` : "点赞今日已满");
            return {
                ok: true,
                checkedIn,
                already: checkedIn && likeRemain === 0,
                reward,
                likeRemain,
                likeAmount,
                message: parts.join(" · "),
                detail: { daily, bind, like },
            };
        }
        catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
        }
    },
    /** 每日任务执行（**有副作用**：Web 会话触碰 + 点赞）。
     *  幂等设计：先读 today_used/today_remain，只补做剩余次数——重复调用不会超领。
     *
     *  凭据分层（关键，见 rules.cjs 注释与 §2.8）：
     *    ① Web 会话触碰走 **Cookie**（唯一触发 daily_active 的凭据；Bearer 调用不计日活）
     *    ② 点赞走 **Cookie**（OAuth 令牌在此端点被上游 401 拒绝；ms- 令牌可但无日活）
     *    ③ 魔粒余额/规则查询走 **OAuth 令牌**（该族两种凭据都可）
     *  无 Cookie 时降级为 ms- 令牌（能点赞、不计日活），并在结果里**如实标注**，
     *  不再把「无可用凭据」静默吞成「无可点赞目标」——那是本实现早期的缺陷。 */
    async checkin(account, secrets) {
        const c = this.cfg();
        const hasCookie = !!this.cookieHeaderOf(secrets);
        const canStar = this.hasStarCredential(secrets);
        // ① 会话触碰：读余额与规则（Cookie 通道下另有 Web 页面触碰，见 webTouch）
        const before = await this.magicubesGet(secrets, this.cfg().balancePath);
        if (before.authError)
            return { ok: false, message: "凭证失效，请重新登录" };
        if (!before.ok)
            return { ok: false, message: before.message || "会话触碰失败" };
        const balBefore = Number((before.data && before.data.data && before.data.data.total_balance)) || 0;
        // ①b Web 会话触碰（Cookie 专用）：这是 daily_active 的真正触发条件
        let web = null;
        if (hasCookie) {
            web = await this.webTouch(secrets).catch((e) => ({ ok: false, touched: 0, dead: false, message: String((e && e.message) || e) }));
            if (web && web.dead) {
                return {
                    ok: false, needReauth: true,
                    message: "Web 会话 Cookie 已失效（无法触发每日登录奖励与点赞），请在「添加账号」里重新完成一次 OAuth 授权以刷新会话",
                };
            }
        }
        const rr = await this.fetchEarnRules(secrets);
        if (!rr.ok)
            return { ok: false, message: rr.message || "任务规则查询失败" };
        const daily = this.ruleOf(rr.rules, c.ruleDailyActive);
        const bind = this.ruleOf(rr.rules, c.ruleAliyunBind);
        const like = this.ruleOf(rr.rules, c.ruleLike);
        const dailyAmt = Number(daily && daily.amount) || 0;
        const bindAmt = Number(bind && bind.amount) || 0;
        // ② 【已移除】自动点赞（原：按剩余额度对第三方 MCP 服务 PUT 星标换魔粒）
        //   移除日期 2026-10-28。依据 docs/号池签到核对-20261028/05-pool-probing-audit.md R-2：
        //   · 这是号池里**唯一会让机器代替用户对第三方产生公开可见行为**的能力（星标对外可见），
        //     属「自动化动作」型探测，不是账号管理——与「仅为账号管理」的定位直接冲突；
        //   · 原实现自带 400~900ms 防风控随机间隔与 25 次硬上限（rules.cjs:497-501），
        //     其定位本身就是「批量动作 + 规避风控」；
        //   · 原实现的到账核验（waitMagicubeReward / 发放记录增量）也随之不再需要。
        //   **保留**：只读的 checkinStatus 仍会报告点赞剩余额度（不产生任何写操作）。
        const cap = Math.min(Number(like && like.daily_cap) || 0, Number(c.likeHardCap) || 25);
        const used = Number(like && like.today_used) || 0;
        const remain = Math.max(cap - used, 0);
        const liked = 0;
        const confirmedLikes = 0;
        const likeErr = "";
        // ③ 复核：重读规则 + 余额（防「接口成功但没发分」）
        const afterRules = await this.fetchEarnRules(secrets);
        const afterBal = await this.magicubesGet(secrets, this.cfg().balancePath);
        const balAfter = Number((afterBal.ok && afterBal.data && afterBal.data.data && afterBal.data.data.total_balance)) || 0;
        const likeAfter = afterRules.ok ? this.ruleOf(afterRules.rules, c.ruleLike) : null;
        const likeUsedAfter = Number(likeAfter && likeAfter.today_used) || used;
        const delta = balAfter - balBefore;
        const gained = delta > 0 ? delta : 0;
        // 自动点赞移除后，progressed 只可能来自「登录奖励/绑云奖励到账」的余额增量。
        const progressed = gained > 0 || (likeUsedAfter > used);
        const msgs = [];
        if (dailyAmt && Number(daily && daily.today_used) > 0)
            msgs.push(`登录奖励 ${dailyAmt} 已领`);
        if (bindAmt && Number(bind && bind.today_used) > 0)
            msgs.push(`绑云奖励 ${bindAmt} 已领`);
        if (gained > 0)
            msgs.push(`余额 +${gained}`);
        // 降级提示：无 Cookie 时明确告知日活拿不到（避免用户以为签到成功了）
        if (!hasCookie && canStar)
            msgs.push("（当前无 Web 会话，daily_active 登录奖励需 Cookie 才能触发；重新 OAuth 授权可自动获取）");
        return {
            // 不再用 `remain === 0`（点赞额度）充当成功判据——自动点赞已移除，不该再据此报 ok
            ok: progressed,
            already: !progressed,
            claimed: progressed,
            liked,
            confirmedLikes,
            gained,
            balance: balAfter,
            hasCookie,
            webTouched: web ? web.touched : 0,
            message: msgs.length ? msgs.join(" · ") : "无可执行的自动动作（自动点赞已于 2026-10-28 移除，仅保留只读查询）",
        };
    },
    // 【已移除】原「列可点赞目标」fetchLikeTargets / fetchLikeTargetsResult 与「点赞单个 MCP 服务」
    // likeOne（PUT .../stars）—— 2026-10-28 随自动点赞一并移除，理由见上方 checkin 内 ② 的说明
    // （R-2：星标是对外可见的写动作，属自动化探测，非账号管理）。
    /** 魔搭无「加油包」类领取动作 */
    async trial() {
        return { ok: false, message: "ModelScope 无加油包领取动作" };
    },
    /** 令牌续期（OAuth 路径专用）：**由编排层注入实现**。
     *
     *  为什么不在适配器里直接 require discovery：discovery.cjs 顶部 require 了本模块
     *  （`const adapters = require("./adapters.cjs")`），反向 require 会形成循环依赖
     *  （Node 下取到半初始化模块 → undefined）。故与 qoderAdapter 同款处理：依赖注入。
     *  index.cjs 启动时调用 setModelScopeRefresh() 把 discovery.refreshModelScopeToken 注入进来。
     *
     *  ⚠ 上游约束（实测）：① refresh_token 一次性轮换 → 成功后必须把新值写回账号；
     *    ② OAuth 错误以 HTTP 200 + body.error 返回 → 判定在注入的实现内完成。 */
    async refreshToken(account, secrets) {
        const refresh = String((secrets && secrets.refreshToken) || "").trim();
        if (!refresh) {
            return { ok: false, terminal: true, message: "该账号是粘贴令牌入池（无 refresh_token），令牌失效后请到魔搭「访问令牌」页面重新生成并粘贴" };
        }
        if (typeof modelScopeRefreshImpl !== "function") {
            return { ok: false, terminal: true, message: "续期实现未注入（编排层未初始化），请重新执行 OAuth 登录" };
        }
        const meta = (account && account.meta) || {};
        const clientId = String(meta.oauthClientId || "");
        // clientSecret 落库时经 DPAPI 加密（msCookie 同款），此处解回明文（兼容存量明文）
        const clientSecret = config.decryptSecret(String(meta.oauthClientSecret || ""));
        if (!clientId || !clientSecret) {
            return { ok: false, terminal: true, message: "缺少 OAuth 客户端信息（meta.oauthClientId/Secret），无法续期，请重新执行 OAuth 登录" };
        }
        // channel 透传：INTL 的 token 端点与 CN 不同域（cfg(channel) 内部解析），
        // 漏传会把国际版账号的续期打到国内站（必然 invalid_client）
        const r = await modelScopeRefreshImpl(clientId, clientSecret, refresh, this.id).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
        if (!r.ok) {
            // invalid_grant 是终止性的（refresh 已被轮换消耗或吊销）——交由上层判 relogin
            const terminal = /invalid_grant|invalid_client|expired/i.test(String(r.message || ""));
            return { ok: false, terminal, message: r.message };
        }
        return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt, rotated: r.rotated };
    }
  };
}
const modelscope = makeModelScope("modelscope");
// 国际版与 CN 同一份实现，分地区值由 makeModelScope 的 cfg() 回落逻辑解析；
// 挂载与 store.MODELSCOPE_INTL_ENABLED 同步（ADAPTERS 参与 modelOwners/mergedModels）。
const modelscope_intl = store.MODELSCOPE_INTL_ENABLED ? makeModelScope("modelscope_intl") : null;
/** ModelScope 续期实现注入点（避免 adapters ↔ discovery 循环依赖，见 refreshToken 注释） */
let modelScopeRefreshImpl = null;
function setModelScopeRefresh(fn) {
    modelScopeRefreshImpl = typeof fn === "function" ? fn : null;
}
/** LobsterAI（有道）逐包：profile-summary 的 creditItems[] → 到期日历的包行。三条实测口径：
 *  · 上游**不下发逐包面值** ⇒ total 落 -1 =「不给总额」（渲染成「5297 / —」）。
 *    落 0 会被读成「已用完」，落别的数字就是编出来的。
 *  · expiresAt 是 string|null，且可能是空格形式 "2099-01-01 00:00:00"；统一走 normalizeExpiryMs
 *    （它认 ISO / 空格形式 / 秒毫秒，并把远未来哨兵夹成 0 = 长期有效）。
 *  · creditsRemaining 是浮点且**可为负**（欠额）。负值一律夹成 0：既因为「已用完」才是它的真实
 *    语义，更因为 -1 在本项目是「不限」哨兵，透下去会把整号余额派生成无限、绕开 cost-first 路由。
 *  非数组 / 空数组 ⇒ []，调用方回落到账号级聚合行（上游结构变更时不会把余额读成 0）。 */
function lobsterCreditPackages(items) {
    if (!Array.isArray(items) || !items.length)
        return [];
    const out = [];
    for (const it of items) {
        if (!it || typeof it !== "object")
            continue;
        const remaining = Number(it.creditsRemaining ?? it.credits_remaining);
        if (!Number.isFinite(remaining))
            continue;
        out.push({
            code: String(it.type || `item${out.length}`).slice(0, 128),
            name: String(it.label || it.labelEn || it.type || "积分包").slice(0, 128),
            total: -1,
            used: 0,
            remaining: Math.max(0, remaining),
            expiresAt: util.normalizeExpiryMs(it.expiresAt ?? it.expires_at),
            ord: out.length,
        });
    }
    return out;
}
const lobster = {
    id: "lobster",
    // 审查整改 O7（OAuth 副作用能力位）：该渠道的 submitCallbackUrl 路径不经 beginOAuth 的
    // onDone（会话可能已超时关闭），需要主进程按此声明补跑「刷新余额 + 自动签到 + 事件」。
    // 其它渠道（raccoon/zcode 等）内部已调 finishOAuth→onDone，若声明此位会重复执行副作用。
    postOAuthEffects: ["refresh", "checkin", "emit"],
    cfg() {
        return rules.get("headers.json").lobster;
    },
    /** 授权/刷新/积分等控制面头（无需 Bearer） */
    authHeaders(extra) {
        const c = this.cfg();
        return {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": `${c.clientName || "LobsterAI"}/${this.version()}`,
            ...(extra || {}),
        };
    },
    /** 对话头：Bearer + 客户端能力/版本头（官方客户端实测值） */
    chatHeaders(token, version) {
        const c = this.cfg();
        const ver = version || this.version();
        return {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            "user-agent": `${c.clientName || "LobsterAI"}/${ver}`,
            "X-LobsterAI-Client-Capabilities": c.clientCapabilities || "kimi-k3-agentic-v1",
            "X-LobsterAI-Client-Version": ver,
        };
    },
    /** 当前客户端版本号：优先官方更新接口（缓存 1h），失败回落配置常量。
     *  签到活动按版本门禁——低于 2026.9.4 会被服务端隐藏（实测 0.1.0 → slotState=empty） */
    version() {
        const c = this.cfg();
        const now = Date.now();
        if (lobsterVersionCache.val && now - lobsterVersionCache.at < 3600000)
            return lobsterVersionCache.val;
        if (lobsterVersionCache.failedAt && now - lobsterVersionCache.failedAt < 600000) {
            return lobsterVersionCache.val || c.clientVersion || LOBSTER_UA_FALLBACK;
        }
        return lobsterVersionCache.val || c.clientVersion || LOBSTER_UA_FALLBACK;
    },
    /** 异步刷新版本号（签到/拉目录前调用，拿不到就用缓存/兜底） */
    async refreshVersion() {
        const c = this.cfg();
        const now = Date.now();
        if (lobsterVersionCache.val && now - lobsterVersionCache.at < 3600000)
            return lobsterVersionCache.val;
        const fallback = c.clientVersion || LOBSTER_UA_FALLBACK;
        const r = await httpJson(c.versionUrl, { method: "GET", headers: { accept: "application/json" } }).catch(() => null);
        const v = r && r.ok && r.data && r.data.data && r.data.data.value && r.data.data.value.version;
        if (v && /^\d{4}\.\d+/.test(String(v))) {
            lobsterVersionCache = { val: String(v), at: now, failedAt: 0 };
            return String(v);
        }
        lobsterVersionCache = { val: lobsterVersionCache.val || fallback, at: 0, failedAt: now };
        return lobsterVersionCache.val;
    },
    models() {
        return unionIds([...catalogMap("lobster").values()].map((m) => String(m.id)), []);
    },
    /** 拉取官方模型目录：优先 GET /api/models/available（Bearer，含账号可见范围），
     *  Bearer 目录不可用（未登录/凭证失效/上游异常）时回退**公开** GET /api/models/pricing-catalog
     *  ——官方文档 2026-08-27-more-models.md 标注其 remains public，实测无需鉴权，含完整
     *  modelId/contextWindow/supportsImage/supportsThinking/costMultiplier。两者都失败才报错。
     *  返回 {code,data:[{modelId,modelName,provider,apiFormat,supportsImage,supportsThinking,
     *  contextWindow,explicitContextCache,thinkingConfig}]}（字段实证自官方开源仓库
     *  docs/server-integration/2026-06-24-explicit-context-cache-models.md 与
     *  specs/features/model-thinking-level-control） */
    async fetchModels(account, secrets) {
        let r = await this.fetchModelsOnce(account, secrets);
        if (r.authError) {
            const rr = await refreshTokenLocked(this.id, account, secrets).catch(() => ({ ok: false }));
            if (rr.ok) {
                if (account && account.id) {
                    store.updateAccount(account.id, { token: rr.token, refreshToken: rr.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
                }
                r = await this.fetchModelsOnce(account, { token: rr.token, refreshToken: rr.refreshToken });
            }
        }
        if (r.ok)
            return r;
        // Bearer 目录拉不动时不直接判失败：公开定价目录仍能给出完整清单与真实元数据
        // （入口 IPC 要求号池有 online 账号；凭证失效但账号仍在池里时，这个兜底让目录照样能刷新）
        const pub = await this.fetchModelsPublic(account).catch(() => ({ ok: false }));
        if (pub.ok)
            return pub;
        return r.authError ? { ok: false, message: "账号登录态失效（401），请重新登录" } : r;
    },
    /** 公开定价目录（无需鉴权，权威兜底源）：{data:{textModels:[{modelId,modelName,contextWindow,
     *  supportsImage,supportsThinking,costMultiplier,freeAccess,...}]}}（另有 imageModels/videoModels，
     *  非文本对话、本渠道不接入） */
    async fetchModelsPublic() {
        const c = this.cfg();
        if (!c.pricingCatalogUrl)
            return { ok: false, message: "未配置公开目录端点" };
        const r = await httpJson(c.pricingCatalogUrl, { method: "GET", headers: { accept: "application/json" } }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const list = (r.data && r.data.data && Array.isArray(r.data.data.textModels) && r.data.data.textModels) || null;
        if (!r.ok || !list || !list.length)
            return { ok: false, message: `公开目录拉取失败（HTTP ${r.status || 0}）` };
        const models = [];
        for (const raw of list) {
            const id = raw && raw.modelId;
            if (typeof id !== "string" || !id)
                continue;
            const img = typeof raw.supportsImage === "boolean" ? raw.supportsImage : undefined;
            const think = typeof raw.supportsThinking === "boolean" ? raw.supportsThinking : undefined;
            const rate = Number(raw.costMultiplier);
            models.push({
                id,
                name: String(raw.modelName || id),
                rate: Number.isFinite(rate) ? rate : null,
                capabilities: capsWithImages(img, { reasoning: think !== false, tools: true }),
                contextLength: tokenLimit(raw.contextWindow),
                maxOutputTokens: tokenLimit(raw.maxOutputTokens),
            });
        }
        if (!models.length)
            return { ok: false, message: "公开目录为空或无可对话模型" };
        return { ok: true, models };
    },
    async fetchModelsOnce(account, secrets) {
        const c = this.cfg();
        const headers = this.chatHeaders(secrets.token);
        const r = await httpJson(c.modelsUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { ok: false, authError: true, message: "登录态已过期（HTTP 401）" };
        const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        const list = (r.data && Array.isArray(r.data.data) && r.data.data) || findList(r.data, "data", 0);
        if (!r.ok || code !== 0 || !Array.isArray(list) || !list.length) {
            return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}${r.data && r.data.message ? " " + r.data.message : ""}）` };
        }
        const models = [];
        for (const raw of list) {
            const id = raw && (raw.modelId || raw.model_id || raw.id);
            if (typeof id !== "string" || !id)
                continue;
            const name = String(raw.modelName || raw.model_name || id);
            // 能力位优先取服务端显式声明（supportsImage/supportsThinking），缺失才嗅探。
            // 绝不编造：sniffImages 无信号时返回 undefined（=未声明），capsWithImages 会省略该键
            const imgDeclared = typeof raw.supportsImage === "boolean" ? raw.supportsImage : undefined;
            const thinkDeclared = typeof raw.supportsThinking === "boolean" ? raw.supportsThinking : undefined;
            const img = imgDeclared !== undefined ? imgDeclared : (sniffImages(raw) ?? (/v-turbo|vision|-vl\b/i.test(id) ? true : undefined));
            models.push({
                id,
                name,
                rate: null,
                capabilities: capsWithImages(img, { reasoning: thinkDeclared !== false, tools: true }),
                // contextWindow 缺失一律 0（未知）——官方对 null 值由客户端回落 OpenClaw 默认 200k，
                // 但本仓库约定「模型上限类字段绝不给编造的默认值」（假值会让客户端误判上下文溢出）
                contextLength: tokenLimit(raw.contextWindow ?? raw.context_length ?? raw.contextLength),
                maxOutputTokens: tokenLimit(raw.maxOutputTokens || raw.max_tokens),
            });
        }
        if (!models.length)
            return { ok: false, message: "目录为空或无可对话模型" };
        return { ok: true, models };
    },
    /** 积分余额：GET /api/user/profile-summary → data.totalCreditsRemaining（含活动积分） */
    async queryCredits(account, secrets) {
        const c = this.cfg();
        const headers = this.chatHeaders(secrets.token);
        const r = await httpJson(c.balanceUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { authError: true };
        const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        if (!r.ok || !r.data || code !== 0) {
            throw new Error(`额度查询失败：HTTP ${r.status}${r.data && r.data.message ? " " + r.data.message : ""}${r.message ? " " + r.message : ""}`);
        }
        const d = r.data.data || r.data;
        const credits = Number(d.totalCreditsRemaining ?? d.total_credits_remaining ?? d.remainingCredits) || 0;
        return { credits, packages: lobsterCreditPackages(d.creditItems ?? d.credit_items), raw: d };
    },
    /** 签到状态：读活动 context 的 claimedToday（不消费签到动作） */
    async checkinStatus(account, secrets) {
        try {
            const c = this.cfg();
            const version = await this.refreshVersion();
            const slot = await this.fetchSlot(secrets, version);
            if (!slot.ok)
                return { ok: false, message: slot.message };
            if (!slot.activity)
                return { ok: true, unavailable: true, checkedIn: false, message: "当前没有可参与的签到活动（活动按客户端版本下发）" };
            const ctx = await this.fetchContext(secrets, slot.activity.activityCode, slot.activity.configRevision, version);
            if (!ctx.ok)
                return { ok: false, message: ctx.message };
            const claimed = !!(ctx.state && ctx.state.claimedToday);
            return {
                ok: true,
                checkedIn: claimed,
                already: claimed,
                reward: Number(ctx.state && ctx.state.rewardCredits) || 0,
                message: claimed ? "今日已签到" : `今日未签到（可得 ${Number(ctx.state && ctx.state.rewardCredits) || 0} 积分）`,
            };
        }
        catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
        }
    },
    /** 活动槽：GET /api/client-activities/slot?placement=…&clientVersion=… */
    async fetchSlot(secrets, version) {
        const c = this.cfg();
        const u = `${c.activitySlotUrl}?placement=${encodeURIComponent(c.checkinPlacement || "desktop_sidebar")}&clientVersion=${encodeURIComponent(version)}&containerApiVersion=2&platform=win32`;
        const r = await httpJson(u, { method: "GET", headers: this.authHeaders({ authorization: `Bearer ${secrets.token}` }) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { ok: false, authError: true, message: "凭证失效，请重新登录" };
        const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        if (!r.ok || code !== 0 || !r.data)
            return { ok: false, message: (r.data && r.data.message) || r.message || `活动查询失败 HTTP ${r.status}` };
        const d = r.data.data || {};
        // slotState=empty 表示该版本号看不到活动（不是错误，如实提示）
        if (d.slotState !== "available" || !d.activity)
            return { ok: true, activity: null, slotState: d.slotState || "" };
        return { ok: true, activity: d.activity };
    },
    /** 活动状态：GET /api/client-activities/{code}/context?configRevision=N */
    async fetchContext(secrets, code, revision, version) {
        const c = this.cfg();
        const u = `${c.activityBaseUrl}/${encodeURIComponent(code)}/context?configRevision=${Number(revision) || 1}`;
        const r = await httpJson(u, { method: "GET", headers: this.authHeaders({ authorization: `Bearer ${secrets.token}` }) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { ok: false, authError: true, message: "凭证失效，请重新登录" };
        const code0 = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        if (!r.ok || code0 !== 0 || !r.data)
            return { ok: false, message: (r.data && r.data.message) || r.message || `活动状态查询失败 HTTP ${r.status}` };
        const d = r.data.data || {};
        return { ok: true, state: d.state || {}, actions: Array.isArray(d.actions) ? d.actions : [], authenticated: !!d.authenticated };
    },
    /** 每日签到：slot → context → POST actions/check_in → 复核 claimedToday。
     *  幂等：已签到 / 无活动 都返回 ok（不算失败），不会重复领取（服务端另有 idempotencyKey 兜底） */
    async checkin(account, secrets) {
        const c = this.cfg();
        const version = await this.refreshVersion();
        const slot = await this.fetchSlot(secrets, version);
        if (!slot.ok)
            return { ok: false, message: slot.message };
        if (!slot.activity) {
            // 版本门禁（服务端按 clientVersion 下发活动）：属「不开放」而非失败——照 trae 的
            // 同款约定返回 ok:true + unavailable，号池页才会显示「不开放」而不是红色「失败」
            // （checkinTagText 对 ok:false 一律判失败，unavailable 分支根本走不到）
            return { ok: true, unavailable: true, claimed: false, message: `当前版本看不到签到活动（slotState=${slot.slotState || "empty"}）——已自动取线上版本号，仍为空请稍后重试` };
        }
        const { activityCode: code, configRevision: rev } = slot.activity;
        const ctx = await this.fetchContext(secrets, code, rev, version);
        if (!ctx.ok)
            return { ok: false, message: ctx.message };
        const reward = Number(ctx.state && ctx.state.rewardCredits) || 0;
        if (ctx.state && ctx.state.claimedToday) {
            return { ok: true, already: true, claimed: false, reward, message: "今日已签到" };
        }
        if (!ctx.actions.includes("check_in")) {
            return { ok: false, message: `活动不可签到（actions=${JSON.stringify(ctx.actions)}）` };
        }
        const body = JSON.stringify({ configRevision: Number(rev) || 1, idempotencyKey: util.uuid(), payload: {} });
        const actionUrl = `${c.activityBaseUrl}/${encodeURIComponent(code)}/actions/check_in`;
        const r = await httpJson(actionUrl, { method: "POST", headers: this.authHeaders({ authorization: `Bearer ${secrets.token}` }), body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { ok: false, message: "凭证失效，请重新登录" };
        const codeN = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        if (!r.ok || codeN !== 0) {
            return { ok: false, message: (r.data && r.data.message) || r.message || `签到失败 HTTP ${r.status}` };
        }
        // 复核：只有 claimedToday 真的翻转才算成功（防"接口成功但没发分"）
        const after = await this.fetchContext(secrets, code, rev, version);
        if (after.ok && after.state && !after.state.claimedToday) {
            return { ok: false, message: "签到接口已返回成功，但服务端 claimedToday 未翻转，请稍后在客户端确认" };
        }
        const got = Number(after.ok && after.state && after.state.claimedCredits) || 0;
        return { ok: true, already: false, claimed: true, reward: reward || got, message: reward ? `签到成功，+${reward} 积分` : "签到成功" };
    },
    /** 龙虾无"加油包"免费领取动作 */
    async trial() {
        return { ok: false, message: "LobsterAI 无加油包领取动作" };
    },
    /** Token 刷新：POST /api/auth/refresh（body 含 refreshToken + keyfrom 载荷，无需 Bearer）。
     *  上游口径：响应 accessToken 缺失即视为 refresh 被拒（终止性，需重新登录） */
    async refreshToken(account, secrets) {
        const c = this.cfg();
        const refreshToken = (secrets && secrets.refreshToken) || "";
        if (!refreshToken)
            return { ok: false, message: "无 refreshToken，请重新登录" };
        const meta = (account && account.meta) || {};
        const body = JSON.stringify({
            refreshToken,
            firstKeyfrom: String(meta.firstKeyfrom || ""),
            latestKeyfrom: String(Date.now()),
            version: "0.1.0",
            ...(meta.uuid ? { uuid: String(meta.uuid) } : {}),
            ...(meta.youdaoUserId ? { userId: String(meta.youdaoUserId) } : {}),
        });
        const r = await httpJson(c.refreshUrl, { method: "POST", headers: this.authHeaders(), body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const d = (r.data && (r.data.data || r.data)) || null;
        const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
        const token = d && (d.accessToken || d.access_token);
        if (r.ok && code === 0 && token) {
            const nextRefresh = (d.refreshToken || d.refresh_token) ? String(d.refreshToken || d.refresh_token) : refreshToken;
            const expiresIn = Number(d.expiresIn || d.expires_in) || 0;
            return {
                ok: true,
                token: String(token),
                refreshToken: nextRefresh,
                expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : (util.jwtDecode(String(token)).exp || 0) * 1000,
            };
        }
        if (r.status === 401 || r.status === 403 || code === 401 || code === 40100 || code === 40101) {
            return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
        }
        return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}` };
    },
    /** 用户信息（导入后补全 uid/昵称）：GET /api/user/profile-summary */
    async userInfo(token, account) {
        const c = this.cfg();
        const r = await httpJson(c.balanceUrl, { method: "GET", headers: this.chatHeaders(token) }).catch(() => ({ ok: false, status: 0, data: null }));
        const d = r.data && (r.data.data || r.data);
        if (r.ok && d) {
            return {
                uid: String(d.uid || d.userId || d.user_id || d.id || ""),
                name: String(d.nickname || d.name || d.phone || ""),
            };
        }
        // 兜底：从 JWT 解 uid
        const dec = util.jwtDecode(token);
        return { uid: String(dec.uid || dec.sub || ""), name: "" };
    }
};
// ===== ZCode（智谱 GLM 编码套餐，渠道 id: zcode） =====
// 与既有四渠道的本质差异：上游是 Anthropic Messages 协议（OpenAI 请求须经 zcodeAnthropic 双向翻译）；
// 一个账号是双凭据——zcodejwttoken（token_enc：start-plan 对话 + billing/claim 控制面）与
// coding-plan API key（refresh_enc：coding-plan 对话，"{apiKey}.{secret}"）。
// 对话选路：有 coding-plan key 优先 coding-plan（正式付费套餐），否则 start-plan（免费/领取的套餐）。
// 事实基线：官方客户端协议实测（2026-10）
// + 本机 ~/.zcode/v2 实测（见 zcodeLocal.cjs 文件头注释）。
const zcodeLocal = require("./zcodeLocal.cjs");
/** 本机设备 ID（telemetry-state.json 的 deviceMid）：本机当前登录态的默认指纹 */
function zcodeDeviceMid() {
    const t = zcodeLocal.readJson(zcodeLocal.paths().telemetry);
    return String((t && t.deviceMid) || "");
}
/**
 * 账号级专属设备指纹（deviceMid 隔离）：
 * 优先取 account.meta.deviceMid（单号单机，终生稳定）；
 * 若无且确属本机当前登录账号，继承本机 telemetry-state.json 的真实 deviceMid；
 * 其余情况按账号 UID 派生出确定性的 UUIDv4，确保同账号多请求指纹恒定，且不同账号互不串联关联封号。
 */
function resolveAccountDeviceMid(account) {
    const meta = (account && account.meta) || {};
    if (meta.deviceMid)
        return String(meta.deviceMid);
    const live = zcodeLocal.readLive();
    const liveUid = live && (zcodeLocal.uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid));
    const mid = zcodeDeviceMid();
    if (mid && account && account.uid && liveUid && account.uid === liveUid) {
        return mid;
    }
    if (account && (account.uid || account.id)) {
        const h = crypto.createHash("sha256").update(`zcode-device:${account.uid || account.id}`).digest("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    return mid || util.uuid();
}
/** 控制面身份头组（billing/claim/configs：带 X-Device-Mid，不带 X-ZCode-Agent）。
 *  deviceMid 采用账号级专属指纹，避免多账号并发同指纹触发上游设备关联封控 */
function zcodeCtlHeaders(c, secrets, account) {
    const ver = c.appVersion || "4.1.10";
    const h = {
        "content-type": "application/json",
        accept: "application/json",
        "User-Agent": `ZCode/${ver}`,
        "HTTP-Referer": c.refererOrigin || "https://zcode.z.ai",
        "X-Title": `Z Code@${c.sourceTitle || "cli"}`,
        "X-ZCode-App-Version": ver,
        "X-Platform": c.platform || "win32-x64",
        "X-Release-Channel": "stable",
        "X-Client-Language": "zh-CN",
        "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        "X-Os-Category": "windows",
        authorization: `Bearer ${secrets.token}`,
    };
    const mid = resolveAccountDeviceMid(account);
    if (mid)
        h["X-Device-Mid"] = mid;
    return h;
}
/** billing/* 专用头组（**客户端形态**）：官方客户端调 `billing/preview`、`billing/claim` 时
 *  只发 `Authorization` + `Content-Type` + `X-ZCode-App-Version` + `X-Platform`
 *  （ZCode 3.16.3，见 docs/号池签到核对-20261028/11 §2）。
 *
 *  与 `zcodeCtlHeaders` 的差别：**不发** `X-Device-Mid`/`HTTP-Referer`/`X-Title`/
 *  `X-Release-Channel`/`X-Client-Language`/`X-Client-Timezone`/`X-Os-Category`/`User-Agent`
 *  —— 客户端把 `X-Device-Mid` 只用在 marketing/touch、反馈工单与更新清单上，billing/* 不用。
 *
 *  ⚠ 回退开关：若实测发现 claim 的 `1004`（原「指纹本周已被消耗」）行为依赖 `X-Device-Mid`，
 *  把 rules 里该渠道的 `billingLegacyHeaders` 置 true 即可恢复旧头组，无需改代码。 */
function zcodeBillingHeaders(c, secrets, account) {
    const cfg = c || {};
    if (cfg.billingLegacyHeaders)
        return zcodeCtlHeaders(cfg, secrets, account);
    const ver = cfg.appVersion || "4.1.10";
    return {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${secrets.token}`,
        "X-ZCode-App-Version": ver,
        "X-Platform": cfg.platform || "win32-x64",
    };
}
// 待消费的阿里云验证码一次性凭据（账号 ID → { verifyParam, region, expireAt }）
const pendingCaptchaTokens = new Map();
function setPendingCaptcha(accountId, data) {
    if (!accountId || !data)
        return;
    pendingCaptchaTokens.set(String(accountId), data);
}
function getPendingCaptcha(accountId) {
    if (!accountId)
        return null;
    const hit = pendingCaptchaTokens.get(String(accountId));
    if (!hit)
        return null;
    if (hit.expireAt && hit.expireAt < Date.now()) {
        pendingCaptchaTokens.delete(String(accountId));
        return null;
    }
    pendingCaptchaTokens.delete(String(accountId)); // one-shot 即用即消
    return hit;
}
/** ZCode 地区表（地区 → 站点身份的唯一事实来源；与 monkeycode/region.cjs 同构） */
const zcodeRegion = require("./zcode/region.cjs");
function makeZcode(channel) {
  const region = zcodeRegion.byChannel(channel);
  const channelId = region ? region.channel : channel;
  return {
    readForwardContext(account) {
        return { deviceMid: resolveAccountDeviceMid(account) };
    },
    id: channelId,
    cfg() {
        // 规则段按渠道 id 取（zcode / zcode_intl 各一段），缺失时回落到 CN 段
        // （INTL 推理平面与 CN 同为 zcode.z.ai 控制面，分地区的只是推理/monitor/biz）
        const all = rules.get("headers.json") || {};
        const base = all.zcode || {};
        const override = channelId === "zcode" ? {} : (all[channelId] || {});
        return { ...base, ...override };
    },
    models() {
        const catalog = [...catalogMap(channelId).values()].map((m) => String(m.id));
        return unionIds(catalog, ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2"]);
    },
    /** 在线模型目录：billing/balance 的 balances[].capabilities "model:*" 提取（账号真实可用集） */
    async fetchModels(account, secrets) {
        const c = this.cfg();
        const url = `${c.billingBase}/billing/balance?app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
        const r = await httpJson(url, { method: "GET", headers: zcodeCtlHeaders(c, secrets, account) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401)
            return { ok: false, message: "账号登录态失效（401），请重新登录" };
        const balances = r.data && r.data.data && Array.isArray(r.data.data.balances) ? r.data.data.balances : [];
        const ids = [];
        for (const b of balances) {
            for (const cap of Array.isArray(b && b.capabilities) ? b.capabilities : []) {
                const m = /^model:(.+)$/.exec(String(cap || ""));
                if (m && m[1] && !ids.includes(m[1]))
                    ids.push(m[1]);
            }
        }
        if (!ids.length)
            return { ok: false, message: "上游未返回可用模型（balances 为空或无 capabilities）" };
        return {
            ok: true,
            models: ids.map((id) => {
                // 模态与上限都优先取官方客户端自带的元数据表（modelConfigRules；逐属性取最后定义值），
                // 取不到再退回通用嗅探/保守默认——别再硬编码 131072/8192（实测真实值为 1000000/128000，
                // 硬编码曾把长回答卡在 8192 造成 MAX_TOKENS 截断）
                const meta = zcodeLocal.resolveModelMeta(id);
                const fmt = (meta && meta.inputFormat) || null;
                const img = fmt && typeof fmt.supportsImage === "boolean" ? fmt.supportsImage : sniffImages(id);
                const caps = capsWithImages(img, { reasoning: true, tools: true });
                if (fmt && typeof fmt.supportsVideo === "boolean")
                    caps.video = fmt.supportsVideo;
                if (fmt && typeof fmt.supportsPdf === "boolean")
                    caps.pdf = fmt.supportsPdf;
                const ctx = (meta && meta.contextWindow) || 131072;
                const maxOut = (meta && meta.maxOutputTokens) || 8192;
                return { id, name: id, rate: null, capabilities: caps, contextLength: ctx, maxOutputTokens: maxOut };
            }),
        };
    },
    /**
     * 额度查询（双通道）：jwt 在 → zai billing（balance + current 合并）；
     * jwt 缺失但有 coding-plan key → bigmodel monitor quota/limit。
     * 429 退避 [0.5,1.5,4]s；全员 401 时等 1.5s 重试一次（新账号服务端激活延迟的实证口径）。
     */
    async queryCredits(account, secrets) {
        const c = this.cfg();
        if (secrets.token && secrets.refreshToken) {
            const [rj, ra] = await Promise.all([
                this.queryCreditsByJwt(account, secrets, c).catch((e) => ({ error: String((e && e.message) || e) })),
                this.queryCreditsByApiKey(account, secrets, c).catch((e) => ({ error: String((e && e.message) || e) })),
            ]);
            // 若 API Key 成功：绝不报 authError 误判停用好号，且合并两路额度（上游 merge_parts）
            if (ra && !ra.authError && !ra.error) {
                const totalCredits = (Number(ra.credits) || 0) + (!rj.authError && !rj.error ? (Number(rj.credits) || 0) : 0);
                const exp = [ra.expiresAt, (!rj.authError && !rj.error ? rj.expiresAt : 0)].filter((t) => t > Date.now());
                return {
                    credits: totalCredits,
                    expiresAt: exp.length ? Math.min(...exp) : 0,
                    raw: { jwt: rj.raw, apiKey: ra.raw, jwtAuthError: !!rj.authError },
                };
            }
            if (rj && !rj.authError && !rj.error)
                return rj;
            // 两路均明确 401/authError 才终判凭据失效
            if (rj.authError && ra.authError)
                return { authError: true, message: "ZCode 凭证失效（JWT 与 API Key 均失效）" };
            return { error: rj.error || ra.error || "额度查询失败" };
        }
        if (secrets.token)
            return this.queryCreditsByJwt(account, secrets, c);
        if (secrets.refreshToken)
            return this.queryCreditsByApiKey(account, secrets, c);
        return { authError: true, message: "该账号没有任何可用凭据" };
    },
    async queryCreditsByJwt(account, secrets, c) {
        const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
        const headers = zcodeCtlHeaders(c, secrets, account);
        const delays = [0, 500, 1500, 4000];
        let last = null;
        for (let i = 0; i < delays.length; i++) {
            if (delays[i])
                await new Promise((r) => setTimeout(r, delays[i]));
            const [rb, rc] = await Promise.all([
                httpJson(`${c.billingBase}/billing/balance?${qs}`, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) })),
                httpJson(`${c.billingBase}/billing/current?${qs}`, { method: "GET", headers }).catch(() => ({ ok: false, status: 0, data: null })),
            ]);
            if (rb.status === 401 || rb.status === 403) {
                last = { authError: true };
                continue; // 退避后重试；末尾仍 401 交给「激活延迟」终判
            }
            if (rb.status === 429) {
                last = { error: "额度接口限流（429），已退避重试" };
                continue;
            }
            const data = rb.data && (rb.data.data || rb.data);
            if (!rb.ok || !data) {
                last = { error: `额度查询失败：HTTP ${rb.status || 0}${rb.message ? " " + rb.message : ""}` };
                break;
            }
            const balances = Array.isArray(data.balances) ? data.balances : [];
            const credits = balances.reduce((sum, b) => sum + (Number(b ? (b.remaining_units ?? b.remainingUnits) : 0) || 0), 0);
            const futureExpiries = balances.map((b) => util.toMs(b && (b.expires_at ?? b.expiresAt))).filter((t) => t > Date.now());
            const expiresAt = futureExpiries.length ? Math.min(...futureExpiries) : 0;
            const cur = rc.data && (rc.data.data || rc.data);
            const plans = Array.isArray(data.plans) ? data.plans : Array.isArray(cur && cur.plans) ? cur.plans : [];
            // 全部为空且 401 之外的「空响应」可能是新账号激活延迟：与 401 场景共用一次终判重试
            if (!balances.length && !plans.length && i < delays.length - 1) {
                last = { error: "额度数据为空（新账号可能激活延迟）" };
                continue;
            }
            const packages = zcodeCreditPackages(balances, plans);
            return { credits, expiresAt, packages, raw: { balances: balances.length, plans: plans.length } };
        }
        // 终判：全程 401 → 最后再等 1.5s 用同一 jwt 试一次，仍 401 才算凭证失效
        if (last && last.authError) {
            await new Promise((r) => setTimeout(r, 1500));
            const qs2 = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
            const r2 = await httpJson(`${c.billingBase}/billing/balance?${qs2}`, { method: "GET", headers: zcodeCtlHeaders(c, secrets, account) }).catch(() => ({ status: 0 }));
            if (r2.status === 401 || r2.status === 403)
                return { authError: true };
        }
        return last && last.error ? { error: last.error } : last && last.authError ? { authError: true } : { error: "额度查询失败" };
    },
    async queryCreditsByApiKey(account, secrets, c) {
        const monitorUrl = zcodeRegion.resolve(region, c, "monitorQuotaUrl") || c.monitorQuotaUrl;
        const r = await httpJson(monitorUrl, {
            method: "GET",
            headers: { "content-type": "application/json", authorization: `Bearer ${secrets.refreshToken}` },
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401 || r.status === 403)
            return { authError: true };
        const data = r.data && (r.data.data || r.data);
        if (!r.ok || !data)
            return { error: `额度查询失败：HTTP ${r.status || 0}${r.message ? " " + r.message : ""}` };
        const limits = Array.isArray(data.limits) ? data.limits : [];
        const credits = limits.reduce((sum, l) => sum + (Number(l && l.remaining) || 0), 0);
        const resets = limits.map((l) => util.toMs(l && l.nextResetTime)).filter((t) => t > Date.now());
        return { credits, expiresAt: resets.length ? Math.min(...resets) : 0, raw: { level: data.level || "" } };
    },
    /** 领取奖励状态 = claim preview：列出当前可领套餐（周末包等） */
    async checkinStatus(account, secrets) {
        const c = this.cfg();
        if (!secrets.token)
            return { ok: false, message: "该账号无 zcodejwt 凭据（仅 coding-plan key 不支持领取）" };
        const url = `${c.billingBase}/billing/preview?app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
        const r = await httpJson(url, { method: "GET", headers: zcodeBillingHeaders(c, secrets, account) }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        if (r.status === 401)
            return { ok: false, message: "凭证失效，请重新登录" };
        if (r.status === 404)
            return { ok: true, unavailable: true, message: "当前没有可领取的奖励活动" };
        const data = r.data && (r.data.data || r.data);
        const plans = Array.isArray(data && data.plans) ? data.plans : [];
        if (!r.ok)
            return { ok: false, message: `查询失败 HTTP ${r.status}${r.message ? " " + r.message : ""}` };
        if (!plans.length)
            return { ok: true, unavailable: true, message: "当前没有可领取的奖励活动" };
        return {
            ok: true,
            checkedIn: false,
            plans: plans.map((p) => ({ planId: String(p.plan_id || ""), name: String(p.name || ""), description: String(p.description || ""), priority: Number(p.priority) || 0, endsAt: util.toMs(p.ends_at) })),
            message: `有 ${plans.length} 个可领取的奖励套餐`,
        };
    },
    /**
     * 领取奖励（checkin 语义映射）：preview 取最高优先级套餐 → 验证码配置判定 → claim。
     * 验证码二段流：captcha 未携带且上游启用验证码时返回 {needCaptcha:true, plan}，
     * 由编排层（index.cjs checkinBatch）弹验证码窗拿 verifyParam 后带 opts.captcha 重调。
     */
    async checkin(account, secrets, opts) {
        const c = this.cfg();
        if (!secrets.token)
            return { ok: false, message: "该账号无 zcodejwt 凭据，无法领取" };
        const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
        const headers = zcodeCtlHeaders(c, secrets, account);
        // billing/* 走客户端形态头组（少发 8 个客户端不发的头），configs 仍用 ctl 头组
        const billingHeaders = zcodeBillingHeaders(c, secrets, account);
        // ① 选定套餐：调用方指定 planId，否则 preview 取最高优先级
        let planId = String((opts && opts.planId) || "");
        if (!planId) {
            const st = await this.checkinStatus(account, secrets);
            if (!st.ok)
                return st;
            if (st.unavailable)
                return { ok: true, already: true, message: st.message };
            const top = [...(st.plans || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
            if (!top || !top.planId)
                return { ok: true, already: true, message: "当前没有可领取的奖励活动" };
            planId = top.planId;
        }
        // ② 验证码判定：上游启用且未携带 verifyParam → 交编排层弹窗过码（不自动求解）
        let captcha = (opts && opts.captcha) || null;
        if (!captcha) {
            const cfgR = await httpJson(`${c.clientConfigsUrl}?${qs}`, { method: "GET", headers }).catch(() => null);
            const cc = cfgR && cfgR.data && cfgR.data.data && cfgR.data.data.configs && cfgR.data.data.configs.captcha;
            if (cc && cc.enabled && cc.sceneId) {
                return {
                    ok: false,
                    needCaptcha: true,
                    planId,
                    captcha: { sceneId: String(cc.sceneId), prefix: String(cc.prefix || ""), region: String(cc.region || "") },
                    message: "领取需要完成一次人机校验（滑块/点选），请在弹出的验证窗口中完成",
                };
            }
        }
        // ③ 【已移除】原「激活事件上报」（app_launch / app_daily_active）
        //   移除理由（2026-10-28，见 docs/号池签到核对-20261028/11 §2 与 05-pool-probing-audit.md R-3）：
        //   ① 该上报的真实目的是「提升领取资格 / 提升风控信誉」，属伪造客户端行为事实，不是账号管理；
        //   ② 字段本身也是错的——客户端 body 为 17 字段且核心键是 `element_name`，
        //      原实现发的 `event` 在客户端根本不存在，该请求很可能完全无效；
        //   ③ 原实现是 `.catch(() => {})` 旁路，claim 不依赖它 → 移除零功能损失。
        // ④ claim
        const claimHeaders = { ...billingHeaders };
        if (captcha && captcha.verifyParam) {
            claimHeaders["X-Aliyun-Captcha-Verify-Param"] = String(captcha.verifyParam);
            if (captcha.region)
                claimHeaders["X-Aliyun-Captcha-Verify-Region"] = String(captcha.region);
        }
        const r = await httpJson(`${c.billingBase}/billing/claim`, {
            method: "POST",
            headers: claimHeaders,
            body: JSON.stringify({ plan_id: planId }),
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const data = r.data && (r.data.data || r.data);
        const code = Number((r.data && r.data.code) || 0);
        if (r.status === 401)
            return { ok: false, message: "凭证失效，请重新登录" };
        if (code === 3007) {
            // verifyParam 被拒：编排层应重新弹窗
            return { ok: false, needCaptcha: true, planId, captcha: { sceneId: (opts && opts.captcha && opts.captcha.sceneId) || "" }, message: "人机校验未通过，请重试" };
        }
        if (code === 1005 || code === 1003) {
            const endsAt = util.toMs(data && (data.ends_at || (data.plan && data.plan.ends_at)));
            return { ok: true, already: true, nextAt: endsAt || 0, message: endsAt ? `已领取过，下次窗口 ${new Date(endsAt).toLocaleString("zh-CN")}` : "已领取过（已达上限）" };
        }
        if (code === 1004) {
            // 设备指纹被消耗（本周已有领取记录打在这枚 X-Device-Mid 上）：资格判定是
            // 「账号本周未领 ∧ 指纹本周未被消耗」，preview 能出套餐但 claim 必被挡。
            // 唯一出路是给该账号换一枚全新设备指纹——号池页「指纹修复」一键完成
            return { ok: false, deviceBurned: true, message: "设备指纹本周已被消耗（1004）：请到号池工具栏点「指纹修复」给该账号换新指纹后重试" };
        }
        if (r.ok && code === 0)
            return { ok: true, claimed: true, message: "领取成功" };
        return { ok: false, message: (r.data && (r.data.message || r.data.msg)) || r.message || `领取失败 HTTP ${r.status}` };
    },
    /** 加油包语义在 zcode 即领取奖励（与 checkin 同路径） */
    async trial(account, secrets, opts) {
        return this.checkin(account, secrets, opts);
    },
    /** zcodejwt 无 exp（长期有效）、coding-plan key 不过期：没有可刷新的东西，诚实返回。
     *  401 语义由 credits/server 落入 relogin 计数，引导用户重新 OAuth 登录或本机导入 */
    async refreshToken() {
        return { ok: false, expired: true, message: "ZCode 凭据长期有效（无自动刷新端点）；凭证失效时请重新 OAuth 登录或从本机软件导入" };
    },
    /** 账号信息（导入/OAuth 后补全 uid/昵称）：jwt 本地解 payload，user_info 由调用方从凭证快照补 */
    async userInfo(token) {
        const uid = zcodeLocal.uidFromJwt(token);
        return { uid, name: uid ? `ZCode ${uid.slice(0, 6)}` : "ZCode 账号" };
    },
    /**
     * 独立人机校验（过码）：从 client/configs 获取 captcha 配置，
     * 弹窗跑阿里云验证码拿到 verifyParam，并向服务端上报/核销，解除风控限制。
     */
    async solveCaptcha(account, secrets) {
        const c = this.cfg();
        if (!secrets.token)
            return { ok: false, message: "该账号无 zcodejwt 凭据，无法进行人机校验" };
        const qs = `app_version=${encodeURIComponent(c.appVersion)}&platform=${encodeURIComponent(c.platform)}`;
        const headers = zcodeCtlHeaders(c, secrets, account);
        // ① 获取验证码配置（sceneId、region、prefix）
        const cfgR = await httpJson(`${c.clientConfigsUrl}?${qs}`, { method: "GET", headers }).catch(() => null);
        const cc = cfgR && cfgR.data && cfgR.data.data && cfgR.data.data.configs && cfgR.data.data.configs.captcha;
        const sceneId = (cc && cc.sceneId) || (c.captcha && c.captcha.sceneId) || "";
        if (!sceneId) {
            return { ok: false, message: "上游未返回验证码配置（sceneId 为空），请稍后重试" };
        }
        const captchaCfg = {
            sceneId: String(sceneId),
            prefix: String((cc && cc.prefix) || ""),
            region: String((cc && cc.region) || "cn"),
        };
        // ② 调起人机校验（桌面 = 沙箱验证窗；无图形环境返回 needCaptcha，由调用方如实标记人工）
        const cap = await platform.solveCaptcha(captchaCfg, { forceShow: true });
        if (!cap.ok) {
            return { ok: false, message: cap.message || "人机校验未完成" };
        }
        // ③ 【已移除】原「激活事件上报（提升风控信誉）」——同 claim 路径的移除理由（R-3，伪造行为事实）
        // ④ 向 billing/claim 尝试核销验证码（即使套餐已领过或无套餐，带着 Header 请求也可核销验证码提升信誉）
        try {
            const claimHeaders = { ...headers, "X-Aliyun-Captcha-Verify-Param": String(cap.verifyParam) };
            if (cap.region)
                claimHeaders["X-Aliyun-Captcha-Verify-Region"] = String(cap.region);
            await httpJson(`${c.billingBase}/billing/claim`, {
                method: "POST",
                headers: claimHeaders,
                body: JSON.stringify({ plan_id: "verify" }),
            }).catch(() => { });
        }
        catch { /* 忽略核销错误 */ }
        // ⑤ 写入短期内存 token，供下一次聊天请求直接带上
        setPendingCaptcha(account.id, {
            verifyParam: cap.verifyParam,
            region: cap.region || captchaCfg.region,
            expireAt: Date.now() + 5 * 60000,
        });
        return { ok: true, verifyParam: cap.verifyParam, message: "人机校验通过，账号已恢复可用" };
    }
  };
}
const zcode = makeZcode("zcode");
// 国际版与 CN 同一份实现（zcode 平面同为 zcode.z.ai），分地区值由 zcode/region.cjs 按渠道解析。
// 挂载与 store.ZCODE_INTL_ENABLED 同步——ADAPTERS 参与 modelOwners/mergedModels。
const zcode_intl = store.ZCODE_INTL_ENABLED ? makeZcode("zcode_intl") : null;
// ===== 适配器契约（新增/维护渠道必读）=====
// 必需方法（缺失在启动期就报错，绝不留到运行期 "ad.chat is not a function"）：
//   cfg()           渠道配置（rules/headers.json 等，含网关地址）
//   models()        静态兜底模型清单（string[]，可为空数组——清单来自拉取目录时）
//   chat(ctx)       对话转发：{ account, secrets, model, body, emit, meta }，事件经 emit 回流
//   queryCredits()  余额查询：(account, secrets) → { credits, expiresAt }
// 推荐方法（现有 9 渠道全有；缺省时调用点各自守卫/降级）：
//   fetchModels / checkin / checkinStatus / refreshToken
// 可选方法（调用点均有 typeof 守卫或降级分支）：
//   trial / userInfo / mapModel / rewriteBody / solveCaptcha / claimOnboarding /
//   fetchModelsPublic / fetchModelsOnce / chatOnce …
// 可选扩展点：
//   stateful() + chatSession(ctx)  会话式转发：一次客户端请求 = 多个上游请求 + 协议翻译时声明
//     stateful() 返回 true，server 改走 chatSession（ctx 同 chat，不再走单发 chat）；缺省单发。
//   classifyError(e)  渠道私有业务码分类：返回 { kind, switchable, status } 走渠道级分类，
//     返回 null/undefined 走通用 classifyUpstream。注意 4008/11102 等码**跨渠道共用**
//     （trae/workbuddy/qoder 都会回），不要把它们搬进单个渠道的 classifyError。
// 命名约定：请求头方法统一 headers()。新增渠道步骤：
//   ① store.cjs 的 CHANNELS 加一行（含 display/domain/costTier）
//   ② 本文件实现适配器并挂到 ADAPTERS（必需方法缺失启动期即抛错）
//   ③ rules/headers.json 等规则文件加渠道配置
//   ④ 前端 format.ts 补 CHANNEL_NAMES / checkinLabels / balanceUnit 等展示文案
//   ⑤ tools/ 自测补注册断言（双表一致性由 consistencyReport 兜底，漏挂即自测失败）
const REQUIRED_ADAPTER_METHODS = ["cfg", 'models', 'queryCredits'];
/** 契约断言：必需方法缺失即抛错（启动期 fail-fast，而非运行期 TypeError） */
function assertAdapterContract(channel, ad) {
    for (const m of REQUIRED_ADAPTER_METHODS) {
        if (typeof (ad && ad[m]) !== "function") {
            throw new Error(`渠道 ${channel} 缺少必需的适配器方法 ${m}()（契约见 adapters.cjs 顶部注释块）`);
        }
    }
}
// ===== 自定义提供商：通用 OpenAI 兼容适配器（按 agents 行动态实例化，一张表行 = 一个上游端点） =====
const { makeOpenaiCompat, compatUrl, statusFromCompatError, compatModelEntries, providerCatalogMap } = require("../localgw/standard/openai-compat.cjs");
// 实例缓存按 `${id}:${updated_at}`：store.saveProvider 会前进 updated_at，于是改完配置自然换实例，
// 不必重启网关。上限防的是"反复编辑同一个提供商"堆积——每次编辑一个新时间戳、旧实例永不复用。
const compatCache = new Map();
function compatAdapter(id) {
    const row = store.channelList().find((c) => c.id === id && c.kind !== "builtin");
    if (!row)
        return null;
    const key = `${row.id}:${row.updatedAt}`;
    let ad = compatCache.get(key);
    if (!ad) {
        if (compatCache.size > 64)
            compatCache.clear();
        ad = makeOpenaiCompat(row);
        compatCache.set(key, ad);
    }
    return ad;
}
const ADAPTERS = { trae, workbuddy, workbuddy_ai, raccoon, modelscope, lobster, zcode };
// ZCode 国际版：与 store.ZCODE_INTL_ENABLED 同步挂载（参与 modelOwners/mergedModels）
if (zcode_intl) ADAPTERS.zcode_intl = zcode_intl;
// ModelScope 国际版：与 store.MODELSCOPE_INTL_ENABLED 同步挂载（参与 modelOwners/mergedModels）
if (modelscope_intl) ADAPTERS.modelscope_intl = modelscope_intl;
// ===== CatPaw（美团）=====
// 上游是**有状态会话协议**（round → event(running) → turn(SSE) → 工具循环 → event(completed)），
// 一个客户端请求会变成多个上游请求 + 协议翻译，故声明 stateful() 走 chatSession 扩展点
// （契约见本文件顶部注释块）。协议实现整体收在 catpaw/ 子目录，这里只做挂载
const { makeCatPaw } = require("./catpaw/management.cjs");
ADAPTERS.catpaw = makeCatPaw();
// ===== Qoder 双区（凭据层 + WASM 签名器 + 适配器）=====
// 与其它渠道的差异：签名是**每请求的**（wasm 驱动，见 qoderSigner.cjs），
// 故其 headers() 只返回非签名基础头，签名在 chat() 内按账号现场完成。
// 依赖注入原因：fetchStream/pumpSse/httpJson 是本模块私有函数（未导出），
// 由 qoderAdapter 直接 require 会形成循环依赖，故在此注入。
const qoderAuth = require("./qoderAuth.cjs");
const qoderSigner = require("./qoderManagementSigner.cjs");
const { makeQoder } = require("./qoderManagement.cjs");
const qoderDeps = { fetchStream, pumpSse, httpJson, rules, auth: qoderAuth, signer: qoderSigner, util, store };
const qoder = makeQoder("qoder", qoderDeps);
ADAPTERS.qoder = qoder;
// 千问办公双站：与 Qoder 同一套协议栈（同一份 makeQoder 工厂 + 站点表），
// 差异全在 `qoder/sites.cjs`。挂载与 store.QWEN_OFFICE_ENABLED 同步。
if (store.QWEN_OFFICE_ENABLED) {
    ADAPTERS.qwen_office = makeQoder("qwen_office", qoderDeps);
    ADAPTERS.qwen_office_intl = makeQoder("qwen_office_intl", qoderDeps);
}
// qoder_intl 暂停启用（免费额度不含 DeepSeek/GLM Flash，需充值；且本机未装国际版客户端）。
// 必须与 store.QODER_INTL_ENABLED 同步——ADAPTERS 参与 modelOwners/mergedModels，
// 只从 CHANNELS 移除而留在此处，会让模型被判为「双区共有」并路由到无账号的渠道。
if (store.QODER_INTL_ENABLED) {
    ADAPTERS.qoder_intl = makeQoder("qoder_intl", qoderDeps);
}
// ===== AutoClaw 双区（国内版 / 国际版：同协议同签名，仅域名与登录方式不同）=====
// 挂载必须与 store.AUTOCLAW_INTL_ENABLED 同步——ADAPTERS 参与 modelOwners/mergedModels，
// 只在 CHANNELS 出现而无适配器会让双表一致性校验失败（与 qoder_intl 同口径）。
// 刷新是「只读不回写」渠道：refreshToken 返回 noPersist 标记，
// server/credits 据此跳过 token 落库，新凭证只进适配器进程缓存。
const { makeAutoClaw } = require("./autoclaw/management.cjs");
const autoclawDeps = { fetchStream, pumpSse, httpJson, rules, util, store, deviceIds, firstByteBudgetMs };
ADAPTERS.autoclaw = makeAutoClaw("autoclaw", autoclawDeps);
if (store.AUTOCLAW_INTL_ENABLED) {
    ADAPTERS.autoclaw_intl = makeAutoClaw("autoclaw_intl", autoclawDeps);
}
// ===== Cline 双池（cline_free 免费额度池 / cline_pass 订阅池）=====
// 同套实现按池参数化（与 qoder/autoclaw 双区同款手法）：两池同域同协议同凭证，
// 差别只有「收哪个池的模型」；配置共用 headers.json 的 cline 段，无地区开关（常开）。
const { makeCline } = require("./cline/management.cjs");
const clineDeps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs };
ADAPTERS.cline_free = makeCline("cline_free", clineDeps);
ADAPTERS.cline_pass = makeCline("cline_pass", clineDeps);
// ===== Loomy（讯飞）=====
// 无状态 OpenAI 兼容上游（模型网关 /api/v1/chat/completions），鉴权双头 token + Bearer。
// HMAC-SHA1 签名只在账号域（短信登录用），转发链不用签名。短信登录见 loomy/login.cjs。
const { makeLoomy } = require("./loomy/management.cjs");
const loomyDeps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs };
ADAPTERS.loomy = makeLoomy(loomyDeps);
// ===== Accio 双区（accio 国际版 / accio_cn 国内版）=====
// 同套实现按渠道参数化（与 qoder/autoclaw 双区同款手法）：上游是阿里 ADK 的 Gemini 风格信封
// （非 OpenAI 协议），声明 stateful 走会话式转发 chatSession。两地同网关，差别只在
// x-package-region 头与登录站点（见 accio/endpoints.cjs）。登录走 OAuth + PKCE（S256）。
const { makeAccio } = require("./accio/management.cjs");
const accioDeps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs };
ADAPTERS.accio = makeAccio("accio", accioDeps);
ADAPTERS.accio_cn = makeAccio("accio_cn", accioDeps);
// ===== CodeArts（华为云 AI 代码助手 / snap-access）=====
// SDK-HMAC-SHA256 签名 + DPoP + 有状态会话（每账号 3 路并发），临时凭据到期前 15 分钟续。
// 声明 stateful 走会话式转发 chatSession；登录走 OAuth + PKCE（SHA-256）+ DPoP（见 codearts/oauth.cjs）。
const { makeCodeArts } = require("./codearts/management.cjs");
const codeartsDeps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs, store };
ADAPTERS.codearts = makeCodeArts(codeartsDeps);
// ===== KukuAI（百度文库「库库 AI / GenFlowPro」）=====
// 四跳链式协议（换会话三件套 → 建会话 → 分配算力 → SSE 取回），整条链装在一次 chat() 内完成。
// 登录态是百度通行证 Cookie，落 token_enc 加密存储；业务会话令牌需要本机官方客户端引擎参与换发
// （见 kuku/engine.cjs），换不到时按原凭证继续并如实提示，不假装成功。
const { makeKuku } = require("./kuku/management.cjs");
const kukuDeps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs };
ADAPTERS.kuku = makeKuku(kukuDeps);
// ===== Command Code（无状态 NDJSON 转发 + 粘贴式 API Key）=====
// 本家没有余额/签到/续期三样（适配器如实回报 unavailable/noRefresh），
// 管理面只有目录与 key 探活；模型执行在插件（NDJSON → chat 帧）。
const { makeCommandCode } = require("./commandcode/management.cjs");
const commandcodeDeps = { httpJson, rules, util, store };
if (store.COMMANDCODE_ENABLED) ADAPTERS.commandcode = makeCommandCode(commandcodeDeps);
// ===== OfficeAce 果办（华为云）：OpenAI 兼容 + 两层凭证 =====
// 网关 Basic 凭据不过期（转发用），控制面 AK/SK 约 2 小时（额度/签到用）。
const { makeOfficeAce } = require("./officeace/management.cjs");
const officeaceDeps = { httpJson, rules, util, store };
if (store.OFFICEACE_ENABLED) ADAPTERS.officeace = makeOfficeAce(officeaceDeps);
// ===== AtomCode（AtomGit / GitCode）：OpenAI 兼容 + 轮询式 OAuth =====
// 额度口径是「每窗口调用次数」；所谓签到是领取免费 CodingPlan（Max → Pro → Lite 级联）。
const { makeAtomCode } = require("./atomcode/management.cjs");
const atomcodeDeps = { httpJson, rules, util, store };
if (store.ATOMCODE_ENABLED) ADAPTERS.atomcode = makeAtomCode(atomcodeDeps);
// ===== 会话式 / 自有多步协议三渠道 =====
// orcaterm（两步有状态）/ astudio（Responses）/ doubaowork（自家信封 + Cookie）。
// 管理面只做账号、目录、额度、签到；模型执行全在插件（各自做帧翻译）。
const { makeOrcaTerm } = require("./orcaterm/management.cjs");
const { makeAStudio } = require("./astudio/management.cjs");
const { makeDoubaoWork } = require("./doubaowork/management.cjs");
if (store.SESSION_CHANNELS_ENABLED) {
    ADAPTERS.orcaterm = makeOrcaTerm({ httpJson, rules, util, store });
    ADAPTERS.astudio = makeAStudio({ httpJson, rules, util, store });
    ADAPTERS.doubaowork = makeDoubaoWork({ httpJson, rules, util, store });
}
// ===== Kiro / Antigravity：二进制帧与 Google 信封 =====
// 两家的响应都不是 chat SSE（AWS event stream / Gemini 信封），插件各自做翻译层；
// 管理面只做账号、续期与「不适用」的如实回报。
const { makeKiro } = require("./kiro/management.cjs");
const { makeAntigravity } = require("./antigravity/management.cjs");
if (store.BINARY_PROTOCOL_ENABLED) {
    ADAPTERS.kiro = makeKiro({ httpJson, rules, util, store });
    ADAPTERS.antigravity = makeAntigravity({ httpJson, rules, util, store });
}
// ===== MonkeyCode 双站（国内版 / 国际版）=====
// 同套协议、两个站点：建任务（HTTP）+ 任务流（WebSocket 上的 ACP 事件）。与 qoder/autoclaw/accio
// 双区同款手法——一个工厂按渠道 id 参数化，站点身份的唯一事实来源在 monkeycode/region.cjs。
// 依赖里额外给一个 store：任务容器的镜像 id 不在登录态里，转发时按需从「最近任务」发现一次
// 并落到账号元数据；模型执行与任务流由外部反代插件负责，管理侧只提供只读事实。
const { makeMonkeyCode } = require("./monkeycode/management.cjs");
const monkeycodeDeps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs, store };
ADAPTERS.monkeycode = makeMonkeyCode("monkeycode", monkeycodeDeps);
ADAPTERS.monkeycode_intl = makeMonkeyCode("monkeycode_intl", monkeycodeDeps);
// 启动期契约校验：全员必需方法缺失在 require 阶段即抛错（fail-fast），
// 人为删掉某个适配器的 chat() 后应用启动即崩在明面上，而不是运行期才 404/TypeError
for (const [channel, ad] of Object.entries(ADAPTERS))
    assertAdapterContract(channel, ad);
function get(channel) {
    // 内置渠道查静态表，未命中再试动态实例化的提供商（ADAPTERS 本身保持只含内置，
    // 那让 modelOwners 的裸名归属判定完全留给内置渠道，见那里的注释）
    return ADAPTERS[channel] || compatAdapter(channel) || null;
}
/** 渠道适配器声明的原始模型 id。
 * 管理页配置反向映射时必须使用这份清单，不能从 mergedModels.sources 反推：
 * mergedModels 会把统一请求名注入映射渠道，反推会让统一名自身混入“实际模型”候选。 */
function channelModelIds(channel) {
    const ad = get(channel);
    if (!ad)
        return [];
    const out = [];
    for (const value of ad.models()) {
        const id = String(value || "").trim();
        if (id && !out.some((item) => item.toLowerCase() === id.toLowerCase()))
            out.push(id);
    }
    return out;
}
function reverseAliasEntry(model, cfg) {
    const rev = (cfg || proxyConfig()).modelReverseAliases || {};
    const direct = rev[String(model || "")];
    if (direct && typeof direct === "object")
        return direct;
    const lower = String(model || "").toLowerCase();
    for (const [key, value] of Object.entries(rev)) {
        if (key.toLowerCase() === lower && value && typeof value === "object")
            return value;
    }
    return null;
}
/** 反向映射的渠道目标。自映射只有在目标不是该渠道原生模型时才是脏配置：
 * 候选来自渠道原始目录，此时「统一名 == 实际模型」说明统一名就是该渠道真实模型名，
 * 恒等映射合法；非原生的同名目标仍返回 null，防止虚拟名透传上游（issue #145）。 */
function reverseAliasTarget(model, channel, cfg) {
    const entry = reverseAliasEntry(model, cfg);
    if (!entry)
        return null;
    const raw = entry[channel];
    if (typeof raw !== "string" || !raw.trim())
        return null;
    const target = raw.trim();
    const same = target.toLowerCase() === String(model || "").trim().toLowerCase();
    return same && !nativeModel(channel, target) ? null : target;
}
function nativeModel(channel, model) {
    const ad = get(channel);
    const lower = String(model || "").trim().toLowerCase();
    return !!ad && lower !== "" && ad.models().some((item) => String(item).toLowerCase() === lower);
}
/** 模型在某渠道上的实际可转发名。
 * 该渠道显式配了反向映射时，只认映射结果；空映射/非原生自映射不得再回退成“原生模型”，
 * 否则历史脏目录里恰好混入统一名时，仍可能把虚拟名发给上游。
 * 原生模型的恒等映射是合法目标（统一名就是该渠道真实模型名，issue #145）。
 * 未配该渠道映射时，原生模型名可继续作为合法目标（保留 issue #78 的跨渠道备选）。 */
function resolveModelTarget(model, channel, cfg) {
    const normalized = String(model || "").trim();
    if (!normalized || !get(channel))
        return null;
    const entry = reverseAliasEntry(normalized, cfg);
    if (entry && Object.prototype.hasOwnProperty.call(entry, channel)) {
        return reverseAliasTarget(normalized, channel, cfg);
    }
    return nativeModel(channel, normalized) ? normalized : null;
}
// ===== 刷新并发互斥（single-flight） =====
// 上游 refreshToken 是轮换语义（实测：旧 refreshToken 可能一次性失效）：
// 并发 401 各自拿同一个旧 token 刷，后发者必然失败并把好号误判 relogin。
// 按账号收敛为单飞——并发调用共享同一个 promise，成功者写库，其余复用结果
const refreshInflight = new Map();
function refreshTokenLocked(channel, account, secrets, extraOrigins) {
    const ad = get(channel);
    if (!ad)
        return Promise.resolve({ ok: false, message: `未知渠道 ${channel}` });
    const key = `${channel}:${(account && (account.id || account.uid)) || ""}`;
    const inflight = refreshInflight.get(key);
    if (inflight)
        return inflight;
    const p = Promise.resolve()
        .then(() => ad.refreshToken(account, secrets, extraOrigins))
        .finally(() => refreshInflight.delete(key));
    refreshInflight.set(key, p);
    return p;
}
/** 合并模型目录（/v1/models）：canonical id 归并 + 来源标记 + 反向映射融合 + 自定义参数覆盖 + 目录元数据（倍率/能力/上下文） */
function mergedModels(cfg) {
    const c = cfg || proxyConfig();
    const seen = new Map();
    const catMaps = {};
    for (const channel of Object.keys(ADAPTERS))
        catMaps[channel] = catalogMap(channel);
    // 提供商的模型清单也铺成同一种 catalog 形状：下面那条共用的富化循环因此认得它们，
    // 不必为自建渠道再写第二套 name/rate/capabilities/上限的填法（抄第二遍必然漂）
    for (const row of store.channelList()) {
        if (row.kind === "builtin")
            continue;
        catMaps[row.id] = providerCatalogMap(row);
    }
    for (const [channel, ad] of Object.entries(ADAPTERS)) {
        for (const m of ad.models()) {
            const id = String(m);
            const cur = seen.get(id.toLowerCase());
            if (cur) {
                if (!cur.sources.includes(channel))
                    cur.sources.push(channel);
            }
            else {
                seen.set(id.toLowerCase(), { id, object: "model", created: 0, owned_by: channel, sources: [channel] });
            }
        }
    }
    // 反向映射：统一请求模型名注入合并目录，拥有各映射渠道的 sources
    const rev = c.modelReverseAliases || {};
    for (const [unifiedId, chMap] of Object.entries(rev)) {
        if (!unifiedId || !chMap || typeof chMap !== "object")
            continue;
        const lowerUnified = unifiedId.toLowerCase();
        const mappedSources = Object.keys(chMap).filter((ch) => get(ch) && reverseAliasTarget(unifiedId, ch, c));
        if (!mappedSources.length)
            continue;
        const existing = seen.get(lowerUnified);
        if (existing) {
            existing.id = unifiedId; // 使用用户定义的统一请求名字面形态
            for (const ch of mappedSources) {
                if (!existing.sources.includes(ch))
                    existing.sources.push(ch);
            }
        }
        else {
            seen.set(lowerUnified, {
                id: unifiedId,
                object: "model",
                created: 0,
                owned_by: mappedSources[0] || "custom",
                sources: [...mappedSources],
            });
        }
    }
    // 自定义提供商的模型**只以 slug/model 出现**，绝不列出裸名：这是防静默遮蔽的结构保证——
    // 用户建一个名叫 claude-sonnet-5 的提供商，也不会让 /v1/models 里多出第二条同名裸条目去顶掉内置池。
    // 元数据不在这里填，交给下面那条与内置渠道共用的富化循环（catMaps 里有它们的条目）。
    for (const row of store.channelList()) {
        if (row.kind === "builtin")
            continue;
        for (const e of compatModelEntries(row)) {
            const id = `${row.id}/${e.client}`;
            if (seen.has(id.toLowerCase()))
                continue;
            seen.set(id.toLowerCase(), { id, object: "model", created: 0, owned_by: row.id, sources: [row.id] });
        }
    }
    for (const entry of seen.values()) {
        entry.name = entry.id;
        entry.rate = null;
        entry.capabilities = {};
        entry.contextLength = 0;
        entry.maxOutputTokens = 0;
        // 多源模型按来源顺序取第一个有值条目（catalog 顺序即渠道优先级）
        for (const channel of entry.sources) {
            let lookupId = entry.id;
            let revMap = rev[entry.id];
            if (!revMap) {
                const lowerId = entry.id.toLowerCase();
                for (const [rk, rv] of Object.entries(rev)) {
                    if (rk.toLowerCase() === lowerId) {
                        revMap = rv;
                        break;
                    }
                }
            }
            if (revMap) {
                const mapped = reverseAliasTarget(entry.id, channel, c);
                if (mapped)
                    lookupId = mapped;
            }
            const meta = catMaps[channel].get(lookupId.toLowerCase()) || catMaps[channel].get(entry.id.toLowerCase());
            if (!meta)
                continue;
            if (meta.name && meta.name !== entry.id && entry.name === entry.id)
                entry.name = String(meta.name);
            if (entry.rate == null && meta.rate != null && !Number.isNaN(Number(meta.rate)))
                entry.rate = Number(meta.rate);
            // images 走 OR（任一来源支持即支持），避免单渠道的 false 污染共享模型名；其余能力沿用后者覆盖
            entry.capabilities = mergeCapabilities(entry.capabilities, meta.capabilities);
            // 数值上限取各来源的**最大声明**：渠道的占位值不得压低另一渠道的真实声明。
            // 例：Trae 目录曾对所有模型硬编码占位 131072（v1.41.2 起改取目录真实限额 traeLimits），
            // 而 GLM-5.3 的真实窗口是 1000000（workbuddy / workbuddy_ai / zcode 均如此声明），
            // 按"先到先得"会被 Trae 顶成 131072。
            // 这两个字段只用于 /v1/models 展示，请求路径各适配器用自己的 meta 兜底，故取最大值安全。
            const ctxN = Number(meta.contextLength) || 0;
            if (ctxN > entry.contextLength)
                entry.contextLength = ctxN;
            const outN = Number(meta.maxOutputTokens) || 0;
            if (outN > entry.maxOutputTokens)
                entry.maxOutputTokens = outN;
        }
    }
    // 自定义参数（modelCustom）：覆写 contextLength、maxOutputTokens、reasoning 能力
    const customMap = c.modelCustom || {};
    for (const entry of seen.values()) {
        let cust = customMap[entry.id];
        if (!cust) {
            const lower = entry.id.toLowerCase();
            for (const [k, v] of Object.entries(customMap)) {
                if (k.toLowerCase() === lower) {
                    cust = v;
                    break;
                }
            }
        }
        if (cust && typeof cust === "object") {
            if (typeof cust.contextLength === "number" && cust.contextLength > 0) {
                entry.contextLength = cust.contextLength;
            }
            if (typeof cust.maxOutputTokens === "number" && cust.maxOutputTokens > 0) {
                entry.maxOutputTokens = cust.maxOutputTokens;
            }
            if (cust.reasoningEffort) {
                if (cust.reasoningEffort === "off") {
                    entry.capabilities = { ...entry.capabilities, reasoning: false };
                }
                else {
                    entry.capabilities = { ...entry.capabilities, reasoning: true };
                }
            }
        }
    }
    return [...seen.values()];
}
/** 模型 → 渠道归属：返回拥有该模型的渠道列表（模型完全不存在 → 空数组）。
 *  **只算内置渠道**（ADAPTERS 静态表）：自定义提供商的归属走 provider.parseModelRef() 的 slug/ 前缀
 *  （或 allowBareProviderModel 的兜底），两者都在本函数之外——把提供商掺进来就等于让一个裸名可能
 *  同时属于内置池和某个中转站，那时"谁赢"就必须靠优先级配置回答，而这里刻意不给它那个可能。
 *  反向映射命中的渠道**排在最前**，其后追加目录里同名 id 的渠道（去重、保序）：反向映射只表达
 *  「这个渠道上该用哪个模型名」，不该顺手把跨渠道自救的备选集合收窄成映射里写的那几个——
 *  原实现命中即 return，用户一旦给某模型配了反向映射，它的备选就只剩映射里的渠道（issue #78）。 */
function modelOwners(model, cfg) {
    const c = cfg || proxyConfig();
    const rev = c.modelReverseAliases || {};
    const lower = String(model || "").toLowerCase();
    const mapped = [];
    const entry = reverseAliasEntry(model, c);
    // channelOn 过滤（与目录循环 4114 同口径）：反向映射命中的已关闭渠道不算归属——
    // 否则统一请求名的唯一归属/固定策略可把请求强制打进已关闭渠道
    if (entry)
        mapped.push(...Object.keys(entry).filter((ch) => get(ch) && channelOn(ch, c) && reverseAliasTarget(model, ch, c)));
    const out = [];
    const seen = new Set();
    for (const ch of mapped) {
        if (seen.has(ch))
            continue;
        seen.add(ch);
        out.push(ch);
    }
    for (const [channel, ad] of Object.entries(ADAPTERS)) {
        if (seen.has(channel))
            continue;
        // 关闭的渠道不算归属：单源模型也判「不可用」（resolveChannel 拿到空列表 → 400 给可用模型提示），
        // 多源模型自动收窄到启用渠道（故障转移备选同步收窄，路由打分与备选队列全走这里）
        if (!channelOn(channel, c))
            continue;
        if (ad.models().some((m) => String(m).toLowerCase() === lower)) {
            seen.add(channel);
            out.push(channel);
        }
    }
    return out;
}
/** /v1/models 对外可列模型：合并视图减去 disabledModels（口径与请求路径 400 拦截一致）。
 * 只供对外 HTTP 出口用；管理页 proxy_models 仍走 mergedModels 全量 + enabled 标志，否则停用模型无法恢复。 */
function listableModels(cfg) {
    const c = cfg || proxyConfig();
    const disabled = c.disabledModels || [];
    const off = new Set((disabled || []).map((s) => String(s).toLowerCase()));
    const on = (ch) => channelOn(ch, c);
    return mergedModels(c)
        .filter((m) => (m.sources || []).some(on)) // 全源渠道都被关闭的模型不对外暴露（客户端不再看到）
        .filter((m) => !off.has(m.id.toLowerCase()));
}
/** 双表一致性报告（CHANNELS ↔ ADAPTERS）：两向差集非空即自测失败（tools/proxy-smoke.cjs 断言）。
 *  只从 CHANNELS 移除而留 ADAPTERS，会让模型被判「双区共有」并路由到无账号的渠道；
 *  只加 ADAPTERS 不加 CHANNELS，会让渠道有适配器却不出现在任何 UI/健康检查/池同步校验里 */
function consistencyReport() {
    const chanIds = new Set(store.CHANNELS.map((c) => c.id));
    const adIds = new Set(Object.keys(ADAPTERS));
    return {
        channelsWithoutAdapter: [...chanIds].filter((id) => !adIds.has(id)),
        adaptersWithoutChannel: [...adIds].filter((id) => !chanIds.has(id)),
    };
}
module.exports = { get, ADAPTERS, modelMetadata, channelModelIds, reverseAliasEntry, resolveModelTarget, mergedModels, listableModels, modelOwners, channelOn, httpJson, refreshTokenLocked, setPendingCaptcha, getPendingCaptcha,
    // 自定义提供商：动态实例化的通用 OpenAI 兼容适配器（provider.cjs 的探测与自测直用这一支）
    makeOpenaiCompat, compatUrl, statusFromCompatError, compatModelEntries,
    // 适配器契约（启动期校验 + 自测复验用）
    REQUIRED_ADAPTER_METHODS, assertAdapterContract, consistencyReport,
    // ModelScope 续期实现注入（避免 adapters ↔ discovery 循环依赖；由 index.cjs 启动时注入）
    setModelScopeRefresh, // 供自测校验首字节预算随 prompt 规模增长（修"大 prompt 被 30s 误杀→熔断 30 分钟"）
    firstByteBudgetMs, estimateInputTokens, FIRST_BYTE_MS, FIRST_BYTE_MAX_MS,
    // 供自测校验模态识别（通用嗅探 / 能力合并 OR 语义）
    sniffImages, mergeCapabilities,
    // 供自测校验模型上限归一化（缺失/非法 → 0，绝不编造）与 trae 目录结构解析
    tokenLimit, traeLimits,
    // 供自测校验「逐包积分」的三条映射（到期日历的数据源）：都是纯函数，喂合成样本即可，不出网
    traeCredits, zcodeCreditPackages, lobsterCreditPackages, parseWbResource,
    // 供自测校验「首个 SSE 事件必须解除首字节预算」（issue #107：漏解除 → 长回答被 30s 掐断）：
    // 自测用真 fetchStream + 真 pumpSse + 缩短的 firstByteBudgetMs + 假上游复现现场
    fetchStream, pumpSse,
    // 设备指纹派生（discovery.cjs 的 OAuth/导入路径复用同一套熵更高的算法，避免弱独立实现）
    deviceIds };
