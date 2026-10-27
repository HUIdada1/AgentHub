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
<!-- 本地网关 · 服务与密钥：生成 / 复制 / 吊销 / 改名
     完整 Key 只在创建响应里出现一次（方案决策 3），列表永远只有前缀 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useLocalgwStore } from "../../stores/localgw";

const lgw = useLocalgwStore();
const createOpen = ref(false);
const busy = ref(false);
/** 新建表单（默认值已预填，降低手动设置成本） */
const form = ref({
  name: "",
  scopeAll: true,
  scopes: [] as string[],
  noExpire: true,
  expiresAt: "",
  concurrency: 8,
  ratePerMin: 120,
});
/** 刚创建的完整 Key：只在弹窗里展示一次 */
const justCreated = ref<{ rawKey: string; name: string } | null>(null);

const activeKeys = computed(() => lgw.keys.filter((k) => k.status === "active"));
const revokedKeys = computed(() => lgw.keys.filter((k) => k.status === "revoked"));

/** 渠道权限文案：scopes 缺失时按「全部渠道」显示，不能直接 .includes 崩掉 */
function scopeText(k: { scopes?: string[] }) {
  const scopes = Array.isArray(k.scopes) ? k.scopes : [];
  if (!scopes.length || scopes.includes("*")) return "全部渠道";
  return `${scopes.length} 个渠道`;
}

function openCreate() {
  form.value = {
    name: `Key-${(activeKeys.value.length + 1).toString().padStart(2, "0")}`,
    scopeAll: true,
    scopes: [],
    noExpire: true,
    expiresAt: "",
    concurrency: 8,
    ratePerMin: 120,
  };
  createOpen.value = true;
}

/** 到期时间：按「所选日期当天 23:59:59（本地时区）」结算，
 *  避免 new Date("YYYY-MM-DD") 被当成 UTC 零点导致中国用户少用 8 小时。
 *  入参放宽到 unknown：日期选择器点「清除」后 v-model 会变 null，直接 .trim() 会崩 */
function parseExpiry(day: unknown): number | null {
  if (typeof day !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  return Number.isFinite(t) ? t : null;
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    ElMessage.warning("请填写密钥名称");
    return;
  }
  if (!form.value.scopeAll && !form.value.scopes.length) {
    ElMessage.warning("请至少选择一个渠道，或选择「全部渠道」");
    return;
  }
  let expiresAt: number | null = null;
  if (!form.value.noExpire) {
    // 「自定义」但没选日期 / 选了过去的日期都必须拦下：
    // 否则前者会静默变成永不过期，后者会创建一个立刻失效的 Key（都要用户自己发现）
    expiresAt = parseExpiry(form.value.expiresAt);
    if (!expiresAt) {
      ElMessage.warning("请选择到期日期");
      return;
    }
    if (expiresAt <= Date.now()) {
      ElMessage.warning("到期日期必须晚于今天");
      return;
    }
  }
  const concurrency = Number(form.value.concurrency);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    ElMessage.warning("并发上限必须 ≥ 1");
    return;
  }
  const ratePerMin = Number(form.value.ratePerMin);
  if (!Number.isFinite(ratePerMin) || ratePerMin < 1) {
    ElMessage.warning("限流必须 ≥ 1 req/min");
    return;
  }
  busy.value = true;
  try {
    const scopes = form.value.scopeAll ? ["*"] : form.value.scopes.slice();
    const name = form.value.name.trim();
    const r = await lgw.createKey({ name, scopes, expiresAt, concurrency, ratePerMin });
    if (r) {
      createOpen.value = false;
      justCreated.value = { rawKey: r.rawKey, name };
    } else {
      ElMessage.error(lgw.lastError || "创建失败");
    }
  } finally {
    busy.value = false;
  }
}

function copyKey(k: { keyPrefix?: string }) {
  // 列表只有前缀，无法复制完整 Key —— 这是刻意的：明文只在创建时出现一次
  ElMessage.info(`只能复制前缀 ${k.keyPrefix || ""}；完整 Key 只在创建时显示一次`);
}

async function revoke(id: string, name: string) {
  try {
    await ElMessageBox.confirm(`吊销后「${name}」立刻失效，无法恢复。`, "吊销密钥", {
      confirmButtonText: "吊销",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  const ok = await lgw.revokeKey(id);
  if (ok) ElMessage.success("已吊销");
  else ElMessage.error(lgw.lastError || "吊销失败");
}

async function rename(id: string, cur: string) {
  try {
    const { value } = await ElMessageBox.prompt("新的名称", "重命名密钥", {
      inputValue: cur,
      confirmButtonText: "保存",
      cancelButtonText: "取消",
      inputValidator: (v: string) => (v && v.trim() ? true : "名称不能为空"),
    });
    const ok = await lgw.renameKey(id, String(value).trim());
    if (ok) ElMessage.success("已重命名");
    else ElMessage.error(lgw.lastError || "重命名失败");
  } catch {
    /* 取消 */
  }
}

/** 复制：返回是否成功——「复制并关闭」必须据此决定关不关，
 *  否则复制失败时弹窗一关，这个只显示一次的 Key 就永久丢了 */
async function copyText(text: string): Promise<boolean> {
  if (!text) {
    ElMessage.warning("没有可复制的内容");
    return false;
  }
  try {
    // navigator.clipboard 在非 https / 无权限环境下不存在或直接 reject，必须兜底
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
    return true;
  } catch {
    ElMessage.warning("复制失败，请手动选中复制");
    return false;
  }
}

/** 复制成功才关闭弹窗（失败时留在原地让用户手动选中） */
async function copyAndClose() {
  const ok = await copyText(justCreated.value?.rawKey || "");
  if (ok) justCreated.value = null;
}

function fmtDate(ts: number | null) {
  if (!ts) return "永不过期";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "永不过期";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtAgo(ts: number | null) {
  if (!ts) return "从未使用";
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff)) return "从未使用";
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

onMounted(async () => {
  // refreshKeys 成功即证明 localgw 通道已接线（backendReady 由 store 置位）——
  // 不再依赖「先打开总览页」才把占位态消掉（App.vue 会恢复上次停留的页面）
  await Promise.all([lgw.refreshKeys(), lgw.refreshChannels()]);
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="lgw-toolbar">
      <span class="lgw-toolbar-title">服务与密钥</span>
      <span class="lgw-kpi-sub">{{ activeKeys.length }} 个有效 · {{ revokedKeys.length }} 个已吊销</span>
      <el-button size="small" type="primary" :disabled="!lgw.backendReady" @click="openCreate">新建密钥</el-button>
    </div>

    <!-- 错误横幅：加载/操作失败时把原因显式说出来 -->
    <div v-if="lgw.lastError" class="lgw-inline-err">
      <i class="ph ph-warning-circle"></i>
      <span>{{ lgw.lastError }}</span>
      <el-button size="small" text @click="lgw.clearError()">知道了</el-button>
    </div>

    <div v-if="!lgw.backendReady" class="lgw-backend-off">
      <i class="ph ph-link-break lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入</div>
      <div class="lgw-backend-off-desc">密钥表需要主进程 localgw IPC 通道，接入后本页自动可用。</div>
    </div>

    <template v-else>
      <div class="lgw-section">
        <div class="lgw-section-title">有效密钥</div>
        <div v-if="activeKeys.length" style="display:flex;flex-direction:column;gap:8px">
          <div v-for="k in activeKeys" :key="k.id" class="lgw-key-row">
            <div style="flex:1;min-width:0">
              <div class="lgw-key-name">{{ k.name || "未命名" }}</div>
              <div class="lgw-key-meta">
                <span class="lgw-key-prefix">{{ k.keyPrefix || "—" }}…</span>
                · {{ scopeText(k) }}
                · 并发 {{ k.concurrency ?? "-" }} · {{ k.ratePerMin ?? "-" }} req/min
                · {{ fmtDate(k.expiresAt) }}
                · 最后使用 {{ fmtAgo(k.lastUsedAt) }}
              </div>
              <div class="lgw-key-meta">
                累计 {{ k.totalRequests ?? 0 }} 次请求 · {{ k.totalTokens ?? 0 }} tokens
              </div>
            </div>
            <div class="lgw-key-actions">
              <el-button size="small" @click="copyKey(k)">复制</el-button>
              <el-button size="small" @click="rename(k.id, k.name)">改名</el-button>
              <el-button size="small" type="danger" plain @click="revoke(k.id, k.name || '未命名')">吊销</el-button>
            </div>
          </div>
        </div>
        <div v-else style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">
          还没有密钥 —— 点右上「新建密钥」，创建后即可在 IDE 里使用
        </div>
      </div>

      <div v-if="revokedKeys.length" class="lgw-section">
        <div class="lgw-section-title">已吊销</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div v-for="k in revokedKeys" :key="k.id" class="lgw-key-row" style="opacity:0.55">
            <div style="flex:1;min-width:0">
              <div class="lgw-key-name">{{ k.name || "未命名" }}</div>
              <div class="lgw-key-meta">
                <span class="lgw-key-prefix">{{ k.keyPrefix || "—" }}…</span>
                · 累计 {{ k.totalRequests ?? 0 }} 次请求
              </div>
            </div>
            <el-tag type="info" size="small">已吊销</el-tag>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建密钥弹窗 -->
    <el-dialog v-model="createOpen" title="新建 API Key" width="480px">
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="lgw-field">
          <span class="lgw-field-label">名称</span>
          <el-input v-model="form.name" size="small" placeholder="用于区分调用方，如 IDE-1" />
        </div>
        <div class="lgw-field" style="align-items:flex-start">
          <span class="lgw-field-label" style="padding-top:4px">渠道权限</span>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px">
            <el-radio-group v-model="form.scopeAll" size="small">
              <el-radio :value="true">全部渠道</el-radio>
              <el-radio :value="false">仅以下渠道</el-radio>
            </el-radio-group>
            <div v-if="!form.scopeAll" style="display:flex;flex-wrap:wrap;gap:6px;max-height:140px;overflow:auto">
              <el-checkbox
                v-for="c in lgw.channels"
                :key="c.id"
                v-model="form.scopes"
                :value="c.id"
                size="small"
              >{{ c.display }}</el-checkbox>
              <span v-if="!lgw.channels.length" style="color:var(--text-3);font-size:11.5px">
                号池暂无渠道，先到「号池管家」添加账号
              </span>
            </div>
          </div>
        </div>
        <div class="lgw-field" style="align-items:flex-start">
          <span class="lgw-field-label" style="padding-top:4px">有效期</span>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px">
            <el-radio-group v-model="form.noExpire" size="small">
              <el-radio :value="true">永不过期</el-radio>
              <el-radio :value="false">自定义</el-radio>
            </el-radio-group>
            <el-date-picker
              v-if="!form.noExpire"
              v-model="form.expiresAt"
              type="date"
              size="small"
              placeholder="选择到期日"
              value-format="YYYY-MM-DD"
              style="width:180px"
            />
          </div>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">并发上限</span>
          <el-input-number v-model="form.concurrency" :min="1" :max="64" size="small" />
          <span style="color:var(--text-3);font-size:11.5px">建议 ≤ 16（与网关全局并发上限对齐）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">限流</span>
          <el-input-number v-model="form.ratePerMin" :min="1" :max="10000" size="small" />
          <span style="color:var(--text-3);font-size:11.5px">req/min</span>
        </div>
      </div>
      <template #footer>
        <el-button size="small" @click="createOpen = false">取消</el-button>
        <el-button size="small" type="primary" :loading="busy" @click="submitCreate">立即生成</el-button>
      </template>
    </el-dialog>

    <!-- 创建成功：完整 Key 只显示这一次 -->
    <el-dialog
      :model-value="!!justCreated"
      title="密钥已生成"
      width="520px"
      :close-on-click-modal="false"
      :show-close="false"
    >
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12.5px;color:var(--warn);font-weight:500">
          这是「{{ justCreated?.name }}」的完整密钥，<b>只显示这一次</b>，关闭后将无法再次查看。
        </div>
        <div class="lgw-copy-block">
          <span class="lgw-copy-text">{{ justCreated?.rawKey }}</span>
          <el-button size="small" @click="copyText(justCreated?.rawKey || '')">复制</el-button>
        </div>
        <div style="font-size:11.5px;color:var(--text-3);line-height:1.7">
          在客户端中把它填到 <code style="font-family:var(--font-mono)">OPENAI_API_KEY</code> 或
          <code style="font-family:var(--font-mono)">ANTHROPIC_API_KEY</code>，Base URL 见「接入与文档」页。
        </div>
      </div>
      <template #footer>
        <el-button size="small" @click="justCreated = null">我已保存，关闭</el-button>
        <el-button size="small" type="primary" @click="copyAndClose">复制并关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>
