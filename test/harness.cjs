#!/usr/bin/env node
// 测试公共设施：真链路（supergateway 3.4.3 + sg-hook + dc-hub + chatgpt-compat + fake-engine）
// 的启停、进程身份查询、MCP HTTP 调用、断言与结果统计。
//
// 约束：所有测试只使用 /tmp 下的临时 BRIDGE_HOME 与高位端口，不触碰线上或用户目录。

const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");

const COPY = path.resolve(__dirname, "..");
const PREFIX = process.env.BRIDGE_TEST_PREFIX || "/tmp/bridge-etest";
const NODE = process.execPath;

// ---------- 断言与统计 ----------
const state = { pass: 0, fail: 0, lines: [] };
function ok(cond, label, detail) {
  if (cond) { state.pass++; console.log(`[PASS] ${label}`); }
  else { state.fail++; console.log(`[FAIL] ${label}${detail ? " <- " + detail : ""}`); }
  state.lines.push(`${cond ? "PASS" : "FAIL"} ${label}`);
}
function info(msg) { console.log(`       ${msg}`); }
function title(t) { console.log(`\n== ${t} ==`); }
function summary(name) {
  console.log(`\n${name} 结果: ${state.pass} 通过 / ${state.fail} 失败`);
  return state.fail === 0 ? 0 : 1;
}

// ---------- 环境 ----------
function makeHome(tag) { return `/tmp/bridge-test-${tag}`; }

function resetHome(h, token) {
  fs.rmSync(h, { recursive: true, force: true });
  fs.mkdirSync(path.join(h, "logs"), { recursive: true });
  fs.writeFileSync(path.join(h, "token"), token);
  fs.writeFileSync(path.join(h, "run_tls"), "0");
  fs.writeFileSync(path.join(h, "tunnel_mode"), "none");
  fs.writeFileSync(path.join(h, "run_mode"), "full");
}

function baseEnv(h, port, extra = {}) {
  return {
    ...process.env,
    BRIDGE_HOME: h,
    BRIDGE_NPM_PREFIX: PREFIX,
    BRIDGE_PORT: String(port),
    BRIDGE_TUNNEL: "none",
    BRIDGE_NO_TUNNEL: "1",
    BRIDGE_MODE: "full",
    BRIDGE_KILL_LEGACY: "0",
    ...extra,
  };
}

function run(script, args, env, opts = {}) {
  const r = spawn("bash", [script, ...args], { env, cwd: COPY });
  let out = "";
  r.stdout.on("data", (d) => (out += d));
  r.stderr.on("data", (d) => (out += d));
  return new Promise((res) => r.on("exit", (code) => res({ code, out })));
}

async function startBridge(h, port, extra = {}) {
  const { code, out } = await run(path.join(COPY, "start.sh"), [], baseEnv(h, port, extra));
  if (code !== 0) throw new Error(`start.sh 退出码 ${code}\n${out}`);
  return out;
}

async function stopBridge(h, port, extra = {}) {
  return run(path.join(COPY, "stop.sh"), [], baseEnv(h, port, extra));
}

// ---------- 进程身份查询（复用 proc-lib.sh，只查本 BRIDGE_HOME 的进程）----------
function ownedPids(h, pattern) {
  const script = `. "${COPY}/proc-lib.sh"; bridge_pids "$1"`;
  try {
    const out = execFileSync("bash", ["-c", script, "bash", pattern], {
      env: { ...process.env, BRIDGE_HOME: h },
      encoding: "utf8",
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// node 本体（排除 /bin/sh -c 包装壳）
// session 转发进程（排除网关本身：supergateway 的 --stdio 参数里也含 dc-hub-client.cjs）
function clientPids(h) {
  const pat = `${COPY.replace(/[][\\.^$*+?(){}|]/g, (m) => "\\" + m)}/dc-hub-client\\.cjs`;
  return ownedPids(h, pat).filter((pid) => {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmd.includes("supergateway")) return false;
      return true;
    } catch (_) { return false; }
  });
}
function clientNodePids(h) {
  return clientPids(h).filter((pid) => {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      return !cmd.includes("/bin/sh -c") && !/\bsh -c\b/.test(cmd);
    } catch (_) { return false; }
  });
}
function clientTotal(h) { return clientPids(h); }
function sgPids(h) {
  const npmRe = PREFIX.replace(/[][\\.^$*+?(){}|]/g, (m) => "\\" + m);
  return ownedPids(h, `${npmRe}/lib/node_modules/supergateway|${npmRe}/bin/supergateway`);
}
function hubPids(h) {
  const sd = COPY.replace(/[][\\.^$*+?(){}|]/g, (m) => "\\" + m);
  return ownedPids(h, `${sd}/dc-hub\\.cjs`);
}

// ---------- 等待 ----------
async function waitFor(fn, { timeout = 30000, interval = 300, label = "条件" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > timeout) { info(`等待超时: ${label}`); return false; }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function healthz(port, timeoutMs = 2000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    clearTimeout(t);
    return res.status;
  } catch (_) { return 0; }
}

// ---------- MCP over HTTP ----------
function parseMaybeSse(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch (_) { return null; } }
  const lines = t.split("\n").filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice(5).trim();
    if (!payload) continue;
    try { return JSON.parse(payload); } catch (_) { /* 继续往前找 */ }
  }
  return null;
}

async function mcpPost(port, token, body, sessionId, timeoutMs = 20000) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/${token}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, sessionId: res.headers.get("mcp-session-id") || null, text, json: parseMaybeSse(text), aborted: false };
  } catch (e) {
    return { status: 0, sessionId: null, text: String(e && e.message), json: null, aborted: /abort/i.test(String(e && e.message)) };
  } finally { clearTimeout(t); }
}

function initBody(id = 1) {
  return {
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" } },
  };
}

async function newSession(port, token) {
  const r = await mcpPost(port, token, initBody(1));
  return { sessionId: r.sessionId, init: r };
}

async function callTool(port, token, sessionId, name, args, id = 2) {
  return mcpPost(port, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sessionId);
}

function toolText(r) {
  try { return r.json.result.content[0].text; } catch (_) { return null; }
}

// ---------- 真实 SDK 客户端（ChatGPT 连接器 / Operit 都构建在这套 SDK 之上）----------
function sdkLoad() {
  const p = path.join(PREFIX, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  return import(`file://${p}`);
}
function transportLoad() {
  const p = path.join(PREFIX, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js");
  return import(`file://${p}`);
}
// 返回 { client, transport, status, tools, err }
async function sdkConnect(port, token) {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([sdkLoad(), transportLoad()]);
  const client = new Client({ name: "bridge-test-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${token}`));
  await client.connect(transport);
  return { client, transport };
}

module.exports = {
  COPY, PREFIX, NODE, state,
  ok, info, title, summary,
  makeHome, resetHome, baseEnv, run, startBridge, stopBridge,
  ownedPids, clientNodePids, clientTotal, sgPids, hubPids,
  waitFor, healthz,
  mcpPost, initBody, newSession, callTool, toolText, sdkConnect, sdkLoad, transportLoad,
};
