<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 模型与网关面板：来源优先级（左拖拽小卡 + 右说明与操作的双栏）+ 供应商紧凑列表
     （名称 / 调用信息 / 模型 / 连接测试·编辑·删除·启用开关）+ 反代网关列表 + 标签降级链。
     供应商「编辑」弹窗＝连接信息（Base URL / API 格式 / API Key / 备注）+ 模型列表：
     每行一个模型，右侧连接测试 / 编辑 / 删除图标按钮与启用开关，编辑走二级小弹窗。
     三级测试与真实调用结果均为弹窗；所有下拉/输入框对齐全站控件规范（f-select/f-input）。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { timeAgo } from "../../composables/useFormat";
import { fmtCtx } from "../../utils/format";
import { taskLabel, taskLabelZh, effortLabel } from "./labels";
import MemHelp from "./MemHelp.vue";
import MemSelect from "./MemSelect.vue";
import MemDialog from "./MemDialog.vue";

const app = useAppStore();
const mem = useMemoryStore();

type Provider = {
  id: string; name: string; kind: string; baseUrl: string; apiFormat: string;
  apiKeyMasked: string; hasKey: boolean; enabled: boolean; note: string;
  status: string; lastCheck: { at: number; ok: boolean; latencyMs?: number; models?: number } | null;
  modelCount: number; enabledModelCount: number; isGateway: boolean;
};
/** 模型能力预判（拉取/添加时按模型名 guessCaps 落盘；旧数据可能没有整块 caps） */
type ModelCaps = { vision?: boolean; tools?: boolean; stream?: boolean; jsonMode?: boolean; contextWindow?: number };
type Model = {
  id: string; providerId: string; modelId: string; displayName: string; enabled: boolean;
  reasoning: { enabled: boolean; effort: string; customBudget: number | null };
  caps?: ModelCaps;
  tags: string[]; priority: number; temperature: number; maxTokens: number;
};
type Routing = { task: string; tags: string[]; effort: string; providerId?: string; modelId?: string; modelState?: string; chain: { providerId: string; providerName: string; modelId: string; priority: number; source: string; fallback?: boolean }[]; tagFallback?: boolean };
type Gateway = { id: string; name: string; baseUrl: string; available: boolean; urlOverride: string; modelCount: number; enabledModelCount: number; fallbackModel: string };
type CallResult = { ok: boolean; latencyMs?: number; providerId?: string; modelId?: string; effort?: string; text?: string; message?: string; usage?: unknown };
/** 路由表里的一条任务级绑定配置（后端 models.routing 的原始条目） */
type RouteEntry = { task: string; tags?: string[]; providerId?: string; modelId?: string };
/** 兜底降级配置（后端 models.degrade）：绑定一个专用供应商+模型 */
type DegradeCfg = { enabled?: boolean; providerId?: string; modelId?: string; effort?: string };
type SourcesState = {
  order: string[]; tagDefs: string[];
  routing?: RouteEntry[]; taskEffort?: Record<string, string>; degrade?: DegradeCfg;
  sources?: { key: string; available: boolean; detail: string }[];
};

const providers = ref<Provider[]>([]);
const gateways = ref<Gateway[]>([]);
const models = ref<Model[]>([]);
const routing = ref<Routing[]>([]);
const sources = ref<SourcesState>({ order: [], tagDefs: [] });
const testResult = ref<{ providerId: string; l1: any; l2: any; l3: any; suggestion: any } | null>(null);
const testOpen = ref(false);
const callResult = ref<CallResult | null>(null);
const callCtx = ref<{ providerName: string; modelId?: string } | null>(null);
const callOpen = ref(false);
const busy = ref("");
const drawer = ref(false);
const form = ref({ id: "", name: "", baseUrl: "", apiFormat: "chat_completions", apiKey: "", note: "", enabled: true, kind: "" });
/** API Key 明文/掩码切换（编辑弹窗里的眼睛按钮） */
const keyVisible = ref(false);
const fetchResult = ref<{ id: string; list: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string } }[] } | null>(null);
/** 模型级二级弹窗（编辑模型）：快照编辑，点保存一次性提交 */
const modelOpen = ref(false);
const modelForm = ref({
  id: "", providerId: "", modelId: "", displayName: "", enabled: true,
  effort: "minimal", customBudget: null as number | null,
  tagsText: "", priority: 10, temperature: 0.2, maxTokens: 2048,
  // 能力预判要随保存一起回传：不传的话后端会按模型名重猜，模型行上的上下文/视觉 chip 会跟着变
  caps: undefined as ModelCaps | undefined,
});

const EFFORTS = ["off", "minimal", "low", "medium", "high", "custom"];
const FORMATS = [
  { id: "anthropic_messages", label: "Anthropic Messages", path: "POST /v1/messages", desc: "Claude 系端点、Claude 中转" },
  { id: "chat_completions", label: "Chat Completions", path: "POST /v1/chat/completions", desc: "OpenAI 系、绝大多数兼容端点、本机网关" },
  { id: "responses", label: "Responses", path: "POST /v1/responses", desc: "OpenAI 新接口" },
];
/** 三个来源档的中文名与一句话说明（右侧解释区渲染用） */
const SOURCE_META: Record<string, { name: string; desc: string }> = {
  custom: { name: "自定义供应商（自备 Key）", desc: "常在线的上游；Key 明文存本机配置，界面只显掩码" },
  gateway: { name: "本机反代网关（AgentHub，零成本）", desc: "随反代网关模块启停，未运行时自动跳过这一档" },
  degrade: { name: "全部失败 → 优雅降级", desc: "兜底档：前面全失败才启用，需在下方绑定专用供应商与模型，未绑定时不参与解析" },
};
const DEFAULT_ORDER = ["custom", "gateway", "degrade"];
/** 任务级思考强度可选项：不给 custom（任务层没有预算输入，custom 只该在模型/单次调用层用） */
const ROUTE_EFFORTS = ["off", "minimal", "low", "medium", "high"];
const sourceName = (key: string) => SOURCE_META[key]?.name || key;
const sourceDesc = (key: string) => SOURCE_META[key]?.desc || "";

/* 下拉选项清单（全部走 MemSelect = 与「用量统计」同款 el-select）：
   原先散在模板里的 <option v-for> 收在这里，选项的来源逻辑一眼可见 */
// API 格式选项带端点路径：下拉收起后仍能对上号（详细差异见选中项下方的 desc 行）
const formatOptions = FORMATS.map((f) => ({ value: f.id, label: `${f.label}（${f.path.replace("POST ", "")}）` }));
const formatDesc = (id: string) => FORMATS.find((f) => f.id === id)?.desc || "";
const effortOptions = EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }));
const routeEffortOptions = ROUTE_EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }));
const degradeProviderOptions = computed(() => [
  { value: "", label: "绑定供应商…" },
  ...providers.value.map((p) => ({ value: p.id, label: p.name })),
]);
const degradeModelOptions = computed(() => [
  { value: "", label: "绑定模型…" },
  ...modelsOf(degradeCfg.value.providerId || "").map((m) => ({ value: m.modelId, label: m.modelId })),
]);
/** 路由表里某任务的「绑定供应商」选项：空值＝按来源优先级，gw-local＝本机反代网关。
    el-select 把空串视作"没选"，会退回 placeholder —— 所以这里的 placeholder
    必须写成同一个语义（见模板），否则用户只看到光秃秃的「全部」。 */
function routeProviderOptions(r: Routing) {
  return [
    { value: "", label: "全部（按来源优先级）" },
    ...providers.value.map((p) => ({ value: p.id, label: p.name })),
    { value: "gw-local", label: "本机反代网关" },
  ];
}
/** 路由表里某任务的「指定模型」选项：空＝不限，其余为该任务标签下的可用模型 */
function routeModelOptions(r: Routing) {
  return [
    { value: "", label: "不限（按标签+优先级）" },
    ...modelsForRoute(r).map((m) => ({ value: m.modelId, label: `${m.modelId}（${providerNameOf(m.providerId)}）` })),
  ];
}

/** 空链的原因提示：说清是标签没人带还是模型都被停用，并给出下一步该动哪个旋钮 */
function chainHint(r: Routing) {
  const hasEnabledModel = models.value.some((m) => m.enabled);
  if (!hasEnabledModel) return "模型池里没有已启用的模型 —— 先到上方「供应商」里拉取模型并启用";
  if (!r.tags.length) return "该任务没有可用标签 —— 点左侧标签单元格补一个";
  return `没有启用模型带「${r.tags.join(" / ")}」标签 —— 到模型池给某个模型补标签，或在本行「指定模型」里直接选一个（指定优先于标签）`;
}

/** 兜底链提示：任务现在能用（用启用模型兜底），但提醒换更强模型效果更好 */
function fallbackHint(r: Routing) {
  return `没有带「${r.tags.join(" / ")}」标签的启用模型，已用池里全部启用模型兜底，任务照常执行。蒸馏/画像这类任务用更强模型效果更好：到模型池给某个模型补标签可精确指定，或在本行「指定模型」里直接选一个（指定优先于标签）。`;
}

const HELP = {
  sources: "记忆模块调模型时按这里的顺序找来源：先试自备 Key 的自定义供应商，再试本机网关（零成本但常不开），全都不行就跳过本次 AI 处理（只记 L1，不报错）。拖动左侧小卡调顺序。",
  format: "上游端点的协议形态。选错会一直 404/400：Claude 系与 Claude 中转多是 Anthropic Messages，绝大多数兼容端点与本机网关是 Chat Completions，OpenAI 新接口是 Responses。拿不准就先按默认测一次，三级测试会给建议。",
  key: "API Key 明文存本机配置文件（不加密、随配置走），界面只回掩码；导出配置时不含 Key。留空表示沿用原有 Key，或走本机网关的号池。",
  test: "三级测试：① 连通（能不能握手）→ ② 鉴权（Key 有没有效）→ ③ 格式能力（用你选的格式发一次最小真实请求）。第三级最关键——它能直接告诉你格式选错了。",
  fetch: "从上游 /models 端点拉模型列表。拉回来的模型会按名字预判标签与思考强度（只是预填，可改）。端点不提供 /models 时改用手动添加。",
  modelTable: "每行一个模型：关掉开关即从所有任务的选择器里消失；「标签」决定哪些任务能用它；「优先级」越小越先被选中；「思考强度」是模型级默认值（任务与单次调用可覆盖）。",
  effort: "思考强度五档：off 不发思考参数；minimal/low/medium/high 控制推理预算（越高质量越好、越费 token）；custom 手动填预算。判定类任务（去重/分类）用低档，蒸馏/画像用中高档。",
  tags: "用途标签是任务与模型之间的唯一约定：任务声明「我要 heavy、summarize 的模型」，就在带这些标签且已启用的模型里按优先级挑。可以只用一个模型打全部标签，也可以配 10 个模型分多档。",
  routing: "按标签展开的降级链：先按「绑定网关/供应商」过滤（绑定了就只用它；它名下没有带匹配标签的模型时，用它全部启用模型兜底），再在同标签内按优先级排序逐个尝试；某个模型 401/403 会立刻换下一个，429/5xx 会退避重试。没有带匹配标签的启用模型时，用全部启用模型兜底并提示「换更强模型效果更好」；模型池彻底没有启用模型时该任务才会被跳过并提示（不会静默什么都不做）。",
  routingEdit: "每行都能给任务绑定指定的网关/供应商与模型：绑定后该任务只走它（它挂了就跳过本次，不再试别的来源）；「全部」则按左侧来源优先级在匹配标签的模型里挑。「指定模型」是再进一步——链上把它排最前，失败仍会落到链上后面的模型；它是显式指定，所以即使该模型没带这个任务的标签也照用（标签只决定「没指定时挑谁」）。",
  degrade: "兜底档只在自定义供应商里绑（本机网关不参与兜底）：前面所有来源都失败时，用这里绑定的模型最后试一次。适合绑一个最便宜、最稳的档位。",
  testCall: "用该模型 + 指定思考强度发一次真实小请求，验证端到端可用（含上游不标准参数的自动修正）。结果在弹窗里查看。",
  quirks: "上游不标准时的自动修正：例如它不认 reasoning_effort 或 temperature，首次被拒后会被记下来，之后的调用不再发该参数，避免每次都多付一次 400 与重试。",
};

async function refresh() {
  await mem.loadAll();
  try {
    // 网关走专属「反代网关」列表，不进供应商列表（mock 数据里带 gw-local，真实后端不带）
    providers.value = ((await api.memoryProviderList()).providers as unknown as Provider[]).filter((p) => p.id !== "gw-local");
  } catch (e) {
    ElMessage.error((e as Error).message || "读取供应商失败");
  }
  try {
    models.value = (await api.memoryModelList()).models as unknown as Model[];
  } catch {
    /* 忽略 */
  }
  try {
    routing.value = (await api.memoryLlmRouting()).routing as unknown as Routing[];
  } catch {
    /* 忽略 */
  }
  try {
    sources.value = (await api.memoryLlmSources()) as unknown as SourcesState;
  } catch {
    /* 忽略 */
  }
  try {
    gateways.value = (await api.memoryGatewayList()).gateways;
  } catch {
    /* 忽略 */
  }
}

function openDrawer(p?: Provider) {
  form.value = p
    ? { id: p.id, name: p.name, baseUrl: p.baseUrl, apiFormat: p.apiFormat, apiKey: "", note: p.note, enabled: p.enabled, kind: p.kind }
    : { id: "", name: "", baseUrl: "", apiFormat: "chat_completions", apiKey: "", note: "", enabled: true, kind: "custom" };
  keyVisible.value = false;
  fetchResult.value = null;
  drawer.value = true;
}

/** 弹窗里正在编辑的供应商实体（新建时为 null）：模型列表与拉取/试调都从它取 providerId */
const editingProvider = computed(() => providers.value.find((x) => x.id === form.value.id) || null);

async function saveProvider() {
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    ElMessage.warning("名称与 Base URL 必填");
    return;
  }
  busy.value = "save";
  try {
    await api.memoryProviderSave({ ...form.value });
    ElMessage.success("已保存");
    drawer.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    busy.value = "";
  }
}

async function removeProvider(p: Provider) {
  try {
    await ElMessageBox.confirm(`删除供应商「${p.name}」会连带删除其下全部模型配置（记忆数据不受影响）`, "删除供应商", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryProviderDelete(p.id);
    if (form.value.id === p.id) drawer.value = false;
    ElMessage.success("已删除");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

/** 列表行内启用/停用（即时生效）。停用的供应商不参与任何模型调用，
 *  视觉上整行弱化 + 名称旁带「已停用」chip，避免"以为在跑其实早停了"。
 *  先乐观翻转再落盘：落在路上的时间太长时开关不能"点了没反应"；
 *  同时串行化（一次只放行一个开关动作），否则往返期间连点两下会按同一份旧状态算，第二次被吞。 */
const toggling = ref("");
async function toggleProvider(p: Provider) {
  if (toggling.value) return;
  const next = !p.enabled;
  toggling.value = p.id;
  p.enabled = next;
  try {
    await api.memoryProviderToggle(p.id, next);
    ElMessage.success(next ? `已启用「${p.name}」` : `已停用「${p.name}」：不再参与模型调用`);
    await refresh();
  } catch (e) {
    p.enabled = !next; // 失败回滚，别把界面停在假状态
    ElMessage.error((e as Error).message || "切换失败");
  } finally {
    toggling.value = "";
  }
}

async function testProvider(p: Provider) {
  busy.value = p.id;
  testResult.value = null;
  try {
    const r = await api.memoryProviderTest(p.id);
    testResult.value = { providerId: p.id, ...(r as any) };
    ElMessage[r.l3.ok ? "success" : "warning"](r.l3.ok ? "三级全部通过" : "测试未全通过，见结果弹窗");
    testOpen.value = true;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "测试失败");
  } finally {
    busy.value = "";
  }
}

async function applySuggestion(apiFormat: string) {
  const id = testResult.value?.providerId;
  const p = providers.value.find((x) => x.id === id);
  if (!p) return;
  try {
    await api.memoryProviderSave({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiFormat, note: p.note, enabled: p.enabled, kind: p.kind });
    ElMessage.success(`已改为 ${apiFormat}，请重新测试`);
    await testProvider(p);
  } catch (e) {
    ElMessage.error((e as Error).message || "修改失败");
  }
}

async function fetchModels(p: Provider) {
  busy.value = `fetch-${p.id}`;
  try {
    const r = await api.memoryProviderFetchModels(p.id);
    fetchResult.value = { id: p.id, list: r.models };
    ElMessage.success(`拉取到 ${r.models.length} 个模型，点标签即可加入模型池`);
  } catch (e) {
    ElMessage.error((e as Error).message || "拉取失败（该端点可能不提供 /models，改用手动添加）");
  } finally {
    busy.value = "";
  }
}

const addingFetched = ref(false);
async function addFetched(list: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string } }[]) {
  if (!fetchResult.value || addingFetched.value) return; // 防连点并发跑两遍
  addingFetched.value = true;
  const providerId = fetchResult.value.id;
  let added = 0;
  let failed = 0;
  try {
    for (const m of list) {
      if (models.value.some((x) => x.providerId === providerId && x.modelId === m.id)) continue;
      try {
        await api.memoryModelSave({ providerId, modelId: m.id, tags: m.tags, reasoning: m.reasoning, priority: 10 + added * 10 });
        added++;
      } catch {
        failed++;
      }
    }
    if (failed) ElMessage.warning(`加入 ${added} 个模型，${failed} 个失败`);
    else ElMessage.success(`加入 ${added} 个模型`);
    fetchResult.value = null;
    await refresh();
  } finally {
    addingFetched.value = false;
  }
}

async function addManual(providerId: string) {
  let modelId = "";
  try {
    const r = await ElMessageBox.prompt("上游真实模型 id（如 gpt-4o-mini）", "手动添加模型", { inputPlaceholder: "gpt-4o-mini" });
    modelId = (r.value || "").trim();
  } catch {
    return;
  }
  if (!modelId) return;
  try {
    await api.memoryModelSave({ providerId, modelId });
    ElMessage.success(`已添加 ${modelId}（标签与思考强度已按模型名预填，可再改）`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "添加失败");
  }
}

async function toggleModel(m: Model) {
  try {
    await api.memoryModelToggle(m.id, !m.enabled);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "切换失败");
  }
}

async function setEffort(m: Model, effort: string, customBudget?: number) {
  try {
    await api.memoryModelSave({
      id: m.id, providerId: m.providerId, modelId: m.modelId, displayName: m.displayName,
      enabled: m.enabled, tags: m.tags, priority: m.priority, temperature: m.temperature, maxTokens: m.maxTokens,
      reasoning: { enabled: effort !== "off", effort, customBudget: customBudget ?? m.reasoning.customBudget },
    });
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function setTags(m: Model) {
  let value = "";
  try {
    const r = await ElMessageBox.prompt(`用途标签，逗号分隔。可用：${sources.value.tagDefs.join(" / ")}`, "设置标签", { inputValue: m.tags.join(", ") });
    value = r.value || "";
  } catch {
    return;
  }
  const tags = value.split(/[,，\s]+/).filter(Boolean);
  try {
    await api.memoryModelSave({ id: m.id, providerId: m.providerId, modelId: m.modelId, displayName: m.displayName, enabled: m.enabled, tags, priority: m.priority, reasoning: m.reasoning });
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function setPriority(m: Model) {
  let n: number;
  try {
    const r = await ElMessageBox.prompt("优先级（越小越优先，同标签内排序用）", "设置优先级", { inputValue: String(m.priority) });
    n = Number(r.value);
  } catch {
    return; // 用户取消
  }
  if (!Number.isFinite(n)) return;
  // 保存失败要显式报错：此前与「用户取消」共用一个 catch，后端 ok:false 被静默吞掉
  try {
    await api.memoryModelSave({ id: m.id, providerId: m.providerId, modelId: m.modelId, displayName: m.displayName, enabled: m.enabled, tags: m.tags, priority: n, reasoning: m.reasoning });
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

/** 打开模型级二级弹窗：快照当前模型，改完点保存一次性提交（含温度/maxTokens，
 *  否则后端 saveModel 会把未传的这两项重置回默认值） */
function openModelEditor(m: Model) {
  modelForm.value = {
    id: m.id,
    providerId: m.providerId,
    modelId: m.modelId,
    displayName: m.displayName || m.modelId,
    enabled: m.enabled,
    effort: m.reasoning.effort || "minimal",
    // custom 档没填过预算时 UI 显示 4096，快照也要取同一个值，否则"显示 4096 却存 null"
    customBudget: m.reasoning.customBudget ?? (m.reasoning.effort === "custom" ? 4096 : null),
    tagsText: m.tags.join(", "),
    priority: m.priority,
    temperature: m.temperature,
    maxTokens: m.maxTokens,
    caps: m.caps,
  };
  modelOpen.value = true;
}

async function saveModelEdit() {
  const f = modelForm.value;
  // 数字字段被清空时（v-model.number 给回空串）回落到默认值，避免把 0 当"用户想要的值"写进去
  const numOr = (v: unknown, def: number) => (v === "" || v == null || !Number.isFinite(Number(v)) ? def : Number(v));
  busy.value = "model-save";
  try {
    await api.memoryModelSave({
      id: f.id,
      providerId: f.providerId,
      modelId: f.modelId,
      displayName: f.displayName.trim() || f.modelId,
      enabled: f.enabled,
      tags: f.tagsText.split(/[,，\s]+/).filter(Boolean),
      priority: numOr(f.priority, 10),
      temperature: numOr(f.temperature, 0.2),
      maxTokens: numOr(f.maxTokens, 2048),
      // 弹窗里切到 custom 却没碰预算时，UI 显示的就是 4096，落盘也取同一个值
      reasoning: { enabled: f.effort !== "off", effort: f.effort, customBudget: f.customBudget ?? (f.effort === "custom" ? 4096 : null) },
      caps: f.caps,
    });
    ElMessage.success("模型已更新");
    modelOpen.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    busy.value = "";
  }
}

/** 批量启停（按供应商）：模型池一次拉几十个时，逐个点开关太费事 */
async function batchModels(providerId: string, op: "enable" | "disable") {
  const ids = modelsOf(providerId).map((m) => m.id);
  if (!ids.length) return;
  busy.value = `batch-${providerId}`;
  try {
    const r = await api.memoryModelBatch(ids, op);
    ElMessage.success(`已${op === "enable" ? "全部启用" : "全部停用"} ${r.changed} 个模型`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "批量操作失败");
  } finally {
    busy.value = "";
  }
}

async function removeModel(m: Model) {
  // 图标按钮比文字按钮更容易误点，删模型不可撤销，必须过一道确认
  try {
    await ElMessageBox.confirm(`删除模型「${m.modelId}」？只从模型池移除，不影响上游`, "删除模型", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryModelDelete(m.id);
    ElMessage.success("已删除");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function saveOrder(order: string[]) {
  try {
    await api.memoryLlmSourcesSave({ order });
    ElMessage.success("来源优先级已保存");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

// 拖动排序：dragover 落到哪个条目上就插到它前面，拖到最后一个的下半区则排尾
const dragKey = ref("");
function onSourceDrop(target: string, after: boolean) {
  const key = dragKey.value;
  dragKey.value = "";
  if (!key || key === target) return;
  const order = sources.value.order.filter((k) => k !== key);
  let i = order.indexOf(target);
  if (i < 0) return;
  if (after) i += 1;
  order.splice(i, 0, key);
  void saveOrder(order);
}

function resetOrder() {
  void saveOrder([...DEFAULT_ORDER]);
}

// ---- 任务级路由编辑：绑定网关/供应商、指定模型、任务标签、任务思考强度 ----
const degradeCfg = computed<DegradeCfg>(() => sources.value.degrade || {});
const degradeOn = computed(() => degradeCfg.value.enabled !== false);
const degradeBound = computed(() => !!(degradeCfg.value.providerId && degradeCfg.value.modelId));
const degradeLabel = computed(() => (degradeBound.value ? `${providerNameOf(degradeCfg.value.providerId!)}/${degradeCfg.value.modelId}` : ""));

function providerNameOf(pid: string) {
  if (pid === "gw-local") return "本机反代网关";
  return providers.value.find((p) => p.id === pid)?.name || pid;
}

/** 指定模型下拉的候选：绑定了供应商就只列它名下启用的模型，否则列全部启用的模型 */
function modelsForRoute(r: Routing) {
  const pool = r.providerId ? modelsOf(r.providerId) : models.value;
  return pool.filter((m) => m.enabled);
}

/**
 * 任务级路由统一保存口。后端 saveSources 对 routing/taskEffort 是整键替换，所以每次带全量；
 * routing 以 sources().routing 的原始条目为基底增量改（预览行的 tags 可能来自默认映射，不能照抄固化）。
 */
async function saveRouting(task: string, patch: { providerId?: string; modelId?: string; tags?: string[]; effort?: string }) {
  const routes: RouteEntry[] = (sources.value.routing || []).map((r) => ({ ...r }));
  let entry = routes.find((r) => r.task === task);
  if (!entry) {
    entry = { task };
    routes.push(entry);
  }
  if (patch.providerId !== undefined) { if (patch.providerId) entry.providerId = patch.providerId; else delete entry.providerId; }
  if (patch.modelId !== undefined) { if (patch.modelId) entry.modelId = patch.modelId; else delete entry.modelId; }
  if (patch.tags) { if (patch.tags.length) entry.tags = patch.tags; else delete entry.tags; }
  const taskEffort = { ...(sources.value.taskEffort || {}) };
  if (patch.effort !== undefined) { if (patch.effort) taskEffort[task] = patch.effort; else delete taskEffort[task]; }
  busy.value = `route-${task}`;
  try {
    await api.memoryLlmSourcesSave({ routing: routes, taskEffort });
    // 先回读降级链再提示：链列显示的是实际解析结果，必须跟着这次保存一起更新
    await refresh();
    ElMessage.success(`「${taskLabel(task)}」路由已更新`);
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    busy.value = "";
  }
}

/** 换绑定供应商时，原指定模型若不在新供应商名下则一并清掉，避免存一个永远匹配不到的模型 */
function onPinProvider(r: Routing, pid: string) {
  const patch: { providerId: string; modelId?: string } = { providerId: pid };
  const pool = pid ? modelsOf(pid) : models.value;
  if (r.modelId && !pool.some((m) => m.modelId === r.modelId)) patch.modelId = "";
  void saveRouting(r.task, patch);
}

async function setRouteTags(r: Routing) {
  let value = "";
  try {
    const res = await ElMessageBox.prompt(
      `该任务从带这些标签的启用模型里挑，逗号分隔。可用：${sources.value.tagDefs.join(" / ")}。留空恢复默认。`,
      `设置「${taskLabel(r.task)}」的任务标签`,
      { inputValue: r.tags.join(", ") },
    );
    value = res.value || "";
  } catch {
    return; // 用户取消
  }
  void saveRouting(r.task, { tags: value.split(/[,，\s]+/).filter(Boolean) });
}

/** 兜底降级配置（后端只在自定义供应商里找兜底模型，本机网关不参与兜底档） */
async function saveDegrade(patch: { enabled?: boolean; providerId?: string; modelId?: string; effort?: string }) {
  const d: DegradeCfg = { ...degradeCfg.value };
  if (patch.enabled !== undefined) d.enabled = patch.enabled;
  if (patch.providerId !== undefined) { if (patch.providerId) d.providerId = patch.providerId; else delete d.providerId; }
  if (patch.modelId !== undefined) { if (patch.modelId) d.modelId = patch.modelId; else delete d.modelId; }
  if (patch.effort !== undefined) d.effort = patch.effort;
  try {
    await api.memoryLlmSourcesSave({ degrade: d });
    await refresh();
    ElMessage.success("兜底降级已保存");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

function onDegradeProvider(pid: string) {
  const patch: { providerId: string; modelId?: string } = { providerId: pid };
  if (degradeCfg.value.modelId && !modelsOf(pid).some((m) => m.modelId === degradeCfg.value.modelId)) patch.modelId = "";
  void saveDegrade(patch);
}

// ---- 网关详情弹窗：列表点行进详情，模型池按 providerId=gw-local 过滤 ----
const gwDetail = ref<Gateway | null>(null);
const gwUrlDraft = ref("");
/** 网关不是落库的供应商：合成一个 Provider 形态给 fetchModels/testCall 复用（后端按 id=gw-local 特判） */
const gwPseudo = computed<Provider>(() => ({
  id: gwDetail.value?.id || "gw-local",
  name: gwDetail.value?.name || "本机网关",
  kind: "gateway",
  baseUrl: gwDetail.value?.baseUrl || "",
  apiFormat: "chat_completions",
  apiKeyMasked: "",
  hasKey: false,
  enabled: true,
  note: "",
  status: gwDetail.value?.available ? "online" : "offline",
  lastCheck: null,
  modelCount: gwDetail.value?.modelCount || 0,
  enabledModelCount: gwDetail.value?.enabledModelCount || 0,
  isGateway: true,
}));

function openGateway(g: Gateway) {
  gwDetail.value = g;
  gwUrlDraft.value = g.urlOverride;
}

async function saveGatewayUrl() {
  try {
    await api.memoryConfigSave({ "models.gatewayUrl": gwUrlDraft.value.trim() });
    ElMessage.success("网关地址已保存");
    await refresh();
    const g = gateways.value.find((x) => x.id === gwDetail.value?.id);
    if (g) gwDetail.value = g;
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function testCall(p: Provider, m?: Model) {
  busy.value = `call-${p.id}`;
  callCtx.value = { providerName: p.name, modelId: m?.modelId };
  callResult.value = null;
  try {
    const r = await api.memoryLlmTestCall(p.id, m ? m.modelId : undefined, m ? m.reasoning.effort : undefined);
    callResult.value = r as CallResult;
    ElMessage[r.ok ? "success" : "error"](r.ok ? "真实调用成功" : "调用失败，见结果弹窗");
  } catch (e) {
    callResult.value = { ok: false, message: (e as Error).message || "调用失败" };
    ElMessage.error(callResult.value.message);
  } finally {
    busy.value = "";
    callOpen.value = true;
  }
}

/** 三级测试弹窗标题里的供应商名（测试结果快照带 providerId，名字现查） */
const testProviderName = computed(() => {
  const id = testResult.value?.providerId;
  if (!id) return "";
  return providers.value.find((p) => p.id === id)?.name || "已删除的供应商";
});

/** 测试结果弹窗里的「重新测试」 */
function retest() {
  const id = testResult.value?.providerId;
  const p = providers.value.find((x) => x.id === id);
  if (p) void testProvider(p);
}

/** 模板回调里丢失 v-if 窄化，格式标签统一走这里 */
function formatLabelOf(p: Provider | null) {
  if (!p) return "";
  return FORMATS.find((f) => f.id === p.apiFormat)?.label || p.apiFormat;
}

/** 「重新测试」按钮显隐：捕获局部变量规避回调窄化 */
const canRetest = computed(() => {
  const t = testResult.value;
  return !!t && providers.value.some((x) => x.id === t.providerId);
});

/** 模型行的能力 chips：上下文窗口与视觉能力来自 caps（拉取/添加时按模型名预判，可被能力探测刷新） */
function ctxLabel(m: Model) {
  return fmtCtx(m.caps?.contextWindow);
}

const modelsOf = (providerId: string) => models.value.filter((m) => m.providerId === providerId);

/** 供应商列表「模型」列的简略展示：前三个模型 id + 其余数量。
 *  computed 一次算完全部供应商——模板里每行 4 处取直值（O(1) 属性访问），
 *  不再像函数版那样每渲染每行重复 filter/map/slice/join（模型池大时整表重渲染卡顿） */
const MODEL_BRIEF = 3;
const briefByProvider = computed<Record<string, { shown: string[]; rest: number; all: string }>>(() => {
  const map: Record<string, { shown: string[]; rest: number; all: string }> = {};
  for (const p of providers.value) {
    const ids = modelsOf(p.id).map((m) => m.modelId);
    map[p.id] = { shown: ids.slice(0, MODEL_BRIEF), rest: Math.max(0, ids.length - MODEL_BRIEF), all: ids.join("、") };
  }
  return map;
});

/** 供应商列表「调用信息」列的状态文案 */
function statusText(p: Provider) {
  if (p.status === "online") return "在线";
  if (p.status === "offline") return "离线";
  if (p.status === "rate_limited") return "限流";
  return "未测试";
}

onMounted(refresh);
</script>

<template>
  <div class="mem-col">
    <div class="mem-row">
      <span class="mem-hint" style="flex: 1">
        记忆模块的 AI 处理（摘要/打标/去重/蒸馏/画像）都从这里取模型；调用统计见「仪表盘 · 模型调用统计」。
      </span>
      <button class="btn btn-cta" @click="openDrawer()">＋ 添加供应商</button>
      <button class="btn btn-ghost" @click="refresh">刷新全部状态</button>
    </div>

    <!-- 模型来源优先级：左侧小卡拖排序，右侧说明与操作 -->
    <div class="mem-card">
      <div class="mem-card-title">
        模型来源优先级
        <span class="mem-hint">拖动左侧小卡调整顺序：靠前者优先尝试</span>
        <MemHelp :text="HELP.sources" />
      </div>
      <div class="mem-src-grid">
        <div class="mem-src-list">
          <div
            v-for="(key, i) in sources.order"
            :key="key"
            class="mem-chain-node mem-draggable mem-src-item"
            :class="{ 'is-dragging': dragKey === key }"
            draggable="true"
            @dragstart="dragKey = key"
            @dragend="dragKey = ''"
            @dragover.prevent
            @drop.prevent="onSourceDrop(key, false)"
          >
            <el-tooltip content="拖动排序" placement="top">
              <span class="mem-drag-handle">⠿</span>
            </el-tooltip>
            <span class="mem-chip accent">{{ i + 1 }}</span>
            <span class="si-body">
              <b>{{ sourceName(key) }}</b>
              <small>{{ sourceDesc(key) }}</small>
            </span>
            <el-tooltip v-if="key === 'degrade'" :content="degradeLabel" placement="top">
              <span class="mem-chip" :class="degradeBound ? 'accent' : 'warn'" style="margin-left: auto">
                {{ degradeBound ? `兜底：${degradeLabel}` : "未绑定模型（不生效）" }}
              </span>
            </el-tooltip>
          </div>
        </div>
        <div class="mem-src-side">
          <p class="mem-hint">{{ HELP.sources }}</p>
          <div class="mem-row">
            <button class="btn btn-ghost" @click="app.selectModule('proxy')">去反代网关页</button>
            <button class="btn btn-ghost" @click="resetOrder">恢复默认顺序</button>
          </div>
          <p class="mem-hint">
            「本机网关」由反代网关模块提供，未启动时自动跳到下一个来源；改完顺序立即生效。
          </p>
        </div>
      </div>
      <!-- 兜底降级绑定：前面所有来源都失败时最后试一次的专用供应商+模型 -->
      <div class="mem-row" style="margin-top: 10px; gap: 6px; flex-wrap: wrap; align-items: center">
        <span class="mem-hint" style="font-weight: 600">兜底降级</span>
        <el-tooltip content="兜底档开关" placement="top">
          <div class="switch" :class="{ on: degradeOn }" role="switch" :aria-checked="degradeOn" @click="saveDegrade({ enabled: !degradeOn })"></div>
        </el-tooltip>
        <MemSelect
          :model-value="degradeCfg.providerId || ''"
          width="190px"
          placeholder="绑定供应商…"
          :options="degradeProviderOptions"
          @change="(v: string | number) => onDegradeProvider(String(v))"
        />
        <MemSelect
          :model-value="degradeCfg.modelId || ''"
          width="190px"
          placeholder="绑定模型…"
          :disabled="!degradeCfg.providerId"
          :options="degradeModelOptions"
          @change="(v: string | number) => saveDegrade({ modelId: String(v) })"
        />
        <MemSelect
          :model-value="degradeCfg.effort || 'minimal'"
          width="130px"
          :options="routeEffortOptions"
          @change="(v: string | number) => saveDegrade({ effort: String(v) })"
        />
        <MemHelp :text="HELP.degrade" />
      </div>
    </div>

    <!-- 自定义供应商：紧凑列表（名称 / 调用信息 / 模型 / 连接测试·编辑·删除·启用开关） -->
    <div class="mem-card">
      <div class="mem-card-title">
        自定义供应商
        <span class="mem-hint">{{ providers.length }} 个 · 「编辑」里管理模型与思考强度</span>
      </div>
      <div class="mem-table-wrap">
        <table class="mem-table mem-table-list prov-tbl">
          <thead>
            <tr>
              <th>名称</th>
              <th>调用信息</th>
              <th>模型</th>
              <th class="th-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in providers" :key="p.id" :class="{ 'is-off': !p.enabled }">
              <td>
                <span class="p-name">
                  <span class="mem-dot" :class="p.status === 'online' ? 'ok' : p.status === 'offline' ? 'bad' : 'warn'"></span>
                  <b>{{ p.name }}</b>
                  <!-- 停用态必须显式标出：否则"路由里没它"会被当成配置丢了 -->
                  <span v-if="!p.enabled" class="mem-chip warn">已停用</span>
                </span>
                <small class="p-sub">{{ formatLabelOf(p) }}</small>
              </td>
              <td>
                <span class="p-call">
                  <span class="mem-chip" :class="p.status === 'online' ? 'accent' : p.status === 'offline' ? 'danger' : ''">{{ statusText(p) }}</span>
                  <span v-if="p.lastCheck" class="mem-hint">上次测试 {{ timeAgo(p.lastCheck.at) }}<template v-if="p.lastCheck.latencyMs"> · {{ p.lastCheck.latencyMs }}ms</template></span>
                  <span v-else class="mem-hint">还没测过</span>
                </span>
              </td>
              <td>
                <el-tooltip :content="briefByProvider[p.id]?.all || ''" :disabled="!briefByProvider[p.id]?.all" placement="top">
                  <span class="p-models">
                    <span v-for="mid in briefByProvider[p.id]?.shown || []" :key="mid" class="mem-chip mem-mono">{{ mid }}</span>
                    <span v-if="(briefByProvider[p.id]?.rest || 0) > 0" class="mem-chip">+{{ briefByProvider[p.id]?.rest }}</span>
                    <span v-if="!(briefByProvider[p.id]?.shown || []).length" class="mem-hint">暂无模型</span>
                  </span>
                </el-tooltip>
              </td>
              <td class="actions">
                <el-tooltip :content="HELP.test" placement="top">
                  <button class="btn-link" :disabled="busy === p.id" @click="testProvider(p)">{{ busy === p.id ? "测试中…" : "连接测试" }}</button>
                </el-tooltip>
                <button class="btn-link" @click="openDrawer(p)">编辑</button>
                <button class="btn-link danger" @click="removeProvider(p)">删除</button>
                <el-tooltip :content="p.enabled ? '已启用：点击停用，停用后不参与任何模型调用' : '已停用：点击重新启用'" placement="top">
                  <div
                    class="switch"
                    :class="{ on: p.enabled, pending: toggling === p.id }"
                    role="switch"
                    :aria-checked="p.enabled"
                    @click="toggleProvider(p)"
                  ></div>
                </el-tooltip>
              </td>
            </tr>
            <tr v-if="!providers.length">
              <td colspan="4" class="mem-empty">还没有供应商 —— 点右上「＋ 添加供应商」，配好 Base URL 与 Key 后再拉取模型</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 反代网关列表：点行看详情（地址覆盖 + 该网关下的模型与思考强度） -->
    <div class="mem-card">
      <div class="mem-card-title">
        反代网关
        <span class="mem-hint">{{ gateways.length }} 个 · 点击查看详情</span>
      </div>
      <div class="mem-col" style="gap: 6px">
        <div v-for="g in gateways" :key="g.id" class="mem-chain-node" style="cursor: pointer" @click="openGateway(g)">
          <span class="mem-dot" :class="g.available ? 'ok' : 'bad'"></span>
          <span style="font-weight: 600">{{ g.name }}</span>
          <span class="mem-mono mem-hint">{{ g.baseUrl || "—" }}</span>
          <span style="margin-left: auto" class="mem-chip" :class="g.available ? 'accent' : 'warn'">
            {{ g.available ? `${g.enabledModelCount}/${g.modelCount} 个模型启用` : "网关未运行" }}
          </span>
        </div>
        <div v-if="!gateways.length" class="mem-empty">未发现可用网关 —— 请到「反代网关」模块启动</div>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        按标签的路由与降级链
        <span class="mem-hint">每行可绑定指定网关/供应商与模型；不绑定则按来源优先级在匹配标签的启用模型里挑</span>
        <MemHelp :text="HELP.routingEdit" />
      </div>
      <div class="mem-table-wrap">
        <table class="mem-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>绑定网关/供应商</th>
              <th>指定模型</th>
              <th>标签</th>
              <th>思考强度</th>
              <th>降级链（按优先级）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in routing" :key="r.task">
              <td>{{ taskLabel(r.task) }}</td>
              <td>
                <MemSelect
                  :model-value="r.providerId || ''"
                  width="170px"
                  placeholder="全部（按来源优先级）"
                  :disabled="busy === `route-${r.task}`"
                  :options="routeProviderOptions(r)"
                  @change="(v: string | number) => onPinProvider(r, String(v))"
                />
              </td>
              <td>
                <MemSelect
                  :model-value="r.modelId || ''"
                  width="190px"
                  placeholder="不限（按标签+优先级）"
                  :disabled="busy === `route-${r.task}`"
                  :options="routeModelOptions(r)"
                  @change="(v: string | number) => saveRouting(r.task, { modelId: String(v) })"
                />
                <!-- 绑了一个用不了的模型：说清是哪种用不了，否则用户只会看到「绑了没反应」 -->
                <span v-if="r.modelState && r.modelState !== 'ok'" class="mem-chip danger" style="margin-left: 6px">
                  {{ r.modelState === "missing" ? "该模型已不存在" : r.modelState === "disabled" ? "该模型已停用" : "该模型所属供应商已停用" }}，指定不生效
                </span>
              </td>
              <td>
                <el-tooltip content="点击编辑任务标签" placement="top">
                  <button class="btn-link" @click="setRouteTags(r)">{{ r.tags.map(taskLabelZh).join("、") }}</button>
                </el-tooltip>
              </td>
              <td>
                <MemSelect
                  :model-value="r.effort || ''"
                  width="140px"
                  placeholder="（用模型默认）"
                  :disabled="busy === `route-${r.task}`"
                  :options="[{ value: '', label: '（用模型默认）' }, ...routeEffortOptions]"
                  @change="(v: string | number) => saveRouting(r.task, { effort: String(v) })"
                />
              </td>
              <td>
                <template v-if="r.chain.length">
                  <span v-for="(c, i) in r.chain" :key="i" class="mem-chip" :class="i === 0 ? 'accent' : ''">{{ i + 1 }}. {{ c.providerName }}/{{ c.modelId }}</span>
                  <!-- 兜底链：任务能用，但提醒换更强模型效果更好（行内小问号给完整说明） -->
                  <template v-if="r.tagFallback">
                    <span class="mem-chip warn" style="margin-left: 6px">已兜底</span>
                    <MemHelp :text="fallbackHint(r)" />
                  </template>
                </template>
                <!-- 空链要给出路，不能只丢一句「无可用模型」：要么给模型补标签，要么在这一行直接指定模型 -->
                <el-tooltip v-else :content="chainHint(r)" placement="top">
                  <span class="mem-chip warn">无可用模型：{{ chainHint(r) }}</span>
                </el-tooltip>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mem-hint" style="margin-top: 8px">链怎么看：{{ HELP.routing }}<br />上游不标准时的自动修正：<MemHelp :text="HELP.quirks" /></div>
    </div>

    <!-- 供应商编辑弹窗：连接信息（Base URL / API 格式 / API Key / 备注）+ 模型列表。
         模型行的连接测试 / 编辑 / 删除 / 开关都在行内，编辑走二级小弹窗；
         本弹窗的字段改动统一走底部「保存」（开关也一样，避免"改了一半已生效"的混合语义）。 -->
    <MemDialog v-model:open="drawer" title="供应商" width="720px">
      <template #header>
        <div>
          <div class="prov-edit-head">
            <i class="ph ph-cube prov-edit-icon"></i>
            <input v-model="form.name" class="prov-name-input" placeholder="供应商名称" />
            <el-tooltip :content="form.enabled ? '已启用：点「保存」后生效为停用' : '已停用：点「保存」后不参与任何模型调用'" placement="top">
              <div class="switch" :class="{ on: form.enabled }" role="switch" :aria-checked="!!form.enabled" @click="form.enabled = !form.enabled"></div>
            </el-tooltip>
          </div>
          <div class="md-sub">{{ form.id ? "编辑供应商：改动点「保存」生效；模型行的操作即时生效" : "自定义供应商走自备 Key；Key 明文存本机配置，界面只显掩码" }}</div>
        </div>
      </template>
      <div class="mem-col">
        <div class="mem-section">
          <div class="s-title">Base URL</div>
          <input v-model="form.baseUrl" class="f-input" placeholder="https://api.example.com（程序自动补 /v1 路径）" />
        </div>
        <div class="mem-section">
          <div class="s-title">API 格式<MemHelp :text="HELP.format" /></div>
          <MemSelect
            :model-value="form.apiFormat"
            width="100%"
            :options="formatOptions"
            @change="(v: string | number) => (form.apiFormat = String(v))"
          />
          <div class="mem-hint">{{ formatDesc(form.apiFormat) }}。选错会导致 404/400，三级测试会自动校验并提示正确格式。</div>
        </div>
        <div class="mem-section">
          <div class="s-title">
            API Key<MemHelp :text="HELP.key" />
            <!-- 掩码不回填输入框（留空＝不动原 Key），但状态要看得见，否则用户以为 Key 丢了 -->
            <span v-if="editingProvider" class="mem-chip" :class="editingProvider.hasKey ? '' : 'warn'" style="margin-left: 6px; text-transform: none">
              {{ editingProvider.hasKey ? `已保存 ${editingProvider.apiKeyMasked}` : "未设置" }}
            </span>
          </div>
          <div class="prov-key-row">
            <input
              v-model="form.apiKey"
              :type="keyVisible ? 'text' : 'password'"
              class="f-input"
              :placeholder="form.id ? '留空则保留原 Key（界面只显掩码）' : '粘贴 Key（明文存本机配置，界面只显掩码）'"
            />
            <el-tooltip :content="keyVisible ? '隐藏 Key' : '显示 Key'" placement="top">
              <button class="icon-btn" type="button" @click="keyVisible = !keyVisible">
                <i class="ph" :class="keyVisible ? 'ph-eye-slash' : 'ph-eye'"></i>
              </button>
            </el-tooltip>
          </div>
        </div>
        <div class="mem-section">
          <div class="s-title">备注</div>
          <input v-model="form.note" class="f-input" placeholder="可选" />
        </div>

        <!-- 模型列表：挂在供应商 id 上，所以新建时还没有（保存后再进来配） -->
        <template v-if="editingProvider">
          <div class="prov-models">
            <div class="pm-head">
              <span class="pm-title">模型列表</span>
              <span class="mem-hint">{{ modelsOf(editingProvider.id).length }} 个 · {{ modelsOf(editingProvider.id).filter((m) => m.enabled).length }} 个启用</span>
              <!-- 拉取一批模型后逐个点开关太费事，超过一个模型就给一键启停 -->
              <span v-if="modelsOf(editingProvider.id).length > 1" class="pm-bulk">
                <button class="btn-link" :disabled="busy === `batch-${editingProvider.id}`" @click="batchModels(editingProvider.id, 'enable')">全部启用</button>
                <button class="btn-link" :disabled="busy === `batch-${editingProvider.id}`" @click="batchModels(editingProvider.id, 'disable')">全部停用</button>
              </span>
              <span class="pm-head-ops">
                <button class="btn btn-ghost" @click="addManual(editingProvider.id)">＋ 添加模型</button>
                <button class="btn btn-ghost" :disabled="busy === `fetch-${editingProvider.id}`" @click="fetchModels(editingProvider)">
                  <i class="ph ph-lightning"></i>{{ busy === `fetch-${editingProvider.id}` ? "拉取中…" : "自动拉取模型" }}
                </button>
                <MemHelp :text="HELP.fetch" />
              </span>
            </div>

            <!-- 拉取结果：逐个点击或一键全部加入模型池 -->
            <div v-if="fetchResult && fetchResult.id === editingProvider.id" class="pm-fetched">
              <div class="pm-fetched-head">
                拉取到 {{ fetchResult.list.length }} 个模型，点名字加入模型池
                <button class="btn-outline sm" @click="addFetched(fetchResult.list)">全部加入</button>
                <button class="btn-link" @click="fetchResult = null">关闭</button>
              </div>
              <div class="pm-fetched-list">
                <el-tooltip v-for="fm in fetchResult.list.slice(0, 200)" :key="fm.id" :content="`标签：${fm.tags.join('/')}`" placement="top">
                  <button class="btn-link" @click="addFetched([fm])">{{ fm.id }}</button>
                </el-tooltip>
              </div>
            </div>

            <div v-if="modelsOf(editingProvider.id).length" class="pm-list">
              <div v-for="m in modelsOf(editingProvider.id)" :key="m.id" class="pm-row" :class="{ 'is-off': !m.enabled }">
                <span class="pm-name mem-mono">{{ m.modelId }}</span>
                <!-- 自定义显示名在列表里也得看得见（与上游 id 不同时才显示，避免重复占位） -->
                <span v-if="m.displayName && m.displayName !== m.modelId" class="pm-alias">{{ m.displayName }}</span>
                <span class="pm-caps">
                  <el-tooltip v-if="ctxLabel(m)" content="上下文窗口（按模型名预判，能力探测会刷新）" placement="top">
                    <span class="mem-chip">{{ ctxLabel(m) }}</span>
                  </el-tooltip>
                  <span v-if="m.caps?.vision" class="mem-chip info">视觉</span>
                </span>
                <span class="pm-ops">
                  <el-tooltip :content="HELP.testCall" placement="top">
                    <button class="btn-link" :disabled="busy === `call-${editingProvider.id}`" @click="testCall(editingProvider, m)">
                      <i class="ph ph-plugs-connected pm-ico"></i>
                    </button>
                  </el-tooltip>
                  <el-tooltip content="编辑模型：显示名 / 思考强度 / 标签 / 优先级 / 采样参数" placement="top">
                    <button class="btn-link" @click="openModelEditor(m)"><i class="ph ph-pencil-simple pm-ico"></i></button>
                  </el-tooltip>
                  <el-tooltip content="从模型池删除（不影响上游）" placement="top">
                    <button class="btn-link danger" @click="removeModel(m)"><i class="ph ph-trash pm-ico"></i></button>
                  </el-tooltip>
                  <el-tooltip :content="m.enabled ? '已启用：点击停用（立即生效）' : '已停用：点击启用（立即生效）'" placement="top">
                    <div class="switch" :class="{ on: m.enabled }" role="switch" :aria-checked="!!m.enabled" @click="toggleModel(m)"></div>
                  </el-tooltip>
                </span>
              </div>
            </div>
            <div v-else class="mem-empty">这个供应商还没有模型 —— 「自动拉取模型」或「＋ 添加模型」</div>
          </div>
        </template>
        <div v-else class="mem-hint">保存后重新打开「编辑」，即可拉取与添加模型。</div>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="busy === 'save'" @click="saveProvider">
          {{ busy === "save" ? "保存中…" : "保存" }}
        </button>
        <button class="btn btn-ghost" @click="drawer = false">取消</button>
      </template>
    </MemDialog>

    <!-- 模型二级弹窗：编辑单个模型（保存时一并带上温度/maxTokens，避免被后端默认值覆盖） -->
    <MemDialog v-model:open="modelOpen" :title="`编辑模型 · ${modelForm.modelId}`" width="560px">
      <div class="mem-col">
        <div class="mem-section">
          <div class="s-title">显示名</div>
          <input v-model="modelForm.displayName" class="f-input" :placeholder="modelForm.modelId" />
        </div>
        <div class="mem-section">
          <div class="s-title">思考强度<MemHelp :text="HELP.effort" /></div>
          <MemSelect
            :model-value="modelForm.effort"
            width="200px"
            :options="effortOptions"
            @change="(v: string | number) => (modelForm.effort = String(v))"
          />
          <input
            v-if="modelForm.effort === 'custom'"
            type="number"
            class="f-input"
            style="width: 140px"
            :value="modelForm.customBudget || 4096"
            placeholder="思考预算"
            @change="modelForm.customBudget = Number(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="mem-section">
          <div class="s-title">用途标签<MemHelp :text="HELP.tags" /></div>
          <input v-model="modelForm.tagsText" class="f-input" placeholder="逗号分隔，如 heavy, summarize" />
          <div class="mem-hint">可用标签：{{ sources.tagDefs.join(" / ") }}</div>
        </div>
        <div class="mem-row" style="gap: 12px; align-items: flex-end; flex-wrap: wrap">
          <div class="mem-section" style="width: 110px">
            <div class="s-title">优先级</div>
            <input v-model.number="modelForm.priority" type="number" class="f-input" placeholder="10" />
          </div>
          <div class="mem-section" style="width: 110px">
            <div class="s-title">温度</div>
            <input v-model.number="modelForm.temperature" type="number" step="0.1" class="f-input" placeholder="0.2" />
          </div>
          <div class="mem-section" style="width: 130px">
            <div class="s-title">最大 Tokens</div>
            <input v-model.number="modelForm.maxTokens" type="number" class="f-input" placeholder="2048" />
          </div>
          <span class="mem-hint" style="padding-bottom: 8px">优先级越小越先被选中；标签决定哪些任务能用它</span>
        </div>
        <label class="mem-row" style="gap: 8px">
          <div class="switch" :class="{ on: modelForm.enabled }" role="switch" :aria-checked="!!modelForm.enabled" @click="modelForm.enabled = !modelForm.enabled"></div>
          <span class="mem-hint">启用该模型（关闭后从所有任务的选择器里消失）</span>
        </label>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="busy === 'model-save'" @click="saveModelEdit">
          {{ busy === "model-save" ? "保存中…" : "保存" }}
        </button>
        <button class="btn btn-ghost" @click="modelOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 网关详情弹窗：连接信息 + 该网关下的模型池 -->
    <MemDialog :open="!!gwDetail" title="网关详情" width="760px" @update:open="gwDetail = null">
      <template v-if="gwDetail" #header>
        <div>
          <div class="md-title">
            <span class="mem-dot" :class="gwDetail.available ? 'ok' : 'bad'" style="margin-right: 6px"></span>{{ gwDetail.name }}
          </div>
          <div class="md-sub">本机反代网关的模型池：可用性随「反代网关」模块启停</div>
        </div>
      </template>
      <template v-if="gwDetail">
        <div class="mem-modal-body">
          <div class="mem-kv">
                <span class="k">状态</span>
                <span class="v">{{ gwDetail.available ? "运行中" : "未运行（到「反代网关」模块启动后模型才可被调用）" }}</span>
                <span class="k">地址</span>
                <span class="v"><span class="mem-mono">{{ gwDetail.baseUrl || "—" }}</span></span>
                <span class="k">地址覆盖</span>
                <span class="v mem-row" style="gap: 6px">
                  <input v-model="gwUrlDraft" class="f-input" style="max-width: 280px" placeholder="留空 = 读反代网关模块配置" />
                  <button class="btn btn-ghost" :disabled="gwUrlDraft.trim() === gwDetail.urlOverride" @click="saveGatewayUrl">保存</button>
                </span>
              </div>
              <div class="mem-row" style="margin-top: 10px; gap: 8px">
                <button class="btn btn-ghost" :disabled="busy === `fetch-${gwDetail.id}` || !gwDetail.available" @click="fetchModels(gwPseudo)">拉取模型</button>
                <button class="btn btn-ghost" :disabled="!gwDetail.available" @click="addManual(gwDetail.id)">＋ 手动添加模型</button>
                <!-- 「真实调用一次」此前不带模型，后端必返「请指定模型」；要试调请用下方模型行的按钮 -->
                <span class="mem-hint">试调用模型行上的按钮（需指定模型）</span>
              </div>

              <div v-if="fetchResult && fetchResult.id === gwDetail.id" class="mem-card" style="margin-top: 10px; background: var(--mem-soft)">
                <div class="mem-card-title">
                  拉取到 {{ fetchResult.list.length }} 个模型
                  <button class="btn-outline" @click="addFetched(fetchResult.list)">全部加入模型池</button>
                </div>
                <div class="mem-row" style="gap: 6px; max-height: 200px; overflow: auto">
                  <el-tooltip
                    v-for="m in fetchResult.list.slice(0, 200)"
                    :key="m.id"
                    :content="`标签：${m.tags.join('/')}`"
                    placement="top"
                  >
                    <button
                      class="btn-link"
                      @click="addFetched([m])"
                    >
                      {{ m.id }}
                    </button>
                  </el-tooltip>
                </div>
              </div>

              <div class="mem-table-wrap" style="margin-top: 12px">
                <table class="mem-table">
                  <thead>
                    <tr>
                      <th>模型 ID</th>
                      <th>开关</th>
                      <th>思考强度 <MemHelp :text="HELP.effort" /></th>
                      <th>标签 <MemHelp :text="HELP.tags" /></th>
                      <th>优先级</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="m in modelsOf(gwDetail.id)" :key="m.id">
                      <td class="mem-mono">{{ m.modelId }}</td>
                      <td><div class="switch" :class="{ on: m.enabled }" role="switch" :aria-checked="!!m.enabled" @click="toggleModel(m)"></div></td>
                      <td>
                        <MemSelect
                          :model-value="m.reasoning.effort"
                          width="150px"
                          :options="effortOptions"
                          @change="(v: string | number) => setEffort(m, String(v))"
                        />
                      </td>
                      <td><button class="btn-link" @click="setTags(m)">{{ m.tags.join(", ") || "（未打标）" }}</button></td>
                      <td><button class="btn-link" @click="setPriority(m)">{{ m.priority }}</button></td>
                      <td>
                        <button class="btn-link" @click="testCall(gwPseudo, m)">试调</button>
                        <button class="btn-link danger" @click="removeModel(m)">删除</button>
                      </td>
                    </tr>
                    <tr v-if="!modelsOf(gwDetail.id).length">
                      <td colspan="6" class="mem-empty">网关下还没有模型 —— 「拉取模型」或「手动添加模型」</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="mem-hint" style="margin-top: 8px">
            网关模型即「模型来源优先级」中本机网关一档的候选池；模型池为空时回退到反代网关设置里的「全局统一回退模型」{{ gwDetail.fallbackModel ? `（当前：${gwDetail.fallbackModel}）` : "（当前未设置，建议到反代网关设置里配一个）" }}。
          </div>
        </div>
      </template>
    </MemDialog>

    <!-- 三级连接测试结果弹窗 -->
    <MemDialog :open="testOpen" :title="`三级连接测试 · ${testProviderName}`" sub="① 连通 → ② 鉴权 → ③ 格式能力，第三级最关键" @update:open="testOpen = false">
      <div class="mem-col">
        <template v-if="testResult">
          <div class="mem-kv">
            <span class="k">① 连通</span>
            <span class="v">{{ testResult.l1.ok ? `✓ ${testResult.l1.latencyMs}ms` : `✗ ${testResult.l1.message}` }}</span>
            <span class="k">② 鉴权</span>
            <span class="v">{{ testResult.l2.ok ? `✓ ${testResult.l2.message}` : `✗ ${testResult.l2.message}` }}</span>
            <span class="k">③ 格式能力</span>
            <span class="v">{{ testResult.l3.ok ? `✓ ${testResult.l3.message}` : `✗ ${testResult.l3.message}` }}</span>
          </div>
          <div v-if="testResult.suggestion" class="mem-banner">
            ⚠️ {{ testResult.suggestion.reason }}
            <button class="btn-outline" @click="applySuggestion(testResult.suggestion.apiFormat)">改为 {{ testResult.suggestion.apiFormat }} 并重测</button>
          </div>
        </template>
        <div v-else class="mem-empty">尚无结果</div>
      </div>
      <template #foot>
        <button
          v-if="canRetest"
          class="btn btn-ghost"
          :disabled="busy === testResult?.providerId"
          @click="retest"
        >
          {{ busy === testResult?.providerId ? "测试中…" : "重新测试" }}
        </button>
        <button class="btn btn-ghost" @click="testOpen = false">关闭</button>
      </template>
    </MemDialog>

    <!-- 真实调用结果弹窗 -->
    <MemDialog
      :open="callOpen"
      :title="callCtx ? `真实调用结果 · ${callCtx.providerName}${callCtx.modelId ? ' / ' + callCtx.modelId : ''}` : '真实调用结果'"
      sub="发一次最小真实请求，验证端到端可用（含上游不标准参数的自动修正）"
      @update:open="callOpen = false"
    >
      <div class="mem-col">
        <template v-if="callResult">
          <div v-if="callResult.ok" class="mem-kv">
            <span class="k">结果</span><span class="v"><span class="mem-chip accent">✓ 调用成功</span></span>
            <span class="k">耗时</span><span class="v">{{ callResult.latencyMs }}ms</span>
            <span class="k">模型</span><span class="v mem-mono">{{ callResult.providerId }} / {{ callResult.modelId }}</span>
            <span class="k">思考强度</span><span class="v">{{ callResult.effort ? effortLabel(callResult.effort) : "—" }}</span>
            <span class="k">返回内容</span><span class="v"><pre class="mem-pre">{{ callResult.text }}</pre></span>
          </div>
          <template v-else>
            <div class="mem-banner" style="border-color: var(--danger); background: var(--danger-dim); color: var(--danger)">✗ 调用失败</div>
            <pre class="mem-pre">{{ callResult.message }}</pre>
          </template>
        </template>
        <div v-else class="mem-empty">尚无结果</div>
      </div>
      <template #foot>
        <button class="btn btn-ghost" @click="callOpen = false">关闭</button>
      </template>
    </MemDialog>
  </div>
</template>
