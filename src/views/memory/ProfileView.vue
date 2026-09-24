<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 深层画像：画像卡组（证据链可展开）+ 生成区 + 待确认失效队列 + 版本历史 + 手动补充 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";
import { formatInteger, timeAgo } from "../../composables/useFormat";
import MemHelp from "../../components/memory/MemHelp.vue";

const app = useAppStore();
const mem = useMemoryStore();
const active = computed(() => app.activeModule === "memory" && app.activePage === "profile");

const SECTION_META: Record<string, { title: string; icon: string; field: string }> = {
  persona: { title: "人格特质", icon: "🧠", field: "结论" },
  preferences: { title: "沟通偏好", icon: "💬", field: "偏好" },
  tech: { title: "技术偏好", icon: "⚙️", field: "偏好" },
  habits: { title: "工作习惯", icon: "🔄", field: "习惯" },
};

type Section = { name: string; path: string; text: string; exists: boolean };
const sections = ref<Section[]>([]);
const history = ref<{ name: string; mtime: number }[]>([]);
const supersedeQueue = ref<{ id: string; payload: { oldId: string; newId?: string; confidence: number; reason: string; oldTitle?: string; newTitle?: string; project?: string } }[]>([]);
const generating = ref(false);
const lastAt = ref(0);
const editing = ref<string>("");
const draft = ref("");

const parsed = computed(() => {
  const out: Record<string, { text: string; evidence: string[] }[]> = {};
  for (const s of sections.value) {
    const items: { text: string; evidence: string[] }[] = [];
    const lines = String(s.text || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("- ")) {
        const text = line.slice(2).trim();
        const next = (lines[i + 1] || "").trim();
        const evidence = next.startsWith("证据") ? (next.split("：")[1] || "").split(/[,，]\s*/).filter(Boolean) : [];
        if (!text.startsWith("<!--")) items.push({ text, evidence });
      }
    }
    out[s.name] = items;
  }
  return out;
});

async function refresh() {
  await mem.loadAll();
  try {
    const r = await api.memoryProfileGet();
    sections.value = r.sections;
    history.value = r.history;
    lastAt.value = r.lastAt;
  } catch (e) {
    ElMessage.error((e as Error).message || "读取画像失败");
  }
  try {
    const q = await api.memoryReviewList("supersede");
    supersedeQueue.value = q.items as unknown as typeof supersedeQueue.value;
  } catch {
    /* 忽略 */
  }
}

async function generate() {
  generating.value = true;
  try {
    const r = await api.memoryProfileGenerate();
    ElMessage.success(r.detail || "画像已更新");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "生成失败：先在「模型与网关」配置可用模型");
  } finally {
    generating.value = false;
  }
}

async function resolveSupersede(id: string, action: "confirm" | "dismiss" | "merge") {
  try {
    await api.memoryReviewResolve(id, action);
    ElMessage.success(action === "confirm" ? "已标记旧事实失效" : action === "merge" ? "已合并两条" : "已判定为并非矛盾");
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "处理失败");
  }
}

function startEdit(name: string) {
  editing.value = name;
  draft.value = sections.value.find((s) => s.name === name)?.text || "";
}

async function saveEdit() {
  try {
    await api.memoryProfileSave(editing.value, draft.value);
    ElMessage.success("已保存（手改内容请以 [pinned] 开头，下次生成不会覆盖）");
    editing.value = "";
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function appendPref() {
  try {
    const r = await ElMessageBox.prompt("手写补充（写入 preferences.md，标记 [pinned]，AI 不覆盖）", "手动补充");
    const text = (r.value || "").trim();
    if (!text) return;
    const cur = sections.value.find((s) => s.name === "preferences")?.text || "";
    await api.memoryProfileSave("preferences", `${cur.trimEnd()}\n- [pinned] ${text}\n`);
    ElMessage.success("已追加");
    await refresh();
  } catch (e) {
    if (e instanceof Error) ElMessage.error(e.message || "写入失败");
  }
}

async function rollback(name: string) {
  const list = history.value.filter((h) => h.name.startsWith(`${name}-`));
  if (!list.length) {
    ElMessage.info("该分区没有历史版本");
    return;
  }
  try {
    const r = await ElMessageBox.prompt(
      `可用历史版本（输入序号回滚）：\n${list.slice(0, 10).map((h, i) => `${i + 1}. ${h.name} · ${timeAgo(h.mtime)}`).join("\n")}`,
      `回滚 ${name}`,
      { inputValue: "1" },
    );
    const idx = Number(r.value) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
      ElMessage.warning("序号无效（历史文件在 <仓库>/profile/.history/，也可手动复制覆盖）");
      return;
    }
    ElMessage.info(`请到 ${mem.root}/profile/.history/${list[idx].name} 手动复制覆盖（避免自动改写历史留档）`);
  } catch {
    /* 用户取消 */
  }
}

async function showEvidence(id: string) {
  try {
    const r = await api.memoryGet(id);
    ElMessage.success(`证据原文：${r.memory.title}`);
  } catch {
    ElMessage.warning("该证据记忆已不存在（可能被删除或失效）");
  }
}

onMounted(refresh);
watch(active, (v) => {
  if (v) void refresh();
});
</script>

<template>
  <div class="memory-scope">
    <div class="mem-head">
      <p class="mem-sub">
        AI 蒸馏出的稳定特征，每条结论带证据链；手改内容标 [pinned] 不被覆盖
        <template v-if="lastAt">· 上次处理 {{ timeAgo(lastAt) }}</template>
        <MemHelp text="画像＝跨项目归纳出的「你是谁」：人格特质、沟通偏好、技术偏好、工作习惯。每条结论都必须附它依据的记忆 id（证据链），点证据可回原文，防止模型编造人格。" />
      </p>
      <div class="mem-head-actions">
        <button class="el-button el-button--small el-button--primary" :disabled="generating" @click="generate">
          {{ generating ? "生成中…" : "重新生成画像" }}
        </button>
        <MemHelp text="生成会读素材（L2 深层记忆 + 高重要度记忆）并调用模型，属于花 token 的操作；素材太少时会拒绝生成并提示先积累记忆。旧版本会自动留档到 profile/.history/。" />
        <button class="el-button el-button--small" @click="appendPref">手动补充</button>
        <button class="el-button el-button--small" @click="mem.loadStatus()">刷新状态</button>
      </div>
    </div>

    <div class="mem-grid mem-grid-2">
      <div v-for="s in sections" :key="s.name" class="mem-card">
        <div class="mem-card-title">
          {{ SECTION_META[s.name]?.icon }} {{ SECTION_META[s.name]?.title || s.name }}
          <span class="mem-row" style="gap: 6px">
            <button class="mem-chip click" @click="startEdit(s.name)">✏️ 编辑</button>
            <button class="mem-chip click" @click="rollback(s.name)">↩ 历史位置</button>
            <MemHelp text="编辑：手改后写回该分区的 md 文件；想让它下次生成不被覆盖，就以 [pinned] 开头写一行。历史：查看留档版本并回滚（留档在 profile/.history/）。" />
          </span>
        </div>

        <template v-if="editing === s.name">
          <textarea v-model="draft" class="el-textarea__inner" rows="8"></textarea>
          <div class="mem-row" style="margin-top: 8px">
            <button class="el-button el-button--small el-button--primary" @click="saveEdit">保存</button>
            <button class="el-button el-button--small" @click="editing = ''">取消</button>
          </div>
        </template>

        <template v-else>
          <div v-if="(parsed[s.name] || []).length" class="mem-col">
            <div v-for="(item, i) in parsed[s.name]" :key="i" class="mem-chain-node" style="align-items: flex-start; flex-direction: column; gap: 4px">
              <span>{{ item.text }}</span>
              <span v-if="item.evidence.length" style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center">
                <span class="mem-hint">证据 [{{ item.evidence.length }}]</span>
                <button v-for="e in item.evidence.slice(0, 5)" :key="e" class="mem-chip click" @click="showEvidence(e)">{{ e }}</button>
              </span>
            </div>
          </div>
          <div v-else class="mem-empty">
            还没有内容 —— 点右上「重新生成画像」（需要先配置模型；素材至少
            {{ formatInteger(Number(mem.cfg("deep.personaMinMemories", 30))) }} 条记忆）
          </div>
        </template>
      </div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        待确认失效（双时间轴维护队列）
        <span class="mem-hint">AI 只建议、人工确认；误标失效会静默丢知识</span>
        <MemHelp text="记忆会被推翻（「改用 Vue3」推翻「在用 React」）。AI 找出互相矛盾的一对并给理由，你点「确认失效」后旧的那条会被标记失效、默认不再被检索到，但原文仍在、可随时查看演化链。" />
      </div>
      <div v-if="supersedeQueue.length" class="mem-col" style="gap: 10px">
        <div v-for="q in supersedeQueue" :key="q.id" class="mem-tile">
          <div class="mem-kv">
            <span class="k">旧事实</span>
            <span class="v">{{ q.payload.oldTitle || q.payload.oldId }}（{{ q.payload.oldId }}）</span>
            <span class="k">新事实</span>
            <span class="v">{{ q.payload.newTitle || q.payload.newId || "（仅提示，无对应新条）" }}</span>
            <span class="k">判定理由</span>
            <span class="v">{{ q.payload.reason || "—" }}</span>
            <span class="k">置信度</span>
            <span class="v">{{ q.payload.confidence }}</span>
          </div>
          <div class="mem-tile-foot">
            <button class="el-button el-button--small el-button--primary" @click="resolveSupersede(q.id, 'confirm')">确认失效</button>
            <button class="el-button el-button--small" @click="resolveSupersede(q.id, 'dismiss')">并非矛盾</button>
            <button v-if="q.payload.newId" class="el-button el-button--small" @click="resolveSupersede(q.id, 'merge')">合并两条</button>
          </div>
        </div>
      </div>
      <div v-else class="mem-empty">没有待确认的失效判定</div>
    </div>

    <div class="mem-card">
      <div class="mem-card-title">
        版本历史
        <span class="mem-hint">{{ history.length }} 个历史版本（保存在 profile/.history/，可回滚）</span>
        <MemHelp text="每次重新生成都会把旧画像留档一份，用于对比「我的人格画像这次变了什么」以及出问题时回滚。" />
      </div>
      <div v-if="history.length" class="mem-col" style="gap: 6px; max-height: 220px; overflow: auto">
        <div v-for="h in history.slice(0, 30)" :key="h.name" class="mem-chain-node">
          <span class="mem-mono">{{ h.name }}</span>
          <span style="margin-left: auto; color: var(--text-3)">{{ timeAgo(h.mtime) }}</span>
        </div>
      </div>
      <div v-else class="mem-empty">还没有历史版本</div>
    </div>
  </div>
</template>
