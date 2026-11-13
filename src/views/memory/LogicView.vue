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
<!--
  AgentHub · 记忆中枢（Memory Hub）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆中枢 · 记忆逻辑说明：工作原理、核心三层分层体系、全生命周期工作流与思维导图可视化 -->
<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();

type LogicSubTab = "text" | "chart";
const subTab = ref<LogicSubTab>("text");

/* 思维导图画布缩放与平移状态 */
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const isDragging = ref(false);
const startX = ref(0);
const startY = ref(0);
const mapContainer = ref<HTMLElement | null>(null);

function handleZoomIn() {
  zoom.value = Math.min(2.0, Number((zoom.value + 0.15).toFixed(2)));
}

function handleZoomOut() {
  zoom.value = Math.max(0.4, Number((zoom.value - 0.15).toFixed(2)));
}

function handleResetZoom() {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
}

function handleFitView() {
  zoom.value = 0.85;
  panX.value = 0;
  panY.value = 0;
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.08 : -0.08;
  const next = Math.max(0.4, Math.min(2.0, Number((zoom.value + delta).toFixed(2))));
  zoom.value = next;
}

function onPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest(".mindmap-controls")) return;
  isDragging.value = true;
  startX.value = e.clientX - panX.value;
  startY.value = e.clientY - panY.value;
}

function onPointerMove(e: PointerEvent) {
  if (!isDragging.value) return;
  panX.value = e.clientX - startX.value;
  panY.value = e.clientY - startY.value;
}

function onPointerUp() {
  isDragging.value = false;
}
</script>

<template>
  <div class="memory-scope logic-view-page">
    <!-- 头部工具栏与子 Tab 切换器 -->
    <div class="mem-head logic-head">
      <div class="mem-col" style="gap: 4px">
        <h2 class="logic-title">
          <i class="ph ph-brain"></i>
          <span>记忆中枢工作原理与逻辑架构</span>
        </h2>
        <p class="mem-sub" style="margin: 0">
          <span>解构本地记忆的三层分层模型（L0/L1/L2）、唯一物理事实源守则与全生命周期流转链路</span>
          <MemHelp text="记忆中枢通过统一 MCP 协议为各 AI Agent 提供跨工具、跨会话的持久记忆与决策避坑支持" />
        </p>
      </div>

      <div class="logic-tabs-switch">
        <button
          class="switch-tab-btn"
          :class="{ active: subTab === 'text' }"
          @click="subTab = 'text'"
        >
          <i class="ph ph-article"></i>
          <span>文字体系说明</span>
        </button>
        <button
          class="switch-tab-btn"
          :class="{ active: subTab === 'chart' }"
          @click="subTab = 'chart'"
        >
          <i class="ph ph-tree-structure"></i>
          <span>思维导图架构</span>
        </button>
      </div>
    </div>

    <!-- 子 Tab 1：文字体系说明 -->
    <div v-show="subTab === 'text'" class="logic-text-section">
      <!-- 第一章：核心定位与设计哲学 -->
      <div class="logic-card">
        <div class="logic-card-header">
          <div class="logic-chapter-num">01</div>
          <div>
            <h3 class="logic-chapter-title">核心设计哲学：代码优先与唯一事实源</h3>
            <p class="logic-chapter-subtitle">First Principles · 坚守真实现实，打破各 AI Agent 孤岛</p>
          </div>
        </div>

        <div class="philosophy-grid">
          <div class="philosophy-item">
            <div class="phil-icon-box">
              <i class="ph ph-file-code"></i>
            </div>
            <div class="phil-content">
              <h4 class="phil-title">代码是唯一的绝对现实 (Code-First)</h4>
              <p class="phil-text">
                磁盘物理代码是最高现实依据。记忆绝不冗余堆砌瞬息万变的代码细节，而是忠实记录<b>「为什么这样决策」</b>（决策动机）、<b>「踩过什么坑」</b>（避坑指南）与<b>「约定规范」</b>。修改前必须先读磁盘最新文件（Read-Before-Write）。
              </p>
            </div>
          </div>

          <div class="philosophy-item">
            <div class="phil-icon-box">
              <i class="ph ph-arrows-split"></i>
            </div>
            <div class="phil-content">
              <h4 class="phil-title">破除 Agent 之间的割裂孤岛</h4>
              <p class="phil-text">
                Trae、Cursor、Claude Code、Antigravity、Windsurf 各工具往往上下文割裂。记忆中枢作为跨 IDE 的<b>统一外置大脑</b>，通过统一 MCP 协议向所有 Agent 注入相同的长期记忆与演进上下文。
              </p>
            </div>
          </div>

          <div class="philosophy-item">
            <div class="phil-icon-box">
              <i class="ph ph-shield-check"></i>
            </div>
            <div class="phil-content">
              <h4 class="phil-title">数据主权与纯物理资产</h4>
              <p class="phil-text">
                所有记忆均以标准 Markdown 物理文件存储在本地磁盘中。不依赖中心化闭源云端，支持随代码仓库 Git 归档或通过自建 WebDAV 端到端安全加密同步，隐私资产绝对自主掌控。
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 第二章：三层记忆分层体系 -->
      <div class="logic-card">
        <div class="logic-card-header">
          <div class="logic-chapter-num">02</div>
          <div>
            <h3 class="logic-chapter-title">三层记忆分层架构（L0 / L1 / L2）</h3>
            <p class="logic-chapter-subtitle">渐进式披露与上下文经济学 · 杜绝 Token 浪费</p>
          </div>
        </div>

        <div class="layers-container">
          <!-- L0 -->
          <div class="layer-card layer-l0">
            <div class="layer-badge-box">
              <span class="layer-tag">L0 全局画像</span>
              <span class="layer-scope">跨项目全局共享</span>
            </div>
            <h4 class="layer-title">核心画像与行为基因 (Global Profile)</h4>
            <p class="layer-desc">
              深度归纳用户的<b>思维模式、人格特质、沟通偏好、技术栈选型与工作习惯</b>。会话开局单次极简注入（约 300~500 Token），让所有 Agent 第一时间“认识你”，且不挤占宝贵的会话窗口。
            </p>
            <div class="layer-features">
              <span class="feat-pill"><i class="ph ph-check"></i> 人格特质 (Persona)</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 沟通偏好 (Preferences)</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 技术偏好 (Tech Stack)</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 工作习惯 (Habits)</span>
            </div>
          </div>

          <!-- L1 -->
          <div class="layer-card layer-l1">
            <div class="layer-badge-box">
              <span class="layer-tag">L1 项目沉淀</span>
              <span class="layer-scope">按项目仓库物理隔离</span>
            </div>
            <h4 class="layer-title">项目级知识、决策与踩坑字典 (Project Distill)</h4>
            <p class="layer-desc">
              专属项目的高密度沉淀。包含重大<b>架构决策原因、历史踩坑复盘字典（Pitfalls）、关键业务逻辑规则与专有名词表</b>。由日常碎片经自动化任务深度蒸馏生成，精准按项目检索召回。
            </p>
            <div class="layer-features">
              <span class="feat-pill"><i class="ph ph-check"></i> 架构决策记录 (ADR)</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 踩坑与反模式规避</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 核心业务逻辑字典</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 团队与工程约定</span>
            </div>
          </div>

          <!-- L2 -->
          <div class="layer-card layer-l2">
            <div class="layer-badge-box">
              <span class="layer-tag">L2 短期碎片</span>
              <span class="layer-scope">高频生成 · 时效衰减</span>
            </div>
            <h4 class="layer-title">会话碎片与日常流水记录 (Daily & Raw)</h4>
            <p class="layer-desc">
              Agent 日常对话生成的会话日志、历史导入对话与灵感备忘。具备<b>时间衰减与时效性标记</b>，经过滤去重、事实推翻判定后，精华为 L1 项目知识，过时碎片则进入回收站清理。
            </p>
            <div class="layer-features">
              <span class="feat-pill"><i class="ph ph-check"></i> 原始对话导入历史</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 每日工作轨迹</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 动态时间衰减半衰期</span>
              <span class="feat-pill"><i class="ph ph-check"></i> 待去重合并队列</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 第三章：全生命周期流转闭环 -->
      <div class="logic-card">
        <div class="logic-card-header">
          <div class="logic-chapter-num">03</div>
          <div>
            <h3 class="logic-chapter-title">全生命周期流转闭环</h3>
            <p class="logic-chapter-subtitle">采集 → 精炼 → 检索召回 → WebDAV 安全协同</p>
          </div>
        </div>

        <div class="lifecycle-steps">
          <div class="step-card">
            <div class="step-num">01</div>
            <div class="step-icon"><i class="ph ph-download-simple"></i></div>
            <h4 class="step-title">接入与采集</h4>
            <p class="step-desc">
              通过 MCP 协议工具实时注入记忆；同时支持一键导入 Cursor/Claude/Trae 的历史会话归档为统一格式。
            </p>
          </div>

          <div class="step-arrow"><i class="ph ph-caret-right"></i></div>

          <div class="step-card">
            <div class="step-num">02</div>
            <div class="step-icon"><i class="ph ph-cpu"></i></div>
            <h4 class="step-title">自动化精炼</h4>
            <p class="step-desc">
              后台定时调度：智能打标签、生成摘要、识别事实推翻（Supersede 裁决）、全库查重合并与深度知识蒸馏。
            </p>
          </div>

          <div class="step-arrow"><i class="ph ph-caret-right"></i></div>

          <div class="step-card">
            <div class="step-num">03</div>
            <div class="step-icon"><i class="ph ph-magnifying-glass"></i></div>
            <h4 class="step-title">混合检索召回</h4>
            <p class="step-desc">
              BM25 全文倒排 + 语义向量 Embedding 双轨检索，融合时间衰减与置顶权重，按需渐进式披露注入上下文。
            </p>
          </div>

          <div class="step-arrow"><i class="ph ph-caret-right"></i></div>

          <div class="step-card">
            <div class="step-num">04</div>
            <div class="step-icon"><i class="ph ph-arrows-clockwise"></i></div>
            <h4 class="step-title">多端加密协同</h4>
            <p class="step-desc">
              通过标准 WebDAV 端到端安全加密同步，差异比对检测冲突，提供三方合并裁决，多台电脑共用无缝大脑。
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 子 Tab 2：思维导图架构交互图表 -->
    <div v-show="subTab === 'chart'" class="logic-chart-section">
      <!-- 导图控制器浮层 -->
      <div class="mindmap-controls">
        <button class="ctrl-btn" title="放大" @click="handleZoomIn">
          <i class="ph ph-magnifying-glass-plus"></i>
        </button>
        <span class="ctrl-zoom-text">{{ Math.round(zoom * 100) }}%</span>
        <button class="ctrl-btn" title="缩小" @click="handleZoomOut">
          <i class="ph ph-magnifying-glass-minus"></i>
        </button>
        <div class="ctrl-divider"></div>
        <button class="ctrl-btn" title="适应视口" @click="handleFitView">
          <i class="ph ph-arrows-in"></i>
        </button>
        <button class="ctrl-btn" title="重置 100%" @click="handleResetZoom">
          <i class="ph ph-arrows-counter-clockwise"></i>
        </button>
      </div>

      <!-- 画布外壳 -->
      <div
        ref="mapContainer"
        class="mindmap-viewport"
        :class="{ 'is-dragging': isDragging }"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="onPointerUp"
      >
        <div
          class="mindmap-canvas"
          :style="{
            transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }"
        >
          <!-- 思维导图核心树状拓扑 -->
          <div class="mindmap-tree">
            <!-- 根节点：AgentHub 记忆中枢 -->
            <div class="mm-node mm-root">
              <div class="mm-node-inner">
                <i class="ph ph-brain mm-icon"></i>
                <div class="mm-node-title">AgentHub 记忆中枢</div>
                <div class="mm-node-sub">跨 Agent 统一外置大脑与决策事实源</div>
              </div>
            </div>

            <!-- 5 大核心分支 -->
            <div class="mm-branches">
              <!-- 分支 1：采集与接入层 -->
              <div class="mm-branch branch-ingest">
                <div class="mm-node mm-level1">
                  <div class="mm-node-inner">
                    <i class="ph ph-plug-charging mm-icon"></i>
                    <div class="mm-node-title">📥 采集与接入层</div>
                    <div class="mm-node-sub">多源 Agent 统一连通</div>
                  </div>
                </div>
                <div class="mm-children">
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">MCP 标准协议对接</div>
                      <div class="mm-leaf-desc">Trae / Cursor / Claude / Antigravity</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">历史会话批量规整导入</div>
                      <div class="mm-leaf-desc">自动解析为标准记忆条目</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">代码优先守卫 (Code-First)</div>
                      <div class="mm-leaf-desc">Read-Before-Write 铁律</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 分支 2：三层存储体系 -->
              <div class="mm-branch branch-layers">
                <div class="mm-node mm-level1">
                  <div class="mm-node-inner">
                    <i class="ph ph-folders mm-icon"></i>
                    <div class="mm-node-title">🗂️ 核心三层存储体系</div>
                    <div class="mm-node-sub">按重要度与生命周期隔离</div>
                  </div>
                </div>
                <div class="mm-children">
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">L0 全局画像 (Core Profile)</div>
                      <div class="mm-leaf-desc">人格特质 / 沟通风格 / 技术栈 / 工作习惯</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">L1 项目知识 (Project Distill)</div>
                      <div class="mm-leaf-desc">架构决策 / 避坑字典 / 业务规则</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">L2 短期碎片 (Daily / Raw)</div>
                      <div class="mm-leaf-desc">临时会话 / 每日工作轨迹 / 时间衰减</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 分支 3：自动化精炼流水线 -->
              <div class="mm-branch branch-pipeline">
                <div class="mm-node mm-level1">
                  <div class="mm-node-inner">
                    <i class="ph ph-gear-six mm-icon"></i>
                    <div class="mm-node-title">⚙️ 自动化精炼流水线</div>
                    <div class="mm-node-sub">低侵扰后台智能调度</div>
                  </div>
                </div>
                <div class="mm-children">
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">语义摘要与标签推断</div>
                      <div class="mm-leaf-desc">高密度提炼与标签复用</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">事实推翻裁决 (Supersede)</div>
                      <div class="mm-leaf-desc">新事实推翻旧事实，人工确认</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">深度蒸馏 (Knowledge Distill)</div>
                      <div class="mm-leaf-desc">碎片提炼为 L1 决策与踩坑记录</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">全库查重与合并 (Consolidate)</div>
                      <div class="mm-leaf-desc">相似度聚类与冗余清除</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 分支 4：混合检索与召回引擎 -->
              <div class="mm-branch branch-search">
                <div class="mm-node mm-level1">
                  <div class="mm-node-inner">
                    <i class="ph ph-magnifying-glass mm-icon"></i>
                    <div class="mm-node-title">🔍 混合检索与召回引擎</div>
                    <div class="mm-node-sub">精准高质上下文注入</div>
                  </div>
                </div>
                <div class="mm-children">
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">双轨混合检索</div>
                      <div class="mm-leaf-desc">BM25 全文关键词 + 语义向量 Embedding</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">多维权重动态计算</div>
                      <div class="mm-leaf-desc">时间半衰期衰减 + 使用热度 + 项目亲和</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">渐进式披露机制</div>
                      <div class="mm-leaf-desc">按需提取摘要与全文，保护 Context 窗口</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 分支 5：数据安全与 WebDAV 同步 -->
              <div class="mm-branch branch-sync">
                <div class="mm-node mm-level1">
                  <div class="mm-node-inner">
                    <i class="ph ph-cloud-arrow-up mm-icon"></i>
                    <div class="mm-node-title">☁️ 数据安全与多端协同</div>
                    <div class="mm-node-sub">纯本地事实源 + 端到端同步</div>
                  </div>
                </div>
                <div class="mm-children">
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">纯本地 Markdown 物理仓储</div>
                      <div class="mm-leaf-desc">无闭源云端，纯本地资产掌控</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">标准 WebDAV 端到端加密同步</div>
                      <div class="mm-leaf-desc">多设备数据快照实时同步</div>
                    </div>
                  </div>
                  <div class="mm-node mm-leaf">
                    <div class="mm-node-inner">
                      <div class="mm-leaf-title">冲突版本保留与双向裁决</div>
                      <div class="mm-leaf-desc">内联 Diff 比对，保证零数据丢失</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logic-view-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.logic-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.logic-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.logic-title i {
  color: var(--accent, #3b82f6);
  font-size: 22px;
}

/* 顶部子 Tab 切换 */
.logic-tabs-switch {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--mem-soft, rgba(125, 125, 125, 0.08));
  padding: 4px;
  border-radius: var(--r-md, 8px);
  border: 1px solid var(--mem-line, var(--line));
}

.switch-tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--r-sm, 6px);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s var(--ease);
}

.switch-tab-btn:hover {
  color: var(--text);
}

.switch-tab-btn.active {
  background: var(--glass-a, var(--panel));
  color: var(--accent, #3b82f6);
  font-weight: 650;
  border-color: var(--glass-bd, var(--line));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

/* 文字说明部分 */
.logic-text-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.logic-card {
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  padding: 22px 24px;
  box-shadow: var(--glass-shadow, 0 1px 3px rgba(0, 0, 0, 0.05));
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.logic-card-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--mem-line, var(--line));
}

.logic-chapter-num {
  font-family: var(--font-code, monospace);
  font-size: 24px;
  font-weight: 800;
  color: var(--accent, #3b82f6);
  opacity: 0.8;
  background: var(--accent-dim, rgba(59, 130, 246, 0.12));
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.logic-chapter-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.logic-chapter-subtitle {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-3);
}

/* 哲学三格网格 */
.philosophy-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

@media (max-width: 900px) {
  .philosophy-grid {
    grid-template-columns: 1fr;
  }
}

.philosophy-item {
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border: 1px solid var(--mem-line, rgba(125, 125, 125, 0.1));
}

.phil-icon-box {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--accent-dim, rgba(59, 130, 246, 0.12));
  color: var(--accent, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.phil-content {
  flex: 1;
}

.phil-title {
  margin: 0 0 6px;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}

.phil-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.55;
}

/* 分层体系三卡片 */
.layers-container {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

@media (max-width: 960px) {
  .layers-container {
    grid-template-columns: 1fr;
  }
}

.layer-card {
  padding: 16px 18px;
  border-radius: var(--r-md, 10px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border: 1px solid var(--mem-line, rgba(125, 125, 125, 0.12));
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  transition: all 0.2s var(--ease);
}

.layer-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent, #3b82f6);
}

.layer-l0 {
  border-top: 3px solid #f59e0b;
}

.layer-l1 {
  border-top: 3px solid #3b82f6;
}

.layer-l2 {
  border-top: 3px solid #10b981;
}

.layer-badge-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.layer-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: var(--font-code, monospace);
}

.layer-l0 .layer-tag {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}
.layer-l1 .layer-tag {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}
.layer-l2 .layer-tag {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.layer-scope {
  font-size: 11px;
  color: var(--text-3);
}

.layer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}

.layer-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.55;
  flex: 1;
}

.layer-features {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}

.feat-pill {
  font-size: 10.5px;
  color: var(--text-3);
  background: var(--bg-soft, rgba(125, 125, 125, 0.08));
  padding: 2px 7px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.feat-pill i {
  color: var(--accent, #3b82f6);
}

/* 生命周期步骤流 */
.lifecycle-steps {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

@media (max-width: 900px) {
  .lifecycle-steps {
    flex-direction: column;
  }
  .step-arrow {
    transform: rotate(90deg);
    padding: 6px 0;
  }
}

.step-card {
  flex: 1;
  padding: 14px 16px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, rgba(125, 125, 125, 0.05));
  border: 1px solid var(--mem-line, rgba(125, 125, 125, 0.1));
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}

.step-num {
  font-family: var(--font-code, monospace);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
}

.step-icon {
  font-size: 22px;
  color: var(--accent, #3b82f6);
  margin-bottom: 2px;
}

.step-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}

.step-desc {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.5;
}

.step-arrow {
  color: var(--text-3);
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 思维导图部分 */
.logic-chart-section {
  position: relative;
  height: 720px;
  background: var(--glass-a, var(--panel));
  border: 1px solid var(--glass-bd, var(--line));
  border-radius: var(--r-lg, 12px);
  overflow: hidden;
  box-shadow: var(--glass-shadow, 0 1px 3px rgba(0, 0, 0, 0.05));
}

.mindmap-controls {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--glass-a, var(--panel));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--glass-bd, var(--line));
  padding: 4px 8px;
  border-radius: var(--r-md, 8px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.ctrl-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  transition: all 0.15s;
}

.ctrl-btn:hover {
  background: var(--bg-hover, rgba(125, 125, 125, 0.12));
  color: var(--text);
}

.ctrl-zoom-text {
  font-family: var(--font-code, monospace);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  min-width: 42px;
  text-align: center;
}

.ctrl-divider {
  width: 1px;
  height: 16px;
  background: var(--line);
  margin: 0 2px;
}

.mindmap-viewport {
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.mindmap-viewport.is-dragging {
  cursor: grabbing;
}

.mindmap-canvas {
  transition: transform 0.05s ease-out;
  padding: 60px;
}

/* 树状拓扑排版 */
.mindmap-tree {
  display: flex;
  align-items: center;
  gap: 60px;
}

.mm-root {
  background: linear-gradient(135deg, var(--accent, #3b82f6), #1d4ed8);
  color: #fff !important;
  border: 2px solid rgba(255, 255, 255, 0.25);
  box-shadow: 0 8px 24px rgba(59, 130, 246, 0.35);
  padding: 18px 24px;
  border-radius: 14px;
  min-width: 200px;
  text-align: center;
}

.mm-root .mm-node-title {
  color: #fff;
  font-size: 16px;
  font-weight: 700;
}

.mm-root .mm-node-sub {
  color: rgba(255, 255, 255, 0.85);
  font-size: 11.5px;
  margin-top: 4px;
}

.mm-root .mm-icon {
  font-size: 28px;
  margin-bottom: 6px;
  display: inline-block;
}

.mm-branches {
  display: flex;
  flex-direction: column;
  gap: 20px;
  position: relative;
}

.mm-branches::before {
  content: "";
  position: absolute;
  top: 30px;
  bottom: 30px;
  left: -30px;
  width: 2px;
  background: var(--mem-line, rgba(125, 125, 125, 0.25));
}

.mm-branch {
  display: flex;
  align-items: center;
  gap: 36px;
  position: relative;
}

.mm-branch::before {
  content: "";
  position: absolute;
  left: -30px;
  top: 50%;
  width: 30px;
  height: 2px;
  background: var(--mem-line, rgba(125, 125, 125, 0.25));
}

.mm-node {
  border-radius: var(--r-md, 10px);
  background: var(--glass-a, var(--panel));
  border: 1px solid var(--glass-bd, var(--line));
  box-shadow: var(--glass-shadow, 0 2px 8px rgba(0, 0, 0, 0.05));
  transition: all 0.2s var(--ease);
}

.mm-node:hover {
  transform: translateX(2px);
  border-color: var(--accent, #3b82f6);
}

.mm-level1 {
  padding: 12px 18px;
  min-width: 190px;
  border-left: 4px solid var(--accent, #3b82f6);
}

.branch-ingest .mm-level1 { border-left-color: #06b6d4; }
.branch-layers .mm-level1 { border-left-color: #f59e0b; }
.branch-pipeline .mm-level1 { border-left-color: #8b5cf6; }
.branch-search .mm-level1 { border-left-color: #3b82f6; }
.branch-sync .mm-level1 { border-left-color: #10b981; }

.mm-level1 .mm-node-title {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}

.mm-level1 .mm-node-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}

.mm-children {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
}

.mm-children::before {
  content: "";
  position: absolute;
  top: 16px;
  bottom: 16px;
  left: -18px;
  width: 2px;
  background: var(--mem-line, rgba(125, 125, 125, 0.2));
}

.mm-leaf {
  padding: 8px 14px;
  min-width: 220px;
  background: var(--bg-soft, rgba(125, 125, 125, 0.06));
  position: relative;
}

.mm-leaf::before {
  content: "";
  position: absolute;
  left: -18px;
  top: 50%;
  width: 18px;
  height: 2px;
  background: var(--mem-line, rgba(125, 125, 125, 0.2));
}

.mm-leaf-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.mm-leaf-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
</style>
