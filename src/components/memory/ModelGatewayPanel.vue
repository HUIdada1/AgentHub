<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 模型与网关面板：来源优先级 + 供应商 CRUD（Base URL / API 格式三选一 / Key）+ 模型池表格 + 标签降级链 + 三级测试。
     原为独立 tab「模型与网关」，现整体迁入配置页作为子板块；调用统计另见仪表盘。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { timeAgo } from "../../composables/useFormat";
import { taskLabel, taskLabelZh, effortLabel } from "./labels";
import MemHelp from "./MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();

type Provider = {
  id: string; name: string; kind: string; baseUrl: string; apiFormat: string;
  apiKeyMasked: string; hasKey: boolean; enabled: boolean; note: string;
  status: string; lastCheck: { at: number; ok: boolean; latencyMs?: number; models?: number } | null;
  modelCount: number; enabledModelCount: number; isGateway: boolean;
};
type Model = {
  id: string; providerId: string; modelId: string; displayName: string; enabled: boolean;
  reasoning: { enabled: boolean; effort: string; customBudget: number | null };
  tags: string[]; priority: number; temperature: number; maxTokens: number;
};
type Routing = { task: string; tags: string[]; effort: string; chain: { providerName: string; modelId: string; priority: number; source: string }[] };
type Gateway = { id: string; name: string; baseUrl: string; available: boolean; urlOverride: string; modelCount: number; enabledModelCount: number; fallbackModel: string };

const providers = ref<Provider[]>([]);
const gateways = ref<Gateway[]>([]);
const models = ref<Model[]>([]);
const routing = ref<Routing[]>([]);
const sources = ref<{ order: string[]; tagDefs: string[] }>({ order: [], tagDefs: [] });
const testResult = ref<{ providerId: string; l1: any; l2: any; l3: any; suggestion: any } | null>(null);
const busy = ref("");
const drawer = ref(false);
const form = ref({ id: "", name: "", baseUrl: "", apiFormat: "chat_completions", apiKey: "", note: "", enabled: true, kind: "" });
const fetchResult = ref<{ id: string; list: { id: string; tags: string[]; reasoning: { enabled: boolean; effort: string } }[] } | null>(null);
const selectedModels = ref<string[]>([]);
const testCallOut = ref("");

const EFFORTS = ["off", "minimal", "low", "medium", "high", "custom"];
const FORMATS = [
  { id: "anthropic_messages", label: "Anthropic Messages", path: "POST /v1/messages", desc: "Claude 系端点、Claude 中转" },
  { id: "chat_completions", label: "Chat Completions", path: "POST /v1/chat/completions", desc: "OpenAI 系、绝大多数兼容端点、本机网关" },
  { id: "responses", label: "Responses", path: "POST /v1/responses", desc: "OpenAI 新接口" },
];

const HELP = {
  sources: "记忆模块调模型时按这里的顺序找来源：本机网关零成本优先，其次是自备 Key 的自定义供应商，全都不行就跳过本次 AI 处理（只记 L1，不报错）。拖动条目调顺序。",
  format: "上游端点的协议形态。选错会一直 404/400：Claude 系与 Claude 中转多是 Anthropic Messages，绝大多数兼容端点与本机网关是 Chat Completions，OpenAI 新接口是 Responses。拿不准就先按默认测一次，三级测试会给建议。",
  key: "API Key 用本机系统级加密（safeStorage/DPAPI）落盘，界面只回掩码；导出配置时不含 Key。留空表示沿用原有 Key，或走本机网关的号池。",
  test: "三级测试：① 连通（能不能握手）→ ② 鉴权（Key 有没有效）→ ③ 格式能力（用你选的格式发一次最小真实请求）。第三级最关键——它能直接告诉你格式选错了。",
  fetch: "从上游 /models 端点拉模型列表。拉回来的模型会按名字预判标签与思考强度（只是预填，可改）。端点不提供 /models 时改用手动添加。",
  modelTable: "每行一个模型：关掉开关即从所有任务的选择器里消失；「标签」决定哪些任务能用它；「优先级」越小越先被选中；「思考强度」是模型级默认值（任务与单次调用可覆盖）。",
  effort: "思考强度五档：off 不发思考参数；minimal/low/medium/high 控制推理预算（越高质量越好、越费 token）；custom 手动填预算。判定类任务（去重/分类）用低档，蒸馏/画像用中高档。",
  tags: "用途标签是任务与模型之间的唯一约定：任务声明「我要 heavy、summarize 的模型」，就在带这些标签且已启用的模型里按优先级挑。可以只用一个模型打全部标签，也可以配 10 个模型分多档。",
  routing: "按标签展开的降级链：同标签内按优先级排序，逐个尝试；某个模型 401/403 会立刻换下一个，429/5xx 会退避重试。链上没有任何模型时该任务会被跳过并提示（不会静默什么都不做）。",
  testCall: "用该模型 + 指定思考强度发一次真实小请求，验证端到端可用（含上游不标准参数的自动修正）。",
  quirks: "上游不标准时的自动修正：例如它不认 reasoning_effort 或 temperature，首次被拒后会被记下来，之后的调用不再发该参数，避免每次都多付一次 400 与重试。",
};

async function refresh() {
  await mem.loadAll();
  try {
    // 网关走专属「反代网关」列表，不进供应商卡片（mock 数据里带 gw-local，真实后端不带）
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
    sources.value = (await api.memoryLlmSources()) as unknown as { order: string[]; tagDefs: string[] };
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
  drawer.value = true;
}

async function saveProvider() {
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    ElMessage.warning("名称与 Base URL 必填");
    return;
  }
  busy.value = "save";
  try {
    await api.memoryProviderSave({ ...form.value });
    ElMessage.success("已保存（Key 以本机加密信封落盘，界面只回掩码）");
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
    ElMessage.success("已删除");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function testProvider(p: Provider) {
  busy.value = p.id;
  testResult.value = null;
  try {
    const r = await api.memoryProviderTest(p.id);
    testResult.value = { providerId: p.id, ...(r as any) };
    ElMessage[r.l3.ok ? "success" : "warning"](r.l3.ok ? "三级全部通过" : "测试未全通过，见下方结果");
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

async function removeModel(m: Model) {
  try {
    await api.memoryModelDelete(m.id);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function batch(op: "enable" | "disable") {
  if (!selectedModels.value.length) {
    ElMessage.info("先勾选模型");
    return;
  }
  try {
    const r = await api.memoryModelBatch(selectedModels.value, op);
    ElMessage.success(`已${op === "enable" ? "启用" : "禁用"} ${r.changed} 个`);
    selectedModels.value = [];
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "批量操作失败");
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

// 网关详情弹窗：列表点行进详情，模型池按 providerId=gw-local 过滤，操作与供应商模型同款
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
  testCallOut.value = "";
  try {
    const r = await api.memoryLlmTestCall(p.id, m ? m.modelId : undefined, m ? m.reasoning.effort : undefined);
    testCallOut.value = r.ok ? `✓ ${r.latencyMs}ms · ${r.providerId}/${r.modelId} · effort=${r.effort} · 返回「${r.text}」` : `✗ ${r.message}`;
    ElMessage[r.ok ? "success" : "error"](r.ok ? "真实调用成功" : "调用失败（见下方）");
  } catch (e) {
    testCallOut.value = (e as Error).message || "调用失败";
    ElMessage.error(testCallOut.value);
  } finally {
    busy.value = "";
  }
}

/** 批量勾选（用 el-checkbox 保持多选语义，样式与全局统一） */
function toggleSelect(id: string, checked: boolean) {
  selectedModels.value = checked ? [...selectedModels.value, id] : selectedModels.value.filter((x) => x !== id);
}

const modelsOf = (providerId: string) => models.value.filter((m) => m.providerId === providerId);

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

    <div class="mem-card">
      <div class="mem-card-title">
        模型来源优先级
        <span class="mem-hint">拖动调整顺序：靠前者优先尝试</span>
        <MemHelp :text="HELP.sources" />
      </div>
      <div class="mem-col" style="gap: 6px">
        <div
          v-for="(key, i) in sources.order"
          :key="key"
          class="mem-chain-node mem-draggable"
          :class="{ 'is-dragging': dragKey === key }"
          draggable="true"
          @dragstart="dragKey = key"
          @dragend="dragKey = ''"
          @dragover.prevent
          @drop.prevent="onSourceDrop(key, false)"
        >
          <span class="mem-drag-handle" title="拖动排序">⠿</span>
          <span class="mem-chip accent">{{ i + 1 }}</span>
          <span style="font-weight: 600">
            {{ key === "gateway" ? "本机反代网关（AgentHub，零成本）" : key === "custom" ? "自定义供应商（自备 Key）" : "全部失败 → 优雅降级" }}
          </span>
        </div>
      </div>
      <div class="mem-hint" style="margin-top: 8px">
        「本机网关」由反代网关模块提供（<button class="mem-chip click" @click="app.activeModule = 'proxy'">去反代网关页</button>）；未启动时自动跳到下一个来源。
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

    <div v-for="p in providers" :key="p.id" class="mem-card">
      <div class="mem-card-title">
        <span class="mem-row" style="gap: 8px">
          <span class="mem-dot" :class="p.status === 'online' ? 'ok' : p.status === 'offline' ? 'bad' : 'warn'"></span>
          {{ p.name }}
          <span class="mem-chip">{{ FORMATS.find((f) => f.id === p.apiFormat)?.label || p.apiFormat }}</span>
          <span v-if="p.isGateway" class="mem-chip accent">本机网关</span>
        </span>
        <span class="mem-hint">
          {{ p.modelCount }} 个模型 · 启用 {{ p.enabledModelCount }}
          <template v-if="p.lastCheck"> · 上次测试 {{ timeAgo(p.lastCheck.at) }}{{ p.lastCheck.latencyMs ? ` · ${p.lastCheck.latencyMs}ms` : "" }}</template>
        </span>
      </div>
      <div class="mem-kv">
        <span class="k">Base URL</span><span class="v"><span class="mem-mono">{{ p.baseUrl }}</span></span>
        <span class="k">API Key</span>
        <span class="v">
          <span class="mem-mono">{{ p.apiKeyMasked || "（未设置 / 走网关号池）" }}</span>
          <span class="mem-chip" style="margin-left: 6px">{{ p.hasKey ? "已加密落盘" : "无" }}</span>
          <MemHelp :text="HELP.key" />
        </span>
      </div>
      <div class="mem-tile-foot" style="margin-top: 8px">
        <button class="btn btn-ghost" :disabled="busy === p.id" @click="testProvider(p)">{{ busy === p.id ? "测试中…" : "三级连接测试" }}</button>
        <MemHelp :text="HELP.test" />
        <button class="btn btn-ghost" :disabled="busy === `fetch-${p.id}`" @click="fetchModels(p)">拉取模型</button>
        <MemHelp :text="HELP.fetch" />
        <button class="btn btn-ghost" @click="addManual(p.id)">＋ 手动添加模型</button>
        <button class="btn btn-ghost" :disabled="busy === `call-${p.id}`" @click="testCall(p)">真实调用一次</button>
        <MemHelp :text="HELP.testCall" />
        <button class="btn btn-ghost" @click="openDrawer(p)">编辑</button>
        <button class="btn btn-outline danger" @click="removeProvider(p)">删除</button>
        <span style="margin-left: auto; display: inline-flex; align-items: center; gap: 4px">
          <select
            class="f-select"
            style="max-width: 180px"
            :value="p.apiFormat"
            @change="api.memoryProviderSave({ ...p, apiFormat: ($event.target as HTMLSelectElement).value }).then(() => { ElMessage.success('格式已更新'); refresh(); })"
          >
            <option v-for="f in FORMATS" :key="f.id" :value="f.id">{{ f.label }}</option>
          </select>
          <MemHelp :text="HELP.format" />
        </span>
      </div>

      <div v-if="testResult && testResult.providerId === p.id" class="mem-card" style="margin-top: 10px; background: var(--mem-soft)">
        <div class="mem-kv">
          <span class="k">① 连通</span><span class="v">{{ testResult.l1.ok ? `✓ ${testResult.l1.latencyMs}ms` : `✗ ${testResult.l1.message}` }}</span>
          <span class="k">② 鉴权</span><span class="v">{{ testResult.l2.ok ? `✓ ${testResult.l2.message}` : `✗ ${testResult.l2.message}` }}</span>
          <span class="k">③ 格式能力</span><span class="v">{{ testResult.l3.ok ? `✓ ${testResult.l3.message}` : `✗ ${testResult.l3.message}` }}</span>
        </div>
        <div v-if="testResult.suggestion" class="mem-banner" style="margin-top: 8px">
          ⚠️ {{ testResult.suggestion.reason }}
          <button class="mem-chip click" @click="applySuggestion(testResult.suggestion.apiFormat)">改为 {{ testResult.suggestion.apiFormat }} 并重测</button>
        </div>
      </div>

      <div v-if="fetchResult && fetchResult.id === p.id" class="mem-card" style="margin-top: 10px; background: var(--mem-soft)">
        <div class="mem-card-title">
          拉取到 {{ fetchResult.list.length }} 个模型
          <button class="mem-chip click" @click="addFetched(fetchResult.list)">全部加入模型池</button>
        </div>
        <div class="mem-row" style="gap: 6px; max-height: 200px; overflow: auto">
          <span
            v-for="m in fetchResult.list.slice(0, 200)"
            :key="m.id"
            class="mem-chip click"
            @click="addFetched([m])"
            :title="`标签：${m.tags.join('/')}`"
          >
            {{ m.id }}
          </span>
        </div>
      </div>

      <div class="mem-table-wrap" style="margin-top: 12px">
        <table class="mem-table">
          <thead>
            <tr>
              <th style="width: 34px"></th>
              <th>模型 ID</th>
              <th>显示名</th>
              <th>开关</th>
              <th>思考强度 <MemHelp :text="HELP.effort" /></th>
              <th>标签 <MemHelp :text="HELP.tags" /></th>
              <th>优先级</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in modelsOf(p.id)" :key="m.id">
              <td>
                <el-checkbox
                  :model-value="selectedModels.includes(m.id)"
                  @change="toggleSelect(m.id, $event as boolean)"
                />
              </td>
              <td class="mem-mono">{{ m.modelId }}</td>
              <td>{{ m.displayName }}</td>
              <td>
                <div class="switch" :class="{ on: m.enabled }" role="switch" :aria-checked="!!m.enabled" @click="toggleModel(m)"></div>
              </td>
              <td>
                <select
                  class="f-select"
                  style="max-width: 150px"
                  :value="m.reasoning.effort"
                  @change="setEffort(m, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="e in EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
                </select>
                <input
                  v-if="m.reasoning.effort === 'custom'"
                  type="number"
                  class="f-input"
                  style="width: 96px; margin-top: 4px"
                  :value="m.reasoning.customBudget || 4096"
                  @change="setEffort(m, 'custom', Number(($event.target as HTMLInputElement).value))"
                  placeholder="思考预算"
                />
              </td>
              <td>
                <span class="mem-chip click" @click="setTags(m)">{{ m.tags.join(", ") || "（未打标）" }}</span>
              </td>
              <td><span class="mem-chip click" @click="setPriority(m)">{{ m.priority }}</span></td>
              <td>
                <button class="mem-chip click" @click="testCall(p, m)">试调</button>
                <button class="mem-chip click" @click="removeModel(m)">删除</button>
              </td>
            </tr>
            <tr v-if="!modelsOf(p.id).length">
              <td colspan="8" class="mem-empty">这个供应商还没有模型 —— 「拉取模型」或「手动添加模型」</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="modelsOf(p.id).length" class="mem-row" style="margin-top: 8px">
        <button class="btn btn-ghost" @click="batch('enable')">批量启用</button>
        <button class="btn btn-ghost" @click="batch('disable')">批量禁用</button>
        <span class="mem-count" style="align-self: center">已选 {{ selectedModels.length }} 项</span>
        <MemHelp :text="HELP.modelTable" />
      </div>
    </div>

    <div v-if="testCallOut" class="mem-card">
      <div class="mem-card-title">真实调用结果</div>
      <pre class="mem-pre">{{ testCallOut }}</pre>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        按标签的路由与降级链
        <span class="mem-hint">任务声明标签，从带该标签且启用的模型里按优先级取第一个可用</span>
        <MemHelp :text="HELP.routing" />
      </div>
      <div class="mem-table-wrap">
        <table class="mem-table">
          <thead><tr><th>任务</th><th>标签</th><th>思考强度</th><th>降级链（按优先级）</th></tr></thead>
          <tbody>
            <tr v-for="r in routing" :key="r.task">
              <td>{{ taskLabel(r.task) }}</td>
              <td>{{ r.tags.map(taskLabelZh).join("、") }}</td>
              <td>{{ r.effort ? effortLabel(r.effort) : "（用模型默认）" }}</td>
              <td>
                <template v-if="r.chain.length">
                  <span v-for="(c, i) in r.chain" :key="i" class="mem-chip" :class="i === 0 ? 'accent' : ''">{{ i + 1 }}. {{ c.providerName }}/{{ c.modelId }}</span>
                </template>
                <span v-else class="mem-chip warn">无可用模型（任务会跳过并提示）</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mem-hint" style="margin-top: 8px">上游不标准时的自动修正：<MemHelp :text="HELP.quirks" /></div>
    </div>

    <!-- 供应商弹窗（居中小弹窗，非侧拉抽屉） -->
    <Teleport to="body">
      <div class="memory-scope">
        <div class="mem-modal-mask" :class="{ show: drawer }" @click="drawer = false"></div>
        <div class="mem-modal" :class="{ show: drawer }" role="dialog">
          <div class="mem-modal-head">
            <h3 style="margin: 0; font-size: 15px">{{ form.id ? "编辑供应商" : "添加供应商" }}</h3>
            <button class="mem-chip click" @click="drawer = false">✕</button>
          </div>
          <div class="mem-modal-body">
            <div class="mem-section">
              <div class="s-title">名称</div>
              <input v-model="form.name" class="f-input" placeholder="如：我的中转站" />
            </div>
            <div class="mem-section">
              <div class="s-title">Base URL</div>
              <input v-model="form.baseUrl" class="f-input" placeholder="https://api.example.com（程序自动补 /v1 路径）" />
            </div>
            <div class="mem-section">
              <div class="s-title">API 格式（三选一）<MemHelp :text="HELP.format" /></div>
              <div class="mem-seg">
                <div
                  v-for="f in FORMATS"
                  :key="f.id"
                  class="mem-seg-item"
                  :class="{ active: form.apiFormat === f.id }"
                  @click="form.apiFormat = f.id"
                >
                  <div class="sg-name">{{ f.label }}</div>
                  <div class="sg-path">{{ f.path }}</div>
                  <div class="sg-path">{{ f.desc }}</div>
                </div>
              </div>
              <div class="mem-hint" style="margin-top: 6px">选错格式会导致 404/400；测试连接会自动校验并提示正确格式。</div>
            </div>
            <div class="mem-section">
              <div class="s-title">API Key<MemHelp :text="HELP.key" /></div>
              <input v-model="form.apiKey" type="password" class="f-input" :placeholder="form.id ? '留空则保留原 Key' : '粘贴 Key（加密落盘，界面只显掩码）'" />
            </div>
            <div class="mem-section">
              <div class="s-title">备注</div>
              <input v-model="form.note" class="f-input" placeholder="可选" />
            </div>
            <label class="mem-row" style="gap: 8px">
              <div class="switch" :class="{ on: form.enabled }" role="switch" :aria-checked="!!form.enabled" @click="form.enabled = !form.enabled"></div>
              <span class="mem-hint">启用该供应商</span>
            </label>
          </div>
          <div class="mem-modal-foot">
            <button class="btn btn-cta" :disabled="busy === 'save'" @click="saveProvider">
              {{ busy === "save" ? "保存中…" : "保存" }}
            </button>
            <button class="btn btn-ghost" @click="drawer = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 网关详情弹窗：连接信息 + 该网关下的模型池（思考强度/标签/优先级逐项可改） -->
    <Teleport to="body">
      <div class="memory-scope">
        <div class="mem-modal-mask" :class="{ show: !!gwDetail }" @click="gwDetail = null"></div>
        <div class="mem-modal mem-modal-lg" :class="{ show: !!gwDetail }" role="dialog">
          <template v-if="gwDetail">
            <div class="mem-modal-head">
              <h3 style="margin: 0; font-size: 15px">
                <span class="mem-dot" :class="gwDetail.available ? 'ok' : 'bad'" style="margin-right: 6px"></span>{{ gwDetail.name }}
              </h3>
              <button class="mem-chip click" @click="gwDetail = null">✕</button>
            </div>
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
                <button class="btn btn-ghost" :disabled="busy === `call-${gwDetail.id}` || !gwDetail.available" @click="testCall(gwPseudo)">真实调用一次</button>
              </div>

              <div v-if="fetchResult && fetchResult.id === gwDetail.id" class="mem-card" style="margin-top: 10px; background: var(--mem-soft)">
                <div class="mem-card-title">
                  拉取到 {{ fetchResult.list.length }} 个模型
                  <button class="mem-chip click" @click="addFetched(fetchResult.list)">全部加入模型池</button>
                </div>
                <div class="mem-row" style="gap: 6px; max-height: 200px; overflow: auto">
                  <span
                    v-for="m in fetchResult.list.slice(0, 200)"
                    :key="m.id"
                    class="mem-chip click"
                    @click="addFetched([m])"
                    :title="`标签：${m.tags.join('/')}`"
                  >
                    {{ m.id }}
                  </span>
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
                        <select
                          class="f-select"
                          style="max-width: 150px"
                          :value="m.reasoning.effort"
                          @change="setEffort(m, ($event.target as HTMLSelectElement).value)"
                        >
                          <option v-for="e in EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
                        </select>
                      </td>
                      <td><span class="mem-chip click" @click="setTags(m)">{{ m.tags.join(", ") || "（未打标）" }}</span></td>
                      <td><span class="mem-chip click" @click="setPriority(m)">{{ m.priority }}</span></td>
                      <td>
                        <button class="mem-chip click" @click="testCall(gwPseudo, m)">试调</button>
                        <button class="mem-chip click" @click="removeModel(m)">删除</button>
                      </td>
                    </tr>
                    <tr v-if="!modelsOf(gwDetail.id).length">
                      <td colspan="6" class="mem-empty">网关下还没有模型 —— 「拉取模型」或「手动添加模型」</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="mem-hint" style="margin-top: 8px">
                网关模型即「模型来源优先级」中本机网关一档的候选池；什么都不配时回退到网关号池当前模型{{ gwDetail.fallbackModel ? `（${gwDetail.fallbackModel}）` : "" }}。
              </div>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>
