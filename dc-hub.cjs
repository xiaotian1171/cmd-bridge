#!/usr/bin/env node
// dc-hub.cjs —— desktop-commander 单例复用中枢
//
// 背景：supergateway 的 --stateful 会为每个 MCP session 各起一份引擎
// （chatgpt-compat + desktop-commander，约 130MB）。客户端不复用 session 时，
// 密集调用会在小内存容器上迅速 OOM，而 --sessionTimeout 只能限制回收窗口，
// 无法降低窗口内的引擎数。
//
// 本文件常驻一份 desktop-commander，在 unix socket 上做 JSON-RPC 复用：
// 所有 MCP session 的请求都转发给同一个引擎，响应按 id 路由回各自连接。
// initialize 握手由中枢本地应答（引擎只握手一次），对客户端完全透明；
// 同时承接原 chatgpt-compat 的 _meta / resources 剥离，保持 ChatGPT 兼容。
//
// 单例保护：启动时若发现已有中枢在监听同一 socket，直接退出，避免多份中枢
// 互相抢 socket（多个 dc-hub-client 同时发现中枢故障时可能并发拉起）。
//
// 用法（由 start.sh 启动，勿单独运行）：
//   node dc-hub.cjs -- <server命令...>

const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const sep = process.argv.indexOf("--");
if (sep === -1 || sep + 1 >= process.argv.length) {
  console.error("用法: node dc-hub.cjs -- <server命令...>");
  process.exit(1);
}
const cmd = process.argv.slice(sep + 1);
const SOCK = process.env.DC_HUB_SOCK || ((process.env.HOME || "/root") + "/.bridge/dc-hub.sock");

fs.mkdirSync(path.dirname(SOCK), { recursive: true });

// 探测是否已有中枢在同一 socket 上监听。
// 只探测、不写入，探测用的连接马上销毁。
function hubAlive(cb) {
  const probe = net.connect(SOCK);
  let settled = false;
  const finish = (alive) => {
    if (settled) return;
    settled = true;
    try { probe.removeAllListeners(); probe.destroy(); } catch (_) {}
    cb(alive);
  };
  probe.on("connect", () => finish(true));
  probe.on("error", () => finish(false));
  setTimeout(() => finish(false), 1000);
}

hubAlive((alive) => {
  if (alive) {
    console.error("[dc-hub] 已有中枢在监听，退出本实例");
    process.exit(0);
  }
  try { fs.unlinkSync(SOCK); } catch (_) { /* 无残留 */ }
  start();
});

function start() {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write("[dc-hub] " + d));

  let seq = 1;
  const pending = new Map(); // localId -> { conn|null, origId, boot }
  const conns = new Set();
  let initResult = null;

  function stripCompat(msg) {
    if (msg && msg.result) {
      if (Array.isArray(msg.result.tools)) {
        for (const tool of msg.result.tools) delete tool._meta;
      }
      if (msg.result.capabilities) delete msg.result.capabilities.resources;
    }
    return msg;
  }

  // 引擎退出时，把在途请求一一回错误，避免对应 session 永久挂起
  child.on("exit", (code, sig) => {
    console.error(`[dc-hub] engine exited code=${code} sig=${sig}`);
    for (const rec of pending.values()) {
      if (rec.conn && !rec.conn.destroyed && rec.origId !== null && rec.origId !== undefined) {
        try {
          rec.conn.write(JSON.stringify({
            jsonrpc: "2.0", id: rec.origId,
            error: { code: -32603, message: "engine exited" },
          }) + "\n");
        } catch (_) {}
      }
    }
    pending.clear();
    try { fs.unlinkSync(SOCK); } catch (_) {}
    process.exit(1);
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    stripCompat(msg);

    if (msg.id !== undefined && pending.has(msg.id)) {
      const rec = pending.get(msg.id);
      pending.delete(msg.id);
      if (rec.boot) {
        initResult = msg.result || null;
        // 引擎会话建立：补发 initialized 通知，随后开始接受客户端
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        startListening();
        return;
      }
      if (rec.conn && !rec.conn.destroyed) {
        rec.conn.write(JSON.stringify(Object.assign({}, msg, { id: rec.origId })) + "\n");
      }
      return;
    }
    // 引擎主动发起的消息：广播给全部会话
    for (const c of conns) if (!c.destroyed) c.write(line + "\n");
  });

  // 与引擎握手，全生命周期只做一次
  const BOOT = seq++;
  pending.set(BOOT, { conn: null, origId: null, boot: true });
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: BOOT, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dc-hub", version: "1.0" } }
  }) + "\n");

  function forward(conn, msg) {
    const lid = seq++;
    pending.set(lid, { conn, origId: msg.id, boot: false });
    child.stdin.write(JSON.stringify(Object.assign({}, msg, { id: lid })) + "\n");
  }

  let listening = false;
  function startListening() {
    if (listening) return;
    listening = true;
    const server = net.createServer((conn) => {
      conns.add(conn);
      const crl = readline.createInterface({ input: conn });
      crl.on("line", (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }

        // initialize：本地应答，引擎不重复握手
        if (msg.method === "initialize" && msg.id !== undefined) {
          const result = Object.assign({}, initResult || {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "desktop-commander" }
          });
          if (msg.params && msg.params.protocolVersion) result.protocolVersion = msg.params.protocolVersion;
          conn.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
          return;
        }
        // 其余通知：引擎已初始化，无需转发
        if (msg.id === undefined) return;
        forward(conn, msg);
      });
      const drop = () => {
        conns.delete(conn);
        try { crl.close(); } catch (_) {}
      };
      crl.on("error", drop);
      conn.on("close", drop);
      conn.on("error", drop);
    });
    server.on("error", (e) => { console.error("[dc-hub] server error: " + e.message); process.exit(1); });
    server.listen(SOCK, () => console.error(`[dc-hub] listening on ${SOCK}`));
  }

  function shutdown() {
    try { fs.unlinkSync(SOCK); } catch (_) {}
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
