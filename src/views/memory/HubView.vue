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
<!-- 记忆中枢 · 接入与迁移（hub）：Agent 接入 / 导入历史 / 多机同步 三段合一。
     迁移是「一台机器的记忆完整搬到另一台」的连贯动作（接上 Agent → 导入历史 → 同步），
     原来分散在三个页签里，靠来回跳转缝合；这里一个页内切换完成。
     三段内容复用原三页组件（visible 控制各段是否处于活动态，避免隐藏段空转 IPC）。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import AgentsView from "./AgentsView.vue";
import ImportView from "./ImportView.vue";
import SyncView from "./SyncView.vue";

const app = useAppStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "hub");

type Sub = "agents" | "import" | "sync";
const sub = ref<Sub>("agents");
const SUB_ORDER: Sub[] = ["agents", "import", "sync"];
const subIndex = computed(() => SUB_ORDER.indexOf(sub.value));
/** 懒挂载 + 保活：首次切到某段才挂载（避免三段 onMounted 并发打 IPC），之后 v-show 保活 */
const mountedSubs = ref<Set<Sub>>(new Set(["agents"]));
watch(sub, (v) => {
  if (!mountedSubs.value.has(v)) mountedSubs.value = new Set(mountedSubs.value).add(v);
});
const SUBS: { id: Sub; label: string; hint: string }[] = [
  { id: "agents", label: "接入 Agent", hint: "给 Trae/Cursor/Claude 等注入记忆能力" },
  { id: "import", label: "导入历史", hint: "把各 Agent 的历史会话导入为记忆" },
  { id: "sync", label: "多机同步", hint: "通过 WebDAV 与其他电脑共用同一份记忆" },
];

/** 从别处（仪表盘 KPI、首启引导、老页签）跳进来时的落点：消费后清空 */
watch(
  () => app.hubSubHint,
  (v) => {
    if (!v) return;
    app.hubSubHint = "";
    if (v === "agents" || v === "import" || v === "sync") sub.value = v;
  },
  { immediate: true },
);
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        把记忆接进你的 Agent、把历史会话导进来、在多台电脑之间同步 —— 都在这一页
      </p>
      <div class="mem-switch is-3" :style="{ '--sw-i': subIndex }" role="tablist">
        <span class="sw-thumb"></span>
        <button
          v-for="s in SUBS"
          :key="s.id"
          class="sw-item"
          :class="{ active: sub === s.id }"
          role="tab"
          :aria-selected="sub === s.id"
          :title="s.hint"
          @click="sub = s.id"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <div class="mem-hint" style="margin: -4px 0 10px">{{ SUBS.find((s) => s.id === sub)?.hint }}</div>

    <!-- 三段各自懒挂载 + 保活（v-show）：切回来不重拉；visible 只让当前段处于活动态 -->
    <AgentsView v-if="mountedSubs.has('agents')" v-show="sub === 'agents'" :visible="active && sub === 'agents'" />
    <ImportView v-if="mountedSubs.has('import')" v-show="sub === 'import'" :visible="active && sub === 'import'" />
    <SyncView v-if="mountedSubs.has('sync')" v-show="sub === 'sync'" :visible="active && sub === 'sync'" />
  </div>
</template>
