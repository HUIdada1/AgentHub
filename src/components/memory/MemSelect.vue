<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 标准下拉：el-select + glass-popper + f-el-select，与「用量统计」板块的下拉一模一样
     （同一套毛玻璃弹层、同尺寸同字号）。本模块所有下拉一律用它，不要再写原生 select。
     用法：
       <MemSelect v-model="filters.project" :options="projectOptions" placeholder="全部项目" width="180px" />
     需要"选了就立刻保存"而不走 v-model 时，用 :model-value + @change。 -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: string | number | undefined | null;
    /** 选项清单：value 为提交值，label 为显示文案 */
    options: { value: string | number; label: string }[];
    /** 空值时的占位文案（默认「全部」） */
    placeholder?: string;
    /** 宽度（不传则由外层布局决定，默认自适应） */
    width?: string;
    disabled?: boolean;
  }>(),
  { placeholder: "全部", width: "", disabled: false },
);

const emit = defineEmits<{
  (e: "update:modelValue", v: string | number): void;
  (e: "change", v: string | number): void;
}>();

/** 清空（clearable 未开）时 Element 会给 undefined：统一回空串，避免下游 undefined 判空 */
function onPick(v: unknown) {
  const val = (v ?? "") as string | number;
  emit("update:modelValue", val);
  emit("change", val);
}
</script>

<template>
  <el-select
    class="f-el-select"
    :model-value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    popper-class="glass-popper"
    :style="width ? { width } : undefined"
    @update:model-value="onPick"
  >
    <el-option v-for="o in options" :key="String(o.value)" :value="o.value" :label="o.label" />
  </el-select>
</template>