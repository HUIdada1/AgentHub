/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · MCP 工具定义（10 个）：本地 HTTP API 与 MCP 桥共用同一份实现，
// 行为标注（readOnly/destructive/idempotent）随 tools/list 下发给 Agent（§5.2）。
"use strict";

const MAX_BODY_CHARS = 6000;

const DEFINITIONS = [
  {
    name: "memory_core",
    description: "取核心记忆：用户画像 + 当前项目汇总（三级披露第一级，≤800 token）。会话开局调用一次即可。",
    inputSchema: { type: "object", properties: { project: { type: "string" } } },
    annotations: { title: "核心记忆", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args) => svc.coreMemory(args.project ? { project: args.project } : {}),
  },
  {
    name: "memory_digest",
    description: "取全局索引概览（≤200 行）：项目列表 + 各项目最近摘要 + 关键标签。不检索就知道有哪些记忆。",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "索引概览", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args) => svc.digestText(args && args.maxLines),
  },
  {
    name: "memory_search",
    description: "检索记忆，返回紧凑索引行（摘要，非全文）。默认排除已失效记忆。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        agent: { type: "string" },
        layer: { type: "string", enum: ["l1", "l2"] },
        type: { type: "string", description: "按类别精确过滤（daily/decision/knowledge/…）" },
        tag: { type: "string", description: "按单个标签过滤（包含匹配）" },
        starred: { type: "boolean", description: "只看星标记忆" },
        pinned: { type: "boolean", description: "只看置顶记忆" },
        limit: { type: "number" },
        includeSuperseded: { type: "boolean" },
      },
      required: ["query"],
    },
    annotations: { title: "检索记忆", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args, agent) => svc.searchForAgent(args, agent),
  },
  {
    name: "memory_get",
    description: "按 id 取记忆全文（受 token 上限截断），附带相关记忆 3 条。",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, id: { type: "string" } } },
    annotations: { title: "取全文", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args) => svc.getMany(args.ids || (args.id ? [args.id] : []), MAX_BODY_CHARS),
  },
  {
    name: "memory_timeline",
    description: "取某条记忆／某主题的事实演化链（A → B → C，含各自有效时间）。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, topic: { type: "string" } } },
    annotations: { title: "演化链", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args) => svc.timelineFor(args),
  },
  {
    name: "memory_write",
    description: "写入一条记忆。归类引擎自动判定项目；supersedes 用于声明本条推翻旧的哪些记忆。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        title: { type: "string" },
        type: { type: "string" },
        project: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number" },
        supersedes: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        session: { type: "string" },
      },
      required: ["content"],
    },
    annotations: { title: "写入记忆", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args, agent) => svc.writeFromAgent(args, agent),
  },
  {
    name: "memory_update",
    description: "更新已有记忆的标题／正文／标签／重要度。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number" },
      },
      required: ["id"],
    },
    annotations: { title: "更新记忆", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args) => svc.updateMemory(args.id, args),
  },
  {
    name: "memory_recent",
    description: "取最近 N 天的记忆索引行。",
    inputSchema: { type: "object", properties: { project: { type: "string" }, agent: { type: "string" }, days: { type: "number" } } },
    annotations: { title: "最近记忆", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc, args) => svc.recent(args),
  },
  {
    name: "memory_projects",
    description: "列出项目（slug／名称／条数／最近更新）。",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "项目列表", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc) => svc.projects(),
  },
  {
    name: "memory_forget",
    description: "删除一条记忆（进回收站，可恢复）。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { title: "删除记忆", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (svc, args) => svc.deleteMemory(args.id),
  },
  {
    name: "memory_status",
    description: "索引／存储／同步状态自检。",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "状态自检", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (svc) => svc.statusForAgent(),
  },
];

function byName(name) {
  return DEFINITIONS.find((d) => d.name === name) || null;
}

function listSchema() {
  return DEFINITIONS.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
    annotations: d.annotations,
  }));
}

module.exports = { DEFINITIONS, byName, listSchema };
