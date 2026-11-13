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
<!-- 设置弹窗 · 模型与网关（平台级）：
     1. 本地网关快捷联动状态与一键导入/同步；
     2. 模型调用流水线（自备优先 + 降级兜底绑定，紧凑集成）；
     3. 供应商与模型池管理（网关来源标识、状态感知、测试与编辑）；
     4. 网络超时与重试并发参数。
     注意：本 Section 必须自带 .memory-scope（mem-* 类的 CSS 变量定义在那层上）。 -->
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
import { providerLogo } from "../../views/proxy/providerIcons";
import type { ProxyProvider } from "../../types";

const app = useAppStore();

type Provider = {
  id: string; name: string; kind: string; baseUrl: string; apiFormat: string;
  apiKeyMasked: string; hasKey: boolean; enabled: boolean; note: string;
  status: string; lastCheck: { at: number; ok: boolean; latencyMs?: number; models?: number } | null;
  modelCount: number; enabledModelCount: number; isGateway: boolean;
};

type ModelCaps = { vision?: boolean; tools?: boolean; stream?: boolean; jsonMode?: boolean; contextWindow?: number };
type Model = {
  id: string; providerId: string; modelId: string; displayName: string; enabled: boolean;
  reasoning: { enabled: boolean; effort: string; customBudget: number | null };
  caps?: ModelCaps;
  tags: string[]; priority: number; temperature: number; maxTokens: number;
};
type CallResult = { ok: boolean; latencyMs?: number; providerId?: string; modelId?: string; effort?: string; text?: string; message?: string; usage?: unknown };
type DegradeCfg = { enabled?: boolean; providerId?: string; modelId?: string; effort?: string };
type SourcesState = {
  order: string[]; tagDefs: string[];
  routing?: unknown[]; taskEffort?: Record<string, string>; degrade?: DegradeCfg;
  sources?: { key: string; available: boolean; detail: string }[];
};

const providers = ref<Provider[]>([]);
const models = ref<Model[]>([]);
const sources = ref<SourcesState>({ order: [], tagDefs: [] });
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
const keyVisible = ref(false);
const fetchResult = ref<{ id: string; list: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string } }[] } | null>(null);
const modelOpen = ref(false);
const modelForm = ref({
  id: "", providerId: "", modelId: "", displayName: "", enabled: true,
  effort: "minimal", customBudget: null as number | null,
  tagsText: "", priority: 10, temperature: 0.2, maxTokens: 2048,
  caps: undefined as ModelCaps | undefined,
});

// ---- 本地网关感知状态 ----
const gwStatus = ref<{ running: boolean; port: number; bind?: string; activeChannels?: number } | null>(null);
const gwCustomProviders = ref<ProxyProvider[]>([]);
const gwDetecting = ref(false);

const EFFORTS = ["off", "minimal", "low", "medium", "high", "custom"];
const FORMATS = [
  { id: "anthropic_messages", label: "Anthropic Messages", path: "POST /v1/messages", desc: "Claude 系端点、Claude 中转" },
  { id: "chat_completions", label: "Chat Completions", path: "POST /v1/chat/completions", desc: "OpenAI 系、绝大多数兼容端点" },
  { id: "responses", label: "Responses", path: "POST /v1/responses", desc: "OpenAI 新接口" },
];
const SOURCE_META: Record<string, { name: string; desc: string }> = {
  custom: { name: "自定义供应商", desc: "自备 Key，按列表优先调度" },
  degrade: { name: "降级兜底档", desc: "当前置不可用时自动接管" },
};
const DEFAULT_ORDER = ["custom", "degrade"];
const ROUTE_EFFORTS = ["off", "minimal", "low", "medium", "high"];
const sourceName = (key: string) => SOURCE_META[key]?.name || key;
const sourceDesc = (key: string) => SOURCE_META[key]?.desc || "";

const formatOptions = FORMATS.map((f) => ({ value: f.id, label: `${f.label}（${f.path.replace("POST ", "")}）` }));
const formatDesc = (id: string) => FORMATS.find((f) => f.id === id)?.desc || "";
const effortOptions = EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }));
const EFFORT_SHORT: Record<string, string> = { off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高" };
const shortEffortOptions = ROUTE_EFFORTS.map((e) => ({ value: e, label: EFFORT_SHORT[e] || e }));
const degradeProviderOptions = computed(() => [
  { value: "", label: "选择供应商…" },
  ...providers.value.map((p) => ({ value: p.id, label: p.name })),
]);
const degradeModelOptions = computed(() => [
  { value: "", label: "选择模型…" },
  ...modelsOf(degradeCfg.value.providerId || "").map((m) => ({ value: m.modelId, label: m.modelId })),
]);

const HELP = {
  sources: "模型路由策略：默认优先从已启用的自定义供应商中挑选可用模型；全部不可用时由降级档兜底。",
  format: "端点协议形态：Claude 系通常选 Anthropic Messages，大部分 OpenAI 兼容端点选 Chat Completions。",
  key: "API Key 本地明文存储，界面只显掩码；导出配置时不含 Key。",
  test: "三级测试：连通性、鉴权有效性与格式真实能力测试。",
  fetch: "从上游 /models 端点拉取模型列表并自动推荐标签；支持手动添加。",
  effort: "思考强度五档：控制推理深度与 Token 消耗。判定类任务用低档，蒸馏/总结用中高档。",
  degrade: "降级兜底档：绑定供应商与模型后，在前置供应商均失效时保障基本功能运转。",
  timeout: "全局模型调用的超时保护、失败重试及并行并发上限控制。",
};

const timeoutSec = ref(60);
const maxRetries = ref(3);
const maxInflight = ref(1);
const netSaving = ref(false);

/** 本地网关联动状态检测 */
async function detectLocalgw() {
  gwDetecting.value = true;
  try {
    const s = await api.localgwStatus();
    if (s && typeof s === "object") {
      gwStatus.value = {
        running: !!s.running,
        port: s.port || 9527,
        bind: s.bind || "127.0.0.1",
        activeChannels: s.activeChannels || 0,
      };
    }
  } catch {
    gwStatus.value = null;
  }
  try {
    const p = await api.proxyProviderList();
    if (p && p.ok !== false) {
      gwCustomProviders.value = (p.providers || []).filter((x) => x.enabled);
    }
  } catch {
    gwCustomProviders.value = [];
  } finally {
    gwDetecting.value = false;
  }
}

async function refresh() {
  loading.value = true;
  loadError.value = "";
  try {
    providers.value = ((await api.memoryProviderList()).providers as unknown as Provider[]).filter((p) => p.id !== "gw-local");
    models.value = (await api.memoryModelList()).models as unknown as Model[];
    const src = (await api.memoryLlmSources()) as unknown as SourcesState;
    const fixed = [...DEFAULT_ORDER];
    const stored = Array.isArray(src.order) ? src.order : [];
    const dirty = stored.length !== fixed.length || stored.some((k, i) => k !== fixed[i]);
    sources.value = { ...src, order: fixed };
    if (dirty) void api.memoryLlmSourcesSave({ order: fixed }).catch(() => {});
    const env = await api.memoryConfigGet();
    const m = ((env.config || {}) as { models?: { timeout?: number; maxRetries?: number; maxInflight?: number } }).models || {};
    timeoutSec.value = Number(m.timeout ?? 60) || 60;
    maxRetries.value = Number.isFinite(Number(m.maxRetries)) ? Number(m.maxRetries) : 3;
    maxInflight.value = Number.isFinite(Number(m.maxInflight)) ? Number(m.maxInflight) : 1;
    await detectLocalgw();
  } catch (e) {
    loadError.value = (e as Error).message || "读取模型与网关配置失败";
  } finally {
    loading.value = false;
  }
}

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

const editingProvider = computed(() => providers.value.find((x) => x.id === form.value.id) || null);

async function saveProvider() {
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    ElMessage.warning("名称与 Base URL 必填");
    return;
  }
  busy.value = "save";
  try {
    await api.memoryProviderSave({ ...form.value });
    ElMessage.success("已保存供应商");
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
    await ElMessageBox.confirm(`删除供应商「${p.name}」将连带移除其下的全部模型关联（不影响网关本体）`, "删除供应商", { type: "warning" });
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

const toggling = ref("");
async function toggleProvider(p: Provider) {
  if (toggling.value) return;
  const next = !p.enabled;
  toggling.value = p.id;
  p.enabled = next;
  try {
    await api.memoryProviderToggle(p.id, next);
    ElMessage.success(next ? `已启用「${p.name}」` : `已停用「${p.name}」`);
    await refresh();
  } catch (e) {
    p.enabled = !next;
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
    ElMessage[r.l3.ok ? "success" : "warning"](r.l3.ok ? "三级测试全部通过" : "测试未完全通过，请查看详情");
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
    ElMessage.success(`已调整为 ${apiFormat}，正在重测`);
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
    ElMessage.success(`拉取到 ${r.models.length} 个模型`);
  } catch (e) {
    ElMessage.error((e as Error).message || "拉取失败（端点若未开放 /models 请改用手动添加）");
  } finally {
    busy.value = "";
  }
}

const addingFetched = ref(false);
async function addFetched(list: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string } }[]) {
  if (!fetchResult.value || addingFetched.value) return;
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
    else ElMessage.success(`成功加入 ${added} 个模型`);
    fetchResult.value = null;
    await refresh();
  } finally {
    addingFetched.value = false;
  }
}

async function addManual(providerId: string) {
  let modelId = "";
  try {
    const r = await ElMessageBox.prompt("请输入上游真实模型 ID（例如 gpt-4o-mini 或 claude-3-5-sonnet）", "手动添加模型", { inputPlaceholder: "gpt-4o-mini" });
    modelId = (r.value || "").trim();
  } catch {
    return;
  }
  if (!modelId) return;
  try {
    await api.memoryModelSave({ providerId, modelId });
    ElMessage.success(`已添加模型 ${modelId}`);
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

function openModelEditor(m: Model) {
  modelForm.value = {
    id: m.id,
    providerId: m.providerId,
    modelId: m.modelId,
    displayName: m.displayName || m.modelId,
    enabled: m.enabled,
    effort: m.reasoning.effort || "minimal",
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
      reasoning: { enabled: f.effort !== "off", effort: f.effort, customBudget: f.customBudget ?? (f.effort === "custom" ? 4096 : null) },
      caps: f.caps,
    });
    ElMessage.success("模型配置已更新");
    modelOpen.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    busy.value = "";
  }
}

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
  try {
    await ElMessageBox.confirm(`确认从模型池移除「${m.modelId}」？（不影响上游服务）`, "移除模型", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryModelDelete(m.id);
    ElMessage.success("已移除");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

// ---- 降级兜底档绑定 ----
const degradeCfg = computed<DegradeCfg>(() => sources.value.degrade || {});
const degradeOn = computed(() => degradeCfg.value.enabled !== false);
const degradeBound = computed(() => !!(degradeCfg.value.providerId && degradeCfg.value.modelId));
const degradeLabel = computed(() => (degradeBound.value ? `${providerNameOf(degradeCfg.value.providerId!)} / ${degradeCfg.value.modelId}` : "未绑定"));

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
    ElMessage.success("降级兜底档已更新");
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
    ElMessage[r.ok ? "success" : "error"](r.ok ? "试调成功" : "试调失败，查看详情");
  } catch (e) {
    callResult.value = { ok: false, message: (e as Error).message || "调用失败" };
    ElMessage.error(callResult.value.message);
  } finally {
    busy.value = "";
    callOpen.value = true;
  }
}

const testProviderName = computed(() => {
  const id = testResult.value?.providerId;
  return id ? providers.value.find((p) => p.id === id)?.name || "供应商" : "";
});

function retest() {
  const id = testResult.value?.providerId;
  const p = providers.value.find((x) => x.id === id);
  if (p) void testProvider(p);
}

function formatLabelOf(p: Provider | null) {
  if (!p) return "";
  return FORMATS.find((f) => f.id === p.apiFormat)?.label || p.apiFormat;
}

const canRetest = computed(() => {
  const t = testResult.value;
  return !!t && providers.value.some((x) => x.id === t.providerId);
});

function ctxLabel(m: Model) {
  return fmtCtx(m.caps?.contextWindow);
}

const modelsOf = (providerId: string) => models.value.filter((m) => m.providerId === providerId);
const enabledProviderCount = computed(() => providers.value.filter((p) => p.enabled).length);

const MODEL_BRIEF = 3;
const briefByProvider = computed<Record<string, { shown: string[]; rest: number; all: string }>>(() => {
  const map: Record<string, { shown: string[]; rest: number; all: string }> = {};
  for (const p of providers.value) {
    const ids = modelsOf(p.id).map((m) => m.modelId);
    map[p.id] = { shown: ids.slice(0, MODEL_BRIEF), rest: Math.max(0, ids.length - MODEL_BRIEF), all: ids.join("、") };
  }
  return map;
});

function statusText(p: Provider) {
  if (p.status === "online") return "在线";
  if (p.status === "offline") return "离线";
  if (p.status === "rate_limited") return "限流";
  return "未测试";
}

/** 判断该供应商是否由本地网关导入 */
function isFromGateway(p: Provider) {
  return String(p.note || "").includes("来自网关") || String(p.note || "").includes("本地网关");
}

async function saveNet() {
  const t = Math.min(600, Math.max(5, Number(timeoutSec.value) || 60));
  const r = Math.min(10, Math.max(0, Number(maxRetries.value) || 0));
  const n = Math.min(8, Math.max(1, Math.floor(Number(maxInflight.value) || 1)));
  timeoutSec.value = t;
  maxRetries.value = r;
  maxInflight.value = n;
  netSaving.value = true;
  try {
    await api.memoryConfigSave({ "models.timeout": t, "models.maxRetries": r, "models.maxInflight": n }, true);
    ElMessage.success("网络与并发配置已保存");
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    netSaving.value = false;
  }
}

const active = computed(() => app.settingsOpen && app.settingsTab === "models");
watch(active, (v) => { if (v) void refresh(); }, { immediate: true });

// ---- 本地网关导入流程 ----
const gwOpen = ref(false);
const gwLoading = ref(false);
const gwBusy = ref(false);
const gwErr = ref("");
const gwProviders = ref<ProxyProvider[]>([]);
const gwBrands = ref<Record<string, string>>({});
const gwProviderId = ref("");
const gwAccountId = ref("");
const gwModelIds = ref<string[]>([]);

const gwProvider = computed(() => gwProviders.value.find((p) => p.id === gwProviderId.value) || null);
type GwModel = { model: string; label: string };
const gwModels = computed<GwModel[]>(() =>
  (gwProvider.value?.models || [])
    .map((m) => {
      if (typeof m === "string") return { model: m, label: m };
      const model = String(m?.model || "");
      const upstream = String(m?.upstream || "");
      return { model, label: upstream && upstream !== model ? `${model} → ${upstream}` : model };
    })
    .filter((m) => m.model),
);

const GW_KEY_STATUS: Record<string, string> = { online: "在线", offline: "离线", rate_limited: "限流" };
const gwKeyStatus = (s: string) => GW_KEY_STATUS[s] || "未测试";

async function openGatewayImport() {
  gwOpen.value = true;
  gwProviderId.value = "";
  gwAccountId.value = "";
  gwModelIds.value = [];
  gwErr.value = "";
  gwLoading.value = true;
  try {
    const r = await api.proxyProviderList();
    if (r.ok === false) {
      gwErr.value = r.message || "读取本地网关提供商失败";
      return;
    }
    gwProviders.value = (r.providers || []).filter((p) => p.enabled);
    const brands: Record<string, string> = {};
    for (const preset of r.presets || []) brands[preset.id] = preset.brand;
    gwBrands.value = brands;
  } catch (e) {
    gwErr.value = (e as Error).message || "读取本地网关提供商失败";
  } finally {
    gwLoading.value = false;
  }
}

function gwPickProvider(p: ProxyProvider) {
  gwProviderId.value = p.id;
  gwAccountId.value = (p.keys || [])[0]?.id || "";
  gwModelIds.value = gwModels.value.map((m) => m.model);
}

function gwToggleModel(model: string) {
  const s = new Set(gwModelIds.value);
  if (s.has(model)) s.delete(model);
  else s.add(model);
  gwModelIds.value = [...s];
}
const gwAllSelected = computed(
  () => gwModels.value.length > 0 && gwModels.value.every((m) => gwModelIds.value.includes(m.model)),
);
function gwToggleAll() {
  gwModelIds.value = gwAllSelected.value ? [] : gwModels.value.map((m) => m.model);
}

const normGwUrl = (u: string) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
function importedOf(p: ProxyProvider): Provider | null {
  const url = normGwUrl(p.baseUrl);
  return providers.value.find((x) => normGwUrl(x.baseUrl) === url && String(x.note || "").includes(p.id)) || null;
}

async function doGatewayImport() {
  const p = gwProvider.value;
  if (!p || !gwAccountId.value || !gwModelIds.value.length || gwBusy.value) return;
  const prev = importedOf(p);
  if (prev) {
    try {
      await ElMessageBox.confirm(
        `「${prev.name}」已导入过此提供商。继续导入会新建一条关联。`,
        "重复导入",
        { type: "warning", confirmButtonText: "仍然导入" },
      );
    } catch {
      return;
    }
  }
  gwBusy.value = true;
  gwErr.value = "";
  try {
    const r = await api.memoryProviderImportGateway({
      providerId: p.id,
      accountId: gwAccountId.value,
      modelIds: gwModelIds.value,
    });
    if (r.ok === false) {
      gwErr.value = r.message || "导入失败";
      return;
    }
    ElMessage.success(`成功导入 ${r.modelCount ?? gwModelIds.value.length} 个模型`);
    gwOpen.value = false;
    await refresh();
  } catch (e) {
    gwErr.value = (e as Error).message || "导入失败";
  } finally {
    gwBusy.value = false;
  }
}
</script>

<template>
  <div class="cfg-sec memory-scope models-sec">
    <!-- 头部栏：标题与核心主操作 -->
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">模型与网关</div>
        <div class="cfg-sec-sub">
          管理全局 AI 模型供应池。支持自建端点与本地网关深度关联，实现一键同步与自动兜底。
        </div>
      </div>
      <div class="cfg-sec-actions">
        <button class="btn btn-cta" @click="openDrawer()">
          <i class="ph ph-plus" style="margin-right: 4px"></i>添加供应商
        </button>
        <button class="btn btn-ghost" :disabled="loading" @click="refresh">
          <i class="ph ph-arrow-clockwise" :class="{ 'is-spinning': loading }" style="margin-right: 4px"></i>
          {{ loading ? "刷新中…" : "刷新状态" }}
        </button>
      </div>
    </div>

    <!-- 错误横幅 -->
    <div v-if="loadError" class="mem-banner">
      <span class="b-grow">读取配置失败：{{ loadError }}</span>
      <button class="btn-outline" @click="refresh">重试</button>
    </div>

    <!-- ① 本地网关快捷联动卡片（高度便捷关联，实时状态感知） -->
    <div class="gw-sync-bar">
      <div class="gw-sync-left">
        <div class="gw-status-badge" :class="gwStatus?.running ? 'active' : 'idle'">
          <span class="gw-pulse-dot"></span>
          <span class="gw-status-text">
            {{ gwStatus?.running ? `本地网关运行中（:${gwStatus.port}）` : "本地网关未运行" }}
          </span>
        </div>
        <div class="gw-info-pills">
          <span class="gw-pill">
            <i class="ph ph-cube"></i>
            {{ gwCustomProviders.length }} 个网关提供商就绪
          </span>
          <span class="gw-pill" v-if="gwStatus?.running">
            <i class="ph ph-shield-check"></i>
            127.0.0.1:{{ gwStatus.port }}/v1
          </span>
        </div>
      </div>
      <div class="gw-sync-right">
        <button class="btn-link gw-action-btn" @click="openGatewayImport">
          <i class="ph ph-link-simple" style="margin-right: 4px"></i>从本地网关导入模型
        </button>
      </div>
    </div>

    <!-- ② 模型调度策略与降级兜底（整合为紧凑流水线卡片） -->
    <div class="mem-card strategy-card">
      <div class="card-header-compact">
        <div class="card-title-text">
          <i class="ph ph-git-branch" style="color: var(--accent); margin-right: 6px"></i>
          调用调度策略
        </div>
        <span class="card-hint-text">自备供应商优先调度，降级档作为断网或上游故障时的兜底</span>
      </div>

      <div class="pipeline-grid">
        <!-- 阶段 1：自备供应商 -->
        <div class="pipe-node active">
          <div class="node-tag">首选 01</div>
          <div class="node-content">
            <div class="node-title">自定义供应商</div>
            <div class="node-desc">共 {{ providers.length }} 个，已启用 {{ enabledProviderCount }} 个</div>
          </div>
          <span class="node-status-pill ok">{{ enabledProviderCount > 0 ? "正常服务" : "无启用项" }}</span>
        </div>

        <div class="pipe-arrow">
          <i class="ph ph-caret-right"></i>
        </div>

        <!-- 阶段 2：内置降级档 -->
        <div class="pipe-node" :class="{ bound: degradeBound && degradeOn }">
          <div class="node-tag">兜底 02</div>
          <div class="node-content">
            <div class="node-title">内置降级档</div>
            <div class="node-desc">{{ degradeBound ? degradeLabel : "未绑定兜底模型" }}</div>
          </div>
          <div class="node-toggle" @click.stop>
            <el-tooltip :content="degradeOn ? '降级档已启用' : '降级档已关闭'" placement="top">
              <div class="switch" :class="{ on: degradeOn }" role="switch" :aria-checked="degradeOn" @click="saveDegrade({ enabled: !degradeOn })"></div>
            </el-tooltip>
          </div>
        </div>
      </div>

      <!-- 降级档快速绑定面板 -->
      <div class="degrade-bind-row">
        <span class="degrade-label">
          <i class="ph ph-shield-warning" style="margin-right: 4px; color: var(--warn)"></i>兜底配置：
        </span>
        <MemSelect
          :model-value="degradeCfg.providerId || ''"
          width="180px"
          placeholder="选择供应商…"
          :options="degradeProviderOptions"
          @change="(v: string | number) => onDegradeProvider(String(v))"
        />
        <MemSelect
          :model-value="degradeCfg.modelId || ''"
          width="180px"
          placeholder="选择模型…"
          :disabled="!degradeCfg.providerId"
          :options="degradeModelOptions"
          @change="(v: string | number) => saveDegrade({ modelId: String(v) })"
        />
        <MemSelect
          :model-value="degradeCfg.effort || 'minimal'"
          width="90px"
          :options="shortEffortOptions"
          @change="(v: string | number) => saveDegrade({ effort: String(v) })"
        />
        <span class="degrade-tip">所有主要供应商请求失效或被限流后立即激活</span>
      </div>
    </div>

    <!-- ③ 自定义供应商与模型池管理 -->
    <div class="mem-card">
      <div class="card-header-compact">
        <div class="card-title-text">
          <i class="ph ph-stack" style="color: var(--accent); margin-right: 6px"></i>
          供应商清单
          <span class="prov-counter">{{ providers.length }}</span>
        </div>
        <span class="card-hint-text">点击行内「编辑」可添加、自动拉取与测试模型</span>
      </div>

      <div class="mem-table-wrap">
        <table class="mem-table mem-table-list prov-tbl">
          <thead>
            <tr>
              <th style="width: 25%">供应商</th>
              <th style="width: 22%">健康状态</th>
              <th style="width: 33%">挂载模型</th>
              <th class="th-actions" style="width: 20%">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in providers" :key="p.id" :class="{ 'is-off': !p.enabled }">
              <td>
                <div class="prov-cell-name">
                  <span class="mem-dot" :class="p.status === 'online' ? 'ok' : p.status === 'offline' ? 'bad' : 'warn'"></span>
                  <b class="p-title-text">{{ p.name }}</b>
                  <span v-if="isFromGateway(p)" class="gw-origin-badge" title="关联自本地网关">
                    <i class="ph ph-link-simple"></i>网关
                  </span>
                  <span v-if="!p.enabled" class="mem-chip warn">已停用</span>
                </div>
                <div class="prov-cell-sub">
                  <span class="prov-fmt-text">{{ formatLabelOf(p) }}</span>
                </div>
              </td>
              <td>
                <div class="p-call">
                  <span class="status-pill" :class="p.status === 'online' ? 'accent' : p.status === 'offline' ? 'danger' : 'idle'">
                    {{ statusText(p) }}
                  </span>
                  <span v-if="p.lastCheck" class="mem-hint check-time">
                    {{ timeAgo(p.lastCheck.at) }}<template v-if="p.lastCheck.latencyMs"> ({{ p.lastCheck.latencyMs }}ms)</template>
                  </span>
                  <span v-else class="mem-hint check-time">未测试</span>
                </div>
              </td>
              <td>
                <el-tooltip :content="briefByProvider[p.id]?.all || ''" :disabled="!briefByProvider[p.id]?.all" placement="top">
                  <div class="p-models-compact">
                    <span v-for="mid in briefByProvider[p.id]?.shown || []" :key="mid" class="model-tag-pill">
                      {{ mid }}
                    </span>
                    <span v-if="(briefByProvider[p.id]?.rest || 0) > 0" class="model-tag-more">
                      +{{ briefByProvider[p.id]?.rest }}
                    </span>
                    <span v-if="!(briefByProvider[p.id]?.shown || []).length" class="mem-hint">无模型</span>
                  </div>
                </el-tooltip>
              </td>
              <td class="actions">
                <button class="btn-link" :disabled="busy === p.id" @click="testProvider(p)">
                  {{ busy === p.id ? "测试中…" : "测试" }}
                </button>
                <button class="btn-link" @click="openDrawer(p)">编辑</button>
                <button class="btn-link danger" @click="removeProvider(p)">删除</button>
                <el-tooltip :content="p.enabled ? '点击停用' : '点击启用'" placement="top">
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
              <td colspan="4" class="mem-empty">
                {{ loading ? "正在加载供应商…" : "暂无供应商配置，点击右上角「＋ 添加供应商」或「从本地网关导入」" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ④ 全局请求参数控制卡片 -->
    <div class="mem-card params-card">
      <div class="card-header-compact">
        <div class="card-title-text">
          <i class="ph ph-sliders-horizontal" style="color: var(--accent); margin-right: 6px"></i>
          调用与重试策略
        </div>
        <button class="btn btn-ghost sm-btn" :disabled="netSaving" @click="saveNet">
          {{ netSaving ? "保存中…" : "保存参数" }}
        </button>
      </div>
      <div class="params-row">
        <div class="param-item">
          <label class="param-label">请求超时（秒）</label>
          <input v-model.number="timeoutSec" type="number" min="5" max="600" class="f-input ctl-input" placeholder="60" />
          <span class="param-tip">默认 60s (5~600)</span>
        </div>
        <div class="param-item">
          <label class="param-label">失败重试次数</label>
          <input v-model.number="maxRetries" type="number" min="0" max="10" class="f-input ctl-input" placeholder="3" />
          <span class="param-tip">应对 429/网络抖动 (0~10)</span>
        </div>
        <div class="param-item">
          <label class="param-label">模型调用并发数</label>
          <input v-model.number="maxInflight" type="number" min="1" max="8" class="f-input ctl-input" placeholder="1" />
          <span class="param-tip">任务并发批次 (1~8)</span>
        </div>
      </div>
    </div>

    <!-- 供应商编辑弹窗 -->
    <MemDialog v-model:open="drawer" title="供应商详情" width="720px">
      <template #header>
        <div>
          <div class="prov-edit-head">
            <i class="ph ph-cube prov-edit-icon"></i>
            <input v-model="form.name" class="prov-name-input" placeholder="输入供应商名称" />
            <el-tooltip :content="form.enabled ? '已启用' : '已停用'" placement="top">
              <div class="switch" :class="{ on: form.enabled }" role="switch" :aria-checked="!!form.enabled" @click="form.enabled = !form.enabled"></div>
            </el-tooltip>
          </div>
          <div class="md-sub">{{ form.id ? "编辑供应商连接参数与关联模型" : "添加自备 Key 供应商，支持 OpenAI/Claude/Responses 兼容端点" }}</div>
        </div>
      </template>
      <div class="mem-col">
        <div class="mem-section">
          <div class="s-title">Base URL</div>
          <input v-model="form.baseUrl" class="f-input" placeholder="https://api.openai.com/v1 或本地 http://127.0.0.1:9527/v1" />
        </div>
        <div class="mem-section">
          <div class="s-title">API 协议格式<MemHelp :text="HELP.format" /></div>
          <MemSelect
            :model-value="form.apiFormat"
            width="100%"
            :options="formatOptions"
            @change="(v: string | number) => (form.apiFormat = String(v))"
          />
          <div class="mem-hint">{{ formatDesc(form.apiFormat) }}</div>
        </div>
        <div class="mem-section">
          <div class="s-title">
            API Key<MemHelp :text="HELP.key" />
            <span v-if="editingProvider" class="mem-chip" :class="editingProvider.hasKey ? '' : 'warn'" style="margin-left: 6px">
              {{ editingProvider.hasKey ? `已保存 ${editingProvider.apiKeyMasked}` : "未设置" }}
            </span>
          </div>
          <div class="prov-key-row">
            <input
              v-model="form.apiKey"
              :type="keyVisible ? 'text' : 'password'"
              class="f-input"
              :placeholder="form.id ? '留空保留原 Key（本地只存安全掩码）' : '粘贴 API Key'"
            />
            <el-tooltip :content="keyVisible ? '隐藏 Key' : '显示 Key'" placement="top">
              <button class="icon-btn" type="button" @click="keyVisible = !keyVisible">
                <i class="ph" :class="keyVisible ? 'ph-eye-slash' : 'ph-eye'"></i>
              </button>
            </el-tooltip>
          </div>
        </div>
        <div class="mem-section">
          <div class="s-title">备注说明</div>
          <input v-model="form.note" class="f-input" placeholder="可选（如：来自本地网关、官方直连等）" />
        </div>

        <!-- 模型列表管理 -->
        <template v-if="editingProvider">
          <div class="prov-models">
            <div class="pm-head">
              <span class="pm-title">模型列表</span>
              <span class="mem-hint">{{ modelsOf(editingProvider.id).length }} 个已配置</span>
              <span v-if="modelsOf(editingProvider.id).length > 1" class="pm-bulk">
                <button class="btn-link" :disabled="busy === `batch-${editingProvider.id}`" @click="batchModels(editingProvider.id, 'enable')">全部启用</button>
                <button class="btn-link" :disabled="busy === `batch-${editingProvider.id}`" @click="batchModels(editingProvider.id, 'disable')">全部停用</button>
              </span>
              <span class="pm-head-ops">
                <button class="btn btn-ghost" @click="addManual(editingProvider.id)">＋ 添加模型</button>
                <button class="btn btn-ghost" :disabled="busy === `fetch-${editingProvider.id}`" @click="fetchModels(editingProvider)">
                  <i class="ph ph-lightning"></i>{{ busy === `fetch-${editingProvider.id}` ? "拉取中…" : "拉取模型" }}
                </button>
              </span>
            </div>

            <!-- 拉取结果 -->
            <div v-if="fetchResult && fetchResult.id === editingProvider.id" class="pm-fetched">
              <div class="pm-fetched-head">
                拉取到 {{ fetchResult.list.length }} 个模型，点击即可加入模型池
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
                <span v-if="m.displayName && m.displayName !== m.modelId" class="pm-alias">{{ m.displayName }}</span>
                <span class="pm-caps">
                  <span v-if="ctxLabel(m)" class="mem-chip">{{ ctxLabel(m) }}</span>
                  <span v-if="m.caps?.vision" class="mem-chip info">视觉</span>
                </span>
                <span class="pm-ops">
                  <el-tooltip content="试调真实小请求" placement="top">
                    <button class="btn-link" :disabled="busy === `call-${editingProvider.id}`" @click="testCall(editingProvider, m)">
                      <i class="ph ph-plugs-connected pm-ico"></i>
                    </button>
                  </el-tooltip>
                  <el-tooltip content="编辑模型参数" placement="top">
                    <button class="btn-link" @click="openModelEditor(m)"><i class="ph ph-pencil-simple pm-ico"></i></button>
                  </el-tooltip>
                  <el-tooltip content="移除模型" placement="top">
                    <button class="btn-link danger" @click="removeModel(m)"><i class="ph ph-trash pm-ico"></i></button>
                  </el-tooltip>
                  <el-tooltip :content="m.enabled ? '已启用' : '已停用'" placement="top">
                    <div class="switch" :class="{ on: m.enabled }" role="switch" :aria-checked="!!m.enabled" @click="toggleModel(m)"></div>
                  </el-tooltip>
                </span>
              </div>
            </div>
            <div v-else class="mem-empty">暂无配置模型，请点击「拉取模型」或「手动添加」</div>
          </div>
        </template>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="busy === 'save'" @click="saveProvider">
          {{ busy === "save" ? "保存中…" : "保存配置" }}
        </button>
        <button class="btn btn-ghost" @click="drawer = false">取消</button>
      </template>
    </MemDialog>

    <!-- 从本地网关导入弹窗 -->
    <MemDialog v-model:open="gwOpen" title="从本地网关导入" width="760px" sub="一键同步本地代理网关中已配置的提供商、密钥与模型清单">
      <div class="mem-col">
        <div v-if="gwErr" class="mem-banner">{{ gwErr }}</div>

        <div class="mem-section gw-step">
          <div class="s-title">① 选择本地网关提供商<span class="mem-hint">已启用列表</span></div>
          <div v-if="gwLoading" class="mem-empty">正在读取本地网关…</div>
          <div v-else-if="!gwProviders.length" class="mem-empty">本地网关中暂无启用的自定义提供商，请在「本地网关」模块中添加</div>
          <div v-else class="gw-list">
            <button
              v-for="p in gwProviders"
              :key="p.id"
              type="button"
              class="gw-item"
              :class="{ on: gwProviderId === p.id }"
              @click="gwPickProvider(p)"
            >
              <img v-if="providerLogo(gwBrands[p.id])" :src="providerLogo(gwBrands[p.id])" class="gw-logo" alt="" />
              <span v-else class="gw-logo gw-initial">{{ (p.display || p.id).slice(0, 1).toUpperCase() }}</span>
              <span class="gw-body">
                <b>{{ p.display }}</b>
                <small class="mem-mono">{{ p.id }} · {{ p.baseUrl }}</small>
              </span>
              <span v-if="importedOf(p)" class="mem-chip warn">已导入</span>
            </button>
          </div>
        </div>

        <div v-if="gwProvider" class="mem-section gw-step">
          <div class="s-title">② 选择账号 Key</div>
          <div v-if="!(gwProvider.keys || []).length" class="mem-empty">该提供商下暂无 Key，请在网关管理中补齐</div>
          <div v-else class="gw-list">
            <button
              v-for="k in gwProvider.keys || []"
              :key="k.id"
              type="button"
              class="gw-item"
              :class="{ on: gwAccountId === k.id }"
              @click="gwAccountId = k.id"
            >
              <span class="gw-body">
                <b>{{ k.name }}</b>
                <small>{{ gwKeyStatus(k.status) }} · 今日请求 {{ k.todayReq }} 次</small>
              </span>
            </button>
          </div>
        </div>

        <div v-if="gwProvider" class="mem-section gw-step">
          <div class="s-title">
            ③ 勾选需导入的模型
            <span class="mem-hint">{{ gwModelIds.length }} / {{ gwModels.length }}</span>
            <span class="mem-inline-ctl">
              <button class="btn-link" @click="gwToggleAll">{{ gwAllSelected ? "全不选" : "全选" }}</button>
            </span>
          </div>
          <div v-if="!gwModels.length" class="mem-empty">该提供商无模型可用</div>
          <div v-else class="gw-models">
            <label v-for="m in gwModels" :key="m.model" class="gw-model">
              <input type="checkbox" :checked="gwModelIds.includes(m.model)" @change="gwToggleModel(m.model)" />
              <span class="mem-mono">{{ m.label }}</span>
            </label>
          </div>
        </div>
      </div>
      <template #foot>
        <button
          class="btn btn-cta"
          :disabled="gwBusy || !gwProviderId || !gwAccountId || !gwModelIds.length"
          @click="doGatewayImport"
        >
          {{ gwBusy ? "导入中…" : `立即导入 (${gwModelIds.length} 个模型)` }}
        </button>
        <button class="btn btn-ghost" @click="gwOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 模型二级弹窗：编辑单个模型 -->
    <MemDialog v-model:open="modelOpen" :title="`模型配置 · ${modelForm.modelId}`" width="560px">
      <div class="mem-col">
        <div class="mem-section">
          <div class="s-title">显示别名</div>
          <input v-model="modelForm.displayName" class="f-input" :placeholder="modelForm.modelId" />
        </div>
        <div class="mem-section">
          <div class="s-title">思考预算强度<MemHelp :text="HELP.effort" /></div>
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
            style="width: 140px; margin-top: 6px"
            :value="modelForm.customBudget || 4096"
            placeholder="自定义 Token 预算"
            @change="modelForm.customBudget = Number(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="mem-section">
          <div class="s-title">用途标签</div>
          <input v-model="modelForm.tagsText" class="f-input" placeholder="逗号分隔，如 chat, heavy, summarize" />
          <div class="mem-hint">可选标签：{{ sources.tagDefs.join(" / ") }}</div>
        </div>
        <div class="mem-row" style="gap: 12px; align-items: flex-end; flex-wrap: wrap">
          <div class="mem-section" style="width: 110px">
            <div class="s-title">优先级</div>
            <input v-model.number="modelForm.priority" type="number" class="f-input" placeholder="10" />
          </div>
          <div class="mem-section" style="width: 110px">
            <div class="s-title">温度 (Temp)</div>
            <input v-model.number="modelForm.temperature" type="number" step="0.1" class="f-input" placeholder="0.2" />
          </div>
          <div class="mem-section" style="width: 130px">
            <div class="s-title">最大 Tokens</div>
            <input v-model.number="modelForm.maxTokens" type="number" class="f-input" placeholder="2048" />
          </div>
        </div>
        <label class="mem-row" style="gap: 8px">
          <div class="switch" :class="{ on: modelForm.enabled }" role="switch" :aria-checked="!!modelForm.enabled" @click="modelForm.enabled = !modelForm.enabled"></div>
          <span class="mem-hint">启用此模型（关闭后将不会在任务挑选时被选中）</span>
        </label>
      </div>
      <template #foot>
        <button class="btn btn-cta" :disabled="busy === 'model-save'" @click="saveModelEdit">
          {{ busy === "model-save" ? "保存中…" : "保存修改" }}
        </button>
        <button class="btn btn-ghost" @click="modelOpen = false">取消</button>
      </template>
    </MemDialog>

    <!-- 三级连接测试结果弹窗 -->
    <MemDialog :open="testOpen" :title="`连通性诊断 · ${testProviderName}`" sub="三级综合测试（网络连通、鉴权握手、格式协议）" @update:open="testOpen = false">
      <div class="mem-col">
        <template v-if="testResult">
          <div class="mem-kv">
            <span class="k">① 连通性</span>
            <span class="v">{{ testResult.l1.ok ? `✓ 正常 (${testResult.l1.latencyMs}ms)` : `✗ ${testResult.l1.message}` }}</span>
            <span class="k">② 鉴权有效性</span>
            <span class="v">{{ testResult.l2.ok ? `✓ ${testResult.l2.message}` : `✗ ${testResult.l2.message}` }}</span>
            <span class="k">③ 格式能力</span>
            <span class="v">{{ testResult.l3.ok ? `✓ ${testResult.l3.message}` : `✗ ${testResult.l3.message}` }}</span>
          </div>
          <div v-if="testResult.suggestion" class="mem-banner">
            ⚠️ {{ testResult.suggestion.reason }}
            <button class="btn-outline" @click="applySuggestion(testResult.suggestion.apiFormat)">改为 {{ testResult.suggestion.apiFormat }} 并重测</button>
          </div>
        </template>
        <div v-else class="mem-empty">尚无诊断结果</div>
      </div>
      <template #foot>
        <button v-if="canRetest" class="btn btn-ghost" :disabled="busy === testResult?.providerId" @click="retest">
          {{ busy === testResult?.providerId ? "测试中…" : "重新测试" }}
        </button>
        <button class="btn btn-ghost" @click="testOpen = false">关闭</button>
      </template>
    </MemDialog>

    <!-- 真实调用结果弹窗 -->
    <MemDialog
      :open="callOpen"
      :title="callCtx ? `调用测试 · ${callCtx.providerName}${callCtx.modelId ? ' / ' + callCtx.modelId : ''}` : '调用测试'"
      sub="端到端单次微型文本试调"
      @update:open="callOpen = false"
    >
      <div class="mem-col">
        <template v-if="callResult">
          <div v-if="callResult.ok" class="mem-kv">
            <span class="k">状态</span><span class="v"><span class="mem-chip accent">✓ 成功</span></span>
            <span class="k">耗时</span><span class="v">{{ callResult.latencyMs }}ms</span>
            <span class="k">目标模型</span><span class="v mem-mono">{{ callResult.providerId }} / {{ callResult.modelId }}</span>
            <span class="k">思考强度</span><span class="v">{{ callResult.effort ? effortLabel(callResult.effort) : "—" }}</span>
            <span class="k">返回内容</span><span class="v"><pre class="mem-pre">{{ callResult.text }}</pre></span>
          </div>
          <template v-else>
            <div class="mem-banner" style="border-color: var(--danger); background: var(--danger-dim); color: var(--danger)">✗ 调用失败</div>
            <pre class="mem-pre">{{ callResult.message }}</pre>
          </template>
        </template>
        <div v-else class="mem-empty">尚无试调结果</div>
      </div>
      <template #foot>
        <button class="btn btn-ghost" @click="callOpen = false">关闭</button>
      </template>
    </MemDialog>
  </div>
</template>

<style scoped>
.models-sec.memory-scope {
  gap: 0;
}

/* 顶部与图标动效 */
.is-spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}

/* ===== ① 本地网关快捷联动栏 ===== */
.gw-sync-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 12px;
  background: linear-gradient(90deg, rgba(68, 224, 127, 0.08) 0%, rgba(92, 157, 255, 0.05) 100%);
  border: 1px solid rgba(68, 224, 127, 0.22);
  border-radius: var(--r-md);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}
.gw-sync-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.gw-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 600;
}
.gw-status-badge.active {
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid rgba(34, 197, 94, 0.35);
  color: var(--accent-strong, #44e07f);
}
.gw-status-badge.idle {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--line);
  color: var(--text-3);
}
.gw-pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
.gw-info-pills {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gw-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--bg-soft);
  padding: 2px 8px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.gw-action-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-strong);
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  white-space: nowrap;
}
.gw-action-btn:hover {
  text-decoration: underline;
}

/* ===== ② 模型调度策略卡片 ===== */
.strategy-card {
  margin-bottom: 12px;
}
.card-header-compact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.card-title-text {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.card-hint-text {
  font-size: 11.5px;
  color: var(--text-3);
}

.pipeline-grid {
  display: grid;
  grid-template-columns: 1fr 32px 1fr;
  align-items: center;
  gap: 10px;
}
.pipe-node {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  transition: all 0.2s ease;
}
.pipe-node.active {
  border-color: rgba(68, 224, 127, 0.35);
  background: rgba(68, 224, 127, 0.04);
}
.pipe-node.bound {
  border-color: rgba(92, 157, 255, 0.35);
  background: rgba(92, 157, 255, 0.04);
}
.node-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-3);
  text-transform: uppercase;
}
.node-content {
  flex: 1;
  min-width: 0;
}
.node-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.node-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-status-pill {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: var(--r-pill);
}
.node-status-pill.ok {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}
.pipe-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 16px;
}

.degrade-bind-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
.degrade-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
}
.degrade-tip {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 6px;
}

/* ===== ③ 供应商列表 ===== */
.prov-counter {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-strong);
  background: var(--accent-dim);
  padding: 1px 7px;
  border-radius: var(--r-pill);
  margin-left: 6px;
}
.prov-cell-name {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.p-title-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.gw-origin-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(92, 157, 255, 0.15);
  border: 1px solid rgba(92, 157, 255, 0.35);
  color: #5c9dff;
}
.prov-cell-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.prov-fmt-text {
  opacity: 0.8;
}

.status-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  font-size: 11px;
  font-weight: 600;
}
.status-pill.accent {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}
.status-pill.danger {
  background: rgba(242, 109, 109, 0.15);
  color: #f26d6d;
}
.status-pill.idle {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-3);
}
.check-time {
  margin-left: 6px;
  font-size: 11px;
}

.p-models-compact {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.model-tag-pill {
  display: inline-block;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  padding: 2px 7px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-2);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-tag-more {
  font-size: 10px;
  padding: 2px 6px;
  background: var(--surface-3, rgba(255, 255, 255, 0.06));
  border-radius: 4px;
  color: var(--text-3);
}

.prov-tbl td.actions {
  white-space: nowrap;
}
.prov-tbl td.actions .btn-link + .btn-link {
  margin-left: 8px;
}
.prov-tbl td.actions .switch {
  margin-left: 10px;
}

/* ===== ④ 全局参数卡片 ===== */
.params-card {
  margin-top: 12px;
}
.sm-btn {
  padding: 4px 10px;
  font-size: 11.5px;
}
.params-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  padding-top: 4px;
}
.param-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.param-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.ctl-input {
  max-width: 160px;
  height: 30px;
}
.param-tip {
  font-size: 10.5px;
  color: var(--text-3);
}

/* 网关导入弹窗样式 */
.gw-step + .gw-step {
  margin-top: 14px;
}
.gw-step .s-title .mem-hint {
  margin-left: 8px;
}
.gw-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  max-height: 200px;
  overflow: auto;
}
.gw-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  transition: all 0.15s;
}
.gw-item:hover {
  border-color: var(--accent);
}
.gw-item.on {
  border-color: var(--accent);
  background: var(--accent-dim, rgba(74, 158, 255, 0.08));
}
.gw-logo {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  object-fit: contain;
}
.gw-initial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  border: 1px solid var(--line);
}
.gw-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.gw-body b {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gw-body small {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gw-models {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  margin-top: 6px;
  max-height: 220px;
  overflow: auto;
}
.gw-model {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  cursor: pointer;
}
.gw-model input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--accent);
}
.gw-model span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>