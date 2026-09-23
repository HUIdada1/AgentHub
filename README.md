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
- **凭据接入（四途径）**：
  - **OAuth 官方登录**：Trae SOLO CN 走 PKCE + 本地回环回调（登录域由官方 GetLoginGuidance 下发，浏览器没跳回时可整段粘贴回调地址兜底）；WorkBuddy 中国区 / 国际版走官方 state 轮询，无需回环端口
  - **从本机软件导入**：直接读本机已登录客户端（WB 双区 auth 文件、Trae storage.json 的 ByteCrypto 信封按官方算法离线解开），零请求入池
  - **从 JSON/ZIP 文件**批量导入、**粘贴 JSON** 手动入池
  - token 经 DPAPI 加密落盘，凭据不出主进程
- **本地 IDE 快捷切换**：一键把号池账号写为 WorkBuddy 双区当前登录态；写前备份 + 三道安全闸（官方 `$wbEncrypted` 加密文件拒绝覆盖 / 写时哈希比对防并发回写 / 写后回读校验并自动回滚）；Trae 因登录态是加密信封，诚实降级为提示
- **防监测**：请求指纹逐字段对齐官方客户端（UA/设备头/链路追踪头/同源 referer）、WB 指纹清洗（cc_*/x-anthropic-* 剥离 + 审核模板最小改写，外置热更新）、拟人抖动（40~220ms 随机延迟）、换号痕迹不外泄
- **规则热加载**：`rules/*.json`（模型映射/清洗模板/渠道头）改文件即时生效，无需重启
- **统计**：请求流水 90 天，总览/趋势/TOP（渠道/模型/Key/账号）/明细分页

### 快速开始

1. 安装并登录 Trae / WorkBuddy（至少一个），启动 AgentHub
2. 「反代网关 · 号池」添加账号（OAuth 官方登录 / 从本机软件导入 / 文件导入 / 手动粘贴）
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

## 作者

**沐辉**（GitHub: [@HUIdada1](https://github.com/HUIdada1)）

## License

本项目基于 [MIT License](./LICENSE) 开源发布。

Copyright (c) 2026 沐辉 (HUIdada1)

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
