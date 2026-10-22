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
<!-- 记忆中枢 · 按标签的路由与降级链（留在配置页，不随「模型与网关」搬到设置）：
     每行可绑定指定网关/供应商与模型、改任务标签与思考强度，右侧是实际解析出的降级链。
     供应商/模型池已移到「设置 · 模型与网关」，本面板只读它们做下拉选项与链路预览。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import * as api from "../../api/ipc";
import { taskLabel, taskLabelZh, effortLabel } from "./labels";
import MemHelp from "./MemHelp.vue";
import MemSelect from "./MemSelect.vue";

type Provider = { id: string; name: string; enabled: boolean };
type Model = { id: string; providerId: string; modelId: string; enabled: boolean };
type Routing = { task: string; tags: string[]; effort: string; providerId?: string; modelId?: string; modelState?: string; chain: { providerId: string; providerName: string; modelId: string; priority: number; source: string; fallback?: boolean }[]; tagFallback?: boolean };
/** 路由表里的一条任务级绑定配置（后端 models.routing 的原始条目） */
type RouteEntry = { task: string; tags?: string[]; providerId?: string; modelId?: string };
type SourcesState = {
  order: string[]; tagDefs: string[];
  routing?: RouteEntry[]; taskEffort?: Record<string, string>;
  sources?: { key: string; available: boolean; detail: string }[];
};

const providers = ref<Provider[]>([]);
const models = ref<Model[]>([]);
const routing = ref<Routing[]>([]);
const sources = ref<SourcesState>({ order: [], tagDefs: [] });
const busy = ref("");
const loadError = ref("");

/** 任务级思考强度可选项：不给 custom（任务层没有预算输入，custom 只该在模型/单次调用层用） */
const ROUTE_EFFORTS = ["off", "minimal", "low", "medium", "high"];
const routeEffortOptions = ROUTE_EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }));

const HELP = {
  routing: "按标签展开的降级链：先按「绑定网关/供应商」过滤（绑定了就只用它；它名下没有带匹配标签的模型时，用它全部启用模型兜底），再在同标签内按优先级排序逐个尝试；某个模型 401/403 会立刻换下一个，429/5xx 会退避重试。没有带匹配标签的启用模型时，用全部启用模型兜底并提示「换更强模型效果更好」；模型池彻底没有启用模型时该任务才会被跳过并提示（不会静默什么都不做）。",
  routingEdit: "每行都能给任务绑定指定的网关/供应商与模型：绑定后该任务只走它（它挂了就跳过本次，不再试别的来源）；「全部」则按「设置 · 模型与网关」里的来源优先级在匹配标签的模型里挑。「指定模型」是再进一步——链上把它排最前，失败仍会落到链上后面的模型；它是显式指定，所以即使该模型没带这个任务的标签也照用（标签只决定「没指定时挑谁」）。",
  quirks: "上游不标准时的自动修正：例如它不认 reasoning_effort 或 temperature，首次被拒后会被记下来，之后的调用不再发该参数，避免每次都多付一次 400 与重试。",
};

/** 路由表里某任务的「绑定供应商」选项：空值＝按来源优先级，gw-local＝本机网关。
    el-select 把空串视作"没选"，会退回 placeholder —— 所以这里的 placeholder
    必须写成同一个语义（见模板），否则用户只看到光秃秃的「全部」。 */
function routeProviderOptions() {
  return [
    { value: "", label: "全部（按来源优先级）" },
    ...providers.value.map((p) => ({ value: p.id, label: p.name })),
    { value: "gw-local", label: "本机网关" },
  ];
}
/** 路由表里某任务的「指定模型」选项：空＝不限，其余为该任务标签下的可用模型。
 *  label 只放模型名：带「（供应商）」的写法在 190px 的下拉里会被截成「claude-3-5-sonnet（我…」，
 *  供应商信息在上一个下拉与降级链里都能看到，这里不必重复。 */
function routeModelOptions(r: Routing) {
  return [
    { value: "", label: "按标签+优先级" },
    ...modelsForRoute(r).map((m) => ({ value: m.modelId, label: m.modelId })),
  ];
}

/** 空链的原因提示：说清是标签没人带还是模型都被停用，并给出下一步该动哪个旋钮 */
function chainHint(r: Routing) {
  const hasEnabledModel = models.value.some((m) => m.enabled);
  if (!hasEnabledModel) return "模型池里没有已启用的模型 —— 先到「设置 · 模型与网关」拉取模型并启用";
  if (!r.tags.length) return "该任务没有可用标签 —— 点左侧标签单元格补一个";
  return `没有启用模型带「${r.tags.join(" / ")}」标签 —— 到「设置 · 模型与网关」的模型池给某个模型补标签，或在本行「指定模型」里直接选一个（指定优先于标签）`;
}

/** 兜底链提示：任务现在能用（用启用模型兜底），但提醒换更强模型效果更好 */
function fallbackHint(r: Routing) {
  return `没有带「${r.tags.join(" / ")}」标签的启用模型，已用池里全部启用模型兜底，任务照常执行。蒸馏/画像这类任务用更强模型效果更好：到「设置 · 模型与网关」给某个模型补标签可精确指定，或在本行「指定模型」里直接选一个（指定优先于标签）。`;
}

function providerNameOf(pid: string) {
  if (pid === "gw-local") return "本机网关";
  return providers.value.find((p) => p.id === pid)?.name || pid;
}
const modelsOf = (providerId: string) => models.value.filter((m) => m.providerId === providerId);

/** 指定模型下拉的候选：绑定了供应商就只列它名下启用的模型，否则列全部启用的模型 */
function modelsForRoute(r: Routing) {
  const pool = r.providerId ? modelsOf(r.providerId) : models.value;
  return pool.filter((m) => m.enabled);
}

async function refresh() {
  loadError.value = "";
  try {
    const [p, m, rt, src] = await Promise.all([
      api.memoryProviderList(),
      api.memoryModelList(),
      api.memoryLlmRouting(),
      api.memoryLlmSources(),
    ]);
    providers.value = ((p.providers as unknown as Provider[]) || []).filter((x) => x.id !== "gw-local");
    models.value = (m.models as unknown as Model[]) || [];
    routing.value = (rt.routing as unknown as Routing[]) || [];
    sources.value = src as unknown as SourcesState;
  } catch (e) {
    loadError.value = (e as Error).message || "读取路由配置失败";
  }
}

/**
 * 任务级路由统一保存口。后端 saveSources 对 routing/taskEffort 是整键替换，所以每次带全量；
 * routing 以 sources().routing 的原始条目为基底增量改（预览行的 tags 可能来自默认映射，不能直接固化）。
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

/** 父级（配置页）在激活时重拉一次：供应商/模型池可能在设置页被改过 */
defineExpose({ refresh });

onMounted(() => { void refresh(); });
</script>

<template>
  <div class="mem-col">
    <div v-if="loadError" class="mem-banner">
      <span class="b-grow">读取路由配置失败：{{ loadError }}</span>
      <button class="btn-outline" @click="refresh">重试</button>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        按标签的路由与降级链
        <span class="mem-hint">每行可绑定指定网关/供应商与模型；不绑定则按来源优先级在匹配标签的启用模型里挑</span>
        <MemHelp :text="HELP.routingEdit" />
        <button class="btn btn-ghost" @click="refresh">刷新链路</button>
      </div>
      <div class="mem-table-wrap">
        <table class="mem-table routing-table">
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
                  placeholder="按来源优先级"
                  :disabled="busy === `route-${r.task}`"
                  :options="routeProviderOptions()"
                  @change="(v: string | number) => onPinProvider(r, String(v))"
                />
              </td>
              <td>
                <MemSelect
                  :model-value="r.modelId || ''"
                  width="190px"
                  placeholder="按标签+优先级"
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
                  <button class="btn-link tag-btn" @click="setRouteTags(r)">{{ r.tags.map(taskLabelZh).join("、") }}</button>
                </el-tooltip>
              </td>
              <td>
                <MemSelect
                  :model-value="r.effort || ''"
                  width="140px"
                  placeholder="用模型默认"
                  :disabled="busy === `route-${r.task}`"
                  :options="[{ value: '', label: '用模型默认' }, ...routeEffortOptions]"
                  @change="(v: string | number) => saveRouting(r.task, { effort: String(v) })"
                />
              </td>
              <td>
                <template v-if="r.chain.length">
                  <el-tooltip
                    v-for="(c, i) in r.chain"
                    :key="i"
                    :content="`${i + 1}. ${c.providerName}/${c.modelId}`"
                    placement="top"
                  >
                    <span class="mem-chip chain-chip" :class="i === 0 ? 'accent' : ''">{{ i + 1 }}. {{ c.providerName }}/{{ c.modelId }}</span>
                  </el-tooltip>
                  <!-- 兜底链：任务能用，但提醒换更强模型效果更好（行内小问号给完整说明） -->
                  <template v-if="r.tagFallback">
                    <span class="mem-chip warn" style="margin-left: 6px">已兜底</span>
                    <MemHelp :text="fallbackHint(r)" />
                  </template>

                </template>
                <!-- 空链要给出路，不能只丢一句「无可用模型」：chip 只放短词，完整出路在 tooltip 里。
                     曾经把整句 chainHint 塞进 chip（nowrap）→ 这一列被撑到 800+px，整张表横向溢出 -->
                <el-tooltip v-else :content="chainHint(r)" placement="top">
                  <span class="mem-chip warn">无可用模型</span>
                </el-tooltip>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mem-hint" style="margin-top: 8px">链怎么看：{{ HELP.routing }}</div>
      <div class="mem-hint" style="margin-top: 4px">上游不标准时的自动修正 <MemHelp :text="HELP.quirks" /></div>
    </div>
  </div>
</template>

<style scoped>
/* 记忆中枢配置页是整页宽布局，但六列都带固定宽下拉，容器一窄浏览器就会把「标签」列
   压到最小内容宽度（中文逐字竖排）。这里给表格兜一个最小宽度，窄了走横向滚动而不是压列。 */
.routing-table {
  /* 正常宽度下撑满容器；容器窄于 1060 时才横向滚动（而不是把列压扁） */
  width: 100%;
  min-width: 1060px;
}
/* 标签是「提取、摘要、去重」这类中文短词，允许列宽按内容走，不允许逐字换行 */
.tag-btn {
  white-space: nowrap;
}
/* 降级链的单个 chip 是「供应商/模型」，长名字（如 claude-3-5-sonnet）会把整列撑开：
   限制宽度 + 省略号，完整内容在 tooltip 里 */
.chain-chip {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
</style>
