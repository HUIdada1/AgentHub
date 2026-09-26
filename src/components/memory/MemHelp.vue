<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 行内小问号：hover 出气泡；click 切换锁定展开（触屏/键盘可达）。
     气泡复用框架统一的毛玻璃样式（glass-popper + qa-tip），文字色取 --text，亮暗主题自适应。 -->
<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  /** 提示正文（白话解释：这是什么、影响什么、什么时候该改） */
  text: string;
  /** 气泡最大宽度（默认 340px；表格窄列里可收窄） */
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
    popper-class="glass-popper qa-tip mem-tip"
  >
    <template #content>
      <span class="mem-tip-body" :style="width ? { maxWidth: `${width}px` } : undefined">{{ text }}</span>
    </template>
    <i
      class="mem-qa ph ph-question"
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
