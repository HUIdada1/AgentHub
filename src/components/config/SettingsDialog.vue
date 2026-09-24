<!-- 全局设置弹窗：左下角设置按钮打开。通用 / WebDAV 同步 / 同步时间 / 数据与备份四块，
     左列模块按钮点击切换，右侧内容定高滚动（弹窗大小固定，不随内容长高）；
     各模块自己的配置不在弹窗里，在对应板块右上「配置」按钮切换的配置页中 -->
<script setup lang="ts">
import { ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { SETTINGS_TABS } from "../../types";
import ConfigGeneralSection from "./ConfigGeneralSection.vue";
import ConfigWebdavSection from "./ConfigWebdavSection.vue";
import ConfigTimingSection from "./ConfigTimingSection.vue";
import ConfigDataSection from "./ConfigDataSection.vue";

const app = useAppStore();

/** 模块懒挂载：首次切到才挂载（配置拉取 / 状态探测不白跑），之后 v-show 保活 */
const visited = ref<Record<string, boolean>>({});
watch(
  () => (app.settingsOpen ? app.settingsTab : ""),
  (t) => {
    if (t) visited.value[t] = true;
  },
  { immediate: true }
);
</script>

<template>
  <el-dialog v-model="app.settingsOpen" class="settings-dialog" width="780px" align-center append-to-body>
    <template #header>
      <div>
        <div class="sd-title">设置</div>
        <div class="sd-sub">通用 · WebDAV 同步 · 同步时间 · 数据与备份（各模块配置在对应板块右上「配置」）</div>
      </div>
    </template>
    <div class="sd-layout">
      <div class="sd-nav">
        <button
          v-for="t in SETTINGS_TABS"
          :key="t.key"
          class="sd-nav-btn"
          :class="{ active: app.settingsTab === t.key }"
          @click="app.settingsTab = t.key"
        >
          <i class="ph" :class="t.icon"></i>
          <span class="sd-nav-txt">
            <b>{{ t.name }}</b>
            <small>{{ t.desc }}</small>
          </span>
        </button>
      </div>
      <div class="sd-scroll">
        <div v-if="visited.general" v-show="app.settingsTab === 'general'"><ConfigGeneralSection /></div>
        <div v-if="visited.webdav" v-show="app.settingsTab === 'webdav'"><ConfigWebdavSection /></div>
        <div v-if="visited.timing" v-show="app.settingsTab === 'timing'"><ConfigTimingSection /></div>
        <div v-if="visited.data" v-show="app.settingsTab === 'data'"><ConfigDataSection /></div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.sd-title {
  font-size: 15px;
  font-weight: 700;
}
.sd-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.settings-dialog {
  max-width: calc(100vw - 48px);
}
/* 弹窗体定高：左列按钮 + 右列内容都在这个高度里，内容超出由右列自己滚 */
.settings-dialog :deep(.el-dialog__body) {
  padding: 14px 16px 16px;
}
.sd-layout {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 14px;
  height: min(560px, calc(100vh - 200px));
}
.sd-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding: 2px;
  border-right: 1px solid var(--line);
}
.sd-nav-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-ui);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.sd-nav-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}
:root[data-theme="light"] .sd-nav-btn:hover {
  background: rgba(15, 23, 42, 0.045);
}
.sd-nav-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
}
.sd-nav-btn > .ph {
  font-size: 16px;
  flex-shrink: 0;
}
.sd-nav-txt {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sd-nav-txt b {
  font-size: 12.5px;
  font-weight: 600;
}
.sd-nav-txt small {
  font-size: 10px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-nav-btn.active .sd-nav-txt small {
  color: var(--accent-strong);
  opacity: 0.75;
}
/* 右列内容：定高内滚；cfg-sec 的纵向节奏在这里生效 */
.sd-scroll {
  min-width: 0;
  overflow-y: auto;
  padding: 2px 6px 2px 2px;
}
.sd-scroll::-webkit-scrollbar {
  width: 6px;
}
</style>
