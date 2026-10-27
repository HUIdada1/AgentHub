/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关：运行时状态 / 密钥表 / 路由 / 模型 / 日志
// 设计口径：
//  · 状态是「可轮询的快照」，不订阅事件——网关的状态变化频率远低于号池，
//    页面 onMounted 拉一次 + 5s 轮询已足够，省一套事件订阅。
//  · 所有失败都降级为空值而非抛错：后端未接入时页面显示占位态即可，不能白屏。
//  · 后端「未接入」与「接了但报错」必须区分：前者保持 backendReady=false 走占位态，
//    后者写 lastError 让页面把原因显示出来（静默吞错会让用户看到假空态）。
//  · 号池账号联动（决策 5）：poolReady 由号池账号数决定，网关页据此决定「启动」按钮是否可点。
import { defineStore } from "pinia";
import * as api from "../api/ipc";
import { useAppStore } from "./app";

/** 网关运行快照（页面共用一个） */
export type LocalgwSnapshot = {
  running: boolean;
  port: number;
  bind: string;
  pid: number | null;
  uptimeSec: number;
  todayReq: number;
  todayTokens: number;
  errRate: number;
  activeChannels: number;
  validKeys: number;
};

const EMPTY_SNAPSHOT: LocalgwSnapshot = {
  running: false,
  port: 9527,
  bind: "127.0.0.1",
  pid: null,
  uptimeSec: 0,
  todayReq: 0,
  todayTokens: 0,
  errRate: 0,
  activeChannels: 0,
  validKeys: 0,
};

/** 把任意来源的 status 结果收敛成完整快照：后端漏字段 / 返回半截对象时页面不会出现 undefined */
function normalizeSnapshot(raw: unknown): LocalgwSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number) => (Number.isFinite(Number(v)) ? Number(v) : def);
  return {
    running: !!r.running,
    port: num(r.port, EMPTY_SNAPSHOT.port),
    bind: typeof r.bind === "string" && r.bind ? r.bind : EMPTY_SNAPSHOT.bind,
    pid: r.pid == null ? null : num(r.pid, 0),
    uptimeSec: num(r.uptimeSec, 0),
    todayReq: num(r.todayReq, 0),
    todayTokens: num(r.todayTokens, 0),
    errRate: num(r.errRate, 0),
    activeChannels: num(r.activeChannels, 0),
    validKeys: num(r.validKeys, 0),
  };
}

/** 把失败原因收敛成一句可展示的中文（页面横幅用） */
function errText(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : String(e || "");
  return m || fallback;
}

/** 「通道根本没注册」的失败特征：main.cjs 还没接线时 ipcRenderer.invoke 抛的就是这句。
 *  这类失败由「后端未就绪」占位态解释，不该再弹一条红字把用户吓一跳；
 *  真正的业务错误（库挂了、参数非法）才写 lastError 显示出来。 */
function isChannelMissing(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e || "")).toLowerCase();
  return m.includes("no handler registered") || m.includes("未授权的 ipc 命令") || m.includes("未注册");
}

/** 记录失败：通道未注册时静默（占位态已解释），其余情况写 lastError 让页面可见 */
function recordError(store: { lastError: string }, e: unknown, fallback: string) {
  if (!isChannelMissing(e)) store.lastError = errText(e, fallback);
}

// 竞态序号：轮询 / 筛选 / 手动刷新会并发，旧响应绝不能盖掉新状态（模块级即可，store 是单例）
let statusSeq = 0;
let logsSeq = 0;

export const useLocalgwStore = defineStore("localgw", {
  state: () => ({
    /** 网关运行快照；null = 还没拉到（后端未接入时的稳定态） */
    snapshot: null as LocalgwSnapshot | null,
    /** 后端通道是否可用：任一 localgw 通道调用成功即 true（首次成功即确定，之后不再回退） */
    backendReady: false,
    /** 密钥表 */
    keys: [] as api.LocalgwKeyRow[],
    /** 路由配置 */
    route: null as api.LocalgwRoute | null,
    /** 模型目录 */
    models: [] as api.LocalgwModelRow[],
    /** 请求日志（当前筛选结果） */
    logs: [] as api.LocalgwLogRow[],
    logsTotal: 0,
    /** 延时分位数 */
    pot: null as { avgMs: number; p50Ms: number; p95Ms: number; maxMs: number } | null,
    /** 号池是否已有可用账号（决策 5 的引导态判据；false 时「启动」按钮置灰） */
    poolReady: false,
    /** 号池账号总数 / 在线数（引导文案用） */
    poolAccountCount: 0,
    poolOnlineCount: 0,
    /** 各渠道概览行（路由页与总览页共用；来自号池 proxyPool，只读） */
    channels: [] as { id: string; display: string; accountCount: number; onlineCount: number; totalCredits: number }[],
    /** 全部已知渠道清单（含无账号渠道；来自号池 channelList，只读）——决策 1 的「扩展渠道」折叠区用 */
    allChannels: [] as { id: string; display: string; accountCount: number }[],
    /** 加载中标志（页面局部 busy 与整页 loading 分开，避免互相盖） */
    loading: false,
    /** 最近一次失败文案（为空表示无错）；页面顶部横幅展示，避免错误被静默吞掉 */
    lastError: "",
  }),
  getters: {
    /** 是否可启动：号池有在线账号 + 后端通道可用 */
    canStart(s): boolean {
      return s.backendReady && s.poolReady;
    },
  },
  actions: {
    /** 清掉错误横幅（用户点「知道了」或页面重新加载成功时调用） */
    clearError() {
      this.lastError = "";
    },

    /** 拉网关状态 + 号池联动信息（总览/侧栏卡片共用；任一失败只降级对应字段） */
    async refreshStatus() {
      const app = useAppStore();
      const seq = ++statusSeq;
      // 号池联动：账号数与在线数是「能否启动」的前置条件（决策 5）
      const [st, poolSt] = await Promise.all([
        api.localgwStatus().catch(() => null),
        api.proxyStatus().catch(() => null),
      ]);
      // 已有更新的请求在飞：本次结果作废，避免旧响应盖掉新状态
      if (seq !== statusSeq) return;
      if (st && typeof st === "object") {
        this.backendReady = true;
        this.snapshot = normalizeSnapshot(st);
      } else if (!this.snapshot) {
        // 后端未注册通道：保持 false，页面显示占位；但端口仍按配置预填，避免 UI 空白。
        // 注意只在「从没拿到过快照」时兜底——临时失败不能把已经显示的运行状态擦成未启动
        const cfg = app.config.localgw;
        this.snapshot = { ...EMPTY_SNAPSHOT, port: cfg?.port || 9527, bind: cfg?.bind || "127.0.0.1" };
      }
      if (poolSt && typeof poolSt === "object") {
        const p = poolSt as { accountCount?: unknown; onlineCount?: unknown };
        this.poolAccountCount = Number(p.accountCount) || 0;
        this.poolOnlineCount = Number(p.onlineCount) || 0;
        this.poolReady = this.poolOnlineCount > 0;
      }
    },

    /** 拉号池渠道列表（只读；路由页与总览页的渠道状态一览用） */
    async refreshChannels() {
      const rows = (await api.proxyPool().catch(() => null)) as
        | { id: string; display: string; summary?: { totalCredits?: number; accountCount?: number; onlineCount?: number } }[]
        | null;
      if (!Array.isArray(rows)) return;
      this.channels = rows
        .filter((r) => r && typeof r.id === "string")
        .map((r) => ({
          id: r.id,
          display: r.display || r.id,
          accountCount: r.summary?.accountCount ?? 0,
          onlineCount: r.summary?.onlineCount ?? 0,
          totalCredits: r.summary?.totalCredits ?? 0,
        }));
      // 全清单（含无账号渠道）：优先号池 channelList；退化为号池 proxyPool 并集
      const full = (await api.proxyChannelList().catch(() => null)) as
        | { id: string; display: string; summary?: { accountCount?: number } }[]
        | null;
      const accBy = new Map(this.channels.map((c) => [c.id, c.accountCount]));
      const merged = new Map<string, { id: string; display: string; accountCount: number }>();
      if (Array.isArray(full)) {
        for (const r of full) {
          if (!r || typeof r.id !== "string") continue;
          merged.set(r.id, {
            id: r.id,
            display: r.display || r.id,
            accountCount: (r.summary && r.summary.accountCount) || accBy.get(r.id) || 0,
          });
        }
      }
      for (const c of this.channels) {
        if (!merged.has(c.id)) merged.set(c.id, { id: c.id, display: c.display, accountCount: c.accountCount });
      }
      this.allChannels = [...merged.values()].sort((a, b) => a.display.localeCompare(b.display));
    },

    /** 拉密钥表 */
    async refreshKeys() {
      const rows = await api.localgwKeysList().catch((e: unknown) => {
        recordError(this, e, "密钥列表加载失败");
        return null;
      });
      if (Array.isArray(rows)) {
        this.keys = rows;
        this.backendReady = true;
      }
    },

    /** 拉路由配置 */
    async refreshRoute() {
      const r = await api.localgwRouteGet().catch((e: unknown) => {
        recordError(this, e, "路由配置加载失败");
        return null;
      });
      // 后端异常时 handle() 会回 { ok:false } 信封，被 ipc 层转成异常；这里只认真正的路由对象
      if (r && typeof r === "object" && !("ok" in r && (r as { ok?: unknown }).ok === false)) {
        this.route = r;
        this.backendReady = true;
      }
    },

    /** 拉模型目录 */
    async refreshModels() {
      const rows = await api.localgwModelsList().catch((e: unknown) => {
        recordError(this, e, "模型目录加载失败");
        return null;
      });
      if (Array.isArray(rows)) {
        this.models = rows;
        this.backendReady = true;
      }
    },

    /** 拉请求日志（分页 + 筛选由调用方传） */
    async refreshLogs(filter: { limit?: number; offset?: number; channel?: string; status?: string } = {}) {
      const seq = ++logsSeq;
      const r = await api.localgwLogsList({ limit: 50, ...filter }).catch((e: unknown) => {
        recordError(this, e, "请求日志加载失败");
        return null;
      });
      // 已有更新的请求在飞：丢弃本次结果（翻页/改筛选点得快时旧响应会乱序回来）
      if (seq !== logsSeq) return;
      if (r && typeof r === "object") {
        this.logs = Array.isArray(r.rows) ? r.rows : [];
        this.logsTotal = Number(r.total) || 0;
        this.backendReady = true;
      }
    },

    /** 拉延时分位数 */
    async refreshPot() {
      const p = await api.localgwPotStats().catch(() => null);
      if (!p || typeof p !== "object" || p.ok === false) return;
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      this.pot = { avgMs: num(p.avgMs), p50Ms: num(p.p50Ms), p95Ms: num(p.p95Ms), maxMs: num(p.maxMs) };
      this.backendReady = true;
    },

    /** 总览页一次性加载 */
    async loadAll() {
      this.loading = true;
      this.lastError = "";
      try {
        await Promise.all([
          this.refreshStatus(),
          this.refreshChannels(),
          this.refreshKeys(),
          this.refreshPot(),
        ]);
      } finally {
        this.loading = false;
      }
    },

    /** 启动 / 停止：包一层统一的错误落地，页面只关心布尔结果 */
    async toggle(enable: boolean) {
      this.lastError = "";
      // 通道可能直接抛错（主进程 handler 的 { ok:false } 信封会被 ipc 层转成异常），必须 catch
      const r = await (enable ? api.localgwStart() : api.localgwStop()).catch((e: unknown) => {
        recordError(this, e, enable ? "启动失败" : "停止失败");
        return null;
      });
      if (!r || !r.ok) {
        this.lastError = this.lastError || (enable ? "启动失败" : "停止失败");
      }
      await this.refreshStatus();
      return !!(r && r.ok);
    },

    /** 改端口（保存后自动重启监听，返回实际生效端口） */
    async changePort(port: number) {
      this.lastError = "";
      const r = await api.localgwSetPort(port).catch((e: unknown) => {
        recordError(this, e, "端口设置失败");
        return null;
      });
      if (!r || !r.ok) {
        this.lastError = this.lastError || "端口设置失败";
        return null;
      }
      await this.refreshStatus();
      return this.snapshot?.port ?? null;
    },

    /** 创建密钥：rawKey 只在返回值里出现一次，调用方负责立刻展示并提示"只显示一次" */
    async createKey(payload: {
      name: string;
      scopes: string[];
      expiresAt?: number | null;
      concurrency?: number;
      ratePerMin?: number;
    }) {
      this.lastError = "";
      const r = await api.localgwKeysCreate(payload).catch((e: unknown) => {
        recordError(this, e, "创建失败");
        return null;
      });
      if (!r || !r.ok) {
        this.lastError = this.lastError || "创建失败";
        return null;
      }
      await this.refreshKeys();
      return { rawKey: r.rawKey || "", apiKey: r.apiKey || null };
    },

    /** 吊销密钥 */
    async revokeKey(id: string) {
      const r = await api.localgwKeysRevoke(id).catch((e: unknown) => {
        recordError(this, e, "吊销失败");
        return null;
      });
      if (r && r.ok) {
        this.lastError = "";
        await this.refreshKeys();
      } else {
        this.lastError = this.lastError || "吊销失败";
      }
      return !!(r && r.ok);
    },

    /** 改名 */
    async renameKey(id: string, name: string) {
      const r = await api.localgwKeysRename(id, name).catch((e: unknown) => {
        recordError(this, e, "重命名失败");
        return null;
      });
      if (r && r.ok) {
        this.lastError = "";
        await this.refreshKeys();
      } else {
        this.lastError = this.lastError || "重命名失败";
      }
      return !!(r && r.ok);
    },

    /** 改路由（部分字段） */
    async patchRoute(patch: Partial<api.LocalgwRoute>) {
      const r = await api.localgwRouteSet(patch).catch((e: unknown) => {
        recordError(this, e, "路由配置保存失败");
        return null;
      });
      if (r && r.ok) {
        this.lastError = "";
        // 乐观回填：避免每次开关都要等一次完整 routeGet
        if (this.route) this.route = { ...this.route, ...patch } as api.LocalgwRoute;
        return true;
      }
      this.lastError = this.lastError || "路由配置保存失败";
      return false;
    },

    /** 渠道启闭（与号池 channelEnabled 同源语义：只影响本模块的路由可见集合） */
    async toggleChannel(channel: string, enabled: boolean) {
      const r = await api.localgwChannelToggle(channel, enabled).catch((e: unknown) => {
        recordError(this, e, "渠道切换失败");
        return null;
      });
      if (r && r.ok) {
        this.lastError = "";
        if (this.route) {
          this.route = {
            ...this.route,
            perChannel: { ...(this.route.perChannel || {}), [channel]: { enabled } },
          };
        }
      } else {
        this.lastError = this.lastError || "渠道切换失败";
      }
      return !!(r && r.ok);
    },
  },
});
