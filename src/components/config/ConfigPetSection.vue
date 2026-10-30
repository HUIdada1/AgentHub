<!--
  设置弹窗 · 桌宠组件（悬浮桌宠 · 卡冈图雅）

  这一页只是「控制台」：真正的桌宠是 electron/pet/ 里的独立窗口模块，
  本页通过 6 条 pet_* IPC 读写它的配置与状态（见 docs/桌宠/01-模块契约.md §2）。

  保存策略：
    · 开关 / 单选这类离散项 —— 点了立刻落盘；
    · 滑块（尺寸 / 转速 / 扭曲强度 / 不透明度）—— 拖动时只改本地，停下 300ms 后落盘，
      否则拖一次滑块会写几十次 config.json。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import type { PetStatus } from "../../api/ipc";
import type { PetConfig, PromptStyle } from "../../types";

const app = useAppStore();

/** 只在设置弹窗停在「桌宠组件」页时才拉数据（与 ConfigGeneralSection 同款，避免打开设置就白耗 IPC） */
const active = computed(() => app.settingsOpen && app.settingsTab === "pet");

const status = ref<PetStatus | null>(null);
const loading = ref(false);
const busy = ref(false);
const msg = ref<{ ok: boolean; text: string } | null>(null);
const usage = ref<{ tokens: number | null; text: string } | null>(null);
const previewText = ref("");
const styles = ref<PromptStyle[]>([]);

/** 配置的本地视图：直接用 app.config.pet，保存后主进程会把归一化结果回写覆盖 */
const pet = computed<PetConfig>(() => app.config.pet);

/** el-select 的 v-model 会写回：必须给 setter，否则绑定只读 computed 时写入被吞、
 *  下拉显示不会跟着变（Vue 只在开发构建里警告一句，界面上像"选了没反应"） */
const selectedStyle = computed<string>({
  get: () => pet.value.optimize.styleId || "",
  set: (v) => { app.config.pet.optimize.styleId = v || ""; },
});

/** 读取状态 + 今日用量 + 优化风格列表 */
async function refresh() {
  loading.value = true;
  msg.value = null;
  try {
    const st = await api.petStatus();
    status.value = st;
    if (st && st.config) app.config.pet = structuredClone(st.config);
  } catch (e) {
    msg.value = { ok: false, text: `读取桌宠状态失败：${(e as Error).message}` };
  } finally {
    loading.value = false;
  }
  try {
    usage.value = await api.petUsageToday();
  } catch {
    usage.value = null;
  }
  try {
    const r = await api.promptsStylesList();
    styles.value = r && Array.isArray(r.styles) ? r.styles : [];
  } catch {
    styles.value = [];
  }
}

watch(active, (v) => { if (v) void refresh(); }, { immediate: true });

// ===== 保存 =====
let saveTimer: number | null = null;

async function doSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  busy.value = true;
  try {
    const r = await api.petConfigSave(app.config.pet);
    if (r && r.ok) {
      app.config.pet = structuredClone(r.config);
      if (status.value) status.value = { ...status.value, config: r.config };
      msg.value = { ok: true, text: "已保存并立即生效" };
    } else {
      msg.value = { ok: false, text: (r && r.message) || "保存失败" };
    }
  } catch (e) {
    msg.value = { ok: false, text: (e as Error).message };
  } finally {
    busy.value = false;
  }
}

/** 离散项：点了立刻存 */
function saveNow() {
  void doSave();
}

/** 连续项（滑块）：停下 300ms 再存 */
function saveLazy() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void doSave(); }, 300);
}

/** 原生 range 的输入处理：只改本地值 + 防抖落盘（不引入 el-slider，
 *  该组件在本项目 components.d.ts 里未登记，按需注册插件的类型要等 dev/build 才会补） */
const RANGE_KEYS = ["size", "diskSpeed", "lensStrength", "opacity"] as const;
type RangeKey = (typeof RANGE_KEYS)[number];
function onRange(key: RangeKey, e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  if (key === "size") app.config.pet.size = Math.round(v);
  else if (key === "diskSpeed") app.config.pet.diskSpeed = v;
  else if (key === "lensStrength") app.config.pet.lensStrength = v;
  else app.config.pet.opacity = v;
  saveLazy();
}

// ===== 开关动作 =====
async function toggleEnabled(next: boolean) {
  if (busy.value) return;
  if (next) {
    // 首次开启给一次确认：透明置顶窗会立刻出现在桌面上，用户需要知道它是什么、怎么交互
    msg.value = null;
  }
  busy.value = true;
  try {
    const r = await api.petSetEnabled(next);
    if (r && r.ok) {
      app.config.pet.enabled = next;
      if (status.value) status.value = { ...status.value, config: { ...status.value.config, enabled: next }, visible: r.visible };
      if (r.config) app.config.pet = structuredClone(r.config);
      msg.value = { ok: true, text: next ? "桌宠已显示：拖动黑洞可移动，Ctrl+滚轮缩放，右键出菜单" : "桌宠已关闭（窗口已销毁，不占资源）" };
    } else {
      msg.value = { ok: false, text: (r && r.message) || "操作失败" };
    }
  } catch (e) {
    msg.value = { ok: false, text: (e as Error).message };
  } finally {
    busy.value = false;
  }
}

async function resetPosition() {
  try {
    const r = await api.petResetPosition();
    msg.value = r && r.ok ? { ok: true, text: "已移回主屏右下角默认位置" } : { ok: false, text: "窗口未开启，无法重置位置" };
  } catch (e) {
    msg.value = { ok: false, text: (e as Error).message };
  }
}

/**
 * 右键「隐藏桌宠」后窗口只是被 hide（enabled 仍为 true，开关仍显示开）。
 * 主进程的 setEnabled(true) 对存活但隐藏的窗口会补一次 show，所以这里点一下就能唤回。
 * 不给这个按钮的话，用户只能先关开关（销毁窗）再开，或重启应用。
 */
async function showPet() {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await api.petSetEnabled(true);
    if (r && r.ok) {
      app.config.pet.enabled = true;
      if (r.config) app.config.pet = structuredClone(r.config);
      if (status.value) status.value = { ...status.value, config: r.config || status.value.config, visible: r.visible };
      msg.value = { ok: true, text: "已唤回桌宠窗口" };
    } else {
      msg.value = { ok: false, text: (r && r.message) || "唤回失败，请先关闭再重新开启" };
    }
  } catch (e) {
    msg.value = { ok: false, text: (e as Error).message };
  } finally {
    busy.value = false;
  }
}

async function testOptimizeChain() {
  try {
    const r = await api.petOptimizePreview();
    previewText.value = r && r.message ? r.message : "无返回";
    if (r && !r.ok) ElMessage.warning(r.message || "优化链路不可用");
  } catch (e) {
    previewText.value = (e as Error).message;
  }
}

// ===== 右键菜单项（5 个开关的元数据；文案要说清"点了会发生什么"） =====
const MENU_ITEMS: { key: keyof PetConfig["rightMenu"]; name: string; desc: string }[] = [
  { key: "optimizePrompt", name: "优化提示词", desc: "读取当前前台输入框里的提示词，用「提示词库」的模型与风格优化后回填" },
  { key: "tokenUsage", name: "今日 Token 用量", desc: "菜单顶部直接显示今日 token 总量（与托盘「今日用量」同一份统计）" },
  { key: "hide", name: "隐藏桌宠", desc: "临时隐藏悬浮窗（不销毁、不占 GPU）；本页「唤回窗口」或重新开关即可恢复" },
  { key: "resetPosition", name: "重置位置", desc: "把悬浮窗移回主屏右下角默认位置" },
  { key: "closePet", name: "关闭桌宠", desc: "彻底关闭悬浮窗并把总开关置为关（下次需在本页重新开启）" },
];

// ===== 采样帧率分段 =====
const FPS_OPTIONS = [15, 30, 60] as const;

// ===== 主进程广播：右键菜单 / 托盘也可能改配置，这里跟着回显 =====
let offEvent: (() => void) | undefined;
onMounted(() => {
  offEvent = api.onUpdateEvent((payload) => {
    const e = payload as { event?: string; config?: PetConfig; visible?: boolean; windowReady?: boolean };
    if (e && e.event === "pet-config-changed" && e.config) {
      app.config.pet = structuredClone(e.config);
      if (status.value) {
        status.value = {
          ...status.value,
          config: e.config,
          visible: typeof e.visible === "boolean" ? e.visible : status.value.visible,
          windowReady: typeof e.windowReady === "boolean" ? e.windowReady : status.value.windowReady,
        };
      }
    }
  });
});
onBeforeUnmount(() => {
  offEvent?.();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
});
</script>

<template>
  <div class="pet-sec">
    <div class="pet-head">
      <i class="ph ph-planet"></i>
      <div>
        <div class="pet-title">卡冈图雅 · 悬浮桌宠</div>
        <div class="pet-sub">
          置顶、无边框、透明悬浮窗；默认窗口点击穿透，只有黑洞盘面可拖动 / 右键。桌宠是独立模块（electron/pet/），关掉后不占任何资源。
        </div>
      </div>
      <span class="pet-badge" :class="{ on: pet.enabled }">{{ pet.enabled ? (status?.visible ? "运行中" : "已隐藏") : "已关闭" }}</span>
    </div>

    <!-- ① 显示与窗口行为 -->
    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">显示桌宠</div>
          <div class="set-desc">
            开启后在桌面右下角出现黑洞。拖动盘面移动，<code>Ctrl</code> + 滚轮缩放，右键出菜单；
            窗口透明区域鼠标可直接穿透到桌面。
          </div>
        </div>
        <!-- 右键「隐藏桌宠」后窗口只是隐藏（开关仍为开），这里给一个直接唤回入口 -->
        <button
          v-if="pet.enabled && status && !status.visible"
          class="btn btn-ghost pet-recall"
          :disabled="busy"
          @click="showPet"
        >唤回窗口</button>
        <div
          class="switch"
          :class="{ on: pet.enabled, disabled: busy }"
          role="switch"
          :aria-checked="pet.enabled"
          @click="toggleEnabled(!pet.enabled)"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">置顶显示</div>
          <div class="set-desc">始终浮在其他窗口之上（不会盖住全屏游戏 / 演示，那会抢走内容层级）</div>
        </div>
        <div
          class="switch"
          :class="{ on: pet.alwaysOnTop }"
          role="switch"
          :aria-checked="pet.alwaysOnTop"
          @click="app.config.pet.alwaysOnTop = !pet.alwaysOnTop; saveNow()"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">点击穿透</div>
          <div class="set-desc">
            开启后只有黑洞盘面接收鼠标，四周透明区域点下去会落到桌面图标上；
            关闭则整个正方形窗口都会挡住鼠标（调试布局时可用）
          </div>
        </div>
        <div
          class="switch"
          :class="{ on: pet.clickThrough }"
          role="switch"
          :aria-checked="pet.clickThrough"
          @click="app.config.pet.clickThrough = !pet.clickThrough; saveNow()"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">不透明度</div>
          <div class="set-desc">{{ Math.round(pet.opacity * 100) }}%（最低 35%，再低会看不清黑洞轮廓）</div>
        </div>
        <div class="pet-slider">
          <input
            class="pet-range"
            type="range"
            :min="0.35"
            :max="1"
            :step="0.01"
            :value="pet.opacity"
            @input="onRange('opacity', $event)"
          />
        </div>
      </div>
    </div>

    <!-- ② 卡冈图雅特效 -->
    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">黑洞大小</div>
          <div class="set-desc">
            {{ pet.size }} px（窗口边长，120~720，默认 240）。黑洞与吸积盘约占窗口的 62%，其余是透明留白
          </div>
        </div>
        <div class="pet-slider">
          <input class="pet-range" type="range" :min="120" :max="720" :step="10" :value="pet.size" @input="onRange('size', $event)" />
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">吸积盘转速</div>
          <div class="set-desc">
            {{ pet.diskSpeed.toFixed(2) }}×（0 = 静止）。按开普勒差速旋转：内圈快、外圈慢
          </div>
        </div>
        <div class="pet-slider">
          <input class="pet-range" type="range" :min="0" :max="3" :step="0.05" :value="pet.diskSpeed" @input="onRange('diskSpeed', $event)" />
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">引力扭曲强度</div>
          <div class="set-desc">
            {{ pet.lensStrength.toFixed(2) }}×（0 = 不弯曲，但仍显示吸积盘）。
            史瓦西引力透镜：越靠近视界背景被压缩得越强，视界内部纯黑
          </div>
        </div>
        <div class="pet-slider">
          <input class="pet-range" type="range" :min="0" :max="2.5" :step="0.05" :value="pet.lensStrength" @input="onRange('lensStrength', $event)" />
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">特效总开关</div>
          <div class="set-desc">
            关闭后不做屏幕采样、不做引力畸变，只保留静态黑洞与吸积盘（低配机器 / 远程桌面建议关闭）
          </div>
        </div>
        <div
          class="switch"
          :class="{ on: pet.fxEnabled }"
          role="switch"
          :aria-checked="pet.fxEnabled"
          @click="app.config.pet.fxEnabled = !pet.fxEnabled; saveNow()"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">采样背后实时屏幕</div>
          <div class="set-desc">
            黑洞里显示的是它背后那块屏幕的实时画面，并做引力弯曲。关闭后改用程序化星空底（省 GPU 与显存带宽）。<br />
            <b>注意</b>：为了不让黑洞递归拍到自己，悬浮窗对系统截图 / 录屏不可见。
          </div>
        </div>
        <div
          class="switch"
          :class="{ on: pet.screenSample, disabled: !pet.fxEnabled }"
          role="switch"
          :aria-checked="pet.screenSample"
          @click="pet.fxEnabled && (app.config.pet.screenSample = !pet.screenSample, saveNow())"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">采样帧率</div>
          <div class="set-desc">只限制屏幕采样频率，动画本身仍按显示器刷新率跑</div>
        </div>
        <div class="pet-seg" :class="{ disabled: !pet.fxEnabled || !pet.screenSample }">
          <button
            v-for="f in FPS_OPTIONS"
            :key="f"
            :class="{ active: pet.captureFps === f }"
            :disabled="!pet.fxEnabled || !pet.screenSample"
            @click="app.config.pet.captureFps = f; saveNow()"
          >{{ f }}</button>
        </div>
      </div>
    </div>

    <!-- ③ 右键菜单（用户自定义右击功能） -->
    <div class="card">
      <div class="set-row set-row-head">
        <div class="set-info">
          <div class="set-name">右键菜单功能</div>
          <div class="set-desc">勾选后出现在桌宠的右键菜单里；关闭的项不显示也不执行</div>
        </div>
      </div>
      <div v-for="it in MENU_ITEMS" :key="it.key" class="set-row">
        <div class="set-info">
          <div class="set-name">{{ it.name }}</div>
          <div class="set-desc">{{ it.desc }}</div>
        </div>
        <div
          class="switch"
          :class="{ on: pet.rightMenu[it.key] }"
          role="switch"
          :aria-checked="pet.rightMenu[it.key]"
          @click="app.config.pet.rightMenu[it.key] = !pet.rightMenu[it.key]; saveNow()"
        ></div>
      </div>
    </div>

    <!-- ④ 提示词优化 -->
    <div class="card">
      <div class="set-row set-row-head">
        <div class="set-info">
          <div class="set-name">「优化提示词」动作</div>
          <div class="set-desc">
            复用「提示词库 · 优化」的模型、风格与历史记录，不另起一套；未配置模型时会提示去「设置 · 模型与网关」
          </div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">读取方式</div>
          <div class="set-desc">
            自动：先把焦点还给原窗口，再模拟 Ctrl+A / Ctrl+C 读取输入框内容（读不到则回退剪贴板）<br />
            仅剪贴板：只处理你已复制的内容，不发送任何按键
          </div>
        </div>
        <div class="pet-seg">
          <button :class="{ active: pet.optimize.source === 'auto' }" @click="app.config.pet.optimize.source = 'auto'; saveNow()">自动读输入框</button>
          <button :class="{ active: pet.optimize.source === 'clipboard' }" @click="app.config.pet.optimize.source = 'clipboard'; saveNow()">仅剪贴板</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">优化后自动回填</div>
          <div class="set-desc">把优化结果 Ctrl+V 贴回原输入框（覆盖原文，可 Ctrl+Z 撤销）；关闭则只复制到剪贴板</div>
        </div>
        <div
          class="switch"
          :class="{ on: pet.optimize.pasteBack }"
          role="switch"
          :aria-checked="pet.optimize.pasteBack"
          @click="app.config.pet.optimize.pasteBack = !pet.optimize.pasteBack; saveNow()"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">优化风格</div>
          <div class="set-desc">与「提示词库 · 优化」共用同一份风格库</div>
        </div>
        <el-select v-model="selectedStyle" size="small" style="width: 210px" @change="saveNow">
          <el-option label="跟随默认（提示词库设置）" value="" />
          <el-option v-for="s in styles" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
      </div>
      <div class="set-row pet-row-col">
        <div class="set-info">
          <div class="set-name">附加要求</div>
          <div class="set-desc">每次优化都会拼进提示词（例如「保持中文」「压到 300 字以内」）；留空则不附加</div>
        </div>
        <el-input
          v-model="app.config.pet.optimize.extra"
          type="textarea"
          :rows="3"
          size="small"
          maxlength="4000"
          show-word-limit
          placeholder="例如：保持中文，尽量精简到 300 字以内"
          @change="saveNow"
        />
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">链路自检</div>
          <div class="set-desc">{{ previewText || "检查读取方式 / 键盘模拟 / 回填是否可用（不调用模型、不消耗 token）" }}</div>
        </div>
        <button class="btn btn-ghost" @click="testOptimizeChain">自检</button>
      </div>
    </div>

    <!-- ⑤ 操作与状态 -->
    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">今日 Token 用量</div>
          <div class="set-desc">与托盘菜单「今日用量」同一份统计（数据来自用量统计板块）</div>
        </div>
        <span class="num pet-usage">{{ usage ? usage.text : "—" }}</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">重置位置</div>
          <div class="set-desc">把悬浮窗移回主屏右下角（多屏拔插后窗口跑到看不见的地方时用）</div>
        </div>
        <button class="btn btn-ghost" :disabled="!pet.enabled" @click="resetPosition">重置位置</button>
      </div>
      <div v-if="msg" class="pet-msg" :class="{ err: !msg.ok }">{{ msg.text }}</div>
      <div v-if="loading" class="pet-msg">读取中…</div>
    </div>
  </div>
</template>

<style scoped>
.pet-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 页头：图标 + 标题 + 一行说明 + 运行状态徽标 */
.pet-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 2px 2px 6px;
}
.pet-head > .ph {
  font-size: 22px;
  color: var(--accent-strong);
  margin-top: 1px;
}
.pet-title {
  font-size: 13px;
  font-weight: 650;
}
.pet-sub {
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 3px;
  line-height: 1.5;
  max-width: 640px;
}
.pet-badge {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 3px 9px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-strong);
  color: var(--text-3);
  background: var(--bg-soft);
}
.pet-badge.on {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

/* 滑块行：固定宽度，避免把左侧说明挤成两行 */
.pet-slider {
  width: 210px;
  flex-shrink: 0;
  padding: 0 4px;
}
/* 原生 range：不引 el-slider（本项目 components.d.ts 未登记该组件，按需注册的类型要等 dev/build 补），
   自绘成与全站开关同色系的细轨 + 圆点滑块 */
.pet-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: var(--line-strong);
  outline: none;
  cursor: pointer;
}
.pet-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--bg);
  box-shadow: 0 0 6px var(--accent-dim);
  cursor: pointer;
}
.pet-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--bg);
  cursor: pointer;
}

/* 分段按钮：与全站分段控件同形（圆角胶囊 + 选中主题色） */
.pet-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  flex-shrink: 0;
}
.pet-seg.disabled {
  opacity: 0.45;
}
.pet-seg button {
  border: none;
  background: transparent;
  color: var(--text-2);
  font-family: var(--font-ui);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: calc(var(--r-sm) - 2px);
  cursor: pointer;
  white-space: nowrap;
}
.pet-seg button:hover:not(:disabled) {
  color: var(--text);
}
.pet-seg button.active {
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.pet-seg button:disabled {
  cursor: not-allowed;
}

/* 纵向行（附加要求）：说明在上、输入框在下，占满宽度 */
.pet-row-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.pet-usage {
  font-size: 12.5px;
  color: var(--accent-strong);
}

/* 开关禁用态：.switch 的样式来自全局/其它组件，scoped 下跨组件不生效，这里补一份本组件内的 */
.pet-sec .switch.disabled {
  opacity: 0.55;
  pointer-events: none;
}

/* 「唤回窗口」：与开关同一行，只在右键隐藏后出现 */
.pet-recall {
  margin-right: 10px;
  flex-shrink: 0;
  font-size: 11px;
  padding: 4px 10px;
}

.pet-msg {
  font-size: 11.5px;
  color: var(--text-2);
  padding-top: 8px;
}
.pet-msg.err {
  color: var(--err);
}

/* 只有标题的设置行：不留底部内边距，让下面的开关行贴上来 */
.set-row-head {
  padding-bottom: 2px;
  border-bottom: none;
}
</style>
