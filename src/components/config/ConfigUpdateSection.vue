<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 设置弹窗 · 检查更新：软件更新独立页签（原在「通用」内，随页签拆分整体搬入）。
     状态由主进程 updater.cjs 维护，经 get_update_status 拉取 + update:event 推送；
     更新通知 / 托盘跳转经 app.configFocusUpdate 滚动并高亮更新卡片 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import type { UpdateStatus, UpdateEvent } from "../../types";

const app = useAppStore();

async function refresh() {
  try {
    update.value = await api.getUpdateStatus();
  } catch {
    /* 浏览器预览走 mock */
  }
}

// ===== 软件更新（状态由主进程 updater.cjs 维护，经 get_update_status 拉取 + update:event 推送）=====
const update = ref<UpdateStatus>({
  status: "idle",
  isPortable: false,
  currentVersion: "",
  latestVersion: "",
  percent: 0,
  notes: "",
  message: "",
});
const updateCard = ref<HTMLElement | null>(null);
const highlight = ref(false); // 通知/托盘跳转时闪一下，指明看哪里
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

const updateBusy = computed(() => update.value.status === "checking" || update.value.status === "downloading");

// 手动检查/下载/安装的结果只经返回值回流（不经事件），红点状态在这里同步一份；
// downloading/error 不动红点（下载中的回落由事件侧处理，error 保留提醒）
watch(() => update.value.status, (st) => {
  if (st === "available" || st === "downloaded") app.updateAvailable = true;
  else if (st === "up-to-date" || st === "idle") app.updateAvailable = false;
});

/** 状态行文案：按状态给一句人能读懂的话 */
const updateStateText = computed(() => {
  const s = update.value;
  switch (s.status) {
    case "checking":
      return "正在检查更新…";
    case "up-to-date":
      return "已是最新版本";
    case "available":
      return s.isPortable ? `发现新版本 v${s.latestVersion}，便携版请手动下载` : `发现新版本 v${s.latestVersion}`;
    case "downloading":
      return `正在下载更新 ${s.percent}%`;
    case "downloaded":
      return "更新已下载，重启应用即安装";
    case "error":
      return "更新未完成";
    default:
      return "尚未检查";
  }
});

/** 仅在设置弹窗 · 检查更新可见时刷新更新状态 */
const active = computed(() => app.settingsOpen && app.settingsTab === "update");
watch(active, (v) => { if (v) refresh(); }, { immediate: true });

/** 通知 / 托盘点击「发现新版本」：App.vue 已切到检查更新分类并自增信号，这里滚到更新卡片 */
watch(
  () => app.configFocusUpdate,
  async (n) => {
    if (!n) return;
    await nextTick();
    scrollToCard();
  },
  { immediate: true }
);

async function scrollToCard() {
  await nextTick();
  updateCard.value?.scrollIntoView({ block: "center", behavior: "smooth" });
  highlight.value = true;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => (highlight.value = false), 1600);
}

// ===== 更新操作（结果由主进程事件回流，这里只用返回值兜住无事件的边界）=====
async function doCheck() {
  try {
    update.value = await api.checkUpdate();
  } catch {
    /* 失败态由主进程 error 事件给出 */
  }
}
async function doDownload() {
  try {
    update.value = await api.downloadUpdate();
  } catch {
    /* 同上 */
  }
}
async function doInstall() {
  try {
    update.value = await api.installUpdate();
  } catch {
    /* 同上 */
  }
}
function openReleases() {
  api.openReleasePage().catch(() => {});
}

/** 自动检查开关：v-model 已改框架配置，这里只管落盘；主进程每轮检查前读盘故即时生效 */
async function setAutoCheck() {
  await app.save();
}

// 主进程推送的更新状态变化（下载进度等实时回流）
let offUpdate: (() => void) | undefined;
onMounted(() => {
  offUpdate = api.onUpdateEvent((e) => {
    const { event, ...state } = e as UpdateEvent;
    if (event === "focus-update") return; // 跳转信号由 App.vue 统一处理
    update.value = state;
  });
});
onUnmounted(() => {
  if (offUpdate) offUpdate();
  if (highlightTimer) clearTimeout(highlightTimer);
});
</script>

<template>
  <div class="cfg-sec">
    <div ref="updateCard" class="card" :class="{ flash: highlight }">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">
            {{ updateStateText }}
            <el-tag
              v-if="update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded'"
              type="success"
              class="upd-ver"
            >
              {{ update.currentVersion }} → {{ update.latestVersion }}
            </el-tag>
          </div>
          <div v-if="update.message" class="set-desc">{{ update.message }}</div>
          <div v-else-if="update.isPortable" class="set-desc">便携版为免安装单文件，无法自动覆盖，检测到新版后请到 Releases 手动替换</div>
        </div>
        <div class="upd-actions">
          <!-- 三个按钮仅在 available/downloaded 态渲染（即「检测到新版本」），红点随按钮出现即代表有待处理更新；
               红点用 .dot-host 包一层承载定位，避免按钮溢出裁剪红点 -->
          <span v-if="update.status === 'available' && !update.isPortable" class="dot-host">
            <button class="btn btn-cta" @click="doDownload">下载更新</button>
            <span class="dot-ping"></span>
          </span>
          <span v-else-if="update.status === 'downloaded' && !update.isPortable" class="dot-host">
            <button class="btn btn-cta" @click="doInstall">重启并安装</button>
            <span class="dot-ping"></span>
          </span>
          <span v-else-if="update.status === 'available'" class="dot-host">
            <button class="btn btn-cta" @click="openReleases">前往下载</button>
            <span class="dot-ping"></span>
          </span>
          <button v-else-if="update.status === 'error'" class="btn btn-ghost" @click="openReleases">前往下载</button>
          <button class="btn btn-ghost" :disabled="updateBusy" @click="doCheck">
            {{ updateBusy ? "处理中…" : "检查更新" }}
          </button>
        </div>
      </div>

      <el-progress
        v-if="update.status === 'downloading'"
        class="upd-progress"
        :percentage="update.percent"
        :stroke-width="4"
        :show-text="false"
      />

      <div v-if="update.notes" class="upd-notes">
        <div class="upd-notes-head">更新说明</div>
        <div class="upd-notes-body">{{ update.notes }}</div>
      </div>

      <div class="set-row">
        <div class="set-info">
          <div class="set-name">自动检查更新</div>
          <div class="set-desc">每小时检查更新，发现新版仅提醒</div>
        </div>
        <div
          class="switch"
          :class="{ on: app.config.update.autoCheck }"
          role="switch"
          :aria-checked="!!app.config.update.autoCheck"
          @click="app.config.update.autoCheck = !app.config.update.autoCheck; setAutoCheck()"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 通知/托盘跳转进来的落点提示：高亮一圈，1.6 秒后自行退去 */
.card.flash {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
/* 版本迁移标签：复用 el-tag，仅补左间距 */
.upd-ver {
  margin-left: 8px;
}
.upd-progress {
  margin: 2px 0 10px;
}
.upd-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
/* 更新按钮组的红点定位由 .dot-host 承载（global.css 的 .dot-ping/.dot-host），
   避免按钮自身的溢出裁剪把红点角裁掉 */
.upd-notes {
  margin: 2px 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--code-bg);
  overflow: hidden;
}
.upd-notes-head {
  padding: 7px 11px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
}
/* 限高内滚：更新说明可能有十几行，不能撑长页面 */
.upd-notes-body {
  max-height: 148px;
  overflow: auto;
  padding: 9px 11px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
