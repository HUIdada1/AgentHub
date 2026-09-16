// ECharts 悬停提示浮层：全站统一做成「液态玻璃数据看板」。
// 踩过的坑：用量同步的 --surface / --border 只在 .sync-scope 里定义，用 documentElement 读出来是空串，
// 传给 ECharts 就成了「没有底色」，提示框整个透明。这里只取 :root 上一定存在的玻璃 token。

/** 取 :root 上的 CSS 变量，缺失时回退到框架默认值 */
function rootVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function isLightTheme(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}

/** 玻璃提示浮层的 ECharts tooltip 配置（配色/模糊/描边/投影与框架 .glass 保持一致） */
export function glassTooltip(): Record<string, unknown> {
  const light = isLightTheme();
  return {
    trigger: "axis",
    backgroundColor: rootVar("--glass-b", light ? "rgba(246, 248, 251, 0.72)" : "rgba(13, 16, 21, 0.78)"),
    borderColor: rootVar("--glass-bd", "rgba(255, 255, 255, 0.08)"),
    borderWidth: 1,
    padding: [11, 13],
    textStyle: { color: rootVar("--text", light ? "#0f172a" : "#e8edf2"), fontSize: 12 },
    extraCssText: [
      "border-radius: var(--r-md, 12px)",
      "backdrop-filter: blur(18px) saturate(180%)",
      "-webkit-backdrop-filter: blur(18px) saturate(180%)",
      `box-shadow: inset 0 1px 0 ${rootVar("--glass-hi", "rgba(255, 255, 255, 0.06)")}, 0 18px 44px -14px rgba(0, 0, 0, ${light ? 0.22 : 0.62})`,
    ].join(";"),
  };
}

/** 看板里的行：色点（可选）+ 名称 + 右对齐的数值 + 单位（可选） */
export interface TooltipRow {
  color?: string;
  label: string;
  value: string;
  unit?: string;
}

const MONO = 'font-family:var(--font-mono);font-variant-numeric:tabular-nums';

/** 提示浮层内容骨架：顶部日期行 → 分隔线 → 若干「名称 …… 数值」行 */
export function tooltipCard(date: string, rows: TooltipRow[]): string {
  const head =
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:11px;color:var(--text-3);margin-bottom:7px">` +
    `<span>日期</span><b style="${MONO};font-weight:600;color:var(--text)">${date}</b></div>` +
    `<div style="height:1px;background:var(--line);margin-bottom:7px"></div>`;
  const body = rows
    .map((r) => {
      const dot = r.color ? `<i style="width:7px;height:7px;border-radius:50%;flex:none;background:${r.color}"></i>` : "";
      const unit = r.unit ? `<span style="font-size:10.5px;color:var(--text-3)">${r.unit}</span>` : "";
      return (
        `<div style="display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.9">${dot}` +
        `<span style="color:var(--text-2)">${r.label}</span>` +
        `<b style="${MONO};margin-left:auto;font-weight:700;color:var(--text)">${r.value}</b>${unit}</div>`
      );
    })
    .join("");
  return `<div style="min-width:164px">${head}${body}</div>`;
}

/** 传给 formatter 的 params 元素（只用到这几个字段，避免拉起整份 echarts 类型） */
export interface TooltipParam {
  marker?: string;
  seriesName?: string;
  dataIndex: number;
  value?: number | string;
}

/** 从 series 的 marker 串里抠出颜色，给看板色点用 */
export function markerColor(marker?: string): string | undefined {
  if (!marker) return undefined;
  const m = marker.match(/(#[0-9a-f]{3,8}|rgba?\([^)]+\))/i);
  return m ? m[1] : undefined;
}
