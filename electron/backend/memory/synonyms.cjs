/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 内置同义词表（无向量库的第一级语义补强，§6.8）。
// 首次启动写入 <仓库>/index/synonyms.json，之后用户可自由编辑，模块只在该文件缺失时补种。
"use strict";

const fs = require("fs");
const path = require("path");

const BUILTIN_SYNONYMS = {
  "登录": ["鉴权", "认证", "登陆", "login", "auth", "signin"],
  "报错": ["异常", "错误", "error", "exception", "失败", "出错"],
  "修改": ["改", "更新", "update", "refactor", "重构", "调整"],
  "性能": ["速度", "耗时", "延迟", "performance", "latency", "卡顿"],
  "记忆": ["memory", "回忆", "记录", "备忘"],
  "检索": ["搜索", "查询", "search", "query", "查找"],
  "索引": ["index", "indexing", "fts5"],
  "同步": ["sync", "webdav", "上传", "下载"],
  "冲突": ["conflict", "合并冲突", "三方合并"],
  "配置": ["config", "设置", "setting", "preference"],
  "部署": ["deploy", "发布", "release", "上线"],
  "删除": ["remove", "delete", "移除", "清理"],
  "备份": ["backup", "快照", "snapshot"],
  "接口": ["api", "endpoint", "端点", "接口地址"],
  "令牌": ["token", "凭证", "密钥", "apikey", "api-key"],
  "代理": ["proxy", "反代", "网关", "gateway"],
  "模型": ["model", "llm", "大模型"],
  "提示词": ["prompt", "提示", "指令"],
  "工具": ["tool", "plugin", "插件", "mcp"],
  "会话": ["session", "对话", "conversation", "chat"],
  "项目": ["project", "仓库", "repo", "repository"],
  "文档": ["doc", "document", "说明", "readme"],
  "测试": ["test", "自测", "冒烟", "smoke", "验收"],
  "修复": ["fix", "补丁", "hotfix", "修 bug", "bugfix"],
  "新增": ["add", "feat", "feature", "新功能"],
  "优化": ["optimize", "improve", "改进", "提速"],
  "回滚": ["rollback", "还原", "恢复", "revert"],
  "归档": ["archive", "存档", "归类"],
  "标签": ["tag", "label", "标记"],
  "画像": ["profile", "人格", "偏好", "persona"],
  "蒸馏": ["distill", "提炼", "总结", "summarize"],
  "去重": ["dedup", "重复", "duplicate"],
  "导入": ["import", "迁移", "migrate"],
  "导出": ["export", "备份导出"],
  "监听": ["watch", "监控", "observe"],
  "队列": ["queue", "待办", "pending"],
  "缓存": ["cache", "缓冲"],
  "数据库": ["database", "db", "sqlite"],
  "前端": ["frontend", "界面", "ui", "页面"],
  "后端": ["backend", "服务端", "server", "主进程"],
  "渲染层": ["renderer", "界面层"],
  "启动": ["launch", "boot", "start", "初始化"],
  "退出": ["quit", "exit", "关闭", "shutdown"],
  "升级": ["upgrade", "更新版本", "update"],
  "降级": ["degrade", "fallback", "兜底"],
  "限流": ["rate limit", "429", "throttle"],
  "额度": ["credit", "quota", "余额", "套餐"],
  "加密": ["encrypt", "cipher", "密文"],
  "解密": ["decrypt", "明文"],
  "脱敏": ["redact", "敏感信息", "打码"],
  "隐私": ["privacy", "私密", "secret"],
  "审计": ["audit", "日志审计"],
  "心跳": ["heartbeat", "beat", "保活"],
  "巡检": ["scan", "巡查", "自检"],
  "报告": ["report", "日报", "周报"],
  "热力图": ["heatmap", "日历图"],
  "时间线": ["timeline", "演化链", "历史"],
  "回收站": ["trash", "废纸篓", "已删除"],
  "占位": ["placeholder", "stub"],
};

function ensureSynonyms(rootDir) {
  const file = path.join(rootDir, "index", "synonyms.json");
  try {
    fs.accessSync(file);
    return { file, seeded: false };
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // tmp + rename：写一半崩了留下半个 JSON，同义词会静默失效（loadSynonyms catch 成 {}）
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(BUILTIN_SYNONYMS, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return { file, seeded: true };
  }
}

module.exports = { BUILTIN_SYNONYMS, ensureSynonyms };
