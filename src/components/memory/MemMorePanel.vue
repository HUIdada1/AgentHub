<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 更多扩展功能面板：收纳低频/高级维护页面，保持首屏清爽 -->
<script setup lang="ts">
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";

const app = useAppStore();
const mem = useMemoryStore();

interface MoreItem {
  page: string;
  name: string;
  desc: string;
  icon: string;
}

const items: MoreItem[] = [
  {
    page: "profile",
    name: "深层画像",
    desc: "跨项目沉淀你的人格画像、技术偏好与工作习惯",
    icon: "ph-user-focus",
  },
  {
    page: "agents",
    name: "Agent 接入",
    desc: "管理各 AI 助手的 MCP 记忆工具注入与调用连通性",
    icon: "ph-plugs-connected",
  },
  {
    page: "auto",
    name: "自动化任务",
    desc: "定时后台增量归档、自动打标签与知识提炼",
    icon: "ph-clock-countdown",
  },
  {
    page: "import",
    name: "导入与去重",
    desc: "导入外部会话记录，排查全库相似重复记忆",
    icon: "ph-file-arrow-up",
  },
  {
    page: "sync",
    name: "WebDAV 同步",
    desc: "在多台电脑间备份与同步记忆，裁决同步冲突",
    icon: "ph-cloud-check",
  },
  {
    page: "index",
    name: "检索与索引",
    desc: "搜不到内容时来此诊断修复全文索引与关联图谱",
    icon: "ph-magnifying-glass-plus",
  },
];

function gotoPage(page: string) {
  app.setPage(page);
}
</script>

<template>
  <div class="mem-card mem-more-panel">
    <div class="mem-card-title">
      <span>扩展工具与维护</span>
      <span class="mem-hint">常用操作在上方；低频维护、导入与深度配置在此展开</span>
    </div>
    <div class="mem-more-grid">
      <div
        v-for="it in items"
        :key="it.page"
        class="mem-more-card"
        @click="gotoPage(it.page)"
      >
        <div class="mem-more-icon">
          <i :class="['ph', it.icon]"></i>
        </div>
        <div class="mem-more-info">
          <div class="mem-more-name">
            {{ it.name }}
            <span v-if="mem.pending[it.page]" class="mem-chip warn" style="font-size: 10px; padding: 0 4px">
              {{ mem.pending[it.page] }}
            </span>
          </div>
          <div class="mem-more-desc">{{ it.desc }}</div>
        </div>
        <i class="ph ph-caret-right mem-more-arrow"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mem-more-panel {
  margin-top: 4px;
}
.mem-more-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.mem-more-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-panel);
  cursor: pointer;
  transition: all 0.18s var(--ease);
}
.mem-more-card:hover {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  transform: translateY(-1px);
}
.mem-more-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-sm);
  background: var(--bg-hover);
  color: var(--accent);
  font-size: 18px;
  flex-shrink: 0;
}
.mem-more-info {
  flex: 1;
  min-width: 0;
}
.mem-more-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.mem-more-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mem-more-arrow {
  color: var(--text-3);
  font-size: 13px;
  opacity: 0.6;
  transition: transform 0.18s var(--ease);
}
.mem-more-card:hover .mem-more-arrow {
  transform: translateX(2px);
  opacity: 1;
  color: var(--accent);
}
</style>
