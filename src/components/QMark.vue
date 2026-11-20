<!-- AgentHub · 全局行内小问号（QMark）
     Copyright (c) 2026 沐晖 (MUHUIX)
     https://github.com/MUHUIX/AgentHub
     本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。 -->
<!-- 以记忆中枢 MemHelp 为蓝本：hover 出气泡、点击锁定展开（触屏/键盘可达）。
     气泡复用全局毛玻璃样式 glass-popper + qa-tip（element.css，含字体色与换行）。
     与 MemHelp 的差异仅在于问号图标样式组件内自带（不依赖 memory.css 的 .mem-qa），
     供记忆中枢以外的板块使用；两者视觉口径一致。 -->
<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  /** 提示正文（白话解释：这是什么、影响什么、什么时候该改） */
  text: string;
  /** 气泡最大宽度（默认沿用 qa-tip 的 300px；窄列里可收窄） */
  width?: number;
}>();

/** 点击切换锁定展开（触屏/键盘用户的可达路径）；hover 自由态不冲突 */
const pinned = ref(false);
</script>

<template>
  <el-tooltip
    placement="top"
    :show-after="120"
    :visible="pinned ? true : undefined"
    popper-class="glass-popper qa-tip"
  >
    <template #content>
      <span class="qmark-body" :style="[{ display: 'block' }, width ? { maxWidth: `${width}px` } : {}]">{{ text }}</span>
    </template>
    <i
      class="qmark ph ph-question"
      role="button"
      tabindex="0"
      :aria-expanded="pinned"
      aria-label="查看说明"
      @click.stop="pinned = !pinned"
      @keydown.enter.stop.prevent="pinned = !pinned"
      @keydown.space.stop.prevent="pinned = !pinned"
    ></i>
  </el-tooltip>
</template>

<style scoped>
/* 问号图标：静态低调、悬停点亮（与 memory.css 的 .mem-qa 同口径，作用域收在本组件） */
.qmark {
  color: var(--text-3);
  cursor: help;
  margin-left: 4px;
  vertical-align: -1px;
  transition: color 0.16s var(--ease), transform 0.16s var(--ease);
}
.qmark:hover {
  color: var(--accent);
  transform: translateY(-1px);
}
</style>
