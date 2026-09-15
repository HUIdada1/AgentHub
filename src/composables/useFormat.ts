// 数字 / 日期格式化工具

/**
 * token 数值中文单位换算（全站统一口径，含图表与托盘）：
 * - 数值 < 1,000 时显示原始整数；
 * - 千(÷1e3)、万(÷1e4)、百万(÷1e6)、千万(÷1e7)、亿(÷1e8)、百亿(÷1e10，上限延伸)；
 * - 带单位时统一保留 2 位小数，整数部分自动千分位（数值 ≥1e13 才会出现）。
 */
export function formatToken(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  const units: [number, string][] = [
    [1e10, "百亿"],
    [1e8, "亿"],
    [1e7, "千万"],
    [1e6, "百万"],
    [1e4, "万"],
    [1e3, "千"],
  ];
  for (const [div, unit] of units) {
    if (abs >= div) {
      return (n / div).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + unit;
    }
  }
  return Math.round(n).toLocaleString("en-US");
}

/** 完整千分位 */
export function formatInteger(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 百分比（0~1 → "95.7%"） */
export function formatPercent(rate: number, digits = 1): string {
  if (!isFinite(rate)) return "0%";
  return (rate * 100).toFixed(digits) + "%";
}

/** 费用：聚合卡显示 2 位（¥1,234.56），明细/小字传小数位 4（¥0.0182）；符号随显示币种（CNY=¥ / USD=$） */
export function formatCost(n: number | null | undefined, digits = 2, currency = "CNY"): string {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  const symbol = currency === "USD" ? "$" : "¥";
  return symbol + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function timeAgo(ts: number | null): string {
  if (!ts) return "从未同步";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/** 时间戳 → 短日期 "09-04 09:53" */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期字符串 → "9月4日" */
export function humanDate(s: string): string {
  const [, m, d] = s.split("-");
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}
