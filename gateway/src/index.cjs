/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-03（归档版 2026-10-22，本文件自归档恢复并按双模块形态改造）
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// AgentHub Docker headless 形态入口：号池管家（proxy）+ 本地网关（localgw）+ 提示词库（prompts）+ 记忆中枢（memory）四模块装配
//
// 方案：docs/docker-上线/Docker版上线方案-20261103.md（板块 B）。
// 提示词库是第三个容器化板块：Web 控制台需要 prompts 的库/优化/目录/同步全部命令，
// 否则「提示词库」页面整页 404（实测前端调用 42 条 prompts_* 命令）。
// 记忆中枢是第四个容器化板块：Web 控制台需要 memory 的库/统计/配置/同步全部命令，
// 否则「记忆中枢」页面整页 404（实测前端调用 95 条 memory_* 命令）。
// 对外接口统一由 localgw（本地网关）提供，渠道能力通过插件适配；号池管理沿用
// proxy/index.cjs 的 boot()（规则/数据库/额度刷新/
// 真实签到 tick/号池同步/deviceMid 自愈/锚点兜底），桌面版日后新增装配项这里自动继承。
//
// 不能破的约束：
//  ① 数据目录与桌面版相互独立：桌面凭据是 safeStorage 密文、容器解不开，两形态之间
//     传号只走号池同步（poolsync 的口令信封通道）；跨机共用数据卷属误配置，不支持。
//  ② 进程内覆盖监听参数，绝不回写 config.json（与桌面版共享宿主配置时绝不篡改对方 bind）。
//  ③ 未设 AGENTHUB_SECRET_KEY 且未显式 AGENTHUB_ALLOW_PLAINTEXT=1 时拒绝启动。
//  ④ 管理面未设 token 时只绑回环；token 校验恒定时间比较；请求体限 4mb。
//  ⑤ 容器不可用能力诚实拒绝（commands.cjs 的 DENY 文案），不假装能过 OAuth/人机校验。
//  ⑥ localgw 在容器里进程内强制 autostart/bind/port（patch 会落盘，故不用 patch 落盘，
//     改在 loadConfig 上套一次进程内覆盖——桌面版配置语义零改动）。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PROXY_DIR = path.join(PROJECT_ROOT, "electron", "backend", "proxy");
const BACKEND_DIR = path.join(PROJECT_ROOT, "electron", "backend");
const LOCALGW_DIR = path.join(BACKEND_DIR, "localgw");

// 数据目录先行：config.cjs 的 dataDir() 以 AGENTHUB_DATA_DIR 优先
process.env.AGENTHUB_DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(process.cwd(), "data");

// 容器里没有 safeStorage，凭据加密唯一来源是 AGENTHUB_SECRET_KEY；未设置又未显式放行时
// 拒绝启动，比"静默明文落库"更早暴露问题（逃生门只给本地调试）
if (!process.env.AGENTHUB_SECRET_KEY && process.env.AGENTHUB_ALLOW_PLAINTEXT !== "1") {
  console.error("[AgentHub Gateway] 拒绝启动：未设置 AGENTHUB_SECRET_KEY，凭据无法加密落盘。");
  console.error("  生产部署：AGENTHUB_SECRET_KEY=$(openssl rand -base64 32)");
  console.error("  仅本地调试需要明文：设 AGENTHUB_ALLOW_PLAINTEXT=1");
  process.exit(1);
}

const express = require("express");
const config = require(path.join(BACKEND_DIR, "config.cjs"));
const { collectCommands, modeOf, DENY } = require("./commands.cjs");
const platform = require(path.join(PROXY_DIR, "platform", "index.cjs"));
const store = require(path.join(PROXY_DIR, "store.cjs"));
const pool = require(path.join(PROXY_DIR, "pool.cjs"));
const adapters = require(path.join(PROXY_DIR, "management-adapters.cjs"));
const pluginHost = require(path.join(BACKEND_DIR, "plugin-host.cjs"));
const extensionPool = require(path.join(BACKEND_DIR, "extensions", "pool-runtime.cjs")).getPoolRuntime(pluginHost);
const extensionForwarder = require(path.join(BACKEND_DIR, "localgw", "forwarder.cjs"));
require(path.join(BACKEND_DIR, "localgw", "services.cjs")).configure({ host: pluginHost, poolService: extensionPool,
  executor: require(path.join(BACKEND_DIR, "localgw", "extension-executor.cjs")).createExtensionExecutor({
    pool: require(path.join(BACKEND_DIR, "proxy", "pool.cjs")), poolService: extensionPool,
    onSuccess: (account, model) => require(path.join(BACKEND_DIR, "proxy", "pool.cjs")).noteSuccess(account, model),
    onFailure: extensionForwarder.applyExtensionFailure
  }) });
pluginHost.init({ app: { getVersion: platform.version }, bindExtensionSession: extensionPool.bindSession });
const discovery = require(path.join(PROXY_DIR, "discovery.cjs"));
const poolsync = require(path.join(PROXY_DIR, "poolsync.cjs"));
const proxyIndex = require(path.join(PROXY_DIR, "index.cjs"));
const localgw = require(path.join(LOCALGW_DIR, "index.cjs"));
const lgwServer = require(path.join(LOCALGW_DIR, "server.cjs"));

const PORT = Number(process.env.AGENTHUB_PROXY_PORT) || 9527;
const BIND = process.env.AGENTHUB_HOST || "0.0.0.0";
const ADMIN_PORT = Number(process.env.AGENTHUB_ADMIN_PORT) || 9528;
const ADMIN_TOKEN = String(process.env.AGENTHUB_ADMIN_TOKEN || "");
// 只读令牌（可选）：日常监视专用，只放行 read 类命令与查询端点——给自动化/看板用更低风险的凭据
const ADMIN_READONLY_TOKEN = String(process.env.AGENTHUB_ADMIN_READONLY_TOKEN || "");
// 管理面默认不进网络：未设任何 token 时只绑回环（网关 Key 与管理 token 是两套凭据）
const ADMIN_BIND = process.env.AGENTHUB_ADMIN_HOST || (ADMIN_TOKEN || ADMIN_READONLY_TOKEN ? "0.0.0.0" : "127.0.0.1");
// 免凭据路径：探针（Dockerfile 的 HEALTHCHECK 与编排器 probe 都不带 token）与能力清单
// （Web 端登录页要据此判断"这是网关托管的 Web UI 还是纯前端预览"，必须无凭据可读）
const PUBLIC_PATHS = new Set(["/api/livez", "/api/readyz", "/api/capabilities"]);
const BODY_LIMIT = "4mb";
const DRAIN_TIMEOUT_MS = 15000;
// Web UI 产物目录：镜像内由 ui 构建层 COPY 到 gateway/public；本地验证用 AGENTHUB_UI_DIR 指 dist
const UI_DIR = process.env.AGENTHUB_UI_DIR || path.join(__dirname, "..", "public");

let adminServer = null;
let lockFile = null;
let commandTable = null; // boot() 之后由 collectCommands() 填充（register 首行副作用需要配置已可读）

/** 进程内覆盖监听参数（约束②）：localgw 的 autostart/bind/port 由容器环境变量决定。
 *  实现方式：reroute config.loadConfig 目标 + 过滤 localgw 运行态字段的 patch 落盘。
 *
 *  为什么不能用"包装 loadConfig"：localgw/index.cjs 顶层导出 autoStartIfNeeded()（读
 *  lgwConfig.get()→loadConfig）是在 require 时绑定的，gateway 在主入口包装的 loadConfig
 *  拦截不到它。能在 loadConfig 上改的只有 patch() 的落盘路径。正确做法：
 *  ① 启动早期直接读盘改 localgw 段（config.json 是容器数据目录，独立的，不涉及桌面语义）；
 *  ② 蒙板 localgw.patch——拦截 bind/port/autostart 三个由容器接管的键后落盘，其余字段
 *     （路由、模型、API Key、security 等）原样穿透。 */
function applyContainerOverrides() {
  // ① 读盘改：boot 之前一次性落位
  const cfg = config.loadConfig();
  const next = JSON.parse(JSON.stringify(cfg));
  if (!next.localgw || typeof next.localgw !== "object") next.localgw = {};
  next.localgw.autostart = true;
  next.localgw.bind = BIND;
  next.localgw.port = PORT;
  config.saveConfig(next);

  // ② 蒙板 patch：防桌面版「记住网关开关」类磁盘优先逻辑把容器参数反弹回运行时
  const lgwConfig = require(path.join(LOCALGW_DIR, "config.cjs"));
  const origPatch = lgwConfig.patch;
  lgwConfig.patch = function patch(p) {
    const next = { ...(p || {}) };
    delete next.autostart;
    delete next.bind;
    delete next.port;
    return origPatch(next);
  };
}

/** token 校验：双方先 SHA-256 成等长再恒定时间比较（token 长度不进时序） */
function adminTokenOk(token, expected) {
  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(digest(token), digest(expected));
}

/** 只读令牌只能读：写端点开头调用；拒绝时已应答并返回 false */
function requireFull(req, res) {
  if (req.adminScope !== "read") return true;
  res.status(403).json({ ok: false, message: "只读令牌不能执行该操作（需要完整管理 token）" });
  return false;
}

/** 单实例锁：同一数据目录只允许一个网关进程（本机直跑与容器、或两个容器共卷双写会把
 *  冷却表/签到/号池同步互相踩烂）。同 host 且 pid 存活 → 拒绝；异 host 无法探活，接管并
 *  继续——跨机共用数据卷属误配置，部署文档明确不支持 */
function acquireLock() {
  const file = path.join(process.env.AGENTHUB_DATA_DIR, "gateway.lock");
  try {
    if (fs.existsSync(file)) {
      const [host, pidStr] = String(fs.readFileSync(file, "utf8")).trim().split(":");
      const pid = Number(pidStr);
      if (host === os.hostname() && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code !== "ESRCH"; // 除"不存在"外一律按存活保守处理：误接管=双写，代价最大
        }
        if (alive) {
          console.error(`[AgentHub Gateway] 拒绝启动：数据目录已被本机 pid ${pid} 占用（${file}）`);
          process.exit(1);
        }
      }
    }
    fs.writeFileSync(file, `${os.hostname()}:${process.pid}`);
    return file;
  } catch (e) {
    platform.log("warn", "[gateway] 锁文件不可用，跳过单实例检查", { message: String((e && e.message) || e) });
    return null;
  }
}

async function main() {
  lockFile = acquireLock();
  console.log(`[AgentHub Gateway] 启动中 platform=${platform.form()} version=${platform.version()}`);
  console.log(`[AgentHub Gateway] 数据目录 ${process.env.AGENTHUB_DATA_DIR}`);
  console.log(`[AgentHub Gateway] 凭据加密 ${process.env.AGENTHUB_SECRET_KEY ? "AES-256-GCM (AGENTHUB_SECRET_KEY)" : "无（AGENTHUB_ALLOW_PLAINTEXT=1 已放行明文）"}`);

  // 进程内覆盖（约束②）：先落位再 boot——boot 内的 rules.init/store.open/调度器读的全是落位后值
  applyContainerOverrides();

  // 首启修正自己的 config：qoder 双区需要本机客户端 wasm 签名，容器里必然失败（归档版同款）。
  // 这里 patch 的是渠道启闭（用户数据），不是监听参数，落盘是刻意的——容器数据目录本就独立。
  const cfg = config.loadConfig();
  const ce = (cfg.proxy && cfg.proxy.channelEnabled) || {};
  if (ce.qoder !== false || ce.qoder_intl !== false) {
    cfg.proxy.channelEnabled = Object.assign({}, ce, { qoder: false, qoder_intl: false });
    config.saveConfig(cfg);
  }

  // localgw 广播器必须在 boot 之前注入（usagehook 的广播器只在 boot 时注入，晚注入丢启动初期事件）。
  // 出口直接写 SSE 客户端：usagehook.broadcast 自己包 {event:"localgw", type:"request", ...} 信封，
  // 不走 platform.emit——后者是号池管家（proxy）事件的出口，事件名要固定 "proxy"，混发会让
  // 前端 onUpdateEvent 把 localgw 请求事件误当号池事件刷新（信封不再同形）
  localgw.setRuntime({
    broadcast: (payload) => {
      for (const c of sseClients) {
        try {
          c.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          /* 连接已断，close 收尾 */
        }
      }
    },
  });

  await proxyIndex.boot();
  // Provider transport only; legacy desktop UI plugins are not headless services.
  try { await pluginHost.resumeEnabled({ schema: 2 }); }
  catch { console.error("[AgentHub Gateway] 插件恢复失败，原号池与标准网关继续启动"); }
  // 提示词库：库/优化/目录/同步全部命令经管理 RPC 暴露（Web 控制台不遗漏操作页面）。
  // prompts.boot() 只启动调度器（定时同步），register 已在 collectCommands 里完成。
  const promptsIndex = require(path.join(BACKEND_DIR, "prompts", "index.cjs"));
  promptsIndex.boot();
  // 记忆中枢：库/统计/配置/同步全部命令经管理 RPC 暴露（Web 控制台不遗漏操作页面）。
  // memory.boot() 启动索引与桥接，register 已在 collectCommands 里完成。
  const memoryIndex = require(path.join(BACKEND_DIR, "memory", "index.cjs"));
  memoryIndex.boot();
  const lgwBoot = await localgw.boot(); // autostart 已被进程内覆盖为 true，server.start() 由它触发
  if (!lgwBoot || lgwBoot.ok !== true) {
    console.error("[AgentHub Gateway] 本地网关启动失败:", (lgwBoot && lgwBoot.message) || "未知原因");
    process.exit(1);
  }
  // 真实监听参数以 localgw 自身状态为准：config 的 portCandidates[0] 可能是端口已被占（幂等启动时）
  // 落回的旧值——日志别拿覆盖前的值糊弄（契约：诚实不谎报）
  const st = lgwServer.status();
  console.log(`✅ [AgentHub Gateway] 本地网关已监听 ${st.bind}:${st.port}/v1（chat/completions · messages · responses · models）`);

  commandTable = collectCommands();

  adminServer = startAdmin();
  console.log(`✅ [AgentHub Gateway] 管理 API 已监听 ${ADMIN_BIND}:${ADMIN_PORT}（${ADMIN_TOKEN ? "Bearer token 鉴权" : "未设 token，仅回环可达"}）`);
}

// ===== 管理 API =====

/** 路由包装：异常收敛为 JSON 错误（与桌面 IPC 层的 handle() 同款形状）。
 *  同步抛错与异步拒绝都兜住——async handler 的拒绝不会被 try 捕获，漏掉会变成
 *  unhandledRejection 且客户端永远等不到响应 */
function handle(fn) {
  const fail = (res, e) => {
    if (!res.headersSent) res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === "function") out.catch((e) => fail(res, e));
      return out;
    } catch (e) {
      fail(res, e);
    }
  };
}

function adminAuth(req, res, next) {
  // 非 /api 前缀 = UI 静态资源与 SPA 入口（前端代码无敏感），免凭据。
  // 注意不能用 app.use("/api", adminAuth) 表达：express 会剥掉挂载前缀，PUBLIC_PATHS
  // 与探针判定将全部失配，HEALTHCHECK 401 会把容器判成不健康
  if (!req.path.startsWith("/api/")) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!ADMIN_TOKEN && !ADMIN_READONLY_TOKEN) {
    req.adminScope = "full"; // 无令牌 = 仅回环可达，等同全权（保持既有语义）
    return next();
  }
  const hdr = String(req.headers.authorization || "");
  const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const token = bearer || String(req.headers["x-admin-token"] || "");
  if (token && ADMIN_TOKEN && adminTokenOk(token, ADMIN_TOKEN)) {
    req.adminScope = "full";
    return next();
  }
  if (token && ADMIN_READONLY_TOKEN && adminTokenOk(token, ADMIN_READONLY_TOKEN)) {
    req.adminScope = "read";
    return next();
  }
  res.status(401).json({ ok: false, message: "管理 token 缺失或错误（Authorization: Bearer <AGENTHUB_ADMIN_TOKEN>）" });
}

function registerProbes(app) {
  // 存活：进程活着就 200（容器 HEALTHCHECK 挂这里）；就绪：至少一个启用渠道有在线账号
  app.get("/api/livez", (req, res) => res.json({ ok: true }));
  app.get("/api/readyz", (req, res) => {
    let ready = false;
    try {
      ready = store.CHANNELS.some((c) => adapters.channelOn(c.id) && pool.poolSummary(c.id).onlineCount > 0);
    } catch { /* 库异常按未就绪 */ }
    res.status(ready ? 200 : 503).json({ ok: ready });
  });
  app.get("/api/status", handle((req, res) => {
    res.json({
      ok: true,
      localgw: lgwServer.status(),
      // 与桌面号池总览对齐的常用字段：外部监控/看板不必再走 RPC 组装
      today: store.statsToday(),
      // 提示词库统计：Web 控制台侧栏卡片需要（条数 / 今日 / 冲突）
      prompts: (() => {
        try {
          const p = require(path.join(BACKEND_DIR, "prompts", "index.cjs"));
          return p.isRunning() ? { running: true } : { running: false };
        } catch { return { running: false }; }
      })(),
      // 记忆中枢统计：Web 控制台侧栏卡片需要（条数 / 今日 / 待处理）
      memory: (() => {
        try {
          const m = require(path.join(BACKEND_DIR, "memory", "index.cjs"));
          return { running: true };
        } catch { return { running: false }; }
      })(),
      channels: store.CHANNELS.filter((c) => adapters.channelOn(c.id)).map((c) => ({
        id: c.id,
        display: c.display,
        ...pool.poolSummary(c.id),
      })),
      platform: platform.form(),
      version: platform.version(),
      dataDir: process.env.AGENTHUB_DATA_DIR,
      encryption: process.env.AGENTHUB_SECRET_KEY ? "aes-256-gcm" : "plaintext",
    });
  }));
}

function registerPoolRoutes(app) {
  app.get("/api/accounts", handle((req, res) => {
    res.json({ ok: true, accounts: store.listAccounts() });
  }));
  // JSON 导入：body 为候选数组或 { channel, accounts: [...] }
  app.post("/api/accounts/import", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const body = req.body || {};
    // 桌面端账号列表导出是元数据包（无 token）：明确告知，不要逐条报“该候选不含可用凭据”
    if (!Array.isArray(body) && body.format === "agenthub-accounts") {
      res.status(400).json({
        ok: false,
        imported: 0,
        total: Array.isArray(body.accounts) ? body.accounts.length : 0,
        message: proxyIndex.METADATA_ONLY_MESSAGE,
        results: [],
      });
      return;
    }
    const list = Array.isArray(body) ? body : Array.isArray(body.accounts) ? body.accounts : [body.candidate || body];
    const channel = Array.isArray(body) ? "" : String(body.channel || "");
    const results = list.map((c) => {
      try {
        const r = discovery.importCandidate(c, channel || undefined);
        return { ok: true, id: r.id, updated: !!r.updated };
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
    });
    const okCount = results.filter((r) => r.ok).length;
    res.status(okCount ? 200 : 400).json({ ok: okCount > 0, imported: okCount, total: list.length, results });
  }));
  app.get("/api/channels", handle((req, res) => {
    res.json({
      ok: true,
      channels: store.CHANNELS.filter((c) => adapters.channelOn(c.id)).map((c) => ({
        id: c.id,
        display: c.display,
        ...pool.poolSummary(c.id),
      })),
    });
  }));
  app.get("/api/models", handle((req, res) => {
    res.json({ ok: true, models: adapters.listableModels(config.loadConfig().proxy) });
  }));
}

function registerConfigRoutes(app) {
  app.get("/api/config", handle((req, res) => {
    const c = config.loadConfig();
    res.json({ ok: true, config: { proxy: JSON.parse(JSON.stringify(c.proxy || {})), localgw: JSON.parse(JSON.stringify(c.localgw || {})) } });
  }));
  app.get("/api/config/webdav", handle((req, res) => {
    res.json({ ok: true, webdav: config.maskedSharedWebdav() });
  }));
  // 写统一 WebDAV/S3 配置：与桌面版设置页同一条落盘路径（掩码密码 = 保留原值）
  app.put("/api/config/webdav", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const r = config.saveSharedWebdav(req.body || {});
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, webdav: config.maskedSharedWebdav() } : r);
  }));
  // 备份：VACUUM INTO 一致性快照（WAL 下直接拷 stats.db 会丢最近事务）
  app.get("/api/backup", handle((req, res) => {
    const target = path.join(os.tmpdir(), `agenthub-stats-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`);
    try {
      store.vacuumInto(target);
      res.download(target, "stats.db", () => { try { fs.unlinkSync(target); } catch { /* 已清 */ } });
    } catch (e) {
      try { fs.unlinkSync(target); } catch { /* 不存在 */ }
      throw e; // 交给 handle 收敛为 500
    }
  }));
}

// 远程管理的统一命令通道：命令表经收集器取自桌面注册表（proxy 66 条 + localgw 43 条），
// Web UI 与桌面远程模式共用同一契约。前端拿到的信封与桌面 IPC 完全一致
// （{ok:true,...} / {ok:false,message}），错误处理零新增
function registerRpcRoutes(app) {
  app.get("/api/capabilities", (req, res) => {
    res.json({
      ok: true,
      platform: platform.form(),
      version: platform.version(),
      modules: ["proxy", "localgw", "prompts", "memory"],
      features: { serviceControl: false, sse: true, fileDialog: false },
      // deny 的文案随清单下发（前端不重复维护提示语）
      commands: Object.fromEntries(
        [...commandTable.keys()].map((cmd) => {
          const mode = modeOf(cmd);
          return [cmd, mode === "deny" ? { mode, reason: DENY[cmd] } : { mode }];
        })
      ),
    });
  });
  app.post("/api/rpc/:cmd", handle(async (req, res) => {
    const cmd = String(req.params.cmd || "");
    // 先查 DENY：即便命令未注册（如 pet/window/webdav），也要返回明确文案而不是 404
    if (modeOf(cmd) === "deny") {
      res.status(403).json({ ok: false, message: DENY[cmd] });
      return;
    }
    const fn = commandTable && commandTable.get(cmd);
    if (!fn) {
      res.status(404).json({ ok: false, message: `未知命令 ${cmd}（先看 /api/capabilities）` });
      return;
    }
    if (req.adminScope === "read" && modeOf(cmd) !== "read") {
      res.status(403).json({ ok: false, message: "只读令牌只能执行监视类命令（需要完整管理 token）" });
      return;
    }
    // 桌面 handler 统一形如 (event, args)，且全部不使用 event（实测 0 处），传 null 即可
    const r = await fn(null, req.body.args || {});
    // 门控失败（如 prompts_save 空条目）返回 {ok:false} 但 HTTP 状态仍是 200，前端按 ok 字段判定
    res.json(r);
  }));

  // 兼容旧前端：POST /api/rpc 且 body.cmd（Web 托管形态的 web-transport 走这里）
  app.post("/api/rpc", handle(async (req, res) => {
    const cmd = String((req.body || {}).cmd || "");
    if (!cmd) {
      res.status(400).json({ ok: false, message: "缺少 cmd 字段" });
      return;
    }
    if (modeOf(cmd) === "deny") {
      res.status(403).json({ ok: false, message: DENY[cmd] });
      return;
    }
    const fn = commandTable && commandTable.get(cmd);
    if (!fn) {
      res.status(404).json({ ok: false, message: `未知命令 ${cmd}（先看 /api/capabilities）` });
      return;
    }
    if (req.adminScope === "read" && modeOf(cmd) !== "read") {
      res.status(403).json({ ok: false, message: "只读令牌只能执行监视类命令（需要完整管理 token）" });
      return;
    }
    const r = await fn(null, (req.body || {}).args || {});
    res.json(r);
  }));
}

// 实时事件流（SSE）：复用 platform 的事件出口，信封与桌面 IPC 的 app:event 同形。
// 前端用 fetch 流订阅（EventSource 带不了自定义头，鉴权要靠 Bearer）
const sseClients = new Set();
function registerEventRoutes(app) {
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    const off = platform.onEmit((payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload && payload.event ? payload : { event: "proxy", ...payload })}\n\n`);
      } catch {
        /* 连接已断，close 收尾 */
      }
    });
    const keepAlive = setInterval(() => {
      try {
        res.write(": ka\n\n");
      } catch {
        /* 同上 */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      off();
      sseClients.delete(res);
    });
  });
}

// Web UI 静态托管：与 API 同源（前端 CSP connect-src 'self' 只允许同源请求）。
// 未内置 UI 时明确跳过——只有 API 的镜像照样能用
function registerUiRoutes(app) {
  const indexFile = path.join(UI_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    console.log(`[AgentHub Gateway] 未内置 Web UI（${UI_DIR}/index.html 不存在），仅提供管理 API`);
    return;
  }
  app.use(express.static(UI_DIR, { index: false }));
  // SPA 入口兜底：非 /api 前缀一律回 index.html（前端无路由库，保住未来加路由不被 404）
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(indexFile));
  console.log(`[AgentHub Gateway] Web UI 已挂载：${UI_DIR}`);
}

/**
 * 外置插件（容器形态的能力边界）。
 *
 * ── 为什么单独一组路由 ────────────────────────────────────────
 * 桌面版的 plugin_* 注册在 electron/backend/ipc.cjs（依赖 BrowserWindow / dialog），
 * 而 collectCommands() 只收 proxy / localgw / prompts / memory 四个模块 —— 所以
 * /api/rpc/plugin_list 这类调用会 404。容器里能做什么、不能做什么，在这里写清楚：
 *
 *   可做：列出已装插件 / 启停 / 卸载 / 授权（都是纯文件与进程操作）
 *   不可做：安装（桌面版是文件对话框选 zip；容器没有对话框，也没有可浏览的本地磁盘）
 *
 * 安装的替代路径：把签名 zip 放进数据卷的 plugins 目录（docker-compose 里挂的
 * `${AGENTHUB_DATA_DIR}`），重启容器时 resumeEnabled 会自动加载。
 */
function registerPluginRoutes(app) {
  app.get("/api/plugins", handle((_req, res) => {
    try { res.json({ ok: true, plugins: pluginHost.list() }); }
    catch (e) { res.json({ ok: false, plugins: [], message: String((e && e.message) || e) }); }
  }));
  app.post("/api/plugins/install", handle((req, res) => {
    if (!requireFull(req, res)) return;
    res.status(501).json({
      ok: false,
      message: "容器里没有文件对话框，无法选择插件包。把签名 zip 放进数据卷的 plugins 目录后重启容器（启动时会自动加载）。",
    });
  }));
  app.post("/api/plugins/:id/toggle", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const out = await pluginHost.toggle(String(req.params.id || ""), !!req.body?.enabled);
    res.json(out);
  }));
  app.post("/api/plugins/:id/uninstall", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const out = await pluginHost.uninstall(String(req.params.id || ""));
    res.json(out);
  }));
  app.post("/api/plugins/:id/authorize", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const out = await pluginHost.authorize(String(req.params.id || ""), {
      permissions: req.body?.permissions,
      channels: req.body?.channels,
    });
    res.json(out);
  }));
}

function startAdmin() {
  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(adminAuth);
  registerProbes(app);
  registerPoolRoutes(app);
  registerPluginRoutes(app);
  registerConfigRoutes(app);
  registerRpcRoutes(app);
  registerEventRoutes(app);
  registerUiRoutes(app);

  const srv = app.listen(ADMIN_PORT, ADMIN_BIND);
  // 监听失败必须显式收口：否则 unhandled 'error' 直接崩掉整个进程（含在跑的本地网关）
  srv.on("error", (e) => {
    console.error(`[AgentHub Gateway] 管理 API 监听 ${ADMIN_BIND}:${ADMIN_PORT} 失败:`, e.message);
    process.exit(1);
  });
  return srv;
}

// ===== 停机（docker stop / compose down 的 SIGTERM）=====
let stopping = false;
async function shutdown(signal) {
  if (stopping) return; // 幂等闸：重复信号不重入（最终由 docker 的 kill 超时兜底）
  stopping = true;
  console.log(`[AgentHub Gateway] 收到 ${signal}，开始停机…`);
  try { if (adminServer) adminServer.close(); } catch { /* 已关 */ }
  for (const c of sseClients) { try { c.end(); } catch { /* 已断 */ } } // 主动收掉长连接，停机不留悬挂
  const drain = (async () => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    try { await localgw.shutdown(); } catch { /* 未装配 */ }
    return { drained: true, remainingMs: Math.max(0, deadline - Date.now()) };
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ drained: false }), DRAIN_TIMEOUT_MS));
  const drained = await Promise.race([drain, timeout]);
  extensionPool.close();
  pluginHost.killAll();
  console.log(`[AgentHub Gateway] 本地网关已停（${drained.drained ? "已排空" : "超时强断"}）`);
  try { proxyIndex.stopTimers(); } catch { /* 未装配 */ }
  try { await poolsync.cancel(); } catch { /* 在途同步收尾 */ }
  try { const p = require(path.join(BACKEND_DIR, "prompts", "index.cjs")); p.shutdown(); } catch { /* 未装配 */ }
  try { const m = require(path.join(BACKEND_DIR, "memory", "index.cjs")); m.shutdown(); } catch { /* 未装配 */ }
  try { store.close(); } catch { /* 句柄随进程退出 */ }
  if (lockFile) { try { fs.unlinkSync(lockFile); } catch { /* 已清 */ } }
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

main().catch((e) => {
  console.error("[AgentHub Gateway] 启动失败:", (e && e.stack) || e);
  process.exit(1);
});
