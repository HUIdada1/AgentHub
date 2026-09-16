<!-- 用量统计 · 配置页（右上「配置」按钮切换的模块页）：数据源 / 工具栏切换项 / 调度（含统计口径）/ 数据
     内容承接原「用量统计 · 配置」弹窗；页面内的二级子板块 tab 在这里切换；
     开机自启与关闭最小化到托盘在左下角「设置 · 通用」；WebDAV 服务器与备份在「设置 · WebDAV 同步」「设置 · 数据与备份」 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSyncStore } from "../../stores/sync";
import { useAppStore } from "../../stores/app";
import { useUsageStore } from "../../stores/usage";
import * as api from "../../api/sync";
import { TOTAL_MODES, GROUP_PREFIX } from "../../types/sync";
import type { TotalMode, SourceHealth, TopBarItem } from "../../types/sync";

const app = useSyncStore();
const framework = useAppStore();
const usage = useUsageStore();
const cfg = app.config;

// 页面内的二级子板块：数据源 / 工具栏切换项 / 调度 / 数据
const tab = ref<"sources" | "visibility" | "schedule" | "data">("sources");

const saveResult = ref<{ ok: boolean; message: string } | null>(null);
const saving = ref(false);
const health = ref<SourceHealth[]>([]);
const exportResult = ref<{ ok: boolean; message: string } | null>(null);
const resetResult = ref<{ ok: boolean; message: string } | null>(null);
let exportResultTimer = 0;
let resetResultTimer = 0;

const hourlyIntervals = [1, 2, 3, 6, 12];

// 每次激活都重新拉健康探测（数据源可读性 / 目录可能被别的入口改过）
const active = computed(() => framework.activeModule === "sync" && framework.activePage === "config");
watch(active, async (v) => {
  if (!v) return;
  health.value = await api.healthSource();
}, { immediate: true });

async function save() {
  saving.value = true;
  try {
    saveResult.value = await app.save();
    window.setTimeout(() => { saveResult.value = null; }, 3200);
  } catch (e) {
    saveResult.value = { ok: false, message: `设置保存失败：${e instanceof Error ? e.message : "未知错误"}` };
  } finally {
    saving.value = false;
  }
}
/** 开关/主题类改动即时生效并自动落盘（凭据等文本输入仍走「保存设置」） */
async function autoSave() {
  const r = await app.save();
  if (!r.ok) {
    saveResult.value = r;
    window.setTimeout(() => { saveResult.value = null; }, 3200);
  }
}
async function detect(source: string) {
  const r = await api.detectSource(source);
  // 探测永远指向该源的默认目录，因此不写入 dataDir 钉死路径；
  // 并清掉旧版本可能留下的固定值，恢复「自动探测」语义（有变化才落盘）
  const s = cfg.sources.find((x) => x.source === source);
  if (s && s.dataDir) {
    s.dataDir = null;
    await autoSave();
  }
  const current = health.value.find((item) => item.source === source);
  if (current) {
    current.detected = !!r.path;
    current.dataDir = r.path;
    current.readable = r.ok;
  }
}
async function toggleSource(source: string) {
  const item = cfg.sources.find((entry) => entry.source === source);
  if (item) {
    item.enabled = !item.enabled;
    await autoSave();
  }
}
async function toggleSchedule(key: "hourly" | "daily" | "notifyOnSuccess") {
  cfg.schedule[key] = !cfg.schedule[key];
  await autoSave();
}

// ===== 工具栏切换项（两级：组 + 子项，显隐 + 两级排序） =====
/** 顶层条目（含隐藏项与全部组成员，供设置页两级列表渲染） */
const topItems = computed(() => app.topItems(true));

/** 顶层条目的配置 token：独立源 = 源 id；组 = `g:组key` */
function itemToken(item: TopBarItem): string {
  return item.kind === "group" ? GROUP_PREFIX + item.key : item.source.id;
}

function isVisible(source: string): boolean {
  return !(app.config.sourceVisibility.hidden || []).includes(source);
}

async function toggleVisible(source: string) {
  await app.setSourceVisible(source, !isVisible(source));
}

/** 组内可见子源数（用于组卡片摘要） */
function visibleCount(item: TopBarItem): number {
  return item.kind === "group" ? item.children.filter((c) => isVisible(c.id)).length : 0;
}

async function moveTopUp(token: string) {
  await app.moveTopUp(token);
}
async function moveTopDown(token: string) {
  await app.moveTopDown(token);
}
async function moveChildUp(groupKey: string, id: string) {
  await app.moveChildUp(groupKey, id);
}
async function moveChildDown(groupKey: string, id: string) {
  await app.moveChildDown(groupKey, id);
}

/** 组卡片折叠（会话内状态，不持久化） */
const collapsedGroups = ref<string[]>([]);
function groupCollapsed(key: string): boolean {
  return collapsedGroups.value.includes(key);
}
function toggleGroup(key: string) {
  collapsedGroups.value = groupCollapsed(key)
    ? collapsedGroups.value.filter((k) => k !== key)
    : [...collapsedGroups.value, key];
}

// —— 拖拽排序（HTML5 Drag and Drop；顶层与组内两套载荷互不干扰）——
type DragPayload = { kind: "top"; token: string } | { kind: "child"; group: string; id: string };
const drag = ref<DragPayload | null>(null);
const dragOver = ref<string | null>(null); // 顶层 token 或 `child:组key:源id` 的叠加目标

function setDragData(e: DragEvent, text: string) {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Firefox 需要 setData 才能启动拖拽
    try { e.dataTransfer.setData("text/plain", text); } catch { /* 忽略 */ }
  }
}
/** 组卡片整体可拖（重排组位置）；但拖拽起点在组内子项上时不拦截（子项有自己的拖拽） */
function onTopDragStart(token: string, e: DragEvent) {
  if ((e.target as HTMLElement | null)?.closest(".vis-group-body")) return;
  drag.value = { kind: "top", token };
  setDragData(e, token);
}
function onTopDragOver(token: string, e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  if (dragOver.value !== token) dragOver.value = token;
}
function onTopDrop(token: string) {
  const d = drag.value;
  drag.value = null;
  dragOver.value = null;
  if (!d || d.kind !== "top" || d.token === token) return;
  const idx = topItems.value.findIndex((it) => itemToken(it) === token);
  if (idx < 0) return;
  app.moveTopItem(d.token, idx);
}
function onChildDragStart(group: string, id: string, e: DragEvent) {
  drag.value = { kind: "child", group, id };
  setDragData(e, id);
}
function onChildDragOver(group: string, id: string, e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const token = `child:${group}:${id}`;
  if (dragOver.value !== token) dragOver.value = token;
}
function onChildDrop(group: string, id: string) {
  const d = drag.value;
  drag.value = null;
  dragOver.value = null;
  if (!d || d.kind !== "child" || d.group !== group || d.id === id) return;
  const g = topItems.value.find((it) => it.kind === "group" && it.key === group) as Extract<TopBarItem, { kind: "group" }> | undefined;
  if (!g) return;
  const idx = g.children.findIndex((c) => c.id === id);
  if (idx < 0) return;
  app.moveChildInGroup(group, d.id, idx);
}
function onDragEnd() {
  drag.value = null;
  dragOver.value = null;
}
async function setHourlyInterval(e: Event) {
  const v = parseInt((e.target as HTMLSelectElement).value, 10);
  if (Number.isFinite(v) && v > 0) {
    cfg.schedule.hourlyInterval = v;
    await autoSave();
  }
}
async function setDailyTime(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  if (/^\d{2}:\d{2}$/.test(v)) {
    cfg.schedule.dailyTime = v;
    await autoSave();
  }
}
async function exportData(fmt: "csv" | "json") {
  // 设置页无筛选上下文，导出全部明细；按筛选导出请到「用量明细」页
  const r = await api.exportData(fmt);
  exportResult.value = r?.ok
    ? { ok: true, message: `导出成功：${r.path}` }
    : { ok: false, message: r?.message || "导出失败" };
  window.clearTimeout(exportResultTimer);
  exportResultTimer = window.setTimeout(() => { exportResult.value = null; }, 6000);
}
async function resetCache() {
  const ok = window.confirm(
    "确定清空本地缓存吗？\n\n将删除本地全部明细记录与增量同步记账，WebDAV 上的数据不受影响，下次同步会自动重新拉取合并。"
  );
  if (!ok) return;
  const r = await api.resetLocalCache();
  resetResult.value = r;
  window.clearTimeout(resetResultTimer);
  resetResultTimer = window.setTimeout(() => { resetResult.value = null; }, 6000);
  if (r?.ok) {
    usage.resetOverview();
    await usage.loadOverview();
  }
}
</script>

<template>
  <div class="cfg-sec sync-scope">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">配置 · 用量统计</div>
        <div class="cfg-sec-sub">数据源 · 工具栏切换项 · 调度 · 数据（WebDAV 服务器在左下角「设置 · WebDAV 同步」、备份与缓存目录在「设置 · 数据与备份」、开机自启与托盘在「设置 · 通用」）</div>
      </div>
      <div class="cfg-sec-actions">
        <span v-if="saveResult" class="save-line" :style="{ color: saveResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ saveResult.message }}</span>
        <button class="btn btn-cta" :disabled="saving" @click="save">{{ saving ? "保存中" : "保存配置" }}</button>
      </div>
    </div>

    <!-- 二级子板块 tab：页面内切换，不占横条菜单的位置 -->
    <div class="cfg-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'sources' }" @click="tab = 'sources'"><i class="ph ph-database"></i>数据源</button>
      <button class="cfg-subtab" :class="{ active: tab === 'visibility' }" @click="tab = 'visibility'"><i class="ph ph-list-checks"></i>工具栏切换项</button>
      <button class="cfg-subtab" :class="{ active: tab === 'schedule' }" @click="tab = 'schedule'"><i class="ph ph-clock"></i>调度</button>
      <button class="cfg-subtab" :class="{ active: tab === 'data' }" @click="tab = 'data'"><i class="ph ph-download-simple"></i>数据</button>
    </div>

    <div class="card" v-if="tab === 'sources'">
      <div class="setting-group" style="margin-bottom: 0">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
          数据源
        </div>
        <div v-for="h in health" :key="h.source" class="switch-row">
          <div class="s-left">
            <div class="s-title">{{ h.name }}</div>
            <div class="s-desc">
              <template v-if="h.readable">{{ h.dataDir }} · <span style="color: var(--ok)">可读取</span><span v-if="!app.isSourceEnabled(h.source)" style="color: var(--accent-strong)"> · 检测到可用数据，可一键启用</span></template>
              <template v-else-if="h.detected">{{ h.dataDir }} · <span style="color: var(--err)">数据不可读取</span></template>
              <template v-else>未检测到数据目录</template>
            </div>
          </div>
          <div class="source-actions">
            <button
              v-if="h.readable && !app.isSourceEnabled(h.source)"
              class="btn-outline"
              title="检测到本机有该源的可用数据，点击立即接入"
              @click="toggleSource(h.source)"
            >一键启用</button>
            <button class="btn-outline" @click="detect(h.source)">重新探测</button>
            <div
              class="switch"
              :class="{ on: cfg.sources.find((item) => item.source === h.source)?.enabled }"
              role="switch"
              :aria-checked="!!cfg.sources.find((item) => item.source === h.source)?.enabled"
              :title="app.isSourceEnabled(h.source) ? '停用数据源' : '启用数据源'"
              @click="toggleSource(h.source)"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" v-else-if="tab === 'visibility'">
      <div class="setting-group" style="margin-bottom: 0">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7h8M8 12h8M8 17h8"/></svg>
          工具栏切换项
          <span class="sg-hint">组与子项均可拖拽排序 · 组内顺序即顶栏下拉顺序 · 关闭开关可隐藏</span>
        </div>
        <div class="visibility-list">
          <template v-for="(item, i) in topItems" :key="item.kind === 'group' ? 'g' + item.key : item.source.id">
            <!-- 独立源：单行条目（复用原扁平行交互） -->
            <div
              v-if="item.kind === 'source'"
              class="visibility-item"
              :class="{ dragging: drag?.kind === 'top' && drag.token === item.source.id, 'drag-over': dragOver === item.source.id && drag?.kind === 'top' && drag.token !== item.source.id, hidden: !isVisible(item.source.id) }"
              :draggable="true"
              @dragstart="onTopDragStart(item.source.id, $event)"
              @dragover="onTopDragOver(item.source.id, $event)"
              @drop="onTopDrop(item.source.id)"
              @dragend="onDragEnd"
            >
              <span class="drag-handle" title="拖拽排序">
                <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
              </span>
              <div class="v-title">
                <span class="v-name">{{ item.source.name }}</span>
                <span class="v-sub">#{{ i + 1 }}</span>
              </div>
              <div class="v-actions">
                <button class="icon-btn-sm" :disabled="i === 0" title="上移" @click="moveTopUp(item.source.id)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                </button>
                <button class="icon-btn-sm" :disabled="i === topItems.length - 1" title="下移" @click="moveTopDown(item.source.id)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
                </button>
                <div
                  class="switch"
                  :class="{ on: isVisible(item.source.id) }"
                  role="switch"
                  :aria-checked="isVisible(item.source.id)"
                  :title="isVisible(item.source.id) ? '隐藏该项' : '显示该项'"
                  @click="toggleVisible(item.source.id)"
                ></div>
              </div>
            </div>
            <!-- 组：卡片（折叠 + 组级排序 + 组内子项排序/显隐） -->
            <div
              v-else
              class="vis-group"
              :class="{ 'drag-over': dragOver === itemToken(item) && drag?.kind === 'top' && drag.token !== itemToken(item) }"
              :draggable="true"
              @dragstart="onTopDragStart(itemToken(item), $event)"
              @dragover="onTopDragOver(itemToken(item), $event)"
              @drop="onTopDrop(itemToken(item))"
              @dragend="onDragEnd"
            >
              <div class="vis-group-head" @click="toggleGroup(item.key)">
                <svg class="vis-group-chev" :class="{ folded: groupCollapsed(item.key) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
                <div class="v-title">
                  <span class="v-name">{{ item.label }}</span>
                  <span class="v-sub">{{ item.children.length }} 项 · 可见 {{ visibleCount(item) }}</span>
                </div>
                <div class="v-actions" @click.stop>
                  <button class="icon-btn-sm" :disabled="i === 0" title="上移" @click="moveTopUp(itemToken(item))">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                  </button>
                  <button class="icon-btn-sm" :disabled="i === topItems.length - 1" title="下移" @click="moveTopDown(itemToken(item))">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
                  </button>
                </div>
              </div>
              <div v-if="!groupCollapsed(item.key)" class="vis-group-body">
                <div
                  v-for="(c, ci) in item.children"
                  :key="c.id"
                  class="visibility-item vis-item-child"
                  :class="{ dragging: drag?.kind === 'child' && drag.group === item.key && drag.id === c.id, 'drag-over': dragOver === 'child:' + item.key + ':' + c.id && drag?.kind === 'child' && drag.id !== c.id, hidden: !isVisible(c.id) }"
                  :draggable="true"
                  @dragstart="onChildDragStart(item.key, c.id, $event)"
                  @dragover="onChildDragOver(item.key, c.id, $event)"
                  @drop="onChildDrop(item.key, c.id)"
                  @dragend="onDragEnd"
                >
                  <span class="drag-handle" title="组内拖拽排序">
                    <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
                  </span>
                  <div class="v-title">
                    <span class="v-name">{{ c.name }}</span>
                  </div>
                  <div class="v-actions">
                    <button class="icon-btn-sm" :disabled="ci === 0" title="组内上移" @click="moveChildUp(item.key, c.id)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                    </button>
                    <button class="icon-btn-sm" :disabled="ci === item.children.length - 1" title="组内下移" @click="moveChildDown(item.key, c.id)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
                    </button>
                    <div
                      class="switch"
                      :class="{ on: isVisible(c.id) }"
                      role="switch"
                      :aria-checked="isVisible(c.id)"
                      :title="isVisible(c.id) ? '隐藏该项' : '显示该项'"
                      @click="toggleVisible(c.id)"
                    ></div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="card" v-else-if="tab === 'schedule'">
      <div class="setting-group" style="margin-bottom: 0">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
          调度
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">每小时同步</div><div class="s-desc">{{ cfg.schedule.hourly ? `每 ${cfg.schedule.hourlyInterval} 小时自动上传本机并拉取他机` : "关闭中，开启后自动上传本机并拉取他机" }}</div></div><div style="display:flex;align-items:center;gap:10px"><select v-if="cfg.schedule.hourly" class="f-select" style="width:110px" :value="String(cfg.schedule.hourlyInterval || 1)" @change="setHourlyInterval"><option v-for="n in hourlyIntervals" :key="n" :value="String(n)">{{ n }} 小时</option></select><div class="switch" :class="{ on: cfg.schedule.hourly }" @click="toggleSchedule('hourly')"></div></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">每天固定时间</div><div class="s-desc">每天 {{ cfg.schedule.dailyTime }} 同步一次（错过自动补跑）</div></div><div style="display:flex;align-items:center;gap:10px"><input v-if="cfg.schedule.daily" type="time" class="f-input" style="width:110px" :value="cfg.schedule.dailyTime" @change="setDailyTime" /><div class="switch" :class="{ on: cfg.schedule.daily }" @click="toggleSchedule('daily')"></div></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">同步成功也通知</div><div class="s-desc">默认关闭，仅同步失败时弹系统通知</div></div><div class="switch" :class="{ on: cfg.schedule.notifyOnSuccess }" @click="toggleSchedule('notifyOnSuccess')"></div></div>
        <div class="switch-row" style="padding-bottom:2px">
          <div class="s-left"><div class="s-title">总量口径</div><div class="s-desc">{{ TOTAL_MODES[cfg.totalMode].desc }}</div></div>
          <div class="tabs">
            <button v-for="(v, k) in TOTAL_MODES" :key="k" class="tab" :class="{ active: cfg.totalMode === k }" @click="app.setTotalMode(k as TotalMode)">{{ v.label }}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card" v-else>
      <div class="setting-group" style="margin-bottom: 0">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          数据
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">导出 CSV</div><div class="s-desc">导出全部明细（按筛选导出请到「用量明细」页）</div></div><button class="btn-outline" @click="exportData('csv')">导出</button></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">导出 JSON</div><div class="s-desc">导出统一用量模型原始数据</div></div><button class="btn-outline" @click="exportData('json')">导出</button></div>
        <div v-if="exportResult" class="switch-row"><div class="s-left"><div class="s-desc" :style="{ color: exportResult.ok ? 'var(--ok)' : 'var(--err)', wordBreak: 'break-all' }">{{ exportResult.message }}</div></div></div>
        <div class="switch-row" style="padding-bottom:2px"><div class="s-left"><div class="s-title">清空本地缓存</div><div class="s-desc">删除本地明细与同步记账，WebDAV 数据不动，下次同步自动重拉</div></div><div style="display:flex;align-items:center;gap:10px"><span v-if="resetResult" class="hint" :style="{ color: resetResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ resetResult.message }}</span><button class="btn-outline" @click="resetCache">清空</button></div></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 保存结果提示（原面板的 save-feedback 样式绑定在弹窗 tabs 条下，这里用行内样式替代） */
.save-line {
  font-size: 11px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
