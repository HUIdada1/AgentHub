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
const credentials = require("./credentials.cjs");
const models = require("./models.cjs");
const balance = require("./balance.cjs");
const welfare = require("./welfare.cjs");
function makeCodeArts(deps) {
    const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs, store } = deps;
    const cfg = () => (rules.get("headers.json") || {}).codearts || {};
    const channel = "codearts";
    // 解析 catalog.json 的 codearts 段为目录数组（含 source / 元数据）
    function catalogEntries() {
        try {
            const file = `${rules.rulesDir()}/catalog.json`;
            const all = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
            const entry = all && all[channel];
            return entry && Array.isArray(entry.models) ? entry.models : [];
        }
        catch {
            return [];
        }
    }
    /** 上游基址：签名、Host 与各调用点都取同一份（headers.json 可覆盖） */
    const baseOf = () => String(cfg().base || "https://snap-access.cn-north-4.myhuaweicloud.com").replace(/\/+$/, "");
    /** 续期拿到的新凭据必须回写账号记录：不回写时进程重启后仍拿旧 AK/SK 打上游，
     *  而 refresh token 已被轮换（同一 token 只能换一次）→ 该账号只能重新登录。 */
    function persist(account, fresh) {
        if (!fresh || !fresh.refreshed || !fresh.fields || !account || !account.id)
            return;
        try {
            store.updateAccount(account.id, fresh.fields);
        }
        catch { /* 落盘失败不阻断本次请求：手上这份凭据还能用 */ }
    }
    /** 统一的凭据取用：临期主动续期 + 回写，调用点不必各自记着这一步 */
    async function credentialOf(account, secrets, force) {
        const fresh = await credentials.ensureFresh(account, secrets, !!force);
        if (fresh.ok)
            persist(account, fresh);
        return fresh;
    }
    return {
        id: channel,
        cfg,
        // Host-only accessors reuse the original credential parser/window/persistence.
        readForwardCredentials(account, secrets) {
            return { ...secrets, signing: credentials.credentialFrom(account, secrets) };
        },
        readForwardContext(account) {
            return { maxConcurrent: Number(account?.maxConcurrent) || 0 };
        },
        async ensureForwardCredentials(account, secrets, force = false) {
            const fresh = await credentials.ensureFresh(account, secrets, !!force);
            if (!fresh.ok) return null;
            const row = store.getAccount(account.id);
            if (!row || row.uid !== account.uid) return null;
            const current = store.accountSecrets(row);
            const sameInput = current.token === secrets.token && current.refreshToken === secrets.refreshToken;
            const alreadySaved = !!fresh.refreshed && current.token === fresh.fields?.token && current.refreshToken === fresh.fields?.refreshToken;
            if ((!sameInput && !alreadySaved) || JSON.stringify(current.meta) !== JSON.stringify(secrets.meta)) return null;
            if (!alreadySaved) persist(account, fresh);
            return { ...secrets, ...fresh.fields, signing: fresh.credential };
        },
        models() {
            return catalogEntries().map((m) => m.id);
        },
        modelEntries() {
            return catalogEntries();
        },
        readForwardModels() {
            return catalogEntries().map(entry => ({ id: entry.id, name: entry.name, source: entry.source, images: entry.capabilities?.images === true }));
        },
        // 拉模型目录（三源合并，见 models.cjs）；写回 catalog.json 的 codearts 段
        async fetchModels(account, secrets, opts) {
            const c = cfg();
            const base = String(c.base || "https://snap-access.cn-north-4.myhuaweicloud.com").replace(/\/+$/, "");
            const fresh = await credentials.ensureFresh(account, secrets, false);
            if (!fresh.ok)
                return { ok: false, message: fresh.message };
            const credential = fresh.credential;
            if (!credentials.valid(credential))
                return { ok: false, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
            const warnings = [];
            const getCatalog = (urlBase, route, agentType = "AgentCenter", benefit = false) => models.signedJson(
                credential, urlBase, "GET", route, undefined, undefined,
                { catalog: true, agentType, pluginVersion: c.pluginVersion, language: c.language,
                  hostSigned: benefit, domainless: benefit });
            const agentModels = [], seenAgents = new Set();
            try {
                // Same pagination as the reference; a repeated page must not loop forever.
                for (let page = 0; page < 100; page++) {
                    opts?.assertCurrent?.();
                    const list = await getCatalog(base, `/v1/agent-center/agents/useragents?offset=${page * 100}&limit=100&is_primary_agent=true&supported_client=VSCODE&min_compatible_plugin_version=${encodeURIComponent(c.pluginVersion || "26.9.101")}`);
                    if (!list.ok || !Array.isArray(list.data?.agents)) throw new Error("agent catalog unavailable");
                    const agents = list.data.agents;
                    let added = 0;
                    for (const agent of agents) {
                        const id = agent?.agent_id || agent?.original_id;
                        if (!id || seenAgents.has(id)) continue;
                        seenAgents.add(id); added++;
                        const detail = await getCatalog(base, `/v1/agent-center/agents/detail?agent_id=${encodeURIComponent(id)}`);
                        if (!detail.ok) { warnings.push("agent-detail"); continue; }
                        for (const m of detail.data?.gpts?.models || []) {
                            const parameters = m.model_parameters || {};
                            if (parameters.enabled === false) continue;
                            agentModels.push({ ...parameters,
                                id: parameters.model_id || m.model_alias || m.model_id || m.modelId || m.id,
                                name: m.model_name || m.name });
                        }
                    }
                    if (agents.length < 100 || !added) break;
                    if (page === 99) warnings.push("agent-pagination-limit");
                }
            } catch { warnings.push("agent"); }
            const builtinModels = [];
            try {
                const response = await getCatalog(base, "/v1/model/builtin", "PromptCenter");
                const data = response.data;
                const list = data?.builtinModels || data?.models || (Array.isArray(data) ? data : null);
                if (!response.ok || !Array.isArray(list)) throw new Error("builtin catalog unavailable");
                for (const m of list) if (m.enable !== false) {
                    builtinModels.push({ ...m, id: m.model_id || m.id || m.model_name, name: m.model_name || m.name });
                }
            } catch { warnings.push("builtin"); }
            const benefitModels = [];
            try {
                const sw = await getCatalog(base, "/v1/benefit-gateway-config");
                if (!sw.ok || typeof sw.data?.enabled !== "boolean") throw new Error("benefit gate unavailable");
                if (sw.data.enabled) {
                    const gateway = String(c.benefitGatewayUrl || "https://opengw.developer.huaweicloud.com").replace(/\/+$/, "");
                    const bg = await getCatalog(gateway, "/api/v1/gateway/config", "", true);
                    if (!bg.ok || bg.data?.error_code !== "0000" || !Array.isArray(bg.data?.result?.models)) throw new Error("benefit catalog unavailable");
                    const list = [...bg.data.result.models].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
                    for (const m of list) benefitModels.push({ ...m, id: m.model_id || m.id, name: m.model_name || m.name });
                }
            } catch { warnings.push("benefit"); }
            const merged = models.mergeCatalog(agentModels, builtinModels, benefitModels);
            if (!merged.length)
                return { ok: false, message: "CodeArts 三个目录源都为空（trial 账号可能无模型，不兜底）" };
            opts?.assertCurrent?.();
            // The refresh coordinator validates the account and atomically persists all channels.
            return { ok: true, models: merged, added: merged.length, count: merged.length, partial: warnings.length > 0, warnings: [...new Set(warnings)] };
        },
        // 额度查询：两份账（订阅统计 + 福利池），见 balance.cjs
        async queryCredits(account, secrets) {
            const fresh = await credentialOf(account, secrets, false);
            if (!fresh.ok)
                return { authError: true, message: fresh.message };
            const credential = fresh.credential;
            if (!credentials.valid(credential))
                return { authError: true, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
            const c = cfg();
            try {
                return await balance.queryBalance(baseOf(), credential, {
                    language: c.language,
                    pluginVersion: c.pluginVersion,
                    benefitGatewayUrl: c.benefitGatewayUrl,
                });
            }
            catch (e) {
                if (e && e.authError)
                    return { authError: true, message: e.message };
                return { error: String((e && e.message) || e) };
            }
        },
        // 每日福利（三段式：领取 → 确认 → 回读核实，见 welfare.cjs）。
        // 本家没有独立签到接口，签到中心那一行就是这条每日福利
        async claimWelfare(account, secrets) {
            const fresh = await credentialOf(account, secrets, false);
            if (!fresh.ok)
                return { ok: false, message: fresh.message };
            const credential = fresh.credential;
            if (!credentials.valid(credential))
                return { ok: false, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
            return welfare.claimWelfare(baseOf(), credential, store, account);
        },
        async checkin(account, secrets) {
            return this.claimWelfare(account, secrets);
        },
        async checkinStatus(account, secrets) {
            // 没有「今日是否已签」的上游查询：活动列表里的 CONFIRMED 不带确认日期（上一期的会一直显示到今天），
            // 故只回本地台账口径，让界面照实说「签到即领取每日福利」
            const ledger = (account && account.meta && account.meta.welfareLedger) || null;
            const attempts = ledger && ledger.day === welfare.todayKey() ? ledger.attempts : 0;
            return {
                ok: true,
                checkedIn: false,
                message: attempts
                    ? `CodeArts 无独立签到查询：今日已发起过福利领取（${attempts} 次）`
                    : "CodeArts 无独立签到查询：签到即领取每日福利（领取入口在号池页）",
            };
        },
        // 只读探测：界面在领取前先看清有什么可领（写请求仍然只有 claim 一条路）
        async previewWelfare(account, secrets) {
            const fresh = await credentialOf(account, secrets, false);
            if (!fresh.ok)
                return { ok: false, message: fresh.message };
            if (!credentials.valid(fresh.credential))
                return { ok: false, message: "CodeArts 账号缺少可用的临时凭据，请重新登录" };
            return welfare.previewWelfare(baseOf(), fresh.credential, account);
        },
        // 续期：提前 15 分钟、凭据整块回写。返回通用形态（token/refreshToken）交给编排层的
        // 单飞与落库路径——CodeArts 的凭据是一整块，故 token 列存的是整块 JSON（见 credentials.cjs）
        async refreshToken(account, secrets) {
            const fresh = await credentialOf(account, secrets, true);
            if (!fresh.ok)
                return { ok: false, message: fresh.message };
            return { ok: true, ...fresh.fields };
        },
    };
}
module.exports = { makeCodeArts };
