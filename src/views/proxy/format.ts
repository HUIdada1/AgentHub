// 反代网关 · 视图共享格式化工具
/** 千分位 */
export const fmtInt = (n: number) => Math.round(n || 0).toLocaleString("en-US");

/** 大数缩写：1,234 → 1.2K */
export function fmtK(n: number): string {
  const v = n || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** 毫秒 → 人类可读延迟 */
export function fmtMs(ms: number): string {
  if (!ms) return "-";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

/** 时间戳 → HH:MM:SS */
export function fmtTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 时间戳 → YYYY-MM-DD */
export function fmtDate(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对时间：3 分钟前（宽容处理 ISO 字符串 / 非法值，不出现 NaN） */
export function fmtAgo(ts: number): string {
  const t = Number(ts);
  if (!t || !Number.isFinite(t)) return "从未";
  const diff = Date.now() - t;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return Math.floor(diff / 86400000) + " 天前";
}

/** 渠道显示名（usage 流水里的 channel id → 中文名） */
export const CHANNEL_NAMES: Record<string, string> = {
  trae: "Trae SOLO CN",
  workbuddy: "WorkBuddy",
  workbuddy_ai: "WorkBuddy AI",
  raccoon: "商汤小浣熊",
};
export const channelName = (id: string) => CHANNEL_NAMES[id] || id || "-";

/** 账号状态 → 标签 */
export const ACCOUNT_STATUS: Record<string, { text: string; cls: string }> = {
  online: { text: "在线", cls: "tag-ok" },
  cooling: { text: "冷却中", cls: "tag-warn" },
  exhausted: { text: "已耗尽", cls: "tag-err" },
  relogin: { text: "需重登", cls: "tag-err" },
  disabled: { text: "已停用", cls: "tag-dim" },
};

/** 账号来源 → 文案 */
export const SOURCE_NAMES: Record<string, string> = {
  scan: "本机导入",
  oauth: "OAuth 登录",
  paste: "手动粘贴",
  json: "文件导入",
};

/** HTTP 状态 → 标签类 */
export const statusCls = (s: number) => (s >= 200 && s < 300 ? "tag-ok" : s >= 500 ? "tag-err" : s >= 400 ? "tag-warn" : "tag-dim");

/** 模型倍率 → 展示文案（null/undefined = 未知） */
export const fmtRate = (r: number | null | undefined) => (r == null || Number.isNaN(Number(r)) ? "—" : `×${Number(r)}`);

/** 模型能力 → 紧凑标签列表：图=图片输入 / 思=思考链 / 工=工具调用；加上下文长度 */
export function capabilityTags(m: { capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean }; contextLength?: number }): string[] {
  const out: string[] = [];
  const c = m.capabilities || {};
  if (c.images) out.push("图");
  if (c.reasoning) out.push("思");
  if (c.tools) out.push("工");
  if (m.contextLength) out.push(fmtK(m.contextLength));
  return out;
}
