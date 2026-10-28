/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-28
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 号池管家 · 自定义模型提供商（中转站 / 自建 OpenAI 兼容端点）
//
// 【恢复说明 2026-10-28】本模块随 fdb3e55「反代网关 → 号池管家」改造下线归档（转发服务
// server.cjs 一并删除），现原样恢复回主树：它不依赖任何已删除模块（只 require
// config / store / adapters / pool / util，全在主树），且仍是唯一的自定义渠道来源——
// store.channelList() 把 providers 表当作 kind≠builtin 的渠道返回，localgw 的路由与
// adapters 的通用 OpenAI 兼容支都靠它，缺了这层用户就没有「自己加中转站」的路。
//
// 这一层只管「提供商这件事的规矩」：标识与地址校验、防遮蔽规则、模型名解析、连通性探测。
// 落库在 store.cjs（提供商就是 agents 表的一行），上游读写在 adapters.cjs（通用 OpenAI 兼容适配器）。
//
// 为什么值得单独一层：网关的渠道概念原本只有代码常量里那几家内置生态渠道，一旦允许用户自己加，
// 「这个模型名归谁」就不再是查表能答的问题——必须有一条不会让新条目悄悄顶掉内置池的解析顺序。
"use strict";
const crypto = require("node:crypto");
const config = require("../config.cjs");
const store = require("./store.cjs");
const adapters = require("./adapters.cjs");
const pool = require("./pool.cjs");
const util = require("./util.cjs");

// slug 就是路由前缀（`myslug/gpt-4o`），也是 accounts.channel 的键值，一旦有账号挂上去就不许改。
// 字符集刻意窄于可读性：小写字母数字加 -_，禁 '/'（分隔符本身），长度卡住是为了 UI 一行放得下。
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// 保留名：内置渠道 id 之外，再加几个会撞上网关自己路由/展示语义的词。
// 撞上的后果不是报错而是行为诡异——例如 slug="v1" 会让 `/v1/models` 的解析歧义。
const RESERVED = new Set(["auto", "all", "v1", "models", "healthz", "status", "readyz"]);

// 上游协议形态。本期只有 OpenAI 兼容一档；Anthropic Messages 与 Responses 两档各自带一个
// 出站互转模块，随后续 PR 进来。**加一档要同改四处**：这里的 KINDS/KIND_LABEL、
// adapters.cjs 的 chat() 分派与 compatUrl 的 leaf、normalizeBaseUrl 的 TRAILING 剥缀表、
// adapters.cjs 的 NATIVE_KEYS_BY_KIND 回填白名单——漏一处的表现都不是报错而是静默错，
// 所以不写死处数，靠这四张表各自的断言守。
const KINDS = new Set(["openai_compat"]);
const KIND_DEFAULT = "openai_compat";
/** 探测失败时按形态给一句人话（拿 OpenAI 措辞去报别的协议的失败会把人引向错误的排查方向） */
const KIND_LABEL = {
  openai_compat: "不是 OpenAI Chat 兼容端点",
};

/** base_url 归一化：只在**写入侧**做一次并存规范值，出站一律 `base + "/v1/chat/completions"`。
 *  留两处拼接口径迟早会漂（尾斜杠、/v1 有无是中转站两种常见写法）。
 *  剥 /v1 尾缀时保留更深的挂载路径（如 /api/openai）——那是某些自建网关的路由，不是版本前缀。 */
function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, message: "base_url 不能为空" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: "base_url 不是合法 URL（需含 http:// 或 https://）" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, message: "base_url 只支持 http(s)" };
  if (u.username || u.password) return { ok: false, message: "base_url 不要带账号信息，Key 请填在 Key 栏" };
  if (u.search || u.hash) return { ok: false, message: "base_url 不要带查询串或锚点" };
  let p = u.pathname.replace(/\/+$/, "");
  // 长后缀优先、剥到不动为止：先匹配 /chat/completions 会让 /v1/chat/completions 只掉一半，
  // 剩个 /v1 就得靠"再归一一次"才干净——写入侧存的就是脏值，读侧永远拼错端点。
  // 刻意不收裸 "/chat/completions"（归入"完整端点形态"，见 adapters.cjs 的 compatUrl）：
  // 挂载点不带 /v1 的站点剥掉它就再也表达不回去（出站恒补 /v1 必 404）。
  const TRAILING = ["/v1/chat/completions", "/v1"];
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of TRAILING) {
      if (p.toLowerCase().endsWith(suffix)) {
        p = p.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  p = p.replace(/\/+$/, "");
  u.pathname = p + (p ? "/" : "");
  return { ok: true, url: u.toString().replace(/\/$/, ""), domain: u.hostname };
}

/** models_json 条目归一。字段口径与内置渠道的 catalog.json 对齐（name/rate/capabilities/
 *  contextLength/maxOutputTokens），另加两项提供商特有的：
 *    aliases[]  下游可用别名——原名照样能请求，别名只是多一个入口，且**不进 /v1/models**
 *    reasoning  {supportedEfforts[], defaultEffort} —— 与 catalog 同一形状，供请求期档位降级
 *  白名单之外的键一律丢掉：留着它们只会让人以为生效了。
 *  空清单允许存在：前缀路由对未列出的模型照样透传（中转站的实际能力常常领先于它的清单）。 */
function normalizeModels(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\n,]/);
  const out = [];
  // 模型名与别名各记一份：合成一个集合会让「后一个模型的名字恰好等于前一个模型的别名」
  // 被下面那条去重 continue 静默吃掉（条目消失、没有任何提示），而同一个模型写两遍
  // 是用户手滑、该宽容去重。两个集合才分得清这两种情况
  const seenModels = new Set();
  const seenAliases = new Set();
  for (const item of list) {
    const e = typeof item === "string" ? { model: item } : item;
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const model = String(e.model || "").trim();
    if (!model) continue;
    if (model.includes("/")) return { ok: false, message: `模型名 "${model}" 含 /：斜杠是 provider/model 的分隔符，模型本身不能有` };
    const key = model.toLowerCase();
    if (seenModels.has(key)) continue; // 同一个模型写两遍：去重（宽容，不是错误）
    // 撞上前面某个别名则必须报错：两个名字就说不清该映射到哪个上游真名，静默丢条目更糟
    if (seenAliases.has(key)) return { ok: false, message: `模型名 "${model}" 与本提供商的另一个模型的别名重复` };
    seenModels.add(key);
    const aliases = normalizeAliases(e.aliases, model, seenModels, seenAliases);
    if (aliases.error) return { ok: false, message: aliases.error };
    const reasoning = normalizeReasoning(e.reasoning);
    out.push({
      model,
      upstream: String(e.upstream || model).trim() || model,
      ...(aliases.list.length ? { aliases: aliases.list } : {}),
      ...(reasoning ? { reasoning } : {}),
      name: e.name ? String(e.name).slice(0, 64) : undefined,
      rate: e.rate != null && !Number.isNaN(Number(e.rate)) ? Number(e.rate) : undefined,
      capabilities: e.capabilities && typeof e.capabilities === "object" ? e.capabilities : undefined,
      contextLength: Number(e.contextLength) || undefined,
      maxOutputTokens: Number(e.maxOutputTokens) || undefined,
    });
  }
  return { ok: true, models: out };
}

const ALIAS_MAX = 8;

/** 别名与模型名同规则（不含 /），且不能与本提供商内任何其他名字撞——撞了两个名字就说不清
 *  该映射到哪个上游真名。撞内置模型名不在此拦：裸名解析本来就是内置优先，结构上遮蔽不了。 */
function normalizeAliases(raw, model, seenModels, seenAliases) {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,]/) : [];
  const out = [];
  for (const a of arr) {
    const s = String(a || "").trim();
    if (!s || s.toLowerCase() === model.toLowerCase()) continue;
    if (s.includes("/")) return { error: `别名 "${s}" 含 /，不能用作别名` };
    if (out.length >= ALIAS_MAX) return { error: `模型 "${model}" 的别名超过 ${ALIAS_MAX} 个` };
    const k = s.toLowerCase();
    if (seenAliases.has(k)) return { error: `别名 "${s}" 与本提供商的另一个别名重复` };
    if (seenModels.has(k)) return { error: `别名 "${s}" 与本提供商的另一个模型名重复` };
    seenAliases.add(k);
    out.push(s.slice(0, 128));
  }
  return { list: out };
}

/** 思考档位归一：只认 util.EFFORT_LEVELS 那份词表（与内置渠道 catalog 同源），
 *  defaultEffort 不在 supportedEfforts 里就丢掉——一个"默认但选不到"的档位只会让人困惑。 */
function normalizeReasoning(raw) {
  const o = raw && typeof raw === "object" ? raw : null;
  if (!o) return undefined;
  const supported = (Array.isArray(o.supportedEfforts) ? o.supportedEfforts : [])
    .map((x) => String(x || "").toLowerCase())
    .filter((x) => util.EFFORT_LEVELS.includes(x));
  const uniq = [...new Set(supported)];
  const dft = String(o.defaultEffort || "").toLowerCase();
  const out = {};
  if (uniq.length) out.supportedEfforts = uniq;
  if (dft && util.EFFORT_LEVELS.includes(dft) && (!uniq.length || uniq.includes(dft))) out.defaultEffort = dft;
  return Object.keys(out).length ? out : undefined;
}

function normalizeHeaders(raw) {
  const o = typeof raw === "string" ? safeJson(raw) : raw;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: true, headers: {} };
  const headers = {};
  for (const [k, v] of Object.entries(o)) {
    const key = String(k).trim();
    // 鉴权头由网关按该渠道的 Key 生成，让用户覆盖等于给了一条绕过 Key 轮转与记账的路
    if (/^(authorization|proxy-connection|host|content-length|connection)$/i.test(key)) {
      return { ok: false, message: `不允许自定义请求头 "${key}"（鉴权头由网关按 Key 栏生成）` };
    }
    headers[key] = String(v);
  }
  return { ok: true, headers };
}

function normalizeBody(raw) {
  const o = typeof raw === "string" ? safeJson(raw) : raw;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: true, body: {} };
  for (const k of ["model", "messages", "prompt", "stream"]) {
    if (k in o) return { ok: false, message: `extra_body 不允许覆盖 "${k}"（由网关与调度层决定）` };
  }
  return { ok: true, body: o };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 校验并归一一整条提供商输入（create 与 update 共用，避免两处规矩漂移） */
function validate(input, existing) {
  const id = String(input.id ?? (existing && existing.id) ?? "").trim();
  if (!SLUG_RE.test(id)) {
    return { ok: false, message: "标识需为 2~32 位小写字母、数字、- 或 _，且不能含 /" };
  }
  if (store.isBuiltinChannel(id)) return { ok: false, message: `标识 "${id}" 是内置渠道，不能占用` };
  if (RESERVED.has(id)) return { ok: false, message: `标识 "${id}" 是保留名` };
  const base = normalizeBaseUrl(input.baseUrl ?? (existing && existing.baseUrl));
  if (!base.ok) return base;
  const models = normalizeModels(input.models ?? (existing && existing.models));
  if (!models.ok) return models;
  const headers = normalizeHeaders(input.extraHeaders ?? (existing && existing.extraHeaders));
  if (!headers.ok) return headers;
  const body = normalizeBody(input.extraBody ?? (existing && existing.extraBody));
  if (!body.ok) return body;
  const kind = input.kind != null ? String(input.kind) : (existing && existing.kind) || KIND_DEFAULT;
  if (!KINDS.has(kind)) return { ok: false, message: `上游协议形态只支持 ${[...KINDS].join("、")}` };
  const enabled = input.enabled != null ? !!input.enabled : !existing || existing.enabled !== false;
  return {
    ok: true,
    row: {
      id,
      display: String(input.display ?? (existing && existing.display) ?? "").trim().slice(0, 64) || id,
      domain: base.domain,
      kind,
      baseUrl: base.url,
      models: models.models,
      extraHeaders: headers.headers,
      extraBody: body.body,
      enabled,
      // 一律 round_robin：expire_first 按到期时间排序，提供商的 Key 没有到期概念（全 0），
      // 结果恒选第一把，多 Key 轮转形同不存在。本期界面不开放改策略（号池页只迭代内置渠道）
      poolStrategy: input.poolStrategy ?? (existing && existing.poolStrategy) ?? "round_robin",
    },
  };
}

/** 防遮蔽规则：新提供商的 slug 不得与既有模型目录里任何 `x/y` 形式的第一段撞名。
 *  撞上的后果是那条内置模型在 /v1/models 里的 id 与提供商前缀无法区分（mergedModels 会跳过重复 id，
 *  于是新提供商的模型一条都列不出来，而用户只会看到「配了却没生效」）。 */
function assertNoCatalogCollision(slug) {
  const prefix = `${slug}/`;
  const hit = adapters.mergedModels().map((m) => m.id).find((id) => id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (hit) return { ok: false, message: `标识 "${slug}" 与模型目录里的 "${hit}" 冲突，换一个（否则该提供商的模型无法出现在 /v1/models）` };
  return { ok: true };
}

// ===== 管理面读写 =====

function list() {
  return store.listProviders().map((p) => {
    // 一次取全，既给计数也给「Key 管理」弹窗当数据源：号池视图（poolView）按内置 CHANNELS
    // 迭代，提供商不在其中，UI 没有第二个来源能拿到这些 Key 的运行态。脱敏视图，不含密文。
    const keys = pool.poolAccounts(p.id);
    return {
      ...p,
      keyCount: keys.length,
      onlineCount: keys.filter((a) => a.status === "online" && a.hasToken).length,
      keys,
    };
  });
}

function create(input) {
  const v = validate(input, null);
  if (!v.ok) return v;
  if (store.getProvider(v.row.id)) return { ok: false, message: `标识 "${v.row.id}" 已存在` };
  const clash = assertNoCatalogCollision(v.row.id);
  if (!clash.ok) return clash;
  return { ok: true, provider: store.saveProvider(v.row) };
}

function update(id, input) {
  const existing = store.getProvider(id);
  if (!existing) return { ok: false, message: `提供商 "${id}" 不存在` };
  // 标识不可改：accounts.channel 以它为外键值，改一个 id 要连带迁移全部 Key 与历史流水，
  // 收益（少建一次）远小于风险（半路失败留下两个渠道的碎片数据）。UI 上把该栏置灰即可。
  if (input.id && String(input.id) !== String(id)) return { ok: false, message: "标识创建后不可修改，请新建一个并删除旧的" };
  const v = validate({ ...input, id }, existing);
  if (!v.ok) return v;
  return { ok: true, provider: store.saveProvider(v.row) };
}

function remove(id) {
  return store.deleteProvider(id) ? { ok: true } : { ok: false, message: `提供商 "${id}" 不存在` };
}

/** 加一把 Key。同一条重复粘贴直接拒：号池里两把一模一样的 Key 会让轮转把配额算成两倍。 */
function addKey(id, { name, key }) {
  if (!store.getProvider(id)) return { ok: false, message: `提供商 "${id}" 不存在` };
  const secret = String(key || "").trim();
  if (!secret) return { ok: false, message: "API Key 不能为空" };
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  for (const row of store.accountRows(id)) {
    if (crypto.createHash("sha256").update(config.decryptSecret(row.token_enc) || "").digest("hex") === hash) {
      return { ok: false, message: "这把 Key 已经在本提供商的号池里了" };
    }
  }
  const accId = store.addAccount({
    channel: id,
    uid: "",
    name: String(name || "").trim().slice(0, 64) || `Key ${store.listAccounts(id).length + 1}`,
    token: secret,
    refreshToken: "", // 空串而非 null：config.encryptSecret 对空串早退，不会留下解不开的空信封
    source: "paste",
    expiresAt: 0,
  });
  return { ok: true, id: accId };
}

function removeKey(accountId) {
  const acc = store.getAccount(accountId);
  if (!acc) return { ok: false, message: "账号不存在" };
  if (!store.getProvider(acc.channel)) return { ok: false, message: "该账号不属于任何自定义提供商" };
  return store.removeAccount(accountId) ? { ok: true } : { ok: false, message: "删除失败" };
}

// ===== 模型名解析（路由的唯一入口） =====

/** `slug/model` → 该提供商的 slug；首段不是启用中的提供商就回 null，交给内置目录判定。
 *  内置模型 id 本身可能含 '/'（如 google/gemini-xxx），所以判据是「首段命中启用中的提供商」，
 *  而不是「含斜杠就当提供商」。 */
function parseModelRef(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  const slug = s.slice(0, i);
  const row = store.channelList().find((c) => c.id === slug && c.kind !== "builtin");
  return row ? slug : null;
}

/** 裸名兜底（proxy.allowBareProviderModel）：只在**没有任何内置渠道拥有该模型**时调用，
 *  且要求恰好唯一命中一个提供商——两个提供商都有 gpt-4o 时不猜，交回上层的 unknown model 提示，
 *  让用户用 slug/model 写清楚。内置优先 + 歧义不猜，这两条合起来就是「不会静默遮蔽」的全部含义。
 *  别名与模型名同等参与：客户端拿别名打裸名也是同一个入口，同样只在无内置归属时才生效。 */
function findUniqueByBareModel(model) {
  const target = String(model || "").toLowerCase();
  if (!target || target.includes("/")) return null;
  // 内置归属先判：裸名的「内置优先」原本靠调用方（server.resolveChannel）的调用顺序兜，
  // 但判据放在这里才封得住——别名让同一个提供商可以声明任意多个裸名，
  // 少一个调用点检查就是静默遮蔽。
  if (adapters.modelOwners(model).length) return null;
  const hits = [];
  for (const row of store.channelList()) {
    if (row.kind === "builtin") continue;
    const names = [];
    for (const m of row.models || []) {
      if (typeof m === "string") names.push(m);
      else if (m && m.model) {
        names.push(m.model);
        if (Array.isArray(m.aliases)) names.push(...m.aliases);
      }
    }
    if (names.some((n) => String(n).toLowerCase() === target)) hits.push(row.id);
  }
  return hits.length === 1 ? hits[0] : null;
}

// ===== 连通性探测 =====

/** 用一把 Key 发一次真实最小请求。Key 有两种来源：
 *  ① `key`：用户在表单里当场填的（新建时还没落库，只能这样试）；
 *  ② `accountId`：编辑已有提供商时表单不重填 Key，让用户从号池里挑一把，主进程按 id 解密——
 *     明文因此一次都不经过渲染层。
 *  两条路都刻意绕开 handleChat 与号池调度：不经 pickAccount（不动 lastUsed、不占租约）、
 *  不 insertUsage、不 applyCool。探测失败的后果绝不能是把号池里一把好 Key 打进冷却。
 *  这会产生真实上游计费，UI 文案要写清楚。 */
async function probe({ id, accountId, baseUrl, key, model, kind, extraHeaders, extraBody }) {
  let secret = String(key || "").trim();
  if (!secret && accountId && id) {
    const acc = store.getAccount(String(accountId));
    // 只认「属于这个提供商」的账号：拿别人的 Key 去试别人的地址，既串了凭据也测不出真相
    if (acc && acc.channel === String(id)) secret = config.decryptSecret(acc.token_enc) || "";
  }
  if (!secret) return { ok: false, message: "请先填 API Key（或从号池里选一把已有的 Key）" };
  const base = normalizeBaseUrl(baseUrl);
  if (!base.ok) return base;
  const target = String(model || "").trim();
  if (!target) return { ok: false, message: "请先填要试的模型名" };
  const headers = normalizeHeaders(extraHeaders || {});
  if (!headers.ok) return headers;
  // 认不出的 kind 不报错、按缺省形态探：这是探测不是保存，保存侧的 validate 才是拒人的地方。
  // 但一旦真按缺省探了，失败文案就得说缺省那种形态，否则会把人引向另一个协议的排查路径。
  const resolvedKind = KINDS.has(kind) ? kind : KIND_DEFAULT;

  // 已保存过的提供商要拿它自己的清单去探：否则 upstream 真名映射、别名、思考档位降级全都不生效，
  // "探测通过但真实请求 400"就是这么来的。新建表单（无 id 或清单里没这个模型）才退化成裸名直传。
  const saved = id ? store.getProvider(String(id)) : null;
  // 别名同样算命中：客户端拿别名发的请求会走别名→上游真名的映射，探测必须用同一张表，
  // 否则"探测失败但真实请求成功"的反向不一致会把人引向改错的排查方向
  const probeModels = (saved && Array.isArray(saved.models) && saved.models.length ? saved.models : []).some((m) => {
    const name = typeof m === "string" ? m : m.model;
    if (String(name || "").toLowerCase() === target.toLowerCase()) return true;
    return !!(m && typeof m === "object" && Array.isArray(m.aliases) &&
      m.aliases.some((a) => String(a || "").toLowerCase() === target.toLowerCase()));
  })
    ? saved.models
    : [{ model: target, upstream: target }];

  const adapter = adapters.makeOpenaiCompat({
    id: id || "__probe__",
    kind: resolvedKind,
    baseUrl: base.url,
    models: probeModels,
    extraHeaders: headers.headers,
    extraBody: (extraBody && typeof extraBody === "object" ? extraBody : {}),
  });
  const started = Date.now();
  let sample = "";
  let finishReason = "";
  let usage = null;
  let streamErr = null;
  const emit = (ev) => {
    if (ev.type === "delta") sample += String((ev.delta && ev.delta.content) || "").slice(0, 200);
    else if (ev.type === "usage") usage = ev.usage;
    else if (ev.type === "finish") finishReason = ev.reason || finishReason;
    else if (ev.type === "error") streamErr = ev;
  };
  try {
    await adapter.chat({
      secrets: { token: secret, refreshToken: "" },
      model: target,
      body: { model: target, messages: [{ role: "user", content: "ping" }], max_tokens: 16, stream: true },
      emit,
    });
  } catch (e) {
    return { ok: false, status: Number(e && e.status) || 0, ms: Date.now() - started, message: String((e && e.message) || e) };
  }
  const ms = Date.now() - started;
  if (streamErr) return { ok: false, status: streamErr.status || 502, ms, message: `流内错误：${streamErr.message}` };
  if (!sample && !finishReason) return { ok: false, status: 502, ms, message: `上游没有任何内容返回（可能不支持该模型，或该地址${KIND_LABEL[resolvedKind]}）` };
  return { ok: true, ms, model: target, sample: sample.slice(0, 200), finishReason, usage };
}

/** 拉上游自己的模型清单：用号池里第一把可用 Key（与探测不同，这里没有"当场输入"的 Key）。
 *  失败如实回错，由 UI 引导手填——真没有 /v1/models 的站是少数，替上游预判会拒掉有能力的那批。 */
function fetchModels(id) {
  const provider = store.getProvider(id);
  if (!provider) return Promise.resolve({ ok: false, message: `提供商 "${id}" 不存在` });
  const row = store.accountRows(id).find((r) => r.status !== "disabled" && r.token_enc);
  if (!row) return Promise.resolve({ ok: false, message: "该提供商还没有可用 Key，先添加一把" });
  const adapter = adapters.makeOpenaiCompat({ ...provider, models: [] });
  return adapter.fetchModels(row, { token: config.decryptSecret(row.token_enc) || "", refreshToken: "" });
}

module.exports = {
  KINDS: [...KINDS],
  normalizeBaseUrl,
  normalizeModels,
  parseModelRef,
  findUniqueByBareModel,
  list,
  create,
  update,
  remove,
  addKey,
  removeKey,
  probe,
  fetchModels,
};
