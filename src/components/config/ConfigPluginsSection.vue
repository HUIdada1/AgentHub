<!--
  ============================================================
   作者：沐晖
   日期：2026-10-24
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { isWebTransport } from "../../api/caps";
import { timeAgo } from "../../composables/useFormat";
import * as api from "../../api/ipc";

const app = useAppStore();
const webMode = isWebTransport();
const items = ref<api.PluginInfo[]>([]);
const busy = ref("");
const executionSources = ref<api.LocalgwExecutionService[]>([]);
const sourceError = ref("");
const updateStatus = ref<api.PluginUpdateStatus | null>(null);
const sourceDialog = ref<{ open: boolean; plugin: api.PluginInfo | null }>({ open: false, plugin: null });
const sourceBusy = ref("");

/** 自动维护开关 */
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
  } catch {
    /* 忽略未就绪错误 */
  }
}

async function onCheckUpdate() {
  if (busy.value) return;
  busy.value = "check-update";
  try {
    const r = await api.pluginUpdateCheck();
    if (!r.ok) {
      ElMessage.error(r.message || "检查更新失败");
      return;
    }
    updateStatus.value = r.status || null;
    const count = r.status?.available?.length || 0;
    if (count) ElMessage.success(`发现 ${count} 个官方插件可安装或更新`);
    else ElMessage.info("所有官方插件已是最新版本");
  } catch (error) {
    ElMessage.error(String((error as Error).message || error));
  } finally {
    busy.value = "";
  }
}

async function onApplyUpdate() {
  if (busy.value) return;
  busy.value = "apply-update";
  try {
    const r = await api.pluginUpdateApply();
    if (!r.ok) {
      ElMessage.error(r.message || "更新失败");
      return;
    }
    const done = (r.results || []).filter((row) => row.ok);
    const failed = (r.results || []).filter((row) => !row.ok);
    if (done.length) ElMessage.success(`已安装 / 更新 ${done.length} 个插件`);
    if (failed.length) ElMessage.warning(failed.map((row) => `${row.id}: ${row.message}`).join("；"));
    await refresh();
    await app.refreshPlugins();
    await loadUpdateStatus();
  } catch (error) {
    ElMessage.error(String((error as Error).message || error));
  } finally {
    busy.value = "";
  }
}

/** 针对单个插件检查是否有更新项 */
function getPluginUpdateItem(pluginId: string) {
  return updateStatus.value?.available?.find((x) => x.id === pluginId) || null;
}

const managed = computed(() => items.value.filter((p) => p.bridgeKinds && p.bridgeKinds.length));

async function refresh() {
  try {
    const list = await api.pluginList();
    items.value = Array.isArray(list) ? list : [];
  } catch {
    items.value = [];
  }
  try {
    const result = await api.localgwProvidersList();
    if (!result.ok) throw new Error(result.message || "读取执行来源失败");
    executionSources.value = result.services || [];
    sourceError.value = "";
  } catch (error) {
    sourceError.value = String((error as Error).message || error);
  }
}

async function onInstall() {
  if (busy.value) return;
  busy.value = "install";
  try {
    const r = await api.pluginInstall();
    if (!r || r.canceled) return;
    if (!r.ok) {
      ElMessage.error(r.message || "安装失败");
      return;
    }
    const done = r.updated ? `已更新到 v${r.version}` : `已安装 v${r.version}`;
    const extras: string[] = [];
    if (r.autoEnabled) extras.push("已自动启用");
    if (r.autoBound?.bound) extras.push(`已固定 ${r.autoBound.bound} 个渠道`);
    ElMessage.success(extras.length ? `${done}，${extras.join("，")}` : done);
    if (r.warning) ElMessage.warning(r.warning);
    await refresh();
    await app.refreshPlugins();
    if (!r.autoEnabled) await autoEnable(r.id);
  } finally {
    busy.value = "";
  }
}

async function autoEnable(id?: string) {
  const p = id ? items.value.find((x) => x.id === id) : undefined;
  if (!p || p.invalid || !p.compatible || p.enabled) return;
  if (p.schema === 2 && !p.authorized) {
    const a = await api.pluginAuthorize(p.id, p.requiredPermissions || [], p.channels || []);
    if (!a.ok) {
      ElMessage.warning(a.message || "自动授权失败");
      return;
    }
  }
  const t = await api.pluginToggle(p.id, true);
  if (!t.ok) {
    ElMessage.warning(t.message || "自动启用失败");
    return;
  }
  await refresh();
  await app.refreshPlugins();
}

async function onSetEnabled(p: api.PluginInfo, enabled: boolean) {
  if (busy.value || !p.compatible) return;
  busy.value = p.id;
  try {
    if (enabled && p.schema === 2 && !p.authorized) {
      const a = await api.pluginAuthorize(p.id, p.requiredPermissions || [], p.channels || []);
      if (!a.ok) {
        ElMessage.error(a.message || "授权失败");
        return;
      }
    }
    const r = await api.pluginToggle(p.id, enabled);
    if (!r.ok) ElMessage.error(r.message || "操作失败");
    await refresh();
    await app.refreshPlugins();
  } finally {
    busy.value = "";
  }
}

const dialogSources = computed(() => {
  const id = sourceDialog.value.plugin?.id;
  if (!id) return [];
  return executionSources.value.filter((s) => s.ref?.kind === "extension" && s.ref.pluginId === id);
});

const dialogIdleChannels = computed(() => {
  const p = sourceDialog.value.plugin;
  if (!p) return [];
  const listed = new Set(dialogSources.value.map((s) => s.channel));
  return (p.channels || []).filter((channel) => !listed.has(channel));
});

async function openSourceDialog(p: api.PluginInfo) {
  sourceDialog.value = { open: true, plugin: p };
  await refresh();
}

const dialogBindable = computed(() => dialogSources.value.filter((s) => s.ready && !s.bound));
const bindAllBusy = ref(false);

async function onBindAllSources() {
  const targets = dialogBindable.value.filter((s) => s.ref);
  if (!targets.length || bindAllBusy.value) return;
  try {
    await ElMessageBox.confirm(
      `把 ${targets.length} 个渠道固定到「${sourceDialog.value.plugin?.name || "此插件"}」？固定后其它插件不会自动接管这些渠道。`,
      "固定全部执行来源",
      { type: "warning", confirmButtonText: "全部固定", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
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
  } finally {
    bindAllBusy.value = false;
  }
}

async function onToggleSource(source: api.LocalgwExecutionService, enabled: boolean) {
  if (sourceBusy.value || !source.ref) return;
  if (enabled && !source.ready) {
    ElMessage.warning("执行来源不可用：插件未就绪，或该渠道已配置自定义提供商");
    return;
  }
  sourceBusy.value = source.channel;
  try {
    const r = enabled
      ? await api.localgwBindExecutionSource(source.channel, source.ref)
      : await api.localgwUnbindExecutionSource(source.channel);
    if (!r.ok) ElMessage.error(r.message || "操作失败");
    await refresh();
  } finally {
    sourceBusy.value = "";
  }
}

async function onOpen(p: api.PluginInfo) {
  busy.value = p.id;
  try {
    const e = await app.openPluginView(p.id);
    if (e && e.ok) {
      app.settingsOpen = false;
      return;
    }
    const w = await api.pluginOpen(p.id);
    if (!w || !w.ok) ElMessage.error((w && w.message) || (e && e.message) || "启动失败");
    else app.settingsOpen = false;
    await refresh();
    await app.refreshPlugins();
  } finally {
    busy.value = "";
  }
}

async function onUninstall(p: api.PluginInfo) {
  try {
    await ElMessageBox.confirm(`卸载「${p.name}」将立即停止其后台进程，插件专属数据将妥善保留。确定卸载？`, "卸载外置插件", {
      type: "warning",
      confirmButtonText: "确定卸载",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  busy.value = p.id;
  try {
    const r = await api.pluginUninstall(p.id);
    if (!r.ok) {
      ElMessage.error(r.message || "卸载失败");
      return;
    }
    ElMessage.success("已成功卸载插件");
    await refresh();
    await app.refreshPlugins();
  } finally {
    busy.value = "";
  }
}

async function onSync(p: api.PluginInfo) {
  busy.value = "sync-" + p.id;
  try {
    const r = await api.pluginSyncNow(p.id);
    if (!r.ok) {
      ElMessage.error(r.message || "同步失败");
      return;
    }
    ElMessage.success(`已同步 ${r.imported || 0} 个账号${r.removed ? `，移除 ${r.removed} 个` : ""}`);
    await refresh();
  } finally {
    busy.value = "";
  }
}

function syncText(p: api.PluginInfo): string {
  const s = p.poolSync;
  if (!s || !s.lastAt) return p.running ? "尚未同步" : "插件未运行";
  if (s.lastError) return "上次同步失败：" + s.lastError;
  return `${timeAgo(s.lastAt)}同步 ${s.imported} 个账号` + (s.removed ? `，移除 ${s.removed} 个` : "");
}

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
onBeforeUnmount(() => {
  offUpdate?.();
});
</script>

<template>
  <div v-if="!webMode" class="cfg-sec memory-scope plugins-sec">
    <!-- 顶栏：标题与主操作 -->
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">外置插件</div>
        <div class="cfg-sec-sub">
          扩展平台生态能力。外置插件独立进程沙箱运行，支持热启停、自主更新与专属执行渠道绑定。
        </div>
      </div>
      <div class="cfg-sec-actions">
        <button class="btn btn-cta" :disabled="busy === 'install'" @click="onInstall">
          <i class="ph ph-plus" style="margin-right: 4px"></i>
          {{ busy === "install" ? "导入中…" : "导入插件包" }}
        </button>
        <button class="btn btn-ghost" :disabled="!!busy" @click="refresh">
          <i class="ph ph-arrow-clockwise" style="margin-right: 4px"></i>刷新
        </button>
      </div>
    </div>

    <!-- 🌌 检查更新控制台（多种展示星空形态：最新、检查中、可更新、更新中、错误） -->
    <div class="starfield-update-card">
      <!-- 星空背景微光装饰 -->
      <div class="star-nebula"></div>
      <div class="star-sparkle s1"></div>
      <div class="star-sparkle s2"></div>
      <div class="star-sparkle s3"></div>

      <!-- ① 形态 A：检查中 (Checking) -->
      <div v-if="busy === 'check-update'" class="sf-status-row checking">
        <div class="sf-icon-orbit">
          <i class="ph ph-spinner-gap is-spinning sf-icon"></i>
        </div>
        <div class="sf-status-body">
          <div class="sf-title">正在检索云端插件源…</div>
          <div class="sf-sub">实时对比已安装插件版本与官方最新分发包元数据</div>
        </div>
        <button class="btn-starfield disabled" disabled>检查中…</button>
      </div>

      <!-- ② 形态 B：更新正在进行中 (Applying) -->
      <div v-else-if="busy === 'apply-update'" class="sf-status-row updating">
        <div class="sf-icon-orbit">
          <i class="ph ph-arrows-clockwise is-spinning sf-icon"></i>
        </div>
        <div class="sf-status-body">
          <div class="sf-title">正在下载并安装插件更新…</div>
          <div class="sf-sub">部署完成后将自动重启受影响插件的后台进程</div>
        </div>
        <div class="sf-mini-progress">
          <span class="sf-progress-bar"></span>
        </div>
      </div>

      <!-- ③ 形态 C：发现新版本 / 可更新 (Update Available) -->
      <div v-else-if="updateStatus?.available?.length" class="sf-status-row available">
        <div class="sf-icon-orbit active-orbit">
          <i class="ph ph-sparkle sf-icon pulse"></i>
        </div>
        <div class="sf-status-body">
          <div class="sf-title">
            发现 {{ updateStatus.available.length }} 个插件可更新
            <span class="sf-badge-count">{{ updateStatus.available.length }}</span>
          </div>
          <div class="sf-update-list">
            <span v-for="item in updateStatus.available" :key="item.id" class="sf-update-chip">
              <i class="ph ph-arrow-up-right"></i>
              <b>{{ item.id }}</b>
              <small>v{{ item.version }}</small>
              <span v-if="item.required" class="sf-req-tag">必要</span>
            </span>
          </div>
        </div>
        <button class="btn-starfield cta" :disabled="!!busy" @click="onApplyUpdate">
          <i class="ph ph-rocket-launch" style="margin-right: 5px"></i>一键全部更新
        </button>
      </div>

      <!-- ④ 形态 D：检查失败 / 错误 (Error) -->
      <div v-else-if="updateStatus?.lastError" class="sf-status-row error">
        <div class="sf-icon-orbit err-orbit">
          <i class="ph ph-warning-circle sf-icon"></i>
        </div>
        <div class="sf-status-body">
          <div class="sf-title">检查更新失败</div>
          <div class="sf-sub">{{ updateStatus.lastError }}</div>
        </div>
        <button class="btn-starfield outline" :disabled="!!busy" @click="onCheckUpdate">
          <i class="ph ph-arrow-counter-clockwise" style="margin-right: 4px"></i>重新检查
        </button>
      </div>

      <!-- ⑤ 形态 E：已是最新状态 (Up to date) -->
      <div v-else class="sf-status-row up-to-date">
        <div class="sf-icon-orbit ok-orbit">
          <i class="ph ph-shield-check sf-icon"></i>
        </div>
        <div class="sf-status-body">
          <div class="sf-title">所有外置插件均为最新版本</div>
          <div class="sf-sub">
            <template v-if="updateStatus?.lastCheckAt">上次成功检查：{{ timeAgo(updateStatus.lastCheckAt) }}</template>
            <template v-else>官方插件发布源已就绪</template>
            · 插件沙箱状态良好
          </div>
        </div>
        <button class="btn-starfield outline" :disabled="!!busy" @click="onCheckUpdate">
          <i class="ph ph-magnifying-glass" style="margin-right: 4px"></i>检查更新
        </button>
      </div>

      <!-- 下部快捷偏好设置条 -->
      <div class="sf-controls-footer">
        <div class="sf-switches">
          <label class="sf-switch-item">
            <div
              class="switch"
              :class="{ on: pluginAuto.autoUpdate }"
              role="switch"
              :aria-checked="pluginAuto.autoUpdate"
              @click="onToggleAuto('autoUpdate')"
            ></div>
            <span>有新版时自动更新</span>
          </label>
          <label class="sf-switch-item">
            <div
              class="switch"
              :class="{ on: pluginAuto.autoDownload }"
              role="switch"
              :aria-checked="pluginAuto.autoDownload"
              @click="onToggleAuto('autoDownload')"
            ></div>
            <span>自动安装官方推荐插件</span>
          </label>
        </div>
        <span class="sf-footer-tip">插件更新与主程序解耦，升级不中断主面板工作</span>
      </div>
    </div>

    <!-- 未安装空态引导卡片 -->
    <div v-if="!items.length" class="mem-card ps-empty-box" tabindex="0" @click="onInstall" @keydown.enter="onInstall">
      <div class="ps-empty-graphic">
        <i class="ph ph-puzzle-piece"></i>
      </div>
      <div class="ps-empty-content">
        <div class="ps-empty-head">暂未安装任何外置插件</div>
        <div class="ps-empty-desc">
          点击此处或右上角「导入插件包」选择扩展压缩包（.zip）。安装后插件专属卡片将自动在左侧栏展出。
        </div>
      </div>
      <button class="btn btn-ghost sm" @click.stop="onInstall">选择文件导入</button>
    </div>

    <!-- 已安装插件卡片流 -->
    <div v-else class="installed-container">
      <div class="section-subhead">
        <span>已安装插件 ({{ items.length }})</span>
        <span class="subhead-meta">可在卡片内直接启停、配置模型执行来源或打开独立面板</span>
      </div>

      <div class="plugin-card-grid">
        <div v-for="p in items" :key="p.id" class="plugin-tile-card" :class="{ 'is-disabled': !p.enabled, 'is-broken': p.invalid || !p.compatible }">
          <div class="ptc-header">
            <div class="ptc-icon-wrap">
              <i class="ph ph-puzzle-piece ptc-icon"></i>
            </div>
            <div class="ptc-header-text">
              <div class="ptc-name-row">
                <span class="ptc-name">{{ p.name }}</span>
                <span v-if="p.version" class="ptc-version">v{{ p.version }}</span>
                <!-- 单个插件可更新标识 -->
                <span v-if="getPluginUpdateItem(p.id)" class="ptc-update-available" title="有可用更新">
                  <i class="ph ph-sparkle"></i>可升至 v{{ getPluginUpdateItem(p.id)?.version }}
                </span>
              </div>
              <div class="ptc-meta-row">
                <span class="ptc-pulse-status">
                  <span class="ptc-dot" :class="{ running: p.running, warn: p.invalid || !p.compatible }"></span>
                  {{ p.invalid ? "插件异常" : !p.compatible ? "不兼容" : p.running ? "运行中" : p.enabled ? "已启用" : "已停用" }}
                </span>
                <span class="ptc-sep">·</span>
                <span class="ptc-sub-info">
                  {{ p.schema === 2 ? (p.authorized ? "已授安全权限" : "未授权") : p.embed ? "内嵌面板" : "独立窗口" }}
                </span>
              </div>
            </div>

            <!-- 右上角核心开关 -->
            <div class="ptc-switch-wrap">
              <el-tooltip :content="p.compatible ? (p.enabled ? '停用此插件' : '启用此插件') : p.compatReason" placement="top">
                <div
                  class="switch"
                  :class="{ on: p.enabled, dim: !p.compatible }"
                  role="switch"
                  :aria-checked="p.enabled"
                  @click="onSetEnabled(p, !p.enabled)"
                ></div>
              </el-tooltip>
            </div>
          </div>

          <!-- 异常与错误信息展示 -->
          <div v-if="p.invalid || !p.compatible || p.lastError" class="ptc-alert-banner">
            <i class="ph ph-warning" style="margin-right: 4px"></i>
            <span>{{ p.invalid ? p.reason : !p.compatible ? p.compatReason : p.lastError }}</span>
          </div>

          <!-- 卡片底栏操作 -->
          <div class="ptc-footer">
            <div class="ptc-footer-left">
              <button v-if="p.ui" class="btn btn-cta mini" :disabled="busy === p.id" @click="onOpen(p)">
                <i class="ph ph-arrow-square-out" style="margin-right: 3px"></i>打开
              </button>
              <button class="btn btn-ghost mini" :disabled="!!busy || !p.compatible" @click="openSourceDialog(p)">
                <i class="ph ph-sliders" style="margin-right: 3px"></i>执行来源
              </button>
            </div>
            <div class="ptc-footer-right">
              <button class="btn btn-ghost mini" :disabled="busy === 'install'" @click="onInstall">
                更新
              </button>
              <button class="btn btn-ghost mini danger" :disabled="busy === p.id" @click="onUninstall(p)">
                卸载
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 号池托管来源卡片 -->
    <div v-if="managed.length" class="mem-card pool-managed-card">
      <div class="card-header-compact">
        <div class="card-title-text">
          <i class="ph ph-users-three" style="color: var(--accent); margin-right: 6px"></i>
          号池托管同步
        </div>
        <span class="card-hint-text">由「号池管家」集中分发账号，插件侧只读同步</span>
      </div>
      <div class="pool-sync-list">
        <div v-for="p in managed" :key="'m-' + p.id" class="pool-sync-item">
          <div class="psi-left">
            <span class="psi-dot" :class="{ ok: !p.poolSync?.lastError && p.running, bad: !!p.poolSync?.lastError }"></span>
            <div class="psi-info">
              <b>{{ p.name }}</b>
              <small>{{ syncText(p) }}</small>
            </div>
          </div>
          <button class="btn btn-ghost sm" :disabled="busy === 'sync-' + p.id || !p.running" @click="onSync(p)">
            {{ busy === "sync-" + p.id ? "同步中…" : "立即同步" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 插件设置：执行来源弹窗 -->
    <el-dialog v-model="sourceDialog.open" class="ps-source-dialog" width="540px" align-center append-to-body>
      <template #header>
        <div class="psd-head">
          <div class="psd-title">{{ sourceDialog.plugin?.name || "插件" }} · 执行来源分配</div>
          <div class="psd-sub">
            指定将哪些模型渠道交给此插件提供服务。新装插件会自动固定其声明的渠道。
          </div>
        </div>
      </template>
      <div v-if="dialogSources.length" class="psd-list">
        <div v-for="source in dialogSources" :key="source.channel" class="psd-row">
          <div class="psd-info">
            <div class="psd-name">{{ source.channel }}</div>
            <div class="psd-meta">
              <span :class="source.bound || source.auto ? 'ok' : 'off'">
                {{ source.bound ? "已固定给本插件" : source.auto ? "自动选用" : "未绑定" }}
              </span>
              <template v-if="!source.ready">
                <span class="ps-sep">·</span>
                <span class="ps-bad">渠道离线或被占用</span>
              </template>
            </div>
          </div>
          <div
            class="switch"
            :class="{ on: !!source.bound, dim: !source.bound && !source.ready }"
            role="switch"
            :aria-checked="!!source.bound"
            :title="source.bound ? '取消绑定' : '绑定为此插件的专用来源'"
            @click="onToggleSource(source, !source.bound)"
          ></div>
        </div>
      </div>
      <div v-else class="psd-empty">
        {{ sourceError || "插件尚未运行或未声明执行来源，请先开启插件后再来配置。" }}
      </div>
      <div v-if="dialogBindable.length" class="psd-bulk">
        <span>当前存在 {{ dialogBindable.length }} 个就绪但尚未固定的渠道</span>
        <button class="btn btn-cta mini" :disabled="bindAllBusy" @click="onBindAllSources">
          {{ bindAllBusy ? "固定中…" : `一键全部绑定 (${dialogBindable.length})` }}
        </button>
      </div>
      <div v-if="dialogIdleChannels.length" class="psd-note">
        另有 {{ dialogIdleChannels.length }} 个渠道需待插件启动后加载：{{ dialogIdleChannels.join("、") }}
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.plugins-sec {
  padding-bottom: 12px;
}

.is-spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}

/* ========================================================
   🌌 星空控制台卡片 (Starfield Update Center)
   ======================================================== */
.starfield-update-card {
  position: relative;
  overflow: hidden;
  padding: 16px 18px 12px;
  margin-bottom: 14px;
  border-radius: var(--r-md);
  background: linear-gradient(135deg, rgba(16, 22, 34, 0.95) 0%, rgba(13, 19, 28, 0.98) 100%);
  border: 1px solid rgba(106, 232, 156, 0.22);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

/* 星空微光星云背景与散落星芒 */
.star-nebula {
  position: absolute;
  top: -40px;
  right: -20px;
  width: 220px;
  height: 180px;
  background: radial-gradient(circle, rgba(68, 224, 127, 0.12) 0%, rgba(92, 157, 255, 0.08) 50%, transparent 70%);
  filter: blur(24px);
  pointer-events: none;
}
.star-sparkle {
  position: absolute;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: #ffffff;
  opacity: 0.6;
  pointer-events: none;
}
.star-sparkle.s1 { top: 22px; right: 80px; box-shadow: 0 0 6px #6ae89c; animation: twinkle 3s ease-in-out infinite; }
.star-sparkle.s2 { top: 48px; right: 190px; box-shadow: 0 0 8px #5c9dff; animation: twinkle 4s ease-in-out infinite 1.5s; }
.star-sparkle.s3 { top: 70px; right: 40px; box-shadow: 0 0 5px #ffffff; animation: twinkle 3.5s ease-in-out infinite 0.7s; }
@keyframes twinkle {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.3); }
}

/* 状态展示行 */
.sf-status-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.sf-icon-orbit {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.sf-icon-orbit.ok-orbit {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.3);
  color: var(--accent-strong);
}
.sf-icon-orbit.active-orbit {
  background: linear-gradient(135deg, rgba(68, 224, 127, 0.2) 0%, rgba(92, 157, 255, 0.2) 100%);
  border-color: rgba(68, 224, 127, 0.4);
  color: #6ae89c;
  box-shadow: 0 0 12px rgba(68, 224, 127, 0.3);
}
.sf-icon-orbit.err-orbit {
  background: rgba(242, 109, 109, 0.12);
  border-color: rgba(242, 109, 109, 0.3);
  color: #f26d6d;
}
.sf-icon {
  font-size: 20px;
}
.pulse {
  animation: pulseIcon 2s ease-in-out infinite;
}
@keyframes pulseIcon {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}

.sf-status-body {
  flex: 1;
  min-width: 0;
}
.sf-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.sf-badge-count {
  font-size: 11px;
  font-weight: 700;
  color: #0b1016;
  background: var(--accent-strong);
  padding: 1px 7px;
  border-radius: var(--r-pill);
}
.sf-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 3px;
}

.sf-update-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.sf-update-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(68, 224, 127, 0.1);
  border: 1px solid rgba(68, 224, 127, 0.3);
  color: var(--text);
}
.sf-update-chip small {
  color: var(--accent-strong);
  font-weight: 600;
}
.sf-req-tag {
  font-size: 9px;
  background: rgba(229, 180, 84, 0.25);
  color: var(--warn);
  padding: 0 4px;
  border-radius: 2px;
}

/* 星空定制按钮 */
.btn-starfield {
  padding: 6px 14px;
  border-radius: var(--r-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}
.btn-starfield.cta {
  background: linear-gradient(135deg, var(--cta-1, #12a150) 0%, var(--cta-2, #3ddc84) 100%);
  color: #0b140e;
  box-shadow: 0 2px 10px rgba(61, 220, 132, 0.35);
}
.btn-starfield.cta:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: 0 4px 14px rgba(61, 220, 132, 0.5);
}
.btn-starfield.outline {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.15);
  color: var(--text);
}
.btn-starfield.outline:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-strong);
}
.btn-starfield.disabled, .btn-starfield:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 进度条动画 */
.sf-mini-progress {
  width: 120px;
  height: 5px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: var(--r-pill);
  overflow: hidden;
  position: relative;
}
.sf-progress-bar {
  display: block;
  width: 50%;
  height: 100%;
  background: var(--accent-strong);
  border-radius: var(--r-pill);
  animation: moveProgress 1.2s ease-in-out infinite alternate;
}
@keyframes moveProgress {
  from { transform: translateX(0); }
  to { transform: translateX(100%); }
}

/* 底部开关条 */
.sf-controls-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  flex-wrap: wrap;
  gap: 10px;
}
.sf-switches {
  display: flex;
  align-items: center;
  gap: 18px;
}
.sf-switch-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.sf-footer-tip {
  font-size: 10.5px;
  color: var(--text-3);
}

/* ========================================================
   空态导入卡片
   ======================================================== */
.ps-empty-box {
  margin-top: 10px;
  border: 1px dashed rgba(106, 232, 156, 0.3);
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--r-md);
  padding: 24px 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.ps-empty-box:hover, .ps-empty-box:focus-visible {
  border-color: var(--accent);
  background: rgba(68, 224, 127, 0.04);
  outline: none;
}
.ps-empty-graphic {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  color: var(--text-3);
  flex-shrink: 0;
}
.ps-empty-content {
  flex: 1;
  min-width: 0;
}
.ps-empty-head {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.ps-empty-desc {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.5;
}

/* ========================================================
   已安装插件卡片流 (Plugin Tile Cards)
   ======================================================== */
.section-subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 2px 8px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text);
}
.subhead-meta {
  font-size: 11px;
  font-weight: normal;
  color: var(--text-3);
}

.plugin-card-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.plugin-tile-card {
  padding: 12px 14px;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  transition: all 0.2s ease;
}
.plugin-tile-card:hover {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.04);
}
.plugin-tile-card.is-disabled {
  opacity: 0.72;
}
.plugin-tile-card.is-broken {
  border-color: rgba(242, 109, 109, 0.3);
}

.ptc-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ptc-icon-wrap {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  flex-shrink: 0;
}
.ptc-icon {
  font-size: 18px;
}
.ptc-header-text {
  flex: 1;
  min-width: 0;
}
.ptc-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ptc-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.ptc-version {
  font-size: 10px;
  color: var(--text-3);
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}
.ptc-update-available {
  font-size: 10.5px;
  font-weight: 600;
  color: #6ae89c;
  background: rgba(68, 224, 127, 0.15);
  border: 1px solid rgba(68, 224, 127, 0.35);
  padding: 1px 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.ptc-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
}
.ptc-pulse-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ptc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}
.ptc-dot.running {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
}
.ptc-dot.warn {
  background: #f59e0b;
}
.ptc-sep {
  opacity: 0.5;
}

.ptc-switch-wrap {
  flex-shrink: 0;
}
.ptc-alert-banner {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(242, 109, 109, 0.1);
  border: 1px solid rgba(242, 109, 109, 0.25);
  color: #f26d6d;
  font-size: 11px;
  display: flex;
  align-items: center;
}

.ptc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.ptc-footer-left, .ptc-footer-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn.mini {
  padding: 3px 8px;
  font-size: 11px;
  height: 24px;
}
.btn.mini.danger {
  color: #f26d6d;
}
.btn.mini.danger:hover {
  background: rgba(242, 109, 109, 0.12);
  border-color: rgba(242, 109, 109, 0.35);
}

/* ========================================================
   号池托管卡片
   ======================================================== */
.pool-managed-card {
  margin-top: 14px;
}
.card-header-compact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.card-title-text {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  display: inline-flex;
  align-items: center;
}
.card-hint-text {
  font-size: 11px;
  color: var(--text-3);
}

.pool-sync-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pool-sync-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px;
  border-top: 1px solid var(--line);
}
.pool-sync-item:first-child {
  border-top: none;
}
.psi-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.psi-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}
.psi-dot.ok {
  background: #22c55e;
}
.psi-dot.bad {
  background: #f26d6d;
}
.psi-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.psi-info b {
  font-size: 12px;
  color: var(--text);
}
.psi-info small {
  font-size: 10.5px;
  color: var(--text-3);
}

/* ========================================================
   执行来源弹窗
   ======================================================== */
.psd-title {
  font-size: 14px;
  font-weight: 700;
}
.psd-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.5;
}
.psd-list {
  max-height: 44vh;
  overflow: auto;
}
.psd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 2px;
  border-top: 1px solid var(--line);
}
.psd-row:first-child {
  border-top: none;
}
.psd-name {
  font-size: 12.5px;
  font-weight: 600;
}
.psd-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  display: flex;
  gap: 5px;
}
.psd-meta .ok {
  color: #22c55e;
}
.psd-meta .off {
  color: var(--text-3);
}
.psd-empty {
  padding: 12px 2px;
  font-size: 12px;
  color: var(--text-3);
}
.psd-bulk {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-ctl);
  font-size: 11px;
  color: var(--text-3);
}
.psd-note {
  margin-top: 8px;
  font-size: 10.5px;
  color: var(--text-3);
}
</style>