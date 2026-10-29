/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · MonkeyCode 建任务：OpenAI messages → 任务 prompt + 任务创建请求
//
// 上游是「任务」语义而不是「补全」语义：建一个带 VM 镜像、资源限额与 coding agent 类型的任务，
// 再由任务流把结果推回来。因此这里有三件别家没有的事：
//   1. system 消息**不进正文**，单独走 system_prompt 字段（只取第一条非空的，后面的静默忽略——
//      与上游客户端自己的取值口径一致，改成拼接反而会造出上游没见过的形态）；
//   2. tools / tool_choice 不透传：任务容器里的 agent 自带工具循环，建任务接口没有接收客户端
//      工具表的字段。客户端带工具表是常态，不为此报错。
//   3. resource.life 与任务流的总时长上限同一口径（1 小时）：到点上游本来就要回收 VM，
//      继续等只会把下游挂死。
"use strict";

const endpoints = require("./endpoints.cjs");
const regionStore = require("./region.cjs");

/** 资源限额：1 核 / 1 GiB / 1 小时（与任务流总超时同一口径，别只改一边） */
const RESOURCE = { core: 1, memory: 1073741824, life: 3600 };

/** 一条消息的可读文本：字符串直接用；数组只收 text / input_text 部件并**无分隔拼接**。
 *  多模态的其它部件（图片、文件）本渠道不接——上游只收文本提示词。 */
function contentText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = typeof part.text === "string" ? part.text : typeof part.input_text === "string" ? part.input_text : "";
      if (text) out.push(text);
    }
    return out.length ? out.join("") : null;
  }
  return null;
}

/**
 * messages → { prompt, systemPrompt }
 * 角色前缀：user → `[User]\n…`、assistant → `[Assistant]\n…`，其它角色（tool / function / 缺省）原样不标注。
 * 段间用空行连接。全空 → 400，因为上游不接受空 content。
 */
function buildPrompt(messages) {
  if (!Array.isArray(messages)) {
    throw Object.assign(new Error("请求缺少 messages 数组"), { status: 400 });
  }
  const parts = [];
  let systemPrompt = null;
  for (const message of messages) {
    const role = String((message && message.role) || "user");
    const text = contentText(message) ?? "";
    if (role === "system") {
      if (systemPrompt === null && text.trim()) systemPrompt = text.trim();
      continue;
    }
    if (!text.trim()) continue;
    if (role === "user") parts.push(`[User]\n${text}`);
    else if (role === "assistant") parts.push(`[Assistant]\n${text}`);
    else parts.push(text);
  }
  const prompt = parts.join("\n\n");
  if (!prompt.trim()) {
    throw Object.assign(
      new Error("messages 里没有可发送的文本内容：MonkeyCode 只接收文本提示词（图片 / 文件附件不在本渠道范围）"),
      { status: 400 },
    );
  }
  return { prompt, systemPrompt: systemPrompt === null ? "" : systemPrompt };
}

/** 起始 user-input 的 data 段：JSON 串里 content 走标准 base64（上游按「存储格式 → 新格式 → 纯文本」三级解析） */
function userInputData(prompt) {
  return JSON.stringify({
    content: Buffer.from(String(prompt || ""), "utf8").toString("base64"),
    attachments: [],
  });
}

function buildBody({ region, section, deps, prompt, target, imageId }) {
  const body = {
    content: prompt.prompt,
    host_id: endpoints.hostId(region, section),
    image_id: imageId,
    model_id: target.modelId,
    cli_name: target.cliName,
    resource: { core: RESOURCE.core, memory: RESOURCE.memory, life: RESOURCE.life },
    repo: { repo_url: "", branch: "master", repo_filename: "", zip_url: "" },
  };
  if (prompt.systemPrompt) body.system_prompt = prompt.systemPrompt;
  return body;
}

/** HTTP 状态 → 网关状态 + 人话。detail 优先用上游文案，没有就截原文响应体前 200 字（排障用）。 */
function statusError(status, detail) {
  const suffix = detail ? `：${detail}` : "";
  if (status === 401 || status === 403) {
    return { status: 401, message: `MonkeyCode 登录态已失效或无权访问（HTTP ${status}）：请在号池页重新粘贴 session${suffix}` };
  }
  if (status === 402) {
    return { status: 402, message: `MonkeyCode 账户额度不足（HTTP 402），请确认订阅 / 余额后再试${suffix}` };
  }
  if (status === 404) {
    return { status: 404, message: `MonkeyCode 模型或镜像不存在（HTTP 404），请确认模型清单与账号的镜像 id 仍然有效${suffix}` };
  }
  if (status === 409) {
    return { status: 409, message: `MonkeyCode 建任务冲突（HTTP 409，可能已有运行中的任务）${suffix}` };
  }
  if (status === 429) {
    return { status: 429, message: `MonkeyCode 请求过于频繁（HTTP 429），请稍后重试${suffix}` };
  }
  // 5xx 归一成 502：上游故障是可重试的，要和 4xx 的参数/权限问题分开
  if (status >= 500) {
    return { status: 502, message: `MonkeyCode 建任务返回 HTTP ${status}（上游故障，可稍后重试）${suffix}` };
  }
  return { status, message: `MonkeyCode 建任务返回 HTTP ${status}${suffix}` };
}

/** HTTP 200 但业务码非 0：上游用 code 表达失败，只看状态码会把失败当成功（账号因此永不冷却） */
function businessError(code, detail) {
  const suffix = detail ? `：${detail}` : "";
  if (code === 40100) {
    return { status: 401, message: `MonkeyCode 登录态已失效（code 40100）：请在号池页重新粘贴 session${suffix}`, code };
  }
  if (code === 40002 || code === 40003 || code === 40004) {
    return { status: 403, message: `MonkeyCode 账号不可用（code ${code}：密码错误 / 被封禁 / 未激活）${suffix}`, code };
  }
  // 同账号已有运行中的任务：这是并发，不是账号故障，所以调用方拿到 409 应当换号而不是冷却
  if (code === 10811) {
    return { status: 409, message: `MonkeyCode 该账号已有正在运行的任务（code 10811），请等它结束或先停止它${suffix}`, code };
  }
  if (code === 50000) {
    return { status: 502, message: `MonkeyCode 上游服务端错误（code 50000，可稍后重试）${suffix}`, code };
  }
  return { status: 502, message: `MonkeyCode 建任务失败（业务码 ${code}）${suffix}`, code };
}

function upstreamDetail(payload, text) {
  const message = String((payload && (payload.message || payload.msg)) || "").trim();
  if (message) return message;
  return String(text || "").trim().slice(0, 200);
}

/** 建任务响应里的任务 id：data.id / data.task_id / data.ID 三种写法都出现过 */
function taskIdOf(payload) {
  const data = payload && typeof payload === "object" && payload.data ? payload.data : payload;
  if (!data || typeof data !== "object") return "";
  for (const key of ["id", "task_id", "ID"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 建一个任务，返回 taskId。
 * 失败一律抛带 status/code 的错误：此刻还没给客户端下发任何字节，编排层可以据此换号或落真实状态码。
 */
async function createTask({ region, section, deps, session, prompt, target, imageId }) {
  const base = regionStore.baseUrl(region, section);
  const url = `${base}${endpoints.TASKS_PATH}`;
  const headers = {
    ...endpoints.jsonHeaders(region, section),
    Cookie: endpoints.cookieHeader(session),
    "Content-Type": "application/json",
  };
  const body = buildBody({ region, section, deps, prompt, target, imageId });
  const r = await deps.httpJson(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r || !r.ok) {
    const status = Number(r && r.status) || 502;
    const mapped = statusError(status, upstreamDetail(r && r.data, r && r.text));
    throw Object.assign(new Error(mapped.message), { status: mapped.status, code: mapped.code || null });
  }
  const payload = r.data;
  const code = payload && typeof payload === "object" && payload.code !== undefined ? Number(payload.code) : 0;
  if (code !== 0) {
    const mapped = businessError(code, upstreamDetail(payload, r && r.text));
    throw Object.assign(new Error(mapped.message), { status: mapped.status, code: mapped.code });
  }
  const taskId = taskIdOf(payload);
  if (!taskId) {
    throw Object.assign(new Error("MonkeyCode 建任务响应里没有任务 id（上游响应形态变化？）"), { status: 502 });
  }
  deps.verbose &&
    deps.verbose(
      `建任务成功 model=${target.model} cli=${target.cliName} task=${taskId} promptLen=${String(prompt.prompt || "").length} systemPrompt=${prompt.systemPrompt ? "有" : "无"}`,
    );
  return taskId;
}

module.exports = { buildPrompt, createTask, userInputData, statusError, businessError, taskIdOf, RESOURCE };
