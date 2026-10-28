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
// 本地网关模块 README：维护入口
// 方案：docs/本地网关模块方案.md（v1.0 已按最推荐方式拍板）
// 执行清单：docs/localgw-implementation-checklist.md
//
// ===== 目录结构 =====
// localgw/
//   index.cjs           模块入口：register(ipcMain) / boot() / shutdown() / setRuntime()
//                       ★33 条 IPC 通道全部登记在本文件里——**没有单独的 ipc.cjs**
//                       （方案 §3.2 曾计划拆 ipc.cjs，实际实现时合并进 index.cjs 以少一层间接）
//   config.cjs          配置默认值 + 读取 + 深合并补丁（落 framework config.json 的 localgw 段）
//   server.cjs          HTTP 转发服务器（start() 才 listen；默认 autostart=false 不会开端口）
//   forwarder.cjs       ★转发核心：选号 + 调 proxy/adapters.cjs 的 chat() + 事件泵（真流式）
//   outbound.cjs        出站伪装与清洗（按渠道策略）：关键词清洗 / agent 文案替换 /
//                       请求头覆盖 / agent 软件模拟档案。契约 docs/localgw-outbound-contract.md
//   keys-store.cjs      API Key 持久化（号池 stats.db，新建 localgw_keys 表）
//   routing.cjs         渠道路由（策略 smart/fixed/round-robin/score / 故障转移 / 冷却）
//   models.cjs          模型目录（合并 channel + overrides + aliases + custom）
//   usagehook.cjs       请求落账钩子（广播 localgw 事件；真实落库由 sync 接线）
//   oplog.cjs           请求流水（localgw_logs 表，GC + 导出）
//   upstream/           【已废弃】base.cjs / index.cjs 只是占位与"别再用我"的提示，
//                       渠道适配已全部并入 proxy/adapters.cjs（见 forwarder.cjs 顶部注释）
//   providers/          第三方 provider 扩展点（本期只放静态元数据 + README，不打包 exe）
//
// ===== 接线步骤（electron/main.cjs 实际落地形态，共 4 步）=====
//   // 1) 惰性 require：顶层不 require，失败只记 crashLog 并降级为「仅本地网关不可用」
//   function localgwMod() { try { return require("./backend/localgw/index.cjs"); } catch (e) { __crashLog(...); return null; } }
//   // 2) 启动装配（whenReady 之后）
//   const lgw = localgwMod();
//   lgw.register(ipcMain);                              // 幂等，重复调用安全
//   lgw.setRuntime({ broadcast: broadcastLocalgw });     // 必须在 boot() 之前
//   if (on("localgw")) lgw.boot().catch(...);            // autostart=false 时不开端口
//   // 3) 模块开关：启用 → setRuntime + boot()；停用 → shutdown()
//   // 4) before-quit / will-quit → lgw.shutdown().catch(() => {})
//
// ===== 设计原则 =====
// 1) 单进程内嵌（方案 §3.1）：与号池 / 记忆 / 提示词同款主进程模块，不另起子进程
// 2) 账号体系只读复用号池（方案 §4.1）：不建第二套账号模型；凭据只从号池 vault 取，永不写本模块配置或日志
// 3) API Key 哈希落库（决策 3）：HMAC-SHA256(raw, localgw.security.secret)，列表只回前缀，明文只在创建响应里出现一次
// 4) 渠道默认启集 = 号池已配置账号的渠道（决策 1）：其余收进扩展区，提示去号池补账号
// 5) 对外协议兼容 OpenAI + Anthropic（决策 4）：不做 Gemini
// 6) 无号池账号时板块默认展示 + 引导态（决策 5）：模块不可禁用，进入后显示三步引导
// 7) 第三方 provider 扩展点（决策 2）：本期不引入 exe，只保留接口与目录约定
// 8) 出站伪装按渠道独立（契约 docs/localgw-outbound-contract.md，v1.4）：
//    · 三件事：body 清洗（关键词 + agent 文案替换 + 内置指纹）、请求头覆盖/移除、
//      agent 软件模拟档案（模拟官方客户端的**请求形态**，不是开发 agent 软件）
//    · **每个上游渠道一份策略**，另有全局默认供未配置渠道继承
//    · mode="passthrough" = 头与 body 全透传；**自定义供应商渠道默认透传**
//      （对端不是官方 agent 后端，没有可伪装的风控指纹）
//    · 头覆盖的落点：proxy/util.cjs 的 byteSafeHeaders()（号池所有出站头的必经点）
//      + proxy/catpaw/upstreamHttp.cjs（该渠道有独立 HTTP 层）；策略经 ALS 传递，
//      **无 ALS 上下文时零行为变化**
//
// ===== 新增渠道步骤 =====
// 渠道适配器**不在本模块**：全部由号池的 electron/backend/proxy/adapters.cjs 提供。
// 所以新增渠道只需在号池侧加适配器（并在 proxy 的渠道表里登记），localgw 会自动跟随：
//   1) 在 electron/backend/proxy/adapters.cjs 里实现该渠道的 adapter（含 models() / chat()）
//   2) 在号池渠道表（proxy/store.cjs 的 CHANNELS）登记 display / domain
//   3) 号池里添加该渠道账号 → routing.channelsWithAccounts() 自动把它纳入默认启集
//   4) 需要对外改名/固定渠道时，用「模型目录」页写 overrides / aliases / custom（落 localgw 配置）
//   5) 跑一遍 IPC 通道冒烟（见 docs/localgw-implementation-checklist.md §3.x）
// ⚠ 不要再往 upstream/ 里加文件：那条路已废弃（曾计划"每渠道一对文件"，最终改为复用号池适配器）。
//
// ===== 不要做的事 =====
// · 不要在业务代码里散落 AGENTHUB_* 环境变量（沿用 config.cjs 的链路）
// · 不要把 API Key 明文写进 localgw 配置或日志
// · 不要把渠道适配器做成"号池适配器的拷贝"——本模块只做"薄包装"
// · 不要在未跑通 pilot 前全量引入第三方 provider 包
