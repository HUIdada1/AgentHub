"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-transport-"));
const store = require("../electron/backend/proxy/store.cjs");
const proxy = require("../electron/backend/proxy/netproxy.cjs");
const transport = require("../electron/backend/proxy/transport-context.cjs");
const { fetchStream } = require("../electron/backend/network/http.cjs");
const sockets = new Set();
const credentials = [];
const counts = [0, 0];
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const upstream = http.createServer((req, res) => {
  if (req.url === "/hang") return;
  if (req.url === "/body") { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); return; }
  res.end("ok");
});
upstream.on("upgrade", (req, socket) => {
  const accept = require("node:crypto").createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(Buffer.from([0x81, 2, 111, 107]));
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
});
function tunnel(index) {
  const server = http.createServer((req, res) => {
    credentials.push(req.headers["proxy-authorization"]);
    counts[index]++;
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const forward = http.request(req.url, { method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    forward.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(forward);
  });
  server.on("connect", (req, socket, head) => {
    credentials.push(req.headers["proxy-authorization"]);
    counts[index]++;
    const target = new URL(`http://${req.url}`);
    const peer = net.connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
    });
    sockets.add(socket); sockets.add(peer);
    socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); peer.destroy(); });
    peer.on("close", () => { sockets.delete(peer); socket.destroy(); });
  });
  server.on("upgrade", (req, socket, head) => {
    counts[index]++;
    const target = new URL(req.url);
    const peer = net.connect(Number(target.port), target.hostname, () => {
      const headers = { ...req.headers }; delete headers["proxy-authorization"];
      peer.write(`${req.method} ${target.pathname} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
    });
    sockets.add(socket); sockets.add(peer);
    socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
  });
  return server;
}
const proxies = [tunnel(0), tunnel(1)];
async function request(url) { return (await proxy.fetchThrough(url, { signal: AbortSignal.timeout(3000) })).text(); }

async function main() {
  store.open();
  const port = await listen(upstream);
  const ports = await Promise.all(proxies.map(listen));
  const a = proxy.save({ name: "one", protocol: "http", host: "127.0.0.1", port: ports[0], username: "one", password: "first" }).item;
  const b = proxy.save({ name: "two", protocol: "http", host: "127.0.0.1", port: ports[1] }).item;
  const url = `http://127.0.0.1:${port}/`;
  proxy.saveSettings({ mode: "fixed", fixedId: a.id });
  assert.equal(await request(url), "ok");
  proxy.save({ ...a, password: "second" });
  assert.equal(await request(url), "ok");
  assert.ok(credentials.includes(`Basic ${Buffer.from("one:first").toString("base64")}`));
  assert.ok(credentials.includes(`Basic ${Buffer.from("one:second").toString("base64")}`));
  console.log("PASS 修改代理密码后使用新凭据与新连接池");
  proxy.closeAll();
  proxy.saveSettings({ mode: "rotate" });
  const before = counts.slice();
  await transport.run(new AbortController().signal, async () => { await request(url); await request(url); });
  assert.equal(counts.filter((n, i) => n > before[i]).length, 1);
  await transport.run(new AbortController().signal, async () => request(url));
  assert.equal(counts.filter((n, i) => n > before[i]).length, 2);
  console.log("PASS 同一上下文固定出口，不同上下文轮换");
  proxy.saveSettings({ mode: "fixed", fixedId: b.id });
  const previous = counts[1];
  await transport.run(new AbortController().signal, () => new Promise((resolve, reject) => {
    const socket = proxy.webSocketThrough(`ws://127.0.0.1:${port}/ws`, { headers: { "x-test": "fixture" } });
    const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 2000);
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket error")); });
    socket.addEventListener("message", (event) => { clearTimeout(timer); assert.equal(event.data, "ok"); socket.close(); resolve(); });
  }));
  assert.ok(counts[1] > previous);
  console.log("PASS WebSocket 握手和消息经过配置出口");
  assert.equal(proxy.proxyUri({ protocol: "http", host: "::1", port: 8080 }), "http://[::1]:8080");
  assert.notEqual(proxy.cacheKey({ id: "a", host: "h", port: 1, username: "one" }), proxy.cacheKey({ id: "b", host: "h", port: 1, username: "two" }));
  console.log("PASS IPv6 URI 与相同端点多身份缓存隔离");
  proxy.saveSettings({ mode: "rotate" });
  proxy.remove({ id: a.id }); proxy.remove({ id: b.id });
  await assert.rejects(request(url), /没有可用出口/);
  proxy.saveSettings({ mode: "off" });
  const controller = new AbortController();
  const pending = fetchStream(url + "hang", { signal: controller.signal, firstByteMs: 10000 });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (e) => !e.firstByteTimeout);
  console.log("PASS 显式取消不会被误报成首字节超时");
  const response = await fetch(url + "body");
  await assert.rejects(transport.readText(response, 100, 30), /读取超时/);
  const large = new Response("x".repeat(200));
  await assert.rejects(transport.readText(large, 100), /超过读取限制/);
  console.log("PASS 异常响应体有读取时限与大小限制");
  fs.writeFileSync(path.join(store.proxyDir(), "netproxy.json"), "invalid-json");
  await assert.rejects(request(url), /配置文件损坏/);
  console.log("PASS 损坏代理配置不会隐式回落直连");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  proxy.closeAll();
  for (const socket of sockets) socket.destroy();
  for (const server of [...proxies, upstream]) {
    server.closeAllConnections();
    if (server.listening) await new Promise((r) => server.close(r));
  }
  store.close();
});
