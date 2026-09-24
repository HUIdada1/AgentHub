/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 本地 HTTP API：MCP 桥与前端之外的工具调用入口（127.0.0.1 + 一次性 token）。
// 存在的意义是「单写者」：多个 Agent 各拉一个 MCP 进程，但写操作全部回流到本进程串行执行。
// 只绑回环、必须带 token；runtime.json 记端口与 token（修正清单 B2：不入仓库目录）。
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = require("./tools.cjs");

class MemoryHttpApi {
  constructor(service, runtimeFile, options = {}) {
    this.service = service;
    this.runtimeFile = runtimeFile;
    this.onEvent = options.onEvent || (() => {});
    this.server = null;
    this.port = 0;
    this.token = crypto.randomBytes(24).toString("hex");
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.port = server.address().port;
        this.server = server;
        this._writeRuntime();
        resolve({ port: this.port });
      });
    });
  }

  _writeRuntime() {
    const payload = { port: this.port, token: this.token, pid: process.pid, startedAt: Date.now() };
    try {
      fs.mkdirSync(path.dirname(this.runtimeFile), { recursive: true });
      const tmp = `${this.runtimeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      if (fs.existsSync(this.runtimeFile)) fs.rmSync(this.runtimeFile, { force: true });
      fs.renameSync(tmp, this.runtimeFile);
    } catch (e) {
      this.onEvent({ type: "error", detail: `本地 API 信息写入失败：${e.message}` });
    }
  }

  stop() {
    if (!this.server) return;
    try { this.server.close(); } catch { /* 已关闭 */ }
    this.server = null;
    try { fs.rmSync(this.runtimeFile, { force: true }); } catch { /* 运行时文件可能已被清理 */ }
  }

  restart() {
    this.stop();
    return this.start();
  }

  status() {
    return { running: !!this.server, port: this.port, tokenReady: !!this.token, pid: process.pid };
  }

  _handle(req, res) {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true, port: this.port });
    if (req.method !== "POST") return send(405, { ok: false, message: "只接受 POST" });

    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${this.token}`) return send(401, { ok: false, message: "鉴权失败" });

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      // 收集 Buffer 块最后 concat：逐块 toString 会在 >64KB 的 CJK 正文 chunk 边界劈出 U+FFFD
      chunks.push(chunk);
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        tooLarge = true;
        // 先回 413 再断流：直接 destroy 客户端连响应都看不到（原 413 是死代码）
        send(413, { ok: false, message: "请求体过大" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      let payload;
      try { payload = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, message: "JSON 解析失败" }); }
      const { tool, args, agent } = payload;
      this.dispatch(tool, args || {}, agent || "unknown")
        .then((result) => send(200, { ok: true, result }))
        .catch((e) => send(200, { ok: false, message: String(e && e.message || e) }));
    });
  }

  // 桥与前端共用的工具分发（MCP tools/call 与 HTTP /call 同一入口）
  async dispatch(tool, args, agent) {
    const def = TOOLS.byName(tool);
    if (!def) throw new Error(`未知工具：${tool}`);
    try {
      const result = await def.run(this.service, args, agent);
      this.service.index.beat(agent, tool, true);
      return result;
    } catch (e) {
      // 失败也要打心跳：agent_beat.errors 是"这个 Agent 调用出错几次"的唯一数据源
      try { this.service.index.beat(agent, tool, false); } catch { /* 记账失败不掩盖原错误 */ }
      throw e;
    }
  }
}

module.exports = { MemoryHttpApi };
