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
// 反代网关 · 出线侧：OpenAI Chat Completions 协议
//
// 本文件只做一件事：把调度核心交出来的一串事件（delta / usage / finish / error）写成客户端听得懂的字节。
// 不做任何路由、换号、冷却决策——那些留在 server.cjs 的 handleChat 里。
//
// ⚠️ 这里每一个输出字节都是从 server.cjs 的 handleChat 原样搬来的，语义零改动，
//    由 scripts/dev-sink-golden.cjs 的场景表逐字守着（响应字节 / 冷却决策 / 选号顺序 / 流水记账）。
//    动本文件请连带跑那道闸；新增判据也应先用变异测试证明新场景真的能变红，
//    否则加进去只是一条会永远通过的摆设。
"use strict";
const util = require("../../proxy/util.cjs");

// 思考链合批（仅流式）：上游 reasoning_content 常按 1~2 字符切片推流（实测 hy3-preview
// 140 个增量/轮），原样透传会把客户端思考面板碎成几百段刷屏。攒够字符或够时间才下发
const REASON_BATCH_CHARS = 24;
const REASON_BATCH_MS = 120;

/**
 * @param ctx {{
 *   res: import("node:http").ServerResponse,
 *   reqId: string,            // 本轮请求 id（chunk 的 id 字段）
 *   requestedModel: string,   // 客户端请求里的模型名；响应始终回显它，路由改判不外泄
 *   wantStream: boolean,
 * }}
 */
function create(ctx) {
  const { res, reqId, requestedModel, wantStream } = ctx;
  // 断连只停写、不中止上游：上游继续消费到 EOF 才能把 usage 记全。
  // 判据是 res 的 close 而不是 req 的——Node 18+ 下请求体读完后 req close 就可能先触发
  let clientGone = false;
  res.on("close", () => { clientGone = true; });
  const write = (text) => {
    if (clientGone || res.writableEnded) return;
    res.write(text);
  };

  let agg = new util.Aggregator(reqId, requestedModel);
  let reasoningBuf = "";
  let reasoningLastFlush = 0;

  /** 冲刷思考链缓冲（思考结束 / 出错 / 收尾时必调，防尾段滞留） */
  const flushReasoning = () => {
    if (wantStream && reasoningBuf) {
      write(util.chunk(reqId, requestedModel, { reasoning_content: reasoningBuf }));
      reasoningBuf = "";
    }
  };

  /** 提交流头 + 首帧 role。抽成局部函数而不是只挂在返回对象上：comment() 也要保证
   *  「写任何字节之前头已经落地」，而对象方法之间互相拿不到（裸 res.write 在未发头时
   *  会隐式提交 200 且无 content-type，按内容类型判流的客户端直接失败） */
  const commitHead = () => {
    if (!wantStream || res.headersSent) return;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    write(util.chunk(reqId, requestedModel, { role: "assistant" }));
  };

  return {
    protocol: "openai",

    /** 开流：写 SSE 响应头 + 首帧 role。非流式没有这一步（等到 endOk 一次性 res.json） */
    writeHead: commitHead,

    /**
     * 一个上游 delta。返回「客户端真正可消费的实质内容有没有出现过」——
     * 调度核心用它同时置位 ttftMs 与 sentDelta，两者都不能算进噪声帧。
     */
    onDelta(d) {
      const delta = d || {};
      const rc = delta.reasoning_content;
      // 噪声字段（function_call:null / refusal:"" / tool_calls:[] / extra_fields:null / 重复 role）
      // 必须在此剔除：它们会让下面"rest 非空即正文"误判，既提前冲刷思考缓冲
      // （合批攒不满 → 思考链碎成一词一条），又把无正文的空帧发给客户端造成逐段换行
      const rest = util.stripEmptyDelta(delta);
      delete rest.reasoning_content;
      // "已出线"只认正文/思考/工具调用这三类客户端与聚合器真能消费的字段，不用 rest 非空做判据：
      // rest 可能带上游私有的非空扩展字段（如 extra_fields:{}），它既进不了 Aggregator，
      // 也不该封死 streamErr 的换号路径、把一次空响应记成 200
      const substantive = util.hasConsumableDelta(delta);
      if (!wantStream) {
        agg.pushDelta(delta);
        return substantive;
      }
      if (rc) {
        reasoningBuf += rc;
        const now = Date.now();
        if (reasoningBuf.length >= REASON_BATCH_CHARS || now - reasoningLastFlush >= REASON_BATCH_MS) {
          flushReasoning();
          reasoningLastFlush = now;
        }
      }
      if (Object.keys(rest).length) {
        flushReasoning(); // 正文/工具调用下发前先冲思考，保持先后顺序
        write(util.chunk(reqId, requestedModel, rest));
      }
      return substantive;
    },

    onUsage(usage) {
      if (!wantStream) agg.usage = usage;
    },

    onFinish(reason) {
      if (!wantStream) agg.finishReason = reason;
      flushReasoning(); // 思考结束：尾段全部下发
    },

    /** 流中出现 error：已出线才下发（且仍补 [DONE] 兜底）；一条内容都没出时交给调度换号 */
    onStreamError(err, { sent }) {
      if (!(wantStream && sent)) return false;
      flushReasoning();
      write(`data: ${JSON.stringify(util.openaiError(err.message, "upstream_error", err.code || null))}\n\n`);
      return true;
    },

    /** 静默期保活字节（防中间层回收，联调坑） */
    keepAlive() {
      if (wantStream) write(": keep-alive\n\n");
    },

    /** 流内 SSE 注释帧（模型回退明示，issue #90）：按 SSE 规范客户端忽略它，抓包/代理可见。
     *  写之前一律走 commitHead，头已落地时是空转 */
    comment(text) {
      if (!wantStream) return;
      commitHead();
      write(`: ${text}\n\n`);
    },

    /** 成功收尾。usage 由调度侧算好（含估算兜底），这里只管成形 */
    endOk(finishReason, usage) {
      if (wantStream) {
        flushReasoning(); // 兜底：上游没发 finish 时尾段思考不滞留
        write(util.chunk(reqId, requestedModel, {}, finishReason, usage));
        write(util.DONE);
        res.end();
        return;
      }
      agg.finishReason = finishReason;
      agg.usage = usage;
      res.json(agg.result());
    },

    /**
     * 失败收尾。头没落地时回标准 JSON 错误；已落地就只能把错误塞进流里（客户端得拿到终止帧）。
     * status / type / code 由调度侧按既有口径算好传进来，这里不做任何决策；
     * type 缺省时两条分支各用自己的默认值（流内帧 = upstream_error，JSON = server_error），
     * 这个不对称是搬家前就有的现状，原样保留。
     */
    endErr(status, message, type, code) {
      if (res.headersSent) {
        write(`data: ${JSON.stringify(util.openaiError(message, type || "upstream_error", code || null))}\n\n`);
        write(util.DONE);
        res.end();
        return;
      }
      res.status(status).json(util.openaiError(message, type || "server_error", code || null));
    },

    /** 聚合器只读句柄：调度侧估算 completion_tokens 要用 agg.content，别另存一份真相 */
    aggregated() {
      return agg;
    },

    /**
     * 每次真实上游请求前重置「单轮尝试独占」的输出状态。
     * 漏掉它的表现：非流式换号重发时两个账号的正文拼进同一条 content；尾段思考链跨尝试残留。
     * 调用点与语义同搬家前的 resetAttemptState（已出线时不会走到重发，见那里的注释）。
     *
     * 刻意**不**重置 reasoningLastFlush：搬家前的 resetAttemptState 里就没有这一行，
     * 本 PR 的前提是零语义改动。它今天也观察不到——思考链一旦下发就置了 sentDelta/ttftMs，
     * 而那两条禁令（planLimit 的 wantStream && sentDelta 短路、catch 的 sentDelta || ttftMs）
     * 保证之后不会再走到重发。要不要连合批时机一起重置，留作单独的行为改动讨论。
     */
    resetAttempt() {
      agg = new util.Aggregator(reqId, requestedModel);
      reasoningBuf = "";
    },
  };
}

module.exports = { create, REASON_BATCH_CHARS, REASON_BATCH_MS };
