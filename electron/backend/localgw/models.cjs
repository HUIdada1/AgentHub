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
// 本地网关模型绑定与对外目录。
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
  const withAcc = new Set(routing.channelsWithAccounts());
  const out = [];
  const metadata = new Map();
  for (const m of adapters.listableModels()) {
    for (const channel of m.sources || []) {
      if (!withAcc.has(channel) || !routing.isChannelEnabled(channel) || !adapters.channelOn(channel)) continue;
      const realModel = adapters.resolveModelTarget(m.id, channel) || m.id;
      out.push({ id: m.id, display: m.id, channel, realModel, source: "channel", ...adapters.modelMetadata(realModel, channel, metadata) });
    }
  }
  return out;
}

/** 某渠道的原生模型清单（「覆盖与自定义」表单里「实际模型名」下拉的数据源）。
 *
 *  为什么不拿 list() 过滤渠道代替：list() 是**对外合并视图**——同名模型被 overrides / custom
 *  抢先接管后，原渠道那一行就不再出现（bindings() 对同名只回一张绑定），拿它反推某渠道的模型
 *  会漏项。这里直接读该渠道适配器的原生目录，回答的是「这个渠道实际能用哪些模型名」。
 *
 *  口径与 list() 对齐：
 *   · realModel 用 resolveModelTarget() 的命中值 —— localgw 转发是把 real_model 原样交给
 *     adapter.chat()，所以下拉里给出的必须是这个名字，而不是渠道客户端名；
 *   · 停用模型（proxy.disabledModels）剔除 —— bindings() 判定绑到停用模型的规则不生效；
 *   · 只读，且不看渠道当前是否启用/有账号：本函数只回答「有哪些模型」，能不能路由是路由层的事
 *     （渠道下拉里能选到无账号渠道，选中后就该看到它的目录，而不是一个无解释的空下拉）。 */
function channelModelList(channel) {
  const ch = String(channel || "").trim();
  if (!ch) return [];
  const proxy = (config.loadConfig() || {}).proxy || {};
  const disabled = new Set((proxy.disabledModels || []).map((m) => String(m).toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const id of adapters.channelModelIds(ch)) {
    const realModel = adapters.resolveModelTarget(id, ch) || id;
    const key = String(realModel || "").toLowerCase();
    if (!key || disabled.has(key) || seen.has(key)) continue;
    seen.add(key);
    // id 是渠道目录里的条目名（覆盖/自定义的「对外名」默认建议值），realModel 才是发上游的名字
    out.push({ id, realModel });
  }
  return out;
}

function bindings(model, visited = new Set(), snapshot) {
  const name = String(model || "").trim();
  if (!name || visited.has(name)) return [];
  const proxy = snapshot?.proxy || config.loadConfig()?.proxy || {};
  if ((proxy.disabledModels || []).some((m) => String(m).toLowerCase() === name.toLowerCase())) return [];
  visited.add(name);
  const c = snapshot?.config || lgwConfig.get();
  const base = snapshot?.base || channelModels();
  const d = c.models.custom?.[name] || c.models.overrides?.[name];
  if (d && typeof d === "object") {
    const target = d.real_model || name;
    if ((proxy.disabledModels || []).some((m) => String(m).toLowerCase() === String(target).toLowerCase())) return [];
    const channel = d.channel || c.models.modelDefaultChannel;
    if (channel) return adapters.channelOn(channel) && routing.isChannelEnabled(channel) ? [{ id: name, display: name, channel, realModel: target, source: c.models.custom?.[name] ? "custom" : "override", ...adapters.modelMetadata(target, channel) }] : [];
    return base.filter((m) => m.id === target).map((m) => ({ ...m, id: name, display: name, source: "override" }));
  }
  if (c.models.disabledAliases?.includes(name)) return [];
  const alias = c.models.aliases?.[name];
  if (typeof alias === "string") return bindings(alias, visited, { proxy, config: c, base }).map((m) => ({ ...m, id: name, display: name, source: "alias" }));
  return base.filter((m) => m.id.toLowerCase() === name.toLowerCase());
}

function list() {
  const c = lgwConfig.get();
  const base = channelModels();
  const names = new Set(base.map((m) => m.id));
  for (const table of [c.models.overrides, c.models.aliases, c.models.custom]) {
    for (const name of Object.keys(table || {})) names.add(name);
  }
  const snapshot = { base, config: c, proxy: config.loadConfig()?.proxy || {} };
  return [...names].flatMap((name) => bindings(name, new Set(), snapshot));
}

function resolve(model, channel) {
  const rows = bindings(model);
  return channel ? rows.find((m) => m.channel === channel) || null : rows[0] || null;
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

module.exports = { list, channelModelList, bindings, resolve, setOverride, setAlias, addCustom, removeRule };
