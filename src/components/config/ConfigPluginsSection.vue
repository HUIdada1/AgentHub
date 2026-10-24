<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { isWebTransport } from "../../api/caps";
import { timeAgo } from "../../composables/useFormat";
import * as api from "../../api/ipc";

const app = useAppStore();
const webMode = isWebTransport(); // 插件自带的 Web 界面里不显示本页
const items = ref<api.PluginInfo[]>([]);
const busy = ref("");

/** 声明了桥接能力的插件：它们的号池/渠道状态由本程序提供（只读镜像） */
const managed = computed(() => items.value.filter((p) => p.bridgeKinds && p.bridgeKinds.length));

async function refresh() {
  try {
    const list = await api.pluginList();
    items.value = Array.isArray(list) ? list : [];
  } catch { items.value = []; }
}

async function onInstall() {
  if (busy.value) return;
  busy.value = "install";
  try {
    const r = await api.pluginInstall();
    if (!r || r.canceled) return;
    if (!r.ok) { ElMessage.error(r.message || "安装失败"); return; }
    ElMessage.success(r.updated ? `已更新到 v${r.version}` : `已安装 v${r.version}`);
    if (r.warning) ElMessage.warning(r.warning);
    await refresh();
    await app.refreshPlugins();
  } finally { busy.value = ""; }
}

async function onToggle(p: api.PluginInfo) {
  busy.value = p.id;
  try {
    const r = await api.pluginToggle(p.id, !p.enabled);
    if (!r.ok) ElMessage.error(r.message || "操作失败");
    await refresh();
    await app.refreshPlugins();
  } finally { busy.value = ""; }
}

async function onOpen(p: api.PluginInfo) {
  busy.value = p.id;
  try {
    const e = await app.openPluginView(p.id);
    if (e && e.ok) { app.settingsOpen = false; return; }
    const w = await api.pluginOpen(p.id);
    if (!w || !w.ok) ElMessage.error((w && w.message) || (e && e.message) || "启动失败");
    else app.settingsOpen = false;
    await refresh();
    await app.refreshPlugins();
  } finally { busy.value = ""; }
}

async function onUninstall(p: api.PluginInfo) {
  try {
    await ElMessageBox.confirm(`卸载「${p.name}」后立即停止，插件数据保留。确定卸载？`, "卸载外置插件", {
      type: "warning", confirmButtonText: "卸载", cancelButtonText: "取消",
    });
  } catch { return; }
  busy.value = p.id;
  try {
    const r = await api.pluginUninstall(p.id);
    if (!r.ok) { ElMessage.error(r.message || "卸载失败"); return; }
    ElMessage.success("已卸载");
    await refresh();
    await app.refreshPlugins();
  } finally { busy.value = ""; }
}

async function onSync(p: api.PluginInfo) {
  busy.value = "sync-" + p.id;
  try {
    const r = await api.pluginSyncNow(p.id);
    if (!r.ok) { ElMessage.error(r.message || "同步失败"); return; }
    ElMessage.success(`已同步 ${r.imported || 0} 个账号${r.removed ? `，移除 ${r.removed} 个` : ""}`);
    await refresh();
  } finally { busy.value = ""; }
}

/** 同步状态一句话：未同步 / 失败原因 / 上次同步结果 */
function syncText(p: api.PluginInfo): string {
  const s = p.poolSync;
  if (!s || !s.lastAt) return p.running ? "尚未同步" : "插件未运行";
  if (s.lastError) return "上次同步失败：" + s.lastError;
  return `${timeAgo(s.lastAt)}同步 ${s.imported} 个账号` + (s.removed ? `，移除 ${s.removed} 个` : "");
}

onMounted(refresh);
</script>

<template>
  <div v-if="!webMode" class="cfg-sec memory-scope plugins-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">外置插件</div>
        <div class="cfg-sec-sub">
          插件独立运行、独立更新，与主程序版本互不影响；卸载后主程序功能不受影响。
          名称与入口位置由插件包自身声明，主程序不内置任何插件。
        </div>
      </div>
      <div class="cfg-sec-actions">
        <button class="btn btn-cta" :disabled="busy === 'install'" @click="onInstall">
          {{ busy === "install" ? "导入中…" : "＋ 导入插件" }}
        </button>
        <button class="btn btn-ghost" :disabled="!!busy" @click="refresh">刷新</button>
      </div>
    </div>

    <!-- 未安装：空态整块可点击 / 键盘回车导入 -->
    <div v-if="!items.length" class="mem-card ps-empty" tabindex="0" @click="onInstall" @keydown.enter="onInstall">
      <i class="ph ph-puzzle-piece ps-empty-icon"></i>
      <div class="ps-empty-txt">
        <b>尚未安装外置插件</b>
        <span>点击这里或右上角「导入插件」选择插件包（.zip），安装后入口会出现在左侧栏板块列表末尾</span>
      </div>
    </div>

    <!-- 已安装 -->
    <div v-else class="mem-card">
      <div class="mem-card-title">
        已安装
        <span class="mem-hint">共 {{ items.length }} 个</span>
      </div>
      <div class="ps-list">
        <div v-for="p in items" :key="p.id" class="ps-item">
          <div class="ps-item-main">
            <span class="ps-dot" :class="{ on: p.running, warn: p.invalid || !p.compatible }"></span>
            <div class="ps-info">
              <div class="ps-name">
                {{ p.name }}
                <span v-if="p.version" class="ps-ver">v{{ p.version }}</span>
                <span v-if="p.invalid" class="ps-bad">插件损坏</span>
                <span v-else-if="!p.compatible" class="ps-bad">{{ p.compatReason }}</span>
              </div>
              <div class="ps-meta">
                <template v-if="p.invalid">
                  <span class="ps-bad">{{ p.reason }}</span>
                </template>
                <template v-else>
                  <span :class="p.running ? 'ok' : 'off'">{{ p.running ? "运行中" : p.enabled ? "已启用" : "已停用" }}</span>
                  <span class="ps-sep">·</span>
                  <span>{{ p.embed ? "内嵌打开" : "独立窗口" }}</span>
                  <template v-if="p.lastError">
                    <span class="ps-sep">·</span>
                    <span class="ps-bad">{{ p.lastError }}</span>
                  </template>
                </template>
              </div>
            </div>
          </div>
          <div class="ps-actions">
            <template v-if="!p.invalid">
              <button v-if="p.ui" class="btn-mini" :disabled="busy === p.id" @click="onOpen(p)">打开</button>
              <button class="btn-mini" :disabled="busy === p.id" @click="onToggle(p)">{{ p.enabled ? "停用" : "启用" }}</button>
              <button class="btn-mini" :disabled="busy === 'install'" @click="onInstall">更新</button>
            </template>
            <button class="btn-mini danger" :disabled="busy === p.id" @click="onUninstall(p)">卸载</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 号池托管：插件声明了 pool 桥接时才有内容 -->
    <div v-if="managed.length" class="mem-card">
      <div class="mem-card-title">
        号池来源
        <span class="mem-hint">由「号池管家」统一管理，插件侧只读</span>
      </div>
      <div class="ps-list">
        <div v-for="p in managed" :key="'m-' + p.id" class="ps-item">
          <div class="ps-item-main">
            <span class="ps-dot" :class="{ on: !p.poolSync?.lastError && p.running, warn: !!p.poolSync?.lastError }"></span>
            <div class="ps-info">
              <div class="ps-name">{{ p.name }}</div>
              <div class="ps-meta">
                <span :class="p.poolSync?.lastError ? 'ps-bad' : 'off'">{{ syncText(p) }}</span>
              </div>
            </div>
          </div>
          <div class="ps-actions">
            <button class="btn-mini" :disabled="busy === 'sync-' + p.id || !p.running" @click="onSync(p)">
              {{ busy === "sync-" + p.id ? "同步中…" : "立即同步" }}
            </button>
          </div>
        </div>
      </div>
      <div class="ps-note">
        账号的增删改在「号池管家」里操作，改动会自动同步到插件；在插件里改号池不会生效（下次同步会被覆盖）。
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugins-sec { padding-bottom: 8px; }
.ps-empty {
  margin-top: 10px; border: 1px dashed var(--line-strong); border-radius: var(--r-ctl);
  padding: 22px 18px; display: flex; align-items: center; gap: 12px; cursor: pointer;
  transition: border-color .2s, background .2s;
}
.ps-empty:hover, .ps-empty:focus-visible { border-color: var(--accent); background: var(--bg-soft); outline: none; }
.ps-empty-icon { font-size: 26px; color: var(--text-3); }
.ps-empty-txt { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.ps-empty-txt span { font-size: 11px; color: var(--text-3); }

.ps-list { margin-top: 4px; }
.ps-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 0; border-top: 1px solid var(--line);
}
.ps-item:first-child { border-top: 0; }
.ps-item-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ps-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
.ps-dot.on { background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, .15); }
.ps-dot.warn { background: #f59e0b; }
.ps-info { min-width: 0; }
.ps-name { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ps-ver { font-size: 10px; color: var(--text-3); background: var(--surface-3); border-radius: 4px; padding: 1px 5px; }
.ps-bad { font-size: 10px; color: #f59e0b; }
.ps-meta { font-size: 11px; color: var(--text-3); margin-top: 3px; display: flex; gap: 5px; flex-wrap: wrap; }
.ps-meta .ok { color: #22c55e; }
.ps-meta .off { color: var(--text-3); }
.ps-sep { opacity: .5; }
.ps-actions { display: flex; gap: 6px; flex-shrink: 0; }
.ps-note { margin-top: 8px; font-size: 11px; color: var(--text-3); line-height: 1.6; }

.btn-mini {
  font-size: 11.5px; line-height: 1; padding: 6px 10px; border-radius: var(--r-ctl);
  border: 1px solid var(--line-strong); background: transparent; color: var(--text-2);
  cursor: pointer; transition: border-color .18s, color .18s, background .18s;
}
.btn-mini:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-mini:disabled { opacity: .45; cursor: not-allowed; }
.btn-mini.danger:hover:not(:disabled) { border-color: #ef4444; color: #ef4444; }
</style>
