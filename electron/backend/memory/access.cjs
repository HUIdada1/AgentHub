/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · Agent 接入编排：一键注入（MCP 条目 + 指令受控块）、一键卸载、片段导出、自定义 Agent。
// 注入前做路径可达性预检并把最终命令行回给前端确认（§5.3.5 / 可行性复核 §2.4）。
"use strict";

const os = require("os");
const path = require("path");
const agents = require("./agents.cjs");
const inject = require("./inject.cjs");
const verify = require("./verify.cjs");

// 自定义 Agent 的配置/指令路径必须在用户主目录内：
// 渲染层可调 saveCustom + inject，不拦则主进程可被诱导往任意路径写 MCP 条目与指令块
function inHome(p) {
  const resolved = path.resolve(String(p || ""));
  const home = path.resolve(os.homedir());
  return resolved === home || resolved.startsWith(home + path.sep);
}

class AgentAccess {
  constructor(opts) {
    this.appPath = opts.appPath;
    this.resourcesPath = opts.resourcesPath;
  }

  connection() {
    return verify.connectionCommand({ appPath: this.appPath, resourcesPath: this.resourcesPath });
  }

  list(cfgAgents, beats) {
    const cmd = this.connection();
    return agents.list(cfgAgents).map((a) => {
      const config = verify.verifyConfig(a);
      const beat = (beats || []).find((b) => b.agent === a.id) || null;
      return {
        id: a.id,
        name: a.name,
        custom: !!a.custom,
        optional: !!a.optional,
        enabled: a.enabled,
        note: a.note || "",
        configPath: a.configPath,
        configExists: a.configExists,
        format: a.format,
        snippetHint: a.snippetHint || "",
        instructionPath: a.instruction ? a.instruction.path : "",
        instructionExists: a.instruction ? a.instruction.exists : false,
        injected: config.ok,
        verifyConfig: config,
        beat: beat ? { lastCall: beat.last_call, calls: beat.calls, writes: beat.writes, searches: beat.searches, errors: beat.errors, lastTool: beat.last_tool } : null,
        pathReady: cmd.hostExists && cmd.bridgeExists,
      };
    });
  }

  injectOne(id, cfgAgents) {
    const adapter = agents.list(cfgAgents).find((a) => a.id === id);
    if (!adapter) return { ok: false, message: `未知 Agent：${id}` };
    const cmd = verify.connectionCommand({ appPath: this.appPath, resourcesPath: this.resourcesPath, agentId: adapter.id });
    if (!cmd.hostExists || !cmd.bridgeExists) {
      return {
        ok: false,
        message: "启动路径不可达：请先确认 AgentHub 安装目录与 resources/mcp/mcp-memory-server.cjs 存在",
        command: cmd,
      };
    }
    const steps = [];
    if (adapter.format === "toml-mcp_servers") {
      steps.push(inject.injectTomlConfig(adapter, cmd.command, cmd.args, cmd.env));
    } else {
      steps.push(inject.injectJsonConfig(adapter, cmd.command, cmd.args, cmd.env));
    }
    const failed = steps.find((s) => !s.ok);
    if (failed) return { ok: false, message: failed.message || "MCP 配置写入失败", steps };
    // agents.injectAgentsMd=false：只写 MCP 条目，不改 AGENTS.md/CLAUDE.md
    if (cfgAgents && cfgAgents.injectAgentsMd === false) {
      steps.push({ ok: true, action: "skipped-block", file: adapter.instruction ? adapter.instruction.path : "", reason: "已关闭指令注入（agents.injectAgentsMd）" });
    } else if (adapter.instruction && adapter.instruction.path) {
      steps.push(inject.injectBlock(adapter.instruction.path, inject.INSTRUCTION_BLOCK, {
        createHeader: "# 全局规则\n\n",
      }));
    }
    return { ok: true, command: cmd, steps, configPath: adapter.configPath, instructionPath: adapter.instruction ? adapter.instruction.path : "" };
  }

  uninjectOne(id, cfgAgents) {
    const adapter = agents.list(cfgAgents).find((a) => a.id === id);
    if (!adapter) return { ok: false, message: `未知 Agent：${id}` };
    const steps = [];
    if (adapter.format === "toml-mcp_servers") steps.push(inject.uninjectTomlConfig(adapter));
    else steps.push(inject.uninjectJsonConfig(adapter));
    if (adapter.instruction && adapter.instruction.path) steps.push(inject.removeBlock(adapter.instruction.path));
    const failed = steps.find((s) => s.ok === false);
    if (failed) return { ok: false, message: failed.message || "卸载失败", steps };
    return { ok: true, steps };
  }

  async verifyOne(id, cfgAgents, beats, opts = {}) {
    const adapter = agents.list(cfgAgents).find((a) => a.id === id);
    if (!adapter) return { ok: false, message: `未知 Agent：${id}` };
    return verify.verifyAgent(adapter, {
      appPath: this.appPath,
      resourcesPath: this.resourcesPath,
      beats,
      skipHandshake: opts.skipHandshake,
    });
  }

  async verifyAll(cfgAgents, beats) {
    return verify.verifyAll({
      cfg: cfgAgents,
      beats,
      appPath: this.appPath,
      resourcesPath: this.resourcesPath,
    });
  }

  snippet(id, cfgAgents, format) {
    const adapter = agents.list(cfgAgents).find((a) => a.id === id);
    if (!adapter) return { ok: false, message: `未知 Agent：${id}` };
    const cmd = verify.connectionCommand({ appPath: this.appPath, resourcesPath: this.resourcesPath, agentId: adapter.id });
    // 桥脚本缺失时给出的是「无参启动主程序」的坏片段——用户贴回去会每开会话弹一个主窗口，必须拦截
    if (!cmd.hostExists || !cmd.bridgeExists) {
      return { ok: false, message: "启动路径不可达：请先确认 AgentHub 安装目录与 resources/mcp/mcp-memory-server.cjs 存在", command: cmd };
    }
    return {
      ok: true,
      json: verify.renderSnippet(adapter, cmd, "json"),
      toml: verify.renderSnippet(adapter, cmd, "toml"),
      cli: verify.renderSnippet(adapter, cmd, "cli"),
      instruction: inject.INSTRUCTION_BLOCK,
      command: cmd,
      configPath: adapter.configPath,
      instructionPath: adapter.instruction ? adapter.instruction.path : "",
      hint: adapter.snippetHint || "",
      format: format || adapter.format,
    };
  }

  saveCustom(list, entry, cfgAgents) {
    if (!entry || !entry.name || !entry.path) return { ok: false, message: "自定义 Agent 需要名称与配置文件路径" };
    if (!inHome(entry.path)) return { ok: false, message: "配置文件路径必须位于用户主目录内" };
    if (entry.instructionPath && !inHome(entry.instructionPath)) return { ok: false, message: "指令文件路径必须位于用户主目录内" };
    const id = entry.id || `custom-${Date.now().toString(36)}`;
    const next = (Array.isArray(list) ? list : []).filter((x) => x.id !== id).concat([{
      id, name: entry.name, path: entry.path,
      format: entry.format || "json-mcpServers",
      instructionPath: entry.instructionPath || "",
    }]);
    void cfgAgents;
    return { ok: true, id, list: next };
  }

  toolsTable() {
    const tools = require("./tools.cjs");
    return tools.listSchema().map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: !!t.annotations.readOnlyHint,
      destructive: !!t.annotations.destructiveHint,
      idempotent: !!t.annotations.idempotentHint,
      openWorld: !!t.annotations.openWorldHint,
    }));
  }

}

module.exports = { AgentAccess };
