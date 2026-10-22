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
<!-- 上游启闭弹窗（渠道级开关）：各渠道图标 + 名称 + 启用开关
     开关 = 该渠道在号池管家中是否启用与可见：关闭后号池管家全部页面动态隐藏该渠道
     （卡片/下拉/调用等一律不存在），重新打开立即恢复。
     数据走 proxy_channel_list（全量含已关闭渠道，带 enabled）；
     切换走 proxy_channel_toggle（后端写 proxy.channelEnabled + 广播 status 事件，各页面事件刷新即动态显隐） -->
<script setup lang="ts">
import { ref, watch } from "vue";
import * as api from "../api/ipc";
import type { ProxyChannelView } from "../types";
import { channelName } from "../views/proxy/format";
// 渠道图标与首字母徽章统一从 channelIcons 取：号池页顶部切换条也用同一份，
// 免得两处各存一张映射表、新渠道只补了一边
import { CHANNEL_ICONS, channelInitial as initial } from "../views/proxy/channelIcons";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

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
                  控制各渠道在号池管家中的启用与可见：关闭后，号池管家的全部页面（总览 / 号池 / 积分日历等）
                  会立即隐藏该渠道，路由与调用、自动签到、额度刷新也不再使用它；重新打开立即恢复。
                </template>
                <i class="up-qa ph ph-question" @click.stop></i>
              </el-tooltip>
            </div>
            <div class="up-sub">关闭的渠道在号池管家全部页面立即隐藏，不再参与余额刷新与签到；重新打开立即恢复</div>
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
              <b v-else>{{ initial(row.id, row.display) }}</b>
            </span>
            <div class="up-info">
              <div class="up-name">{{ row.display || channelName(row.id) }}</div>
              <div class="up-meta">
                {{ row.enabled === false ? "已关闭 —— 号池管家全部页面隐藏该渠道" : row.summary.accountCount ? `${row.summary.onlineCount}/${row.summary.accountCount} 账号可用` : "空号池" }}
              </div>
            </div>
            <button
              class="switch"
              :class="{ on: row.enabled !== false }"
              :disabled="busyId === row.id"
              @click="toggle(row, row.enabled === false)"
            ></button>
          </div>
          <!-- 占位卡：提示后续新渠道会出现在这里（不参与交互） -->
          <div v-if="rows.length" class="up-row up-more">
            <span class="up-more-icon"><i class="ph ph-plus"></i></span>
            <div class="up-info">
              <div class="up-name">更多渠道等待添加</div>
              <div class="up-meta">后续支持的新渠道会出现在这里</div>
            </div>
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
  width: 580px;
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

/* 渠道列表：两列卡片网格（minmax(0,1fr) 防长渠道名把列撑破溢出） */
.up-list {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  max-height: 440px;
  overflow-y: auto;
  padding-right: 2px;
}
.up-list::-webkit-scrollbar {
  width: 4px;
}
.up-empty {
  grid-column: 1 / -1;
  padding: 20px 0;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}
.up-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, 0.04);
}
:root[data-theme="light"] .up-row {
  background: rgba(15, 23, 42, 0.04);
}
/* 占位卡：虚线弱化态，与渠道卡同构但不可交互 */
.up-more {
  border-style: dashed;
  background: transparent;
}
/* 亮色下 :root[data-theme] .up-row 特异性更高，须同特异性覆盖回透明 */
:root[data-theme="light"] .up-more {
  background: transparent;
}
.up-more-icon {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.up-more-icon .ph {
  font-size: 14px;
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
