// 行级 diff（LCS），输出左右两列等长的行序列，方便并排渲染
export type DiffLine = { text: string; kind: "ctx" | "del" | "add" | "gap" };

export function sideBySideDiff(leftText: string, rightText: string): { left: DiffLine[]; right: DiffLine[] } {
  const a = leftText.split("\n");
  const b = rightText.split("\n");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push({ text: a[i], kind: "ctx" });
      right.push({ text: b[j], kind: "ctx" });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.push({ text: a[i], kind: "del" });
      right.push({ text: "", kind: "gap" });
      i++;
    } else {
      left.push({ text: "", kind: "gap" });
      right.push({ text: b[j], kind: "add" });
      j++;
    }
  }
  while (i < n) { left.push({ text: a[i], kind: "del" }); right.push({ text: "", kind: "gap" }); i++; }
  while (j < m) { left.push({ text: "", kind: "gap" }); right.push({ text: b[j], kind: "add" }); j++; }
  return { left, right };
}

export function diffStats(leftText: string, rightText: string): { del: number; add: number } {
  const { left, right } = sideBySideDiff(leftText, rightText);
  return { del: left.filter((l) => l.kind === "del").length, add: right.filter((l) => l.kind === "add").length };
}
