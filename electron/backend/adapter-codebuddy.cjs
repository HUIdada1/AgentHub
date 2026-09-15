// CodeBuddy 数据源适配器（腾讯云 CodeBuddy IDE）
// 权威数据源：%LOCALAPPDATA%\CodeBuddyExtension\Data\<userUuid>\CodeBuddyIDE\<installUuid>\history\<projectHash>\<sessionId>\index.json
//   会话级 index.json 的 requests[].usage 含每请求 token 用量（inputTokens/outputTokens/totalTokens/lastTokens），
//   request.startedAt 为发生时间；模型名不在 usage 里，须用同会话 messages\<msgId>.json 的
//   extra.requestId → extra.modelId 关联归因。
// 口径：inputTokens 为总口径（含缓存写入，与本项目其余源一致）；实测 total = input + output；
//   reasoning / cache_read / cache_write 细分仅存在于 IDE 滚动日志（notifyStepEnd 行），本地无持久化明细，一期记 0。
// 限制：credits 余额/消耗总量本地不存在（配置缓存均为 DPAPI v10 密文），本源仅做 token 用量统计。
// 国内版预留：CodeBuddy CN 数据目录尚未实测，候选根含 "CodeBuddyExtension CN"，产生数据后验证同构即自动生效。
// 设备标识：无稳定设备文件，返回 null 走 sync.cjs 统一回退链（同 reasonix）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

const ID = "codebuddy";
const NAME = "CodeBuddy";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/**
 * 候选数据根（按优先级）。环境变量供自测注入（reasonix 同款约定）；
 * 国际版实测目录为 %LOCALAPPDATA%\CodeBuddyExtension，国内版预留 CN 后缀候选。
 */
function candidateRoots() {
  const out = [];
  const env = String(process.env.CODEBUDDY_DATA_HOME || "").trim();
  if (env) out.push(path.resolve(env));
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
  out.push(path.join(localAppData, "CodeBuddyExtension"));
  out.push(path.join(localAppData, "CodeBuddyExtension CN"));
  // 去重保序
  return [...new Set(out)];
}

/** 数据目录：首个真实存在的候选；都不存在返回 null */
function detect() {
  for (const dir of candidateRoots()) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** 校验：Data 目录存在即通过（history 结构校验在 extract 内进行） */
function validate(dir) {
  return !!dir && fs.existsSync(path.join(dir, "Data"));
}

/**
 * 设备标识：CodeBuddy 本地无稳定设备文件，返回 null 由 sync.cjs 回退链兜底。
 */
function getDeviceId() {
  return null;
}

/**
 * 定位全部会话历史根目录 .../history。
 * 实测结构 Data/<userUuid>/CodeBuddyIDE/<installUuid>/history，固定四层扫描；
 * 中间层不按名筛选（容忍 CN 版目录名差异），history 名字精确匹配不会误入 Cache/check-point 等兄弟目录；
 * 兼容三层变体（app 目录下直接是 history）。
 */
function findHistoryDirs(root) {
  const out = [];
  const dataDir = path.join(root, "Data");
  if (!fs.existsSync(dataDir)) return out;
  let level1 = [];
  try {
    level1 = fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  const pushIfHistory = (dir, user) => {
    try {
      const historyDir = path.join(dir, "history");
      if (fs.existsSync(historyDir) && fs.statSync(historyDir).isDirectory()) {
        out.push({ historyDir, userDir: user });
      }
    } catch {
      /* 不可读的目录跳过 */
    }
  };
  for (const user of level1) {
    const userDir = path.join(dataDir, user.name);
    let level2 = [];
    try {
      level2 = fs.readdirSync(userDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const app of level2) {
      const appDir = path.join(userDir, app.name);
      // 变体兼容：app 目录下直接是 history
      pushIfHistory(appDir, user.name);
      let level3 = [];
      try {
        level3 = fs.readdirSync(appDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      for (const inst of level3) {
        pushIfHistory(path.join(appDir, inst.name), user.name);
      }
    }
  }
  return out;
}

/** 时间戳兼容读取：毫秒 / 秒 / ISO 字符串；无法解析返回 null */
function toMs(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    // 秒级时间戳（< 1e12 ≈ 2001-09 的毫秒值）换算为毫秒
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }
  if (typeof v === "string" && v.trim()) {
    const t = new Date(v).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** 非负有限数字，非法返回 0（db 层 safeToken 之外的适配器侧兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 模型归因表：扫会话 messages/*.json，按 extra.requestId 建立 requestId → modelId 映射。
 * 单条消息文件几十 KB 内，JSON 失败跳过；目录不存在返回空表（模型记 unknown）。
 */
function buildModelMap(sessionDir) {
  const map = new Map();
  const msgDir = path.join(sessionDir, "messages");
  let files = [];
  try {
    files = fs.readdirSync(msgDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json"));
  } catch {
    return map;
  }
  for (const f of files) {
    try {
      const msg = JSON.parse(fs.readFileSync(path.join(msgDir, f.name), "utf8"));
      // 实测 extra 为 JSON 字符串（需二次解析），兼容直接是对象的形态
      let extra = msg && typeof msg === "object" ? msg.extra : null;
      if (typeof extra === "string") {
        try {
          extra = JSON.parse(extra);
        } catch {
          continue;
        }
      }
      if (!extra || typeof extra !== "object") continue;
      if (typeof extra.requestId === "string" && extra.requestId && typeof extra.modelId === "string" && extra.modelId) {
        map.set(extra.requestId, extra.modelId);
      }
    } catch {
      /* 损坏消息跳过 */
    }
  }
  return map;
}

/**
 * 增量抽取：只采 requests[] 中 startedAt > since 且带 usage 的请求。
 * index.json 为会话期追加写（与 codex rollout 同性质）：mtime 早于回扫窗口起点的文件
 * 不可能包含 startedAt > since 的新请求，直接跳过，避免每次同步全量读盘解析。
 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 CodeBuddy 会话数据目录：${path.join(dir, "Data")}`);

  const out = [];
  for (const { historyDir, userDir } of findHistoryDirs(dir)) {
    let projects = [];
    try {
      projects = fs.readdirSync(historyDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const project of projects) {
      const projectDir = path.join(historyDir, project.name);
      let sessions = [];
      try {
        sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      for (const session of sessions) {
        const sessionDir = path.join(projectDir, session.name);
        const indexFile = path.join(sessionDir, "index.json");
        if (!fs.existsSync(indexFile)) continue;
        if (since > 0) {
          try {
            if (fs.statSync(indexFile).mtimeMs <= since) continue;
          } catch {
            /* stat 失败按原逻辑全量解析 */
          }
        }

        let index;
        try {
          index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
        } catch {
          continue; // 损坏索引跳过（与 codex 损坏行处理一致），不阻断其余会话
        }
        const requests = Array.isArray(index?.requests) ? index.requests : [];
        if (requests.length === 0) continue;

        // 有可用请求才扫描消息文件做模型归因
        let modelMap = null;
        const ensureModelMap = () => {
          if (!modelMap) modelMap = buildModelMap(sessionDir);
          return modelMap;
        };

        for (let i = 0; i < requests.length; i++) {
          const req = requests[i];
          if (!req || typeof req !== "object") continue;
          const usage = req.usage && typeof req.usage === "object" ? req.usage : null;
          if (!usage) continue;
          const startedAt = toMs(req.startedAt);
          if (startedAt === null || startedAt <= since) continue;
          // 无任何 token 数值的请求不入库（请求失败/空轮次/全 0 轮次，本源无 credits 口径）
          if (num(usage.inputTokens) === 0 && num(usage.outputTokens) === 0) continue;

          const rawModel = ensureModelMap().get(String(req.id ?? "")) || "unknown";
          const modelId = normalizeModel(rawModel);
          const reqId = typeof req.id === "string" && req.id ? req.id : `seq${i}`;
          out.push({
            // 追加请求序号保证唯一：同会话重复 req.id（重试）是两次真实消耗，
            // 共用 id 会被 INSERT OR REPLACE 覆盖而少记（2026-09-10 审查修复 P3）
            id: `${deviceId}:codebuddy:${userDir}:${session.name}:${reqId}:${i}`,
            deviceId,
            deviceName,
            source: ID,
            // providerId 传 "tencent"：模型推断未命中时显示「未知供应商:tencent」（providerName 有 8 字符截断）
            providerId: providerName("tencent", modelId),
            modelId,
            sessionId: session.name,
            inputTokens: num(usage.inputTokens),
            outputTokens: num(usage.outputTokens),
            reasoningTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            startedAt,
            completedAt: startedAt,
            status: req.state === "complete" ? "success" : String(req.state || "success"),
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract };
