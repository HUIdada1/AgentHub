<!-- 反代网关 · 配置页（右上「配置」按钮切换的模块页）：服务 / 请求与路由 / 额度监控 / 安全与数据 / 规则热加载
     内容承接原反代网关「设置」页签；页面内的二级子板块 tab 在这里切换；
     设置统一读写框架整体配置（config.json 的 proxy 段）；
     端口/绑定地址属例外：保存后同进程 stop→listen 秒级重启监听 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyModel, ProxyRuleFile } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtAgo, fmtK } from "../../views/proxy/format";

const app = useAppStore();
// 页面内的二级子板块：服务与路由 / 监控与安全 / 规则文件
const tab = ref<"service" | "monitor" | "rules">("service");
const rules = ref<ProxyRuleFile[]>([]);
const vault = ref<{ encrypted: boolean; driver: string; dataDir: string } | null>(null);
const saving = ref(false);
const msg = ref("");
const msgErr = ref(false);
const running = ref(false);
// 优先渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
// 全局回退模型候选 = 合并模型目录
const models = ref<ProxyModel[]>([]);

async function refresh() {
  try {
    rules.value = await api.proxyRulesList();
    vault.value = await api.proxyVaultStatus();
    channels.value = await api.proxyPool().catch(() => channels.value);
    models.value = await api.proxyModels().catch(() => models.value);
    const st = await api.proxyStatus();
    running.value = st.running;
  } catch {
    /* 浏览器预览走 mock */
  }
}

// 每次激活都重拉规则 / 保险库 / 运行状态（规则文件可能被外部改过）
const active = computed(() => app.activeModule === "proxy" && app.activePage === "config");
watch(active, (v) => { if (v) refresh(); }, { immediate: true });

/** 保存：整体配置落盘；端口/绑定变化时重启监听，其余项热生效 */
async function save() {
  if (saving.value) return;
  saving.value = true;
  msg.value = "";
  try {
    const port = Math.round(Number(app.config.proxy.port));
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      msg.value = "端口必须是 1-65535 的整数";
      msgErr.value = true;
      return;
    }
    app.config.proxy.port = port;
    app.config.proxy.rateLimitPerMin = Math.max(0, Math.round(Number(app.config.proxy.rateLimitPerMin) || 0));
    app.config.proxy.concurrency = Math.max(1, Math.round(Number(app.config.proxy.concurrency) || 1));
    const r = await app.save();
    if (r && r.ok === false) {
      msg.value = r.message || "保存失败";
      msgErr.value = true;
      return;
    }
    if (running.value) {
      const rr = await api.proxyRestart();
      if (rr && (rr as { ok?: boolean }).ok === false) {
        msg.value = (rr as { message?: string }).message || "重启监听失败";
        msgErr.value = true;
        return;
      }
    }
    msg.value = running.value ? "已保存并重启监听" : "已保存（服务未启动，下次启动生效）";
    msgErr.value = false;
  } finally {
    saving.value = false;
    await refresh();
  }
}

function openRulesDir() {
  api.proxyOpenRulesDir().catch(() => {});
}
function openDataDir() {
  api.proxyOpenDataDir().catch(() => {});
}
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">配置 · 反代网关</div>
        <div class="cfg-sec-sub">网关服务 · 路由 · 监控 · 规则热加载（设置存于框架整体配置）</div>
      </div>
      <div class="cfg-sec-actions">
        <span v-if="msg" class="tag" :class="msgErr ? 'tag-err' : 'tag-ok'">{{ msg }}</span>
        <button class="btn btn-cta" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存并重启服务" }}</button>
      </div>
    </div>

    <!-- 二级子板块 tab：页面内切换，不占横条菜单的位置 -->
    <div class="cfg-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'service' }" @click="tab = 'service'"><i class="ph ph-gear-six"></i>服务与路由</button>
      <button class="cfg-subtab" :class="{ active: tab === 'monitor' }" @click="tab = 'monitor'"><i class="ph ph-chart-bar"></i>监控与安全</button>
      <button class="cfg-subtab" :class="{ active: tab === 'rules' }" @click="tab = 'rules'"><i class="ph ph-file-code"></i>规则文件</button>
    </div>

    <template v-if="tab === 'service'">
    <div class="grid-2">
      <div class="card">
        <div class="card-title">服务</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">监听端口</div>
            <div class="set-desc">默认 9527；改端口需重启监听（秒级，不中断应用）</div>
          </div>
          <input v-model.number="app.config.proxy.port" class="input mono" style="width: 100px" type="number" min="1" max="65535" />
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">绑定地址</div>
            <div class="set-desc">局域网开放会强制要求 Key 鉴权，注意风险</div>
          </div>
          <el-select v-model="app.config.proxy.bind" popper-class="glass-popper" style="width: 208px">
            <el-option value="127.0.0.1" label="127.0.0.1（仅本机）" />
            <el-option value="0.0.0.0" label="0.0.0.0（局域网开放）" />
          </el-select>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">记住网关开关（随应用启动）</div>
            <div class="set-desc">默认关闭：首次打开应用网关是停的，需在「总览」页手动启动；启动/停止都会记在这里，下次打开按它恢复</div>
          </div>
          <button class="switch" :class="{ on: app.config.proxy.restoreOnLaunch }" @click="app.config.proxy.restoreOnLaunch = !app.config.proxy.restoreOnLaunch"></button>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">/status 调试端点</div>
            <div class="set-desc">默认关闭；开启后仅回环地址可访问</div>
          </div>
          <button class="switch" :class="{ on: app.config.proxy.debugStatus }" @click="app.config.proxy.debugStatus = !app.config.proxy.debugStatus"></button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">请求与路由</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">默认路由策略</div>
            <div class="set-desc">模型仅存在于单渠道时强制走该渠道，此策略处理多源重叠</div>
          </div>
          <el-select v-model="app.config.proxy.routeStrategy" popper-class="glass-popper" style="width: 208px">
            <el-option value="smart" label="智能路由（健康度 × 余额打分）" />
            <el-option value="fixed" label="指定渠道优先" />
          </el-select>
        </div>
        <div class="set-row" v-if="app.config.proxy.routeStrategy === 'fixed'">
          <div class="set-info"><div class="set-name">优先渠道</div></div>
          <el-select v-model="app.config.proxy.fixedChannel" popper-class="glass-popper" style="width: 208px">
            <el-option v-for="c in channels" :key="c.id" :value="c.id" :label="c.display" />
          </el-select>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">单 Key 限速</div>
            <div class="set-desc">令牌桶；新 Key 默认继承，Key 上可单独覆盖</div>
          </div>
          <input v-model.number="app.config.proxy.rateLimitPerMin" class="input mono" style="width: 90px" type="number" min="0" />
          <span style="font-size: 11px; color: var(--text-3)">次 / 分钟</span>
        </div>
        <div class="set-row">
          <div class="set-info"><div class="set-name">上游并发上限</div></div>
          <input v-model.number="app.config.proxy.concurrency" class="input mono" style="width: 90px" type="number" min="1" />
          <span style="font-size: 11px; color: var(--text-3)">并发</span>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">拟人抖动（防监测）</div>
            <div class="set-desc">每次上游请求前随机停 40~220ms，模拟真实客户端节奏，降低被风控识别为反代的概率</div>
          </div>
          <button class="switch" :class="{ on: app.config.proxy.humanizeJitter }" @click="app.config.proxy.humanizeJitter = !app.config.proxy.humanizeJitter"></button>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">不可用时自动切换模型</div>
            <div class="set-desc">统一设置（默认开）：模型未知或号池耗尽时自动切到下方回退模型，客户端无感（响应模型字段保持请求值）</div>
          </div>
          <button class="switch" :class="{ on: app.config.proxy.autoFallbackEnabled !== false }" @click="app.config.proxy.autoFallbackEnabled = app.config.proxy.autoFallbackEnabled === false"></button>
        </div>
        <div class="set-row" v-if="app.config.proxy.autoFallbackEnabled !== false">
          <div class="set-info">
            <div class="set-name">全局回退模型</div>
            <div class="set-desc">候选来自合并模型目录；留空则不切换</div>
          </div>
          <el-select v-model="app.config.proxy.fallbackModel" popper-class="glass-popper" filterable clearable style="width: 208px" placeholder="选择回退模型">
            <el-option v-for="m in models" :key="m.id" :value="m.id" :label="m.id" />
          </el-select>
        </div>
      </div>
    </div>
    </template>

    <template v-else-if="tab === 'monitor'">
    <div class="grid-2">
      <div class="card">
        <div class="card-title">额度监控</div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">自动刷新周期</div>
            <div class="set-desc">逐账号批量查询，每渠道并发 ≤2</div>
          </div>
          <el-select v-model="app.config.proxy.creditsRefreshMin" popper-class="glass-popper" style="width: 120px">
            <el-option :value="10" label="10 分钟" />
            <el-option :value="30" label="30 分钟" />
            <el-option :value="60" label="60 分钟" />
          </el-select>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-name">定时自动签到</div>
            <div class="set-desc">每天到点自动跑全渠道：Trae/WorkBuddy/小浣熊 每日签到 + 国际版领加油包（幂等，已签过自动跳过）</div>
          </div>
          <button class="switch" :class="{ on: app.config.proxy.checkinAuto }" @click="app.config.proxy.checkinAuto = !app.config.proxy.checkinAuto"></button>
        </div>
        <div class="set-row" v-if="app.config.proxy.checkinAuto">
          <div class="set-info">
            <div class="set-name">签到时间</div>
            <div class="set-desc">到点未开机则开机后首次过点补跑一次</div>
          </div>
          <el-time-select
            v-model="app.config.proxy.checkinAutoTime"
            start="00:00"
            end="23:30"
            step="00:30"
            popper-class="glass-popper"
            style="width: 120px"
          />
        </div>
        <div class="set-row">
          <div class="set-info"><div class="set-name">余额历史 / 请求流水保留</div></div>
          <span class="num">90 天（启动时自动清理）</span>
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
    </template>

    <div class="card" v-else>
      <div class="card-title">
        规则文件热加载
        <span class="right">改文件即时生效，无需重启 · <button class="btn-link btn-sm" @click="openRulesDir">打开 rules 目录</button></span>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <tbody>
            <tr><th>文件</th><th>说明</th><th>大小</th><th>修改时间</th><th>状态</th></tr>
            <tr v-for="r in rules" :key="r.file">
              <td class="mono">{{ r.file }}</td>
              <td>{{ r.desc }}</td>
              <td class="mono">{{ r.size ? fmtK(r.size) + "B" : "-" }}</td>
              <td class="mono">{{ r.mtimeMs ? fmtAgo(r.mtimeMs) : "-" }}</td>
              <td>
                <span class="tag" :class="r.ok ? 'tag-ok' : 'tag-err'" :title="r.error">{{ r.ok ? "已加载" : "解析失败（用上次快照）" }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
