/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-06
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 科大讯飞 Loomy 数据源适配器
// 权威数据源：C:\Users\Public\Loomy\<用户名 SHA256 前 12 位>\share\opencode\opencode.db
//   message 表每行一条消息，data 为 opencode 风格 JSON；assistant 消息在轮次结束后回填
//   data.tokens = { total, input, output, reasoning, cache: { write, read } }，五项之和 = total。
//   路径口径来自 Loomy 主进程 config-path.js 的 getConfigRoot()：
//   Windows 下数据被重定向到公共目录（不随 %APPDATA% 走），旧版 ~/.local/share/loomy 已迁移，
//   因此按「用户名哈希目录」定位 + 目录扫描兜底，不做 %APPDATA% 猜测。
// 口径（2026-11-06 本机实测，v0.9.39）：
//   - opencode 的 input 是新鲜输入（不含缓存读），入库前并入 cache.read，对齐全系统基线
//     「input_tokens 含 cache_read_tokens」（db.cjs 计费与净输入按相减拆分，口径错位会导致
//     命中率超 100%、计费为负），与 dsh / mimo / autoclaw 同款归一化；
//   - providerID 本机恒为 imodel（Loomy 自有模型网关），统一记为「Loomy」；
//     用户自建供应商的行按原始 providerID 记录，不冒充官方；
//   - mode 全收：loomy（对话）/ memory_extraction（记忆抽取）都是真实消耗，
//     agent / variant（思考档位）一并带上，界面可按 agent 维度拆开看；
//   - 五桶全 0 的消息不采集（免费模型 / 被中断的空轮次），同 mimo：锚点只被已成型消息推进；
//   - 积分（points）不在本适配器采集：Loomy 的积分流水按「会话聚合」记账（粒度到整段对话，
//     不落到单条消息），且需要有效登录态走云接口；与本库的逐条 token 口径混算会把总量算花，
//     积分余额留在「号池管家 · Loomy 渠道」看。
// 设备标识：Loomy 没有可直读的安装 ID（主进程按 node-machine-id + 钥匙串生成），
//   返回 null 交给上层回退链，与 grok 缺失 agent_id 时同策。
// 幂等键：deviceId:loomy:messageId——tokens 回填时同 id 覆盖更新。
// 时间：startedAt 取 data.time.created（毫秒，与 time_created 列一致），completedAt 取 data.time.completed；
//   增量锚点按 time_updated 过滤（= 轮次结算时刻，见 extract 内注释），不用 time_created。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeModel } = require("./adapter-zcode.cjs");
const { openReadOnly } = require("./temp-util.cjs");

const ID = "loomy";
const NAME = "Loomy";
const PROVIDER = "Loomy";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** Loomy 在 Windows 上的公共数据根：C:\Users\Public\Loomy（主进程 config-path.js） */
function publicRoot() {
  const pub = process.env.PUBLIC || path.join(path.parse(homeDir()).root || "C:\\", "Users", "Public");
  return path.join(pub, "Loomy");
}

/** 当前用户名对应的哈希目录（SHA256(username) 前 12 位，与 Loomy 主进程 _getUserHash 一致） */
function hashedRoot() {
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = "";
  }
  if (!username) return null;
  const hash = crypto.createHash("sha256").update(username).digest("hex").slice(0, 12);
  return path.join(publicRoot(), hash);
}

/** 自测注入环境变量覆盖（临时目录隔离，不触碰真实数据） */
function resolveRoot() {
  const env = String(process.env.LOOMY_HOME || "").trim();
  return env ? path.resolve(env) : hashedRoot();
}

/** 数据根下可能存在多个用户哈希目录：哈希目录不可用时扫描同级的第一个可用目录 */
function scanRoot() {
  const base = publicRoot();
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(base, entry.name);
    if (fs.existsSync(dbFile(candidate))) return candidate;
  }
  return null;
}

/** 数据库路径：<root>\share\opencode\opencode.db（也接受直接指向 share\opencode 的自定义目录） */
function dbFile(root) {
  if (!root) return "";
  const candidates = [
    path.join(root, "share", "opencode", "opencode.db"),
    path.join(root, "opencode", "opencode.db"),
    path.join(root, "opencode.db"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

/** 数据库文件存在即探测成功（与其他源 detect 返回「数据根」一致） */
function detect() {
  const root = resolveRoot();
  if (root && fs.existsSync(dbFile(root))) return root;
  if (String(process.env.LOOMY_HOME || "").trim()) return null;
  return scanRoot();
}

function validate(root) {
  try {
    const file = dbFile(root);
    return !!file && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** 无稳定安装 ID 可读：返回 null，由上层 deviceId 回退链兜底 */
function getDeviceId() {
  return null;
}

/** 非负有限数字，非法返回 0（与 mimo / grok 同款兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一条 assistant 消息 → 事件记录；tokens 缺失 / 五桶全 0 / 时间非法返回 null */
function mapRow(deviceId, deviceName, row, data) {
  const t = data && data.tokens && typeof data.tokens === "object" ? data.tokens : null;
  if (!t) return null;
  const cache = t.cache && typeof t.cache === "object" ? t.cache : {};
  const input = num(t.input);
  const output = num(t.output);
  const reasoning = num(t.reasoning);
  const cacheRead = num(cache.read);
  const cacheWrite = num(cache.write);
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) return null;

  const time = data.time && typeof data.time === "object" ? data.time : {};
  const startedAt = Number(time.created) || Number(row.time_created);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const completedAt = Number(time.completed);

  const providerId = typeof data.providerID === "string" && data.providerID ? data.providerID : "";
  return {
    id: `${deviceId}:${ID}:${row.id}`,
    deviceId,
    deviceName,
    source: ID,
    // imodel = Loomy 自有模型网关；自建供应商保留原文，避免把第三方用量记到官方头上
    providerId: !providerId || providerId === "imodel" ? PROVIDER : providerId,
    modelId: data.modelID ? normalizeModel(data.modelID) : "unknown",
    variant: typeof data.variant === "string" && data.variant ? data.variant : undefined,
    sessionId: typeof row.session_id === "string" && row.session_id ? row.session_id : undefined,
    agent: typeof data.agent === "string" && data.agent ? data.agent : undefined,
    mode: typeof data.mode === "string" && data.mode ? data.mode : undefined,
    // 口径对齐：全系统基线 input 含 cache.read，opencode 的 input 为新鲜输入，故入库前并入；
    // 总量仍与源端 total 一致，不重复计
    inputTokens: input + cacheRead,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    startedAt,
    completedAt: Number.isFinite(completedAt) && completedAt > 0 ? completedAt : undefined,
    status: messageStatus(data),
  };
}

/** 状态：opencode 用 finish 表达收尾方式，异常行另有 error 字段；其余按成功计 */
function messageStatus(data) {
  const finish = String((data && data.finish) || "").trim().toLowerCase();
  if (finish === "error" || (data && data.error)) return "error";
  if (finish === "aborted" || finish === "cancelled" || finish === "canceled") return "cancelled";
  return "success";
}

/**
 * 增量抽取：time_updated > since 的消息。
 * 为什么不用 time_created：opencode 在**轮次结束**时才把 tokens 回填进 message.data，
 * 同时刷新 time_updated（本机实测两者相等，= data.time.completed）。长轮次可能跨过锚点，
 * 按创建时间过滤会漏掉「创建得早、结算得晚」的那条；按更新时间去重扫则天然覆盖，
 * 重复读到的同 id 记录由 INSERT OR REPLACE 幂等覆盖。
 * data 损坏（半截 JSON）跳过该行，下轮回扫补采。
 */
function extract(dir, deviceId, deviceName, since) {
  const file = dbFile(dir);
  if (!validate(dir)) {
    throw new Error(`未找到 ${NAME} 数据库：${file}`);
  }
  const sinceMs = Number(since) || 0;
  // Loomy 运行中持续写 WAL：openReadOnly 复制三件套到临时副本再读（exit 钩子兜底清理）
  const conn = openReadOnly(file, "dosage-sync-loomy-");
  const out = [];
  try {
    const rows = conn
      .prepare("SELECT id, session_id, time_created, data FROM message WHERE time_updated > ? ORDER BY time_created ASC")
      .all(sinceMs);
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!data || data.role !== "assistant") continue;
      const rec = mapRow(deviceId, deviceName, row, data);
      if (rec) out.push(rec);
    }
  } finally {
    conn.close();
  }
  return out;
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, _internal: { mapRow, num, dbFile, hashedRoot } };
