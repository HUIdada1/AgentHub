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
// Qoder / Qoder CN 数据源公共工厂
// 用量权威来源：~/.qoder{,-cn}/projects/<路径编码项目>/<sessionId>.jsonl（会话转录，追加写）
//   assistant 行 message.usage 含 Anthropic 口径五桶 token（input_tokens / output_tokens /
//   cache_creation_input_tokens / cache_read_input_tokens），官方模型另有 credits 额度点。
// 口径（2026-09-10 本机实测）：
//   - 官方模型（qmodel / qfmodel 系列）：本地五桶 token 全 0，按 credits 额度点计量（服务端计量，
//     客户端本地不落盘 token 明细）；credits 写入 usage_record.credits 独立列。
//   - 自定义 BYOK（模型名形如 "qoder-custom-<uuid>/<真名>"）：五桶 token 真实完整，无 credits。
//   - usage 是 Anthropic 原生语义：input_tokens 只含「新鲜输入」，cache_read / cache_creation 是
//     另列的互斥桶（字段名与 Anthropic API 逐字一致：cache_read_input_tokens 等）。入库前必须把
//     cache_read + cache_creation 补进 inputTokens，才能与全系统基线「input_tokens 含 cache_read_tokens」
//     对齐（db.cjs 的净输入 = input − cache_read、命中率 = cache_read / input 都依赖该基线）。
//     与 autoclaw / mimo / dsh / reasonix 的补入口径一致；不补会让 BYOK 的 token 总量少算缓存部分、
//     命中率虚高（可 >100%）、净输入变负数。
//   - credits 是「额度点」不是 token：绝不参与 token 总量聚合（db.cjs 的 token 口径只算五桶，
//     额度点由 summary.credits 单独展示）。早期把它折进 totalTokens 会把 Qoder 的 0.36 点额度
//     显示成「0.36 token」，并把 Antigravity 的配额百分比点抬成假 token 数。
// 幂等键：assistant 行顶层 uuid 全局唯一；仅最终消息带 usage（thinking 中间消息无 usage），天然去重。
// 扫描范围：projects 下【递归】收集所有 .jsonl —— 新版客户端会把子代理转录写到
//   projects/<项目>/<会话>/subagents/agent-*.jsonl，只扫一层会整段漏记（2026-10-30 本机实测
//   Qoder 漏 249 条 / Qoder CN 漏 77 条，额度与调用次数同步偏小）。
// 不采集备用源：logs/sessions/**/segments/*.jsonl 的 model.response.completed 同样带 token
// 但无 credits，信息为转录子集，双采会重复入账。
// 设备标识：installation_id（UUID 文本文件）；读取失败返回 null 走 sync.cjs 统一回退链。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 时间戳兼容读取：毫秒 / 秒 / ISO 字符串；无法解析返回 null（同 codebuddy 约定） */
function toMs(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
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

/** credits 额度点：缺失/非法返回 null（官方模型有值，BYOK 为 null，不入 0 假数据） */
function creditsOf(usage) {
  if (usage.credits === null || usage.credits === undefined) return null;
  const n = Number(usage.credits);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 工厂：dirName 为主目录名（homeDir 下），envKey 为自测注入环境变量（覆盖默认目录）。
 * 返回标准适配器契约 { id, name, detect, validate, getDeviceId, extract }。
 */
function makeQoderAdapter(id, name, dirName, envKey) {
  function defaultDir() {
    return path.join(homeDir(), dirName);
  }

  function resolveDir() {
    const env = String(process.env[envKey] || "").trim();
    return env ? path.resolve(env) : defaultDir();
  }

  function detect() {
    const dir = resolveDir();
    return fs.existsSync(dir) ? dir : null;
  }

  /** 校验：projects 转录目录存在即通过（内部结构校验在 extract 内进行） */
  function validate(dir) {
    return !!dir && fs.existsSync(path.join(dir, "projects"));
  }

  function getDeviceId(dir) {
    try {
      const text = fs.readFileSync(path.join(dir, "installation_id"), "utf8").trim();
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * 模型归一：官方模型原样（qmodel_38max 等，过 normalizeModel 统一为连字符）；
   * BYOK 模型名 "qoder-custom-<uuid>/<真名>" 取 "/" 后真名，供应商按模型名推断，
   * 未命中时沿用 codebuddy 先例传 "custom"（显示「未知供应商:custom」）。
   */
  function mapModel(rawModel) {
    const raw = String(rawModel || "unknown");
    const isCustom = raw.startsWith("qoder-custom-");
    const realModel = isCustom && raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
    const modelId = normalizeModel(realModel);
    const providerId = isCustom ? providerName("custom", modelId) : "Qoder";
    return { modelId, providerId };
  }

  /**
   * 递归收集全部 .jsonl（含 subagents 子目录）。转录目录仍是项目目录的子路径，
   * 递归只扩大文件集合，不改变单文件解析与幂等键。
   */
  function collectJsonl(dir, out) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过，不阻断其余项目
    }
    for (const e of entries) {
      const filePath = path.join(dir, e.name);
      if (e.isDirectory()) collectJsonl(filePath, out);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(filePath);
    }
  }

  /**
   * 增量抽取：递归扫描 projects 下所有 <*.jsonl>，取 type=assistant 且带 message.usage 的行。
   * 转录为追加写（与 codex rollout 同性质）：mtime 早于回扫窗口起点的文件直接跳过。
   */
  function extract(dir, deviceId, deviceName, since) {
    if (!validate(dir)) throw new Error(`未找到 ${name} 转录数据目录：${path.join(dir, "projects")}`);
    const projectsDir = path.join(dir, "projects");
    const files = [];
    collectJsonl(projectsDir, files);
    const out = [];
    for (const filePath of files) {
      if (since > 0) {
        try {
          if (fs.statSync(filePath).mtimeMs <= since) continue;
        } catch {
          /* stat 失败按原逻辑全量解析 */
        }
      }
      let lines;
      try {
        lines = fs.readFileSync(filePath, "utf8").split("\n");
      } catch {
        continue; // 读取失败跳过该文件，不影响其余
      }
      const fallbackSession = path.basename(filePath).replace(/\.jsonl$/, "");
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // 损坏行跳过（与 codex 同策略），不阻断其余
        }
        if (!evt || evt.type !== "assistant") continue;
        const msg = evt.message;
        const usage = msg && typeof msg === "object" ? msg.usage : null;
        if (!usage || typeof usage !== "object") continue;
        const startedAt = toMs(evt.timestamp);
        if (startedAt === null || startedAt <= since) continue;
        // 幂等键：优先 uuid（全局唯一）；退而 request_id 时追加行号——重试行共享 request_id，
        // 不加行号会被 INSERT OR REPLACE 覆盖而少记（2026-09-10 审查修复 P3）；两者皆缺失无法去重，跳过
        const srcId = typeof evt.uuid === "string" && evt.uuid ? evt.uuid
          : typeof usage.request_id === "string" && usage.request_id ? `${usage.request_id}#${lineIdx}` : null;
        if (!srcId) continue;

        const { modelId, providerId } = mapModel(msg.model);
        // Anthropic 语义归一：input 只含新鲜输入，缓存读/写另列；补入后 inputTokens 才是全系统基线
        // 的「总输入（含 cache_read）」，命中率与净输入才不会算错（官方模型三桶恒 0，不受影响）
        const cacheRead = num(usage.cache_read_input_tokens);
        const cacheCreate = num(usage.cache_creation_input_tokens);
        out.push({
          id: `${deviceId}:${id}:${srcId}`,
          deviceId,
          deviceName,
          source: id,
          providerId,
          modelId,
          sessionId: typeof evt.sessionId === "string" && evt.sessionId ? evt.sessionId : fallbackSession,
          mode: typeof evt.entrypoint === "string" && evt.entrypoint ? evt.entrypoint : undefined,
          inputTokens: num(usage.input_tokens) + cacheRead + cacheCreate,
          outputTokens: num(usage.output_tokens),
          reasoningTokens: 0,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
          credits: creditsOf(usage),
          startedAt,
          status: msg.stop_reason === "end_turn" || !msg.stop_reason ? "success" : String(msg.stop_reason),
        });
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  return { id, name, detect, validate, getDeviceId, extract };
}

module.exports = { makeQoderAdapter };
