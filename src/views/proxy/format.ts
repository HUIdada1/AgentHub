/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
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
 * 大数中文数量级：万 / 百万 / 千万 / 亿 / 百亿，换算档固定保留两位小数。
 * 渠道额度共用一套换算（积分与 Token 同规）；不足 1 万保持千分位整数。
 */
export function fmtCnAmount(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return "0";
  if (v >= 1e10) return (v / 1e10).toFixed(2) + " 百亿";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e7) return (v / 1e7).toFixed(2) + " 千万";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " 百万";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + " 万";
  return fmtInt(v);
}

/**
 * 格式化 Qoder Credits（浮点计量，实测精度到 1e-16）：
 * 整数部分正常显示，小数最多保留 2 位并去尾零——整数化会丢掉小额消耗的真实计量。
 */
export function fmtCredits(n: number): string {
  const v = Number(n) || 0;
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return fmtInt(v);
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

/** Qoder 双区共用一套展示口径（Credits 浮点 + 领 Credits 动作），判断收敛到一处 */
export const isQoderChannel = (id?: string): boolean => id === "qoder" || id === "qoder_intl";

/** Cline 双池共用同一套展示口径（credit 是浮点计量、无签到活动） */
export const isClineChannel = (id?: string): boolean => id === "cline_free" || id === "cline_pass";

/** 渠道余额格式化（智谱是 Token 不是积分，同走中文数量级换算；Qoder / Cline 保持浮点 Credits） */
export function fmtBalance(val: number, channel?: string): string {
  if (val === -1) return "不限";
  // Accio 是用量百分比（0-100），不是积分：按中文数量级换算会误导，直接原数
  if (channel === "accio" || channel === "accio_cn") return String(Math.round(val * 10) / 10);
  // Qoder / Cline 的 credits 是浮点（实测 0.0066 / -0.0177 级精度），整数化会丢计量
  if (isQoderChannel(channel) || isClineChannel(channel)) return fmtCredits(val);
  return fmtCnAmount(val);
}

/** 渠道余额单位标签 */
export function balanceUnit(channel?: string): string {
  if (channel === "accio" || channel === "accio_cn") return "%";
  if (channel === "zcode") return "Tokens";
  if (isQoderChannel(channel) || isClineChannel(channel)) return "Credits";
  return "积分";
}

/** 「剩余 / 总额」一对，含两个 -1 哨兵的分工：
 *  total === -1 是「上游不给这一包的总额」⇒ 右格给「—」（不是「不限」，那是 remaining=-1）；
 *  两边都是 -1（整号不限）时单位标签也省掉，否则会出现「不限 / 不限 积分」。 */
export function fmtBalancePair(remaining: number, total: number, channel?: string): string {
  const right = total === -1 && remaining !== -1 ? "—" : fmtBalance(total, channel);
  const unit = remaining === -1 && total === -1 ? "" : ` ${balanceUnit(channel)}`;
  return `${fmtBalance(remaining, channel)} / ${right}${unit}`;
}

/** 上游没给包名时的回落名。判据跟着 balanceUnit 的**实际返回值**写：
 *  zcode 的单位是 "Tokens"（复数），照单数 "Token" 比会静默掉进最后一个分支。 */
export function pkgFallbackName(channel?: string): string {
  const u = balanceUnit(channel);
  return u === "Tokens" ? "套餐额度" : u === "积分" ? "积分包" : "额度包";
}

/** 号池逐包表的「总额」「已用」两格，与上面 fmtBalancePair 同一套哨兵口径（别在模板里各写一份）：
 *  总额格直接走 fmtBalance 会把 total=-1 念成「不限」——那是 remaining=-1 的语义，
 *  而 total=-1 是「上游不给这一包的面值」。没有面值 ⇒ 已用同样无从推算，一并给「—」。 */
export function fmtPkgTotal(total: number, remaining: number, channel?: string): string {
  return total === -1 ? (remaining === -1 ? "不限" : "—") : fmtBalance(total, channel);
}
export const fmtPkgUsed = (used: number, total: number, channel?: string) => (total === -1 ? "—" : fmtBalance(used, channel));

/** 本地时区的今天（YYYY-MM-DD）：与主进程 store.dayStr 同口径，签到记录的跨天判定用 */
export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 渠道**动作类型** → 展示文案。
 *
 * 依据 13/14/15 号报告 §1.3：号池原有矩阵只有 checkin / checkinStatus 两列，**没有区分
 * 「签到」与「登录领取」**——不同渠道的上游要求本就不同（签到=按自然日打卡；登录领取=
 * 登录/每日首次登录即发，服务端按日幂等），混为一谈会让文案与判据都错位。
 *
 * 取值由号池 `store.cjs` 的 `CHANNELS[].checkinKind` 给出，经 `index.cjs` 渠道视图的
 * `...c` 展开（那里直接遍历 `store.CHANNELS`）传到前端；`store.channelList()` 也显式
 * 投影了同一字段。未核实的一律 `"unknown"`，**不臆断**。
 *
 * 与 `checkinLabels()` 的分工：本函数说的是「这家属于什么动作类型」（分类，只读展示）；
 * `checkinLabels()` 说的是「这家的按钮该叫什么字」（渠道化文案）。两者不互相替代。
 */
export const CHECKIN_KIND_NAMES: Record<string, string> = {
  signin: "签到",
  login_grant: "登录领取",
  claim: "领取",
  both: "签到+登录领取",
  unknown: "未核实",
};
/** 动作类型 → 中文文案；未知/缺省一律「未核实」（与 store.cjs 的缺省口径一致） */
export const checkinKindName = (kind?: string) => CHECKIN_KIND_NAMES[kind || "unknown"] || "未核实";

/**
 * 签到动作的渠道化文案：各渠道"领取"形态不同（加油包/Credits 一次性领取、zcode 领奖励、
 * 其余每日签到），按钮/完成态/详情标题统一吃这一份，避免把"领加油包"写成"签到"
 */
export function checkinLabels(channel?: string): {
  /** 设置按钮：自动签到 / 自动领加油包 / 自动领 Credits / 自动领取 */
  auto: string;
  /** 工具栏动作按钮：一键签到 / 领加油包 / 领 Credits / 一键领取 */
  run: string;
  /** 行内动作按钮（窄）：签到 / 领加油包 / 领 Credits / 领取 */
  shortRun: string;
  /** 全部完成后的工具栏按钮：签到成功 / 领取成功 */
  done: string;
  /** 行内完成态：已签到 / 已领取 */
  shortDone: string;
  /** 行内失败态：签到失败 / 领取失败 */
  shortFail: string;
  /** 详情弹窗标题词：签到详情 / 领取详情 */
  detail: string;
} {
  if (channel === "workbuddy_ai") {
    return { auto: "自动领加油包", run: "领加油包", shortRun: "领加油包", done: "领取成功", shortDone: "已领取", shortFail: "领取失败", detail: "领取详情" };
  }
  if (isQoderChannel(channel)) {
    return { auto: "自动领 Credits", run: "领 Credits", shortRun: "领 Credits", done: "领取成功", shortDone: "已领取", shortFail: "领取失败", detail: "领取详情" };
  }
  if (channel === "zcode") {
    return { auto: "自动领取", run: "一键领取", shortRun: "领取", done: "领取成功", shortDone: "已领取", shortFail: "领取失败", detail: "领取详情" };
  }
  // CodeArts 的「签到」就是每日福利（三段式领取，见 codearts/welfare.cjs），照它的实际形态叫「领福利」
  if (channel === "codearts") {
    return { auto: "自动领福利", run: "一键领福利", shortRun: "领福利", done: "领取成功", shortDone: "已领取", shortFail: "领取失败", detail: "福利领取详情" };
  }
  return { auto: "自动签到", run: "一键签到", shortRun: "签到", done: "签到成功", shortDone: "已签到", shortFail: "签到失败", detail: "签到详情" };
}

/** 渠道成本档 → 展示文案（cost-first 路由排序的标注；'' = 未标注按普通） */
export const COST_TIER_NAMES: Record<string, string> = {
  free: "免费",
  low: "低成本",
  normal: "普通",
};
export const costTierName = (tier?: string) => COST_TIER_NAMES[tier || "normal"] || "普通";

/** 渠道显示名（usage 流水里的 channel id → 中文名） */
export const CHANNEL_NAMES: Record<string, string> = {
  trae: "Trae SOLO CN",
  workbuddy: "WorkBuddy CN",
  workbuddy_ai: "WorkBuddy AI",
  raccoon: "商汤小浣熊",
  modelscope: "ModelScope（魔搭）",
  lobster: "LobsterAI（有道）",
  zcode: "ZCode（智谱）",
  catpaw: "CatPaw（美团）",
  qoder: "Qoder CN",
  qoder_intl: "Qoder International",
  autoclaw: "AutoClaw 国内版",
  autoclaw_intl: "AutoClaw 国际版",
  cline_free: "Cline Free",
  cline_pass: "Cline Pass",
  accio: "Accio",
  accio_cn: "Accio 国内版",
  codearts: "CodeArts（华为云）",
  loomy: "Loomy（讯飞）",
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
 * 记忆中枢的模型行也要用同一套缩写，实现已提到 utils/format.ts（此处转出保持既有引用不变）。
 */
export { fmtCtx } from "../../utils/format";

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
