<!--
  ============================================================
   作者：沐晖
   日期：2026-10-23
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 顶栏右侧全局操作条：版本 / 作者 / Star / 亮暗 / 设置 + 窗口三键（最小化·全屏·关闭）。
     原生标题栏已用 frame:false 去掉，窗口三键由这里自绘；顺序按爸爸要求固定为
     版本号 → 作者 → Star → 主题 → 设置 → 最小化 → 全屏 → 关闭。
     按钮全部 -webkit-app-region: no-drag，否则点在拖拽区上会被当成拖窗口 -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useAppStore } from "../stores/app";
import * as api from "../api/ipc";

const app = useAppStore();
const version = ref("");
// 全屏态：决定中间那颗按钮画「全屏」还是「还原」
const maximized = ref(false);
let offEvent: (() => void) | undefined;

function openRepo() {
  api.openRepoPage().catch(() => {});
}
function toggleMaximize() {
  api
    .windowToggleMaximize()
    .then((r) => {
      maximized.value = !!r?.maximized;
    })
    .catch(() => {});
}

onMounted(() => {
  api
    .getAppVersion()
    .then((v) => {
      version.value = "v" + v;
    })
    .catch(() => {});
  api
    .windowIsMaximized()
    .then((r) => {
      maximized.value = !!r?.maximized;
    })
    .catch(() => {});
  // 主进程 maximize / unmaximize 时广播，双保险对齐图标（比如系统快捷键、双击拖拽区触发）
  offEvent = api.onUpdateEvent((p) => {
    const e = p as { event?: string; maximized?: boolean };
    if (e && e.event === "window-maximized") maximized.value = !!e.maximized;
  });
});
onUnmounted(() => offEvent?.());
</script>

<template>
  <div class="top-actions">
    <span class="ta-ver">{{ version }}</span>
    <span class="ta-author" title="作者"><i class="ph ph-user"></i>沐晖</span>

    <span class="ta-sep"></span>

    <el-tooltip content="Star 支持" placement="bottom">
      <button class="ta-btn" @click="openRepo">
        <i class="ph ph-github-logo"></i>
      </button>
    </el-tooltip>
    <el-tooltip content="切换亮暗主题" placement="bottom">
      <button class="ta-btn" @click="app.toggleTheme()">
        <i class="ph" :class="app.isDark ? 'ph-moon' : 'ph-sun'"></i>
      </button>
    </el-tooltip>
    <span class="dot-host">
      <el-tooltip content="设置" placement="bottom">
        <button class="ta-btn" @click="app.openSettings('general')">
          <i class="ph ph-gear-six"></i>
        </button>
      </el-tooltip>
      <span v-if="app.updateAvailable" class="dot-ping"></span>
    </span>

    <span class="ta-sep"></span>

    <!-- 窗口三键：细线图标（10×10 描边），比字体图标更贴 Windows 标题栏观感 -->
    <div class="ta-win">
      <button class="win-btn" title="最小化" @click="api.windowMinimize()">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" /></svg>
      </button>
      <button class="win-btn" :title="maximized ? '还原' : '全屏'" @click="toggleMaximize">
        <svg v-if="maximized" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="3" width="6" height="6" rx="0.6" />
          <path d="M3.2 3V1.6h5.2v5.2H7" />
        </svg>
        <svg v-else viewBox="0 0 10 10" aria-hidden="true"><rect x="1.1" y="1.1" width="7.8" height="7.8" rx="0.6" /></svg>
      </button>
      <button class="win-btn close" title="关闭" @click="api.windowClose()">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.4 1.4l7.2 7.2M8.6 1.4L1.4 8.6" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.top-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-right: 2px;
  /* 拖拽区上的按钮必须显式声明 no-drag，否则点击会被当成拖窗口 */
  -webkit-app-region: no-drag;
}

.ta-ver {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  letter-spacing: 0.2px;
  padding-left: 2px;
  white-space: nowrap;
}
.ta-author {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
.ta-author .ph {
  font-size: 11px;
  /* 光学对齐：flex 已把图标盒与文字行盒居中，但 Phosphor 字形以基线锚定、
     line-height:1 的盒内墨迹偏上（canvas 实测墨迹中心比「沐晖」高 1px），
     往下挪 1px 让字形与文字坐在同一行上 */
  transform: translateY(1px);
}
.ta-author:hover {
  color: var(--text-2);
}

/* 竖直分隔线：把「元信息 / 功能键 / 窗口键」三组分开 */
.ta-sep {
  width: 1px;
  height: 16px;
  background: var(--line-strong);
  flex-shrink: 0;
}

.ta-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.ta-btn .ph {
  font-size: 15px;
}
.ta-btn:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.07);
  border-color: var(--line-strong);
}
:root[data-theme="light"] .ta-btn:hover {
  background: rgba(15, 23, 42, 0.05);
}

/* ===== 窗口三键：与系统标题栏同尺寸手感（46×28），关闭悬停才转红 ===== */
.ta-win {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
}
.win-btn {
  width: 34px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.win-btn svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.win-btn:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.09);
}
:root[data-theme="light"] .win-btn:hover {
  background: rgba(15, 23, 42, 0.07);
}
/* 关闭：悬停红底白字（Windows 惯例），与主题无关 */
.win-btn.close:hover {
  color: #fff;
  background: #e5484d;
}
</style>
