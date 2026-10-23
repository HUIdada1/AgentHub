/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 配置读写（Node 主进程侧）：框架配置（主题 / 模块顺序）与技能仓库配置（工具 / WebDAV / 调度）
// 统一落在 Windows 惯例的用户应用数据目录（Electron userData = %APPDATA%\AgentHub），
// 深合并默认值，临时文件原子落盘；WebDAV 密码用系统级密钥加密存储。
// AGENT_SKILLS_HOME 环境变量可把中央技能仓库指到临时目录（自测脚本用），默认 ~/.agent_skills
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Electron app（主进程）；纯 Node 脚本直跑（tools 自测等）时为 null
let electronApp = null;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object" && electron.app) electronApp = electron.app;
} catch {
  /* 非 Electron 环境 */
}

/** 便携版是临时解压目录，开机自启注册的路径退出即失效（自启开关要在设置页禁用） */
function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

// 凭据信封按前缀分派，加密后端二选一（桌面 safeStorage / headless AES）：
//   enc:v1: — Electron safeStorage（Windows 下即 DPAPI），OS 用户绑定、原理上不可跨机
//   enc:v2: — AES-256-GCM，密钥取自 AGENTHUB_SECRET_KEY，桌面与 headless 形态通用
// 两种前缀并存是刻意的：统一成"通用信封"只会退化成把密钥一起搬走（等于没有加密）。
// 无 safeStorage 且无 key 时保持明文降级（自测环境依赖此行为）；生产形态由网关入口强制 key
let safeStorage = null;
try { safeStorage = require("electron").safeStorage; } catch { /* 自测环境无 electron */ }
const ENC_PREFIX = "enc:v1:";
const AES_PREFIX = "enc:v2:";

function aesKey() {
  const secret = String(process.env.AGENTHUB_SECRET_KEY || "");
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

/** 是否本模块产出的密文信封（敏感 meta 判定用：enc:v2: 同样算密文，不能当明文剥掉） */
function isEncrypted(v) {
  return typeof v === "string" && (v.startsWith(ENC_PREFIX) || v.startsWith(AES_PREFIX));
}

function encryptSecret(plain) {
  const s = String(plain || "");
  if (!s || isEncrypted(s)) return s; // 空值或已是密文不重复加密
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return ENC_PREFIX + safeStorage.encryptString(s).toString("base64");
  }
  const key = aesKey();
  if (!key) return s; // 明文降级（历史行为；生产形态的 key 由网关入口把关）
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  return AES_PREFIX + [nonce, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

function decryptSecret(stored) {
  const s = String(stored || "");
  if (s.startsWith(AES_PREFIX)) {
    const key = aesKey();
    if (!key) return ""; // 密钥缺失/不符：与 enc:v1: 跨环境解不开同语义，交由上层"保留磁盘密文"的保护兜底
    try {
      const [n, tag, ct] = s.slice(AES_PREFIX.length).split(".");
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(n, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch {
      return ""; // 密钥不符或密文损坏，让用户重填
    }
  }
  if (!s.startsWith(ENC_PREFIX)) return s; // 明文（降级环境存的）直接用
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return ""; // 密文来自其他机器解不开，让用户重填
  }
}

/** 数据目录：Electron 用 userData（%APPDATA%\AgentHub，目录名由 main.cjs 的 setName 决定）；
 *  纯 Node 环境退回 %APPDATA%\AgentHub（无则用户主目录），保证脚本直跑与主进程读同一份配置。
 *  AGENTHUB_DATA_DIR 显式指定时始终优先：自测脚本的沙箱钩子（不设即无感，生产零影响） */
function dataDir() {
  const dir = process.env.AGENTHUB_DATA_DIR || (electronApp ? electronApp.getPath("userData") : path.join(process.env.APPDATA || os.homedir(), "AgentHub"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 中央技能仓库目录：真身 skills / reports / .trash 与 manifest.json 都在这里。
 *  与 Agent_skills 共用同一份中央仓库，装了两个应用也指向同一批真身 */
function hubDir() {
  const custom = process.env.AGENT_SKILLS_HOME;
  if (custom && custom.trim()) return path.resolve(custom.trim());
  return path.join(os.homedir(), ".agent_skills");
}

function ensureHub() {
  const root = hubDir();
  for (const sub of ["skills", "reports", ".trash"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

/** 配置文件路径 */
function configPath() {
  return path.join(dataDir(), "config.json");
}

/** 默认配置（与前端 src/types/index.ts 及 stores/app.ts 保持一致） */
function defaultConfig() {
  return {
    theme: "dark",
    // 界面动效总开关（装饰层，默认开启）；粒子尘场 / 光池追随是它的两个独立子开关，默认关闭
    // （两者是背景层最吃性能的两项，开启前设置页会给性能提示）；个性化鼠标样式默认开启
    fx: true,
    fxParticles: false,
    fxPools: false,
    fxCursor: true,
    // 左栏四大模块的显示顺序（用户在「设置 · 个性化」中调整）
    /** 远程网关实例（桌面连远程 Docker 版）：tokenEnc 以 enc:v1: 加密落盘，列表接口只回 hasToken */
    remoteTargets: [],
    remoteActiveId: "local",
    // 五大模块的显示顺序（用户在「设置 · 个性化」中调整）；prompts = 提示词库（第五板块）
    moduleOrder: ["skills", "sync", "proxy", "memory", "prompts"],
    // ===== 板块启用开关（issue #91 轻量模式）：关闭后左上角置灰不可点、后台完全不运行。
    // 唯一写入口是 module_toggle IPC（主进程读改写），设置页表单不拥有它；
    // 记忆中枢旧版 memory.enabled=false 由 loadConfig 迁移到这里，旧字段保留但不再被读取
    modules: {
      skills: { enabled: true },
      sync: { enabled: true },  // 用量统计（键名与 moduleOrder/前端 ModuleKey 对齐）
      proxy: { enabled: true },
      memory: { enabled: true },
      prompts: { enabled: true }, // 提示词库（第五板块）
    },
    // ===== 技能仓库 =====
    // 各工具候选路径按顺序探测，取第一个存在的
    tools: {
      zcode: { enabled: true, paths: [".zcode/skills"] },
      codex: { enabled: true, paths: [".codex/skills"] },
      claude: { enabled: true, paths: [".claude/skills"] },
      antigravity: { enabled: true, paths: [".gemini/antigravity/skills", ".gemini/config/skills"] },
      agents: { enabled: true, paths: [".agents/skills"] },
    },
    customDirs: [],
    mountMode: "junction", // copy 是兜底
    l3: { enabled: false, threshold: 0.85 },
    trashDays: 7,
    update: { channel: "stable", autoCheck: true, notifiedVersion: "" },
    // WebDAV 跨设备同步（password 落盘是密文，内存里是明文）
    // 注意：技能仓库的服务器凭据已并入 webdavShared，此段仅为兼容旧配置保留读取，
    // 实际生效的是 webdavShared.endpoint/username/password + webdavShared.roots.skills
    webdav: {
      endpoint: "",
      username: "",
      password: "",
      root: "/agent-skills",
      deviceId: "",     // 首次使用时惰性生成
      deviceName: "",   // 默认取计算机名
    },
    // ===== 全项目统一的 WebDAV 服务器（技能仓库 / 用量统计 / 反代网关 / 记忆中枢共用一套凭据，
    // 各模块根目录隔离互不冲突；远端数据布局与格式保持不变） =====
    // type="s3" 时 endpoint/username/password 复用为 S3 兼容 API 地址 / AccessKeyId / SecretKey
    //（配 s3.bucket/region/pathStyle），四个同步引擎经 moduleWebdav 的 __s3 标记零改动走 S3 传输
    webdavShared: {
      type: "webdav",     // webdav | s3
      endpoint: "",
      username: "",
      password: "",       // 落盘为 enc:v1: 密文；S3 模式下是 SecretKey
      encryptionPassphrase: "", // 号池压缩包加密口令（enc:v1: 密文）；空 = 沿用 password（S3 模式下即 SecretKey）
      s3: {
        bucket: "",
        region: "",       // 非亚马逊服务一般填 auto（R2）或服务商标注的区域
        pathStyle: false, // true = path-style（MinIO/R2/OSS 等）；false = 虚拟主机式（AWS）
      },
      roots: {
        skills: "/agent-skills",   // 技能仓库中央仓库同步根目录（存量数据位置，勿改默认）
        usage: "/dosage-sync",     // 用量统计同步根目录（存量数据位置，勿改默认）
        proxy: "/agenthub-proxy",  // 反代网关号池同步根目录
        memory: "/agenthub-memory", // 记忆中枢同步根目录
        prompts: "/agenthub-prompts", // 提示词库同步根目录（第五板块；与其它板块数据隔离）
      },
    },
    // ===== 记忆中枢（模块自带配置在 <仓库>/config/memory.config.json，此处只放框架指针） =====
    memory: {
      enabled: true,
      rootDir: "",   // 空 = 默认 <用户文件夹>/AgentHub/memory
    },
    // ===== 提示词库（第五板块）=====
    // 库目录（用户资产，参与 WebDAV 同步）与「本机偏好目录」（风格 / 优化历史，不参与同步）
    // 是两处不同的位置：前者在 ~/AgentHub/prompts，后者在 userData/prompts，勿混用。
    prompts: {
      // —— 同步 ——
      syncAuto: true,              // 自动同步默认开（用户确认）
      syncIntervalHours: 4,        // 同步周期（小时，1~24）；界面用数字输入框
      mergeStrategy: "newer-wins", // newer-wins | local-wins | remote-wins | longer-wins | manual
      onDeleteConflict: "tombstone", // 一边删一边改时：tombstone=保留删除 | keep-modified=保留修改
      syncVersions: true,          // 版本历史是否随同步上传
      // —— 库 ——
      rootDir: "",                 // 空 = 默认 <用户文件夹>/AgentHub/prompts（与 memory 同父目录）
      versionKeep: 20,             // 每条保留的版本数上限
      trashDays: 30,               // 回收站保留天数
      itemMaxKB: 1024,             // 单条正文上限（KB）
      defaultCategory: "未分类",
      // —— 优化 ——
      defaultStyleId: "builtin-general",
      defaultModel: "",            // 空 = 跟随「设置 · 模型与网关」的默认模型
      maxLength: 800,              // 改写结果建议长度上限（对应 WorkBuddy 模板里的硬约束）
      temperature: 0.7,            // 改写任务需要多样性，比记忆任务的 0.2 高
      maxTokens: 4096,
      timeoutSec: 60,
      scenario: "通用 AI 助手",     // 注入 system 模板的目标场景描述
      historyLimit: 50,            // 优化历史条数上限
    },
    // 后台与调度
    schedule: {
      minimizeToTray: true, // 关窗缩到托盘
      // 全局快捷键：唤起/释放主窗口。默认 Alt+`（两键），必须是「功能键+字符键」组合
      // （见 backend/shortcut.cjs）。**不要写 Alt+~** —— ~ 在标准键盘要 Shift，
      // Electron 会当成三键组合，用户按两键没反应、极易误判为快捷键失效。
      // 空串 = 不注册快捷键。注册失败（被别的程序占用）时界面会明确提示，不静默换键。
      shortcutToggle: "Alt+`",
      // 轻量模式：关窗时销毁窗口（释放整个渲染进程），托盘常驻期间后端照旧跑。
      // 实测依据：hide() 只是藏窗口，渲染进程仍占 ~298 MB；destroy() 才会让它整只消失。
      // 仅在 minimizeToTray 开启时有意义（否则关窗本来就销毁窗口）。默认关，与改造前行为一致。
      lightweightMode: false,
      autoStart: false,     // 开机自启（便携版无效）
      hourly: false,        // 每小时自动同步
      daily: false,         // 每天定时同步
      dailyTime: "09:00",
      notifyOnSuccess: false, // 同步成功也通知（失败总通知）
    },
    // 自动感知：后台按周期快照各工具技能目录，有新技能且零冲突才自动收纳，有冲突只提醒
    watch: {
      enabled: true,
      intervalSeconds: 15, // 扫描周期（秒），设置 · 同步时间 可改
    },
    // ===== 反代网关（方案 settings 全量入框架整体设置；端口改动需重启监听，其余热生效） =====
    proxy: {
      port: 9527,               // 监听端口（默认 9527）
      bind: "127.0.0.1",        // 绑定地址：127.0.0.1 仅本机 / 0.0.0.0 局域网开放
      restoreOnLaunch: false,    // 网关开关的上次状态：启动应用时是否随之启动（默认关，由用户自行开启）
      routeStrategy: "smart",   // smart=智能路由（健康度×余额打分）/ fixed=指定渠道优先
      fixedChannel: "trae",     // fixed 策略下的优先渠道
      routeOrder: "score",      // 渠道成本感知排序：score=按打分（现状）/ cost-first=按成本档升序
                                // （免费→低成本→普通，组内仍按打分）；Key 可单独覆盖
      rateLimitPerMin: 120,     // 单 Key 令牌桶限速（次/分钟，Key 可单独覆盖）
      concurrency: 8,           // 单渠道在途并发上限（满则跳备选渠道，不做全局 429，issue #106）
      creditsRefreshMin: 30,    // 额度自动刷新周期（分钟）
      usageRetentionDays: 90,   // 请求流水保留期（天，1~3650）：启动 GC 与用量统计页「清理」共用
                                // （默认 90 = 该保留期此前在 proxy/store.cjs 的 gc() 里写死的那个数）
      expiringSoonDays: 1,      // 积分包「即将到期」预警阈值（天，0~3650，0=关闭预警）：
                                // 号池到期徽标与逐包明细的 expiringSoon 共用这一个值
                                // （默认 1 = 该阈值此前在 pool.cjs 里硬编码的那个数）
      poolsyncSchedule: {       // 号池定时同步（issue #89/#92）：全关 = 仅手动；API Key 与
                                // 模型映射随号池同步走，自动同步让新设备开箱即得
        hourly: false,          // 每小时档自动同步
        hourlyInterval: 6,      // 每小时档周期（小时）：1/2/3/6/12
        daily: false,           // 每天固定时刻同步
        dailyTime: "04:00",
      },
      debugStatus: false,       // /status 调试端点（默认关，仅回环地址）
      modelOverrides: {},       // 模型 → 渠道 的 per-model 覆盖（多源重叠时优先）
      humanizeJitter: true,     // 拟人抖动：每次上游请求前随机停 40~220ms（防风控识别为反代）
      disabledModels: [],       // 禁用的模型（请求直接 400 model_disabled，且不出现在 /v1/models）
      modelFallback: {},        // 模型 → 回退模型（旧版 per-model 配置，优先于全局回退）
      modelAliases: {},         // 自定义模型映射：别名 → 目标模型 id（请求入口先解析再路由）
      modelReverseAliases: {},  // 反向模型映射：统一请求名 → { [channelId]: 渠道实际模型名 }
      modelCustom: {},          // 模型自定义参数覆盖：modelId → { contextLength?, maxOutputTokens?, reasoningEffort? }
      autoFallbackEnabled: true, // 不可用时自动切换模型（统一设置，默认开）
      fallbackModel: "",        // 全局统一回退模型（模型未知/号池耗尽时自动切换）
      channelFailover: true,    // 跨渠道故障转移：渠道耗尽/降级时请求内自动跳其他渠道（默认开）；
                                // 只作用于渠道间跳转，「不可用时自动切换模型」的回退链不受此开关影响
      channelFailoverMax: 3,    // 单请求最多尝试渠道数（含主渠道；范围 1~10、超出按 10；上游尝试预算随上限放大：每模型 max(6, 本值+1) 次，failover 关闭恒 6）
      channelCooldownMs: 120000,     // 渠道降级基础时长（毫秒），失败翻倍（防半开震荡）
      channelCooldownCapMs: 900000,  // 渠道降级指数退避封顶（15 分钟）
      checkinAutoRules: {},     // 按渠道自动签到：{ [渠道 id]: { enabled, time:"HH:mm", jitterMin } }，
                                // 号池页各渠道工具栏各自设置（时间/抖动独立；默认全关）
      channelEnabled: {},       // 渠道启闭（「上游启闭」弹窗）：{ [渠道 id]: true|false }，缺省 = 启用。
                                // 关闭的渠道在反代网关全部页面隐藏，路由/调用/调度也不再使用，重新打开立即恢复
      ccSwitchModel: "",        // 生态接入默认模型（注册进 CC Switch 时使用，缺省取 fallbackModel）
      // ===== 上游超时旋钮（毫秒；对应四段超时的可配置化，0/缺省 = 用内置默认） =====
      firstByteBaseMs: 30000,      // 首字节基础预算（30s，按输入规模追加、封顶 firstByteMaxMs）
      firstByteMaxMs: 180000,      // 首字节预算封顶（超长 prompt 的 prefill 可能上百秒）
      streamIdleMs: 300000,        // 流式相邻数据空闲超时（300s，收到新数据即重置）
      httpJsonTimeoutMs: 60000,    // 非流式 JSON 请求（额度查询 / token 刷新）总超时（60s）
      retrySameAccountCount: 1,    // 瞬时错误同账号原地重发次数（0~5，对齐 retryCount）
      retrySameAccountIntervalMs: 1000, // 同账号原地重发退避间隔（毫秒，200~10000）
      rateRetryDelayMs: 1000,      // 无明示重置时间的 429 同号退避基数（毫秒，实际延迟带 ±15% 抖动；
                                   // 1000~15000。上游窗口更长时调大比「冷却换号」划算）
      dedupeSameBody: true,        // 同 body 请求去重排队：客户端快速重试时，后来的请求等前一个结束再发
                                   // （防风控识别为反代：同一账号连发同一份内容是最典型的机器特征；
                                   // 关掉后并发重试会全部并行打到上游，也更容易把上游拦截窗口续期）
      dedupeWaitMs: 45000,         // 去重排队等待上限（毫秒，1000~300000）：到点无条件放行，
                                   // 宁可多一个并发，也不让用户被一个卡住的前序请求挂住
    },
  };
}

/** 深合并：默认值补齐缺失字段；以 cfg 的键为准（tools 里的自定义工具 id 是动态键，
 *  不在默认值里，必须原样收进来），null 一律不收（防打穿必填子对象） */
function mergeConfig(def, cfg) {
  const out = { ...def };
  if (!cfg || typeof cfg !== "object") return out;
  for (const k of Object.keys(cfg)) {
    const dv = def ? def[k] : undefined;
    const cv = cfg[k];
    if (dv && typeof dv === "object" && !Array.isArray(dv) && cv && typeof cv === "object" && !Array.isArray(cv)) {
      out[k] = mergeConfig(dv, cv);
    } else if (cv !== undefined && cv !== null) {
      out[k] = cv;
    }
  }
  return out;
}

/** 模块顺序归一化：非法项剔除，缺失模块按默认顺序补尾 */
function normalizeModuleOrder(order) {
  const known = defaultConfig().moduleOrder;
  const list = (Array.isArray(order) ? order : []).filter((k) => known.includes(k));
  for (const k of known) if (!list.includes(k)) list.push(k);
  return list;
}

// ===== 提示词库（第五板块）配置归一化与目录工具 =====

/** 整数收敛：非有限值回默认，超出区间钳制（配置可能被手改，下游不再重复判合法性） */
function clampInt(v, def, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 提示词库配置归一化：逐字段收敛到安全区间，未知值一律回默认。
 *  为什么在 loadConfig 里做而不是在各消费点做：调度器与优化器都直接读配置，
 *  分散判合法性必然出现某处漏判（例如 syncIntervalHours 为 0 会让调度器每 tick 都触发）。 */
function normalizePrompts(p) {
  const def = defaultConfig().prompts;
  const o = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const str = (v, d) => (typeof v === "string" ? v.trim() : d);
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const MERGE = ["newer-wins", "local-wins", "remote-wins", "longer-wins", "manual"];
  return {
    syncAuto: bool(o.syncAuto, def.syncAuto),
    syncIntervalHours: clampInt(o.syncIntervalHours, def.syncIntervalHours, 1, 24),
    mergeStrategy: MERGE.includes(o.mergeStrategy) ? o.mergeStrategy : def.mergeStrategy,
    onDeleteConflict: o.onDeleteConflict === "keep-modified" ? "keep-modified" : def.onDeleteConflict,
    syncVersions: bool(o.syncVersions, def.syncVersions),
    rootDir: str(o.rootDir, def.rootDir),
    versionKeep: clampInt(o.versionKeep, def.versionKeep, 1, 500),
    trashDays: clampInt(o.trashDays, def.trashDays, 0, 3650),
    itemMaxKB: clampInt(o.itemMaxKB, def.itemMaxKB, 1, 10240),
    defaultCategory: str(o.defaultCategory, def.defaultCategory) || def.defaultCategory,
    defaultStyleId: str(o.defaultStyleId, def.defaultStyleId) || def.defaultStyleId,
    defaultModel: str(o.defaultModel, def.defaultModel),
    maxLength: clampInt(o.maxLength, def.maxLength, 100, 20000),
    temperature: num(o.temperature, def.temperature, 0, 2),
    maxTokens: clampInt(o.maxTokens, def.maxTokens, 256, 200000),
    timeoutSec: clampInt(o.timeoutSec, def.timeoutSec, 5, 600),
    scenario: str(o.scenario, def.scenario) || def.scenario,
    historyLimit: clampInt(o.historyLimit, def.historyLimit, 1, 500),
  };
}

/** 提示词库目录（用户资产，参与 WebDAV 同步）：默认 <用户文件夹>/AgentHub/prompts。
 *  与记忆中枢 <用户文件夹>/AgentHub/memory 同父目录，便于用户统一备份。 */
function promptsLibDir() {
  let custom = "";
  try {
    custom = (loadConfig().prompts || {}).rootDir || "";
  } catch { /* 配置读不出来时用默认目录，不让调用方拿到空路径 */ }
  const dir = custom && custom.trim()
    ? path.resolve(custom.trim())
    : path.join(os.homedir(), "AgentHub", "prompts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 提示词库本机偏好目录（优化风格 / 优化历史）：**不参与同步**，落在应用数据目录下。
 *  为什么与库目录分开：风格与历史是「这台机器的偏好」，同步到别的设备会互相覆盖。 */
function promptsLocalDir() {
  const dir = path.join(dataDir(), "prompts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ===== 按渠道自动签到规则（proxy.checkinAutoRules）：号池页每个渠道一套时间/抖动 =====

/** 规则可覆盖的渠道清单（旧全局配置迁移时铺满用；与 proxy/store.cjs 的 CHANNELS 对齐，新增渠道记得补） */
const CHECKIN_RULE_CHANNELS = ["trae", "workbuddy", "workbuddy_ai", "raccoon", "modelscope", "lobster", "zcode", "qoder", "qoder_intl", "autoclaw", "autoclaw_intl"];

/** HH:mm 归一化：格式或数值越界（h>23 / m>59）一律回落 09:00（配置可能被手改，下游 tick 不必再判合法性） */
function normalizeHm(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || "").trim());
  if (!m) return "09:00";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "09:00";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** 抖动分钟数归一化：0~180 整数（到点后随机延迟 0~N 分钟执行） */
function normalizeJitter(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(180, Math.max(0, n)) : 0;
}

/** 按渠道规则归一化：剔除畸形项，逐渠道收敛为 { enabled, time, jitterMin } 三键 */
function normalizeCheckinRules(rules) {
  const out = {};
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return out;
  for (const [id, r] of Object.entries(rules)) {
    if (!r || typeof r !== "object") continue;
    out[id] = { enabled: r.enabled === true, time: normalizeHm(r.time), jitterMin: normalizeJitter(r.jitterMin) };
  }
  return out;
}

// ===== 统一 WebDAV 服务器（webdavShared）：三套同步共用一套凭据，根目录各自隔离 =====

// 掩码约定与用量同步模块（sync-config.cjs）一致：渲染层只拿掩码，保存时精确掩码 = 未修改
const PASSWORD_MASK = "••••••••";

/** 归一化共享配置：缺键补默认，根目录去掉多余斜杠（空值回退默认根目录） */
function normalizeShared(s) {
  const def = defaultConfig().webdavShared;
  const out = s && typeof s === "object" ? s : {};
  const roots = out.roots && typeof out.roots === "object" ? out.roots : {};
  const s3 = out.s3 && typeof out.s3 === "object" ? out.s3 : {};
  const normRoot = (v, d) => {
    const r = typeof v === "string" ? v.trim().replace(/^\/+|\/+$/g, "") : "";
    return r ? "/" + r : d;
  };
  return {
    type: out.type === "s3" ? "s3" : "webdav",
    endpoint: typeof out.endpoint === "string" ? out.endpoint.trim() : "",
    username: typeof out.username === "string" ? out.username.trim() : "",
    password: typeof out.password === "string" ? out.password : "",
    encryptionPassphrase: typeof out.encryptionPassphrase === "string" ? out.encryptionPassphrase : "",
    s3: {
      bucket: typeof s3.bucket === "string" ? s3.bucket.trim() : "",
      region: typeof s3.region === "string" ? s3.region.trim() : "",
      pathStyle: s3.pathStyle === true,
    },
    // 各板块同步根目录白名单：**新增板块必须同时加到这里**，否则用户在设置页填的根目录
    // 会在下一次 loadConfig 时被本函数静默丢弃（只剩默认值），表现为「填了不生效」
    roots: {
      skills: normRoot(roots.skills, def.roots.skills),
      usage: normRoot(roots.usage, def.roots.usage),
      proxy: normRoot(roots.proxy, def.roots.proxy),
      memory: normRoot(roots.memory, def.roots.memory),
      prompts: normRoot(roots.prompts, def.roots.prompts),
    },
  };
}

// 迁移过程会读用量模块配置，而用量 loadConfig 又会回调本函数取共享值——重入时直接抛错，
// 让对方 catch 后保留旧值，避免无限递归与迁移中途读到半成品
let sharedBusy = false;

/**
 * 加载统一 WebDAV 配置（明文密码）。
 * 迁移规则（仅首次生效）：webdavShared.endpoint 为空时，从旧位置（框架 config.json 的
 * webdav 段 → 用量模块 ~/.Dosage_sync/config.json 的 webdav 段）搬服务器凭据与各根目录；
 * 随后把用量模块配置里的服务器凭据清空并置 useShared=true（两边 root 保留为各自覆盖值）。
 */
function loadSharedWebdav() {
  if (sharedBusy) throw new Error("webdavShared 正在迁移中");
  const cfg = loadConfig();
  let s = normalizeShared(cfg.webdavShared);
  if (!s.endpoint) {
    sharedBusy = true;
    try {
      let dirty = false;
      // 旧框架配置（技能仓库首次配置的凭据）
      const oldFw = cfg.webdav || {};
      if (oldFw.endpoint && String(oldFw.endpoint).trim()) {
        s.endpoint = String(oldFw.endpoint).trim();
        s.username = String(oldFw.username || "");
        s.password = String(oldFw.password || "");
        if (oldFw.root && String(oldFw.root).trim()) s.roots.skills = normalizeShared({ roots: { skills: oldFw.root } }).roots.skills;
        dirty = true;
      }
      // 旧用量模块配置（~/.Dosage_sync/config.json）
      try {
        const sc = require("./sync-config.cjs");
        const ucfg = sc.loadConfig();
        const uw = (ucfg && ucfg.webdav) || {};
        if (!s.endpoint && uw.endpoint && String(uw.endpoint).trim()) {
          s.endpoint = String(uw.endpoint).trim();
          s.username = String(uw.username || "");
          s.password = String(uw.password || "");
          dirty = true;
        }
        if (uw.root && String(uw.root).trim()) s.roots.usage = normalizeShared({ roots: { usage: uw.root } }).roots.usage;
        // 用量模块改为跟随共享：清掉它自己存的服务器凭据，只留下 useShared 开关与 root 覆盖
        if (!ucfg.webdav.useShared || uw.endpoint || uw.username || uw.password) {
          ucfg.webdav.useShared = true;
          uw.endpoint = "";
          uw.username = "";
          uw.password = "";
          sc.saveConfig(ucfg);
        }
      } catch { /* 用量模块目录不可达时跳过，下轮再迁移 */ }
      if (dirty) {
        try {
          // 迁移卫生（issue #95）：凭据已并入 webdavShared，旧段一律清空——
          // 否则 webdavShared 意外为空时再迁移会把旧服务器凭据「复活」，
          // 用户看到配置自己回到旧服务器
          cfg.webdav.endpoint = "";
          cfg.webdav.username = "";
          cfg.webdav.password = "";
          cfg.webdavShared = s;
          saveConfig(cfg); // saveConfig 内部会对 webdavShared.password 加密落盘
        } catch { /* 写不回去下轮再迁移 */ }
        s = normalizeShared(loadConfig().webdavShared); // 重读（含解密后的密码）
      }
    } finally {
      sharedBusy = false;
    }
  }
  return s;
}

/** 保存统一 WebDAV 配置（incoming 为明文/掩码表单值；掩码密码回填磁盘真值） */
function saveSharedWebdav(incoming) {
  const cur = loadSharedWebdav();
  const next = normalizeShared(incoming);
  if (next.password === PASSWORD_MASK) next.password = cur.password;
  // 号池加密口令同样只回掩码：精确掩码 = 未修改（issue #89）
  if (next.encryptionPassphrase === PASSWORD_MASK) next.encryptionPassphrase = cur.encryptionPassphrase;
  // S3 模式桶名必填：空桶名会让请求 URL 变成 `https://.host` 之类，报错是「网络错误」无从定位
  if (next.type === "s3" && !next.s3.bucket) return { ok: false, message: "S3 模式必须填写桶名（Bucket）" };
  // 表单里把有值的加密口令清空 = 用户显式要求回到「沿用密码」，放行清除；
  // cur 为空（解密失败）时不放行，密文仍由 saveConfig 保留（issue #95 保护）
  const explicitPassphraseClear = next.encryptionPassphrase === "" && !!cur.encryptionPassphrase;
  const cfg = loadConfig();
  cfg.webdavShared = next;
  return saveConfig(cfg, explicitPassphraseClear ? { forceClearSharedSecrets: true } : {}); // 加密落盘在 saveConfig 内统一处理
}

/** 显式清除统一 WebDAV 服务器配置（设置页「清除配置」按钮）：全字段清空。
 *  这是唯一允许把密码/加密口令清掉的入口——后台保存遇空密码会保留磁盘密文（解密失败保护），
 *  没有这个显式通道，用户将没有任何办法撤销已保存的服务器配置。
 *  同步清掉 legacy webdav 段凭据：否则清除后 webdavShared.endpoint 为空，再迁移会把
 *  旧服务器凭据原样「复活」（issue #95 现象） */
function clearSharedWebdav() {
  const cfg = loadConfig();
  cfg.webdavShared = normalizeShared({});
  cfg.webdav.endpoint = "";
  cfg.webdav.username = "";
  cfg.webdav.password = "";
  return saveConfig(cfg, { forceClearSharedSecrets: true });
}

/** 统一配置掩码版（给渲染层）：有密码/加密口令则回掩码，绝不回明文 */
function maskedSharedWebdav() {
  const s = loadSharedWebdav();
  return {
    ...s,
    password: s.password ? PASSWORD_MASK : "",
    encryptionPassphrase: s.encryptionPassphrase ? PASSWORD_MASK : "",
  };
}

/** 给同步引擎用：共享服务器 + 指定模块根目录拼成的完整 webdav 配置。
 *  S3 模式（issue #89）：endpoint/username/password 复用为 S3 API 地址 / AccessKeyId /
 *  SecretKey，并注入 __s3 标记与桶参数——webdav.cjs 据此分派到 S3 传输，
 *  各引擎与「配置齐全才可同步」的判断（endpoint/账号/密码非空）对 S3 原样成立 */
function moduleWebdav(moduleKey) {
  const s = loadSharedWebdav();
  const root = (s.roots && s.roots[moduleKey]) || "";
  const passphrase = sharedEncryptionPassphrase();
  if (s.type === "s3") {
    return {
      __s3: true,
      endpoint: s.endpoint,
      username: s.username,
      password: s.password,
      passphrase, // 号池压缩包加密口令（显式口令优先，缺省=SecretKey）——poolsync 封套全走它
      bucket: s.s3.bucket,
      region: s.s3.region,
      pathStyle: s.s3.pathStyle,
      root,
    };
  }
  return {
    endpoint: s.endpoint,
    username: s.username,
    password: s.password,
    passphrase,
    root,
  };
}

/** 号池压缩包加密口令（issue #89）：显式设置过 encryptionPassphrase 用之，
 *  否则沿用 password（WebDAV 模式=登录密码，S3 模式=SecretKey）——与历史行为兼容 */
function sharedEncryptionPassphrase() {
  const s = loadSharedWebdav();
  return s.encryptionPassphrase || s.password;
}

/** 加载配置（不存在/损坏时返回默认；损坏时留档 .bak） */
function loadConfig() {
  const p = configPath();
  let disk = {};
  if (fs.existsSync(p)) {
    try {
      disk = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      try { fs.rmSync(p + ".bak", { force: true }); fs.renameSync(p, p + ".bak"); } catch { /* 留档失败忽略 */ }
      disk = {};
    }
  }
  // 整个文件不是对象（null/数字/数组）也当没有，不然合并完必炸
  if (!disk || typeof disk !== "object" || Array.isArray(disk)) disk = {};
  const merged = mergeConfig(defaultConfig(), disk);
  // 迁移：旧版 proxy.autoStart 是「永远自启」的开关且默认 true，不是用户选择；
  // 新语义是 restoreOnLaunch「记住上次开关」，所以旧值一律丢弃，改完存盘即不再出现
  if (merged.proxy && "autoStart" in merged.proxy) delete merged.proxy.autoStart;
  // 迁移：旧版「全局定时自动签到」（proxy.checkinAuto / checkinAutoTime）→ 按渠道规则
  // （号池页每个渠道各自设时间与抖动）。只在旧开关确实开着时搬到全部渠道；搬完即删旧字段，
  // 天然防二次搬运——用户之后在号池页手改的规则不会被旧值再覆盖
  {
    const legacyOn = merged.proxy.checkinAuto === true;
    const legacyTime = normalizeHm(merged.proxy.checkinAutoTime);
    delete merged.proxy.checkinAuto;
    delete merged.proxy.checkinAutoTime;
    if (legacyOn && !Object.keys(normalizeCheckinRules(merged.proxy.checkinAutoRules)).length) {
      const seeded = {};
      for (const id of CHECKIN_RULE_CHANNELS) seeded[id] = { enabled: true, time: legacyTime, jitterMin: 0 };
      merged.proxy.checkinAutoRules = seeded;
    }
  }
  merged.proxy.checkinAutoRules = normalizeCheckinRules(merged.proxy.checkinAutoRules);
  if (merged.theme !== "dark" && merged.theme !== "light") merged.theme = "dark";
  merged.moduleOrder = normalizeModuleOrder(merged.moduleOrder);
  // 模块开关归一化（issue #91）：非法/缺失回 true；旧版「记忆中枢已关闭」（memory.enabled=false）
  // 一次性迁移进 modules.memory.enabled，此后 modules.* 是唯一事实源
  merged.modules = merged.modules && typeof merged.modules === "object" ? merged.modules : {};
  // 板块 key 白名单：**新增板块必须补进这个数组**，否则模块开关被剔除（表现为板块不存在）
  for (const k of ["skills", "sync", "proxy", "memory", "prompts"]) {
    const m = merged.modules[k] && typeof merged.modules[k] === "object" ? merged.modules[k] : {};
    m.enabled = m.enabled !== false;
    merged.modules[k] = m;
  }
  // 提示词库配置归一化：脏配置（手改 config.json）不得传到调度器与优化器
  merged.prompts = normalizePrompts(merged.prompts);
  if (merged.memory && merged.memory.enabled === false) merged.modules.memory.enabled = false;
  merged.webdav.password = decryptSecret(merged.webdav.password);
  merged.webdavShared = normalizeShared(merged.webdavShared);
  merged.webdavShared.password = decryptSecret(merged.webdavShared.password);
  merged.webdavShared.encryptionPassphrase = decryptSecret(merged.webdavShared.encryptionPassphrase);
  // deviceId / 本机名惰性补全并写回，保证多次调用稳定
  if (!merged.webdav.deviceId || !merged.webdav.deviceName) {
    if (!merged.webdav.deviceId) merged.webdav.deviceId = crypto.randomUUID();
    if (!merged.webdav.deviceName) merged.webdav.deviceName = os.hostname();
    try { saveConfig(merged); } catch { /* 写不回去下次再补 */ }
  }
  return merged;
}

// 保存前校验工具适配器：id 合法、自定义工具必须有名字、候选路径不许落进中央仓库（自己扫自己）
function validateToolConfig(cfg) {
  const { isBuiltinId, expandPath } = require("./adapter.cjs");
  const hub = path.resolve(hubDir());
  const errors = [];
  const pathOk = (p) => {
    if (typeof p !== "string" || !p.trim()) return true; // 空白交给探测层报"未命中"
    const abs = expandPath(p).toLowerCase();
    return abs !== hub.toLowerCase() && !abs.startsWith(hub.toLowerCase() + path.sep);
  };
  for (const [id, t] of Object.entries(cfg.tools || {})) {
    if (!isBuiltinId(id) && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) errors.push(`工具 id "${id}" 不合法（小写字母数字开头，可含 -_，最长 32 位）`);
    if (!t || typeof t !== "object" || Array.isArray(t)) { errors.push(`工具 ${id} 的配置损坏`); continue; }
    if (!isBuiltinId(id) && !String(t.name || "").trim()) errors.push(`工具 ${id} 缺显示名`);
    for (const p of t.paths || []) {
      if (!pathOk(p)) errors.push(`工具 ${id} 的候选路径指向中央仓库内部，会自己扫自己`);
    }
  }
  for (const p of cfg.customDirs || []) {
    if (!pathOk(p)) errors.push(`自定义目录 ${p} 指向中央仓库内部，会自己扫自己`);
  }
  return errors;
}

/** 保存配置（先写临时文件再原子替换，写一半断电不留半个 JSON）。
 *  opts.forceClearSharedSecrets：显式清除意图（clearSharedWebdav / 表单清空加密口令）——
 *  绕过下述解密失败保留规则；后台读改写保存绝不传它 */
function saveConfig(cfg, opts = {}) {
  const errors = validateToolConfig(cfg);
  if (errors.length) {
    const e = new Error("配置校验未通过：" + errors.slice(0, 3).join("；"));
    e.toolErrors = errors;
    throw e;
  }
  ensureHub();
  const p = configPath();
  const disk = JSON.parse(JSON.stringify(cfg));
  disk.webdav.password = encryptSecret(disk.webdav.password);
  if (disk.webdavShared) {
    disk.webdavShared = normalizeShared(disk.webdavShared);
    // 解密失败保护（issue #95）：loadConfig 解不开 enc:v1: 密文（换机 / DPAPI 变化）时
    // 内存密码是 ""，若直接落盘会把好端端的密文覆盖成空——网关启停等后台读改写保存都会触发。
    // 服务器未变而密码为空 = 本机没有新密码可写 → 保留磁盘密文；
    // 换服务器（endpoint/username 变了）正常写空，显式清除走 clearSharedWebdav。
    // encryptionPassphrase（号池加密口令，issue #89）无「换服务器」概念：为空一律保留磁盘密文
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const dsh = raw && raw.webdavShared;
      if (dsh && typeof dsh.password === "string" && dsh.password
          && String(dsh.endpoint || "") === disk.webdavShared.endpoint
          && String(dsh.username || "") === disk.webdavShared.username) {
        disk.webdavShared.password = dsh.password;
      }
      if (dsh && typeof dsh.encryptionPassphrase === "string" && dsh.encryptionPassphrase
          && !disk.webdavShared.encryptionPassphrase
          && !(opts && opts.forceClearSharedSecrets)) {
        disk.webdavShared.encryptionPassphrase = dsh.encryptionPassphrase;
      }
    } catch { /* 读不到就按原值落盘 */ }
    disk.webdavShared.password = encryptSecret(disk.webdavShared.password);
    disk.webdavShared.encryptionPassphrase = encryptSecret(disk.webdavShared.encryptionPassphrase);
  }
  // 中转名带 pid，与本仓其余原子写同形（memory/config.cjs、memory/store.cjs、synonyms.cjs、
  // inject.cjs 早就是 `.tmp.${process.pid}`）：固定名时两个写入者会互相把对方的 .tmp rename 走
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return { ok: true, message: "设置保存成功" };
}

/** 由「独立 IPC 直接写盘」或「只手工编辑 config.json」的 proxy 字段 —— 设置页表单不拥有它们，
 *  渲染层的 config 快照可能过期，整份保存会把它们冲掉（issue #90）。
 *  · channelEnabled   ← proxy_channel_toggle（上游启闭）
 *  · checkinAutoRules ← proxy_checkin_auto_set（按渠道自动签到）
 *  · enableAnthropic / enableResponses ← 新增协议面的紧急止血开关。界面不提供入口，
 *    用户按注释提示手工改 config.json；而「手工改完要重启才进内存快照」这件事不能当约束——
 *    应用在跑的时候改盘，之后任何一次无关的整份保存（切主题、拖模块顺序）都会把这个
 *    刚写下的 false 抹掉，等于止血开关自己会弹回来。故与上面两个字段同列，以磁盘为准。
 *  注意：只应在这两个字段**各自的写入 IPC** 里绕过本名单；它们调的是 saveConfig。
 *  restoreOnLaunch 刻意不进名单：设置页「记住网关开关」就是经整份保存写盘的，
 *  磁盘优先会架空那个开关；渲染层快照由总览页每次启停同步（ProxyHomeView），不会过期。 */
const OUT_OF_BAND_PROXY_FIELDS = ["channelEnabled", "checkinAutoRules", "enableAnthropic", "enableResponses"];

/** 设置页保存路径专用：先把 out-of-band 字段以**磁盘值**为准，再落盘。
 *
 *  为什么必须区分 saveConfig / saveConfigFromUI：
 *    那两个字段的写入方（channel 启闭、签到规则）也是调 saveConfig 落盘的。
 *    若把「磁盘优先」写进 saveConfig，它们自己的写入会被自己刚改的值覆盖回去 —— 功能当场失效。
 *    所以「磁盘优先」只适用于**设置页整份提交**这一条路径。
 *
 *  为什么不能在渲染层单独解决：没有渲染层的部署形态（HTTP / Web 端）同样能提交整份配置，
 *    后端这层兜底对两条路径都生效。
 *  返回 saveConfig 的结果（含校验失败时抛出的 toolErrors）。 */
function saveConfigFromUI(cfg) {
  const next = cfg && typeof cfg === "object" ? cfg : {};
  try {
    const disk = loadConfig();
    if (!next.proxy || typeof next.proxy !== "object") next.proxy = {};
    const diskProxy = (disk && disk.proxy) || {};
    for (const k of OUT_OF_BAND_PROXY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(diskProxy, k)) next.proxy[k] = diskProxy[k];
    }
    // webdavShared 整段同样磁盘优先（issue #95）：它从不经设置页整份保存编辑
    //（专用通道 webdav_shared_save），渲染层快照里的这一段是启动时带进来的旧行李字段，
    // 首配会话内密码快照为空串，任何整份提交（切主题/拖模块排序/改反代设置）都会把
    // 已保存的服务器配置整段冲掉——这里以磁盘值为准，让该快照字段失效
    if (disk && disk.webdavShared) next.webdavShared = disk.webdavShared;
    // 远程网关目标同样磁盘优先：唯一写入口是 remote_targets_save/delete/activate（主进程读改写），
    // 设置页整份提交携带的是启动时的旧快照，不保护会像 issue #90 一样把变更冲回去
    if (disk && Array.isArray(disk.remoteTargets)) next.remoteTargets = disk.remoteTargets;
    if (disk && typeof disk.remoteActiveId === "string") next.remoteActiveId = disk.remoteActiveId;
    // modules（板块启用开关）同样磁盘优先（issue #91）：唯一写入口是 module_toggle IPC
    //（主进程读改写），设置页表单不拥有它——否则开关切换后任何整份保存都会把
    // 渲染层旧快照里的开关状态写回去，重启后开关「自己弹回来」
    if (disk && disk.modules) next.modules = disk.modules;
    // models（模型与网关）**当前**住在记忆中枢配置里，config.json 里没有这一段 → 这行现在是空操作。
    // 但它是一次性把隐患封死的托底：若将来把 models 上移到平台配置，缺这行的话
    // 「切主题 / 拖模块顺序」这类整份保存会把供应商与模型池整段冲掉（issue #90/#95/#91 同型事故）。
    // 上移前必须确认这条仍然在（B6 的硬前置，不可省）。
    if (disk && disk.models) next.models = disk.models;
  } catch { /* 读盘失败时退回原行为（宁可保存成功，也不要让设置页整体保存失败） */ }
  return saveConfig(next);
}
function getUpdateNotified() {
  try {
    return loadConfig().update.notifiedVersion || "";
  } catch {
    return "";
  }
}

function setUpdateNotified(version) {
  try {
    const cfg = loadConfig();
    cfg.update.notifiedVersion = version || "";
    saveConfig(cfg);
  } catch {
    // 写不进去就算了，只是通知去重失效
  }
}

// 开机自启即时生效；便携版注册的是临时解压路径，开发模式不必注册
function applyAutoStart(cfg) {
  if (isPortable() || !electronApp || process.env.VITE_DEV_SERVER_URL) return;
  try {
    if (!electronApp.isPackaged) return;
    electronApp.setLoginItemSettings({ openAtLogin: !!(cfg.schedule && cfg.schedule.autoStart) });
  } catch { /* 注册失败不拦保存 */ }
}

module.exports = {
  dataDir, configPath, hubDir, ensureHub, loadConfig, saveConfig, defaultConfig, ENC_PREFIX,
  getUpdateNotified, setUpdateNotified, isPortable, encryptSecret, decryptSecret, isEncrypted, applyAutoStart,
  loadSharedWebdav, saveSharedWebdav, clearSharedWebdav, maskedSharedWebdav, moduleWebdav, sharedEncryptionPassphrase, PASSWORD_MASK,
  normalizeHm, normalizeJitter,
  // 提示词库（第五板块）：库目录（参与同步）与本机偏好目录（风格/历史，不参与同步）由本模块统一提供，
  // 避免后端各处自己拼路径导致两个目录被混用
  promptsLibDir, promptsLocalDir, normalizePrompts,
  saveConfigFromUI, OUT_OF_BAND_PROXY_FIELDS,
};
