#!/usr/bin/env node
// 测试用「假引擎」：以 stdio 提供 desktop-commander 风格的最小 MCP 语义。
// 用途：
//   1. 验证 dc-hub.cjs 的握手复用、id 路由与 ChatGPT 兼容剥离（_meta / resources）；
//   2. 验证长任务链路 start_process -> read_process_output；
//   3. 伪装成 $BRIDGE_NPM_PREFIX/bin/desktop-commander，让 start.sh 能起整条真实链路。
// 用法: node fake-engine.cjs
//
// 语义对齐 desktop-commander：
//   - start_process({command}) 返回 PID，输出累积在引擎内；
//   - read_process_output({pid}) 返回「自上次读取后的新增输出」+ 是否仍在运行；
//   - 引擎自身退出时，它启动的子进程随之退出（同真实引擎的父子关系）。

const readline = require("readline");
const { spawn } = require("child_process");

const TOOLS = [
  { name: "read_file", description: "读取文件", inputSchema: { type: "object" }, _meta: { "openai/widget": { x: 1 } } },
  { name: "write_file", description: "写入文件", inputSchema: { type: "object" }, _meta: { "openai/widget": { x: 1 } } },
  { name: "execute_command", description: "执行命令", inputSchema: { type: "object" } },
  { name: "start_process", description: "启动长任务", inputSchema: { type: "object" } },
  { name: "read_process_output", description: "读取长任务输出", inputSchema: { type: "object" } },
  { name: "list_processes", description: "列出长任务", inputSchema: { type: "object" } },
];

const procs = new Map(); // pid -> { child, buf, cursor, running, exitCode }
let nextPid = 4001;

function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function text(t) { return { content: [{ type: "text", text: t }] }; }

function doStartProcess(a) {
  const pid = nextPid++;
  const child = spawn("sh", ["-c", String(a.command || "true")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const p = { child, buf: "", cursor: 0, running: true, exitCode: null };
  const append = (chunk) => { p.buf += chunk.toString(); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code) => { p.running = false; p.exitCode = code == null ? -1 : code; });
  procs.set(pid, p);
  return { pid, running: true };
}

function doReadOutput(a) {
  const pid = Number(a.pid);
  const p = procs.get(pid);
  if (!p) return { pid, found: false, output: "", isRunning: false };
  const fresh = p.buf.slice(p.cursor);
  p.cursor = p.buf.length;
  return { pid, found: true, output: fresh, isRunning: p.running, exitCode: p.exitCode };
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: { listChanged: true } },
        serverInfo: { name: "desktop-commander", version: "fake-engine" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = (msg.params && msg.params.name) || "?";
    const a = (msg.params && msg.params.arguments) || {};
    let body;
    if (name === "read_file") body = text(`READ(${a.path || "?"})\nline-1\nline-2`);
    else if (name === "write_file") body = text(`WROTE(${a.path || "?"})`);
    else if (name === "execute_command") body = text(`EXEC(${a.command || "?"})`);
    else if (name === "start_process") body = text(JSON.stringify(doStartProcess(a)));
    else if (name === "read_process_output") body = text(JSON.stringify(doReadOutput(a)));
    else if (name === "list_processes") {
      body = text(JSON.stringify([...procs.entries()].map(([pid, p]) => ({ pid, running: p.running }))));
    } else body = text(`UNKNOWN(${name})`);
    send({ jsonrpc: "2.0", id: msg.id, result: body });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});

// 引擎退出（stdin 关闭 / 被 kill）时，一起收掉自己拉起的子进程，避免测试残留
function cleanup() {
  for (const p of procs.values()) { try { p.child.kill("SIGKILL"); } catch (_) {} }
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
