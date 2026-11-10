<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
const executionSources = ref<api.LocalgwExecutionService[]>([]);
const sourceError = ref("");
const updateStatus = ref<api.PluginUpdateStatus | null>(null);
/** 插件「设置」弹窗：只放这一个插件的执行来源开关（页面不再单列「模型执行来源」卡片） */
const sourceDialog = ref<{ open: boolean; plugin: api.PluginInfo | null }>({ open: false, plugin: null });
const sourceBusy = ref("");

/** 开关住在 config.plugins，跟设置页其它项一起整份保存 */
const pluginAuto = computed(() => app.config.plugins || { autoUpdate: true, autoDownload: true, feedUrl: "" });

async function onToggleAuto(field: "autoUpdate" | "autoDownload") {
  if (!app.config.plugins) app.config.plugins = { autoUpdate: true, autoDownload: true, feedUrl: "" };
  app.config.plugins[field] = !app.config.plugins[field];
  const r = await app.save();
  if (r && r.ok === false) ElMessage.error(r.message || "保存失败");
}

async function loadUpdateStatus() {
  try {
    const r = await api.pluginUpdateStatus();
    if (r.ok) updateStatus.value = r.status || null;
  } catch { /* 状态读不到不影响手动导入 */ }
}

async function onCheckUpdate() {
  if (busy.value) return;
  busy.value = "check-update";
  try {
    const r = await api.pluginUpdateCheck();
    if (!r.ok) { ElMessage.error(r.message || "检查更新失败"); return; }
    updateStatus.value = r.status || null;
    const count = r.status?.available?.length || 0;
    if (count) ElMessage.success(`发现 ${count} 个官方插件可安装或更新`);
    else ElMessage.info("官方插件已是最新");
  } catch (error) { ElMessage.error(String((error as Error).message || error)); }
  finally { busy.value = ""; }
}

async function onApplyUpdate() {
  if (busy.value) return;
  busy.value = "apply-update";
  try {
    const r = await api.pluginUpdateApply();
    if (!r.ok) { ElMessage.error(r.message || "更新失败"); return; }
    const done = (r.results || []).filter(row => row.ok);
    const failed = (r.results || []).filter(row => !row.ok);
    if (done.length) ElMessage.success(`已安装 ${done.length} 个插件`);
    if (failed.length) ElMessage.warning(failed.map(row => `${row.id}: ${row.message}`).join("；"));
    await refresh();
    await app.refreshPlugins();
    await loadUpdateStatus();
  } catch (error) { ElMessage.error(String((error as Error).message || error)); }
  finally { busy.value = ""; }
}

/** 声明了桥接能力的插件：它们的号池/渠道状态由本程序提供（只读镜像） */
const managed = computed(() => items.value.filter((p) => p.bridgeKinds && p.bridgeKinds.length));

async function refresh() {
  try {
    const list = await api.pluginList();
    items.value = Array.isArray(list) ? list : [];
  } catch { items.value = []; }
  try {
    const result = await api.localgwProvidersList();
    if (!result.ok) throw new Error(result.message || "读取执行来源失败");
    executionSources.value = result.services || [];
    sourceError.value = "";
  } catch (error) { sourceError.value = String((error as Error).message || error); }
}

async function onInstall() {
  if (busy.value) return;
  busy.value = "install";
  try {
    const r = await api.pluginInstall();
    if (!r || r.canceled) return;
    if (!r.ok) { ElMessage.error(r.message || "安装失败"); return; }
    const done = r.updated ? `已更新到 v${r.version}` : `已安装 v${r.version}`;
    const extras: string[] = [];
    if (r.autoEnabled) extras.push("已自动启用");
    if (r.autoBound?.bound) extras.push(`已固定 ${r.autoBound.bound} 个渠道`);
    ElMessage.success(extras.length ? `${done}，${extras.join("，")}` : done);
    if (r.warning) ElMessage.warning(r.warning);
    await refresh();
    await app.refreshPlugins();
    // 新版后端安装时已自动授权并启用；只有它没能启用（如启动失败）时才走前端兜底
    if (!r.autoEnabled) await autoEnable(r.id);
  } finally { busy.value = ""; }
}

/** 已安装即用：schema 2 先把插件声明的权限与渠道一次性授权，再启动 */
async function autoEnable(id?: string) {
  const p = id ? items.value.find((x) => x.id === id) : undefined;
  if (!p || p.invalid || !p.compatible || p.enabled) return;
  if (p.schema === 2 && !p.authorized) {
    const a = await api.pluginAuthorize(p.id, p.requiredPermissions || [], p.channels || []);
    if (!a.ok) { ElMessage.warning(a.message || "自动授权失败"); return; }
  }
  const t = await api.pluginToggle(p.id, true);
  if (!t.ok) { ElMessage.warning(t.message || "自动启用失败"); return; }
  await refresh();
  await app.refreshPlugins();
}

/** 唯一的启停入口：开启前自动补授权，关闭只停进程、保留授权 */
async function onSetEnabled(p: api.PluginInfo, enabled: boolean) {
  if (busy.value || !p.compatible) return;
  busy.value = p.id;
  try {
    if (enabled && p.schema === 2 && !p.authorized) {
      const a = await api.pluginAuthorize(p.id, p.requiredPermissions || [], p.channels || []);
      if (!a.ok) { ElMessage.error(a.message || "授权失败"); return; }
    }
    const r = await api.pluginToggle(p.id, enabled);
    if (!r.ok) ElMessage.error(r.message || "操作失败");
    await refresh();
    await app.refreshPlugins();
  } finally { busy.value = ""; }
}

/** 弹窗里的执行来源：该插件声明的渠道（停用后残留的绑定也在，便于逐个关掉） */
const dialogSources = computed(() => {
  const id = sourceDialog.value.plugin?.id;
  if (!id) return [];
  return executionSources.value.filter((s) => s.ref?.kind === "extension" && s.ref.pluginId === id);
});

/** 插件没跑时读不到声明的渠道，只给一句提示里列名字用 */
const dialogIdleChannels = computed(() => {
  const p = sourceDialog.value.plugin;
  if (!p) return [];
  const listed = new Set(dialogSources.value.map((s) => s.channel));
  return (p.channels || []).filter((channel) => !listed.has(channel));
});

async function openSourceDialog(p: api.PluginInfo) {
  sourceDialog.value = { open: true, plugin: p };
  // 打开时重读一次：插件可能刚刚启动，声明渠道要现读现显示
  await refresh();
}

/** 弹窗内可固定的来源：就绪且尚未显式绑定 */
const dialogBindable = computed(() => dialogSources.value.filter((s) => s.ready && !s.bound));
const bindAllBusy = ref(false);

/** 一键把本插件当前所有就绪来源固定下来：多个插件争同一渠道时，
 *  自动选择按引用排序取第一个，固定后不会被后来安装的插件顶掉。 */
async function onBindAllSources() {
  const targets = dialogBindable.value.filter((s) => s.ref);
  if (!targets.length || bindAllBusy.value) return;
  try {
    await ElMessageBox.confirm(
      `把 ${targets.length} 个渠道固定到「${sourceDialog.value.plugin?.name || "此插件"}」？固定后其它插件不会自动接管这些渠道。`,
      "固定全部执行来源",
      { type: "warning", confirmButtonText: "全部固定", cancelButtonText: "取消" },
    );
  } catch { return; }
  bindAllBusy.value = true;
  let done = 0;
  const failed: string[] = [];
  try {
    for (const source of targets) {
      if (!source.ref) continue;
      try {
        const r = await api.localgwBindExecutionSource(source.channel, source.ref);
        if (r.ok) done++;
        else failed.push(`${source.channel}: ${r.message || "固定失败"}`);
      } catch (error) {
        failed.push(`${source.channel}: ${String((error as Error).message || error)}`);
      }
    }
    if (done) ElMessage.success(`已固定 ${done} 个渠道`);
    if (failed.length) ElMessage.warning(failed.slice(0, 5).join("；"));
    await refresh();
  } finally { bindAllBusy.value = false; }
}

async function onToggleSource(source: api.LocalgwExecutionService, enabled: boolean) {
  if (sourceBusy.value || !source.ref) return;
  // 打不开的来源不必让用户先试一次：插件未就绪，或该渠道已被自定义提供商占用
  if (enabled && !source.ready) { ElMessage.warning("执行来源不可用：插件未就绪，或该渠道已配置自定义提供商"); return; }
  sourceBusy.value = source.channel;
  try {
    const r = enabled
      ? await api.localgwBindExecutionSource(source.channel, source.ref)
      : await api.localgwUnbindExecutionSource(source.channel);
    if (!r.ok) ElMessage.error(r.message || "操作失败");
    await refresh();
  } finally { sourceBusy.value = ""; }
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

// 主进程自动更新完成后会广播状态，设置页跟着变，不用用户手动刷新
let offUpdate: (() => void) | undefined;
onMounted(() => {
  refresh();
  loadUpdateStatus();
  offUpdate = api.onUpdateEvent((payload: unknown) => {
    const ev = payload as { event?: string; status?: api.PluginUpdateStatus };
    if (ev?.event !== "plugin-update" || !ev.status) return;
    const previous = updateStatus.value?.lastInstalled?.at;
    updateStatus.value = ev.status;
    if (ev.status.lastInstalled && ev.status.lastInstalled.at !== previous) {
      refresh();
      app.refreshPlugins();
    }
  });
});
onBeforeUnmount(() => { offUpdate?.(); });
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
        <button class="btn btn-ghost" :disabled="!!busy" @click="onCheckUpdate">
          {{ busy === "check-update" ? "检查中…" : "检查更新" }}
        </button>
        <button class="btn btn-cta" :disabled="busy === 'install'" @click="onInstall">
          {{ busy === "install" ? "导入中…" : "＋ 导入插件" }}
        </button>
        <button class="btn btn-ghost" :disabled="!!busy" @click="refresh">刷新</button>
      </div>
    </div>

    <!-- 自动更新：两个勾选框一行放下（说明只在标题行保留一句），关掉也补齐最低版本 -->
    <div class="mem-card ps-auto">
      <div class="mem-card-title">
        自动更新
        <span class="mem-hint">插件独立于主程序更新</span>
      </div>
      <div class="ps-checks">
        <label class="ps-check">
          <input type="checkbox" :checked="pluginAuto.autoUpdate" @change="onToggleAuto('autoUpdate')" />
          <span>自动更新插件</span>
        </label>
        <label class="ps-check">
          <input type="checkbox" :checked="pluginAuto.autoDownload" @change="onToggleAuto('autoDownload')" />
          <span>自动安装官方插件</span>
        </label>
      </div>
      <div v-if="updateStatus?.lastCheckAt || updateStatus?.lastError" class="ps-note">
        <template v-if="updateStatus?.lastCheckAt">上次检查：{{ timeAgo(updateStatus.lastCheckAt) }}</template>
        <template v-if="updateStatus?.lastError"> · 最近一次失败：{{ updateStatus.lastError }}</template>
      </div>
      <div v-if="updateStatus?.available?.length" class="ps-updates">
        <span class="ps-updates-label">可安装</span>
        <span v-for="item in updateStatus.available" :key="item.id" class="ps-ver">
          {{ item.id }} v{{ item.version }}{{ item.required ? " · 最低版本" : "" }}
        </span>
        <button class="btn-mini" :disabled="!!busy" @click="onApplyUpdate">
          {{ busy === "apply-update" ? "安装中…" : "立即安装" }}
        </button>
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
                  <span>{{ p.schema === 2 ? (p.authorized ? "已授权" : "未授权") : p.embed ? "内嵌打开" : "独立窗口" }}</span>
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
              <!-- 启停只留一个开关：开启时自动补授权，不再给「授权 / 撤销授权」按钮 -->
              <div
                class="switch"
                :class="{ on: p.enabled, dim: !p.compatible }"
                role="switch"
                :aria-checked="p.enabled"
                :aria-label="p.enabled ? '停用插件' : '启用插件'"
                :title="p.compatible ? (p.enabled ? '停用' : '启用') : p.compatReason"
                @click="onSetEnabled(p, !p.enabled)"
              ></div>
              <button class="btn-mini" :disabled="!!busy || !p.compatible" @click="openSourceDialog(p)">设置</button>
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

    <!-- 插件设置：执行来源逐个开关（开 = 该渠道的模型调用交给此插件） -->
    <el-dialog v-model="sourceDialog.open" class="ps-source-dialog" width="520px" align-center append-to-body>
      <template #header>
        <div class="psd-head">
          <div class="psd-title">{{ sourceDialog.plugin?.name || "插件" }} · 执行来源</div>
          <div class="psd-sub">新装插件会自动授权、启用，并固定它声明的全部渠道；这里的开关用于调整固定来源，同一渠道安装多个插件时以固定值为准。</div>
        </div>
      </template>
      <div v-if="dialogSources.length" class="psd-list">
        <div v-for="source in dialogSources" :key="source.channel" class="psd-row">
          <div class="psd-info">
            <div class="psd-name">{{ source.channel }}</div>
            <div class="psd-meta">
              <span :class="source.bound || source.auto ? 'ok' : 'off'">
                {{ source.bound ? "已固定" : source.auto ? "自动选中" : "未启用" }}
              </span>
              <template v-if="!source.ready"><span class="ps-sep">·</span><span class="ps-bad">来源不可用</span></template>
            </div>
          </div>
          <div
            class="switch"
            :class="{ on: !!source.bound, dim: !source.bound && !source.ready }"
            role="switch"
            :aria-checked="!!source.bound"
            :title="source.bound ? '取消固定（仍有可用插件时自动接管）' : '固定此执行来源'"
            @click="onToggleSource(source, !source.bound)"
          ></div>
        </div>
      </div>
      <div v-else class="psd-empty">
        {{ sourceError || "插件未运行或尚未声明执行来源；先启用插件，再回到这里逐个开关。" }}
      </div>
      <div v-if="dialogBindable.length" class="psd-bulk">
        <span>新装插件已自动固定；只有取消过固定，或同一渠道装了多个插件时，才需要在这里手动调整。</span>
        <button class="btn-mini" :disabled="bindAllBusy" @click="onBindAllSources">
          {{ bindAllBusy ? "固定中…" : `全部固定到本插件（${dialogBindable.length}）` }}
        </button>
      </div>
      <div v-if="dialogIdleChannels.length" class="psd-note">
        还有 {{ dialogIdleChannels.length }} 个渠道需要插件运行后才能读取：{{ dialogIdleChannels.join("、") }}
      </div>
      <div class="psd-note">
        执行来源只管「哪个渠道的模型调用交给这个插件」；登录、凭据解析、续期、余额、签到、领取和客户端切号仍在号池管家。
      </div>
    </el-dialog>
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
.ps-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
/* 插件行里的开关与全站同款；不兼容的插件置灰不可点 */
.ps-actions .switch.dim { opacity: .45; cursor: not-allowed; }
.ps-note { margin-top: 8px; font-size: 11px; color: var(--text-3); line-height: 1.6; }
.ps-auto { margin-top: 10px; }
/* 自动更新：两个勾选框一行放下（长说明已删，行高与勾选框一起收小） */
.ps-checks { display: flex; flex-wrap: wrap; gap: 18px; padding: 1px 0 4px; }
.ps-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
.ps-check input { width: 13px; height: 13px; margin: 0; accent-color: var(--accent); flex-shrink: 0; }

/* 插件设置弹窗：执行来源逐行开关 */
.psd-title { font-size: 14px; font-weight: 700; }
.psd-sub { font-size: 11px; color: var(--text-3); margin-top: 3px; line-height: 1.6; }
.psd-list { max-height: 46vh; overflow: auto; }
.psd-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 2px; border-top: 1px solid var(--line);
}
.psd-row:first-child { border-top: 0; }
.psd-name { font-size: 12.5px; font-weight: 600; }
.psd-meta { font-size: 11px; color: var(--text-3); margin-top: 2px; display: flex; gap: 5px; }
.psd-meta .ok { color: #22c55e; }
.psd-meta .off { color: var(--text-3); }
.psd-empty { padding: 4px 2px; font-size: 12px; color: var(--text-3); line-height: 1.7; }
.psd-bulk {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin-top: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-ctl);
  font-size: 11px; color: var(--text-3); line-height: 1.6;
}
.psd-bulk .btn-mini { flex-shrink: 0; }
.psd-note { margin-top: 10px; font-size: 11px; color: var(--text-3); line-height: 1.6; }
.ps-updates { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; }
.ps-updates-label { color: var(--text-3); }

.btn-mini {
  font-size: 11.5px; line-height: 1; padding: 6px 10px; border-radius: var(--r-ctl);
  border: 1px solid var(--line-strong); background: transparent; color: var(--text-2);
  cursor: pointer; transition: border-color .18s, color .18s, background .18s;
}
.btn-mini:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-mini:disabled { opacity: .45; cursor: not-allowed; }
.btn-mini.danger:hover:not(:disabled) { border-color: #ef4444; color: #ef4444; }
</style>
