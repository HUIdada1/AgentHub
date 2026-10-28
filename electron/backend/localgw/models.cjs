/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 模型目录
// 合并四源：渠道适配器清单 + models.overrides + models.aliases + models.custom。
// 与号池的 proxy.modelOverrides / modelAliases 是两套独立配置：号池那套是"网关内部转发映射"，
// 本模块这套是"对外暴露给客户端的模型名"——刻意分开，用户可以只改对外可见名而不影响号池。
// 【口径说明·审查修正】原注释声称本模块会过滤 display_name 为空 / is_invisible_to_user /
// config_switch=false 的内部模型——实际并不会：adapters.ADAPTERS[ch].models() 返回的是
// string[] 纯模型名，那些字段级的可见性过滤由号池的 discovery/adapters 侧负责。
// 本模块只做三件事：空名剔除、同渠道去重、按 override/alias/custom 改名。注释已按事实改正。
"use strict";
const lgwConfig = require("./config.cjs");
const config = require("../config.cjs");
const adapters = require("../proxy/adapters.cjs");
const routing = require("./routing.cjs");

/** 从号池渠道与适配器读模型清单（只读；失败时降级为空）。
 *  模型归属：逐渠道 adapters.ADAPTERS[ch].models()（静态兜底 + discovery 更新后的最新目录），
 *  只展示号池已有账号（status online/cooling）的渠道，与决策 1 默认启集同口径；
 *  同名模型多渠共存时，以号池已配置渠道优先（routing.pick 候选集内最靠前的一个）。 */
function channelModels() {
  const out = [];
  const seen = new Set();
  try {
    const withAcc = new Set(routing.channelsWithAccounts());
    for (const [ch, ad] of Object.entries(adapters.ADAPTERS || {})) {
      if (!withAcc.has(ch)) continue;
      let ms = [];
      try { ms = typeof ad.models === "function" ? ad.models() : []; } catch { /* 渠道适配器炸了不拖垮整个目录 */ }
      for (const name of ms || []) {
        const id = String(name || "").trim();
        if (!id) continue;
        const key = `${ch}::${id}`;
        if (seen.has(key)) continue; // 适配器清单里重复项（同一模型两种写法）只留一条
        seen.add(key);
        out.push({ id, display: id, channel: ch, realModel: id, source: "channel" });
      }
    }
  } catch {
    /* 号池未起或未接入：返回空列表，页面显示"暂无模型"而不是报错 */
  }
  return out;
}

/** 合并视图：应用 overrides / aliases / custom 后的最终对外目录
 *  冲突优先级（对外可见名相同时）：channel 原始 < overrides < custom，
 *  aliases 单独占一个"别名"命名空间（它的 from 是新名字，通常与渠道模型不同名）。 */
function list() {
  const c = lgwConfig.get();
  const base = channelModels();
  const seen = new Set();
  const out = [];

  // 1) 渠道模型（被 override 的用实际模型名替换）
  for (const m of base) {
    const ov = c.models.overrides[m.display] || c.models.overrides[m.id];
    const channel = ov && ov.channel ? ov.channel : m.channel;
    const key = `${channel}::${m.display}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: m.id,
      display: m.display,
      channel,
      realModel: ov && ov.real_model ? ov.real_model : m.realModel,
      source: ov ? "override" : "channel",
    });
  }

  // 2) overrides 里指向不存在模型的（用户手填的）也要出现
  for (const [model, ov] of Object.entries(c.models.overrides || {})) {
    if (!ov || typeof ov !== "object") continue; // 手改 config 写坏的条目直接跳过，不让它污染目录
    const channel = ov.channel || c.models.modelDefaultChannel || "";
    const key = `${channel}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: model, display: model, channel, realModel: ov.real_model || model, source: "override" });
  }

  // 3) aliases：别名 → 目标模型（对外暴露别名，实际打目标）
  for (const [from, to] of Object.entries(c.models.aliases || {})) {
    if (typeof to !== "string" || !to) continue;
    const target = base.find((m) => m.display === to || m.id === to);
    const key = `${target ? target.channel : "alias"}::${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: from,
      display: from,
      channel: target ? target.channel : c.models.modelDefaultChannel || "",
      realModel: target ? target.realModel : to,
      source: "alias",
    });
  }

  // 4) custom：渠道都不认识的自定义模型
  for (const [model, def] of Object.entries(c.models.custom || {})) {
    if (!def || typeof def !== "object") continue;
    const channel = def.channel || c.models.modelDefaultChannel || "";
    const key = `${channel}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: model, display: model, channel, realModel: def.real_model || model, source: "custom" });
  }

  return out;
}

/** 解析请求模型名 → { channel, realModel }；未知模型返回 null（由调用方决定 400 还是回落） */
function resolve(model) {
  const c = lgwConfig.get();
  const m = String(model || "").trim();
  if (!m) return null;

  // 顺序：custom > overrides > aliases > 渠道同名
  if (c.models.custom && c.models.custom[m] && typeof c.models.custom[m] === "object") {
    const d = c.models.custom[m];
    return { channel: d.channel || c.models.modelDefaultChannel || "", realModel: d.real_model || m };
  }
  if (c.models.overrides && c.models.overrides[m] && typeof c.models.overrides[m] === "object") {
    const d = c.models.overrides[m];
    return { channel: d.channel || c.models.modelDefaultChannel || "", realModel: d.real_model || m };
  }
  if (c.models.aliases && c.models.aliases[m]) {
    const target = c.models.aliases[m];
    // 别名链只解一层（避免 A→B→A 死循环）
    if (c.models.overrides && c.models.overrides[target] && typeof c.models.overrides[target] === "object") {
      const d = c.models.overrides[target];
      return { channel: d.channel || c.models.modelDefaultChannel || "", realModel: d.real_model || target };
    }
    const hit = channelModels().find((x) => x.display === target || x.id === target);
    if (hit) return { channel: hit.channel, realModel: hit.realModel };
    return null;
  }
  const hit = channelModels().find((x) => x.display === m || x.id === m);
  if (hit) return { channel: hit.channel, realModel: hit.realModel };
  return null;
}

/** 写 override（model 与 payload 都可能来自渲染层，必须逐字段校验，否则会写出 undefined 字段的坏配置） */
function setOverride(model, payload) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, message: "缺少模型名" };
  if (!payload || typeof payload !== "object") return { ok: false, message: "缺少覆盖配置" };
  const c = lgwConfig.get();
  const cur = { ...(c.models.overrides || {}) };
  cur[name] = { real_model: String(payload.real_model || name), channel: String(payload.channel || "") };
  const r = lgwConfig.patch({ models: { ...c.models, overrides: cur } });
  return r && r.ok === false ? { ok: false, message: r.message } : { ok: true };
}

/** 写 alias */
function setAlias(from, to) {
  const name = String(from || "").trim();
  const target = String(to || "").trim();
  if (!name || !target) return { ok: false, message: "别名与目标模型都不能为空" };
  const c = lgwConfig.get();
  const cur = { ...(c.models.aliases || {}) };
  cur[name] = target;
  const r = lgwConfig.patch({ models: { ...c.models, aliases: cur } });
  return r && r.ok === false ? { ok: false, message: r.message } : { ok: true };
}

/** 写 custom */
function addCustom(model, provider) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, message: "缺少模型名" };
  if (!provider || typeof provider !== "object") return { ok: false, message: "缺少渠道配置" };
  const c = lgwConfig.get();
  const cur = { ...(c.models.custom || {}) };
  cur[name] = { channel: String(provider.channel || ""), real_model: String(provider.real_model || name) };
  const r = lgwConfig.patch({ models: { ...c.models, custom: cur } });
  return r && r.ok === false ? { ok: false, message: r.message } : { ok: true };
}

/** 删除 overrides / aliases / custom 三张表里的单条规则。
 *
 *  为什么不能走 lgwConfig.patch 实现删除（实测结论，勿"顺手简化"）：
 *  config.cjs 的 mergeDeep 是「以 base 为骨架、只遍历 incoming 的键」的**加性**合并，
 *  提交一份"少了某个键"的表不会删掉它 —— 该键会从 base 原样存活；传 null 也不是删除
 *  （normalize 只对 outbound.headers 做 null 清理，models 三表没有这条约定，null 会被
 *  原样存下来，反而把表污染成 { "x": null }）。所以删除必须在**原始配置层**做手术：
 *  先摘掉该键，再整体 normalize 回落盘，绕开加性合并。
 *
 *  幂等：键本来就不存在时直接回 ok（连续点两次「移除」不该报错）。 */
function removeRule(kind, name) {
  const TABLES = ["overrides", "aliases", "custom"];
  if (!TABLES.includes(kind)) return { ok: false, message: `未知的模型配置表：${kind}` };
  const key = String(name || "").trim();
  if (!key) return { ok: false, message: "缺少模型名" };

  const c = config.loadConfig();
  // 与 config.patch 同款保护：读不到完整配置时宁可失败也不写，
  // 否则会把其它模块的配置整份抹掉
  if (!c || typeof c !== "object") {
    return { ok: false, message: "配置读取失败，已放弃写入以免覆盖其它模块配置" };
  }
  const m = (c.localgw && c.localgw.models) || {};
  const table = { ...(m[kind] || {}) };
  if (!(key in table)) return { ok: true }; // 幂等：已经没有了
  delete table[key];

  // 直接替换整段（不经 mergeDeep），再走一次 normalize 补全形状与纠偏
  c.localgw = lgwConfig.normalize(
    lgwConfig.mergeDeep(lgwConfig.LOCALGW_DEFAULTS, { ...(c.localgw || {}), models: { ...m, [kind]: table } })
  );
  try {
    config.saveConfig(c);
  } catch (e) {
    return { ok: false, message: `配置写入失败：${String((e && e.message) || e)}` };
  }
  return { ok: true };
}

module.exports = { list, resolve, setOverride, setAlias, addCustom, removeRule };
