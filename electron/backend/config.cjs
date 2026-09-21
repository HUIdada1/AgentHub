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

// WebDAV 密码用系统级密钥加密落盘（safeStorage 不可用就降级明文）。
// 渲染层永远只拿掩码，真值留在主进程
let safeStorage = null;
try { safeStorage = require("electron").safeStorage; } catch { /* 自测环境无 electron */ }
const ENC_PREFIX = "enc:v1:";

function encryptSecret(plain) {
  const s = String(plain || "");
  if (!s || s.startsWith(ENC_PREFIX)) return s; // 空值或已是密文不重复加密
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return s;
  return ENC_PREFIX + safeStorage.encryptString(s).toString("base64");
}

function decryptSecret(stored) {
  const s = String(stored || "");
  if (!s.startsWith(ENC_PREFIX)) return s; // 明文（降级环境存的）直接用
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return ""; // 密文来自其他机器解不开，让用户重填
  }
}

/** 数据目录：Electron 用 userData（%APPDATA%\AgentHub，目录名由 main.cjs 的 setName 决定）；
 *  纯 Node 环境退回 %APPDATA%\AgentHub（无则用户主目录），保证脚本直跑与主进程读同一份配置 */
function dataDir() {
  const dir = electronApp ? electronApp.getPath("userData") : path.join(process.env.APPDATA || os.homedir(), "AgentHub");
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
    // 左栏三大模块的显示顺序（用户在「设置 · 个性化」中调整）
    moduleOrder: ["skills", "sync", "proxy"],
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
    // ===== 全项目统一的 WebDAV 服务器（技能仓库 / 用量统计 / 反代网关共用一套凭据，
    // 各模块根目录隔离互不冲突；远端数据布局与格式保持不变） =====
    webdavShared: {
      endpoint: "",
      username: "",
      password: "",       // 落盘为 enc:v1: 密文；同时作为反代号池压缩包的加密口令
      roots: {
        skills: "/agent-skills",   // 技能仓库中央仓库同步根目录（存量数据位置，勿改默认）
        usage: "/dosage-sync",     // 用量统计同步根目录（存量数据位置，勿改默认）
        proxy: "/agenthub-proxy",  // 反代网关号池同步根目录
      },
    },
    // 后台与调度
    schedule: {
      minimizeToTray: true, // 关窗缩到托盘
      autoStart: false,     // 开机自启（便携版无效）
      hourly: false,        // 每小时自动同步
      daily: false,         // 每天定时同步
      dailyTime: "09:00",
      notifyOnSuccess: false, // 同步成功也通知（失败总通知）
    },
    // 自动感知：后台每 15 秒快照各工具技能目录，有新技能且零冲突才自动收纳，有冲突只提醒
    watch: {
      enabled: true,
    },
    // ===== 反代网关（方案 settings 全量入框架整体设置；端口改动需重启监听，其余热生效） =====
    proxy: {
      port: 9527,               // 监听端口（默认 9527）
      bind: "127.0.0.1",        // 绑定地址：127.0.0.1 仅本机 / 0.0.0.0 局域网开放
      restoreOnLaunch: false,    // 网关开关的上次状态：启动应用时是否随之启动（默认关，由用户自行开启）
      routeStrategy: "smart",   // smart=智能路由（健康度×余额打分）/ fixed=指定渠道优先
      fixedChannel: "trae",     // fixed 策略下的优先渠道
      rateLimitPerMin: 120,     // 单 Key 令牌桶限速（次/分钟，Key 可单独覆盖）
      concurrency: 8,           // 上游并发上限
      creditsRefreshMin: 30,    // 额度自动刷新周期（分钟）
      debugStatus: false,       // /status 调试端点（默认关，仅回环地址）
      modelOverrides: {},       // 模型 → 渠道 的 per-model 覆盖（多源重叠时优先）
      humanizeJitter: true,     // 拟人抖动：每次上游请求前随机停 40~220ms（防风控识别为反代）
      disabledModels: [],       // 禁用的模型（请求直接 400 model_disabled）
      modelFallback: {},        // 模型 → 回退模型（旧版 per-model 配置，优先于全局回退）
      modelAliases: {},         // 自定义模型映射：别名 → 目标模型 id（请求入口先解析再路由）
      autoFallbackEnabled: true, // 不可用时自动切换模型（统一设置，默认开）
      fallbackModel: "",        // 全局统一回退模型（模型未知/号池耗尽时自动切换）
      checkinAuto: false,       // 定时自动签到（默认关）：每天到点自动跑全渠道签到/领加油包
      checkinAutoTime: "09:00", // 每日自动签到时间（HH:mm）
      ccSwitchModel: "",        // 生态接入默认模型（注册进 CC Switch 时使用，缺省取 fallbackModel）
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

// ===== 统一 WebDAV 服务器（webdavShared）：三套同步共用一套凭据，根目录各自隔离 =====

// 掩码约定与用量同步模块（sync-config.cjs）一致：渲染层只拿掩码，保存时精确掩码 = 未修改
const PASSWORD_MASK = "••••••••";

/** 归一化共享配置：缺键补默认，根目录去掉多余斜杠（空值回退默认根目录） */
function normalizeShared(s) {
  const def = defaultConfig().webdavShared;
  const out = s && typeof s === "object" ? s : {};
  const roots = out.roots && typeof out.roots === "object" ? out.roots : {};
  const normRoot = (v, d) => {
    const r = typeof v === "string" ? v.trim().replace(/^\/+|\/+$/g, "") : "";
    return r ? "/" + r : d;
  };
  return {
    endpoint: typeof out.endpoint === "string" ? out.endpoint.trim() : "",
    username: typeof out.username === "string" ? out.username.trim() : "",
    password: typeof out.password === "string" ? out.password : "",
    roots: {
      skills: normRoot(roots.skills, def.roots.skills),
      usage: normRoot(roots.usage, def.roots.usage),
      proxy: normRoot(roots.proxy, def.roots.proxy),
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
  const cfg = loadConfig();
  cfg.webdavShared = next;
  saveConfig(cfg); // 加密落盘在 saveConfig 内统一处理
  return { ok: true, message: "已保存" };
}

/** 统一配置掩码版（给渲染层）：有密码则回掩码 */
function maskedSharedWebdav() {
  const s = loadSharedWebdav();
  return { ...s, password: s.password ? PASSWORD_MASK : "" };
}

/** 给同步引擎用：共享服务器 + 指定模块根目录拼成的完整 webdav 配置 */
function moduleWebdav(moduleKey) {
  const s = loadSharedWebdav();
  return {
    endpoint: s.endpoint,
    username: s.username,
    password: s.password,
    root: (s.roots && s.roots[moduleKey]) || "",
  };
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
  if (merged.theme !== "dark" && merged.theme !== "light") merged.theme = "dark";
  merged.moduleOrder = normalizeModuleOrder(merged.moduleOrder);
  merged.webdav.password = decryptSecret(merged.webdav.password);
  merged.webdavShared = normalizeShared(merged.webdavShared);
  merged.webdavShared.password = decryptSecret(merged.webdavShared.password);
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

/** 保存配置（先写临时文件再原子替换，写一半断电不留半个 JSON） */
function saveConfig(cfg) {
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
  if (disk.webdavShared) disk.webdavShared = normalizeShared(disk.webdavShared);
  disk.webdavShared.password = encryptSecret(disk.webdavShared.password);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return { ok: true, message: "设置保存成功" };
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
  dataDir, configPath, hubDir, ensureHub, loadConfig, saveConfig, defaultConfig,
  getUpdateNotified, setUpdateNotified, isPortable, encryptSecret, decryptSecret, applyAutoStart,
  loadSharedWebdav, saveSharedWebdav, maskedSharedWebdav, moduleWebdav, PASSWORD_MASK,
};
