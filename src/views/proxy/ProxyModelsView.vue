<!-- 反代网关 · 模型目录：渠道 tab（全部/各渠道）+ 官方目录拉取 + 启停开关 / 渠道覆盖 / 倍率与能力 / 自定义模型映射
     管理态存框架整体配置（disabledModels / modelOverrides / modelAliases），保存即热生效（服务端每请求读盘） -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelId, ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";
import { capabilityTags, channelName, fmtRate } from "./format";

const app = useAppStore();
const models = ref<ProxyModel[]>([]);
const err = ref("");
const msg = ref("");
const syncing = ref("");
const filter = ref("");
const activeTab = ref(""); // "" = 全部

// 渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
const CHANNEL_OPTIONS = computed<{ value: "" | ProxyChannelId; label: string }[]>(() => [
  { value: "", label: "自动（打分）" },
  ...channels.value.map((c) => ({ value: c.id as ProxyChannelId, label: c.display })),
]);

const tabChannels = computed(() => channels.value.filter((c) => models.value.some((m) => m.sources.includes(c.id as ProxyChannelId))));

const rows = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  return models.value.filter((m) => {
    if (activeTab.value && !m.sources.includes(activeTab.value as ProxyChannelId)) return false;
    if (!kw) return true;
    return m.id.toLowerCase().includes(kw) || String(m.name || "").toLowerCase().includes(kw);
  });
});

// ===== 模型映射（别名）管理 =====
const aliasName = ref("");
const aliasTarget = ref("");
const aliases = computed<[string, string][]>(() => Object.entries(app.config.proxy.modelAliases || {}));

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

/** 启停开关：默认开；关闭即写入 disabledModels 落盘（软件记录，重启保持） */
async function toggleEnabled(m: ProxyModel, v: string | number | boolean) {
  const on = !!v;
  const list = new Set(app.config.proxy.disabledModels || []);
  if (on) list.delete(m.id);
  else list.add(m.id);
  app.config.proxy.disabledModels = [...list];
  await persist(on ? `已启用 ${m.id}` : `已禁用 ${m.id}`);
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

async function addAlias() {
  const from = aliasName.value.trim();
  const to = aliasTarget.value;
  if (!from || !to) return;
  if (from === to) {
    err.value = "别名与目标模型不能相同";
    return;
  }
  const al = { ...(app.config.proxy.modelAliases || {}) };
  al[from] = to;
  app.config.proxy.modelAliases = al;
  aliasName.value = "";
  aliasTarget.value = "";
  await persist(`映射 ${from} → ${to} 已生效`);
}

async function removeAlias(from: string) {
  const al = { ...(app.config.proxy.modelAliases || {}) };
  delete al[from];
  app.config.proxy.modelAliases = al;
  await persist(`已移除映射 ${from}`);
}

/** 拉取官方模型目录（云端接口，用号池账号 token，不依赖本地软件）：写回 rules/catalog.json 热生效 */
async function syncCatalog(channel: string) {
  if (syncing.value) return;
  syncing.value = channel;
  try {
    const r = await api.proxyModelsSync(channel);
    if (r && r.ok === false) err.value = r.message || "拉取失败";
    else {
      const rateInfo = r.withRate ? `，其中 ${r.withRate} 个含倍率` : "";
      msg.value = `已拉取 ${r.count ?? 0} 个模型到 ${channelName(channel)}目录${rateInfo}`;
      setTimeout(() => (msg.value = ""), 3000);
    }
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    syncing.value = "";
    await refresh();
  }
}

/** 全部渠道并发拉取：逐渠道汇总结果，部分失败不拖垮整体 */
async function syncAll() {
  if (syncing.value) return;
  syncing.value = "__all__";
  try {
    const results = await Promise.all(channels.value.map((c) => api.proxyModelsSync(c.id).catch((e) => ({ ok: false as const, message: String((e as Error).message || e) }))));
    const okParts: string[] = [];
    const failParts: string[] = [];
    results.forEach((r, i) => {
      const name = channelName(channels.value[i].id);
      if (r && r.ok !== false) okParts.push(`${name} ${r.count ?? 0} 个`);
      else failParts.push(`${name}：${(r && r.message) || "失败"}`);
    });
    if (okParts.length) {
      msg.value = `已拉取 ${okParts.join("、")}`;
      setTimeout(() => (msg.value = ""), 3000);
    }
    if (failParts.length) err.value = failParts.join("；");
  } finally {
    syncing.value = "";
    await refresh();
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <!-- 页头工具条：渠道分段选择器在左、搜索与官方目录拉取在右，一条 30px 控件线对齐；
           拉取反馈用浮层贴在工具条下缘，出现/消失不挤动布局 -->
      <div class="models-head">
        <div class="seg">
          <button class="seg-item" :class="{ active: !activeTab }" @click="activeTab = ''">全部</button>
          <button
            v-for="c in tabChannels"
            :key="c.id"
            class="seg-item"
            :class="{ active: activeTab === c.id }"
            @click="activeTab = c.id"
          >
            {{ c.display }}
          </button>
        </div>
        <span class="head-tools">
          <label class="search-box">
            <i class="ph ph-magnifying-glass"></i>
            <input v-model="filter" class="search-input" placeholder="搜索模型" spellcheck="false" />
            <button v-if="filter" class="search-clear" title="清空搜索" @click.prevent="filter = ''"><i class="ph ph-x"></i></button>
          </label>
          <button v-if="activeTab" class="btn btn-cta" :disabled="!!syncing" @click="syncCatalog(activeTab)">
            <i class="ph ph-cloud-arrow-down"></i>{{ syncing === activeTab ? "拉取中…" : "拉取模型" }}
          </button>
          <button v-else class="btn btn-cta" :disabled="!!syncing" @click="syncAll">
            <i class="ph ph-cloud-arrow-down"></i>{{ syncing === "__all__" ? "拉取中…" : "全部拉取" }}
          </button>
        </span>
        <Transition name="headmsg">
          <span v-if="msg" class="head-msg tag tag-ok">{{ msg }}</span>
        </Transition>
      </div>
      <div class="card">
        <div class="card-title">
          {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
          <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr>
                <th>模型</th>
                <th>倍率</th>
                <th>能力</th>
                <th v-if="!activeTab">来源渠道</th>
                <th>渠道覆盖</th>
                <th>状态</th>
              </tr>
              <tr v-for="m in rows" :key="m.id">
                <td>
                  <div class="mono">{{ m.id }}</div>
                  <div v-if="m.name && m.name !== m.id" class="model-name">{{ m.name }}</div>
                </td>
                <td class="mono">{{ fmtRate(m.rate) }}</td>
                <td>
                  <span v-for="t in capabilityTags(m)" :key="t" class="tag tag-dim" style="margin-right: 4px">{{ t }}</span>
                  <span v-if="!capabilityTags(m).length" style="color: var(--text-3)">—</span>
                </td>
                <td v-if="!activeTab">
                  <span v-for="s in m.sources" :key="s" class="tag tag-dim" style="margin-right: 4px">{{ channelName(s) }}</span>
                </td>
                <td>
                  <el-select
                    :model-value="m.override"
                    :disabled="!m.enabled || m.sources.length === 1"
                    :title="m.sources.length === 1 ? '单源模型强制走所属渠道，无需覆盖' : ''"
                    popper-class="glass-popper"
                    size="small"
                    style="width: 132px"
                    @change="setOverride(m, $event)"
                  >
                    <el-option
                      v-for="o in CHANNEL_OPTIONS.filter((o) => !o.value || m.sources.includes(o.value as ProxyChannelId))"
                      :key="o.value"
                      :value="o.value"
                      :label="o.label"
                    />
                  </el-select>
                </td>
                <td>
                  <el-switch :model-value="m.enabled" @change="toggleEnabled(m, $event)" />
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td :colspan="activeTab ? 5 : 6" style="text-align: center; color: var(--text-3); padding: 18px">
                  无匹配模型 —— 点上方「拉取模型」从官方目录云端同步（用号池账号 token，不依赖本地软件）
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <!-- 自定义模型映射：客户端请求别名 → 实际模型，响应 model 字段保持请求值（客户端无感） -->
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          自定义模型映射
          <span class="right">客户端请求别名 → 实际模型 · 响应模型字段保持请求值</span>
        </div>
        <div class="alias-form">
          <input v-model="aliasName" class="input" style="width: 220px" placeholder="别名（如 gpt-4o）" />
          <span class="alias-arrow">→</span>
          <el-select v-model="aliasTarget" popper-class="glass-popper" size="default" filterable style="width: 260px" placeholder="目标模型">
            <el-option v-for="m in models" :key="m.id" :value="m.id" :label="m.id" />
          </el-select>
          <button class="btn" :disabled="!aliasName.trim() || !aliasTarget" @click="addAlias">添加映射</button>
        </div>
        <div v-if="aliases.length" class="alias-list">
          <span v-for="[from, to] in aliases" :key="from" class="tag tag-dim alias-item">
            <span class="mono">{{ from }}</span> → <span class="mono">{{ to }}</span>
            <button class="alias-del" title="移除映射" @click="removeAlias(from)">×</button>
          </span>
        </div>
        <div v-else class="set-desc" style="margin-top: 8px; color: var(--text-3)">
          暂无映射 —— 例如把 gpt-4o 映射到 kimi-k3，客户端按 gpt-4o 请求即自动走 kimi-k3
        </div>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">路由与切换规则</div>
        <div class="code">模型仅存在于单渠道 → 强制走该渠道；多源重叠 → per-model 覆盖优先，否则按路由策略打分；
自定义模型映射 → 请求入口先把别名解析为实际模型再路由（响应模型字段保持请求值）；
模型未知或号池耗尽 → 按配置页「不可用时自动切换模型」统一设置切到全局回退模型（客户端无感）；
模型级限流（6004）/ 该号不支持（11102）→ 只冷却「账号×模型」组合，切模型即豁免；
切换命中会在用量明细的备注列标记 alias→实际模型 / fallback→实际模型。</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ===== 页头工具条：分段选择器 + 搜索 + 拉取，一条 30px 控件线；反馈消息浮层不占布局 ===== */
.models-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 渠道分段选择器：容器框住选项，选中项点亮（与号池弹窗的方式切换同一语言）；
   容器 padding 3px + 内项 22px + 边框 = 30px，与右侧 .btn / 搜索框同高成一条线 */
.seg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.seg-item {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: calc(var(--r-sm) - 3px);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.2s;
}
.seg-item:hover {
  color: var(--text);
}
.seg-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
  box-shadow: 0 0 10px -6px var(--accent-line);
}
.seg-item:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}
/* 搜索框：图标 + 无框输入 + 快捷清空；聚焦时整框点亮主色并给图标染色 */
.search-box {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 210px;
  height: var(--ctl-h);
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-box:focus-within {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.search-box > .ph {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-3);
  transition: color 0.2s;
}
.search-box:focus-within > .ph {
  color: var(--accent-strong);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  font-family: var(--font-ui);
}
.search-input::placeholder {
  color: var(--text-3);
}
.search-clear {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.search-clear:hover {
  color: var(--text);
  background: var(--line);
}
/* 拉取按钮里的云下载图标与文字同高（.btn 自带 6px 图文间距） */
.head-tools .btn .ph {
  font-size: 13px;
}
/* 拉取反馈：浮在工具条下缘，进出均不挤动任何布局 */
.head-msg {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 6;
  max-width: min(560px, 82%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.6);
}
.headmsg-enter-active,
.headmsg-leave-active {
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
}
.headmsg-enter-from,
.headmsg-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .headmsg-enter-active,
  .headmsg-leave-active {
    transition: none;
  }
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.model-name {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.alias-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.alias-arrow {
  color: var(--text-3);
}
.alias-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.alias-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.alias-del {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.alias-del:hover {
  color: var(--err, #e05555);
}
</style>
