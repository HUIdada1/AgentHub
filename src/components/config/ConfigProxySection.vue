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
<!-- 号池管家 · 配置页（右上「配置」按钮切换的模块页）：额度监控 / 安全与数据
     原「反代网关」配置里的服务端口、路由策略、限速并发、故障转移、规则热加载与远程实例
     随转发能力一并下线；设置统一读写框架整体配置（config.json 的 proxy 段），保存即热生效 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import * as api from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import ProxyUpstreamDialog from "../ProxyUpstreamDialog.vue";

const app = useAppStore();
// 上游启闭弹窗（渠道级开关：关闭的渠道在号池管家全部页面动态隐藏，重新打开立即恢复）
const upOpen = ref(false);
const vault = ref<{ encrypted: boolean; driver: string; dataDir: string } | null>(null);
const saving = ref(false);
const msg = ref("");
const msgErr = ref(false);

/** 打开框架设置弹窗并落到「同步时间」页（周期类配置统一在那里改） */
function gotoTiming() {
  app.settingsTab = "timing";
  app.settingsOpen = true;
}

/** 当前周期状态摘要（引导行里给用户看现状）：自动签到按渠道开，这里汇总已开启的渠道数 */
const autoCheckinChannels = computed(() =>
  Object.values(app.config.proxy.checkinAutoRules || {}).filter((r) => r && r.enabled).length
);
const proxyTimingSummary = computed(() =>
  [
    `额度每 ${app.config.proxy.creditsRefreshMin} 分钟刷新`,
    autoCheckinChannels.value ? `自动签到 ${autoCheckinChannels.value} 个渠道` : "自动签到关",
  ].join(" · "),
);

async function refresh() {
  try {
    vault.value = await api.proxyVaultStatus();
  } catch {
    /* 浏览器预览走 mock */
  }
}

// 每次激活都重拉保险库状态
const active = computed(() => app.activeModule === "proxy" && app.activePage === "config");
watch(active, (v) => { if (v) refresh(); }, { immediate: true });

/** 保存：整体配置落盘，全部字段热生效（不再有监听服务需要重启） */
async function save() {
  if (saving.value) return;
  saving.value = true;
  msg.value = "";
  try {
    // 判数用 Number.isFinite 而不是 ||：合法的 0（= 关闭预警）会被 || 当 falsy 跳回默认值
    const esd = Number(app.config.proxy.expiringSoonDays);
    app.config.proxy.expiringSoonDays = Math.min(3650, Math.max(0, Math.round(Number.isFinite(esd) ? esd : 1)));
    // 保留期只认 1~3650：非正值（0 / 负数 / 空串 / 垃圾）一律兜底默认 90，与后端两处同一口径
    // （setUsageRetention 忽略非法值保留现值、cleanupUsage 兜底 90）。刻意不把 0 钳成 1——
    // 那等于静默把保留期改成一天，下次启动 GC 会把一天前的流水整批删掉。
    // 空串得先掐掉再 Number：Number("") === 0 会被当成合法输入。
    const urd = Number(String(app.config.proxy.usageRetentionDays ?? "").trim() || NaN);
    app.config.proxy.usageRetentionDays = Number.isFinite(urd) && Math.round(urd) >= 1 ? Math.min(3650, Math.round(urd)) : 90;
    const r = await app.save();
    if (r && r.ok === false) {
      msg.value = r.message || "保存失败";
      msgErr.value = true;
      return;
    }
    msg.value = "已保存";
    msgErr.value = false;
  } finally {
    saving.value = false;
    await refresh();
  }
}

function openDataDir() {
  api.proxyOpenDataDir().catch(() => {});
}
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">配置 · 号池管家</div>
        <div class="cfg-sec-sub">额度监控 · 凭证与数据（设置存于框架整体配置）</div>
      </div>
      <div class="cfg-sec-actions">
        <span v-if="msg" class="tag" :class="msgErr ? 'tag-err' : 'tag-ok'">{{ msg }}</span>
        <button class="btn btn-ghost" @click="upOpen = true"><i class="ph ph-plugs-connected"></i>上游启闭</button>
        <button class="btn btn-cta" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">额度监控</div>
        <!-- 周期类配置统一在「设置 · 同步时间」管理，这里只读状态并引导 -->
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">自动刷新与定时签到</div>
            <div class="set-desc">{{ proxyTimingSummary }} · 统一在「设置 · 同步时间」管理</div>
          </div>
          <button class="btn btn-ghost" @click="gotoTiming">去修改 →</button>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">「即将到期」预警阈值</div>
            <div class="set-desc">号池到期徽标与逐包明细共用这一个值；填 0 关闭预警。范围 0~3650，超出按边界保存</div>
          </div>
          <input v-model.number="app.config.proxy.expiringSoonDays" class="input mono" style="width: 90px" type="number" min="0" max="3650" />
          <span style="font-size: 11px; color: var(--text-3)">天</span>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">余额历史保留</div>
            <div class="set-desc">启动时按它清理超期的余额历史（1~3650 天，默认 90；填 0 或非法值按 90 保存）</div>
          </div>
          <input v-model.number="app.config.proxy.usageRetentionDays" class="input mono" style="width: 90px" type="number" min="1" max="3650" />
          <span style="font-size: 11px; color: var(--text-3)">天</span>
        </div>
      </div>
      <div class="card">
        <div class="card-title">安全与数据</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">凭证保险库</div>
            <div class="set-desc">渠道 token 经 DPAPI 加密落盘，日志零明文</div>
          </div>
          <span class="tag" :class="vault?.encrypted ? 'tag-ok' : 'tag-warn'">
            {{ vault?.encrypted ? "DPAPI 加密正常" : "加密不可用（降级明文，建议修复系统密钥）" }}
          </span>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">数据目录</div>
            <div class="set-desc">{{ vault?.dataDir || "（浏览器预览）" }} · 存储驱动 {{ vault?.driver || "-" }}</div>
          </div>
          <button class="btn btn-sm" @click="openDataDir">打开目录</button>
        </div>
      </div>
    </div>

    <!-- 上游启闭弹窗（渠道级开关）：关闭的渠道在号池管家全部页面动态隐藏，重新打开立即恢复 -->
    <ProxyUpstreamDialog :open="upOpen" @close="upOpen = false" />
  </div>
</template>
