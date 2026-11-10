"use strict";
// A transport owned by plugin-host, not another plugin manager/installer.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RpcPeer } = require("./rpc.cjs");
const { ProviderSession } = require("./provider-session.cjs");
const { verifyDirectory } = require("./package.cjs");

function pluginEnvironment({ id, dataDir, electron = !!process.versions.electron }) {
  const env = {
    AGENTHUB_PLUGIN_ID: id,
    AGENTHUB_PLUGIN_DATA_DIR: dataDir,
    TEMP: path.join(dataDir, "tmp"), TMP: path.join(dataDir, "tmp"), TMPDIR: path.join(dataDir, "tmp"),
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    env.SystemRoot = systemRoot;
    env.PATH = path.join(systemRoot, "System32") + path.delimiter + systemRoot;
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  } else env.PATH = "/usr/bin:/bin";
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

class StdioTransport {
  constructor({ directory, dataDir, generation, verification, killTree, bindSession = () => () => {}, onExit = () => {}, executable = process.execPath }) {
    Object.assign(this, { directory, dataDir, generation, verification, killTree, bindSession, onExit, executable });
    this.closed = false;
    this.ready = false;
    this.stopping = false;
    this.stderrBytes = 0;
  }

  async start() {
    if (this.started) throw new Error("Plugin transport already started");
    this.started = true;
    const verified = await verifyDirectory(this.directory, this.verification);
    if (this.closed) throw new Error("Plugin start cancelled");
    this.manifest = verified.manifest;
    this.identity = Object.freeze({ ...verified.identity, generation: this.generation });
    await fs.promises.mkdir(path.join(this.dataDir, "tmp"), { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error("Plugin start cancelled");
    const native = this.manifest.runtime.kind === "native";
    const entry = path.join(verified.root, ...this.manifest.runtime.entry.split("/"));
    const child = spawn(native ? entry : this.executable, native ? [] : [entry], {
      cwd: verified.root,
      env: pluginEnvironment({ id: this.manifest.id, dataDir: this.dataDir, electron: !native && !!process.versions.electron }),
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    this.child = child;
    this.exited = new Promise(resolve => {
      let ended = false;
      const finish = code => {
        if (ended) return; ended = true;
        this.ready = false;
        this.closed = true;
        this.peer?.close(new Error("Plugin process exited"));
        this.revoke?.();
        resolve(code);
        try { this.onExit({ code, generation: this.generation, stopping: this.stopping }); } catch { /* Owner diagnostics must not escape child handlers. */ }
      };
      child.once("error", () => finish(null));
      child.once("exit", finish);
    });
    // Drain stderr with bounded accounting. Raw plugin diagnostics may contain
    // account secrets or prompts and are never copied to host logs/UI.
    child.stderr.on("data", chunk => { this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + chunk.length); });
    const peer = this.peer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:", maxFrameBytes: 16 * 1024 * 1024 });
    peer.once("closed", () => {
      this.ready = false;
      this.revoke?.();
      if (!this.stopping) this.killTree(child);
    });
    try {
      this.session = new ProviderSession({ peer, identity: this.identity, declarations: this.manifest.contributes.providers, onUnhealthy: () => { if (!this.stopping) this.killTree(child); } });
      this.revoke = this.bindSession(peer, this.session.identity) || (() => {});
      await this.session.initialize();
      if (this.closed || this.stopping) throw new Error("Plugin start cancelled");
      this.ready = true;
      return this.session;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop({ graceMs = 1000 } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.ready = false;
    this.closed = true;
    this.stopPromise = (async () => {
      this.revoke?.();
      if (this.peer && !this.peer.closed) {
        try { await this.peer.call("shutdown", {}, { timeoutMs: graceMs }); } catch { /* Bounded best effort before process-tree cleanup. */ }
        this.peer.close(new Error("Plugin stopped"));
      }
      if (this.child) {
        this.killTree(this.child);
        let timer;
        try { await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
        finally { clearTimeout(timer); }
      }
    })();
    return this.stopPromise;
  }
}

module.exports = { StdioTransport, pluginEnvironment };
