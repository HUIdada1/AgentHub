<!-- 上游启闭弹窗（渠道级开关）：各渠道图标 + 名称 + 启用开关
     开关 = 该渠道在反代网关中是否启用与可见：关闭后反代网关全部页面动态隐藏该渠道
     （卡片/下拉/调用等一律不存在），重新打开立即恢复。
     数据走 proxy_channel_list（全量含已关闭渠道，带 enabled）；
     切换走 proxy_channel_toggle（后端写 proxy.channelEnabled + 广播 status 事件，各页面事件刷新即动态显隐） -->
<script setup lang="ts">
import { ref, watch } from "vue";
import * as api from "../api/ipc";
import type { ProxyChannelView } from "../types";
import { channelName } from "../views/proxy/format";
import traeIcon from "../assets/channels/trae.png";
import workbuddyIcon from "../assets/channels/workbuddy.png";
import raccoonIcon from "../assets/channels/raccoon.png";
import qoderIcon from "../assets/channels/qoder.png";
import zcodeIcon from "../assets/channels/zcode.png";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

// 渠道图标（取自各客户端安装目录内嵌的同一张图，与系统里显示的为一致；
// 没收录图标的渠道回落首字母徽章）
const CHANNEL_ICONS: Record<string, string> = {
  trae: traeIcon,
  workbuddy: workbuddyIcon,
  workbuddy_ai: workbuddyIcon,
  raccoon: raccoonIcon,
  qoder: qoderIcon,
  qoder_intl: qoderIcon,
  zcode: zcodeIcon,
};
const initial = (id: string) => (channelName(id) || id || "?").trim().slice(0, 1).toUpperCase() || "?";

const rows = ref<ProxyChannelView[]>([]);
const loading = ref(false);
const busyId = ref("");
const err = ref("");

async function load() {
  loading.value = true;
  err.value = "";
  try {
    rows.value = await api.proxyChannelList();
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) load();
  },
  { immediate: true }
);

/** 切换即生效：后端写配置 + 广播事件，各页面重新拉取即动态显隐；
 *  失败回滚开关并报错（乐观更新只做本地一瞬，以 IPC 返回为准） */
async function toggle(row: ProxyChannelView, next: boolean) {
  if (busyId.value) return;
  busyId.value = row.id;
  err.value = "";
  try {
    const r = await api.proxyChannelToggle(row.id, next);
    if (r && r.ok === false) {
      err.value = r.message || "切换失败";
      await load();
      return;
    }
    row.enabled = next;
  } catch (e) {
    err.value = String((e as Error).message || e);
    await load();
  } finally {
    busyId.value = "";
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="p-mask" @click.self="emit('close')">
      <div class="p-dlg glass up-dlg" role="dialog" aria-modal="true" aria-label="上游启闭">
        <!-- 头部：图标 + 标题 + 问号说明 + 关闭 -->
        <header class="up-head">
          <span class="up-head-icon"><i class="ph ph-plugs-connected"></i></span>
          <div class="up-head-text">
            <div class="up-title">
              上游启闭
              <el-tooltip placement="top" :show-after="120" popper-class="glass-popper qa-tip">
                <template #content>
                  控制各渠道在反代网关中的启用与可见：关闭后，反代网关的全部页面（总览 / 号池 / 模型 / Keys / 统计等）
                  会立即隐藏该渠道，路由与调用、自动签到、额度刷新也不再使用它；重新打开立即恢复。
                </template>
                <i class="up-qa ph ph-question" @click.stop></i>
              </el-tooltip>
            </div>
            <div class="up-sub">关闭的渠道在反代网关全部页面立即隐藏，路由与调用不再使用；重新打开立即恢复</div>
          </div>
          <el-tooltip content="关闭" placement="top">
            <button class="up-close" @click="emit('close')"><i class="ph ph-x"></i></button>
          </el-tooltip>
        </header>

        <div v-if="err" class="up-err">{{ err }}</div>

        <!-- 渠道列表：图标 + 名称 + 启用开关 -->
        <div class="up-list">
          <div v-if="loading && !rows.length" class="up-empty">加载中…</div>
          <div v-else-if="!rows.length" class="up-empty">暂无渠道</div>
          <div v-for="row in rows" :key="row.id" class="up-row">
            <span class="up-icon has-icon" :class="{ off: row.enabled === false }">
              <img v-if="CHANNEL_ICONS[row.id]" :src="CHANNEL_ICONS[row.id]" alt="" loading="lazy" />
              <b v-else>{{ initial(row.id) }}</b>
            </span>
            <div class="up-info">
              <div class="up-name">{{ row.display || channelName(row.id) }}</div>
              <div class="up-meta">
                {{ row.enabled === false ? "已关闭 —— 反代网关全部页面隐藏该渠道" : row.summary.accountCount ? `${row.summary.onlineCount}/${row.summary.accountCount} 账号可用` : "空号池" }}
              </div>
            </div>
            <el-tooltip :content="row.enabled === false ? '开启该渠道（立即恢复显示与调用）' : '关闭该渠道（全部页面立即隐藏，路由与调用不再使用）'" placement="top">
              <button
                class="switch"
                :class="{ on: row.enabled !== false }"
                :disabled="busyId === row.id"
                @click="toggle(row, row.enabled === false)"
              ></button>
            </el-tooltip>
          </div>
        </div>

        <footer class="up-foot">
          <span class="up-hint">共 {{ rows.length }} 个渠道 · 已启用 {{ rows.filter((r) => r.enabled !== false).length }} 个</span>
          <button class="btn btn-cta" @click="emit('close')">完成</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.up-dlg {
  width: 440px;
}
/* 头部：图标 + 标题 + 关闭（与号池页 add-dlg 同构） */
.up-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.up-head-icon {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.up-head-icon .ph {
  font-size: 16px;
}
.up-head-text {
  flex: 1;
  min-width: 0;
}
.up-title {
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 问号小图标：悬停出操作说明（弹层走全局 .qa-tip 玻璃样式） */
.up-qa {
  font-size: 12px;
  color: var(--text-3);
  cursor: help;
  transition: color 0.15s;
}
.up-qa:hover {
  color: var(--accent-strong);
}
.up-sub {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
  margin-top: 2px;
}
.up-close {
  flex: none;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: color 0.15s, border-color 0.15s;
}
.up-close:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.up-close .ph {
  font-size: 12px;
}
.up-err {
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--danger, #e05555);
  color: var(--danger, #e05555);
  font-size: 11px;
}

/* 渠道行：图标 + 名称 + 开关 */
.up-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
}
.up-list::-webkit-scrollbar {
  width: 4px;
}
.up-empty {
  padding: 20px 0;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}
.up-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 4px;
}
.up-row + .up-row {
  border-top: 1px solid var(--line);
}
.up-icon {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
}
:root[data-theme="light"] .up-icon {
  background: rgba(15, 23, 42, 0.05);
}
.up-icon img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  display: block;
}
/* 关闭的渠道图标弱化置灰 */
.up-icon.off {
  filter: grayscale(1);
  opacity: 0.45;
}
.up-icon b {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
}
.up-info {
  flex: 1;
  min-width: 0;
}
.up-name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up-meta {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up-row .switch {
  flex: none;
}

/* 底部：计数摘要 + 完成 */
.up-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.up-hint {
  flex: 1;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--text-3);
}
</style>
