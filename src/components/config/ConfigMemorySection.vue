<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 配置页（隐藏页，经顶部「配置」按钮进入）：元数据驱动自动渲染，新增配置项零前端改动 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryConfigFieldMeta } from "../../types";
// 模型与网关整体作为配置页的子板块（原独立 tab 已并入此处，调用统计移到仪表盘）
import ModelGatewayPanel from "../memory/ModelGatewayPanel.vue";
import MemHelp from "../memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "config");

const draft = ref<Record<string, unknown>>({});
const groups = ref<{ name: string; keys: string[] }[]>([]);
/** 模型与网关不再是子页签（用户要求去掉那个 tab 按钮），改为配置页顶部的常驻可折叠区块 */
const modelsOpen = ref(true);
const modelsSection = ref<HTMLElement | null>(null);
const tab = ref("");
const dirty = ref<Set<string>>(new Set());
const saving = ref(false);
const jsonOpen = ref(false);
const jsonText = ref("");
/** 高级项（算法权重/内部参数）默认收起：留总开关与强度，细节按需展开 */
const advancedOpen = ref(false);
const busy = ref("");

/** 结构化配置项不在自动表单里编辑，走各自页面（模型与网关等） */
const COMPLEX_TYPES = new Set(["providerlist", "modeltable", "orderlist", "map", "list"]);

/** 高级项：调参与内部参数（权重、阈值、批量、token 上限等）——默认不露，避免把配置页变成调参台 */
const ADVANCED_KEYS = new Set([
  "index.dualIndex", "index.titleBoost", "index.debounceMs",
  "search.weightBm25", "search.weightRecency", "search.weightImportance", "search.weightAffinity",
  "search.weightLayer", "search.weightGraph", "search.timeDecayHalfLife", "search.recallTopK",
  "search.finalTopK", "search.graphExpansionDepth", "search.graphExpansionMax",
  "dedup.l1.normalizeLevel", "dedup.l2.autoMergeThreshold", "dedup.l2.candidateThreshold",
  "dedup.l2.wDice", "dedup.l2.wEdit", "dedup.l2.wTitle", "dedup.l3.topK",
  "dedup.l4.autoUpdateThreshold", "dedup.l4.minCandidateScore", "dedup.l4.batchSize",
  "dedup.duplicateIdentityTypes", "dedup.pendingWarnThreshold",
  "import.batchSize", "import.maxBatchBytes",
  "auto.logKeepDays", "auto.logKeepCount",
  "agents.verifyInterval", "agents.coreMaxTokens", "agents.digestMaxLines", "agents.searchMaxTokens",
  "privacy.redactRules", "sync.packSizeLimitMB",
]);

/** 二级 tab 图标：按分组名映射（未命中回退到通用图标） */
const GROUP_ICON: Record<string, string> = {
  "存储": "ph-database",
  "索引": "ph-list-magnifying-glass",
  "检索": "ph-magnifying-glass",
  "去重": "ph-funnel",
  "归类": "ph-folders",
  "导入": "ph-download-simple",
  "同步": "ph-arrows-clockwise",
  "自动化": "ph-clock-countdown",
  "模型与网关": "ph-cpu",
  "深层记忆": "ph-brain",
  "Agent 接入": "ph-plugs-connected",
  "隐私": "ph-shield-check",
  "界面": "ph-sliders",
};
function groupIcon(name: string): string {
  return GROUP_ICON[name] || "ph-sliders";
}

function readPath(obj: Record<string, any>, key: string): unknown {
  let cur: any = obj;
  for (const seg of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function writePath(obj: Record<string, any>, key: string, value: unknown) {
  const segs = key.split(".");
  let cur: any = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
}

function buildGroups() {
  const map = new Map<string, string[]>();
  const order: string[] = [];
  for (const [key, meta] of Object.entries(mem.schema)) {
    const g = meta.group || "其它";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(key);
  }
  // 「模型与网关」这组的结构化键（providers/models/routing/…）由上面的面板接管，
  // 不再作为独立子页签出现（否则与面板重复、且裸 JSON 编辑体验差）
  const PANEL_GROUPS = new Set(["模型与网关"]);
  groups.value = order.filter((g) => !PANEL_GROUPS.has(g)).map((g) => ({ name: g, keys: map.get(g)! }));
  if (!tab.value && order.length) tab.value = order[0];
}

function syncDraft() {
  draft.value = JSON.parse(JSON.stringify(mem.config || {}));
  dirty.value = new Set();
}

async function refresh() {
  await mem.loadAll(true);
  buildGroups();
  syncDraft();
}

function setValue(key: string, value: unknown) {
  writePath(draft.value, key, value);
  dirty.value = new Set(dirty.value).add(key);
}

function isDefault(key: string, meta: MemoryConfigFieldMeta) {
  const cur = readPath(draft.value, key);
  return JSON.stringify(cur) === JSON.stringify(meta.def);
}

/** 多选项点一下即切换（不用裸勾选框，样式与模块内其它 chip 一致） */
function toggleMulti(key: string, option: string) {
  const list = [...(((readPath(draft.value, key) as string[]) || []))];
  const next = list.includes(option) ? list.filter((x) => x !== option) : [...list, option];
  setValue(key, next);
}

function resetOne(key: string, meta: MemoryConfigFieldMeta) {
  setValue(key, JSON.parse(JSON.stringify(meta.def)));
}

async function save() {
  if (!dirty.value.size) {
    ElMessage.info("没有改动");
    return;
  }
  const entries: Record<string, unknown> = {};
  for (const key of dirty.value) entries[key] = readPath(draft.value, key);
  saving.value = true;
  try {
    await mem.save(entries);
    ElMessage.success(`已保存 ${Object.keys(entries).length} 项`);
    syncDraft();
    buildGroups();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function resetAll() {
  try {
    await ElMessageBox.confirm("把「记忆仓库」的全部配置恢复为默认值？", "恢复默认", { type: "warning" });
  } catch {
    return;
  }
  busy.value = "reset";
  try {
    await mem.reset();
    ElMessage.success("已恢复默认");
    syncDraft();
  } catch (e) {
    ElMessage.error((e as Error).message || "恢复失败");
  } finally {
    busy.value = "";
  }
}

async function exportJson() {
  try {
    const r = await api.memoryConfigExport();
    await navigator.clipboard.writeText(r.json);
    ElMessage.success("配置 JSON 已复制到剪贴板");
  } catch (e) {
    ElMessage.error((e as Error).message || "导出失败");
  }
}

async function importJson() {
  try {
    const r = await api.memoryConfigImport(jsonText.value);
    ElMessage.success(`已应用 ${r.applied} 项`);
    jsonOpen.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "导入失败（检查 JSON 格式）");
  }
}

async function changeRoot() {
  const r = await api.browseDir();
  if (!r.ok || !r.path) return;
  busy.value = "root";
  try {
    const res = await api.memoryRootSet(r.path, true);
    ElMessage.success(`根目录已迁移到 ${res.root}（索引已随新目录重建）`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "迁移失败");
  } finally {
    busy.value = "";
  }
}

async function toggleModule(enabled: boolean) {
  try {
    // 后端 memoryToggle 已经把框架配置落盘；这里只同步内存态，
    // 别再整份 saveConfig（那会把渲染层启动时的旧值写回，重启后开关自己弹回来）
    const r = await api.memoryToggle(enabled);
    if (app.config.memory) app.config.memory.enabled = r.enabled;
    ElMessage.success(enabled ? "记忆仓库已启用" : "记忆仓库已停用");
    await mem.loadStatus();
  } catch (e) {
    ElMessage.error((e as Error).message || "切换失败");
  }
}

function optionsOf(meta: MemoryConfigFieldMeta): string[] {
  return meta.options || [];
}

onMounted(refresh);
watch(active, (v) => {
  if (v) void refresh();
});

// 从仪表盘/自动化页点「模型与网关」进来时：展开该区块并滚到可视区（消费后清掉提示）
watch(
  () => [active.value, mem.configTabHint] as const,
  ([on, hint]) => {
    if (!on || !hint) return;
    modelsOpen.value = true;
    mem.configTabHint = "";
    window.setTimeout(() => modelsSection.value?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  },
  { immediate: true },
);

const tabMeta = computed(() => groups.value.find((g) => g.name === tab.value));
/** 当前分组里可编辑的键（模型与网关那组已被面板接管，见 buildGroups 的过滤） */
const visibleKeys = computed(() => (tabMeta.value ? tabMeta.value.keys.filter((k) => mem.schema[k]) : []));
/** 拆成「常用」与「高级」两批：高级项默认收起 */
const basicKeys = computed(() => visibleKeys.value.filter((k) => !ADVANCED_KEYS.has(k)));
const advancedKeys = computed(() => visibleKeys.value.filter((k) => ADVANCED_KEYS.has(k)));
/** 实际渲染的键：默认只出常用项，点「高级项」把调参项一并带出（不改变原顺序） */
const shownKeys = computed(() => (advancedOpen.value ? visibleKeys.value : basicKeys.value));
</script>

<template>
  <!-- 版式对齐「设置 · 用量统计」的配置页：cfg-sec 标题行 + cfg-subtabs 二级切换 + 玻璃卡片 -->
  <div class="cfg-sec memory-scope">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">配置 · 记忆仓库</div>
        <div class="cfg-sec-sub">
          配置事实源：<span class="mem-mono">{{ mem.root }}/config/memory.config.json</span>（随 WebDAV 同步）· 本机覆盖：memory.config.local.json
        </div>
      </div>
      <div class="cfg-sec-actions">
        <span class="mem-chip" :class="dirty.size ? 'warn' : 'accent'">{{ dirty.size ? `${dirty.size} 项未保存` : "已同步" }}</span>
        <button class="btn" :disabled="busy === 'reset'" @click="resetAll">恢复默认</button>
        <button class="btn btn-cta" :disabled="saving || !dirty.size" @click="save">{{ saving ? "保存中" : "保存配置" }}</button>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        模块与存储
        <span class="mem-hint">根目录改动需迁移数据（可勾选自动迁移）</span>
      </div>
      <div class="mem-kv">
        <span class="k">启用状态</span>
        <span class="v">
          <div class="switch" :class="{ on: mem.enabled }" role="switch" :aria-checked="!!mem.enabled" @click="toggleModule(!mem.enabled)"></div>
          <span class="mem-hint">{{ mem.enabled ? "已启用" : "已停用（记忆文件与配置都保留）" }}</span>
        </span>
        <span class="k">当前根目录</span>
        <span class="v">
          <span class="mem-mono">{{ mem.root || "—" }}</span>
          <button class="mem-chip click" :disabled="busy === 'root'" @click="changeRoot">
            {{ busy === "root" ? "迁移中…" : "更改并迁移" }}
          </button>
          <button class="mem-chip click" @click="api.memoryOpenDir()">打开</button>
        </span>
        <span class="k">配置备份</span>
        <span class="v">
          <button class="btn btn-ghost" @click="exportJson">导出 JSON</button>
          <button class="btn btn-ghost" @click="jsonOpen = !jsonOpen">导入 JSON</button>
        </span>
      </div>
    </div>

    <div v-if="jsonOpen" class="mem-card">
      <div class="mem-card-title">导入配置（合并模式，未列出的键保持不变）</div>
      <textarea v-model="jsonText" class="el-textarea__inner" rows="8" placeholder='{"dedup": {"l2": {"autoMergeThreshold": 0.85}}}'></textarea>
      <div class="mem-row" style="margin-top: 8px">
        <button class="btn btn-cta" @click="importJson">应用</button>
        <button class="btn btn-ghost" @click="jsonOpen = false">取消</button>
      </div>
    </div>

    <!-- 模型与网关：常驻区块（不再是子页签按钮），默认展开、可收起 -->
    <section ref="modelsSection" class="mem-card">
      <div class="mem-card-title">
        模型与网关
        <span class="mem-hint">供应商 / 模型池 / 标签路由；调用统计见「仪表盘」</span>
        <MemHelp text="记忆模块的 AI 处理（摘要/打标/去重/蒸馏/画像）都从这里取模型。来源优先级、供应商与模型开关、思考强度、三级连通测试都在这一块；改完即生效。" />
        <button class="mem-chip click" @click="modelsOpen = !modelsOpen">{{ modelsOpen ? "收起" : "展开" }}</button>
      </div>
      <ModelGatewayPanel v-if="modelsOpen" />
    </section>

    <div class="cfg-subtabs">
      <button
        v-for="g in groups"
        :key="g.name"
        class="cfg-subtab"
        :class="{ active: tab === g.name }"
        @click="tab = g.name"
      >
        <i class="ph" :class="groupIcon(g.name)"></i>{{ g.name }}
      </button>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        {{ tab }}
        <span class="mem-inline-ctl">
          <span class="mem-hint">{{ shownKeys.length }} 项（热生效项改完即用；标 ❄ 的需重启或重建索引）</span>
          <button v-if="advancedKeys.length" class="mem-chip click" :class="advancedOpen ? 'accent' : ''" @click="advancedOpen = !advancedOpen">
            高级项 {{ advancedKeys.length }} {{ advancedOpen ? "▲" : "▼" }}
          </button>
        </span>
      </div>

      <div v-for="key in shownKeys" :key="key" class="mem-field">
        <div>
          <div class="f-label">
            <span v-if="!isDefault(key, mem.schema[key])" class="f-dot" title="已偏离默认值"></span>
            {{ mem.schema[key].label || key }}
            <span v-if="mem.schema[key].hot === false" class="mem-chip">❄ 需重启/重建</span>
          </div>
          <div class="f-desc">{{ mem.schema[key].desc || key }}</div>
        </div>

        <div class="f-ctl">
          <template v-if="COMPLEX_TYPES.has(mem.schema[key].type)">
            <span class="mem-hint">结构化配置项，请到对应页面编辑</span>
          </template>

          <template v-else-if="mem.schema[key].type === 'boolean'">
            <div class="switch" :class="{ on: !!readPath(draft, key) }" role="switch" :aria-checked="!!readPath(draft, key)" @click="setValue(key, !readPath(draft, key))"></div>
            <span class="mem-hint">{{ readPath(draft, key) ? "开启" : "关闭" }}</span>
          </template>

          <template v-else-if="mem.schema[key].type === 'number'">
            <input
              type="number"
              class="f-input"
              style="max-width: 160px"
              :min="mem.schema[key].min"
              :max="mem.schema[key].max"
              :step="mem.schema[key].step"
              :value="readPath(draft, key)"
              @input="setValue(key, Number(($event.target as HTMLInputElement).value))"
            />
            <span class="mem-hint">默认 {{ mem.schema[key].def }}<template v-if="mem.schema[key].min !== undefined"> · 范围 {{ mem.schema[key].min }}~{{ mem.schema[key].max }}</template></span>
          </template>

          <template v-else-if="mem.schema[key].type === 'enum'">
            <select class="f-select" style="max-width: 240px" :value="readPath(draft, key)" @change="setValue(key, ($event.target as HTMLSelectElement).value)">
              <option v-for="o in optionsOf(mem.schema[key])" :key="o" :value="o">{{ o }}</option>
            </select>
          </template>

          <template v-else-if="mem.schema[key].type === 'multiselect'">
            <span
              v-for="o in optionsOf(mem.schema[key])"
              :key="o"
              class="mem-chip click"
              :class="((readPath(draft, key) as string[]) || []).includes(o) ? 'accent' : ''"
              role="checkbox"
              :aria-checked="((readPath(draft, key) as string[]) || []).includes(o)"
              @click="toggleMulti(key, o)"
            >
              {{ o }}
            </span>
          </template>

          <template v-else-if="mem.schema[key].type === 'path'">
            <input class="f-input" style="max-width: 420px" :value="readPath(draft, key)" @input="setValue(key, ($event.target as HTMLInputElement).value)" placeholder="留空使用默认目录" />
            <button class="btn btn-ghost" @click="changeRoot">浏览…</button>
          </template>

          <template v-else>
            <input
              class="f-input"
              style="max-width: 420px"
              :value="readPath(draft, key)"
              @input="setValue(key, ($event.target as HTMLInputElement).value)"
            />
          </template>

          <button class="mem-chip click" :disabled="isDefault(key, mem.schema[key])" @click="resetOne(key, mem.schema[key])">默认</button>
        </div>
      </div>

      <div v-if="!visibleKeys.length" class="mem-empty">该分组暂无可编辑项</div>
    </div>
  </div>
</template>
