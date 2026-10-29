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
// 反代网关 · MonkeyCode（长亭科技）渠道适配器：建任务 + WebSocket 任务流
//
// 形态与别家最不一样的一点：一次对话不是「一次 HTTP 请求一次回答」，而是
// 建任务 → 挂任务流 → 消费 ACP 事件 → 收尾。整条链装在一次 chat() 里完成（本仓库的转发入口
// 统一是 chat()，stateful/chatSession 那个扩展点在现网关里没有分流方，声明了反而没人走）。
//
// 本家没有的东西，如实声明，别照抄别家：
//   · 没有续期：session 30 天硬上限，上游无 refresh 接口，过期只能重新粘贴；
//   · 没有登录窗口：密码登录要验证码、OAuth 要滑块 + 短信，都不适合网关代跑；
//   · 没有余额接口：queryCredits 如实回「查不到」，绝不为凑字段去打一个不存在的接口；
//   · 没有签到；
//   · 没有内置兜底模型清单：目录没拉到就如实报错，不编模型名。
"use strict";

const rules = require("../rules.cjs");
const regionStore = require("./region.cjs");
const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");
const models = require("./models.cjs");
const probe = require("./probe.cjs");
const task = require("./task.cjs");
const stream = require("./stream.cjs");
const log = require("./log.cjs");

/** 发现的镜像 id 落到账号 meta。updateAccount 的 meta 是「整份替换」语义（调用方负责读-改-写），
 *  所以这里必须先把库里那份读回来合并——否则会把设备绑定、备注等既有元数据一起清掉。 */
function rememberImageId(store, accountId, imageId) {
  if (!store || !accountId || typeof store.updateAccount !== "function") return;
  try {
    const row = store.getAccount(accountId);
    if (!row) return;
    let meta = {};
    try {
      meta = row.meta ? JSON.parse(row.meta) : {};
    } catch {
      meta = {};
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
    if (meta.imageId === imageId) return;
    store.updateAccount(accountId, { meta: { ...meta, imageId } });
  } catch {
    /* 落库失败不阻断本次转发：下一次请求会再发现一次 */
  }
}

function makeMonkeyCode(channel, deps) {
  const { httpJson } = deps;
  const region = regionStore.byChannel(channel);
  const cfg = () => (rules.get("headers.json") || {})[channel] || {};

  // 子模块只需要三样：JSON 出站（走 adapters 的共用通道，因此自动继承出网代理与超时档）、
  // 排障日志、以及任务流的空闲预算（从规则文件读，缺省由 stream.cjs 兜底）
  const bundle = {
    httpJson,
    verbose: (text) => log.verbose(`[${region ? region.label : channel}] ${text}`),
    get streamIdleMs() {
      return Number(cfg().streamIdleMs) || 0;
    },
  };

  /** 凭据 + 建任务材料：session 落 token 字段，镜像 id 与用户 id 落账号 meta */
  function snapshotOf(secrets, account) {
    const snap = credentials.snapshot({ ...(secrets || {}), accountId: account && account.id });
    if (!snap.session) {
      throw Object.assign(
        new Error(
          `MonkeyCode ${region.label}账号缺少有效 session：请重新粘贴 ${endpoints.SESSION_COOKIE_NAME} 的值` +
            "（只贴这一个 cookie 的值，不要贴整段 Cookie 表或其它文件内容）",
        ),
        { status: 401 },
      );
    }
    return snap;
  }

  return {
    id: channel,
    cfg,

    models() {
      return models.ids(channel);
    },

    modelEntries() {
      return models.list(channel);
    },

    async fetchModels(account, secrets, opts) {
      if (!region) return { ok: false, message: "未知的 MonkeyCode 站点" };
      const snap = credentials.snapshot(secrets);
      return models.refresh(region, cfg(), bundle, snap.session, !!(opts && opts.force));
    },

    async chat(ctx) {
      if (!region) throw Object.assign(new Error("未知的 MonkeyCode 站点"), { status: 501 });
      const section = cfg();
      const body = (ctx && ctx.body) || {};
      // emit 在任务流里是从定时器与 WebSocket 事件回调里被调的：那里抛出的异常不会经过转发层，
      // 只会变成一条无人接的 rejection。给一个空实现兜底，宁可丢一帧也不让整条链静默死掉。
      const emit = typeof (ctx && ctx.emit) === "function" ? ctx.emit : () => {};
      const snap = snapshotOf(ctx && ctx.secrets, ctx && ctx.account);

      // 镜像 id 是建任务的必填参数，但它不在登录态里：上游只在账号跑过任务之后的任务列表里回吐它。
      // 先按需发现一次并落到账号元数据（下次直接用），发现不到才如实拒——绝不拿空值去建任务碰运气。
      if (!snap.imageId) {
        const discovered = await probe.discoverImageId(bundle, region, section, snap.session);
        if (discovered) {
          snap.imageId = discovered;
          rememberImageId(deps.store, ctx.account && ctx.account.id, discovered);
        } else {
          throw Object.assign(
            new Error(
              `MonkeyCode ${region.label}账号还没有可用的镜像 id：该账号在 MonkeyCode 上还没有跑过任务，` +
                "任务容器的镜像 id 无从发现。请先在官网发起一次任务，再回到号池重试。",
            ),
            { status: 400, switchable: false },
          );
        }
      }

      // ctx.model 才是"要转发给上游的那一个"（网关已按目录 / 别名 / 反向映射解过），body.model 是客户端请求名。
      // 上游建任务要的是目录里的模型 UUID，所以必须拿解析后的名字去查目录：用客户端的虚拟统一名查会
      // 判"找不到模型"，用户看到的是"明明选了却报不存在"。
      const requestedModel = String((ctx && ctx.model) || (body && body.model) || "").trim();
      if (!requestedModel) throw Object.assign(new Error("请求缺少 model"), { status: 400 });
      // 目录没拉过就先自动刷一次：模型页的定时刷新不一定跑过，"要点两下才能用"是体验缺陷；
      // 刷完仍空才如实报 503，并把动作指向模型管理页
      if (!models.list(channel).length) {
        await models.refresh(region, section, bundle, snap.session, true);
      }
      if (!models.list(channel).length) {
        throw Object.assign(
          new Error(`MonkeyCode ${region.label}模型目录为空：上游没有内置兜底清单，请在模型管理页点「刷新模型清单」后重试`),
          { status: 503, switchable: false },
        );
      }
      const target = models.resolveTarget(channel, requestedModel);
      if (!target) {
        throw Object.assign(
          new Error(`MonkeyCode 模型目录里找不到模型「${requestedModel}」：请在模型管理页刷新清单后重试`),
          { status: 503, switchable: false },
        );
      }

      const prompt = task.buildPrompt(body.messages);
      const taskId = await task.createTask({
        region,
        section,
        deps: bundle,
        session: snap.session,
        prompt,
        target,
        imageId: snap.imageId,
      });

      await stream.runTaskStream({
        region,
        section,
        deps: bundle,
        session: snap.session,
        taskId,
        prompt: prompt.prompt,
        requestedModel,
        includeUsage: !!(body.stream_options && body.stream_options.include_usage === true),
        emit,
        signal: (ctx && ctx.meta && ctx.meta.signal) || null,
      });
      return { status: 200, planLimit: false };
    },

    /** 本家错误已在建任务/任务流现场翻译过状态码，这里只补「换不换号」这一层判断 */
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      if (status === 401 || status === 403) return { kind: "relogin", switchable: true, status: 401 };
      // 额度不足：换号也没用，用户得去官网处理
      if (status === 402) return { kind: "credit", switchable: true, status: 402 };
      // 「该账号已有运行中的任务」是并发不是故障：短冷却并换下一个账号，别把账号判成坏了
      if (status === 409) return { kind: "rate", switchable: true, status: 429 };
      if (status === 429) return { kind: "rate", switchable: true, status: 429 };
      return null;
    },

    /** 没有余额接口：如实回 unavailable，账号保持可用、余额字段不动（回 0 会被判额度耗尽并自动切号） */
    async queryCredits() {
      return { unavailable: true, message: "MonkeyCode 上游没有可用的余额接口，额度以官网为准" };
    },

    async checkin() {
      return { ok: true, unavailable: true, message: "MonkeyCode 没有签到活动" };
    },

    async checkinStatus() {
      return { ok: true, checkedIn: false, unavailable: true, message: "MonkeyCode 没有签到活动" };
    },

    async refreshToken() {
      return {
        ok: false,
        noRefresh: true,
        message: `MonkeyCode 登录态没有刷新机制（会话 30 天、上游无续期接口）：请在浏览器重新取一次 ${endpoints.SESSION_COOKIE_NAME} 后在本页重新粘贴`,
      };
    },
  };
}

module.exports = { makeMonkeyCode };
