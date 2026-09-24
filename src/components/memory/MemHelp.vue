<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 行内小问号：鼠标移上去给一段"这是什么/怎么用"的白话说明。
     气泡复用框架统一的毛玻璃样式（glass-popper + qa-tip），文字色取 --text，亮暗主题自适应。 -->
<script setup lang="ts">
defineProps<{
  /** 提示正文（白话解释：这是什么、影响什么、什么时候该改） */
  text: string;
  /** 气泡最大宽度（默认 340px；表格窄列里可收窄） */
  width?: number;
}>();
</script>

<template>
  <el-tooltip placement="top" :show-after="120" popper-class="glass-popper qa-tip mem-tip">
    <template #content>
      <span class="mem-tip-body" :style="width ? { maxWidth: `${width}px` } : undefined">{{ text }}</span>
    </template>
    <i class="mem-qa ph ph-question" aria-hidden="true" @click.stop></i>
  </el-tooltip>
</template>
