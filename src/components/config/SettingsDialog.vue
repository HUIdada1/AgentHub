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
<!-- 全局设置弹窗：左下角设置按钮打开。通用 / WebDAV 同步 / 同步时间 / 数据与备份 / 模型与网关 / 反馈与需求 / 检查更新，
     左列模块按钮点击切换，右侧内容定高滚动（弹窗大小固定，不随内容长高）；
     各模块自己的配置不在弹窗里，在对应板块右上「配置」按钮切换的配置页中 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { SETTINGS_TABS } from "../../types";
import { isWebTransport } from "../../api/caps";
import ConfigGeneralSection from "./ConfigGeneralSection.vue";
import ConfigWebdavSection from "./ConfigWebdavSection.vue";
import ConfigTimingSection from "./ConfigTimingSection.vue";
import ConfigDataSection from "./ConfigDataSection.vue";
import ConfigModelsSection from "./ConfigModelsSection.vue";
import ConfigPluginsSection from "./ConfigPluginsSection.vue";
import ConfigFeedbackSection from "./ConfigFeedbackSection.vue";
import ConfigUpdateSection from "./ConfigUpdateSection.vue";

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

// 设置关闭时刷新插件状态：安装/卸载发生在弹窗内，关闭后侧栏入口要立刻跟着变
watch(
  () => app.settingsOpen,
  (open) => { if (!open) app.refreshPlugins(); }
);

/** 设置导航：内置页签固定，「外置插件」常驻在「模型与网关」与「反馈与需求」之间（仅桌面端）。
 *  不能按「已安装插件数」显隐——没装插件时页签若消失，「导入插件」就没了入口，第一个插件永远装不上。 */
const webMode = isWebTransport();
const tabs = computed(() => {
  const list = SETTINGS_TABS.slice();
  if (webMode) return list;
  const at = list.findIndex((t) => t.key === "feedback");
  list.splice(at < 0 ? list.length : at, 0, {
    key: "plugins" as const,
    name: "外置插件",
    icon: "ph-puzzle-piece",
    desc: "导入 · 启停 · 更新 · 卸载",
  });
  return list;
});

/** 弹窗副标题按实际页签拼，避免新增页签后文案与导航不一致 */
const subTitle = computed(() => tabs.value.map((t) => t.name).join(" · "));

/** 宽度按页签自适应：其余五页是表单流（780px 正好），模型与网关页是 4 列表格 + 来源优先级双栏，
 *  780px 时右列可用宽仅 ≈550px（780 − 32 padding − 176 左列 − 14 gap − 8 滚动条内边距），
 *  表格必然挤成换行，故该页单独放宽到 1040px。外置插件页是插件列表，900px 足够。 */
const dialogWidth = computed(() => {
  if (app.settingsTab === "models") return "1040px";
  if (app.settingsTab === "plugins") return "900px";
  return "780px";
});
/** 模型与网关页内容更长（三块卡片），高度同步给一点，避免一屏只看到一块半 */
const layoutHeight = computed(() =>
  app.settingsTab === "models" || app.settingsTab === "plugins"
    ? "min(640px, calc(100vh - 160px))"
    : "min(560px, calc(100vh - 200px))"
);
</script>

<template>
  <el-dialog v-model="app.settingsOpen" class="settings-dialog" :width="dialogWidth" align-center append-to-body>
    <template #header>
      <div>
        <div class="sd-title">设置</div>
        <div class="sd-sub">{{ subTitle }}（各模块配置在对应板块右上「配置」）</div>
      </div>
    </template>
    <div class="sd-layout" :style="{ height: layoutHeight }">
      <div class="sd-nav">
        <button
          v-for="t in tabs"
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
        <div v-if="visited.models" v-show="app.settingsTab === 'models'"><ConfigModelsSection /></div>
        <!-- 外置插件：独立页签常驻（桌面端），未安装时页内是空态导入引导 -->
        <div v-if="visited.plugins" v-show="app.settingsTab === 'plugins'">
          <ConfigPluginsSection />
        </div>
        <div v-if="visited.feedback" v-show="app.settingsTab === 'feedback'"><ConfigFeedbackSection /></div>
        <!-- 检查更新：软件更新独立页签（原在通用内整体搬入），更新通知 / 托盘跳转也落到这里 -->
        <div v-if="visited.update" v-show="app.settingsTab === 'update'"><ConfigUpdateSection /></div>
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
  /* 高度由 :style 按页签下发（模型与网关页更高），这里只兜底 */
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
