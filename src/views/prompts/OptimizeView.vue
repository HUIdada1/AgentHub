<!--
  ============================================================
   作者：沐晖
   日期：2026-10-23
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!--
  AgentHub · 提示词库（Prompt Library）
  Copyright (c) 2026 沐晖 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 提示词库 · 优化提示词（核心页）：顶部参数条 → 上框原文 → 中间按钮区 → 下框结果（请求中显示「正在优化中」转圈态）+ 动作区。
     优化历史已独立为「优化历史」页签（HistoryView.vue），本页不再内嵌。 -->
<!--
  §8.1 的 40 条异常，前端负责的在这里落地（后端负责的在括号里注明，前端只消费 err.code / message；
  历史侧 33~39 在「优化历史」页签落地）：
    输入侧  1 空原文禁用 · 2 过短二次确认 · 3 超长预估警告并让用户选截断 · 6 清零宽字符
            （4 `$&` 替换模式、5 只替换一次占位符：属后端模板渲染，前端不做替换故不会踩）
    模型侧  7 no_model 引导去「设置 · 模型与网关」 · 8 model_error 提示查配置 · 10 请求中提示会自动重试
            11 timeout 提示可调高超时 · 13 too_long 提示截断/换模型 · 14 结果为空判失败且不动结果框
            20 语言不符只提示不重试 · 21 与原文完全相同提示换风格 · 22 超出建议长度提示但不截断
            23/24 空结果与拒绝话术给出「换非思考模型 / 换风格」的可执行建议
            （9 401/403 换候选、12 400/422 剥离参数重试、15~19 去引号/围栏/前言/语言标签/取第一段：后端后处理）
    交互侧  25 取消立即停转圈 · 26 连点先 abort 前一次且只保留最后一次结果 · 27 切页/卸载中断在途请求
            28 结果被手改后「重新优化」先确认 · 29 结果为空禁用「保存到我的库」 · 30 血缘存原文前 500 字
            31 同名条目提示 · 32 「保存为风格」校验非法占位符
            （历史侧 33 只保留最近 N 次、34 截断禁止回填、36 失败留痕、37 风格名快照、
            38 savedToLibrary 失效提示、39 清空二次确认：都在「优化历史」页签）
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { toast as ElMessage } from "../../utils/toast";
import { useAppStore } from "../../stores/app";
import { usePromptsStore } from "../../stores/prompts";
import { pipc, type PromptItem, type PromptStyle } from "./promptTypes";
import {
  cjkRatio, charCount, copyText, estimateTokens, formatElapsed,
  invalidPlaceholders, newId, parseTags, parseVariables, stripZeroWidth, unifiedDiff,
} from "./promptUtil";
import { sideBySideDiff, type DiffLine } from "../../utils/diff";

const app = useAppStore();
const prompts = usePromptsStore();
const active = computed(() => String(app.activeModule) === "prompts" && app.activePage === "optimize");

/** 超长预警阈值（token）：取 8K 上下文档的保守值。
 *  为什么是常量而不是从模型读：契约 §4 没有「模型上下文窗口」通道，模型清单在设置页；
 *  这里只做「提醒你别把几千字塞进小模型」的兜底，真正超限仍由后端调用返回错误码。 */
const CONTEXT_WARN_TOKENS = 8000;
/** 过短阈值：少于 4 个字符基本没什么可改写的（§8.1 第 2 条） */
const MIN_INPUT_CHARS = 4;
/** 血缘里保留的原文长度：条目膨胀的代价是同步体积（§8.1 第 30 条） */
const LINEAGE_INPUT_KEEP = 500;

// ===== 顶部参数 =====
const styleId = ref("");
const modelPick = ref("");          // "" = 跟随默认；"__custom__" = 手填模型名
const modelCustom = ref("");
const advancedOpen = ref(false);
const adv = ref({ maxLength: 800, temperature: 0.7, maxTokens: 4096, timeoutSec: 60, scenario: "通用 AI 助手" });

const currentStyle = computed<PromptStyle | undefined>(() => prompts.styleById(styleId.value));
const cfg = computed(() => prompts.cfg);

/** 当前风格 / 配置给出的参数基线：风格自己带 maxLength/temperature 就以风格为准，否则跟随全局配置 */
function baseAdv() {
  const st = currentStyle.value;
  return {
    maxLength: st?.maxLength ?? cfg.value.maxLength,
    temperature: st?.temperature ?? cfg.value.temperature,
    maxTokens: cfg.value.maxTokens,
    timeoutSec: cfg.value.timeoutSec,
    scenario: cfg.value.scenario,
  };
}
/** 参数是否被临时改过：决定「保存为风格」是否可用（内置风格 + 没改过参数 = 没什么可存的，§3.1.2） */
const advDirty = computed(() => {
  const b = baseAdv();
  return adv.value.maxLength !== b.maxLength || adv.value.temperature !== b.temperature
    || adv.value.maxTokens !== b.maxTokens || adv.value.timeoutSec !== b.timeoutSec || adv.value.scenario !== b.scenario;
});
const canSaveStyle = computed(() => !!currentStyle.value && (!currentStyle.value.builtin || advDirty.value));

const effectiveModel = computed(() => (modelPick.value === "__custom__" ? modelCustom.value.trim() : modelPick.value));
/** 模型候选：契约 §4 没有模型清单通道，候选来自「配置的默认模型 + 优化历史里用过的模型 + 手填」 */
const modelOptions = computed(() => {
  const extra = [...new Set([cfg.value.defaultModel, ...prompts.recentModels].filter(Boolean))];
  return [
    { value: "", label: "跟随默认（设置 · 模型与网关）" },
    ...extra.map((m) => ({ value: m, label: m + (m === cfg.value.defaultModel ? "（配置的默认）" : "") })),
    { value: "__custom__", label: "自定义模型名…" },
  ];
});

// ===== 双框 =====
const inputText = ref("");
const resultText = ref("");
/** 上一次「由模型产出 / 由历史回填」的结果快照：用来判断结果框是否被手工编辑过（§8.1 第 28 条） */
const resultBase = ref("");
const resultDirty = computed(() => resultText.value !== resultBase.value);

// ===== 请求状态 =====
const running = ref(false);
const runHint = ref("");
const lastRun = ref<{ styleName: string; model: string; elapsedMs: number; tokens?: { in: number; out: number } } | null>(null);
/** 请求序号：连点 / 取消后，旧请求的返回一律丢弃（只保留最后一次结果，§8.1 第 26 条） */
let runSeq = 0;

const inputChars = computed(() => charCount(inputText.value));
const inputTokens = computed(() => estimateTokens(inputText.value));
const resultChars = computed(() => charCount(resultText.value));
const resultTokens = computed(() => estimateTokens(resultText.value));
const overLength = computed(() => resultChars.value > adv.value.maxLength);
const canOptimize = computed(() => !!inputText.value.trim() && !!styleId.value);

// ===== 对比 =====
const compareOpen = ref(false);
const compareMode = ref<"side" | "unified">("side");
const diffLines = computed<{ left: DiffLine | null; right: DiffLine | null }[]>(() => {
  if (!compareOpen.value) return [];
  try {
    const { left, right } = sideBySideDiff(inputText.value, resultText.value);
    return left.slice(0, 400).map((l, i) => ({ left: l, right: right[i] || null }));
  } catch {
    return [];
  }
});
const unified = computed(() => (compareOpen.value ? unifiedDiff(inputText.value, resultText.value) : { text: "", add: 0, del: 0 }));

// ===== 保存到我的库 =====
const saveOpen = ref(false);
const saveForm = ref({ name: "", category: "", tags: "", description: "" });

// ===== 保存为风格 =====
const styleOpen = ref(false);
const styleForm = ref({ name: "", description: "", systemTemplate: "", userTemplate: "" });
const styleTemplateError = computed(() => {
  const bad = [...invalidPlaceholders(styleForm.value.systemTemplate), ...invalidPlaceholders(styleForm.value.userTemplate)];
  return [...new Set(bad)];
});

/** 错误码 → 人话 + 可执行动作（§4.2 要求按 code 分支，绝不按 message 文案匹配） */
function explainError(code: string, message: string): { text: string; kind: "error" | "warning" | "info" } {
  switch (code) {
    case "empty_input": return { text: "原文为空，请先输入要优化的提示词", kind: "warning" };
    case "too_long": return { text: "原文过长，超出模型上下文；建议截断或换用更大上下文的模型", kind: "warning" };
    case "model_error": return { text: "模型不可用或调用失败，请检查「设置 · 模型与网关」里的供应商与 Key", kind: "error" };
    case "timeout": return { text: `请求超时（当前上限 ${adv.value.timeoutSec}s），可在「高级」里调高超时后重试`, kind: "warning" };
    case "cancelled": return { text: "已取消本次优化", kind: "info" };
    case "empty_result": return { text: "模型返回为空，已判为失败。若用的是思考模型，请换非思考模型或降低思考强度", kind: "error" };
    case "no_model": return { text: "尚未配置可用模型，请先去「设置 · 模型与网关」配置供应商与模型", kind: "warning" };
    default: return { text: message || "优化失败，请稍后重试", kind: "error" };
  }
}

/** 无模型引导：不能只弹一句话，要带「去设置」的直接入口（§8.1 第 7 条） */
async function guideToModels(message: string) {
  try {
    await ElMessageBox.confirm(message, "未配置可用模型", { confirmButtonText: "去「设置 · 模型与网关」", cancelButtonText: "知道了", type: "warning" });
    app.openSettings("models");
  } catch {
    /* 用户选择「知道了」：不做跳转 */
  }
}

/** 取消：先告诉后端中断，再本地立刻停掉转圈（§8.1 第 25 条——「立即」是体验的关键，不能等 IPC 回包） */
async function cancelOptimize() {
  runSeq++;
  running.value = false;
  runHint.value = "";
  try {
    await pipc.promptsOptimizeCancel();
  } catch {
    /* 后端可能已经没有在途请求，取消失败不影响本地还原 */
  }
  ElMessage.info("已取消本次优化");
}

/** 主流程：优化（也是「重新优化」的实现） */
async function optimize(opts: { force?: boolean } = {}) {
  // 连点保护：已在跑就先中断前一次，保证「同时只有一个请求、只保留最后一次结果」（§8.1 第 26 条）
  if (running.value) await cancelOptimize();
  let text = stripZeroWidth(inputText.value);
  if (!text.trim()) { ElMessage.warning("请先输入要优化的提示词"); return; }

  // 过短：允许强行继续（§8.1 第 2 条）
  if (charCount(text.trim()) < MIN_INPUT_CHARS) {
    try {
      await ElMessageBox.confirm("内容太短，优化意义不大。仍要继续吗？", "内容过短", { confirmButtonText: "继续优化", cancelButtonText: "再改改", type: "warning" });
    } catch { return; }
  }

  // 超长：预估 token 后让用户自己选「截断 / 换模型 / 取消」，绝不静默截断（§8.1 第 3 条）
  let truncated = false;
  if (estimateTokens(text) > CONTEXT_WARN_TOKENS) {
    const keepChars = Math.floor(text.length * (CONTEXT_WARN_TOKENS / estimateTokens(text)));
    try {
      await ElMessageBox.confirm(
        `原文约 ${estimateTokens(text)} tokens，超过 ${CONTEXT_WARN_TOKENS} 的预警线，可能触发模型上下文超限。\n`
        + `可以选择「截断后继续」（保留前约 ${keepChars} 字）或先去换一个更大上下文的模型。`,
        "原文可能过长",
        { confirmButtonText: "截断后继续", cancelButtonText: "取消", type: "warning" },
      );
      text = text.slice(0, keepChars);
      truncated = true;
    } catch { return; }
  }

  const seq = ++runSeq;
  running.value = true;
  runHint.value = "正在请求模型…（限流或 5xx 时后端会自动退避重试）";
  // 新一轮开始即清空上一轮结果：下框切换为「正在优化中」转圈态，避免新旧结果混在一起被误读
  resultText.value = "";
  resultBase.value = "";
  lastRun.value = null;
  compareOpen.value = false;
  try {
    const r = await pipc.promptsOptimize({
      text,
      styleId: styleId.value,
      model: effectiveModel.value || undefined,
      maxLength: adv.value.maxLength,
      temperature: adv.value.temperature,
      maxTokens: adv.value.maxTokens,
      timeoutSec: adv.value.timeoutSec,
      scenario: adv.value.scenario,
    });
    // 序号不匹配 = 期间被取消或被更新的一次请求顶掉：直接丢弃，不动界面
    if (seq !== runSeq) return;
    const out = (r.text || "").trim();
    if (!out) {
      // 三层兜底的第三层：后端已判空，前端再判一次。新一轮开始时结果框已先行清空，
      // 这里只提示失败，不往结果框里写任何内容（§8.1 第 14 条）
      ElMessage.error("模型返回为空，已判为失败；若用的是思考模型，请换非思考模型或降低思考强度");
      return;
    }
    resultText.value = out;
    resultBase.value = out;
    lastRun.value = { styleName: r.styleName || currentStyle.value?.name || "", model: r.model || effectiveModel.value || "跟随默认", elapsedMs: r.elapsedMs || 0, tokens: r.tokens };
    postCheck(text, out);
    void prompts.loadHistory();
    if (truncated) ElMessage.warning("本次提交的原文已按你的选择截断，请注意结果只基于截断后的内容");
  } catch (e) {
    if (seq !== runSeq) return;
    const err = e as Error & { code?: string };
    const code = err.code || "unknown";
    if (code === "cancelled") return;   // 取消走静默分支（§8.1 第 25 条：取消是用户主动放弃，不再打扰）
    const info = explainError(code, err.message);
    if (code === "no_model") await guideToModels(info.text);
    else ElMessage[info.kind](info.text);
  } finally {
    if (seq === runSeq) { running.value = false; runHint.value = ""; }
  }
}

/** 结果侧的软提示（不阻断、不改结果）：语言一致性 / 与原文完全相同 / 超出建议长度 / 拒绝话术 */
function postCheck(input: string, output: string) {
  if (input.trim() === output.trim()) {
    ElMessage.warning("模型返回与原文完全相同：原文已较清晰，可换一个风格或补充要求后重试");
    return;
  }
  // 语言粗判：中文占比差异过大才提示，避免中英混排被误报（§8.1 第 20 条，只提示不自动重试）
  const a = cjkRatio(input);
  const b = cjkRatio(output);
  if ((a > 0.5 && b < 0.2) || (a < 0.2 && b > 0.5)) {
    ElMessage.warning("检测到返回语言可能与原文不一致，可重新优化；本次结果已保留");
  }
  if (output.length > adv.value.maxLength * 1.5) {
    ElMessage.warning(`结果 ${charCount(output)} 字，超出建议长度 ${adv.value.maxLength} 字较多（未做截断，可自行精简或调高上限）`);
  }
  if (/^(很抱歉|抱歉|对不起|我无法|我不能|作为一个|I'm sorry|I cannot|I can't)/i.test(output.trim())) {
    ElMessage.warning("模型似乎拒绝了本次改写：建议换一个模型或调整风格后重试");
  }
}

/** 「重新优化」：结果被手工编辑过要先确认（§8.1 第 28 条——手工改动是用户的劳动成果，不能默默覆盖） */
async function reoptimize() {
  if (resultDirty.value) {
    try {
      await ElMessageBox.confirm("结果框已被手工修改，重新优化将覆盖这些改动。确定继续吗？", "覆盖手工修改？", { confirmButtonText: "覆盖并重新优化", cancelButtonText: "取消", type: "warning" });
    } catch { return; }
  }
  await optimize({ force: true });
}

// ===== 保存到我的库 =====
function openSave() {
  const first = (resultText.value || "").split("\n").find((l) => l.trim()) || "";
  saveForm.value = {
    name: first.slice(0, 30).trim() || `优化结果 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    category: cfg.value.defaultCategory,
    tags: currentStyle.value?.name || "",
    description: `由「优化提示词」生成 · 风格：${currentStyle.value?.name || "—"} · 模型：${lastRun.value?.model || "跟随默认"}`,
  };
  saveOpen.value = true;
}
async function doSave() {
  const name = saveForm.value.name.trim();
  if (!name) { ElMessage.warning("请填写名称"); return; }
  // 同名不阻止（id 唯一、名称可重复），但要让用户知道会多出一条（§8.1 第 31 条）
  if (prompts.items.some((i) => !i.deletedAt && i.name === name)) {
    try {
      await ElMessageBox.confirm(`已存在同名条目「${name}」，仍要再存一条吗？`, "同名提示", { confirmButtonText: "仍然保存", cancelButtonText: "取消", type: "warning" });
    } catch { return; }
  }
  const now = Date.now();
  const body = resultText.value;
  const lineageInput = inputText.value.slice(0, LINEAGE_INPUT_KEEP);
  const item: PromptItem = {
    id: newId("p"),
    name,
    description: saveForm.value.description,
    body,
    variables: parseVariables(body),
    category: saveForm.value.category.trim() || cfg.value.defaultCategory,
    tags: parseTags(saveForm.value.tags),
    source: "optimized",
    lineage: {
      styleId: styleId.value,
      model: effectiveModel.value || "",
      // 原文只留前 N 字：完整原文在优化历史里，条目本身要保持轻量（§8.1 第 30 条）
      inputText: inputText.value.length > LINEAGE_INPUT_KEEP ? lineageInput + "…（已截断，完整原文见优化历史）" : lineageInput,
    },
    version: 1,
    versions: [{ version: 1, body, at: now, note: "由优化结果保存", by: "user" }],
    favorite: false,
    useCount: 0,
    lastUsedAt: 0,
    hash: "",
    createdAt: now,
    updatedAt: now,
  };
  const r = await prompts.saveItem(item);
  if (!r.ok) { ElMessage.error(r.message || "保存失败"); return; }
  saveOpen.value = false;
  ElMessage.success(`已保存到个人提示词库：${name}`);
}

// ===== 保存为风格 =====
function openSaveStyle() {
  const st = currentStyle.value;
  if (!st) return;
  styleForm.value = {
    name: `${st.name} · 我的调整`,
    description: advDirty.value ? `基于「${st.name}」调整了参数（上限 ${adv.value.maxLength} / 温度 ${adv.value.temperature} / 场景 ${adv.value.scenario}）` : st.description,
    systemTemplate: st.systemTemplate,
    userTemplate: st.userTemplate || "",
  };
  styleOpen.value = true;
}
async function doSaveStyle() {
  const name = styleForm.value.name.trim();
  if (!name) { ElMessage.warning("请填写风格名称"); return; }
  if (styleTemplateError.value.length) {
    ElMessage.warning(`模板里有非法占位符：${styleTemplateError.value.map((x) => `{${x}}`).join("、")}；只允许 {input} {maxLength} {scenario}`);
    return;
  }
  // id 由前端生成：契约 §1 要求文件名一律用 ASCII id，风格名可重复，所以不能拿名称当 id
  const style: PromptStyle = {
    id: newId("style"),
    name,
    description: styleForm.value.description,
    systemTemplate: styleForm.value.systemTemplate,
    userTemplate: styleForm.value.userTemplate || undefined,
    maxLength: adv.value.maxLength,
    temperature: adv.value.temperature,
    builtin: false,
  };
  try {
    const r = await pipc.promptsStylesSave({ style });
    await prompts.loadStyles();
    styleId.value = r.id || style.id;
    styleOpen.value = false;
    ElMessage.success(`已保存风格「${name}」`);
  } catch (e) {
    ElMessage.error((e as Error).message || "保存风格失败");
  }
}

// ===== 生命周期 =====
/** 「优化历史」页点「回填」跳转过来：取走暂存的原文/结果（与 detailId 同款落点传递）。
 *  首挂载时 active 初始已是 true，watch(active) 不会触发，所以 bootstrap 也要调一次 */
function consumeDraft() {
  if (!prompts.draft) return;
  inputText.value = prompts.draft.input;
  resultText.value = prompts.draft.output;
  resultBase.value = prompts.draft.output;
  lastRun.value = {
    styleName: prompts.draft.styleName,
    model: prompts.draft.model,
    elapsedMs: prompts.draft.elapsedMs,
    tokens: prompts.draft.tokens,
  };
  prompts.draft = null;
}

async function bootstrap() {
  prompts.init();
  await prompts.loadAll();
  styleId.value = prompts.defaultStyleId || prompts.styles[0]?.id || "";
  adv.value = baseAdv();
  modelPick.value = cfg.value.defaultModel || "";
  consumeDraft();
}
onMounted(bootstrap);

// 请求中切页 / 卸载：必须中断在途请求，否则回来后状态是「永远转圈」（§8.1 第 27 条）
watch(active, (v) => {
  if (!v && running.value) void cancelOptimize();
  if (v) {
    if (!prompts.loaded) void prompts.loadAll();
    consumeDraft();
  }
});
onUnmounted(() => {
  if (running.value) void cancelOptimize();
});

// 换风格：把临时覆盖重置为「新风格的基线」，避免上一套风格的参数悄悄带过来
watch(styleId, () => { adv.value = baseAdv(); });

// 结果/原文清空
function clearInput() {
  inputText.value = "";
}
function clearResult() {
  resultText.value = "";
  resultBase.value = "";
}
</script>

<template>
  <div class="page prompts-scope">
    <!-- 顶部参数条 -->
    <div class="pr-card">
      <div class="pr-opt-bar">
        <span class="pr-field">
          <span>风格</span>
          <el-select v-model="styleId" size="small" style="width: 176px" placeholder="选择优化风格">
            <el-option v-for="s in prompts.styles" :key="s.id" :value="s.id" :label="s.name + (s.builtin ? '' : '（自定义）')" />
          </el-select>
        </span>
        <span class="pr-field">
          <span>模型</span>
          <el-select v-model="modelPick" size="small" style="width: 220px">
            <el-option v-for="m in modelOptions" :key="m.value" :value="m.value" :label="m.label" />
          </el-select>
          <input v-if="modelPick === '__custom__'" v-model="modelCustom" class="f-input" style="width: 180px" placeholder="填写模型名" />
        </span>
        <span class="pr-inline-ctl">
          <button class="btn btn-ghost" @click="advancedOpen = !advancedOpen">
            <i class="ph ph-sliders-horizontal"></i>高级 {{ advancedOpen ? "▲" : "▼" }}
          </button>
        </span>
      </div>

      <div v-if="advancedOpen" class="pr-opt-adv">
        <label>输出长度上限（字符）
          <input v-model.number="adv.maxLength" type="number" min="100" max="8000" class="f-input" />
        </label>
        <label>温度（0~2）
          <input v-model.number="adv.temperature" type="number" min="0" max="2" step="0.1" class="f-input" />
        </label>
        <label>最大输出 token
          <input v-model.number="adv.maxTokens" type="number" min="256" max="32000" class="f-input" />
        </label>
        <label>超时（秒）
          <input v-model.number="adv.timeoutSec" type="number" min="5" max="600" class="f-input" />
        </label>
        <label>目标场景描述
          <input v-model="adv.scenario" class="f-input" placeholder="例如：通用 AI 助手 / 面向编码任务" />
        </label>
      </div>
      <div v-if="advancedOpen" class="pr-hint" style="margin-top: 8px">
        这里的改动是「本次临时覆盖」，不会写回配置；想让某套参数长期复用，改完点下方「保存为风格」。
        <template v-if="advDirty">（当前已偏离该风格的基线参数）</template>
      </div>
    </div>

    <!-- 上框：原文 -->
    <div class="pr-card">
      <div class="pr-box">
        <div class="pr-box-head">
          原文
          <span class="pr-hint">上框就是原文、下框是结果，原文始终可见，所以不需要「恢复原文」</span>
        </div>
        <textarea
          v-model="inputText"
          class="pr-area"
          placeholder="把要优化的提示词粘贴到这里，例如：帮我写个周报"
          @keydown.ctrl.enter.prevent="optimize()"
          @keydown.meta.enter.prevent="optimize()"
        ></textarea>
        <div class="pr-area-foot">
          <span>{{ inputChars.toLocaleString("en-US") }} 字符 · 约 {{ inputTokens.toLocaleString("en-US") }} tokens</span>
          <span v-if="inputTokens > CONTEXT_WARN_TOKENS" class="pr-warn-inline">⚠ 已超过 {{ CONTEXT_WARN_TOKENS }} tokens 预警线，提交时会先问你</span>
          <span class="pr-inline-ctl">
            <span class="pr-hint">Ctrl / ⌘ + Enter 直接优化</span>
            <button class="btn btn-ghost btn-sm" :disabled="!inputText" @click="clearInput">清空</button>
          </span>
        </div>
      </div>
    </div>

    <!-- 中间按钮区（无「恢复原文」） -->
    <div class="pr-opt-actions">
      <button v-if="!running" class="btn btn-cta" :disabled="!canOptimize" @click="optimize()">
        <i class="ph ph-magic-wand"></i>优化
      </button>
      <button v-else class="btn btn-outline danger" @click="cancelOptimize">
        <i class="ph ph-x-circle"></i>取消
      </button>
      <el-tooltip :content="canSaveStyle ? '把当前风格与临时参数另存为可复用风格' : '内置风格且未调整参数时无需另存；改参数或换自定义风格后可保存'" placement="top">
        <span><button class="btn btn-ghost" :disabled="!canSaveStyle" @click="openSaveStyle"><i class="ph ph-floppy-disk"></i>保存为风格</button></span>
      </el-tooltip>
    </div>

    <!-- 下框：结果 + 动作区。请求中下框显示「正在优化中」转圈态（上一轮结果已在发起时清空） -->
    <div class="pr-card">
      <div class="pr-box">
        <div class="pr-box-head">
          优化结果
          <span v-if="lastRun" class="pr-chip">{{ lastRun.styleName || "—" }}</span>
          <span v-if="lastRun" class="pr-chip">{{ lastRun.model }}</span>
          <span v-if="lastRun" class="pr-chip">{{ formatElapsed(lastRun.elapsedMs) }}</span>
          <span v-if="lastRun?.tokens" class="pr-chip">in {{ lastRun.tokens.in }} / out {{ lastRun.tokens.out }}</span>
          <span v-if="resultDirty" class="pr-chip warn">已被手工修改</span>
          <span v-if="overLength" class="pr-chip warn">超出建议长度 {{ adv.maxLength }}</span>
          <span class="pr-inline-ctl">
            <button class="btn btn-ghost btn-sm" :disabled="!resultText" @click="clearResult">清空</button>
          </span>
        </div>
        <div v-if="running" class="pr-loading">
          <i class="ph ph-circle-notch"></i>
          <div class="pr-loading-title">正在优化中</div>
          <div class="pr-hint">{{ runHint }}</div>
        </div>
        <template v-else>
          <textarea v-model="resultText" class="pr-area" placeholder="优化结果会出现在这里；也可以直接在这里手工继续编辑"></textarea>
          <div class="pr-area-foot">
            <span>{{ resultChars.toLocaleString("en-US") }} 字符 · 约 {{ resultTokens.toLocaleString("en-US") }} tokens</span>
          </div>
        </template>
        <div class="pr-result-actions">
          <button class="btn btn-ghost" :disabled="!resultText" @click="copyText(resultText, '优化结果')">
            <i class="ph ph-copy"></i>一键复制
          </button>
          <button class="btn btn-ghost" :disabled="running || !canOptimize" @click="reoptimize">
            <i class="ph ph-arrows-clockwise"></i>重新优化
          </button>
          <button class="btn btn-cta" :disabled="!resultText.trim()" @click="openSave">
            <i class="ph ph-bookmark-simple"></i>保存到我的库
          </button>
          <button class="btn btn-ghost" :disabled="!resultText" @click="compareOpen = !compareOpen">
            <i class="ph ph-columns"></i>{{ compareOpen ? "收起对比" : "与原文对比" }}
          </button>
        </div>
      </div>

      <!-- 与原文对比：并排 / 统一 diff -->
      <div v-if="compareOpen" style="margin-top: 12px; border-top: 1px solid var(--pr-line); padding-top: 12px">
        <div class="pr-row" style="margin-bottom: 8px">
          <span class="pr-chip click" :class="{ accent: compareMode === 'side' }" @click="compareMode = 'side'">并排对比</span>
          <span class="pr-chip click" :class="{ accent: compareMode === 'unified' }" @click="compareMode = 'unified'">统一 diff</span>
          <span class="pr-hint" v-if="compareMode === 'unified'">新增 {{ unified.add }} 行 · 删除 {{ unified.del }} 行</span>
        </div>
        <div v-if="compareMode === 'side'" class="pr-diff2">
          <div class="col">
            <div class="col-head">原文</div>
            <div class="col-body">
              <div v-for="(l, i) in diffLines" :key="'l' + i" class="pr-diff-line" :class="l.left?.kind === 'del' ? 'del' : l.left?.kind === 'ctx' ? 'ctx' : ''">{{ l.left?.text || "" }}</div>
            </div>
          </div>
          <div class="col">
            <div class="col-head">优化结果</div>
            <div class="col-body">
              <div v-for="(l, i) in diffLines" :key="'r' + i" class="pr-diff-line" :class="l.right?.kind === 'add' ? 'add' : l.right?.kind === 'ctx' ? 'ctx' : ''">{{ l.right?.text || "" }}</div>
            </div>
          </div>
        </div>
        <pre v-else class="pr-pre">{{ unified.text || "（两侧内容一致）" }}</pre>
      </div>
    </div>

    <!-- ===== 保存到我的库 ===== -->
    <el-dialog v-model="saveOpen" title="保存到我的库" width="520px">
      <div class="pr-col">
        <label class="pr-field" style="display: block">名称<input v-model="saveForm.name" class="f-input" style="width: 100%" /></label>
        <label class="pr-field" style="display: block">分类<input v-model="saveForm.category" class="f-input" style="width: 100%" placeholder="支持两级，如 写作/邮件" /></label>
        <label class="pr-field" style="display: block">标签（逗号或空格分隔）<input v-model="saveForm.tags" class="f-input" style="width: 100%" /></label>
        <label class="pr-field" style="display: block">备注<textarea v-model="saveForm.description" class="pr-area" style="min-height: 70px"></textarea></label>
        <div class="pr-hint">
          正文存结果；原文前 {{ LINEAGE_INPUT_KEEP }} 字 + 风格 + 模型会写进「血缘」，详情页可回溯。
          结果里的 <code>&#123;&#123;变量&#125;&#125;</code> 会被自动识别为变量。
        </div>
        <div v-if="parseVariables(resultText).length" class="pr-row">
          <span class="pr-hint">识别到变量：</span>
          <span v-for="v in parseVariables(resultText)" :key="v.name" class="pr-chip accent">{{ v.name }}</span>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="saveOpen = false">取消</button>
        <button class="btn btn-cta" @click="doSave">保存</button>
      </template>
    </el-dialog>

    <!-- ===== 保存为风格 ===== -->
    <el-dialog v-model="styleOpen" title="保存为风格" width="640px">
      <div class="pr-col">
        <label class="pr-field" style="display: block">风格名称<input v-model="styleForm.name" class="f-input" style="width: 100%" /></label>
        <label class="pr-field" style="display: block">说明<input v-model="styleForm.description" class="f-input" style="width: 100%" /></label>
        <label class="pr-field" style="display: block">
          System 模板
          <textarea v-model="styleForm.systemTemplate" class="pr-area" style="min-height: 130px"></textarea>
        </label>
        <label class="pr-field" style="display: block">
          User 模板（可空）
          <textarea v-model="styleForm.userTemplate" class="pr-area" style="min-height: 110px"></textarea>
        </label>
        <div v-if="styleTemplateError.length" class="pr-warn-inline">
          ⚠ 非法占位符：{{ styleTemplateError.map((x) => "{" + x + "}").join("、") }}（只允许 {input} {maxLength} {scenario}）
        </div>
        <div class="pr-hint">可用占位符：<code>{input}</code> 原文 · <code>{maxLength}</code> 长度上限 · <code>{scenario}</code> 目标场景。风格存本机偏好，不参与同步。</div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="styleOpen = false">取消</button>
        <button class="btn btn-cta" :disabled="styleTemplateError.length > 0" @click="doSaveStyle">保存风格</button>
      </template>
    </el-dialog>
  </div>
</template>
