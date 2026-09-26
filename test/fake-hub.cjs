#!/usr/bin/env node
// 测试用「假中枢」：在 unix socket 上提供最小 MCP 语义，替代真实 dc-hub。
// 用法: node fake-hub.cjs <sock路径> [应答延迟ms]

const net = require("net");
const fs = require("fs");

const sock = process.argv[2];
const delay = Number(process.argv[3] || 0);
if (!sock) { console.error("用法: node fake-hub.cjs <sock> [delayMs]"); process.exit(1); }

try { fs.unlinkSync(sock); } catch (_) {}

function handle(msg) {
  if (msg.method === "initialize" && msg.id !== undefined) {
    return {
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "desktop-commander", version: "fake-hub" },
      },
    };
  }
  if (msg.method === "tools/list" && msg.id !== undefined) {
    return {
      jsonrpc: "2.0", id: msg.id,
      result: { tools: [{ name: "read_file" }, { name: "write_file" }, { name: "execute_command" }] },
    };
  }
  if (msg.method === "tools/call" && msg.id !== undefined) {
    const name = (msg.params && msg.params.name) || "?";
    const args = JSON.stringify((msg.params && msg.params.arguments) || {});
    return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `FAKEHUB:${name}:${args}` }] } };
  }
  if (msg.id !== undefined) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
  return null; // 通知类不回
}

const server = net.createServer((conn) => {
  let buf = "";
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const reply = handle(msg);
      if (!reply) continue;
      const write = () => { if (!conn.destroyed) conn.write(JSON.stringify(reply) + "\n"); };
      if (delay > 0) setTimeout(write, delay); else write();
    }
  });
  conn.on("error", () => {});
});

server.listen(sock, () => console.log("FAKEHUB_READY"));

const stop = () => { try { fs.unlinkSync(sock); } catch (_) {} process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
