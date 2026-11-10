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
const modelSources = computed(() => executionSources.value.filter(source => source.ref?.kind === "extension" || source.bound));
/** 一键绑定的候选：同一渠道只取第一个可用来源，避免多插件重复声明时来回覆盖 */
const bindableSources = computed(() => {
  const seen = new Set<string>();
  const out: api.LocalgwExecutionService[] = [];
  for (const source of modelSources.value) {
    if (source.ref?.kind !== "extension" || !source.ready || source.bound) continue;
    if (seen.has(source.channel)) continue;
    seen.add(source.channel);
    out.push(source);
  }
  return out;
});

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
    if (!result.ok) throw new Error(result.message || "读取模型执行来源失败");
    executionSources.value = result.services || [];
    sourceError.value = "";
  } catch (error) { sourceError.value = String((error as Error).message || error); }
}

async function onBind(source: api.LocalgwExecutionService) {
  if (source.ref?.kind !== "extension" || !source.ready || source.bound) return;
  const ref = source.ref;
  try {
    await ElMessageBox.confirm(`将渠道「${source.channel}」的模型调用交给插件「${ref.pluginId}」（发布者：${ref.publisherId}）？号池管理功能继续由主程序负责。`, "选择模型执行来源", {
      confirmButtonText: "使用此插件", cancelButtonText: "取消", type: "warning",
    });
  } catch { return; }
  busy.value = "bind-" + source.channel;
  try {
    const result = await api.localgwBindExecutionSource(source.channel, ref);
    if (!result.ok) ElMessage.error(result.message || "绑定失败");
    else ElMessage.success("已选择模型执行来源");
    await refresh();
  } catch (error) { ElMessage.error(String((error as Error).message || error)); }
  finally { busy.value = ""; }
}

async function onBindAll() {
  if (busy.value || !bindableSources.value.length) return;
  const targets = bindableSources.value.slice();
  try {
    await ElMessageBox.confirm(`将 ${targets.length} 个渠道的模型调用交给对应的执行插件？号池管理功能继续由主程序负责。`, "一键选择模型执行来源", {
      confirmButtonText: "全部使用", cancelButtonText: "取消", type: "warning",
    });
  } catch { return; }
  busy.value = "bind-all";
  let done = 0;
  const failed: string[] = [];
  try {
    for (const source of targets) {
      const ref = source.ref;
      if (ref?.kind !== "extension") continue;
      try {
        const result = await api.localgwBindExecutionSource(source.channel, ref);
        if (result.ok) done++;
        else failed.push(`${source.channel}: ${result.message || "绑定失败"}`);
      } catch (error) {
        failed.push(`${source.channel}: ${String((error as Error).message || error)}`);
      }
    }
    if (done) ElMessage.success(`已选择 ${done} 个渠道的执行来源`);
    if (failed.length) ElMessage.warning(failed.slice(0, 5).join("；"));
    await refresh();
  } finally {
    busy.value = "";
  }
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
    if (r.requiresAuthorization) ElMessage.info("插件已安装，请确认权限后启用");
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

const permissionNames: Record<string, string> = {
  "pool.forward-scoped": "按次使用获准渠道的账号凭据",
  "network.outbound": "连接上游服务",
  "storage.private": "保存插件自己的配置和缓存",
};

async function onAuthorize(p: api.PluginInfo) {
  const revoke = p.authorized === true;
  const permissions = revoke ? [] : p.requiredPermissions || [];
  const channels = revoke ? [] : p.channels || [];
  const detail = revoke
    ? `撤销「${p.name}」的授权并停止运行？号池账号和管理功能保留。`
    : `允许「${p.name}」（发布者：${p.publisherId}）${permissions.map(value => permissionNames[value] || value).join("、")}？涉及渠道：${channels.join("、")}。账号仍由号池管家管理。`;
  try {
    await ElMessageBox.confirm(detail, revoke ? "撤销插件授权" : "插件权限", {
      type: "warning", confirmButtonText: revoke ? "撤销" : "授权", cancelButtonText: "取消",
    });
  } catch { return; }
  busy.value = p.id;
  try {
    const result = await api.pluginAuthorize(p.id, permissions, channels);
    if (!result.ok) ElMessage.error(result.message || "授权操作失败");
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

    <!-- 自动更新：开关跟软件自动检查一起走，关掉也补齐最低版本 -->
    <div class="mem-card ps-auto">
      <div class="mem-card-title">
        自动更新
        <span class="mem-hint">插件独立于主程序更新</span>
      </div>
      <label class="ps-switch">
        <input type="checkbox" :checked="pluginAuto.autoUpdate" @change="onToggleAuto('autoUpdate')" />
        <span class="ps-switch-body">
          <b>自动更新插件</b>
          <span>检测到更新后自动下载、校验并安装已启用的官方签名插件。关闭此项不影响最低版本补齐；未签名或第三方插件仍需手动更新。</span>
        </span>
      </label>
      <label class="ps-switch">
        <input type="checkbox" :checked="pluginAuto.autoDownload" @change="onToggleAuto('autoDownload')" />
        <span class="ps-switch-body">
          <b>自动下载官方插件</b>
          <span>发现未安装的官方插件时自动下载并安装，仅接受当前平台且通过官方签名校验的包；开启期间卸载的官方插件也会重新安装。</span>
        </span>
      </label>
      <div class="ps-note">
        默认跟随软件的自动检查和间隔。关闭后暂停日常自动更新和下载，但仍会补齐已安装官方插件的最低版本。
        <template v-if="updateStatus?.lastCheckAt"> 上次检查：{{ timeAgo(updateStatus.lastCheckAt) }}。</template>
        <template v-if="updateStatus?.lastError"> 最近一次失败：{{ updateStatus.lastError }}</template>
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
                  <span>{{ p.schema === 2 ? (p.authorized ? "已授权" : "待授权") : p.embed ? "内嵌打开" : "独立窗口" }}</span>
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
              <button v-if="p.schema === 2" class="btn-mini" :disabled="!!busy || !p.compatible" @click="onAuthorize(p)">{{ p.authorized ? "撤销授权" : "授权" }}</button>
              <button class="btn-mini" :disabled="!!busy || (p.schema === 2 && !p.authorized)" @click="onToggle(p)">{{ p.enabled ? "停用" : "启用" }}</button>
              <button class="btn-mini" :disabled="busy === 'install'" @click="onInstall">更新</button>
            </template>
            <button class="btn-mini danger" :disabled="busy === p.id" @click="onUninstall(p)">卸载</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="modelSources.length || sourceError" class="mem-card">
      <div class="mem-card-title">模型执行来源</div>
      <div class="ps-note">安装并授权后，为渠道选择执行插件。登录、凭据解析、续期、余额、签到、领取和客户端切号继续在号池管家使用。</div>
      <div v-if="bindableSources.length" class="ps-list" style="margin-bottom: 8px">
        <button class="btn-mini" :disabled="!!busy" @click="onBindAll">
          {{ busy === "bind-all" ? "绑定中…" : `一键选择全部（${bindableSources.length}）` }}
        </button>
      </div>
      <div v-if="sourceError" class="ps-bad" role="alert">{{ sourceError }}</div>
      <div class="ps-list">
        <div v-for="(source, index) in modelSources" :key="source.channel + '-' + index" class="ps-item">
          <div class="ps-info">
            <div class="ps-name">{{ source.channel }} <span class="ps-ver">{{ source.bound ? "已选择" : "可选择" }}</span></div>
            <div v-if="source.ref?.kind === 'extension'" class="ps-meta">{{ source.ref.pluginId }} · {{ source.ref.publisherId }} · {{ source.ref.providerId }}</div>
            <div v-if="!source.ready" class="ps-bad">执行来源不可用，请检查插件安装、授权及运行状态</div>
          </div>
          <button class="btn-mini" :disabled="!!busy || !source.ready || source.bound" @click="onBind(source)">{{ source.bound ? "已选择" : "使用此插件" }}</button>
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
.ps-auto { margin-top: 10px; }
.ps-switch {
  display: flex; gap: 10px; align-items: flex-start; padding: 9px 0;
  border-top: 1px solid var(--line); cursor: pointer;
}
.ps-switch:first-of-type { border-top: 0; }
.ps-switch input { margin-top: 2px; accent-color: var(--accent); flex-shrink: 0; }
.ps-switch-body { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.ps-switch-body b { font-weight: 600; }
.ps-switch-body span { font-size: 11px; color: var(--text-3); line-height: 1.6; }
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
