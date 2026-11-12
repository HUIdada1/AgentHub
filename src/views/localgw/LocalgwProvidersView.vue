<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 自定义提供商：把第三方中转站 / 自建端点接进网关。
     照搬 fdb3e55^ 的「反代网关 · 自定义提供商」页（旧文件 views/proxy/ProxyProvidersView.vue），
     与旧版的差别只有两处，其余逐行保留（数据源契约 proxy_provider_* 同名同形，已在 src/api/ipc.ts 落地）：
       · 保活 watch 的 activeModule 由 "proxy" 改为 "localgw"（本页现在挂在本地网关模块下）；
       · 共享格式化工具从 "./format" 改为 "../proxy/format"（那份文件随号池页留了下来）。
     一个提供商 = 一个上游端点 + 若干把 API Key（Key 走号池轮转与冷却）；模型以 `标识/模型名` 形态被客户端调用。
     与「号池」页的分工：这里管端点本身（地址、Key 集合、模型清单、连通性），号池页管各渠道账号的运行状态 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProviderPreset, ProxyProvider, ProxyProviderKey, ProxyProviderKind, ProxyProviderModel, ProxyProviderModelRow, ProxyProviderTestResult } from "../../types";
import { ACCOUNT_STATUS, fmtAgo } from "../proxy/format";
import { providerLogo } from "../proxy/providerIcons";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const rows = ref<ProxyProvider[]>([]);
/** 后端下发的预设目录（精简视图，不含模型清单）：模型由主进程在创建时按 preset 补全 */
const presets = ref<ProviderPreset[]>([]);
const err = ref("");
const busy = ref(false);

// 系统级加密不可用时不阻断（与内置渠道凭据同一降级策略），但必须把「明文落盘」说清楚
const vault = ref<{ encrypted: boolean; driver: string; dataDir: string } | null>(null);

async function refresh() {
  try {
    const r = await api.proxyProviderList();
    if (r.ok === false) {
      err.value = r.message || "读取提供商列表失败";
      return;
    }
    rows.value = r.providers || [];
    presets.value = r.presets || [];
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
  vault.value = await api.proxyVaultStatus().catch(() => vault.value);
}

/** 按 provider.id 反查预设：列表行的 logo 与「预设」标签都靠它 */
const presetMap = computed(() => new Map(presets.value.map((p) => [p.id, p])));
function presetOf(id: string): ProviderPreset | null {
  return presetMap.value.get(id) || null;
}
/** 命中预设且有图才返回 logo；没有就交给首字母徽章 */
function logoOf(p: ProxyProvider): string {
  return providerLogo(presetOf(p.id)?.brand);
}
function initialOf(text: string): string {
  return String(text || "").trim().slice(0, 1).toUpperCase() || "?";
}

// ===== 新建 / 编辑表单 =====
// 模型清单的唯一真相是 modelRows（结构化表格）：它一旦有第二个可编辑源，
// 「从上游拉取」就会把已写的元数据整段抹平成裸名（曾经的真实行为）。
const formOpen = ref(false);
const editingId = ref("");
const form = ref({
  id: "",
  display: "",
  baseUrl: "",
  kind: "openai_compat" as ProxyProviderKind,
  auth: "" as NonNullable<ProxyProvider["auth"]>,
  keysText: "",
  extraHeadersText: "",
  extraBodyText: "",
  enabled: true,
});
const formErr = ref("");
const testResult = ref<ProxyProviderTestResult | null>(null);
const testing = ref(false);

/** 当前表单来自哪条预设（null = 自定义空白表单）：决定标题、提示条、模型区文案与保存时的 preset 字段 */
const formPreset = ref<ProviderPreset | null>(null);
/** 协议下拉：值与 types 的 ProxyProviderKind 同源（后端 provider.cjs 的 KINDS 也是这三档） */
const KIND_OPTIONS = [
  { value: "openai_compat", label: "OpenAI Chat Completions" },
  { value: "anthropic_messages", label: "Anthropic Messages" },
  { value: "openai_responses", label: "OpenAI Responses" },
] as const;
/** 预设卡片上的协议简称：一行小字里放全名会把卡片撑爆 */
const KIND_SHORT: Record<string, string> = {
  openai_compat: "Chat",
  anthropic_messages: "Anthropic",
  openai_responses: "Responses",
};
const AUTH_OPTIONS = [
  { value: "", label: "自动（按协议与域名判断）" },
  { value: "bearer", label: "Authorization: Bearer" },
  { value: "x-api-key", label: "x-api-key" },
] as const;
/** 鉴权方式只对 Anthropic 档有意义：另两档一律 Bearer，选它只会让人以为能改 */
const showAuth = computed(() => form.value.kind === "anthropic_messages");

const isEdit = computed(() => !!editingId.value);

/** 档位词表必须与后端 util.EFFORT_LEVELS 同源，漂移由 scripts/test-provider-ui.cjs 断言守住 */
const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CAPS = [
  { key: "images", label: "视觉" },
  { key: "tools", label: "工具" },
  { key: "reasoning", label: "思考" },
] as const;

type ModelRow = {
  /** 行身份：与模型名解耦——重命名、导入合并都会换名，勾选态与逐行测试结果挂在名字上就会错位 */
  _rid: number;
  model: string;
  name: string;
  upstream: string;
  aliases: string[];
  contextLength: string;
  maxOutputTokens: string;
  rate: string;
  caps: Record<string, boolean>;
  efforts: string[];
};

let rowSeq = 0;

/** 空行：给"添加模型"用 */
function blankRow(): ModelRow {
  return { _rid: ++rowSeq, model: "", name: "", upstream: "", aliases: [], contextLength: "", maxOutputTokens: "", rate: "", caps: {}, efforts: [] };
}

/** 存库形状 → 表格行（字符串简写与历史缺字段都在这一步补齐，写回时再统一收敛） */
function toRow(m: ProxyProviderModel): ModelRow {
  const o = typeof m === "string" ? { model: m } : m || { model: "" };
  return {
    _rid: ++rowSeq,
    model: String(o.model || ""),
    name: String(o.name || ""),
    upstream: String(o.upstream || ""),
    aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : [],
    contextLength: o.contextLength ? String(o.contextLength) : "",
    maxOutputTokens: o.maxOutputTokens ? String(o.maxOutputTokens) : "",
    rate: o.rate != null ? String(o.rate) : "",
    caps: { ...((o.capabilities || {}) as Record<string, boolean>) },
    efforts: Array.isArray(o.reasoning?.supportedEfforts) ? [...o.reasoning!.supportedEfforts!] : [],
  };
}

const modelRows = ref<ModelRow[]>([]);

/** 表格行 → 存库条目：只写有值的键，避免 models_json 里堆一串 null/空数组 */
function rowToModel(r: ModelRow): ProxyProviderModel {
  const upstream = (r.upstream || "").trim();
  const out: Record<string, unknown> = { model: (r.model || "").trim() };
  if (r.name.trim()) out.name = r.name.trim();
  if (upstream && upstream !== out.model) out.upstream = upstream;
  const aliases = (r.aliases || []).map((a) => String(a).trim()).filter((a) => a && a.toLowerCase() !== String(out.model).toLowerCase());
  if (aliases.length) out.aliases = [...new Set(aliases)];
  if (Number(r.contextLength) > 0) out.contextLength = Number(r.contextLength);
  if (Number(r.maxOutputTokens) > 0) out.maxOutputTokens = Number(r.maxOutputTokens);
  if (r.rate !== "" && !Number.isNaN(Number(r.rate))) out.rate = Number(r.rate);
  const caps: Record<string, boolean> = {};
  for (const c of CAPS) if (r.caps?.[c.key]) caps[c.key] = true;
  if (Object.keys(caps).length) out.capabilities = caps;
  if (r.efforts?.length) out.reasoning = { supportedEfforts: r.efforts };
  return out as ProxyProviderModelRow;
}

const modelNames = computed(() => modelRows.value.map((r) => (r.model || "").trim()).filter(Boolean));

/** 表格里的模型名重复会让"该名字映射到哪个上游真名"变成猜——保存前先在前端拦一道，
 *  后端的 normalizeModels 是去重静默丢，那不适合当交互反馈 */
const dupModels = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of modelNames.value) {
    const k = n.toLowerCase();
    if (seen.has(k)) dup.add(n);
    seen.add(k);
  }
  return [...dup];
});

function parseJsonObject(text: string, label: string): Record<string, unknown> | string {
  const t = String(text || "").trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== "object" || Array.isArray(v)) return `${label}必须是 JSON 对象`;
    return v as Record<string, unknown>;
  } catch (e) {
    return `${label}不是合法 JSON：${String((e as Error).message || e)}`;
  }
}

function keysFromText(): { key: string }[] {
  return String(form.value.keysText || "")
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((key) => ({ key }));
}

/** 创建入参的**运行期**契约比类型多一个 keys：
 *  index.cjs 的 handler 是 `({ keys, ...input }) => { provider.create(input); keys.forEach(k => provider.addKey(...)) }`，
 *  即「建店 + 顺带灌 Key」是一次调用完成的（旧版页面也这么传）。
 *  而 ipc.ts 的 ProxyProviderInput 没写这个字段——类型漂移由本页显式声明接住，
 *  比 `as any` 把整个入参的类型检查关掉强：这里仍然逐字段校验，只是补上被漏掉的那一个。 */
type CreatePayload = api.ProxyProviderInput & { keys: { key: string }[] };

// ===== 第一步：选择预设 =====
const pickOpen = ref(false);
const pickQuery = ref("");
/** 接入约定弹窗（原页面底部那张说明卡搬进来，正文一字不改） */
const guideOpen = ref(false);

function openPicker() {
  pickQuery.value = "";
  pickOpen.value = true;
}

/** 搜索按 display / id / kind 三处命中；kind 用原值（anthropic_messages 也能被 "anthropic" 命中） */
const filteredPresets = computed(() => {
  const q = pickQuery.value.trim().toLowerCase();
  if (!q) return presets.value;
  return presets.value.filter((p) =>
    [p.display, p.id, p.kind].some((s) => String(s || "").toLowerCase().includes(q)),
  );
});

/** 自定义卡片走原有空白表单：与「添加自定义提供商」改造前的那条路径完全一致 */
function openCreate() {
  pickOpen.value = false;
  formPreset.value = null;
  editingId.value = "";
  form.value = {
    id: "",
    display: "",
    baseUrl: "",
    kind: "openai_compat",
    auth: "",
    keysText: "",
    extraHeadersText: "",
    extraBodyText: "",
    enabled: true,
  };
  modelRows.value = [];
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

/** 点预设卡片 = 带着预填值进表单（不是直接落库，用户能先看一眼地址再存） */
function openFromPreset(p: ProviderPreset) {
  pickOpen.value = false;
  formPreset.value = p;
  editingId.value = "";
  form.value = {
    id: p.id,
    display: p.display,
    baseUrl: p.baseUrl,
    kind: p.kind,
    auth: p.auth || "",
    keysText: "",
    extraHeadersText: "",
    extraBodyText: "",
    enabled: true,
  };
  // 模型清单留在主进程：这里只显示数量，不伪造模型行
  modelRows.value = [];
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

/** 表单左上角「←」：回预设选择，已填的内容作废（新建态才显示） */
function backToPicker() {
  formOpen.value = false;
  formPreset.value = null;
  pickQuery.value = "";
  pickOpen.value = true;
}

function openEdit(row: ProxyProvider) {
  formPreset.value = null;
  editingId.value = row.id;
  form.value = {
    id: row.id,
    display: row.display,
    baseUrl: row.baseUrl,
    // 存量行（以及理论上的 builtin 脏数据）一律按 openai_compat 处理
    kind: row.kind === "builtin" ? "openai_compat" : row.kind,
    auth: row.auth || "",
    keysText: "",
    extraHeadersText: row.extraHeaders && Object.keys(row.extraHeaders).length ? JSON.stringify(row.extraHeaders, null, 2) : "",
    extraBodyText: row.extraBody && Object.keys(row.extraBody).length ? JSON.stringify(row.extraBody, null, 2) : "",
    enabled: row.enabled,
  };
  modelRows.value = (row.models || []).map(toRow);
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

async function doSave() {
  if (busy.value) return;
  const models = modelRows.value.filter((r) => (r.model || "").trim()).map(rowToModel);
  if (dupModels.value.length) {
    formErr.value = `模型名重复：${dupModels.value.join("、")}（同名会说不清该映射到哪个上游真名）`;
    return;
  }
  const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
  if (typeof headers === "string") {
    formErr.value = headers;
    return;
  }
  const body = parseJsonObject(form.value.extraBodyText, "extraBody");
  if (typeof body === "string") {
    formErr.value = body;
    return;
  }
  busy.value = true;
  try {
    // id 在这里必定有值（表单必填）：交叉一个 { id: string } 让更新路径的类型收窄成立，
    // 否则 ProxyProviderInput.id 是可选的，proxyProviderUpdate 要求必填会报 TS2345
    const input: api.ProxyProviderInput & { id: string } = {
      id: form.value.id.trim(),
      display: form.value.display.trim(),
      baseUrl: form.value.baseUrl.trim(),
      kind: form.value.kind,
      extraHeaders: headers as Record<string, string>,
      extraBody: body,
      enabled: form.value.enabled,
    };
    // 鉴权方式只对 Anthropic 档有意义；另两档写了后端也用不上，不往外送
    if (showAuth.value) input.auth = form.value.auth;
    // 预设新建且没手加模型时**不传 models**：空数组是"用户明确清空"，会挡住后端按 preset 补全
    if (models.length || !formPreset.value) input.models = models;
    const keys = keysFromText();
    // 先落到显式类型变量上再传：对象字面量直接进 proxyProviderCreate 会触发「未知属性 keys」的
    // 多余属性检查（参数类型里没有它），而这里正是要声明那个被类型漏掉的运行期字段
    const payload: CreatePayload = { ...input, keys };
    if (formPreset.value) payload.preset = formPreset.value.id;
    // 更新路径不回 keyIds（不做 Key 增删），标注成并集形状让下面那条去重提示对两条路径都成立
    const r: { ok: boolean; keyIds?: string[]; message?: string } = isEdit.value
      ? await api.proxyProviderUpdate(input)
      : await api.proxyProviderCreate(payload);
    if (r.ok === false) {
      formErr.value = r.message || "保存失败";
      return;
    }
    formOpen.value = false;
    await refresh();
    const keyIds = Array.isArray(r.keyIds) ? r.keyIds : [];
    if (!isEdit.value && keys.length > keyIds.length) {
      // 同一把 Key 粘两遍时后端只收一把（按内容去重）：不说一声用户以为都存上了
      err.value = `已创建；${keys.length - keyIds.length} 把重复的 Key 被跳过（同一把只存一次）`;
    }
  } catch (e) {
    formErr.value = String((e as Error).message || e);
  } finally {
    busy.value = false;
  }
}

// ===== 逐模型：行操作 / 批量 / 连通性 =====
const rowSel = ref<Set<string>>(new Set());
const rowTest = ref<Record<string, { state: "testing" | "ok" | "fail"; ms?: number; message?: string; sample?: string }>>({});

function rowId(r: ModelRow) {
  return `r${r._rid}`;
}
// 浮层正文走 el-tooltip（上游既有口径）。这三条都可能为空，空串必须 :disabled——
// 原生 title 给空串是不显示，el-tooltip 给空串会飘出一个空玻璃泡，两档语义得对齐
const rowOkTip = (r: ModelRow) => rowTest.value[rowId(r)]?.sample || "";
const rowFailTip = (r: ModelRow) => rowTest.value[rowId(r)]?.message || "";
const testTip = computed(() =>
  testResult.value ? ((testResult.value.ok ? testResult.value.sample : testResult.value.message) || "") : "");
/** 预设新建时模型清单在保存后才由主进程写入，此刻没有任何模型名可测：
 *  按钮置灰并说明原因，比让它点了回一句「请先添加至少一个模型」更诚实 */
const testBlocked = computed(() => !!formPreset.value && !modelRows.value.length);
const testHint = computed(() =>
  testBlocked.value
    ? "预置模型保存后才可用：先保存，再在列表里点「编辑」逐行测试"
    : "向上游发一次 max_tokens=16 的真实最小请求：会计费，但不改动号池 Key 的冷却状态");

/** 「去厂商获取 Key」：新窗口打开预设里记录的控制台地址 */
function openKeyUrl(url: string) {
  if (url) window.open(url, "_blank");
}
function addModelRow() {
  modelRows.value.push(blankRow());
}
function removeModelRow(r: ModelRow) {
  const i = modelRows.value.indexOf(r);
  if (i < 0) return;
  const id = rowId(r);
  modelRows.value.splice(i, 1);
  rowSel.value.delete(id);
  delete rowTest.value[id];
}
function toggleRow(r: ModelRow) {
  const id = rowId(r);
  if (rowSel.value.has(id)) rowSel.value.delete(id);
  else rowSel.value.add(id);
  rowSel.value = new Set(rowSel.value);
}
/** 别名输入框用逗号串承载，写回时切分去空去重——比让用户在表格里操作数组少一层歧义 */
function setAliases(r: ModelRow, text: string) {
  const list = String(text || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  r.aliases = [...new Set(list)];
}
function setCap(r: ModelRow, key: string, on: boolean) {
  if (on) r.caps = { ...r.caps, [key]: true };
  else {
    const next = { ...r.caps };
    delete next[key];
    r.caps = next;
  }
}
const allSelected = computed(
  () => modelRows.value.length > 0 && modelRows.value.every((r) => (r.model || "").trim() ? rowSel.value.has(rowId(r)) : true),
);
function toggleAll() {
  if (allSelected.value) rowSel.value = new Set();
  else rowSel.value = new Set(modelRows.value.filter((r) => (r.model || "").trim()).map(rowId));
}

/** 批量设置：留空的字段不参与修改——"全选后顺手清了上下文"这种误操作代价太高 */
const batch = ref({ contextLength: "", maxOutputTokens: "", rate: "", images: "", tools: "", reasoning: "", efforts: [] as string[] });
function applyBatch() {
  const b = batch.value;
  const touched = b.contextLength || b.maxOutputTokens || b.rate || b.images || b.tools || b.reasoning || b.efforts.length;
  if (!touched) {
    formErr.value = "批量设置里至少要填一项（留空表示不修改）";
    return;
  }
  formErr.value = "";
  for (const r of modelRows.value) {
    if (!rowSel.value.has(rowId(r))) continue;
    if (b.contextLength) r.contextLength = b.contextLength;
    if (b.maxOutputTokens) r.maxOutputTokens = b.maxOutputTokens;
    if (b.rate) r.rate = b.rate;
    for (const [key, val] of [["images", b.images], ["tools", b.tools], ["reasoning", b.reasoning]] as const) {
      if (!val) continue;
      if (val === "1") r.caps = { ...r.caps, [key]: true };
      else delete r.caps[key];
    }
    if (b.efforts.length) r.efforts = [...b.efforts];
  }
}

/** 编辑态不重填 Key 时，从该提供商已存的 Key 里挑一把（明文不过渲染层）。
 *  Key 列表随 proxy_provider_list 一起回来：号池视图只按内置渠道迭代，提供商不在其中。 */
function poolKeysOf(id: string): ProxyProviderKey[] {
  return rows.value.find((p) => p.id === id)?.keys || [];
}

/** 单个模型探一次真实请求。Key 来源与"测试连接"一致：表单里现填的优先，
 *  编辑态不重填则从号池挑一把。刻意不做"批量测全部"——一次点下去就是 N 个真实计费请求，
 *  用户要的是按需验一个。 */
async function testOne(r: ModelRow) {
  const model = (r.model || "").trim();
  if (!model) return;
  const id = rowId(r);
  if (rowTest.value[id]?.state === "testing") return;
  const key = keysFromText()[0]?.key || "";
  if (!key && !isEdit.value) {
    formErr.value = "请先在「API Key」里填一把 Key 再测试";
    return;
  }
  if (!key) {
    keyPickList.value = poolKeysOf(editingId.value);
    if (!keyPickList.value.length) {
      formErr.value = "该提供商还没有可用的 Key，先在「Key 管理」里加一把";
      return;
    }
    keyPickId.value = keyPickList.value[0]?.id || "";
    keyPickRowId.value = id;
    keyPickModel.value = model;
    keyPickOpen.value = true;
    return;
  }
  await runRowTest(id, model, { key });
}

async function runRowTest(id: string, model: string, { key = "", accountId = "" }) {
  // 上一次「先填 Key 再测试」这类表单级错误属于上一个动作：新一轮探测一开始就该收掉，
  // 否则用户按提示补完 Key，顶上那条红字还在，看起来像没生效
  formErr.value = "";
  rowTest.value = { ...rowTest.value, [id]: { state: "testing" } };
  const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
  const body = parseJsonObject(form.value.extraBodyText, "extraBody");
  try {
    const r: ProxyProviderTestResult = await api.proxyProviderTest({
      id: form.value.id.trim(),
      accountId: accountId || undefined,
      baseUrl: form.value.baseUrl.trim(),
      key,
      model,
      extraHeaders: typeof headers === "string" ? {} : (headers as Record<string, string>),
      extraBody: typeof body === "string" ? {} : body,
    });
    rowTest.value = {
      ...rowTest.value,
      [id]: r.ok
        ? { state: "ok", ms: r.ms, sample: r.sample }
        : { state: "fail", ms: r.ms, message: r.message || "探测失败" },
    };
  } catch (e) {
    rowTest.value = { ...rowTest.value, [id]: { state: "fail", message: String((e as Error).message || e) } };
  }
}

/** 连通性探测（整店一次）：仍用列表里第一个模型，作用是"地址与 Key 通不通" */
async function doTest() {
  if (testing.value) return;
  const model = modelNames.value[0] || "";
  if (!model) {
    testResult.value = { ok: false, message: "请先添加至少一个模型" };
    return;
  }
  const keys = keysFromText();
  if (!keys[0]?.key) {
    if (!isEdit.value) {
      formErr.value = "请先在「API Key」里填一把 Key 再测试";
      return;
    }
    keyPickList.value = poolKeysOf(editingId.value);
    if (!keyPickList.value.length) {
      formErr.value = "该提供商还没有可用的 Key，先在「Key 管理」里加一把";
      return;
    }
    keyPickId.value = keyPickList.value[0]?.id || "";
    keyPickRowId.value = "";
    keyPickModel.value = "";
    keyPickOpen.value = true;
    return;
  }
  await runTest({ key: keys[0].key });
}

async function runTest({ key = "", accountId = "" }) {
  testing.value = true;
  testResult.value = null;
  formErr.value = "";
  try {
    const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
    const body = parseJsonObject(form.value.extraBodyText, "extraBody");
    testResult.value = await api.proxyProviderTest({
      id: form.value.id.trim(),
      accountId: accountId || undefined,
      baseUrl: form.value.baseUrl.trim(),
      key,
      model: modelNames.value[0] || "",
      extraHeaders: typeof headers === "string" ? {} : (headers as Record<string, string>),
      extraBody: typeof body === "string" ? {} : body,
    });
  } catch (e) {
    testResult.value = { ok: false, message: String((e as Error).message || e) };
  } finally {
    testing.value = false;
  }
}

// 编辑态测试连接的 Key 选择框（明文不出主进程，只回账号 id 与展示字段）
const keyPickOpen = ref(false);
const keyPickId = ref("");
const keyPickList = ref<ProxyProviderKey[]>([]);
// 从"某一行的测试按钮"进来时记住那一行（行 id + 模型名），选完 Key 直接续上那次探测；整店测试留空
const keyPickRowId = ref("");
const keyPickModel = ref("");
async function confirmKeyPick() {
  keyPickOpen.value = false;
  if (keyPickRowId.value) {
    const rid = keyPickRowId.value;
    const model = keyPickModel.value;
    keyPickRowId.value = "";
    keyPickModel.value = "";
    await runRowTest(rid, model, { accountId: keyPickId.value });
    return;
  }
  await runTest({ accountId: keyPickId.value });
}

// ===== 从上游拉取：三态 diff，勾选合并 =====
const importOpen = ref(false);
const importState = ref<"loading" | "ready" | "error">("loading");
const importErr = ref("");
type UpstreamModel = {
  id: string;
  name?: string;
  rate?: number | null;
  capabilities?: Record<string, boolean | string | number>;
  contextLength?: number;
  maxOutputTokens?: number;
};
const upstreamModels = ref<UpstreamModel[]>([]);
const upstreamIds = computed(() => upstreamModels.value.map((model) => model.id));
// 拉取时的地址签名：改过之后再结果就"过期"了，直接应用会拿旧清单配新地址
const importSig = ref("");
const selAdd = ref<Set<string>>(new Set());
const selDrop = ref<Set<string>>(new Set());

const importGroups = computed(() => {
  // Compare full upstream IDs, including namespaces, rather than client aliases.
  const upstreamOf = (row: ModelRow) => (row.upstream || row.model || "").trim().toLowerCase();
  const current = new Set(modelRows.value.map(upstreamOf));
  const upstream = new Set(upstreamIds.value.map(id => id.toLowerCase()));
  return {
    added: upstreamIds.value.filter(id => !current.has(id.toLowerCase())),
    existing: upstreamIds.value.filter(id => current.has(id.toLowerCase())),
    removed: modelRows.value.filter(row => !upstream.has(upstreamOf(row))).map(row => row.model.trim()),
  };
});

let importSeq = 0;
function sigNow() {
  const provider = rows.value.find(row => row.id === editingId.value);
  return JSON.stringify([editingId.value, form.value.baseUrl.trim(), provider?.keys]);
}

async function openImport() {
  if (!isEdit.value) {
    formErr.value = "「从上游拉取」要先保存一次（拉取用号池里已存的 Key）";
    return;
  }
  formErr.value = "";
  importOpen.value = true;
  await doImport();
}

async function doImport() {
  importState.value = "loading";
  importErr.value = "";
  const seq = ++importSeq;
  const signature = sigNow();
  importSig.value = signature;
  const providerId = editingId.value;
  try {
    const r = await api.proxyProviderFetchModels(providerId);
    if (seq !== importSeq || signature !== sigNow() || !importOpen.value) return;
    if (r.ok === false) {
      importState.value = "error";
      importErr.value = r.message || "拉取失败";
      return;
    }
    upstreamModels.value = (r.models || []).flatMap((item) => {
      if (typeof item === "string") {
        const id = item.trim();
        return id ? [{ id }] : [];
      }
      if (!item || typeof item !== "object") return [];
      const id = String(item.id || item.model || "").trim();
      return id ? [{
        id,
        ...(item.name ? { name: String(item.name) } : {}),
        ...(item.rate != null && Number.isFinite(Number(item.rate)) ? { rate: Number(item.rate) } : {}),
        ...(item.capabilities && typeof item.capabilities === "object" ? { capabilities: item.capabilities } : {}),
        ...(Number(item.contextLength) > 0 ? { contextLength: Number(item.contextLength) } : {}),
        ...(Number(item.maxOutputTokens) > 0 ? { maxOutputTokens: Number(item.maxOutputTokens) } : {}),
      }] : [];
    });
    const g = importGroups.value;
    // 新增默认不勾（用户可能只想看），已存在默认保持，下架默认保留——删除必须是显式动作
    selAdd.value = new Set();
    selDrop.value = new Set(g.removed);
    importState.value = "ready";
  } catch (e) {
    if (seq !== importSeq || signature !== sigNow() || !importOpen.value) return;
    importState.value = "error";
    importErr.value = String((e as Error).message || e);
  }
}

// 模板里 ref 会自动解包，所以不能把 selAdd 当 Ref 传进函数——各自给一个显式切换器
function toggleAdd(id: string) {
  const s = new Set(selAdd.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selAdd.value = s;
}
function toggleDrop(id: string) {
  const s = new Set(selDrop.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selDrop.value = s;
}

function applyImport() {
  if (importState.value !== "ready" || importStale.value) {
    importErr.value = "提供商或 Key 已变化，请重新拉取模型后再应用";
    return;
  }
  const keep = new Set(modelNames.value.map((s) => s.toLowerCase()));
  for (const id of importGroups.value.removed) {
    if (!selDrop.value.has(id)) keep.delete(id.toLowerCase());
  }
  const rows2 = modelRows.value.filter((r) => keep.has((r.model || "").trim().toLowerCase()));
  for (const id of selAdd.value) {
    if (keep.has(id.toLowerCase())) continue;
    // 上游真名常带命名空间（Qwen/Qwen2.5-72B 这类），而客户端名不能含 /（那是 slug 分隔符）：
    // 拆成「末段当客户端名、完整 id 当上游真名」，拉下来即可保存；末段撞名交给上面的重复提示
    const slash = id.lastIndexOf("/");
    const upstreamModel = upstreamModels.value.find((model) => model.id === id);
    const row = slash > 0
      ? { ...blankRow(), model: id.slice(slash + 1), upstream: id }
      : { ...blankRow(), model: id };
    if (upstreamModel?.name) row.name = upstreamModel.name;
    if (upstreamModel?.rate != null) row.rate = String(upstreamModel.rate);
    if (upstreamModel?.contextLength) row.contextLength = String(upstreamModel.contextLength);
    if (upstreamModel?.maxOutputTokens) row.maxOutputTokens = String(upstreamModel.maxOutputTokens);
    if (upstreamModel?.capabilities) {
      row.caps = Object.fromEntries(Object.entries(upstreamModel.capabilities).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    }
    rows2.push(row);
  }
  modelRows.value = rows2;
  rowSel.value = new Set();
  importOpen.value = false;
}

const importStale = computed(() => importState.value === "ready" && importSig.value !== sigNow());

// ===== Key 管理 =====
const keysOpen = ref(false);
const keysRow = ref<ProxyProvider | null>(null);
const keysList = ref<ProxyProviderKey[]>([]);
const newKey = ref({ name: "", key: "" });
const keyErr = ref("");
const keyBusy = ref(false);
async function openKeys(row: ProxyProvider) {
  keysRow.value = row;
  newKey.value = { name: "", key: "" };
  keyErr.value = "";
  await refresh();
  keysList.value = rows.value.find((p) => p.id === row.id)?.keys || [];
  keysOpen.value = true;
}
async function reloadKeys(id: string) {
  await refresh();
  keysList.value = rows.value.find((p) => p.id === id)?.keys || [];
}
async function doAddKey() {
  if (!keysRow.value || keyBusy.value) return;
  keyBusy.value = true;
  keyErr.value = "";
  try {
    const r = await api.proxyProviderAddKey(keysRow.value.id, newKey.value.key.trim(), newKey.value.name.trim());
    if (r.ok === false) {
      keyErr.value = r.message || "添加失败";
      return;
    }
    newKey.value = { name: "", key: "" };
    await reloadKeys(keysRow.value.id);
  } catch (e) {
    keyErr.value = String((e as Error).message || e);
  } finally {
    keyBusy.value = false;
  }
}
// 移出 Key 不可逆（库里只有密文，界面无从还原），与模块内其余删除动作一样先过确认框
const keyDelOpen = ref(false);
const keyDelRow = ref<ProxyProviderKey | null>(null);
function askRemoveKey(acc: ProxyProviderKey) {
  keyDelRow.value = acc;
  keyDelOpen.value = true;
}
async function doRemoveKey() {
  if (!keysRow.value || !keyDelRow.value) return;
  const acc = keyDelRow.value;
  keyDelOpen.value = false;
  try {
    const r = await api.proxyProviderRemoveKey(acc.id);
    if (r.ok === false) keyErr.value = r.message || "移出失败";
    await reloadKeys(keysRow.value.id);
  } catch (e) {
    keyErr.value = String((e as Error).message || e);
  }
}

async function toggleEnabled(row: ProxyProvider) {
  try {
    await api.proxyProviderUpdate({ id: row.id, enabled: !row.enabled });
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

// ===== 删除确认 =====
const delOpen = ref(false);
const delRow = ref<ProxyProvider | null>(null);
async function doDelete() {
  if (!delRow.value) return;
  try {
    const r = await api.proxyProviderDelete(delRow.value.id);
    if (r.ok === false) err.value = r.message || "删除失败";
    delOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

onMounted(refresh);
// 页面 v-show 保活：onMounted 只跑一次；切回本页时补一次刷新，Key 的运行态与别处改过的配置不停留在旧数据
// （旧版判定的是 "proxy" 模块，本页现在挂在 "localgw" 模块下，其余不变）
watch(
  () => app.activeModule === "localgw" && app.activePage === "providers",
  (on) => {
    if (on) refresh();
  }
);
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="openPicker()">添加自定义提供商</button>
        <button class="btn" @click="guideOpen = true">接入约定</button>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="table-scroll">
          <table class="table table-bare tbl-static">
            <thead>
              <tr><th>标识</th><th>名称</th><th>上游地址</th><th>Key</th><th>模型</th><th>状态</th><th>更新</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in rows" :key="p.id">
                <td class="mono">{{ p.id }}</td>
                <td>
                  <span class="p-name">
                    <img v-if="logoOf(p)" :src="logoOf(p)" class="p-logo" alt="" />
                    <span v-else class="p-logo p-initial">{{ initialOf(p.display || p.id) }}</span>
                    <span>{{ p.display }}</span>
                    <span v-if="presetOf(p.id)" class="tag tag-dim p-preset">预设</span>
                  </span>
                </td>
                <el-tooltip :content="p.baseUrl" :disabled="!p.baseUrl" placement="top">
                  <td class="mono url-cell">{{ p.baseUrl }}</td>
                </el-tooltip>
                <td class="mono num">{{ p.onlineCount ?? 0 }}/{{ p.keyCount ?? 0 }}</td>
                <td class="mono num">{{ p.models.length }}</td>
                <td>
                  <span class="tag" :class="p.enabled ? 'tag-ok' : 'tag-dim'">{{ p.enabled ? "启用" : "已停用" }}</span>
                  <span v-if="p.enabled && !(p.keyCount ?? 0)" class="tag tag-warn">无 Key</span>
                </td>
                <td class="mono">{{ fmtAgo(p.updatedAt) }}</td>
                <td>
                  <button class="btn-link btn-sm" @click="openKeys(p)">Key 管理</button>
                  <button class="btn-link btn-sm" @click="openEdit(p)">编辑</button>
                  <button class="btn-link btn-sm" @click="toggleEnabled(p)">{{ p.enabled ? "停用" : "启用" }}</button>
                  <button class="btn-link btn-sm danger" @click="delRow = p; delOpen = true">删除</button>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="8" class="empty-row">暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <!-- 第一步：选预设（末尾固定一张「自定义」卡走原有空白表单） -->
      <div v-if="pickOpen" class="p-mask" @click.self="pickOpen = false">
        <div class="p-dlg glass pick-dlg">
          <div class="p-title">添加提供商</div>
          <input v-model="pickQuery" class="input pick-search" placeholder="搜索名称 / 标识 / 协议…" />
          <div class="pick-grid">
            <button v-for="p in filteredPresets" :key="p.id" type="button" class="pick-card" @click="openFromPreset(p)">
              <img v-if="providerLogo(p.brand)" :src="providerLogo(p.brand)" class="pick-logo" alt="" />
              <span v-else class="pick-logo pick-initial">{{ initialOf(p.display) }}</span>
              <span class="pick-body">
                <b class="pick-name">{{ p.display }}</b>
                <small class="pick-meta">{{ KIND_SHORT[p.kind] || p.kind }} · {{ p.modelCount }} 个模型</small>
              </span>
            </button>
            <button type="button" class="pick-card" @click="openCreate()">
              <span class="pick-logo pick-plus">＋</span>
              <span class="pick-body">
                <b class="pick-name">自定义（OpenAI 兼容）</b>
                <small class="pick-meta">手填地址 / 协议 / 模型</small>
              </span>
            </button>
          </div>
          <div v-if="!filteredPresets.length" class="set-desc pick-none">没有匹配的预设 —— 用末尾的「自定义」手填</div>
          <div class="p-actions">
            <button class="btn" @click="pickOpen = false">取消</button>
          </div>
        </div>
      </div>

      <!-- 接入约定（原页面底部说明卡搬进来；新增一段说明预设与自定义同规则） -->
      <div v-if="guideOpen" class="p-mask" @click.self="guideOpen = false">
        <div class="p-dlg glass guide-dlg">
          <div class="p-title">接入约定</div>
          <div class="code">
            客户端把 base_url 指向本网关、填一把网关 Key，模型名写 <b>标识/模型名</b>（如 myrelay/gpt-4o）即可直达该提供商。<br />
            不带前缀的裸模型名一律先归内置渠道，只有内置目录里没有、且只有一家提供商拥有时才会落到提供商——自建条目不会悄悄顶掉生态渠道。<br />
            模型清单里的别名同样能请求（<span class="mono">标识/别名</span>），但不出现在 /v1/models。<br />
            预设只是预填了地址 / 协议 / 模型清单，之后与自定义提供商同表同规则。
          </div>
          <div class="p-actions">
            <button class="btn" @click="guideOpen = false">关闭</button>
          </div>
        </div>
      </div>

      <!-- 新建 / 编辑 -->
      <div v-if="formOpen" class="p-mask" @click.self="formOpen = false">
        <div class="p-dlg glass form-dlg">
          <div class="form-head">
            <div class="p-title-row">
              <button v-if="!isEdit && formPreset" type="button" class="btn-link f-back" title="返回预设选择" @click="backToPicker">←</button>
              <div class="p-title">{{ isEdit ? "编辑自定义提供商" : formPreset ? `添加 · ${formPreset.display}` : "添加自定义提供商" }}</div>
            </div>
            <div v-if="formPreset && formPreset.note" class="f-note">{{ formPreset.note }}</div>
            <div v-if="formErr" class="set-desc err-text">{{ formErr }}</div>
          </div>
          <div class="form-body">
            <div class="f-grid">
              <div class="f-row">
                <div class="set-name">标识</div>
                <input v-model="form.id" class="input mono f-input" :disabled="isEdit" placeholder="myslug" />
                <div class="set-desc">模型名前缀（{{ form.id || "myslug" }}/gpt-4o），创建后不可改</div>
              </div>
              <div class="f-row">
                <div class="set-name">显示名</div>
                <input v-model="form.display" class="input f-input" placeholder="我的中转站" />
                <div class="set-desc">只影响界面展示，留空则用标识</div>
              </div>
            </div>
            <div class="f-row">
              <div class="set-name">上游地址</div>
              <input v-model="form.baseUrl" class="input mono f-input" placeholder="https://relay.example.com/v1" />
              <div class="set-desc">
                <template v-if="formPreset">预设默认值，改过就不再跟随预设</template>
                <template v-else>填到 <span class="mono">/v1</span> 为止，端点由网关按所选协议补</template>
              </div>
            </div>
            <div class="f-grid">
              <div class="f-row">
                <div class="set-name">协议形态</div>
                <el-select v-model="form.kind" class="f-input" popper-class="glass-popper">
                  <el-option v-for="k in KIND_OPTIONS" :key="k.value" :value="k.value" :label="k.label" />
                </el-select>
                <div class="set-desc">决定出站端点的路径与请求体形态，选错会一直 404 / 400</div>
              </div>
              <div v-if="showAuth" class="f-row">
                <div class="set-name">鉴权方式</div>
                <el-select v-model="form.auth" class="f-input" popper-class="glass-popper">
                  <el-option v-for="a in AUTH_OPTIONS" :key="a.value" :value="a.value" :label="a.label" />
                </el-select>
                <div class="set-desc">国内 Coding Plan 多为 Bearer；官方 api.anthropic.com 用 x-api-key</div>
              </div>
            </div>
            <div class="f-row f-models">
              <div class="set-name">
                模型清单<span class="f-count">{{ modelRows.filter((r) => r.model).length }} 个<template v-if="formPreset && formPreset.modelCount"> · 预设 {{ formPreset.modelCount }} 个</template></span>
              </div>
              <div class="models-bar">
                <button class="btn btn-sm" @click="openImport">从上游拉取</button>
                <button class="btn btn-sm" @click="addModelRow">添加模型</button>
                <label v-if="modelRows.length" class="m-selall">
                  <input type="checkbox" :checked="allSelected" @change="toggleAll" /> 全选
                </label>
                <span v-if="dupModels.length" class="set-desc err-text">模型名重复：{{ dupModels.join("、") }}</span>
              </div>

              <!-- 批量条紧贴工具条而不是压在列表末尾：它是「勾选之后的下一步」，
                   隔着一屏模型行放下面，勾完就看不见回来了 -->
              <div v-if="rowSel.size" class="m-batch">
                <span class="set-desc">已选 {{ rowSel.size }} 个 →</span>
                <label class="m-num">上下文<input v-model="batch.contextLength" class="input mono" type="number" placeholder="不改" /></label>
                <label class="m-num">最大输出<input v-model="batch.maxOutputTokens" class="input mono" type="number" placeholder="不改" /></label>
                <label class="m-num">倍率<input v-model="batch.rate" class="input mono" type="number" step="0.1" placeholder="不改" /></label>
                <label v-for="c in CAPS" :key="c.key" class="m-num">
                  {{ c.label }}
                  <el-select v-model="batch[c.key]" size="small" popper-class="glass-popper" class="m-cap-sel">
                    <el-option value="" label="不改" />
                    <el-option value="1" label="设为支持" />
                    <el-option value="0" label="设为不支持" />
                  </el-select>
                </label>
                <el-select v-model="batch.efforts" multiple collapse-tags size="small" popper-class="glass-popper" class="m-efforts" placeholder="档位（不改）">
                  <el-option v-for="e in EFFORT_LEVELS" :key="e" :value="e" :label="e" />
                </el-select>
                <button class="btn btn-sm" @click="applyBatch">应用到所选</button>
              </div>

              <div v-if="formPreset" class="models-preset set-desc">
                <template v-if="formPreset.modelCount">已预置 {{ formPreset.modelCount }} 个模型（保存后写入）—— 保存后可在列表里编辑模型</template>
                <template v-else>该预设不含模型清单 —— 保存后用「从上游拉取」获取</template>
              </div>

              <div v-if="!modelRows.length && !formPreset" class="models-empty set-desc">
                还没有模型 —— 点「添加模型」手填，或「从上游拉取」后勾选导入；留空也能用，带前缀的模型名原样透传给上游
              </div>

              <div v-for="m in modelRows" :key="m._rid" class="m-row" :class="{ on: rowSel.has(rowId(m)) }">
                <div class="m-line">
                  <input type="checkbox" class="m-check" :checked="rowSel.has(rowId(m))" @change="toggleRow(m)" />
                  <input v-model="m.model" class="input mono m-name" placeholder="gpt-4o" />
                  <input :value="m.aliases.join(', ')" class="input mono m-alias" placeholder="别名，逗号分隔"
                         @input="setAliases(m, ($event.target as HTMLInputElement).value)" />
                  <input v-model="m.upstream" class="input mono m-up" placeholder="上游真名（缺省同模型名）" />
                </div>
                <div class="m-line m-sub">
                  <label class="m-num">上下文<input v-model="m.contextLength" class="input mono" type="number" placeholder="128000" /></label>
                  <label class="m-num">最大输出<input v-model="m.maxOutputTokens" class="input mono" type="number" placeholder="4096" /></label>
                  <label class="m-num">倍率<input v-model="m.rate" class="input mono" type="number" step="0.1" placeholder="-" /></label>
                  <label v-for="c in CAPS" :key="c.key" class="m-cap">
                    <input type="checkbox" :checked="!!m.caps[c.key]" @change="setCap(m, c.key, ($event.target as HTMLInputElement).checked)" /> {{ c.label }}
                  </label>
                  <el-select v-model="m.efforts" multiple collapse-tags collapse-tags-tooltip size="small"
                             popper-class="glass-popper" class="m-efforts" placeholder="思考档位">
                    <el-option v-for="e in EFFORT_LEVELS" :key="e" :value="e" :label="e" />
                  </el-select>
                  <button class="btn btn-sm m-test" :disabled="!m.model || rowTest[rowId(m)]?.state === 'testing'" @click="testOne(m)">
                    {{ rowTest[rowId(m)]?.state === "testing" ? "测试中…" : "测试" }}
                  </button>
                  <el-tooltip v-if="rowTest[rowId(m)]?.state === 'ok'" :content="rowOkTip(m)" :disabled="!rowOkTip(m)" placement="top">
                    <span class="tag tag-ok">可用 {{ rowTest[rowId(m)]?.ms }}ms</span>
                  </el-tooltip>
                  <el-tooltip v-else-if="rowTest[rowId(m)]?.state === 'fail'" :content="rowFailTip(m)" :disabled="!rowFailTip(m)" placement="top">
                    <span class="tag tag-warn m-fail">{{ (rowTest[rowId(m)]?.message || "").slice(0, 40) }}</span>
                  </el-tooltip>
                  <button class="btn-link btn-sm m-del danger" @click="removeModelRow(m)">移除</button>
                </div>
              </div>
            </div>
            <div v-if="!isEdit" class="f-row">
              <div class="set-name">
                API Key
                <button v-if="formPreset && formPreset.apiKeyUrl" type="button" class="btn-link btn-sm f-keylink" @click="openKeyUrl(formPreset.apiKeyUrl)">
                  去 {{ formPreset.display }} 获取 ↗
                </button>
              </div>
              <textarea v-model="form.keysText" class="input mono f-input" rows="3" placeholder="sk-..."></textarea>
              <div class="set-desc">一行一把；多把自动轮转，被限流的那把单独冷却。可留空，之后在「Key 管理」里加</div>
            </div>
            <div class="f-grid">
              <div class="f-row">
                <div class="set-name">自定义请求头</div>
                <textarea v-model="form.extraHeadersText" class="input mono f-input" rows="2" placeholder='{ "X-Channel": "agenthub" }'></textarea>
                <div class="set-desc">JSON 对象，选填；鉴权头由网关按 Key 生成，不能在这里覆盖</div>
              </div>
              <div class="f-row">
                <div class="set-name">附加请求体字段</div>
                <textarea v-model="form.extraBodyText" class="input mono f-input" rows="2" placeholder='{ "reasoning": { "effort": "high" } }'></textarea>
                <div class="set-desc">JSON 对象，选填，深合并进上游请求体；不能覆盖 model / messages / prompt / stream</div>
              </div>
            </div>
            <div class="f-inline">
              <div class="f-inline-info">
                <div class="set-name">启用</div>
                <div class="set-desc">停用即从路由视图消失，带该前缀的请求会报「模型不在目录中」</div>
              </div>
              <el-switch v-model="form.enabled" />
            </div>
          </div>
          <!-- 操作条固定在弹窗底部：表单比视口高，按钮跟着滚走的话每次保存都要先滚到底 -->
          <div class="form-foot">
            <el-tooltip :content="testHint" placement="top">
              <button class="btn" :disabled="testing || testBlocked" @click="doTest">
                {{ testing ? "测试中…" : "测试连接" }}
              </button>
            </el-tooltip>
            <el-tooltip v-if="testResult" :content="testTip" :disabled="!testTip" placement="top">
              <span class="set-desc f-foot-msg" :class="{ 'err-text': !testResult.ok }">
                <template v-if="testResult.ok">
                  通过 {{ testResult.ms }}ms · {{ testResult.finishReason || "-" }} · token {{ testResult.usage?.prompt_tokens ?? "?" }}/{{ testResult.usage?.completion_tokens ?? "?" }}
                </template>
                <template v-else>失败：{{ testResult.message }}<template v-if="testResult.status">（HTTP {{ testResult.status }}）</template></template>
              </span>
            </el-tooltip>
            <button class="btn f-foot-push" @click="formOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doSave">{{ busy ? "保存中…" : "保存" }}</button>
          </div>
        </div>
      </div>

      <!-- Key 管理 -->
      <div v-if="keysOpen" class="p-mask" @click.self="keysOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">{{ keysRow?.display }} · API Key</div>
          <div v-if="vault && !vault.encrypted" class="set-row">
            <div class="set-info">
              <div class="set-name">系统加密不可用</div>
              <div class="set-desc err-text">本机 DPAPI / safeStorage 取不到密钥，Key 将<b>明文</b>写入 stats.db（与现有渠道账号同一策略）。换机器或重装系统前请先导出。</div>
            </div>
          </div>
          <div v-if="keyErr" class="set-row"><div class="set-info"><div class="set-desc err-text">{{ keyErr }}</div></div></div>
          <div class="table-scroll" style="max-height: 260px">
            <table class="table table-bare tbl-static">
              <thead>
                <tr><th>名称</th><th>状态</th><th>今日</th><th>最近使用</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="acc in keysList" :key="acc.id">
                  <td>{{ acc.name }}</td>
                  <td>
                    <span class="tag" :class="acc.status === 'online' ? 'tag-ok' : 'tag-dim'">{{ ACCOUNT_STATUS[acc.status]?.text || acc.status }}</span>
                    <span v-if="acc.coolReason" class="set-desc"> · {{ acc.coolReason }}</span>
                  </td>
                  <td class="mono num">{{ acc.todayReq }} 次</td>
                  <td class="mono">{{ fmtAgo(acc.lastUsed) }}</td>
                  <td><button class="btn-link btn-sm danger" @click="askRemoveKey(acc)">移出</button></td>
                </tr>
                <tr v-if="!keysList.length"><td colspan="5" class="empty-row">还没有 Key —— 在下方填一把。没有可用 Key 的提供商不会被调度</td></tr>
              </tbody>
            </table>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="newKey.name" class="input" style="width: 160px" placeholder="主 Key" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">API Key</div><div class="set-desc">加密存库；同一把重复粘贴会被拒</div></div>
            <input v-model="newKey.key" class="input mono" style="width: 300px" placeholder="sk-..." />
          </div>
          <div class="p-actions">
            <button class="btn" @click="keysOpen = false">关闭</button>
            <button class="btn btn-primary" :disabled="keyBusy || !newKey.key.trim()" @click="doAddKey">{{ keyBusy ? "添加中…" : "添加 Key" }}</button>
          </div>
        </div>
      </div>

      <!-- 移出 Key 确认（不可逆：库里只有密文，界面无从还原） -->
      <div v-if="keyDelOpen" class="p-mask" @click.self="keyDelOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">移出 Key</div>
          <div class="set-desc">
            确定从「{{ keysRow?.display }}」移出 Key「{{ keyDelRow?.name }}」？移出后它立即不再参与轮转，库里的密文一并删除，无法恢复。
          </div>
          <div class="p-actions">
            <button class="btn" @click="keyDelOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doRemoveKey">移出</button>
          </div>
        </div>
      </div>

      <!-- 编辑态测试连接时从已存 Key 里挑一把 -->
      <div v-if="keyPickOpen" class="p-mask" @click.self="keyPickOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">选一把已有 Key 来测试</div>
          <div class="set-desc" style="margin-bottom: 8px">表单里的 Key 输入框是空的（编辑态不重填），测试需要一把真 Key。选中的 Key 只用于这次请求，不会被改动冷却状态。</div>
          <el-select v-model="keyPickId" class="f-el-select" popper-class="glass-popper" style="width: 100%">
            <el-option v-for="a in keyPickList" :key="a.id" :value="a.id" :label="`${a.name}（${ACCOUNT_STATUS[a.status]?.text || a.status}）`" />
          </el-select>
          <div class="p-actions">
            <button class="btn" @click="keyPickOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="!keyPickId" @click="confirmKeyPick">测试</button>
          </div>
        </div>
      </div>

      <!-- 从上游拉取：三态 diff 勾选合并（新增默认不勾 / 已存在默认保留 / 下架默认保留，删除要显式取消勾选） -->
      <div v-if="importOpen" class="p-mask" @click.self="importOpen = false">
        <div class="p-dlg glass imp-dlg">
          <div class="p-title">从上游拉取模型</div>
          <div v-if="importState === 'loading'" class="set-desc">正在请求上游 /v1/models…</div>
          <div v-else-if="importState === 'error'" class="set-desc err-text">
            {{ importErr }}
            <div class="p-actions"><button class="btn" @click="importOpen = false">关闭</button><button class="btn btn-primary" @click="doImport">重试</button></div>
          </div>
          <template v-else>
            <div v-if="importStale" class="set-desc imp-stale">
              上游地址在拉取之后改过了，这份清单已经过期——先重新拉取再合并，否则会把旧地址的模型配到新地址上。
              <button class="btn-link btn-sm" @click="doImport">重新拉取</button>
            </div>
            <div class="set-desc imp-sum">上游共 {{ upstreamIds.length }} 个模型：新增 {{ importGroups.added.length }} · 已存在 {{ importGroups.existing.length }} · 上游已下架 {{ importGroups.removed.length }}</div>

            <div v-if="importGroups.added.length" class="imp-group">
              <div class="imp-head">
                <b>新增</b>
                <span class="set-desc">默认不勾选，勾上的才加进清单</span>
                <button class="btn-link btn-sm" @click="selAdd = new Set(importGroups.added)">全选</button>
                <button class="btn-link btn-sm" @click="selAdd = new Set()">清空</button>
              </div>
              <label v-for="id in importGroups.added" :key="id" class="imp-item">
                <input type="checkbox" :checked="selAdd.has(id)" @change="toggleAdd(id)" /> <span class="mono">{{ id }}</span>
              </label>
            </div>

            <div v-if="importGroups.existing.length" class="imp-group">
              <div class="imp-head"><b>已存在</b><span class="set-desc">保留现有配置（别名、上下文、档位都不动）</span></div>
              <div class="imp-item set-desc">共 {{ importGroups.existing.length }} 个：{{ importGroups.existing.join("、") }}</div>
            </div>

            <div v-if="importGroups.removed.length" class="imp-group">
              <div class="imp-head">
                <b>上游已下架</b>
                <span class="set-desc">默认保留；取消勾选即从清单里删除</span>
              </div>
              <label v-for="id in importGroups.removed" :key="id" class="imp-item">
                <input type="checkbox" :checked="selDrop.has(id)" @change="toggleDrop(id)" /> <span class="mono">{{ id }}</span>
              </label>
            </div>

            <div v-if="!importGroups.added.length && !importGroups.removed.length" class="set-desc">上游清单与本地一致，无需合并。</div>

            <div class="p-actions">
              <button class="btn" @click="importOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="importStale" @click="applyImport">
                合并（新增 {{ selAdd.size }} 个、删除 {{ importGroups.removed.length - selDrop.size }} 个）
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">删除自定义提供商</div>
          <div class="set-desc">
            确定删除「{{ delRow?.display }}」（{{ delRow?.id }}）？它的 {{ delRow?.keyCount ?? 0 }} 把 Key 会一并移出。
            正在用 <span class="mono">{{ delRow?.id }}/模型名</span> 的客户端会立即收到「模型不在任何渠道目录中」。
          </div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doDelete">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.danger {
  color: var(--err, #e05555);
}
.url-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 两张表都是只读列表（行内只有按钮），不点行看详情：
   全局 .table 默认给了 pointer + 主色悬停底色，这里关掉，免得看起来像能点 */
.tbl-static tbody tr {
  cursor: default;
}
.tbl-static tbody tr:hover {
  background: transparent;
}
/* ===== 表单弹窗：标题与操作条固定，只有中间字段区滚动 =====
   整窗一起滚的话「保存」会在填到一半时滚出视口，每次提交都得先滚到底。
   .p-dlg 自带 padding 与 overflow:hidden，这里改成三段式布局，内边距下放到各段。 */
.form-dlg {
  width: 780px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.form-head {
  flex: none;
  padding: 16px 18px 0;
}
.form-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--line);
}
/* 测试结果挤在按钮排里：长了就截断，完整内容在 el-tooltip 浮层上 */
.f-foot-msg {
  max-width: 330px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-foot-push {
  margin-left: auto;
}
/* 字段一律「标签在上、控件吃满宽度」。老的左标签 + 右窄控件写法把 URL 和 JSON 挤断，
   而省下来的说明只能塞进左列那条缝——说明越长，布局越歪。 */
.f-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.f-models {
  gap: 6px;
}
.f-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.f-warn {
  color: var(--warn, #d9a13b);
}
.f-count {
  margin-left: 6px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
}
.f-input {
  width: 100%;
}
.f-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.f-inline-info {
  min-width: 0;
}
/* ===== 模型清单：工具条 + 逐行两行式 ===== */
.models-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.m-selall {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.models-empty {
  padding: 10px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  text-align: center;
}
.m-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-2, transparent);
}
.m-row.on {
  border-color: var(--accent, #4a9eff);
}
.m-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.m-check {
  flex: none;
}
.m-name {
  flex: 1 1 150px;
  min-width: 0;
}
.m-alias {
  flex: 1 1 130px;
  min-width: 0;
}
.m-up {
  flex: 1 1 150px;
  min-width: 0;
}
.m-sub {
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 22px;
  font-size: 11.5px;
  color: var(--text-2);
}
.m-num {
  display: flex;
  align-items: center;
  gap: 4px;
}
.m-num .input {
  width: 84px;
}
.m-cap {
  display: flex;
  align-items: center;
  gap: 3px;
}
/* 选择控件跟全站同观感：原生 checkbox 补强调色与手型（与 Key 页选择列同款） */
.m-selall input[type="checkbox"],
.m-check,
.m-cap input[type="checkbox"],
.imp-item input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--accent);
}
.m-cap-sel {
  width: 104px;
}
.m-efforts {
  width: 150px;
}
.m-test,
.m-del {
  flex: none;
}
.m-fail {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-batch {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--accent, #4a9eff);
  border-radius: 8px;
  background: var(--bg-2, transparent);
}
/* ===== 拉取合并弹窗 ===== */
.imp-dlg {
  width: 620px;
  max-height: 84vh;
  overflow: auto;
}
.imp-sum {
  margin-bottom: 8px;
}
.imp-stale {
  color: var(--warn, #d9a13b);
  margin-bottom: 8px;
}
.imp-group {
  margin-bottom: 10px;
}
.imp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.imp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 2px 6px;
  font-size: 12px;
}
.empty-row {
  text-align: center;
  color: var(--text-3);
  padding: 14px;
}
/* ===== 列表 · 名称列（24px logo / 首字母徽章 + 预设标签） ===== */
.p-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.p-logo {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: contain;
}
.p-initial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--bg-2, rgba(127, 127, 127, 0.14));
  border: 1px solid var(--line);
}
.p-preset {
  flex: none;
  font-weight: 400;
}
/* ===== 预设选择弹窗 ===== */
.pick-dlg {
  width: 660px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pick-search {
  width: 100%;
  margin: 10px 0;
  flex: none;
}
.pick-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding-right: 2px;
}
.pick-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-2, transparent);
  color: inherit;
  font: inherit;
  transition: border-color 0.15s, background 0.15s;
}
.pick-card:hover {
  border-color: var(--accent, #4a9eff);
  background: var(--bg-3, rgba(127, 127, 127, 0.06));
}
.pick-logo {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  object-fit: contain;
}
.pick-initial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--bg-3, rgba(127, 127, 127, 0.14));
  border: 1px solid var(--line);
}
.pick-plus {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--text-3);
  border: 1px dashed var(--line);
}
.pick-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pick-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-meta {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-none {
  padding: 8px 0 0;
}
/* ===== 接入约定弹窗 ===== */
.guide-dlg {
  width: 620px;
  max-height: 84vh;
  overflow: auto;
}
/* ===== 表单：返回箭头 / 预设提示条 / 预置模型说明 ===== */
.p-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.f-back {
  flex: none;
  font-size: 15px;
  line-height: 1;
  padding: 2px 4px;
}
.f-note {
  margin-top: 8px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent, #4a9eff);
  border-radius: 6px;
  background: var(--bg-2, rgba(127, 127, 127, 0.06));
  font-size: 12px;
  color: var(--text-2);
}
.models-preset {
  padding: 10px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  text-align: center;
}
.f-keylink {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}
</style>
