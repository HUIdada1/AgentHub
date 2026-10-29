<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转載、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 路由与渠道：策略 / 故障转移 / 渠道启闭 / 连通测试
     页面形式照搬旧版反代网关的「网络代理」策略卡（fdb3e55^:src/views/proxy/ProxyNetworkView.vue:406-436
     的 .strategy-card）；渠道表改用与用量统计板块同款的 .table.table-bare + .table-scroll 结构，
     数据源换成现在的 localgw_route_* / localgw_channel_toggle，渠道清单只读复用号池。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";
import { fmtBalance, balanceUnit } from "../proxy/format";

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

/** 策略档位（与后端 routing.cjs 的 strategy 取值一一对应） */
const STRATEGIES = [
  { value: "score", label: "打分", desc: "按渠道打分排序（余额、成功率、延迟综合），最省心的默认" },
  { value: "smart", label: "智能", desc: "优先可用渠道，耗尽时自动换" },
  { value: "round-robin", label: "轮询", desc: "轮流使用，摊平各渠道消耗" },
  { value: "fixed", label: "固定", desc: "固定走指定渠道，不做切换" },
] as const;

const strategyHint = computed(() => STRATEGIES.find((s) => s.value === lgw.route?.strategy)?.desc || STRATEGIES[0].desc);

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

/** 连通测试：后端 routing.cjs 的 testChannel 是**故意收敛承诺**的实现，固定回
 *  {ok:false, message:"..."}（不真打上游）。所以这里必须把它当**中性说明**展示，
 *  不能按「测试失败」渲染成红色错误——否则用户会以为渠道坏了。 */
async function testChannel(id: string) {
  if (busyChannel.value) return;
  busyChannel.value = id;
  try {
    await localgwApi.channelTest(id);
    ElMessage.info(lgw.lastError || `${id}：连通测试能力本期未开放`);
  } catch (e) {
    // 通道未接入 / 后端异常：同样按中性提示处理，别吓用户
    ElMessage.info(`${id}：连通测试能力本期未开放（${e instanceof Error ? e.message : String(e)}）`);
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
  <section class="page">
    <div class="page-body">
      <!-- 错误红卡：加载/保存失败时把原因显式说出来 -->
      <div v-if="lgw.lastError" class="card err-card"><div class="set-desc err-text">{{ lgw.lastError }}</div></div>

      <!-- 后端未接入占位 -->
      <div v-if="!lgw.backendReady" class="card">
        <div class="empty">
          <div class="empty-title">后端通道未接入</div>
          <div class="empty-sub">渠道路由配置需要主进程 localgw IPC 通道，接入后本页自动可用。</div>
        </div>
      </div>

      <template v-else>
        <!-- 路由策略：改完立即落盘，下一次上游请求就按新策略走 -->
        <div class="card strategy-card">
          <div class="strategy-row">
            <div class="s-left">
              <div class="s-title">路由策略</div>
              <div class="s-desc">{{ strategyHint }}</div>
              <div class="s-desc" style="color: var(--text-3)">
                {{ primaryChannels.length }} 个可用渠道 · {{ extendedChannels.length }} 个待接入
              </div>
            </div>
            <div class="strategy-ctl">
              <el-radio-group
                :model-value="lgw.route?.strategy || 'score'"
                @update:model-value="(v: any) => setStrategy(String(v))"
              >
                <el-radio-button v-for="s in STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</el-radio-button>
              </el-radio-group>
              <el-select
                v-if="lgw.route?.strategy === 'fixed'"
                :model-value="lgw.route?.fixedChannel || ''"
                placeholder="选择一个渠道"
                popper-class="glass-popper"
                class="f-el-select fixed-select"
                style="width: 220px"
                @update:model-value="(v: string) => setFixed(v)"
              >
                <el-option v-for="c in primaryChannels" :key="c.id" :label="c.display" :value="c.id" />
              </el-select>
            </div>
          </div>
        </div>

        <!-- 故障转移与冷却：同一策略卡版式，逐项一行 -->
        <div class="card strategy-card">
          <div class="strategy-row">
            <div class="s-left">
              <div class="s-title">故障转移</div>
              <div class="s-desc">渠道失败时自动换下一个，建议开启；关闭后单渠道失败即直接返回错误</div>
            </div>
            <div class="strategy-ctl">
              <el-switch
                :model-value="lgw.route?.enableFailover !== false"
                @update:model-value="(v: any) => toggleFailover(v === true)"
              />
            </div>
          </div>
          <div class="strategy-row">
            <div class="s-left">
              <div class="s-title">基础冷却</div>
              <div class="s-desc">失败后该渠道静默时长（秒），成功一次自动解除</div>
            </div>
            <div class="strategy-ctl">
              <el-input-number
                :model-value="Math.round((lgw.route?.cooldownMs || 120000) / 1000)"
                :min="10"
                :max="3600"
                @update:model-value="(v: any) => saveCooldown('cooldownMs', Number(v) * 1000)"
              />
            </div>
          </div>
          <div class="strategy-row">
            <div class="s-left">
              <div class="s-title">冷却封顶</div>
              <div class="s-desc">连续失败时的指数退避上限（分钟）</div>
            </div>
            <div class="strategy-ctl">
              <el-input-number
                :model-value="Math.round((lgw.route?.cooldownCapMs || 900000) / 60000)"
                :min="1"
                :max="120"
                @update:model-value="(v: any) => saveCooldown('cooldownCapMs', Number(v) * 60000)"
              />
            </div>
          </div>
        </div>

        <!-- 可用渠道：改用用量统计同款表格（.table.table-bare + .table-scroll + thead） -->
        <div class="card">
          <div class="card-title">
            可用渠道
            <span class="right">号池已配置账号 · 只读复用，账号在号池管家维护</span>
          </div>
          <div class="table-scroll">
            <table class="table table-bare tbl-static">
              <thead>
                <tr>
                  <th style="width: 34%">渠道</th>
                  <th style="width: 16%">账号</th>
                  <th style="width: 20%">余额</th>
                  <th style="width: 14%">状态</th>
                  <th style="width: 16%">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in primaryChannels" :key="c.id">
                  <td>
                    <div class="np-name">{{ c.display }}</div>
                    <div class="np-meta">{{ c.id }}</div>
                  </td>
                  <td class="mono">{{ c.onlineCount }}/{{ c.accountCount }} 在线</td>
                  <td>
                    <span class="mono">{{ fmtBalance(c.totalCredits, c.id) }}</span>
                    <span class="np-meta" style="margin-left: 4px">{{ balanceUnit(c.id) }}</span>
                  </td>
                  <td>
                    <span class="tag" :class="c.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
                      {{ c.onlineCount > 0 ? "在线" : "离线" }}
                    </span>
                  </td>
                  <td class="col-act" style="white-space: nowrap">
                    <button class="btn btn-sm" :disabled="busyChannel === c.id" @click="testChannel(c.id)">
                      {{ busyChannel === c.id ? "测试中…" : "测试" }}
                    </button>
                    <el-switch
                      :model-value="isOn(c.id)"
                      size="small"
                      style="margin-left: 8px"
                      @update:model-value="(v: any) => toggleChannel(c.id, v === true)"
                    />
                  </td>
                </tr>
                <tr v-if="!primaryChannels.length">
                  <td colspan="5" class="empty-cell">
                    号池还没有可用账号
                    <button class="btn-link" style="margin-left: 6px" @click="app.selectModule('proxy')">去号池管家 →</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 扩展渠道（折叠）：号池无账号的渠道，列出来但不可启用，避免用户以为漏了 -->
        <div v-if="extendedChannels.length" class="card">
          <div class="card-title" style="cursor: pointer; user-select: none" @click="showExtended = !showExtended">
            <i class="ph ph-caret-right lgw-caret" :class="{ 'is-open': showExtended }"></i>
            扩展渠道（{{ extendedChannels.length }}）
            <span class="right" style="font-weight: 400">号池无账号，启用后需先去添加账号</span>
          </div>
          <div v-if="showExtended" class="table-scroll">
            <table class="table table-bare tbl-static">
              <thead>
                <tr>
                  <th>渠道</th>
                  <th style="width: 22%">账号</th>
                  <th style="width: 14%">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in extendedChannels" :key="c.id" style="opacity: 0.7">
                  <td>
                    <div class="np-name">{{ c.display }}</div>
                    <div class="np-meta">{{ c.id }}</div>
                  </td>
                  <td class="np-meta">号池暂无账号</td>
                  <td class="col-act">
                    <button class="btn-link" @click="app.selectModule('proxy')">去添加 →</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 页头工具条（照搬旧版 ProxyHomeView.css 的 .toolbar 版式；本页暂未用满，留给后续筛选行） */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.toolbar-right {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 错误红卡：旧版 6 页各自声明一份，这里照旧版做法保留在页内 */
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
/* ===== 策略卡：左说明 + 右控件（照搬旧版 ProxyNetworkView.css:630-655）===== */
.strategy-card {
  padding: 14px 16px;
}
.strategy-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.strategy-row + .strategy-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.s-left {
  flex: 1;
  min-width: 220px;
}
.s-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.s-desc {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 2px;
}
.strategy-ctl {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.fixed-select {
  width: 220px;
}
/* ===== 只读表格：全局 .table 默认给了 pointer + 悬停底色（那是给「点行看详情」的表用的），
   本页两张表只有行内按钮/开关，关掉这两项，免得看起来像能点 ===== */
.tbl-static tbody tr {
  cursor: default;
}
.tbl-static tbody tr:hover {
  background: transparent;
}
.tbl-static .col-act {
  text-align: right;
}
.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 22px 0;
}
/* 渠道名 / 次要信息（旧版 np-name / np-meta 版式） */
.np-name {
  font-size: 12.5px;
  color: var(--text);
  font-weight: 500;
}
.np-meta {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
/* 折叠箭头：展开时转 90°（与旧版 caret 同款） */
.lgw-caret {
  transition: transform 0.15s;
}
.lgw-caret.is-open {
  transform: rotate(90deg);
}
/* 空态（旧版 .empty 版式） */
.empty {
  padding: 28px 0;
  text-align: center;
}
.empty-title {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
}
.empty-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 4px;
}
</style>
