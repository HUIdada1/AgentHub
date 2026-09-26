/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 记忆详情抽屉：全文 + 演化链 + 相关记忆 + 路径操作 + 行内编辑。
// 用自绘抽屉而非复用 sync/Drawer（后者只吃 key-value 行，装不下演化链与编辑区）。
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import * as api from "../../api/ipc";
import type { MemoryDetail } from "../../types";
import { formatDateTime, timeAgo } from "../../composables/useFormat";
import { agentLabel } from "./labels";

const props = defineProps<{ show: boolean; id: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "changed"): void;
  (e: "open", id: string): void;
}>();

const memory = ref<MemoryDetail | null>(null);
const related = ref<{ id: string; title: string; summary: string }[]>([]);
const chain = ref<{ id: string; title: string; created: number; validTo?: number | null; supersededBy?: string | null; current: boolean }[]>([]);
const loading = ref(false);
const error = ref("");
const editing = ref(false);
const draft = ref({ title: "", body: "", tags: "", importance: 3 });
const saving = ref(false);

const tagsText = computed(() => (memory.value?.tags || []).join(" · "));

/* 请求序号：在演化链/相关记忆里快速连点时，晚到的旧详情不许覆盖新详情 */
let detailSeq = 0;
watch(
  () => [props.show, props.id] as const,
  async ([show, id]) => {
    if (!show || !id) return;
    const my = ++detailSeq;
    editing.value = false;
    loading.value = true;
    error.value = "";
    try {
      const r = await api.memoryGet(id);
      if (my !== detailSeq) return;
      memory.value = r.memory;
      related.value = r.related || [];
      chain.value = r.timeline || [];
      draft.value = {
        title: r.memory.title,
        body: r.memory.body,
        tags: (r.memory.tags || []).join(", "),
        importance: r.memory.importance,
      };
    } catch (e) {
      if (my !== detailSeq) return;
      error.value = (e as Error).message || "读取失败";
      memory.value = null;
    } finally {
      if (my === detailSeq) loading.value = false;
    }
  },
  { immediate: true },
);

async function save() {
  if (!memory.value) return;
  saving.value = true;
  try {
    await api.memoryUpdate(memory.value.id, {
      title: draft.value.title.trim() || memory.value.title,
      body: draft.value.body,
      tags: draft.value.tags.split(/[,，\s]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean),
      importance: draft.value.importance,
    });
    ElMessage.success("已保存");
    editing.value = false;
    emit("changed");
    // 保存后整份重拉：相关记忆 / 演化链可能因标题/标签变化而重算，只刷新 memory 字段会用旧值
    const r = await api.memoryGet(memory.value.id);
    memory.value = r.memory;
    related.value = r.related || [];
    chain.value = r.timeline || [];
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function toggleFlag(key: "pinned" | "starred") {
  if (!memory.value) return;
  const next = key === "pinned" ? !memory.value.pinned : !memory.value.starred;
  try {
    if (key === "pinned") await api.memoryPin(memory.value.id, next);
    else await api.memoryStar(memory.value.id, next);
    memory.value = { ...memory.value, [key]: next };
    emit("changed");
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function remove() {
  if (!memory.value) return;
  try {
    await ElMessageBox.confirm("删除后进入回收站，可恢复。确认删除这条记忆？", "删除记忆", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.memoryDelete(memory.value.id);
    ElMessage.success("已移入回收站");
    emit("changed");
    emit("close");
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

async function copyPath() {
  if (!memory.value) return;
  const rel = memory.value.anchor ? `${memory.value.path}#${memory.value.anchor}` : memory.value.path;
  try {
    await navigator.clipboard.writeText(rel);
    ElMessage.success("路径已复制");
  } catch {
    ElMessage.warning("复制失败，请手动复制：" + rel);
  }
}

async function openDir() {
  if (!memory.value) return;
  try {
    await api.memoryOpenDir(memory.value.path);
  } catch (e) {
    ElMessage.error((e as Error).message || "打开失败");
  }
}

function jump(id: string) {
  if (!id || id === props.id) return;
  // 交给父级换 id 打开（父级持有 currentId，抽屉自身只负责展示）
  emit("open", id);
}
</script>

<template>
  <Teleport to="body">
    <div class="memory-scope">
      <div class="mem-drawer-mask" :class="{ show }" @click="emit('close')"></div>
      <aside class="mem-drawer" :class="{ show }">
        <div class="mem-drawer-head">
          <div style="min-width: 0">
            <div v-if="editing" style="display: flex; gap: 8px; align-items: center">
              <input v-model="draft.title" class="f-input" style="font-size: 15px" />
            </div>
            <h3 v-else style="margin: 0; font-size: 15px">{{ memory?.title || "记忆详情" }}</h3>
            <div style="display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap">
              <span v-if="memory" class="mem-chip">{{ memory.layer === "l2" ? "深层" : "普通" }}</span>
              <span v-if="memory" class="mem-chip">重要 {{ memory.importance }}</span>
              <span v-if="memory?.pinned" class="mem-chip accent">已置顶</span>
              <span v-if="memory?.starred" class="mem-chip accent">已收藏</span>
              <span v-if="memory?.superseded || memory?.validTo" class="mem-chip warn">已失效</span>
            </div>
          </div>
          <button class="mem-dlg-close" title="关闭" @click="emit('close')">✕</button>
        </div>

        <div class="mem-drawer-body">
          <div v-if="loading" class="mem-empty">正在读取…</div>
          <div v-else-if="error" class="mem-empty">{{ error }}</div>
          <template v-else-if="memory">
            <div class="mem-section">
              <div class="mem-kv">
                <span class="k">项目</span>
                <span class="v">{{ memory.project || "（无项目归属 / 通用 general）" }}</span>
                <span class="k">来源</span>
                <span class="v">{{ agentLabel(memory.agent) }}<template v-if="memory.device"> · {{ memory.device }}</template></span>
                <span class="k">创建</span>
                <span class="v">{{ formatDateTime(memory.created) }}（{{ timeAgo(memory.created) }}）</span>
                <span class="k">有效期</span>
                <span class="v">
                  {{ formatDateTime(memory.created) }} 起 ·
                  {{ memory.validTo ? `失效于 ${formatDateTime(memory.validTo)}` : "至今有效" }}
                </span>
                <span class="k">标签</span>
                <span class="v">{{ tagsText || "—" }}</span>
                <span class="k">路径</span>
                <span class="v">
                  <span class="mem-mono">{{ memory.path }}<template v-if="memory.anchor">#{{ memory.anchor }}</template></span>
                  <button class="mem-chip click" style="margin-left: 6px" @click="copyPath">复制</button>
                  <button class="mem-chip click" @click="openDir">打开所在目录</button>
                </span>
              </div>
            </div>

            <div class="mem-section">
              <div class="s-title">正文</div>
              <template v-if="editing">
                <textarea v-model="draft.body" class="el-textarea__inner" rows="10"></textarea>
                <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap">
                  <span style="font-size: 12px; color: var(--text-3)">标签</span>
                  <input v-model="draft.tags" class="f-input" style="max-width: 240px" placeholder="逗号分隔" />
                  <span style="font-size: 12px; color: var(--text-3)">重要度</span>
                  <input v-model.number="draft.importance" type="number" min="1" max="5" class="f-input" style="width: 72px" />
                </div>
              </template>
              <p v-else class="mem-pre" style="font-family: var(--font-ui); font-size: 12.5px">{{ memory.body || "（正文为空）" }}</p>
            </div>

            <div v-if="chain.length > 1" class="mem-section">
              <div class="s-title">演化链（事实演化史）</div>
              <div class="mem-chain">
                <div v-for="node in chain" :key="node.id" class="mem-chain-node" :class="{ current: node.current }">
                  <span class="mem-dot" :class="node.current ? 'ok' : ''"></span>
                  <span class="n-title" @click="jump(node.id)">{{ node.title }}</span>
                  <span style="margin-left: auto; color: var(--text-3)">{{ formatDateTime(node.created) }}</span>
                  <span class="mem-chip" :class="node.current ? 'accent' : ''">{{ node.current ? "当前" : "已被取代" }}</span>
                </div>
              </div>
            </div>

            <div v-if="related.length" class="mem-section">
              <div class="s-title">相关记忆</div>
              <div v-for="r in related" :key="r.id" class="mem-chain-node">
                <span class="n-title" @click="jump(r.id)">{{ r.title }}</span>
                <span style="color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ r.summary }}</span>
              </div>
            </div>

            <div v-if="memory.supersededBy" class="mem-section">
              <div class="s-title">被谁取代</div>
              <div class="mem-chain-node">
                <span class="n-title" @click="jump(memory.supersededBy)">{{ memory.supersededBy }}</span>
              </div>
            </div>
          </template>
        </div>

        <div class="mem-drawer-foot">
          <template v-if="editing">
            <button class="btn btn-cta" :disabled="saving" @click="save">
              {{ saving ? "保存中…" : "保存" }}
            </button>
            <button class="btn btn-ghost" @click="editing = false">取消</button>
          </template>
          <template v-else>
            <button class="btn btn-ghost" :disabled="!memory" @click="editing = true">编辑</button>
            <button class="btn btn-ghost" :disabled="!memory" @click="toggleFlag('pinned')">
              {{ memory?.pinned ? "取消置顶" : "置顶" }}
            </button>
            <button class="btn btn-ghost" :disabled="!memory" @click="toggleFlag('starred')">
              {{ memory?.starred ? "取消收藏" : "收藏" }}
            </button>
            <button class="btn btn-outline danger" :disabled="!memory" @click="remove">删除（进回收站）</button>
          </template>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
