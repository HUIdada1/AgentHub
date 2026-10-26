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
<!-- 记忆中枢 · 首启新手引导卡片：仅在记忆总数 0 时显示，降低初次使用认知门槛。
     三步都「就地办完」：第 1 步直接在卡内注入（不再跳页让用户自己找按钮）、
     第 2 步显示真实调用进度、第 3 步跳过去自动弹新建表单。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import type { MemoryAgentCard } from "../../types";

const app = useAppStore();
const mem = useMemoryStore();

const agents = ref<MemoryAgentCard[]>([]);
const injecting = ref("");
const loadError = ref("");

const injectable = computed(() => {
  const pending = agents.value.filter((a) => !a.injected);
  return { pending, done: agents.value.length > 0 && pending.length === 0 };
});

/** 第 2 步的反馈位：已注入几个、真实调用过几个（数据源是心跳表，事件驱动自动更新） */
const callState = computed(() => {
  const injected = agents.value.filter((a) => a.injected).length;
  const verified = mem.beats.filter((b) => b.last_call).length;
  return { injected, verified };
});

async function loadAgents() {
  try {
    const r = await api.memoryAgentsList();
    agents.value = r.agents || [];
    loadError.value = "";
  } catch (e) {
    loadError.value = (e as Error).message || "读取 Agent 列表失败";
  }
}

/** 就地注入：写该 Agent 的配置文件（写前自动备份）——知情在前，仍是一键 */
async function inject(a: MemoryAgentCard) {
  if (injecting.value) return;
  injecting.value = a.id;
  try {
    const r = await api.memoryAgentInject(a.id);
    if (r && r.ok === false) throw new Error(r.message || "注入失败");
    ElMessage.success(`已为 ${a.name} 注入记忆工具（配置文件写前已自动备份）`);
    await loadAgents();
  } catch (e) {
    ElMessage.error((e as Error).message || "注入失败");
  } finally {
    injecting.value = "";
  }
}

function gotoBrowse() {
  // create 落点：浏览页消费到它时自动弹出新建表单，引导点过去即是目标状态
  mem.browseViewHint = "create";
  app.setPage("browse");
}

/** 「Agent 接入」已并入「接入与迁移」页：引导第 1 步在卡内就地注入，这里只作深度管理入口 */
function gotoHub() {
  app.hubSubHint = "agents";
  app.setPage("hub");
}

onMounted(loadAgents);
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
        <div class="fr-num" :class="{ 'fr-done': injectable.done }">{{ injectable.done ? "✓" : "1" }}</div>
        <div class="fr-content">
          <div class="fr-step-title">注入 Agent 记忆工具</div>
          <div class="fr-step-desc">为您的 Trae/Cursor/Claude 等注入 MCP 记忆能力——直接点即可，会修改对应 Agent 的配置文件（写前自动备份）。</div>
          <div v-if="loadError" class="mem-hint" style="margin-top: 6px; color: var(--warn, #d97706)">{{ loadError }} <button class="btn-link" @click="loadAgents">重试</button></div>
          <div v-else-if="!agents.length" class="mem-hint" style="margin-top: 6px">正在探测本机可接入的 Agent…</div>
          <div v-else-if="injectable.done" class="mem-hint" style="margin-top: 6px">已全部注入 ✓ <button class="btn-link" @click="gotoHub">去「接入与迁移」管理</button></div>
          <div v-else class="fr-agent-list">
            <span v-for="a in injectable.pending.slice(0, 4)" :key="a.id" class="fr-agent-row">
              <span>{{ a.name }}</span>
              <button class="btn btn-cta" style="font-size: 11px; padding: 2px 8px" :disabled="injecting === a.id" @click="inject(a)">
                {{ injecting === a.id ? "注入中…" : "注入" }}
              </button>
            </span>
            <span v-if="injectable.pending.length > 4" class="mem-hint">等 {{ injectable.pending.length - 4 }} 个去 <button class="btn-link" @click="gotoHub">「接入与迁移」</button></span>
          </div>
        </div>
      </div>

      <div class="fr-step">
        <div class="fr-num">2</div>
        <div class="fr-content">
          <div class="fr-step-title">对话自动沉淀记忆</div>
          <div class="fr-step-desc">平时正常与 AI 交流，提到技术决策或偏好时，Agent 会自动调用 <code>memory_write</code> 写入仓库。</div>
          <div v-if="callState.injected" class="mem-hint" style="margin-top: 6px">
            {{ callState.verified ? `已注入 ${callState.injected} 个 · 真实调用过 ${callState.verified} 个 ✓` : `已注入 ${callState.injected} 个 · 等 Agent 首次调用（当前 0 次）` }}
          </div>
        </div>
      </div>

      <div class="fr-step">
        <div class="fr-num">3</div>
        <div class="fr-content">
          <div class="fr-step-title">随时检索、修改与裁决</div>
          <div class="fr-step-desc">回到本控制台，随时浏览查看、就地编辑修改，AI 发现记忆冲突时会提议供您点头确认。</div>
          <!-- create 落点：跳过去自动弹出新建表单，不再「点开却没反应」 -->
          <button class="btn btn-ghost" style="margin-top: 8px; font-size: 11.5px; padding: 3px 10px" @click="gotoBrowse">
            去写第一条记忆 →
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
.fr-num.fr-done {
  background: var(--ok, #22c55e);
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
.fr-agent-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.fr-agent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-2);
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 8px);
}
</style>
