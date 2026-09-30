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

/**
 * 格式化 Token 数量：
 * 智谱不是积分，是 Token，支持换算单位百万、千万、亿，保留合理小数位并去除末尾零。
 */
export function fmtToken(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return "0";
  if (v >= 1e8) {
    const s = (v / 1e8).toFixed(2).replace(/\.?0+$/, "");
    return `${s} 亿`;
  }
  if (v >= 1e7) {
    const s = (v / 1e7).toFixed(2).replace(/\.?0+$/, "");
    return `${s} 千万`;
  }
  if (v >= 1e6) {
    const s = (v / 1e6).toFixed(2).replace(/\.?0+$/, "");
    return `${s} 百万`;
  }
  if (v >= 1e4) {
    const s = (v / 1e4).toFixed(1).replace(/\.?0+$/, "");
    return `${s} 万`;
  }
  return fmtInt(v);
}

/** 渠道余额格式化（针对智谱输出换算后的 Token，其他渠道输出积分） */
export function fmtBalance(val: number, channel?: string): string {
  if (val === -1) return "不限";
  if (channel === "zcode") {
    return fmtToken(val);
  }
  return fmtInt(val);
}

/** 渠道余额单位标签 */
export function balanceUnit(channel?: string): string {
  return channel === "zcode" ? "Tokens" : "积分";
}

/** 渠道显示名（usage 流水里的 channel id → 中文名） */
export const CHANNEL_NAMES: Record<string, string> = {
  trae: "Trae SOLO CN",
  workbuddy: "WorkBuddy CN",
  workbuddy_ai: "WorkBuddy AI",
  raccoon: "商汤小浣熊",
  zcode: "ZCode（智谱）",
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

/** 模型能力 → 可读全称（浮窗用）：把 图/思/工 的缩写还原成完整说法 */
export function capabilityNames(m: { capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean } }): string[] {
  const out: string[] = [];
  const c = m.capabilities || {};
  if (c.images) out.push("图片输入");
  if (c.reasoning) out.push("思考链");
  if (c.tools) out.push("工具调用");
  return out;
}

/**
 * 上下文长度 → 紧凑显示（K/M）。
 * 表格列只有 82px，131072 这样的六位数必然被 nowrap 裁断；用 K/M 缩写后
 * 最长 4 字符（如 1.0M / 131K），列内可完整显示。
 * 不足 1000 按原数；1000~999999 用 K（≥100K 取整、其余 1 位小数）；≥1e6 用 M。
 */
export function fmtCtx(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  if (v >= 1e6) {
    const s = (v / 1e6).toFixed(1).replace(/\.0$/, "");
    return `${s}M`;
  }
  if (v >= 1e3) {
    // 131072 → 131K（三位数不再带小数，避免 131.1K 超长）；4096 → 4.1K；
    // 取整到 1000K 时进位为 1M，避免出现 5 字符的 1000K
    if (v >= 1e5) {
      const k = Math.round(v / 1e3);
      return k >= 1000 ? "1M" : `${k}K`;
    }
    const s = (v / 1e3).toFixed(1).replace(/\.0$/, "");
    return `${s}K`;
  }
  return String(Math.round(v));
}

/**
 * 上下文长度输入框的显示值 → 数字。
 * 输入框允许用户直接写 "128K" / "1M" / "1.5m"（大小写不敏感，允许空格），
 * 编辑回数字后交给 updateModelCustom。纯数字原样返回；无法识别返回 undefined（视为清空）。
 */
export function parseCtxInput(raw: string): number | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const m = /^([0-9]*\.?[0-9]+)\s*([kmb]?)$/i.exec(s);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const unit = m[2].toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1;
  const out = Math.round(num * mult);
  return out > 0 ? out : undefined;
}
