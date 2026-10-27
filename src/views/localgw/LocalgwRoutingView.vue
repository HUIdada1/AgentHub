<!--
  ============================================================
   作者：沐晖
   日期：2026-10-27
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 路由与渠道：策略 / 故障转移 / 渠道启闭 / 连通测试
     渠道列表来自号池（只读）；本期只默认启用「号池已有账号」的渠道（方案决策 1） -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";

const app = useAppStore();
const lgw = useLocalgwStore();
const busyChannel = ref("");
const showExtended = ref(false);

/** 默认启集：号池有账号的渠道（决策 1）；其余收进扩展区。
 *  扩展区数据源：allChannels（号池 channelList 全清单，含无账号渠道；与号池 proxyPool 并集） */
const primaryChannels = computed(() => {
  // 优先 allChannels 里有账号的（与决策 1 默认启集同口径）；
  // fallback 到 channels 视图（号池 proxyPool 行）
  const accMap = new Map(lgw.channels.map((c) => [c.id, c]));
  return lgw.allChannels
    .filter((c) => (accMap.get(c.id)?.accountCount || c.accountCount) > 0)
    .map((c) => {
      const fromPool = accMap.get(c.id);
      return {
        id: c.id,
        display: c.display,
        accountCount: fromPool ? fromPool.accountCount : c.accountCount,
        onlineCount: fromPool ? fromPool.onlineCount : 0,
        totalCredits: fromPool ? fromPool.totalCredits : 0,
      };
    });
});
const extendedChannels = computed(() => {
  const primaryIds = new Set(primaryChannels.value.map((c) => c.id));
  // 从 allChannels 里筛没账号的；同时兼容只有 proxyPool 里没有 allChannels 的兜底
  return lgw.allChannels.filter((c) => !primaryIds.has(c.id));
});

const strategyHint = computed(() => {
  switch (lgw.route?.strategy) {
    case "score": return "按渠道打分排序（余额、成功率、延迟综合），最省心的默认";
    case "smart": return "智能：优先可用渠道，耗尽时自动换";
    case "round-robin": return "轮流使用，摊平各渠道消耗";
    case "fixed": return "固定走指定渠道，不做切换";
    default: return "";
  }
});

/** 写路由配置：失败必须说出来（静默失败会让用户以为已经生效）；
 *  成功不弹提示——单选框/开关本身已随乐观回填变化，再弹一次反而吵 */
async function saveRoute(patch: Record<string, unknown>, label: string) {
  const ok = await lgw.patchRoute(patch as never);
  if (!ok) ElMessage.error(lgw.lastError || `${label}保存失败`);
}

async function setStrategy(v: string) {
  await saveRoute({ strategy: v }, "路由策略");
}
async function setFixed(v: string) {
  await saveRoute({ fixedChannel: v }, "固定渠道");
}
async function toggleFailover(v: boolean) {
  await saveRoute({ enableFailover: v }, "故障转移");
}
async function saveCooldown(field: "cooldownMs" | "cooldownCapMs", v: number) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    ElMessage.warning("冷却时间必须是正数");
    return;
  }
  await saveRoute({ [field]: n }, field === "cooldownMs" ? "基础冷却" : "冷却封顶");
}
async function toggleChannel(id: string, enabled: boolean) {
  const ok = await lgw.toggleChannel(id, enabled);
  if (!ok) ElMessage.error(lgw.lastError || `${id} 切换失败`);
}
async function testChannel(id: string) {
  if (busyChannel.value) return;
  busyChannel.value = id;
  try {
    // 要真打一次上游，可能较久；失败（含通道未接入）都要给出可见反馈
    const r = await localgwApi.channelTest(id);
    if (r && r.ok) {
      ElMessage.success(`${id} 连通正常${r.latencyMs ? ` · ${Math.round(r.latencyMs)} ms` : ""}`);
    } else {
      ElMessage.error(`${id} 连通失败：${r?.message || "未知原因"}`);
    }
  } catch (e) {
    ElMessage.error(`${id} 连通失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busyChannel.value = "";
  }
}
/** 渠道是否在本模块启用（缺省 = 启用，与号池 channelEnabled 同语义） */
function isOn(id: string) {
  const v = lgw.route?.perChannel?.[id];
  return !v || v.enabled !== false;
}

onMounted(async () => {
  await Promise.all([lgw.refreshRoute(), lgw.refreshChannels(), lgw.refreshStatus()]);
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="lgw-toolbar">
      <span class="lgw-toolbar-title">路由与渠道</span>
      <span class="lgw-kpi-sub">
        {{ primaryChannels.length }} 个可用渠道 · {{ extendedChannels.length }} 个待接入
      </span>
    </div>

    <!-- 错误横幅：加载/保存失败时把原因显式说出来 -->
    <div v-if="lgw.lastError" class="lgw-inline-err">
      <i class="ph ph-warning-circle"></i>
      <span>{{ lgw.lastError }}</span>
      <el-button size="small" text @click="lgw.clearError()">知道了</el-button>
    </div>

    <div v-if="!lgw.backendReady" class="lgw-backend-off">
      <i class="ph ph-link-break lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入</div>
      <div class="lgw-backend-off-desc">渠道路由配置需要主进程 localgw IPC 通道。</div>
    </div>

    <template v-else>
      <!-- 路由策略 -->
      <div class="lgw-section">
        <div class="lgw-section-title">路由策略</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <el-radio-group :model-value="lgw.route?.strategy || 'score'" size="small" @change="(v: any) => setStrategy(String(v))">
            <el-radio-button value="score">打分</el-radio-button>
            <el-radio-button value="smart">智能</el-radio-button>
            <el-radio-button value="round-robin">轮询</el-radio-button>
            <el-radio-button value="fixed">固定</el-radio-button>
          </el-radio-group>
          <div class="lgw-kpi-sub">{{ strategyHint }}</div>

          <div v-if="lgw.route?.strategy === 'fixed'" class="lgw-field">
            <span class="lgw-field-label">固定渠道</span>
            <el-select
              :model-value="lgw.route?.fixedChannel || ''"
              size="small"
              placeholder="选择一个渠道"
              style="width:220px"
              @change="setFixed"
            >
              <el-option v-for="c in primaryChannels" :key="c.id" :label="c.display" :value="c.id" />
            </el-select>
          </div>

          <el-divider style="margin:6px 0" />

          <div class="lgw-field">
            <span class="lgw-field-label">自动故障转移</span>
            <el-switch
              :model-value="lgw.route?.enableFailover !== false"
              size="small"
              @change="(v: any) => toggleFailover(v)"
            />
            <span class="lgw-kpi-sub">渠道失败时自动换下一个，建议开启</span>
          </div>
          <div class="lgw-field">
            <span class="lgw-field-label">基础冷却</span>
            <el-input-number
              :model-value="Math.round((lgw.route?.cooldownMs || 120000) / 1000)"
              :min="10"
              :max="3600"
              size="small"
              @change="(v: any) => saveCooldown('cooldownMs', Number(v) * 1000)"
            />
            <span class="lgw-kpi-sub">秒（失败后该渠道静默时长，成功一次自动解除）</span>
          </div>
          <div class="lgw-field">
            <span class="lgw-field-label">冷却封顶</span>
            <el-input-number
              :model-value="Math.round((lgw.route?.cooldownCapMs || 900000) / 60000)"
              :min="1"
              :max="120"
              size="small"
              @change="(v: any) => saveCooldown('cooldownCapMs', Number(v) * 60000)"
            />
            <span class="lgw-kpi-sub">分钟（连续失败时的指数退避上限）</span>
          </div>
        </div>
      </div>

      <!-- 可用渠道 -->
      <div class="lgw-section">
        <div class="lgw-section-title">可用渠道（号池已配置账号）</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div v-for="c in primaryChannels" :key="c.id" class="lgw-channel-row">
            <div class="lgw-channel-icon"><i class="ph ph-plugs-connected"></i></div>
            <div style="flex:1;min-width:0">
              <div class="lgw-channel-name">{{ c.display }}</div>
              <div class="lgw-channel-meta">{{ c.onlineCount }}/{{ c.accountCount }} 在线</div>
            </div>
            <el-button size="small" :loading="busyChannel === c.id" @click="testChannel(c.id)">测试</el-button>
            <el-switch :model-value="isOn(c.id)" size="small" @change="(v: any) => toggleChannel(c.id, v)" />
          </div>
          <div v-if="!primaryChannels.length" style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">
            号池还没有可用账号
            <el-button size="small" text type="primary" @click="app.selectModule('proxy')">去号池管家</el-button>
          </div>
        </div>
      </div>

      <!-- 扩展渠道（折叠） -->
      <div v-if="extendedChannels.length" class="lgw-section">
        <div
          class="lgw-section-title"
          style="cursor:pointer;display:flex;align-items:center;gap:6px"
          @click="showExtended = !showExtended"
        >
          <i class="ph ph-caret-right lgw-caret" :class="{ 'is-open': showExtended }"></i>
          扩展渠道（{{ extendedChannels.length }}）
          <span class="lgw-kpi-sub" style="font-weight:400">号池无账号，启用后需先去添加账号</span>
        </div>
        <div v-if="showExtended" style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          <div v-for="c in extendedChannels" :key="c.id" class="lgw-channel-row" style="opacity:0.7">
            <div class="lgw-channel-icon"><i class="ph ph-plug"></i></div>
            <div style="flex:1;min-width:0">
              <div class="lgw-channel-name">{{ c.display }}</div>
              <div class="lgw-channel-meta">号池暂无账号</div>
            </div>
            <el-button size="small" text type="primary" @click="app.selectModule('proxy')">去添加</el-button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
