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
const modelCatalog = require("./model-catalog.cjs");
const routing = require("./routing.cjs");

/** 从标准供应商或已授权就绪插件读模型清单（只读；失败时降级为空）。
 *  模型归属：逐渠道中性目录快照（标准配置或当前插件 listModels），
 *  只展示号池已有账号（status online/cooling）的渠道，与决策 1 默认启集同口径；
 *  同名模型多渠共存时，以号池已配置渠道优先（routing.pick 候选集内最靠前的一个）。 */
function channelModels(catalog = modelCatalog.view()) {
  const withAcc = new Set(routing.channelsWithAccounts());
  const out = [];
  const metadata = new Map();
  for (const m of catalog.listableModels()) {
    for (const channel of m.sources || []) {
      if (!withAcc.has(channel) || !routing.isChannelEnabled(channel) || !catalog.channelOn(channel)) continue;
      const realModel = catalog.resolveModelTarget(m.id, channel) || m.id;
      out.push({ id: m.id, display: m.id, channel, realModel, source: "channel", ...catalog.modelMetadata(realModel, channel, metadata) });
    }
  }
  return out;
}

/** 某渠道的原生模型清单（「覆盖与自定义」表单里「实际模型名」下拉的数据源）。
 *
 *  为什么不拿 list() 过滤渠道代替：list() 是**对外合并视图**——同名模型被 overrides / custom
 *  抢先接管后，原渠道那一行就不再出现（bindings() 对同名只回一张绑定），拿它反推某渠道的模型
 *  会漏项。这里读该渠道执行服务的原生目录，回答的是「这个渠道实际能用哪些模型名」。
 *
 *  口径与 list() 对齐：
 *   · realModel 使用该渠道的原生目录 id，不套用用户映射，以免下拉原生模型被覆盖规则污染；
 *   · 停用模型（proxy.disabledModels）剔除 —— bindings() 判定绑到停用模型的规则不生效；
 *   · 只读，且不看渠道当前是否启用/有账号：本函数只回答「有哪些模型」，能不能路由是路由层的事
 *     （渠道下拉里能选到无账号渠道，选中后就该看到它的目录，而不是一个无解释的空下拉）。 */
function channelModelList(channel, snapshot) {
  const catalog = snapshot?.catalog || modelCatalog.view();
  const ch = String(channel || "").trim();
  if (!ch) return [];
  const proxy = (config.loadConfig() || {}).proxy || {};
  const disabled = new Set((proxy.disabledModels || []).map((m) => String(m).toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const id of catalog.channelModelIds(ch)) {
    // Native dropdown choices must not be rewritten by a user alias/override.
    const realModel = id;
    const key = String(realModel || "").toLowerCase();
    if (!key || disabled.has(key) || seen.has(key)) continue;
    seen.add(key);
    // id 是渠道目录里的条目名（覆盖/自定义的「对外名」默认建议值），realModel 才是发上游的名字
    out.push({ id, realModel });
  }
  return out;
}

/** 渠道锁定表查找：精确优先，回落大小写不敏感。
 *  v1.82.2 的 modelOverrides 是大小写敏感的，这里刻意放宽：开源用户在不同客户端里
 *  写 "Kimi-K3" / "kimi-k3" 是常态，「锁不上」比「锁错」更让人困惑；
 *  而渠道 id 本身来自固定枚举，不存在大小写歧义。 */
function lookupChannelLock(locks, name) {
  if (!locks || typeof locks !== "object" || Array.isArray(locks)) return "";
  const exact = locks[name];
  if (typeof exact === "string" && exact) return exact;
  const lower = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(locks)) {
    if (key.toLowerCase() === lower && typeof value === "string" && value) return value;
  }
  return "";
}

/** 模型组查找：精确优先，回落大小写不敏感（与渠道锁同口径——客户端写 "Free" / "free"
 *  是常态，找不到组比找到错组更让人困惑）。返回 { key, group } 或 null。 */
function lookupGroup(groups, name) {
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) return null;
  const key = String(name || "").trim();
  if (!key) return null;
  const exact = groups[key];
  if (exact && typeof exact === "object" && Array.isArray(exact.members)) return { key, group: exact };
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(groups)) {
    if (k.toLowerCase() === lower && v && typeof v === "object" && Array.isArray(v.members)) return { key: k, group: v };
  }
  return null;
}

/** 对外名解析成模型组（别名链路也算：alias → 组）。
 *  转发层靠它决定「这是不是组请求、按哪种策略挑成员」；
 *  bindings() 里的组分支负责给出成员候选，两处必须同一优先级。 */
function groupSpec(model, snapshot) {
  const c = snapshot?.config || lgwConfig.get();
  const proxy = snapshot?.proxy || config.loadConfig()?.proxy || {};
  const requested = String(model || "").trim();
  // 对外名本身被停用时按「模型不存在」处理（404），不要说成「组没有可用成员」
  if (!requested || (proxy.disabledModels || []).some((m) => String(m).toLowerCase() === requested.toLowerCase())) return null;
  const seen = new Set();
  let name = requested;
  while (name && !seen.has(name.toLowerCase())) {
    seen.add(name.toLowerCase());
    const hit = lookupGroup(c.models.groups, name);
    if (hit) {
      return {
        name: hit.key,
        strategy: hit.group.strategy === "round-robin" ? "round-robin" : "priority",
        members: hit.group.members,
      };
    }
    const alias = c.models.aliases?.[name];
    if (typeof alias !== "string" || !alias.trim()) return null;
    name = alias.trim();
  }
  return null;
}

/** 模型倍率查找：精确优先，回落大小写不敏感。0 是合法倍率（免费档），
 *  只有「表里没有这个键」才返回 null（= 沿用目录声明）。 */
function lookupModelRate(rates, name) {
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) return null;
  const key = String(name || "").trim();
  if (!key) return null;
  if (Number.isFinite(rates[key])) return rates[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(rates)) {
    if (k.toLowerCase() === lower && Number.isFinite(v)) return v;
  }
  return null;
}

function bindings(model, visited = new Set(), snapshot) {
  const name = String(model || "").trim();
  if (!name || visited.has(name)) return [];
  const catalog = snapshot?.catalog || modelCatalog.view();
  const proxy = snapshot?.proxy || config.loadConfig()?.proxy || {};
  const isDisabled = (v) => (proxy.disabledModels || []).some((m) => String(m).toLowerCase() === String(v).toLowerCase());
  if (isDisabled(name)) return [];
  visited.add(name);
  const c = snapshot?.config || lgwConfig.get();
  const base = snapshot?.base || channelModels(catalog);
  /** 用户手填的模型倍率优先于目录声明；按「用户可见的模型名」查表。 */
  const withRate = (row, modelName) => {
    const rate = lookupModelRate(c.models.rates, modelName || row.display || row.id);
    return rate == null ? row : { ...row, rate, rateSource: "user" };
  };
  // ===== 模型组：对外名 → 多个（渠道 + 实际模型）候选 =====
  // 位置在 custom/overrides 之前、别名/渠道锁/渠道目录之前：组是「一个对外名聚合多模型」
  // 的显式声明，组成员自带渠道和上游名，比别名（单目标）与渠道目录（隐式）更强。
  // setGroup / setOverride / addCustom / setAlias 都会拒绝与组重名，正常配置里不会出现
  // 两套规则抢同名；手改 config.json 造成重名时以组为准（组是更晚引入、更明确的用户意图）。
  const grp = lookupGroup(c.models.groups, name);
  if (grp) {
    const rows = [];
    for (const member of grp.group.members) {
      const channel = String(member?.channel || "").trim();
      const target = String(member?.real_model || "").trim();
      if (!channel || !target || isDisabled(target)) continue;
      // 与改名覆盖同口径：渠道关了 / 执行来源未打开时该成员不进入候选（路由层再看账号与冷却）
      if (!catalog.channelOn(channel) || !routing.isChannelEnabled(channel)) continue;
      rows.push(withRate({ id: name, display: name, channel, realModel: target, source: "group", groupName: grp.key, ...catalog.modelMetadata(target, channel) }, name));
    }
    // 成员全部不可用时不回退到同名渠道模型：用户显式用组接管了这个名字，
    // 悄悄换回单渠道模型会让「free 到底打哪」变得不可预测。转发层会回 503 并说明原因。
    return rows;
  }
  const d = c.models.custom?.[name] || c.models.overrides?.[name];
  if (d && typeof d === "object") {
    const target = d.real_model || name;
    if (isDisabled(target)) return [];
    const channel = d.channel || c.models.modelDefaultChannel;
    if (channel) return catalog.channelOn(channel) && routing.isChannelEnabled(channel) ? [withRate({ id: name, display: name, channel, realModel: target, source: c.models.custom?.[name] ? "custom" : "override", ...catalog.modelMetadata(target, channel) }, name)] : [];
    return base.filter((m) => m.id === target).map((m) => withRate({ ...m, id: name, display: name, source: "override" }, name));
  }
  if (c.models.disabledAliases?.includes(name)) return [];
  const alias = c.models.aliases?.[name];
  if (typeof alias === "string") return bindings(alias, visited, { proxy, config: c, base, catalog }).map((m) => withRate({ ...m, id: name, display: name, source: "alias" }, name));
  // ===== 渠道锁定（v1.82.2「渠道覆盖」的语义：只锁渠道，不改发给上游的模型名） =====
  // 位置刻意在 custom/overrides 之后、渠道目录兜底之前：
  //  · custom/overrides 是「改名绑定」，语义更强，命中即生效；
  //  · 别名是「这个名字代表另一个模型」，解析目标再走本分支才能让锁定作用到真正的模型上。
  const lockChannel = lookupChannelLock(c.models.channelLocks, name);
  if (lockChannel) {
    const target = catalog.resolveModelTarget(name, lockChannel);
    const lockUsable = !!target && !isDisabled(target) && catalog.channelOn(lockChannel) && routing.isChannelEnabled(lockChannel);
    if (lockUsable) {
      const locked = withRate({ id: name, display: name, channel: lockChannel, realModel: target, source: "channel-lock", ...catalog.modelMetadata(target, lockChannel) }, name);
      // 「尽力锁」：锁行排第一，其余同名来源行作为回落候选一起返回。
      // 为什么不是只回锁行：v1.82.2 的覆盖失效（渠道关闭/冷却/无号）会回落自动路由，
      // 单行绑定会让锁定渠道一失败就整模型 503，跟旧版体验不一致。
      // /v1/models 只展示锁行（见 list()），重复行不会外泄。
      const others = base.filter((m) => m.id.toLowerCase() === name.toLowerCase() && m.channel !== lockChannel).map((m) => withRate(m, name));
      return [locked, ...others];
    }
    // 配置失效（渠道关了/该渠道没有这个模型名/模型被停用）→ 当作没锁，回落自动路由
  }
  const active = base.filter((m) => m.id.toLowerCase() === name.toLowerCase()).map((m) => withRate(m, name));
  if (active.length) return active;
  return catalog.historicalBindings(name).map(m => withRate({ ...m, id: name, display: name, source: "unavailable", unavailable: true }, name));
}

function list(prepared) {
  const c = prepared?.config || lgwConfig.get();
  const catalog = prepared?.catalog || modelCatalog.view();
  const base = prepared?.base || channelModels(catalog);
  const names = new Set(base.map((m) => m.id));
  for (const table of [c.models.overrides, c.models.aliases, c.models.custom, c.models.channelLocks, c.models.groups]) {
    for (const name of Object.keys(table || {})) names.add(name);
  }
  const snapshot = { base, config: c, proxy: prepared?.proxy || config.loadConfig()?.proxy || {}, catalog };
  /** 模型名（小写）→ 该模型的全部来源渠道（用于行内下拉与单源判定） */
  const sourcesByLower = new Map();
  for (const m of base) {
    const key = m.id.toLowerCase();
    if (!sourcesByLower.has(key)) sourcesByLower.set(key, []);
    const chList = sourcesByLower.get(key);
    if (!chList.includes(m.channel)) chList.push(m.channel);
  }
  return [...names].flatMap((name) => {
    const rows = bindings(name, new Set(), snapshot).filter(row => !row.unavailable);
    // 锁生效时目录只留锁行：bindings 为「尽力锁」额外返回的来源行只是转发回落候选，
    // 让它们在 /v1/models 里出现会造成同名模型重复。
    const locked = rows.find((m) => m.source === "channel-lock");
    const visible = locked ? [locked] : rows;
    const sources = sourcesByLower.get(name.toLowerCase()) || [];
    // 组行的渠道由成员决定，渠道锁对它不生效；回传锁值只会让 UI 显示一个改不动的锁
    const lockChannel = visible.some((row) => row.groupName) ? "" : lookupChannelLock(c.models.channelLocks, name);
    return visible.map((m) => ({
      ...m,
      // 行内「渠道锁定」下拉的数据源：
      //  · sources = 这个模型真实存在的渠道（旧版 m.sources 的新对应物），单源时前端禁用下拉；
      //  · lockChannel = 当前锁值（即使锁已失效也回传，前端据此提示「锁定已失效」）；
      //  · renameLocked = 该模型被改名绑定接管，行内锁必须避让（否则会改错上游模型名）。
      sources,
      lockChannel,
      // 组行/改名行都自带渠道与上游名，行内「渠道锁定」必须避让（锁了会改错路由语义）
      groupName: m.groupName || "",
      renameLocked: m.source === "override" || m.source === "custom" || m.source === "group",
    }));
  });
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
  const grp = lookupGroup(c.models.groups, name);
  if (grp) return { ok: false, message: `「${grp.key}」是模型组，请先移除模型组或换一个对外名` };
  const cur = { ...(c.models.overrides || {}) };
  cur[name] = { real_model: String(payload.real_model || name), channel: String(payload.channel || "") };
  const r = lgwConfig.patch({ models: { ...c.models, overrides: cur } });
  return r && r.ok === false ? { ok: false, message: r.message } : { ok: true };
}

/** 写 / 清「模型消耗倍率」（{ [模型名]: number }）。
 *
 *  上游目录不一定给倍率（Trae 就没有），这里让用户按模型补一个用于展示与比价的系数。
 *  rate 传 null / 空串 = 清除（回到目录声明）。删除同样走原始配置层重建整张表：
 *  mergeDeep 是加性合并，「少一个键」的 patch 不会真删。 */
function setModelRate(model, rate) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, message: "缺少模型名" };
  const raw = rate === null || rate === undefined || rate === "" ? null : Number(rate);
  if (raw != null && (!Number.isFinite(raw) || raw < 0 || raw > 1000)) {
    return { ok: false, message: "倍率需为 0–1000 的数字（0 = 免费档）" };
  }
  const c = config.loadConfig();
  if (!c || typeof c !== "object") {
    return { ok: false, message: "配置读取失败，已放弃写入以免覆盖其它模块配置" };
  }
  const m = (c.localgw && c.localgw.models) || {};
  const table = { ...(m.rates || {}) };
  const lower = name.toLowerCase();
  for (const key of Object.keys(table)) {
    if (key.toLowerCase() === lower) delete table[key];
  }
  if (raw == null && Object.keys(table).length === Object.keys(m.rates || {}).length) return { ok: true };
  if (raw != null) table[name] = Math.round(raw * 10000) / 10000;
  c.localgw = lgwConfig.normalize(
    lgwConfig.mergeDeep(lgwConfig.LOCALGW_DEFAULTS, { ...(c.localgw || {}), models: { ...m, rates: table } })
  );
  try {
    config.saveConfig(c);
  } catch (e) {
    return { ok: false, message: `配置写入失败：${String((e && e.message) || e)}` };
  }
  return { ok: true };
}

/** 写 / 清「渠道锁定」（{ [模型名]: 渠道 id }）——v1.82.2「渠道覆盖」的存储层。
 *
 *  为什么不像 setOverride 那样走 lgwConfig.patch：**删除**是 patch 表达不了的
 *  （mergeDeep 是加性合并，提交"少了某个键"的表不会真删，见 removeRule 的实测结论）。
 *  「自动（不锁定）」必须真删键，所以这里一律在**原始配置层**重建整张表。
 *
 *  顺带收敛大小写同义键：Tab1 的模型名来自请求/目录、用户手写时大小写随意，
 *  "Kimi-K3" 与 "kimi-k3" 各锁一个渠道会让 lookup 命中哪条取决于插入顺序，这里统一成一条。
 *
 *  channel 为空 = 清除锁定（幂等：本来没锁也回 ok）。
 *  channel 非空 = 先校验该渠道确实能转发这个名字（resolveModelTarget 命中），
 *  否则拒绝——写进去也是转发 404，不如当场说清楚。 */
function setChannelLock(model, channel, snapshot) {
  const catalog = snapshot?.catalog || modelCatalog.view();
  const name = String(model || "").trim();
  const ch = String(channel || "").trim();
  if (!name) return { ok: false, message: "缺少模型名" };
  if (ch) {
    const grp = lookupGroup(lgwConfig.get().models.groups, name);
    if (grp) return { ok: false, message: `「${grp.key}」是模型组，渠道由组成员决定，不能行内锁定` };
  }
  if (ch && !catalog.resolveModelTarget(name, ch)) {
    return { ok: false, message: `渠道「${ch}」没有模型 ${name}，不能锁定` };
  }
  const c = config.loadConfig();
  if (!c || typeof c !== "object") {
    return { ok: false, message: "配置读取失败，已放弃写入以免覆盖其它模块配置" };
  }
  const m = (c.localgw && c.localgw.models) || {};
  const table = { ...(m.channelLocks || {}) };
  for (const key of Object.keys(table)) {
    if (key.toLowerCase() === name.toLowerCase()) delete table[key];
  }
  if (ch) table[name] = ch;
  c.localgw = lgwConfig.normalize(lgwConfig.mergeDeep(lgwConfig.LOCALGW_DEFAULTS, { ...(c.localgw || {}), models: { ...m, channelLocks: table } }));
  try {
    config.saveConfig(c);
  } catch (e) {
    return { ok: false, message: `配置写入失败：${String((e && e.message) || e)}` };
  }
  return { ok: true };
}

/** 写 alias */
function setAlias(from, to) {
  const name = String(from || "").trim();
  const target = String(to || "").trim();
  if (!name || !target) return { ok: false, message: "别名与目标模型都不能为空" };
  const c = lgwConfig.get();
  const grp = lookupGroup(c.models.groups, name);
  if (grp) return { ok: false, message: `「${grp.key}」是模型组，不能再用作别名；请直接使用组名或换一个别名` };
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
  const grp = lookupGroup(c.models.groups, name);
  if (grp) return { ok: false, message: `「${grp.key}」是模型组，请先移除模型组或换一个对外名` };
  const cur = { ...(c.models.custom || {}) };
  cur[name] = { channel: String(provider.channel || ""), real_model: String(provider.real_model || name) };
  const r = lgwConfig.patch({ models: { ...c.models, custom: cur } });
  return r && r.ok === false ? { ok: false, message: r.message } : { ok: true };
}

/** 写模型组（对外名 → 多成员）。
 *
 *  为什么走原始配置层重建整张 groups 表而不是 lgwConfig.patch：
 *  组名大小写收敛（"Free" 与 "free" 只留一条）和删除旧键都属于「patch 表达不了的减法」，
 *  与 setChannelLock / removeRule 同因（mergeDeep 是加性合并）。
 *
 *  members 的顺序就是「顺序优先」策略的优先级；保存时整组替换，成员删减不会残留。
 *  与 overrides / custom / aliases 重名直接拒绝：组在 bindings() 里优先级最高，
 *  允许重名等于让另一套显式规则静默失效，用户很难发现。 */
function setGroup(name, payload) {
  const group = String(name || "").trim();
  if (!group) return { ok: false, message: "缺少模型组名称" };
  if (group.length > 128) return { ok: false, message: "模型组名称最长 128 个字符" };
  if (!payload || typeof payload !== "object") return { ok: false, message: "缺少模型组配置" };
  const members = lgwConfig.normalizeGroupMembers(payload.members);
  if (!members.length) return { ok: false, message: "模型组至少需要一个有效成员（渠道与实际模型名都不能为空）" };
  const strategy = payload.strategy === "round-robin" ? "round-robin" : "priority";

  const c = lgwConfig.get();
  const lower = group.toLowerCase();
  for (const [table, label] of [["overrides", "改名覆盖"], ["custom", "自定义模型"], ["aliases", "别名"]]) {
    const hit = Object.keys(c.models[table] || {}).find((key) => key.toLowerCase() === lower);
    if (hit) return { ok: false, message: `「${hit}」已被${label}占用，请先移除它或换一个组名` };
  }

  const raw = config.loadConfig();
  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "配置读取失败，已放弃写入以免覆盖其它模块配置" };
  }
  const m = (raw.localgw && raw.localgw.models) || {};
  const table = { ...(m.groups || {}) };
  for (const key of Object.keys(table)) {
    if (key.toLowerCase() === lower) delete table[key];
  }
  table[group] = { strategy, members };
  raw.localgw = lgwConfig.normalize(
    lgwConfig.mergeDeep(lgwConfig.LOCALGW_DEFAULTS, { ...(raw.localgw || {}), models: { ...m, groups: table } })
  );
  try {
    config.saveConfig(raw);
  } catch (e) {
    return { ok: false, message: `配置写入失败：${String((e && e.message) || e)}` };
  }
  return { ok: true, added: members.length };
}

/**
 * 批量写入覆盖 / 自定义（「覆盖与自定义」页的多选添加）。
 *
 * 为什么单开一条批量通道而不是前端循环调 setOverride/addCustom：
 * 每次 patch 都是「读整份 config.json → normalize → 写回」，50 条模型就是 50 次
 * 磁盘往返。除了慢，逐条写还有真实风险 —— 中间任一条失败时前面已经落盘，
 * 界面上的「成功 N / 失败 M」与库里的实际内容会对不上。这里一次合并、一次落盘。
 *
 * 语义（与单条接口一致，不新增规则）：
 *   · 同名键**覆盖**旧值（用户显式勾选要加，覆盖比报错更符合预期）；
 *   · 缺 model / channel 的行整行跳过，记进 skipped 而不是让整批失败；
 *   · kind 只认 override / custom —— aliases 是「名字→名字」，语义不同，不混进来。
 *
 * @param {"override"|"custom"} kind
 * @param {{model:string, real_model?:string, channel:string}[]} rows
 */
function addBatch(kind, rows) {
  const TABLE = { override: "overrides", custom: "custom" }[String(kind || "")];
  if (!TABLE) return { ok: false, message: "批量添加只支持 override / custom" };
  if (!Array.isArray(rows) || !rows.length) return { ok: false, message: "没有要添加的模型" };
  if (rows.length > 500) return { ok: false, message: "一次最多添加 500 条" };
  const c = lgwConfig.get();
  const cur = { ...(c.models[TABLE] || {}) };
  let added = 0, replaced = 0;
  const skipped = [];
  for (const row of rows) {
    const name = String(row?.model || "").trim();
    const channel = String(row?.channel || "").trim();
    if (!name || !channel) { skipped.push({ model: name, message: "缺少模型名或渠道" }); continue; }
    const grp = lookupGroup(c.models.groups, name);
    if (grp) { skipped.push({ model: name, message: `「${grp.key}」是模型组，不能写入覆盖 / 自定义` }); continue; }
    if (cur[name]) replaced++;
    cur[name] = { channel, real_model: String(row?.real_model || name).trim() || name };
    added++;
  }
  if (!added) return { ok: false, message: "没有可写入的条目（模型名与渠道都不能为空）", skipped };
  const r = lgwConfig.patch({ models: { ...c.models, [TABLE]: cur } });
  if (r && r.ok === false) return { ok: false, message: r.message, skipped };
  return { ok: true, added, replaced, skipped };
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
  const TABLES = ["overrides", "aliases", "custom", "groups"];
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

async function prepare(options) {
  const catalog = await modelCatalog.prepare(options);
  return { catalog, base: channelModels(catalog), config: lgwConfig.get(), proxy: config.loadConfig()?.proxy || {} };
}
async function snapshot(options) {
  const prepared = await prepare(options);
  return { models: list(prepared), diagnostics: { ...prepared.catalog.completeness, errors: prepared.catalog.errors, historyWarning: prepared.catalog.historyWarning } };
}

module.exports = { prepare, snapshot, list, channelModelList, bindings, resolve, setOverride, setAlias, addCustom, addBatch, setChannelLock, setGroup, setModelRate, groupSpec, removeRule };
