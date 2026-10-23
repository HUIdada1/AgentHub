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
<!-- 顶部通栏横条（替代原生标题栏 + 原来左右两张卡片）：
     左 = 品牌（logo + AgentHub），右 = 全局操作（版本 / 作者 / Star / 主题 / 设置 + 窗口三键）。
     不是卡片：无圆角、无毛玻璃底，只有一条发丝下边线；贴住窗口顶端，左右通到边缘。
     Electron 下整条是拖拽把手，里面的按钮由 TopBarActions 自己声明 no-drag -->
<script setup lang="ts">
import TopBarActions from "./TopBarActions.vue";
import logoUrl from "../assets/logo.png";
</script>

<template>
  <header class="app-topbar glass">
    <div class="tb-brand">
      <img class="tb-logo" :src="logoUrl" alt="AgentHub" />
      <span class="tb-name">AgentHub</span>
    </div>
    <TopBarActions />
  </header>
</template>

<style scoped>
.app-topbar {
  grid-area: topbar;
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 12px;
  /* 通栏：抵消 .app 的左右内边距顶到窗口边缘，再用内边距把内容对齐回网格线 */
  margin-inline: calc(var(--gap-shell) * -1);
  padding-inline: var(--gap-shell);
  /* 底色直接吃 .glass（与各卡片同一套液态玻璃渐变 + 背景模糊），只是不带圆角、通到边缘。
     下边线换成更淡的 --line，避免和玻璃自带的 1px 描边叠成两道 */
  border-radius: 0;
  border-bottom: 1px solid var(--line);
  /* 玻璃默认那圈 24/56 的大投影挂在通栏条上会把下方内容压暗：
     保留和卡片一致的顶部内高光（玻璃受光边），外投影收成贴边的薄影 */
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 6px 18px -12px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
/* 拖拽区：只在 Electron 下生效——浏览器里 -webkit-app-region 会把点击吃掉 */
html.is-electron .app-topbar {
  -webkit-app-region: drag;
  user-select: none;
}

.tb-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.tb-logo {
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
  object-fit: cover;
  display: block;
}
.tb-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text);
  white-space: nowrap;
}
</style>
