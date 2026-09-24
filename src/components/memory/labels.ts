/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 任务/内置标签的中文显示名：界面一律「中文（英文）」，英文保留便于对照后端配置值
const LABELS: Record<string, string> = {
  extract: "提取",
  summarize: "摘要",
  tag: "打标",
  classify: "分类",
  supersede: "失效判定",
  distill: "蒸馏",
  consolidate: "合并",
  profile: "画像",
  dedup: "去重",
  light: "轻量",
  heavy: "重型",
};

export function taskLabel(key: string): string {
  const zh = LABELS[key];
  return zh ? `${zh}（${key}）` : key;
}

/** 只要中文名（表格窄列用） */
export function taskLabelZh(key: string): string {
  return LABELS[key] || key;
}

const EFFORT_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  custom: "自定义",
};

export function effortLabel(key: string): string {
  const zh = EFFORT_LABELS[key];
  return zh ? `${zh}（${key}）` : key;
}
