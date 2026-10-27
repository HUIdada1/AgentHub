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
<!-- 本地网关 · 配置（方案 §7 默认值清单）
     四个二级 tab：监听与安全 / 性能与限流 / 联动 / 扩展点。
     改动即存（与提示词库配置页同款交互：用户改完常直接关弹窗，漏存比多存烦人）。
     所有字段打开时就按 LOCALGW_CONFIG_DEFAULTS 渲染好，用户零成本上手（方案 §7 末段）。 -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import { LOCALGW_CONFIG_DEFAULTS, type LocalgwConfig } from "../../types";
import * as api from "../../api/ipc";

const app = useAppStore();
const tab = ref<"net" | "perf" | "bind" | "extend">("net");

/** 表单镜像：以 store 里的配置为源，改动即 patch 到主进程 config.json 的 localgw 段 */
const form = reactive<LocalgwConfig>(JSON.parse(JSON.stringify(LOCALGW_CONFIG_DEFAULTS)));
watch(
  () => app.config.localgw,
  (v) => { if (v) Object.assign(form, JSON.parse(JSON.stringify(v))); },
  { immediate: true, deep: true }
);

/** 后端通道是否可用：不可用时所有写操作会失败，页面上要明确说明而不是静默 */
const backendReady = ref(false);
const saving = ref(false);

/** 改动即存：调 localgw_config_patch（深合并补丁），失败必须把错误说出来 */
async function patch(p: Record<string, unknown>) {
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await api.localgwConfigPatch(p);
    if (r && r.ok) {
      // 回写内存态，避免配置页与其它页面（如总览的 Base URL）读到旧值
      Object.assign(app.config.localgw as object, p);
      ElMessage.success("已保存");
    } else {
      ElMessage.error("保存失败：主进程未响应");
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    saving.value = false;
  }
}

/** 改绑定地址要二次确认：0.0.0.0 会把网关暴露到局域网/公网 */
async function setBind(v: string) {
  if (v !== "127.0.0.1" && v !== "::1") {
    try {
      await ElMessageBox.confirm(
        `绑定到 ${v} 后，局域网内其它设备也能访问该网关。请确认你了解这个风险。`,
        "开放网络访问",
        { confirmButtonText: "我知道，继续", cancelButtonText: "取消", type: "warning" }
      );
    } catch {
      return;
    }
  }
  form.bind = v;
  await patch({ bind: v });
}

async function setPort(v: number) {
  form.port = v;
  // 端口走专用通道（方案 §6 localgw_set_port），不走 config_patch：
  // 它除了写配置，还会在网关运行中「停止 → 用新端口重启」，改完立即生效；
  // 只 patch 配置的话运行中的实例仍监听旧端口，用户看到的是「改了没反应」。
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await api.localgwSetPort(v);
    if (r && r.ok) {
      Object.assign(app.config.localgw as object, { port: v });
      ElMessage.success(r.port && r.port !== v ? `已保存，当前实际端口 ${r.port}` : "端口已保存");
    } else {
      ElMessage.error((r && r.message) || "端口保存失败");
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "端口保存失败");
  } finally {
    saving.value = false;
  }
}

/** 端口候选列表：编辑成 "9527,9528" 这类逗号分隔串 */
const portCandidatesText = computed({
  get: () => (form.portCandidates || []).join(", "),
  set: (v: any) => {
    const arr = String(v)
      .split(/[,，\s]+/)
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => Number.isFinite(n) && n > 0 && n < 65536);
    form.portCandidates = arr;
  },
});

/** 安全：清空 secret 后重启会重新生成（用于轮转） */
async function rotateSecret() {
  try {
    await ElMessageBox.confirm(
      "轮转密钥后，已签发的访问凭据会失效（API Key 不受影响，它们哈希存库）。继续？",
      "轮转内部签名密钥",
      { confirmButtonText: "轮转", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  await patch({ security: { ...form.security, secret: "" } });
}

/** provider 扩展点：本期只做开关与目录，exe 不进仓库（方案决策 2） */
const providersHint = computed(() =>
  form.providers.enabled
    ? "已开启：将从指定目录扫描 provider，未通过 doctor 校验的不会被加载"
    : "未开启（本期默认）：仅保留接口与目录约定，不加载任何第三方 provider"
);

watch(
  () => app.config.localgw,
  async () => {
    const st = await api.localgwStatus().catch(() => null);
    backendReady.value = !!st;
  },
  { immediate: true }
);
</script>

<template>
  <div class="cfg-sec lgw-scope">
    <!-- 二级页签 -->
    <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
      <el-button size="small" :type="tab === 'net' ? 'primary' : 'default'" @click="tab = 'net'">监听与安全</el-button>
      <el-button size="small" :type="tab === 'perf' ? 'primary' : 'default'" @click="tab = 'perf'">性能与限流</el-button>
      <el-button size="small" :type="tab === 'bind' ? 'primary' : 'default'" @click="tab = 'bind'">模块联动</el-button>
      <el-button size="small" :type="tab === 'extend' ? 'primary' : 'default'" @click="tab = 'extend'">扩展点</el-button>
    </div>

    <div v-if="!backendReady" class="lgw-backend-off" style="margin-bottom:14px">
      <i class="ph ph-warning-circle lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入，本页改动无法保存</div>
      <div class="lgw-backend-off-desc">
        前端已按默认值渲染好（方案 §7），主进程接上 localgw/index.cjs 的 IPC 注册后即可生效。当前展示的是推荐默认配置。
      </div>
    </div>

    <!-- ===== 监听与安全 ===== -->
    <div v-show="tab === 'net'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">监听地址</div>
        <div class="lgw-field">
          <span class="lgw-field-label">绑定</span>
          <el-select :model-value="form.bind" size="small" style="width:200px" @change="setBind">
            <el-option label="127.0.0.1（仅本机，推荐）" value="127.0.0.1" />
            <el-option label="::1（IPv6 回环）" value="::1" />
            <el-option label="0.0.0.0（局域网/公网可访问）" value="0.0.0.0" />
          </el-select>
        </div>
        <div v-if="form.bind === '0.0.0.0'" class="lgw-kpi-sub" style="color:var(--warn)">
          当前绑定对外开放：任何能访问本机网络的人都能调用该网关。请确保已设置强 API Key。
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">端口</span>
          <el-input-number
            :model-value="form.port"
            :min="1024"
            :max="65535"
            size="small"
            @change="(v: any) => setPort(Number(v))"
          />
          <span class="lgw-kpi-sub">被占用时自动尝试：{{ portCandidatesText }}</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">候选端口</span>
          <el-input
            v-model="portCandidatesText"
            size="small"
            placeholder="9527, 9528, 9529, 9530"
            @blur="patch({ portCandidates: form.portCandidates })"
          />
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">开机自启</span>
          <el-switch
            :model-value="form.autostart"
            size="small"
            @change="(v: any) => { form.autostart = v; patch({ autostart: v }); }"
          />
          <span class="lgw-kpi-sub">应用启动时自动开始监听（默认关）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">安全</div>
        <div class="lgw-field">
          <span class="lgw-field-label">密钥哈希落库</span>
          <el-switch
            :model-value="form.security.encryptKeysAtRest"
            size="small"
            disabled
          />
          <span class="lgw-kpi-sub">固定开启：API Key 只存 HMAC-SHA256 + 前缀，列表永不回显明文</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">内部签名密钥</span>
          <el-button size="small" @click="rotateSecret">轮转</el-button>
          <span class="lgw-kpi-sub">留空时首次启动自动生成；轮转会使旧访问凭据失效</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">请求体上限</span>
          <el-input-number :model-value="form.bodyLimitMb" :min="1" :max="64" size="small" @change="(v: any) => patch({ bodyLimitMb: Number(v) })" />
          <span class="lgw-kpi-sub">MB（超限直接 413，避免大 payload 撑爆主进程）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">请求超时</span>
          <el-input-number :model-value="Math.round(form.requestTimeoutMs / 1000)" :min="10" :max="1800" size="small" @change="(v: any) => patch({ requestTimeoutMs: Number(v) * 1000 })" />
          <span class="lgw-kpi-sub">秒（长上下文推理建议 ≥120）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">跨域（CORS）</div>
        <div class="lgw-field" style="align-items:flex-start">
          <span class="lgw-field-label" style="padding-top:4px">允许来源</span>
          <el-input
            :model-value="(form.corsOrigins || []).join('\n')"
            type="textarea"
            :rows="3"
            size="small"
            placeholder="http://localhost:5174"
            @blur="(e: FocusEvent) => patch({ corsOrigins: String((e.target as HTMLTextAreaElement).value).split('\n').map((s) => s.trim()).filter(Boolean) })"
          />
        </div>
        <div class="lgw-kpi-sub">
          仅在从浏览器页面直连网关时需要；IDE 与 curl 不受 CORS 限制。默认只放行本地 dev 与 tauri webview。
        </div>
      </div>
    </div>

    <!-- ===== 性能与限流 ===== -->
    <div v-show="tab === 'perf'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">并发与限流</div>
        <div class="lgw-field">
          <span class="lgw-field-label">全局并发</span>
          <el-input-number :model-value="form.concurrency" :min="1" :max="64" size="small" @change="(v: any) => patch({ concurrency: Number(v) })" />
          <span class="lgw-kpi-sub">同刻最大在途请求；与号池共用主进程 event loop，建议 ≤16</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">全局限流</span>
          <el-input-number :model-value="form.rateLimitPerMin" :min="1" :max="100000" size="small" @change="(v: any) => patch({ rateLimitPerMin: Number(v) })" />
          <span class="lgw-kpi-sub">req/min（所有密钥合计）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">单 Key 限流</span>
          <el-input-number :model-value="form.apiKeyRatePerMin" :min="1" :max="100000" size="small" @change="(v: any) => patch({ apiKeyRatePerMin: Number(v) })" />
          <span class="lgw-kpi-sub">req/min（新建 Key 的默认值，单个 Key 可另行覆盖）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">排队上限</span>
          <el-input-number :model-value="Math.round(form.queueTimeoutMs / 1000)" :min="1" :max="300" size="small" @change="(v: any) => patch({ queueTimeoutMs: Number(v) * 1000 })" />
          <span class="lgw-kpi-sub">秒（超并发的请求最多排队这么久，超时返回 429）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">出站行为</div>
        <div class="lgw-field">
          <span class="lgw-field-label">指纹脱敏</span>
          <el-switch :model-value="form.fingerprintObfuscation" size="small" @change="(v: any) => { form.fingerprintObfuscation = v; patch({ fingerprintObfuscation: v }); }" />
          <span class="lgw-kpi-sub">剥离 cc_* 自定义键与客户端痕迹头，避免上游识别出转发（默认开）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">拟人抖动</span>
          <el-switch :model-value="form.humanizeJitter" size="small" @change="(v: any) => { form.humanizeJitter = v; patch({ humanizeJitter: v }); }" />
          <span class="lgw-kpi-sub">每次上游请求前随机停 40~220ms（默认开）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">数据保留</div>
        <div class="lgw-field">
          <span class="lgw-field-label">请求流水</span>
          <el-input-number :model-value="form.logRetentionDays" :min="1" :max="3650" size="small" @change="(v: any) => patch({ logRetentionDays: Number(v) })" />
          <span class="lgw-kpi-sub">天（超期在启动时 GC）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">用量记录</span>
          <el-input-number :model-value="form.usageRetentionDays" :min="1" :max="3650" size="small" @change="(v: any) => patch({ usageRetentionDays: Number(v) })" />
          <span class="lgw-kpi-sub">天（写入用量统计模块的明细保留期）</span>
        </div>
      </div>
    </div>

    <!-- ===== 模块联动 ===== -->
    <div v-show="tab === 'bind'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">提示词注入</div>
        <div class="lgw-field">
          <span class="lgw-field-label">注入提示词</span>
          <el-switch :model-value="form.injectPrompt" size="small" @change="(v: any) => { form.injectPrompt = v; patch({ injectPrompt: v }); }" />
          <span class="lgw-kpi-sub">开启后，命中下面这条提示词的请求会把它的正文前置进 system 消息（默认关）</span>
        </div>
        <div v-if="form.injectPrompt" class="lgw-field">
          <span class="lgw-field-label">提示词名</span>
          <el-input v-model="form.injectPromptName" size="small" placeholder="填个人提示词库里的条目名（必须精确匹配）" @blur="patch({ injectPromptName: form.injectPromptName })" />
        </div>
        <div v-if="form.injectPrompt" class="lgw-kpi-sub" style="line-height:1.9">
          · 名字<b>留空 = 不注入</b>：本仓库没有「active 提示词」这个概念，不做"按 model/channel 自动匹配"的猜测——那等于替你选提示词<br />
          · 名字填错 / 条目正文为空 / 提示词库不可用 → 原样转发，注入失败绝不影响请求
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">记忆中枢</div>
        <!-- 本期未接线：不展示开关，只如实说明。理由见 electron/backend/localgw/server.cjs
             的 maybeWriteToMemory 注释（记忆库是用户资产，逐请求写入的语义与内容策略尚无定论）。 -->
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · <b>对话写入记忆：本期未接线</b>（开关与配置字段已预留，不会静默生效）<br />
          · 原因：记忆库是用户资产（参与 WebDAV 同步、全文索引与画像蒸馏），
          把网关这个高频转发面的每一次请求都写进去，会把记忆库变成请求流水账，且不可逆
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">与号池的联动</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 账号与凭证：<b>只读</b>复用号池（不建第二套账号模型）<br />
          · 号池停用某账号 → 网关侧立即熔断，不再选到它<br />
          · 号池模块整体停用 → 本地网关无法启动（没有凭证来源）<br />
          · 渠道启闭：本模块的「路由与渠道」只影响网关可见集合，不改号池自身配置
        </div>
      </div>
    </div>

    <!-- ===== 扩展点 ===== -->
    <div v-show="tab === 'extend'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">第三方 Provider（预留）</div>
        <div class="lgw-field">
          <span class="lgw-field-label">启用</span>
          <el-switch :model-value="form.providers.enabled" size="small" @change="(v: any) => { form.providers.enabled = v; patch({ providers: { ...form.providers, enabled: v } }); }" />
        </div>
        <div class="lgw-kpi-sub">{{ providersHint }}</div>
        <div class="lgw-field">
          <span class="lgw-field-label">扫描目录</span>
          <el-input v-model="form.providers.dir" size="small" placeholder="留空 = <dataDir>/providers" @blur="patch({ providers: { ...form.providers, dir: form.providers.dir } })" />
        </div>
        <div class="lgw-kpi-sub" style="line-height:1.9;color:var(--warn)">
          本期不打包任何第三方 exe（方案决策 2）：无源码、不可审计，出 Bug 无法修。
          未来如需接入：把 provider 包放到扫描目录 → 通过 doctor 校验签名与版本 → 在 allowlist 里显式放行。
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">关于本模块</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 模块 key：<code style="font-family:var(--font-mono)">localgw</code>（不可禁用——它是对外 API 的唯一入口）<br />
          · 转发链路：单进程内嵌（不另起子进程），与本项目其余模块同款 IPC 直连<br />
          · 协议：OpenAI + Anthropic 双协议，不支持 Gemini
        </div>
      </div>
    </div>
  </div>
</template>
