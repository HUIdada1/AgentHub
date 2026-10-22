<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 设置弹窗 · 模型与网关（平台级）：模型来源（自定义供应商 + 内置降级档托底）+ 自定义供应商
     （名称 / 调用信息 / 模型 / 连接测试·编辑·删除·启用开关）+ 请求超时与失败重试。
     供应商「编辑」弹窗＝连接信息 + 模型列表（拉取 / 添加 / 试调 / 编辑 / 删除 / 启停）。
     按标签的路由与降级链仍留在「记忆中枢 · 配置」页（见 RoutingChainPanel.vue），不在这里。
     注意：本 Section 必须自带 .memory-scope（mem-* 类的 CSS 变量定义在那层上，缺了描边与底色会静默丢失）。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import { timeAgo } from "../../composables/useFormat";
import { fmtCtx } from "../../utils/format";
import { effortLabel } from "../memory/labels";
import MemHelp from "../memory/MemHelp.vue";
import MemSelect from "../memory/MemSelect.vue";
import MemDialog from "../memory/MemDialog.vue";

const app = useAppStore();

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
type CallResult = { ok: boolean; latencyMs?: number; providerId?: string; modelId?: string; effort?: string; text?: string; message?: string; usage?: unknown };
/** 兜底降级配置（后端 models.degrade）：绑定一个专用供应商+模型 */
type DegradeCfg = { enabled?: boolean; providerId?: string; modelId?: string; effort?: string };
type SourcesState = {
  order: string[]; tagDefs: string[];
  routing?: unknown[]; taskEffort?: Record<string, string>; degrade?: DegradeCfg;
  sources?: { key: string; available: boolean; detail: string }[];
};

const providers = ref<Provider[]>([]);
const models = ref<Model[]>([]);
const sources = ref<SourcesState>({ order: [], tagDefs: [] });
/** 读取失败原因：后端解耦后正常不该出现；真出现时给中文提示 + 重试，而不是整页空白 */
const loadError = ref("");
const loading = ref(false);
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
  { id: "chat_completions", label: "Chat Completions", path: "POST /v1/chat/completions", desc: "OpenAI 系、绝大多数兼容端点" },
  { id: "responses", label: "Responses", path: "POST /v1/responses", desc: "OpenAI 新接口" },
];
/** 两个来源档的中文名与一句话说明（右侧解释区渲染用）。
 *  来源只剩两档：自定义供应商（自备 Key）在前，降级档作为内置托底在后；
 *  位次即优先级，用户不需要（也不能）拖动——档位语义是固定的。 */
const SOURCE_META: Record<string, { name: string; desc: string }> = {
  // 名称必须短：左侧小卡只有 ~320px，`.mem-chip` 与 `.si-body b` 都是 nowrap
  custom: { name: "自定义供应商（自备 Key）", desc: "常在线的上游，按顺序优先尝试" },
  degrade: { name: "降级档（内置托底）", desc: "默认就有的兜底档，需绑定模型才参与" },
};
/** 固定顺序：自定义供应商在前，内置降级档托底。档位语义固定，不支持自定义排序；
 *  与后端 DEFAULT_SOURCE_ORDER（electron/backend/memory/llm/client.cjs）保持逐位一致 */
const DEFAULT_ORDER = ["custom", "degrade"];
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
/** 紧凑行（来源卡里的降级档）用短标签：effortLabel 给的「最小（minimal）」在 100px 的下拉里会被截成「最小（min…）」 */
const EFFORT_SHORT: Record<string, string> = { off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高" };
const shortEffortOptions = ROUTE_EFFORTS.map((e) => ({ value: e, label: EFFORT_SHORT[e] || e }));
const degradeProviderOptions = computed(() => [
  { value: "", label: "绑定供应商…" },
  ...providers.value.map((p) => ({ value: p.id, label: p.name })),
]);
const degradeModelOptions = computed(() => [
  { value: "", label: "绑定模型…" },
  ...modelsOf(degradeCfg.value.providerId || "").map((m) => ({ value: m.modelId, label: m.modelId })),
]);

const HELP = {
  sources: "记忆模块调模型时按这里的顺序找来源：先试自备 Key 的自定义供应商，再试内置降级档（绑了供应商与模型才参与）。两档都不可用时本次 AI 处理会失败，并提示你去配置。",
  format: "上游端点的协议形态。选错会一直 404/400：Claude 系与 Claude 中转多是 Anthropic Messages，绝大多数兼容端点是 Chat Completions，OpenAI 新接口是 Responses。拿不准就先按默认测一次，三级测试会给建议。",
  key: "API Key 明文存本机配置文件（不加密、随配置走），界面只回掩码；导出配置时不含 Key。留空表示沿用原有 Key。",
  test: "三级测试：① 连通（能不能握手）→ ② 鉴权（Key 有没有效）→ ③ 格式能力（用你选的格式发一次最小真实请求）。第三级最关键——它能直接告诉你格式选错了。",
  fetch: "从上游 /models 端点拉模型列表。拉回来的模型会按名字预判标签与思考强度（只是预填，可改）。端点不提供 /models 时改用手动添加。",
  modelTable: "每行一个模型：关掉开关即从所有任务的选择器里消失；「标签」决定哪些任务能用它；「优先级」越小越先被选中；「思考强度」是模型级默认值（任务与单次调用可覆盖）。",
  effort: "思考强度五档：off 不发思考参数；minimal/low/medium/high 控制推理预算（越高质量越好、越费 token）；custom 手动填预算。判定类任务（去重/分类）用低档，蒸馏/画像用中高档。",
  tags: "用途标签是任务与模型之间的唯一约定：任务声明「我要 heavy、summarize 的模型」，就在带这些标签且已启用的模型里按优先级挑。可以只用一个模型打全部标签，也可以配 10 个模型分多档。",
  degrade: "降级档是默认就有的托底档，排在自定义供应商之后：前面的供应商都不可用时由它接管。绑定一个最便宜、最稳的模型即可。未绑定时这一档不参与解析，不会凭空多试一次。",
  testCall: "用该模型 + 指定思考强度发一次真实小请求，验证端到端可用（含上游不标准参数的自动修正）。结果在弹窗里查看。",
  timeout: "单次模型请求的超时与重试次数。超时按秒计（默认 60s，思考型模型输出长可调到 120~180）；重试只针对 429/5xx 与网络错误，401/403 会立刻换下一个模型，不会反复撞墙。",
};

/** 请求超时 / 失败重试：这两项此前没有任何界面入口（schema 分组被过滤 + 类型被排除，两条叠加） */
const timeoutSec = ref(60);
const maxRetries = ref(3);
const netSaving = ref(false);

async function refresh() {
  loading.value = true;
  loadError.value = "";
  try {
    // 网关档已下线：供应商列表里若残留 gw-local（旧版/mock 数据），一律滤掉
    providers.value = ((await api.memoryProviderList()).providers as unknown as Provider[]).filter((p) => p.id !== "gw-local");
    models.value = (await api.memoryModelList()).models as unknown as Model[];
    const src = (await api.memoryLlmSources()) as unknown as SourcesState;
    // 来源只剩两档且顺序固定：后端回来的 order 若还带着 gateway（存量配置 / 旧默认序），
    // 就地按固定序渲染，并静默落盘一次——否则运行时仍会去试那个已下线的网关档。
    const fixed = [...DEFAULT_ORDER];
    const stored = Array.isArray(src.order) ? src.order : [];
    const dirty = stored.length !== fixed.length || stored.some((k, i) => k !== fixed[i]);
    sources.value = { ...src, order: fixed };
    if (dirty) void api.memoryLlmSourcesSave({ order: fixed }).catch(() => {});
    const env = await api.memoryConfigGet();
    const m = ((env.config || {}) as { models?: { timeout?: number; maxRetries?: number } }).models || {};
    timeoutSec.value = Number(m.timeout ?? 60) || 60;
    maxRetries.value = Number.isFinite(Number(m.maxRetries)) ? Number(m.maxRetries) : 3;
  } catch (e) {
    // 一条中文提示 + 重试入口：不让用户看到「Cannot read properties of null」这种英文报错
    loadError.value = (e as Error).message || "读取模型与网关配置失败";
  } finally {
    loading.value = false;
  }
}

/** 仅刷新供应商与模型（列表内的开关/保存后用它，省掉配置回读） */
async function refreshCore() {
  try {
    providers.value = ((await api.memoryProviderList()).providers as unknown as Provider[]).filter((p) => p.id !== "gw-local");
    models.value = (await api.memoryModelList()).models as unknown as Model[];
  } catch (e) {
    ElMessage.error((e as Error).message || "读取供应商失败");
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
    await refreshCore();
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
    await refreshCore();
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
    await refreshCore();
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
    await refreshCore();
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

// ---- 降级档绑定（内置托底档：绑定自定义供应商 + 模型后，前面几档不可用时接管） ----
const degradeCfg = computed<DegradeCfg>(() => sources.value.degrade || {});
const degradeOn = computed(() => degradeCfg.value.enabled !== false);
const degradeBound = computed(() => !!(degradeCfg.value.providerId && degradeCfg.value.modelId));
const degradeLabel = computed(() => (degradeBound.value ? `${providerNameOf(degradeCfg.value.providerId!)}/${degradeCfg.value.modelId}` : ""));

function providerNameOf(pid: string) {
  return providers.value.find((p) => p.id === pid)?.name || pid;
}

async function saveDegrade(patch: { enabled?: boolean; providerId?: string; modelId?: string; effort?: string }) {
  const d: DegradeCfg = { ...degradeCfg.value };
  if (patch.enabled !== undefined) d.enabled = patch.enabled;
  if (patch.providerId !== undefined) { if (patch.providerId) d.providerId = patch.providerId; else delete d.providerId; }
  if (patch.modelId !== undefined) { if (patch.modelId) d.modelId = patch.modelId; else delete d.modelId; }
  if (patch.effort !== undefined) d.effort = patch.effort;
  try {
    await api.memoryLlmSourcesSave({ degrade: d });
    await refresh();
    ElMessage.success("降级档已保存");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

function onDegradeProvider(pid: string) {
  const patch: { providerId: string; modelId?: string } = { providerId: pid };
  if (degradeCfg.value.modelId && !modelsOf(pid).some((m) => m.modelId === degradeCfg.value.modelId)) patch.modelId = "";
  void saveDegrade(patch);
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

/** 来源卡「自定义供应商」档的状态：已启用供应商数量（停用的不参与调用） */
const enabledProviderCount = computed(() => providers.value.filter((p) => p.enabled).length);

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

/** 超时/重试落盘：与其它 models.* 用户数据同落 local（本机级、不随 WebDAV 同步） */
async function saveNet() {
  const t = Math.min(600, Math.max(5, Number(timeoutSec.value) || 60));
  const r = Math.min(10, Math.max(0, Number(maxRetries.value) || 0));
  timeoutSec.value = t;
  maxRetries.value = r;
  netSaving.value = true;
  try {
    await api.memoryConfigSave({ "models.timeout": t, "models.maxRetries": r }, true);
    ElMessage.success("超时与重试已保存");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    netSaving.value = false;
  }
}

/** 只在「设置弹窗打开且停在该页签」时拉数据：弹窗关着不白跑 IPC。
 *  SettingsDialog 是懒挂载 + v-show 保活，所以还要靠 watch 在每次切回该页时重拉（可能在别处被改过）。 */
const active = computed(() => app.settingsOpen && app.settingsTab === "models");
watch(active, (v) => { if (v) void refresh(); }, { immediate: true });
</script>

<template>
  <div class="cfg-sec memory-scope models-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">模型与网关</div>
        <div class="cfg-sec-sub">
          平台级 AI 配置：所有调用模型的板块共用这一份（当前消费方：记忆中枢）。按标签的路由与降级链仍在「记忆中枢 · 配置」。
        </div>
      </div>
      <div class="cfg-sec-actions">
        <button class="btn btn-cta" @click="openDrawer()">＋ 添加供应商</button>
        <button class="btn btn-ghost" :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新全部状态" }}</button>
      </div>
    </div>

    <div v-if="loadError" class="mem-banner">
      <span class="b-grow">读取配置失败：{{ loadError }}</span>
      <button class="btn-outline" @click="refresh">重试</button>
    </div>

    <!-- 模型来源：两档固定顺序（自定义供应商 → 内置降级档托底），档位语义固定，不提供拖动 -->
    <div class="mem-card">
      <div class="mem-card-title">
        模型来源
        <span class="mem-hint">按序号依次尝试：自定义供应商优先，降级档托底</span>
        <MemHelp :text="HELP.sources" />
      </div>
      <div class="mem-src-grid models-src">
        <div class="mem-src-list">
          <div v-for="(key, i) in sources.order" :key="key" class="mem-chain-node mem-src-item">
            <span class="mem-chip accent">{{ i + 1 }}</span>
            <span class="si-body">
              <b>{{ sourceName(key) }}</b>
              <small>{{ sourceDesc(key) }}</small>
            </span>
            <!-- 状态 chip 只放短词：完整绑定关系在 tooltip 里。
                 直接塞「降级档：供应商/模型」会把 320px 的卡片撑破（.mem-chip 是 nowrap） -->
            <el-tooltip
              v-if="key === 'degrade'"
              :content="degradeBound ? `已绑定：${degradeLabel}` : '未绑定供应商与模型，此档不参与解析'"
              placement="top"
            >
              <span class="mem-chip src-state" :class="degradeBound ? 'accent' : 'warn'">
                {{ degradeBound ? "已绑定" : "未绑定" }}
              </span>
            </el-tooltip>
            <span v-else class="mem-chip src-state">{{ enabledProviderCount }} 个已启用</span>
          </div>
        </div>
        <div class="mem-src-side">
          <p class="mem-hint">{{ HELP.sources }}</p>
          <p class="mem-hint">
            降级档是内置托底档：默认就存在、不需要新增，绑好供应商与模型后才参与解析。
          </p>
        </div>
      </div>
      <!-- 降级档绑定：内置托底档，前面的供应商都不可用时接管 -->
      <div class="mem-row" style="margin-top: 10px; gap: 6px; flex-wrap: wrap; align-items: center">
        <span class="mem-hint" style="font-weight: 600">降级档</span>
        <el-tooltip content="降级档开关" placement="top">
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
          width="96px"
          :options="shortEffortOptions"
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
              <td colspan="4" class="mem-empty">{{ loading ? "读取中…" : "还没有供应商 —— 点右上「＋ 添加供应商」，配好 Base URL 与 Key 后再拉取模型" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 请求超时 / 失败重试：此前没有任何界面入口（分组被过滤 + 类型被排除，两条叠加），随搬迁一并补上 -->
    <div class="mem-card">
      <div class="mem-card-title">
        请求超时与失败重试
        <MemHelp :text="HELP.timeout" />
        <span class="mem-inline-ctl">
          <button class="btn btn-ghost" :disabled="netSaving" @click="saveNet">{{ netSaving ? "保存中…" : "保存" }}</button>
        </span>
      </div>
      <!-- 两个字段与说明分开排：说明原先和字段同一个 flex 行，会把两列的顶部错开
           （align-items:flex-end 让高度不同的 section 底部对齐，label 就上下不齐） -->
      <div class="net-grid">
        <div class="mem-section net-field">
          <div class="s-title">请求超时（秒）</div>
          <input v-model.number="timeoutSec" type="number" min="5" max="600" class="f-input" placeholder="60" />
          <div class="mem-hint">默认 60 · 范围 5~600</div>
        </div>
        <div class="mem-section net-field">
          <div class="s-title">失败重试次数</div>
          <input v-model.number="maxRetries" type="number" min="0" max="10" class="f-input" placeholder="3" />
          <div class="mem-hint">默认 3 · 范围 0~10</div>
        </div>
      </div>
      <p class="mem-hint net-tip">
        对所有走模型的任务生效（抽取 / 摘要 / 打标 / 去重 / 蒸馏 / 画像）。超时按秒计，思考型模型输出长可调到 120~180；重试只针对 429/5xx 与网络错误，401/403 会立刻换下一个模型，不会反复撞墙。
      </p>
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

<style scoped>
/* ===== 设置弹窗内的局部修正 =====
   这一页复用了记忆中枢的 mem-* 组件类（全局裸类，见 styles/memory.css）。
   记忆中枢是整页宽布局，设置弹窗右列只有 ~810px，几处布局在窄容器里会塌，
   所以这里只做「窄容器适配」，不动全局样式，避免影响记忆中枢页面本身。 */

/* ① 间距去重：.memory-scope 自带 display:flex + gap，.cfg-sec 又给 > * + * 加 margin-top，
   两者叠加会让卡片间距变成两倍（视觉上「空得莫名其妙」）。间距统一由 .cfg-sec 给。 */
.models-sec.memory-scope {
  gap: 0;
}

/* ② 来源小卡：320px 一列比记忆中枢页面的 300px 略宽，且允许换行。
   .mem-chip 是 nowrap，长内容（如「降级档：供应商/模型」）会直接撑破卡片压到右栏上。 */
.models-src {
  grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
}
.models-src .mem-src-item {
  flex-wrap: wrap;
  row-gap: 4px;
}
.models-src .mem-src-item .si-body {
  flex: 1 1 120px;
}
.models-src .src-state {
  margin-left: auto;
  flex-shrink: 0;
}
/* 窄视口下弹窗被 max-width 压到 100vw-48px：两列会互相挤，改回单列（与 memory.css 的断点一致） */
@media (max-width: 720px) {
  .models-src {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ③ 供应商表：操作列四个控件（连接测试/编辑/删除/开关）挤在一起，窄容器里会互相贴住。
   给按钮之间留间距并禁止换行；模型列的 chip 过长时省略而不是把行撑高。 */
.prov-tbl td.actions {
  white-space: nowrap;
}
.prov-tbl td.actions .btn-link + .btn-link {
  margin-left: 6px;
}
.prov-tbl td.actions .switch {
  margin-left: 10px;
}
.prov-tbl .p-models .mem-chip {
  display: inline-block;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  line-height: 1.7;
}

/* ④ 超时 / 重试：两个字段左对齐排一行，说明单独一行（原先三者同排会把 label 错开） */
.net-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: flex-start;
}
.net-field {
  width: 200px;
}
.net-field .f-input {
  max-width: 120px;
}
.net-tip {
  margin: 10px 0 0;
}
</style>
