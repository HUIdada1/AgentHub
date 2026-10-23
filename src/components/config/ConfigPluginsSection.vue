<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { isWebTransport } from "../../api/caps";
import * as api from "../../api/ipc";

const app = useAppStore();
const webMode = isWebTransport(); // 插件自带的 Web 界面里不显示本板块
const items = ref<api.PluginInfo[]>([]);
const busy = ref("");

async function refresh() {
  try { items.value = await api.pluginList(); } catch { items.value = []; }
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
    const r = await api.pluginOpen(p.id);
    if (!r.ok) { ElMessage.error(r.message || "启动失败"); return; }
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

onMounted(refresh);
</script>

<template>
  <section v-if="!webMode" class="memory-scope plugins-sec">
    <div class="mem-card ps-card">
      <header class="ps-head">
        <div>
          <div class="ps-title">外置插件</div>
          <div class="ps-sub">插件独立运行、独立更新，与主程序版本互不影响；卸载后不影响主程序功能。</div>
        </div>
        <el-tooltip content="安装插件包（.zip）" placement="top">
          <el-button class="ps-add" circle :loading="busy === 'install'" aria-label="安装插件包" @click="onInstall">
            <i v-if="busy !== 'install'" class="ph ph-plus"></i>
          </el-button>
        </el-tooltip>
      </header>

      <!-- 未安装：空态整块可点击 / 键盘回车安装 -->
      <div v-if="!items.length" class="ps-empty" tabindex="0" @click="onInstall" @keydown.enter="onInstall">
        <i class="ph ph-puzzle-piece ps-empty-icon"></i>
        <div class="ps-empty-txt">
          <b>尚未安装外置插件</b>
          <span>点击右上角 + 选择插件包，安装后入口会出现在左侧栏</span>
        </div>
      </div>

      <!-- 已安装 -->
      <div v-else class="ps-list">
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
                  <span>独立版本</span>
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
              <el-button v-if="p.ui" size="small" :loading="busy === p.id" @click="onOpen(p)">打开</el-button>
              <el-button size="small" :loading="busy === p.id" @click="onToggle(p)">{{ p.enabled ? "停用" : "启用" }}</el-button>
              <el-button size="small" :loading="busy === 'install'" @click="onInstall">更新</el-button>
            </template>
            <el-button size="small" type="danger" plain :loading="busy === p.id" @click="onUninstall(p)">卸载</el-button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plugins-sec { margin-top: 14px; }
.ps-card { padding: 16px 18px; }
.ps-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ps-title { font-size: 13px; font-weight: 600; }
.ps-sub { font-size: 11px; color: var(--text-3); margin-top: 3px; line-height: 1.5; }
.ps-add { width: 30px; height: 30px; padding: 0; flex-shrink: 0; }
.ps-add:hover { border-color: var(--accent); color: var(--accent); }
.ps-empty {
  margin-top: 12px; border: 1px dashed var(--line-strong); border-radius: var(--r-ctl);
  padding: 18px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer;
  transition: border-color .2s, background .2s;
}
.ps-empty:hover, .ps-empty:focus-visible { border-color: var(--accent); background: var(--bg-soft); outline: none; }
.ps-empty-icon { font-size: 26px; color: var(--text-3); }
.ps-empty-txt { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.ps-empty-txt span { font-size: 11px; color: var(--text-3); }
.ps-list { margin-top: 6px; }
.ps-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 0; border-top: 1px solid var(--line);
}
.ps-item:first-child { border-top: 0; }
.ps-item-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ps-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
.ps-dot.on { background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, .15); }
.ps-dot.warn { background: #f59e0b; }
.ps-name { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ps-ver { font-size: 10px; color: var(--text-3); background: var(--surface-3); border-radius: 4px; padding: 1px 5px; }
.ps-bad { font-size: 10px; color: #f59e0b; }
.ps-meta { font-size: 11px; color: var(--text-3); margin-top: 3px; display: flex; gap: 5px; flex-wrap: wrap; }
.ps-meta .ok { color: #22c55e; }
.ps-meta .off { color: var(--text-3); }
.ps-sep { opacity: .5; }
.ps-actions { display: flex; gap: 6px; flex-shrink: 0; }
</style>
