<!-- 用量同步模块顶栏：数据源切换（全部 + 独立源 + 组下拉）+ 同步状态 + 立即同步
     原「用量记录同步」AppBar.vue；主题切换按钮归框架侧栏，这里不再重复 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useSyncStore, ALL_SOURCES } from "../../stores/sync";
import type { SourceInfo, TopBarItem } from "../../types/sync";

const app = useSyncStore();

// 来源清单与名称来自后端 list_sources（唯一事实源是适配器），前端不再硬编码
const lastSyncLabel = computed(() => {
  const t = app.sync.lastSyncAt;
  return t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "—";
});

// ===== 分组下拉（仅 ≥2 个可见子源的组显示为组 pill） =====
const menu = ref<{ key: string; top: number; left: number; minWidth: number } | null>(null);

/** 组 pill 显示名：激活子源名优先，否则组缩略名 */
function groupLabel(item: TopBarItem): string {
  if (item.kind !== "group") return item.source.name;
  return item.children.find((c) => c.id === app.activeSource)?.name ?? item.label;
}
/** 退化/独立源统一取子源 */
function plainOf(item: TopBarItem): SourceInfo {
  return item.kind === "group" ? item.children[0] : item.source;
}

function toggleMenu(item: TopBarItem, e: MouseEvent) {
  if (item.kind !== "group") return;
  if (menu.value?.key === item.key) {
    menu.value = null;
    return;
  }
  const pill = (e.currentTarget as HTMLElement).closest(".source-tab");
  if (!pill) return;
  const r = pill.getBoundingClientRect();
  menu.value = { key: item.key, top: r.bottom + 6, left: r.left, minWidth: Math.max(r.width, 190) };
}
function closeMenu() {
  menu.value = null;
}
function pickChild(child: SourceInfo) {
  app.setActiveSource(child.id);
  closeMenu();
}
function onDocPointerDown(e: PointerEvent) {
  const el = e.target as HTMLElement | null;
  if (!el?.closest(".source-tab-group") && !el?.closest(".src-group-menu")) closeMenu();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeMenu();
}
onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onDocKey);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onDocKey);
});
</script>

<template>
  <header class="appbar sync-topbar sync-scope">
    <div class="source-tabs-wrap">
      <!-- 「全部」固定在横向滚动盒之外，按钮再多也始终可见 -->
      <button
        class="source-tab source-tab-all"
        :class="{ active: app.activeSource === ALL_SOURCES }"
        @click="app.setActiveSource(ALL_SOURCES)"
      >
        <span class="dot" v-if="app.anyVisibleSourceEnabled"></span>
        全部
      </button>
      <span class="tabs-divider"></span>
      <div class="source-tabs">
        <template v-for="item in app.topItems(false)" :key="item.kind === 'group' ? 'g:' + item.key : item.source.id">
          <!-- 组（≥2 个可见子源）：组 pill + 下拉选择器 -->
          <button
            v-if="item.kind === 'group' && item.children.length > 1"
            class="source-tab source-tab-group"
            :class="{ active: item.children.some((c) => c.id === app.activeSource), open: menu?.key === item.key }"
            @click.stop="toggleMenu(item, $event)"
          >
            <span class="dot" v-if="item.children.some((c) => app.isSourceEnabled(c.id))"></span>
            <span>{{ groupLabel(item) }}</span>
            <svg class="grp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <!-- 组内仅剩 1 个可见子源时退化为普通 pill；独立源同此 -->
          <button
            v-else
            class="source-tab"
            :class="{ active: app.activeSource === plainOf(item).id }"
            @click="app.setActiveSource(plainOf(item).id)"
          >
            <span class="dot" v-if="app.isSourceEnabled(plainOf(item).id)"></span>
            {{ plainOf(item).name }}
          </button>
        </template>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="sync-state">
      <span class="ok-dot"></span>
      <span v-if="app.sync.running">{{ app.sync.message }}</span>
      <span v-else>最后同步 {{ lastSyncLabel }}</span>
    </div>
    <button
      class="btn btn-cta"
      :class="{ 'is-loading': app.syncing }"
      :disabled="app.syncing"
      @click="app.startSync()"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>
      {{ app.syncing ? "同步中" : app.webdavReady ? "立即同步" : "立即读取" }}
    </button>
  </header>

  <!-- 分组下拉：Teleport 到 body，避免被顶栏横向滚动盒裁剪（sync-scope 保持样式作用域） -->
  <Teleport to="body">
    <div
      v-if="menu"
      class="src-group-menu sync-scope"
      :style="{ top: menu.top + 'px', left: menu.left + 'px', minWidth: menu.minWidth + 'px' }"
    >
      <template v-for="item in app.topItems(false)" :key="'m' + (item.kind === 'group' ? item.key : item.source.id)">
        <template v-if="item.kind === 'group' && item.key === menu.key">
          <button
            v-for="c in item.children"
            :key="c.id"
            class="src-group-menu-item"
            :class="{ active: app.activeSource === c.id }"
            @click="pickChild(c)"
          >
            <span class="dot" v-if="app.isSourceEnabled(c.id)"></span>
            <span>{{ c.name }}</span>
          </button>
        </template>
      </template>
    </div>
  </Teleport>
</template>
