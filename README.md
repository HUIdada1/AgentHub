# AgentHub —— Agent中控台

技能仓库 / 用量同步 / **反代网关** 三合一的 Windows 桌面应用（Electron + Vue 3 + TypeScript）。

## 反代网关

把本机已登录的 **Trae SOLO CN / WorkBuddy（中国区）/ WorkBuddy AI（国际版）** 的订阅额度，包装成标准 **OpenAI Chat Completions API**（默认 `http://127.0.0.1:9527/v1`），供任何 OpenAI 兼容客户端调用。

### 能力一览

- **OpenAI 兼容端点**：`POST /v1/chat/completions`（SSE 流式 + 非流式本地聚合）、`GET /v1/models`、`GET /healthz`，错误语义与 OpenAI 对齐（401/429/400/502/503）
- **API Key 体系**：`sk-` 随机 Key，库中只存 SHA-256 哈希；日配额、单 Key 令牌桶限速、启停即时生效
- **三渠道独立号池**：多账号、五态状态机（online/cooling/exhausted/relogin/disabled）、池内调度（到期优先/余额优先/轮询）
- **自动切换**
  - 余额不足自动切换：402/1005 运行期换号（单请求最多 2 次）+ 已知零余额账号调度期直接跳过
  - 余额到期自动切换：快到期账号优先消耗（到期前榨干），过期自动切走，刷新后复活
  - 模型回退：模型未知或号池耗尽时按「回退模型」自动切换（模型目录页配置）
- **模型目录**：三渠道合并视图、启停、per-model 渠道覆盖、WB 官方目录一键同步
- **凭据接入**：本地扫描（WB auth 文件含历史快照）/ Trae OAuth 回环登录 / 手动粘贴；token 经 DPAPI 加密落盘
- **本地 IDE 快捷切换**：一键把号池账号写为 WorkBuddy 当前登录态（写前备份）；Trae 因登录态加密信封暂不支持写回
- **防监测**：请求指纹逐字段对齐官方客户端（UA/设备头/链路追踪头/同源 referer）、WB 指纹清洗（cc_*/x-anthropic-* 剥离 + 审核模板最小改写，外置热更新）、拟人抖动（40~220ms 随机延迟）、换号痕迹不外泄
- **规则热加载**：`rules/*.json`（模型映射/清洗模板/渠道头）改文件即时生效，无需重启
- **统计**：请求流水 90 天，总览/趋势/TOP（渠道/模型/Key/账号）/明细分页

### 快速开始

1. 安装并登录 Trae / WorkBuddy（至少一个），启动 AgentHub
2. 「反代网关 · 号池」添加账号（本地扫描 / OAuth 登录 / 手动粘贴）
3. 「API Keys」生成 Key（完整 Key 只显示一次）
4. 客户端填入 `base_url=http://127.0.0.1:9527/v1` + `Bearer sk-…`
5. 总览「实时请求流」出现第一行记录 = 链路打通

```bash
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -d '{"model":"deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

### 开发与自测

```bash
npm install
npm run dev        # 桌面端（Electron + Vite HMR）
npm run dev:web    # 纯浏览器预览 UI（mock 数据）

# 反代网关后端全链路自测（含假上游端到端：换号/自动切换/流式双态/指纹头）
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs
```

后端实现位于 `electron/backend/proxy/`（存储/适配器/号池/网关服务/规则热加载/IDE 切换），协议细节参考 TraeWorkAssistant 的公开逆向事实，代码独立实现。

## 免责声明

本项目为**开源学习研究项目**，仅供个人在已合法订阅相应服务的前提下，于本地环境调用自有账号额度。使用者不得用于任何违反目标服务条款、侵犯第三方权益或商业转售的用途；因使用本项目产生的一切后果（包括但不限于账号限制、封禁）由使用者自行承担，作者概不负责。本项目与 Trae、WorkBuddy、腾讯等公司无任何关联，相关商标归其各自所有者。

## License

MIT
