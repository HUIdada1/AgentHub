/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 配置元数据表：每个旋钮的类型/默认/范围/热生效/分组。
// UI 依据本表自动渲染表单（CfgAutoForm），新增配置项只需在此加一行。
"use strict";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "custom"];
const API_FORMATS = ["anthropic_messages", "chat_completions", "responses"];

// type: number | boolean | string | enum | path | multiselect | list | map
//   | apiformat | apikey | modeltable | effort | providerlist | orderlist
const SCHEMA = {
  // ===== 存储与路径 =====
  "storage.root":              { type: "path",    def: "",     label: "记忆根目录", group: "存储", hot: false, desc: "空 = 默认 <用户文件夹>/AgentHub/memory；改动后需重启并自动迁移" },
  "storage.atomicWrite":       { type: "boolean", def: true,   label: "原子写", group: "存储", hot: true },
  "storage.backupBeforeWrite": { type: "boolean", def: true,   label: "改写前备份 .bak", group: "存储", hot: true },
  "storage.backupKeep":        { type: "number",  def: 5, min: 1, max: 50, label: "备份保留份数", group: "存储", hot: true },
  "storage.maxFileSizeKB":     { type: "number",  def: 512, min: 16, max: 8192, label: "单文件上限 (KB)", group: "存储", hot: true },
  "storage.trashKeepDays":     { type: "number",  def: 90, min: 7, max: 365, label: "回收站保留天数", group: "存储", hot: true },

  // ===== 索引与检索 =====
  "index.dualIndex":        { type: "boolean", def: true,        label: "双索引（保真+标题加权）", group: "索引", hot: false },
  "index.titleBoost":       { type: "number",  def: 3, min: 1, max: 10, label: "标题权重倍数", group: "索引", hot: false, desc: "写入侧重复次数；改动需重建索引" },
  "index.debounceMs":       { type: "number",  def: 2000, min: 200, max: 60000, label: "索引增量防抖 (ms)", group: "索引", hot: true },
  "search.recallTopK":      { type: "number",  def: 20, min: 5, max: 200, label: "检索召回条数", group: "检索", hot: true },
  "search.finalTopK":       { type: "number",  def: 8,  min: 1, max: 50,  label: "最终返回条数", group: "检索", hot: true },
  "search.timeDecayHalfLife": { type: "number", def: 30, min: 0, max: 365, label: "时间衰减半衰期（天，0=不衰减）", group: "检索", hot: true },
  "search.weightBm25":      { type: "number",  def: 0.5,  min: 0, max: 1, step: 0.05, label: "权重·相关度", group: "检索", hot: true },
  "search.weightRecency":   { type: "number",  def: 0.15, min: 0, max: 1, step: 0.05, label: "权重·时间", group: "检索", hot: true },
  "search.weightImportance":{ type: "number",  def: 0.1,  min: 0, max: 1, step: 0.05, label: "权重·重要度", group: "检索", hot: true },
  "search.weightAffinity":  { type: "number",  def: 0.15, min: 0, max: 1, step: 0.05, label: "权重·项目/Agent 亲和", group: "检索", hot: true },
  "search.weightGraph":     { type: "number",  def: 0.05, min: 0, max: 1, step: 0.05, label: "权重·图扩散", group: "检索", hot: true },
  "search.weightLayer":     { type: "number",  def: 0.05, min: 0, max: 1, step: 0.05, label: "权重·层级", group: "检索", hot: true },
  "search.synonymsEnabled": { type: "boolean", def: true, label: "同义词表扩展", group: "检索", hot: true },
  "search.graphExpansionDepth": { type: "number", def: 1, min: 0, max: 3, label: "图扩散深度", group: "检索", hot: true },
  "search.graphExpansionMax":   { type: "number", def: 5, min: 0, max: 30, label: "图扩散最多补充条数", group: "检索", hot: true },

  // ===== 归类引擎 =====
  "classify.fuzzyThreshold":    { type: "number", def: 0.62, min: 0.3, max: 1, step: 0.01, label: "模糊匹配阈值", group: "归类", hot: true },
  "classify.gitPreferred":      { type: "boolean", def: true, label: "Git 地址优先", group: "归类", hot: true },
  "classify.autoCreateProject": { type: "boolean", def: false, label: "模糊失败自动建新项目", group: "归类", hot: true },
  "classify.pathReverse":       { type: "boolean", def: true, label: "会话目录名反解项目", group: "归类", hot: true },

  // ===== Agent 接入 =====
  "agents.enabled":        { type: "multiselect", def: ["zcode", "codex", "workbuddy", "claude"], options: ["zcode", "codex", "workbuddy", "claude"], label: "启用的 Agent", group: "Agent 接入", hot: true },
  "agents.custom":         { type: "list", def: [], label: "自定义 Agent（本机）", group: "Agent 接入", hot: true, desc: "名称 + 配置文件路径 + 格式，用于生成接入片段" },
  "agents.autoVerify":     { type: "boolean", def: true, label: "接入后自动校验", group: "Agent 接入", hot: true },
  "agents.verifyInterval": { type: "number", def: 300, min: 30, max: 3600, label: "连接巡检间隔（秒）", group: "Agent 接入", hot: true },
  "agents.injectAgentsMd": { type: "boolean", def: true, label: "注入 AGENTS.md 受控块", group: "Agent 接入", hot: true },
  "agents.coreMaxTokens":    { type: "number", def: 800,  min: 200, max: 2000, label: "memory_core token 上限", group: "Agent 接入", hot: true },
  "agents.digestMaxLines":   { type: "number", def: 200,  min: 50, max: 1000, label: "memory_digest 行数上限", group: "Agent 接入", hot: true },
  "agents.searchMaxTokens":  { type: "number", def: 1200, min: 200, max: 4000, label: "memory_search token 上限", group: "Agent 接入", hot: true },

  // ===== 深层记忆与 AI =====
  "deep.enabled":            { type: "boolean", def: true, label: "深层记忆总开关", group: "深层记忆", hot: true },
  "deep.batchSize":          { type: "number", def: 50, min: 5, max: 500, label: "单次处理条数", group: "深层记忆", hot: true },
  "deep.personaEnabled":     { type: "boolean", def: true, label: "生成人格画像", group: "深层记忆", hot: true },
  "deep.personaMinMemories": { type: "number", def: 30, min: 5, max: 500, label: "画像最少记忆数", group: "深层记忆", hot: true },
  "deep.evidenceRequired":   { type: "boolean", def: true, label: "画像结论必须附证据链", group: "深层记忆", hot: true },
  "deep.distillMaxPerProject": { type: "number", def: 200, min: 20, max: 1000, label: "单项目蒸馏素材上限", group: "深层记忆", hot: true },

  // ===== 自动化 =====
  "auto.enabled":         { type: "boolean", def: true, label: "自动化总开关", group: "自动化", hot: true },
  "auto.dailyTokenLimit": { type: "number", def: 200000, min: 0, label: "日 token 预算（0=不限）", group: "自动化", hot: true },
  "auto.overBudgetAction":{ type: "enum", def: "pause", options: ["pause", "ignore"], label: "超预算行为", group: "自动化", hot: true },
  "auto.logKeepDays":     { type: "number", def: 30, min: 1, max: 365, label: "任务日志保留天数", group: "自动化", hot: true },
  "auto.logKeepCount":    { type: "number", def: 200, min: 20, max: 2000, label: "任务日志保留条数", group: "自动化", hot: true },
  "auto.tasks": {
    type: "map",
    def: {
      extract: { enabled: true, intervalMin: 30, batchSize: 20, thresholdCount: 20 },
      summarize: { enabled: false, intervalMin: 30, batchSize: 20 },
      tag: { enabled: false, intervalMin: 30, batchSize: 20 },
      classify: { enabled: true, intervalMin: 60 },
      supersede: { enabled: false, daily: "23:00", autoApplyConfidence: 0.9 },
      distill: { enabled: false, daily: "23:30" },
      consolidate: { enabled: false, weekly: 0, weeklyTime: "02:00" },
      profile: { enabled: false, weekly: 0, weeklyTime: "03:00" },
      "index-scan": { enabled: true, intervalMin: 360 },
    },
    label: "任务开关与节奏",
    desc: "默认开：零/低消耗的 extract、classify、index-scan；耗 token 的任务默认关，开启时页面会提示预计消耗",
    group: "自动化",
    hot: true,
  },

  // ===== 双时间轴（事实失效） =====
  "timeline.enabled":       { type: "boolean", def: true, label: "启用双时间轴", group: "深层记忆", hot: true },
  "timeline.autoDetect":    { type: "boolean", def: true, label: "蒸馏时自动识别取代", group: "深层记忆", hot: true },
  "timeline.requireConfirm":{ type: "boolean", def: true, label: "失效判定需人工确认", group: "深层记忆", hot: true, desc: "关掉后仅高置信建议自动应用（见 auto.tasks.supersede.autoApplyConfidence）" },

  // ===== 模型供应商与路由 =====
  "models.sourceOrder":  { type: "orderlist", def: ["gateway", "custom", "degrade"], label: "模型来源优先级", group: "模型与网关", hot: true },
  "models.providers":    { type: "providerlist", def: [], label: "自定义供应商", group: "模型与网关", hot: true },
  "models.models":       { type: "modeltable", def: [], label: "模型池", group: "模型与网关", hot: true },
  "models.routing":      { type: "list", def: [], label: "按标签降级链", group: "模型与网关", hot: true },
  "models.tagDefs":      { type: "list", def: ["light", "heavy", "dedup", "classify", "distill", "extract", "tag", "summarize", "profile"], label: "用途标签集", group: "模型与网关", hot: true },
  "models.timeout":      { type: "number", def: 60, min: 5, max: 600, label: "请求超时（秒）", group: "模型与网关", hot: true },
  "models.maxRetries":   { type: "number", def: 3, min: 0, max: 10, label: "失败重试次数", group: "模型与网关", hot: true },
  "models.gatewayUrl":   { type: "string", def: "", label: "本机网关地址覆盖", group: "模型与网关", hot: true, desc: "空 = 读 proxy 模块配置" },
  "models.taskEffort":   { type: "map", def: { extract: "low", tag: "minimal", classify: "minimal", summarize: "low", distill: "medium", profile: "high", dedup: "low" }, label: "各任务思考强度覆盖", group: "模型与网关", hot: true },
  "models.degrade":      { type: "map", def: { enabled: true, effort: "minimal" }, label: "兜底降级", group: "模型与网关", hot: true },

  // ===== 去重 =====
  "dedup.enabled":              { type: "boolean", def: true, label: "去重总开关", group: "去重", hot: true },
  "dedup.l1.enabled":           { type: "boolean", def: true, label: "L1 精确哈希去重", group: "去重", hot: true },
  "dedup.l1.normalizeLevel":    { type: "enum", def: "full", options: ["none", "trim", "full"], label: "归一化强度", group: "去重", hot: true },
  "dedup.l2.enabled":           { type: "boolean", def: true, label: "L2 文本近似去重", group: "去重", hot: true },
  "dedup.l2.autoMergeThreshold":{ type: "number", def: 0.9, min: 0.5, max: 1, step: 0.01, label: "L2 自动合并阈值", group: "去重", hot: true },
  "dedup.l2.candidateThreshold":{ type: "number", def: 0.72, min: 0.3, max: 1, step: 0.01, label: "L2 候选阈值", group: "去重", hot: true },
  "dedup.l2.wDice":             { type: "number", def: 0.5, min: 0, max: 1, step: 0.05, label: "L2 集合相似度权重", group: "去重", hot: true },
  "dedup.l2.wEdit":             { type: "number", def: 0.3, min: 0, max: 1, step: 0.05, label: "L2 编辑距离权重", group: "去重", hot: true },
  "dedup.l2.wTitle":            { type: "number", def: 0.2, min: 0, max: 1, step: 0.05, label: "L2 标题权重", group: "去重", hot: true },
  "dedup.l3.topK":              { type: "number", def: 8, min: 1, max: 30, label: "L3 BM25 候选条数", group: "去重", hot: true },
  "dedup.l4.enabled":           { type: "boolean", def: true, label: "L4 语义判定（耗 token）", group: "去重", hot: true },
  "dedup.l4.minCandidateScore": { type: "number", def: 0.62, min: 0, max: 1, step: 0.01, label: "L4 触发最低候选分", group: "去重", hot: true },
  "dedup.l4.autoUpdateThreshold": { type: "number", def: 0.8, min: 0, max: 1, step: 0.01, label: "L4 UPDATE 自动执行置信", group: "去重", hot: true },
  "dedup.l4.batchSize":         { type: "number", def: 20, min: 1, max: 50, label: "L4 单批条数", group: "去重", hot: true },
  "dedup.l4.autoDelete":        { type: "boolean", def: false, label: "允许自动删除（默认永久关闭）", group: "去重", hot: true },
  "dedup.duplicateIdentityTypes": { type: "multiselect", def: ["incident", "fix", "daily", "log"], options: ["incident", "fix", "daily", "log", "note", "session"], label: "允许同身份多条目的类别", group: "去重", hot: true },
  "dedup.pendingWarnThreshold": { type: "number", def: 50, min: 1, max: 999, label: "队列积压告警阈值", group: "去重", hot: true },

  // ===== 导入 =====
  "import.dryRunFirst":   { type: "boolean", def: true, label: "导入前必须干跑预览", group: "导入", hot: true },
  "import.batchSize":     { type: "number", def: 1000, min: 20, max: 2000, label: "每批写入条数", group: "导入", hot: true, desc: "批量导入时一批写多少条；批越大，同一个 daily 文件的整份重写次数越少（写入更快），但单批失败影响的条数也越多" },
  "import.maxBatchBytes": { type: "number", def: 104857600, min: 1048576, label: "单批/解压字节上限", group: "导入", hot: true },
  "import.sensitiveSkip": { type: "boolean", def: true, label: "疑似敏感内容默认跳过", group: "导入", hot: true },
  "import.sources": {
    type: "list",
    def: [
      { id: "zcode-db", name: "ZCode 会话库", kind: "sqlite", path: "~/.zcode/cli/db/db.sqlite", enabled: true, priority: 1 },
      { id: "zcode-tx", name: "ZCode 实时日志（流式增量，与会话库重复）", kind: "jsonl", path: "~/.zcode/cli/agents", enabled: false, priority: 2 },
      { id: "claude", name: "Claude Code 会话", kind: "jsonl", path: "~/.claude/projects", enabled: true, priority: 3 },
      { id: "codex", name: "Codex 会话", kind: "jsonl", path: "~/.codex/sessions", enabled: true, priority: 4 },
      { id: "workbuddy", name: "WorkBuddy 会话", kind: "jsonl", path: "~/.workbuddy-ai", enabled: true, priority: 5 },
      { id: "notes-md", name: "Markdown 笔记目录", kind: "md", path: "", enabled: false, priority: 6 },
    ],
    label: "导入来源清单",
    desc: "路径/格式/启用/优先级/表映射；「Markdown 笔记目录」默认关，选好路径再开",
    group: "导入",
    hot: true,
  },
  "import.md.observationMarkers": { type: "boolean", def: true, label: "解析 - [xxx] 行首标记", group: "导入", hot: true },
  "import.md.extractTags":        { type: "boolean", def: true, label: "解析行内 #标签", group: "导入", hot: true },

  // ===== 隐私 =====
  "privacy.redact":          { type: "boolean", def: true, label: "写入前脱敏", group: "隐私", hot: true },
  "privacy.redactRules":     { type: "list", def: ["sk-[A-Za-z0-9_-]{8,}", "Bearer\\s+[A-Za-z0-9._-]+", "AKIA[0-9A-Z]{16}", "password\\s*[:=]\\s*\\S+", "1[3-9]\\d{9}", "\\b\\d{17}[\\dXx]\\b"], label: "脱敏规则（正则）", group: "隐私", hot: true },
  "privacy.pause":           { type: "boolean", def: false, label: "隐私模式（暂停一切采集）", group: "隐私", hot: true },
  "privacy.localOnlyProjects": { type: "multiselect", def: [], label: "永不上传的项目", group: "隐私", hot: true },

  // ===== WebDAV 同步 =====
  "sync.enabled":      { type: "boolean", def: true, label: "同步总开关", group: "同步", hot: true },
  "sync.auto":         { type: "boolean", def: true, label: "自动定时同步", group: "同步", hot: true },
  "sync.intervalMin":  { type: "number", def: 60, min: 5, max: 1440, label: "同步间隔（分钟）", group: "同步", hot: true },
  "sync.packSizeLimitMB": { type: "number", def: 50, min: 1, max: 2048, label: "单包体积上限 (MB)", group: "同步", hot: true },
  "sync.excludeIndex": { type: "boolean", def: true, label: "索引库不入同步包", group: "同步", hot: true },

  // ===== 界面 =====
  "ui.pageSize":        { type: "number", def: 50, min: 10, max: 500, label: "列表每页条数", group: "界面", hot: true },
  "ui.defaultTab":      { type: "enum", def: "dashboard", options: ["dashboard", "browse", "review", "projects", "profile", "agents", "index", "auto", "import", "sync"], label: "默认页签", group: "界面", hot: true },
  "ui.realtimeRefresh": { type: "boolean", def: true, label: "浏览页实时刷新", group: "界面", hot: true },
  // 默认只开日常要用的六个：深层画像 / Agent 接入 / 检索与索引 / 导入与去重 属「装一次」「排障才来」，按需勾选
  "ui.tabs":            { type: "orderlist", def: ["dashboard", "browse", "review", "projects", "auto", "sync"], label: "页签显隐与排序", group: "界面", hot: true, desc: "未列出的页签不显示（白名单）；收件箱、画像、Agent 接入等可按需勾回来" },
};

function flattenDefaults() {
  const out = {};
  for (const [key, meta] of Object.entries(SCHEMA)) out[key] = meta.def;
  return out;
}

function defaultConfig() {
  const flat = flattenDefaults();
  const root = {};
  for (const [key, value] of Object.entries(flat)) {
    const segs = key.split(".");
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (typeof cur[k] !== "object" || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[segs[segs.length - 1]] = value;
  }
  return root;
}

function validateValue(meta, value) {
  if (value === undefined || value === null) return null;
  switch (meta.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "必须是数字";
      if (meta.min !== undefined && value < meta.min) return `不能小于 ${meta.min}`;
      if (meta.max !== undefined && value > meta.max) return `不能大于 ${meta.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "必须是布尔值";
    case "string":
    case "path":
      return typeof value === "string" ? null : "必须是字符串";
    case "enum":
      return meta.options.includes(value) ? null : `必须是 ${meta.options.join("/")} 之一`;
    case "multiselect":
    case "orderlist":
      if (!Array.isArray(value)) return "必须是数组";
      if (meta.options && meta.options.length) {
        const bad = value.filter((v) => !meta.options.includes(v));
        if (bad.length && meta.type === "multiselect") return `含未知选项：${bad.join(", ")}`;
      }
      return null;
    case "effort":
      return EFFORTS.includes(value) ? null : `思考强度必须是 ${EFFORTS.join("/")} 之一`;
    case "apiformat":
      return API_FORMATS.includes(value) ? null : "API 格式必须是 anthropic_messages/chat_completions/responses 之一";
    case "apikey":
      return typeof value === "string" ? null : "API Key 必须是字符串";
    case "list":
    case "providerlist":
    case "modeltable":
      return Array.isArray(value) ? null : "必须是数组";
    case "map":
      return value !== null && typeof value === "object" && !Array.isArray(value) ? null : "必须是对象";
    default:
      return null;
  }
}

module.exports = { SCHEMA, defaultConfig, flattenDefaults, validateValue, EFFORTS, API_FORMATS };
