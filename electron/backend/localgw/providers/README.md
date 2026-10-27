# 本地网关 · Provider 扩展点（决策 2）

> 本期不打包任何第三方 exe。本目录只放**静态能力元数据** + 接入说明，作为未来扩展的接口约定。

## 现状

- `pack-docs.json`：21 个与号池重叠渠道的能力矩阵（refresh / usage / checkin / claims 支持级别），作为扩展点声明的静态快照
- 不拷 exe、不打包 exe、不进 git 仓库
- 本期 IPC 已预留 4 条通道，handler 固定返回 `{ ok: false, message: "provider 扩展点未启用（方案决策 2，本期不打包 exe）" }`：
  - `localgw_providers_list / enable / doctor / exec`

## 未来如何接入（写代码前先看这里）

1. 用户手动把第三方 provider 包放到 `<dataDir>/providers/<pack-id>/`
2. 在 `LocalgwSettingsView → 扩展点` 打开开关，并填扫描目录（默认 `<dataDir>/providers`）
3. 实现 `localgw_providers_doctor`：验证签名（pack.json 里的 ed25519 签名）+ hash + 版本兼容性
4. 实现 `localgw_providers_exec`：spawn 子进程，走 stdio JSON-RPC（与 AgentHub 插件宿主同款协议，参考 `electron/backend/plugin-host.cjs`）
5. **必须先 pilot 1~2 个渠道跑通再全量引入**（方案 §1.4）

## 为什么本期不引入

- exe 无源码、不能审计、出 Bug 无法修
- 号池已具备 28 个自研渠道适配器，覆盖同一批上游
- 全量引入等于把「渠道正确性」这个网关核心承诺押在第三方黑盒上

## 风险（沿用方案 §8.3）

- Windows 打包：exe 要作为 `extraResources` 并指定平台过滤，否则安装包会显著变大
- spawn 子进程需杀进程树（`taskkill /T`）
- 第三方插件的协议版本与主程序可能不兼容，doctor 校验必不可少
