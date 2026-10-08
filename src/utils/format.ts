export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

export function fmtTime(ms: number | string | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortHash(h: string | undefined): string {
  return h ? h.slice(0, 8) + "…" : "—";
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
