/**
 * 记忆中枢 · 纯函数导航与跨 Tab 状态推导模块
 * 零 Vue/Pinia 依赖，完全可在纯 Node 环境下单元测试
 */

export type MemPage = "dashboard" | "browse" | "projects" | "profile" | "agents" | "index" | "auto" | "import" | "sync";
export type BrowseView = "list" | "heatmap" | "review" | "trash";
export type ReviewKind = "supersede" | "classify" | "dedup";

export interface ReviewCounts {
  supersede: number;
  classify: number;
  dedup: number;
}

/**
 * 待确认三队列 -> 推导应落到的 tab：
 * 规则：优先落到积压条数最多且非空的队列；如果全为空，兜底为 "supersede"；平局按 supersede > classify > dedup
 */
export function pickReviewTab(counts: ReviewCounts): ReviewKind {
  const s = counts.supersede || 0;
  const c = counts.classify || 0;
  const d = counts.dedup || 0;

  if (s === 0 && c === 0 && d === 0) return "supersede";

  const max = Math.max(s, c, d);
  if (s === max) return "supersede";
  if (c === max) return "classify";
  return "dedup";
}

export interface NavTarget {
  page: MemPage;
  view?: BrowseView;
  kind?: ReviewKind;
  prefilter?: string;
  project?: string;
  counts?: ReviewCounts;
}

export interface NavResolution {
  page: MemPage;
  view?: BrowseView;
  tab?: ReviewKind;
  prefilter?: string;
  project?: string;
}

/**
 * 记忆中枢内跳转的唯一解析出口：返回目标页面 + 视图 + tab + 过滤条件，不产生外部副作用
 */
export function resolveMemNav(target: NavTarget): NavResolution {
  const result: NavResolution = { page: target.page };

  if (target.page === "browse") {
    result.view = target.view || "list";
    if (result.view === "review") {
      result.tab = target.kind || (target.counts ? pickReviewTab(target.counts) : "supersede");
    }
    if (target.prefilter) {
      result.prefilter = target.prefilter;
    }
  }

  if (target.page === "projects" && target.project) {
    result.project = target.project;
  }

  return result;
}
