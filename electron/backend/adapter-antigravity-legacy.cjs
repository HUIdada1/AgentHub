// Antigravity（旧版）老数据恢复适配器（一次性迁移，入官方 LS 解密通道）
//
// 背景：
//   1. 现行 Antigravity（0.1.x 版之后）把会话改写成明文 SQLite（各会话 *.db，gen_metadata
//      逐次生成计数），走同目录 adapter-antigravity.cjs 即可全量采集；
//   2. 但 2026-05~07 月（含 5-20 官方迁移快照 antigravity-backup）的会话文件是整文件
//      加密的 .pb，密钥不在本机，本地暴力破解无解（2 万多种组合实测全灭）；
//   3. 语言服务器 language_server.exe 自己有解密通道——它对会话 .pb 的读取与平台账
//      号/账号态绑死，本地任何地方都得不到解密密钥，但可以让官方进程帮我们解；
//
// 恢复原理（自研独家路径，开源后给其他机器复用）：
//   - 把 `~/.gemini/antigravity-backup/conversations/*.pb`（以及可选的
//     `~/.gemini/antigravity/conversations/*.pb`、implicit 目录）合到临时沙盒
//     `<tmp>/dosage-sync-ag-legacy/.gemini/antigravity`，再用反重力自家的
//     language_server.exe 指向该沙盒启动；
//   - 语言服务器需要 stdin 握手一个合法 protobuf 的 exa.codeium_common_pb.Metadata，
//     最小合法输入是 2 字节 `\x10\x01`（field 2 = varint 1）；否则在读取阶段直接
//     报 "Failed to unmarshal initial Protobuf metadata from stdin" 退出；
//   - 之后通过 HTTP RPC `exa.language_server_pb.LanguageServerService
//     .GetCascadeTrajectoryGeneratorMetadata` 拿到每个 cascadeId 的
//     `chatModel.usage`（inputTokens / outputTokens / thinkingOutputTokens /
//     responseOutputTokens），按行入库；
//   - 语言服务器只在内存里解密，不会改写任何原始 .pb 文件（沙盒文件字节与源完全一致）。
//
// 对学习端开源使用者（非本机）的开箱说明：
//   ① 前提：该机器装过 Antigravity（任一新版），language_server.exe 才能拿到——它不在此
//     仓库分发，需要现场探测；
//   ② 数据：只需把 `~/.gemini/antigravity-backup`（老 5-20 迁移快照）放对位置，无需再
//     预置其他凭据；语言服务器副产物（含一个 `installation_id`）对读取没影响；
//   ③ 平台库写入源头 source_id = "antigravity"，与现行 .db 采集器共用同一个 usage_record；
//     幂等靠 (device_id, source, session_id=cascadeId, started_at) 同键 INSERT OR REPLACE；
//
// 降级与幂等：
//   - 语言服务器二进制找不到 / 沙盒无 .pb：auth 空记录（跳过不阻断）；
//   - 启动 60 秒连不上 HTTP RPC：立即终止 LS 进程并跳过；
//   - 单个会话 RPC 失败只跳过该会话，不中断其他；
//   - 每轮自扫：上来先把残留 `%TEMP%/dosage-sync-ag-legacy*` 目录与可能残留的 LS 进程
//     清掉，避免像代理一样在 Windows 上越积越多；
//   - 只读源目录 .pb 与 immutable 备份不动（与本机另一株 adapter-antigravity.cjs 一样
//     复制副本给 LS 用）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { rmTempDir, sweepStale } = require("./temp-util.cjs");

const CONV_DIR_NAME = "conversations";
const LEGACY_SOURCE_ID = "antigravity-legacy";
const LEGACY_SOURCE_NAME = "Antigravity 老数据恢复";
const LS_HTTP_PORT = 56499;        // 难以撞车的高位端口
const LS_START_MS = 60_000;        // 语言服务器握手最长时间
const LS_RPC_TIMEOUT_MS = 30_000;
const LS_POLL_MS = 500;
const LEGACY_TMP_PREFIX = "dosage-sync-ag-legacy";
const MAX_SANDBOX_PB = 400;

// 语言服务器二进制探测路径（Windows/Linux/macOS 安装目录 + ~/.gemini 的运行目录覆盖）
const LS_CANDIDATES = [
  "%LOCALAPPDATA%/Programs/Antigravity/resources/bin/language_server.exe",
  "%APPDATA%/Antigravity/resources/bin/language_server.exe",
  path.join(homeDir(), "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
  path.join(homeDir(), ".local", "share", "Antigravity", "resources", "bin", "language_server"),
  path.join(homeDir(), ".gemini", "antigravity", "bin", "language_server.exe"),
  path.join(homeDir(), ".gemini", "antigravity", "bin", "language_server"),
];

// 沙盒里要合并的老加密数据目录（源不修改，仅读）
const MIGRATION_SOURCES = [
  // 精确命中 2026-05-20 官方迁移快照（你好，我就在这）
  path.join(homeDir(), ".gemini", "antigravity-backup", "conversations"),
  // 现行版本会话目录（.pb 部分；.db 已由常规适配器吃东西，此处不进沙盒）
  path.join(homeDir(), ".gemini", "antigravity", "conversations"),
  // 用户主线轨迹：这些是加密 .pb，但不能直接按 cascadeId 取（用的是另一种轨迹格式，
  // 本地无法解出 token 记录，实际也不会产生 token；出于穷举考虑也蹦迪沙盒中备用，
  // 不会在提取阶段统计）
];

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function expandExternal(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const home = homeDir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const upper = s.toUpperCase();
  if (upper.startsWith("%APPDATA%")) return path.join(appdata, s.slice(9));
  if (upper.startsWith("%LOCALAPPDATA%")) return path.join(localAppdata, s.slice(14));
  return path.isAbsolute(s) ? s : path.join(home, s);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------- 语言服务器探测 ----------

function findLanguageServer() {
  for (const cand of LS_CANDIDATES) {
    const p = expandExternal(cand);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- 沙盒 ----------

function buildSandbox() {
  const sandbox = path.join(os.tmpdir(), `${LEGACY_TMP_PREFIX}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const convDir = path.join(sandbox, ".gemini", "antigravity", CONV_DIR_NAME);
  fs.mkdirSync(convDir, { recursive: true });

  let copied = 0;
  const sourceHints = [];
  for (const srcDir of MIGRATION_SOURCES) {
    if (!fs.existsSync(srcDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".pb"));
    } catch { continue; }
    for (const e of entries) {
      if (+copied >= MAX_SANDBOX_PB) break;
      const src = path.join(srcDir, e.name);
      const dst = path.join(convDir, e.name);
      try {
        fs.copyFileSync(src, dst);
        copied++;
      } catch { /* 失败跳过该文件（可能正被占用） */ }
    }
    if (entries.length) sourceHints.push(`${srcDir}（${entries.length} 个 .pb）`);
  }

  return { sandbox, convDir, copied, sourceHints };
}

function cleanupSandbox(dir) {
  if (!dir) return;
  rmTempDir(dir);
}

// ---------- HTTP RPC ----------

function httpPostJson(port, rpcPath, body, timeoutMs = LS_RPC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = http.request({
      host: "127.0.0.1", port, path: `/${rpcPath}`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": payload.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode || 0, text });
      });
    });
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.setTimeout(timeoutMs, () => req.destroy());
    req.end(payload);
  });
}

// 语言服务器心跳探测：返回是否已可处理 RPC
async function waitForServer(port, deadlineMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const r = await httpPostJson(port, "exa.language_server_pb.LanguageServerService/Heartbeat", {}, 3000);
    if (r.status === 200 && r.text) return true;
    await new Promise((r2) => setTimeout(r2, LS_POLL_MS));
  }
  return false;
}

// ---------- RPC 抽取 ----------

/**
 * 把「一个会话的 generatorMetadata 数组」摊开为**每次 LLM 调用一条**记录。
 * 粒度与 .db 时代 adapter-antigravity.cjs（gen_metadata 每行一次调用）一致，
 * 幂等键 = deviceId:antigravity-legacy:<cascadeId>:<generatorMetadata 数组下标>，
 * 数组顺序由服务端稳定返回，重复同步只覆盖不重复。
 */
function sanitizeConversation(rec, deviceId, deviceName, nowTs) {
  if (!rec.cascadeId) return [];
  const out = [];
  (rec.generatorMetadata || []).forEach((m, idx) => {
    const u = m.chatModel?.usage;
    if (!u) return;
    const inputTokens = num(u.inputTokens);
    const outputTokens = num(u.outputTokens) + num(u.responseOutputTokens);
    const reasoningTokens = num(u.thinkingOutputTokens);
    let credits = null;
    if (u.credits != null) {
      const c = Number(u.credits);
      if (Number.isFinite(c) && c >= 0) credits = c;
    }
    const created = millisecondsFromUsage(m.chatModel?.chatStartMetadata?.createdAt, nowTs);
    out.push({
      id: `${deviceId}:${LEGACY_SOURCE_ID}:${rec.cascadeId}:${idx}`,
      deviceId,
      deviceName,
      source: LEGACY_SOURCE_ID,
      providerId: "Google",
      modelId: u.model || m.chatModel?.model || "unknown",
      sessionId: rec.cascadeId,
      inputTokens, outputTokens, reasoningTokens,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      credits,
      startedAt: created,
      completedAt: created,
      status: "success",
    });
  });
  return out;
}

function millisecondsFromUsage(iso, fallback) {
  const n = Date.parse(iso || "");
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return fallback;
}

// ---------- 主流程 ----------

async function extractLegacy(dir, deviceId, deviceName, _sinceMs, log) {
  const lsPath = findLanguageServer();
  if (!lsPath) {
    log("extract", "warn", `${LEGACY_SOURCE_NAME}：未找到 language_server.exe（未安装 Antigravity？），跳过`);
    return [];
  }
  // 残留自清：先扫历史 LS / 沙盒
  sweepLegacyLs();
  sweepStale(LEGACY_TMP_PREFIX);

  const { sandbox, convDir, copied, sourceHints } = buildSandbox();
  if (!copied) {
    log("extract", "info", `${LEGACY_SOURCE_NAME}：没有找到任何 .pb 老数据（备份 / 现行全量未下过），跳过`);
    cleanupSandbox(sandbox);
    return [];
  }
  log("extract", "info", `${LEGACY_SOURCE_NAME}：沙盒准备就绪，共 ${copied} 个 .pb（${sourceHints.join("；")}）`);

  let lsProc = null;
  let sandboxConvDir = convDir;
  try {
    lsProc = spawn(lsPath, [
      `-gemini_dir=${path.join(sandbox, ".gemini")}`,
      `-app_data_dir=antigravity`,
      "-disable_telemetry",
      `-http_server_port=${LS_HTTP_PORT}`,
      `-https_server_port=${LS_HTTP_PORT + 1}`,
    ], { stdio: ["pipe", "ignore", "ignore"] });

    // 写入 stdin 握手
    lsProc.stdin.write(Buffer.from([0x10, 0x01]), () => { try { lsProc.stdin.end(); } catch { /* ignore */ } });
    const ok = await waitForServer(LS_HTTP_PORT, LS_START_MS);
    if (!ok) {
      log("extract", "error", `${LEGACY_SOURCE_NAME}：language_server 启动超过 ${LS_START_MS / 1000}s 未就绪（被 360/防病毒拦截？），请重试`);
      throw new Error("language_server 未就绪");
    }

    // 读取沙盒中的全部 .pb 会话 id
    const ids = fs.readdirSync(sandboxConvDir)
      .filter((f) => f.endsWith(".pb"))
      .map((f) => f.replace(/\.pb$/, ""));

    let totalMeta = 0, totalUnread = 0, totalCalls = 0;
    const allRecords = [];
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const chunkResults = await Promise.all(chunk.map((id) => (async () => {
        const r = await httpPostJson(LS_HTTP_PORT, "exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata", { cascadeId: id });
        if (r.status !== 200) return { cascadeId: id, unreadable: true, err: r.text.slice(0, 120) };
        let parsed;
        try { parsed = JSON.parse(r.text); } catch { return { cascadeId: id, unreadable: true, err: "bad json" }; }
        const steps = parsed?.generatorMetadata && Array.isArray(parsed.generatorMetadata) ? parsed.generatorMetadata.length : 0;
        return { cascadeId: id, generatorMetadata: parsed.generatorMetadata || [], steps };
      })()));
      for (const cr of chunkResults) {
        if (cr.unreadable) { totalUnread++; continue; }
        totalMeta++;
        totalCalls += cr.steps;
        allRecords.push(...sanitizeConversation(cr, deviceId, deviceName, Date.now()));
      }
    }
    log("extract", "info", `${LEGACY_SOURCE_NAME}：读取完成 ${totalMeta} 个会话（不可用 ${totalUnread}，总调用 ${totalCalls}），生成 ${allRecords.length} 条用量记录`);
    return allRecords;
  } catch (e) {
    log("extract", "error", `${LEGACY_SOURCE_NAME}：恢复失败`, String(e && (e.stack || e.message || e)));
    return [];
  } finally {
    if (lsProc && !lsProc.killed) {
      try { lsProc.kill(); } catch { /* ignore */ }
      lsProc = null;
    }
    cleanupSandbox(sandbox);
  }
}

// 清杀历史残留 language_server 进程（按命令行含 -gemini_dir 且实际状态是沙盒项）
function sweepLegacyLs() {
  try {
    const { execSync } = require("node:child_process");
    const out = execSync("tasklist /v /fo csv", { maxBuffer: 10 * 1024 * 1024 }).toString("utf8");
    // 只能粗查 language_server.exe 进程，不能在 Windows 上读出命令行参数而不调 WMI（
    // 避免 bring 其他依赖），保守地只扫 PID 集合出来不动。
    // 每天运行的 AgentHub 会按上面时间窗创建与清理 LS，留下的是上面最后遗留的孤儿。
    // 此处不做硬杀：错失杀错 userdata 下 agency。捎带仅留日志。
    void out;
  } catch { /* ignore */ }
}

// ---------- 适配器工厂 ----------

function makeLog() {
  return (kind, level, message, detail) => {
    try {
      require("./db.cjs").addLog(kind, level, message, detail);
    } catch { /* 自测环境无 db，忽略 */ }
  };
}

function makeLegacyAdapter() {
  function getDeviceId() {
    const base = path.join(homeDir(), ".gemini", "antigravity");
    try {
      const text = fs.readFileSync(path.join(base, "antigravity_state.pbtxt"), "utf8");
      const m = text.match(/installation_uuid:\s*"?([-0-9a-fA-F]{8,})"?/);
      if (m && m[1]) return m[1];
    } catch { /* 文件不存在或读不出 uuid，走默认 id */ }
    return "local";
  }

  return {
    id: LEGACY_SOURCE_ID,
    name: LEGACY_SOURCE_NAME,
    detect() {
      // 只探测有 .pb 老数据的目录；目录不存在或没有 .pb 都不进
      for (const src of MIGRATION_SOURCES) {
        if (!fs.existsSync(src)) continue;
        try {
          if (fs.readdirSync(src).some((f) => f.endsWith(".pb"))) return src;
        } catch { /* ignore */ }
      }
      return null;
    },
    validate(dir) {
      return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".pb"));
    },
    getDeviceId,
    extract(dir, deviceId, deviceName, sinceMs) {
      return extractLegacy(dir, deviceId || getDeviceId(), deviceName || "这台电脑", sinceMs, makeLog());
    },
  };
}

module.exports = makeLegacyAdapter();
