<!-- 反代网关 · 模型目录：全渠道合并视图 + 启停 / per-model 渠道覆盖 / 回退模型 / WB 官方目录同步
     管理态存框架整体配置（disabledModels / modelOverrides / modelFallback），保存即热生效（服务端每请求读盘） -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelId, ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";
import { channelName } from "./format";

const app = useAppStore();
const models = ref<ProxyModel[]>([]);
const err = ref("");
const msg = ref("");
const syncing = ref("");
const filter = ref("");

// 渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
const CHANNEL_OPTIONS = computed<{ value: "" | ProxyChannelId; label: string }[]>(() => [
  { value: "", label: "自动（打分）" },
  ...channels.value.map((c) => ({ value: c.id as ProxyChannelId, label: c.display })),
]);

const rows = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  return models.value.filter((m) => !kw || m.id.toLowerCase().includes(kw));
});

/** 回退模型候选：除自身外的启用模型 */
function fallbackCandidates(self: ProxyModel) {
  return models.value.filter((m) => m.id !== self.id);
}

async function refresh() {
  try {
    models.value = await api.proxyModels();
    channels.value = await api.proxyPool().catch(() => channels.value);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

/** 管理态写回整体配置（save 即热生效；保存后重拉对齐服务端口径） */
async function persist(successMsg: string) {
  const r = await app.save();
  if (r && r.ok === false) {
    err.value = r.message || "保存失败";
    return;
  }
  msg.value = successMsg;
  setTimeout(() => (msg.value = ""), 2000);
}

async function toggleEnabled(m: ProxyModel) {
  const list = new Set(app.config.proxy.disabledModels || []);
  if (m.enabled) list.add(m.id);
  else list.delete(m.id);
  app.config.proxy.disabledModels = [...list];
  await persist(m.enabled ? `已禁用 ${m.id}` : `已启用 ${m.id}`);
  await refresh();
}

async function setOverride(m: ProxyModel, v: string) {
  const ov = { ...(app.config.proxy.modelOverrides || {}) };
  if (v) ov[m.id] = v as ProxyChannelId;
  else delete ov[m.id];
  app.config.proxy.modelOverrides = ov;
  await persist(v ? `${m.id} → 固定走 ${channelName(v)}` : `${m.id} 恢复自动路由`);
  await refresh();
}

async function setFallback(m: ProxyModel, v: string) {
  const fb = { ...(app.config.proxy.modelFallback || {}) };
  if (v) fb[m.id] = v;
  else delete fb[m.id];
  app.config.proxy.modelFallback = fb;
  await persist(v ? `${m.id} 不可用时自动切换 ${v}` : `${m.id} 已移除回退模型`);
  await refresh();
}

async function syncCatalog(channel: ProxyChannelId) {
  if (syncing.value) return;
  syncing.value = channel;
  try {
    const r = await api.proxyModelsSync(channel);
    if (r && (r as { ok?: boolean }).ok === false) err.value = (r as { message?: string }).message || "同步失败";
    else {
      msg.value = `已同步 ${r.count ?? 0} 个模型到 ${channelName(channel)}目录`;
      setTimeout(() => (msg.value = ""), 2500);
    }
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    syncing.value = "";
    await refresh();
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">模型目录</div>
        <div class="page-sub">全渠道合并视图 · 启停 · 渠道覆盖 · 回退模型（多模型自动切换）</div>
      </div>
      <div class="page-actions">
        <span v-if="msg" class="tag tag-ok">{{ msg }}</span>
        <input v-model="filter" class="input" style="width: 160px" placeholder="搜索模型" />
        <button class="btn" :disabled="!!syncing" @click="syncCatalog('workbuddy')">
          {{ syncing === "workbuddy" ? "同步中…" : "同步 WB 目录" }}
        </button>
        <button class="btn" :disabled="!!syncing" @click="syncCatalog('workbuddy_ai')">
          {{ syncing === "workbuddy_ai" ? "同步中…" : "同步 WB AI 目录" }}
        </button>
      </div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="card">
        <div class="card-title">
          合并模型目录
          <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr><th>模型</th><th>来源渠道</th><th>状态</th><th>渠道覆盖</th><th>回退模型（不可用时自动切换）</th><th>操作</th></tr>
              <tr v-for="m in rows" :key="m.id">
                <td class="mono">{{ m.id }}</td>
                <td>
                  <span v-for="s in m.sources" :key="s" class="tag tag-dim" style="margin-right: 4px">{{ channelName(s) }}</span>
                </td>
                <td><span class="tag" :class="m.enabled ? 'tag-ok' : 'tag-dim'">{{ m.enabled ? "启用" : "已禁用" }}</span></td>
                <td>
                  <select
                    class="select"
                    :value="m.override"
                    :disabled="!m.enabled || m.sources.length === 1"
                    :title="m.sources.length === 1 ? '单源模型强制走所属渠道，无需覆盖' : ''"
                    @change="setOverride(m, ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="o in CHANNEL_OPTIONS.filter((o) => !o.value || m.sources.includes(o.value as ProxyChannelId))" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </option>
                  </select>
                </td>
                <td>
                  <select class="select" :value="m.fallback" :disabled="!m.enabled" @change="setFallback(m, ($event.target as HTMLSelectElement).value)">
                    <option value="">无</option>
                    <option v-for="c in fallbackCandidates(m)" :key="c.id" :value="c.id">{{ c.id }}</option>
                  </select>
                </td>
                <td>
                  <button class="btn-link btn-sm" @click="toggleEnabled(m)">{{ m.enabled ? "禁用" : "启用" }}</button>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="6" style="text-align: center; color: var(--text-3); padding: 18px">
                  无匹配模型 —— 模型来自 rules/model_map.json（Trae）与 rules/wb_models.json（WB 双区），可点右上角从官方目录同步
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">路由与切换规则</div>
        <div class="code">模型仅存在于单渠道 → 强制走该渠道；多源重叠 → per-model 覆盖优先，否则按路由策略打分；
模型未知或号池耗尽 → 按「回退模型」自动切换（客户端无感，响应模型字段保持请求值）；
回退命中会在用量明细的备注列标记 fallback→实际模型。</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
</style>
