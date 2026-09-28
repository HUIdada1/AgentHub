<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 首启新手引导卡片：仅在记忆总数 0 时显示，降低初次使用认知门槛 -->
<script setup lang="ts">
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";

const app = useAppStore();
const mem = useMemoryStore();

function gotoAgents() {
  app.setPage("agents");
}

function gotoBrowse() {
  mem.browseViewHint = "list";
  app.setPage("browse");
}
</script>

<template>
  <div v-if="mem.stats && mem.stats.total === 0" class="mem-card mem-first-run">
    <div class="first-run-header">
      <div class="fr-title">
        <i class="ph ph-sparkle fr-icon"></i>
        <span>欢迎使用记忆中枢 · 3 步开启 AI 持续记忆</span>
      </div>
      <span class="mem-hint">透明本地存储 · 跨助手共享 · 零割裂</span>
    </div>

    <div class="first-run-steps">
      <div class="fr-step">
        <div class="fr-num">1</div>
        <div class="fr-content">
          <div class="fr-step-title">注入 Agent 记忆工具</div>
          <div class="fr-step-desc">进入「Agent 接入」，为您的 Trae/Cursor/Claude 等一键注入 MCP 记忆能力。</div>
          <button class="btn btn-cta" style="margin-top: 8px; font-size: 11.5px; padding: 3px 10px" @click="gotoAgents">
            去接入 Agent →
          </button>
        </div>
      </div>

      <div class="fr-step">
        <div class="fr-num">2</div>
        <div class="fr-content">
          <div class="fr-step-title">对话自动沉淀记忆</div>
          <div class="fr-step-desc">平时正常与 AI 交流，提到技术决策或偏好时，Agent 会自动调用 <code>memory_write</code> 写入仓库。</div>
        </div>
      </div>

      <div class="fr-step">
        <div class="fr-num">3</div>
        <div class="fr-content">
          <div class="fr-step-title">随时检索、修改与裁决</div>
          <div class="fr-step-desc">回到本控制台，随时浏览查看、就地编辑修改，AI 发现记忆冲突时会提议供您点头确认。</div>
          <button class="btn btn-ghost" style="margin-top: 8px; font-size: 11.5px; padding: 3px 10px" @click="gotoBrowse">
            手动新建首条记忆
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mem-first-run {
  background: linear-gradient(135deg, var(--bg-card) 0%, var(--accent-dim) 100%);
  border: 1px solid var(--accent-line);
  margin-bottom: 12px;
}
.first-run-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.fr-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.fr-icon {
  font-size: 18px;
  color: var(--accent);
}
.first-run-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}
.fr-step {
  display: flex;
  gap: 10px;
  padding: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-panel);
}
.fr-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}
.fr-content {
  flex: 1;
}
.fr-step-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.fr-step-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 4px;
  line-height: 1.45;
}
</style>
