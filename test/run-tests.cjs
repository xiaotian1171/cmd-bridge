#!/usr/bin/env node
// cmd-bridge 本地靶向测试
//   node test/run-tests.cjs
//
// 覆盖：
//   t1 中枢暂时不存在 → 恢复后客户端能重连（且请求被缓冲不丢）
//   t2 已连接的中枢退出 → 客户端不退出、不伪造响应，中枢恢复后自愈
//   t3 多个客户端同时发现中枢故障 → 只拉起一份中枢
//   t4 反复断线重连 → 请求仍可用、id 不串、进程/缓冲不堆积
//   t5 dc-hub + 引擎：initialize 本地应答、ChatGPT 兼容剥离、read/write/exec 转发、并发 id 路由

"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cmdbridge-test-"));
const children = [];
let pass = 0;
let fail = 0;
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + "\n");
function ok(name, cond, detail) {
  if (cond) { pass++; results.push(`[PASS] ${name}`); }
  else { fail++; results.push(`[FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// ---------- 通用：按行读取 ----------
function lineReader(stream) {
  const pending = [];
  const waiters = [];
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      const w = waiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(l); } else pending.push(l);
    }
  });
  stream.on("error", () => {});
  return {
    next(timeout = 6000) {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("等待输出超时"));
        }, timeout);
        waiters.push({ timer, resolve, reject });
      });
    },
    get buffered() { return pending.length; },
  };
}

function sendLine(stream, obj) { stream.write(JSON.stringify(obj) + "\n"); }

// ---------- 启动 dc-hub-client ----------
function spawnClient(sock, extraEnv = {}) {
  const proc = spawn(NODE, [path.join(ROOT, "dc-hub-client.cjs")], {
    env: { ...process.env, DC_HUB_SOCK: sock, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(proc);
  return {
    proc,
    reader: lineReader(proc.stdout),
    close() { try { proc.kill("SIGKILL"); } catch (_) {} },
  };
}

async function clientCall(cli, obj, timeout = 8000) {
  sendLine(cli.proc.stdin, obj);
  const line = await cli.reader.next(timeout);
  return JSON.parse(line);
}

// ---------- 进程内 hub（便于反复开关） ----------
function handleHub(msg) {
  if (msg.method === "initialize" && msg.id !== undefined) {
    return {
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "desktop-commander", version: "inproc-hub" },
      },
    };
  }
  if (msg.method === "tools/call" && msg.id !== undefined) {
    const name = (msg.params && msg.params.name) || "?";
    return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `FAKEHUB:${name}:${JSON.stringify((msg.params && msg.params.arguments) || {})}` }] } };
  }
  if (msg.id !== undefined) return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  return null;
}

function startHub(sock) {
  try { fs.unlinkSync(sock); } catch (_) {}
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
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
        const reply = handleHub(msg);
        if (reply && !conn.destroyed) conn.write(JSON.stringify(reply) + "\n");
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => conns.delete(conn));
  });
  server.listen(sock);
  return {
    destroyConns() { for (const c of conns) { try { c.destroy(); } catch (_) {} } },
    async close() {
      this.destroyConns();
      await new Promise((r) => server.close(r));
      try { fs.unlinkSync(sock); } catch (_) {}
    },
  };
}

async function waitSock(sock, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(sock)) {
      const good = await new Promise((res) => {
        const c = net.connect(sock);
        c.on("connect", () => { c.destroy(); res(true); });
        c.on("error", () => res(false));
      });
      if (good) return true;
    }
    await sleep(100);
  }
  return false;
}

function childCount(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return s ? s.split(/\s+/).length : 0;
  } catch (_) { return -1; }
}

// ---------- 直连 socket 的 RPC 客户端（t5 用） ----------
function rpcClient(sock) {
  const conn = net.connect(sock);
  const reader = lineReader(conn);
  return {
    conn,
    send(obj) { conn.write(JSON.stringify(obj) + "\n"); },
    async call(obj, timeout = 5000) { this.send(obj); return JSON.parse(await reader.next(timeout)); },
    close() { try { conn.destroy(); } catch (_) {} },
  };
}

// ================= 场景 =================

async function t1() {
  const sock = path.join(TMP, "s1.sock");
  const cli = spawnClient(sock, { DC_HUB_CMD: "" });
  await sleep(1200); // 先让它经历若干次连接失败
  sendLine(cli.proc.stdin, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  await sleep(300); // 此时中枢不存在，请求应被缓冲
  const hub = startHub(sock);
  try {
    const m = JSON.parse(await cli.reader.next(10000));
    ok("t1 中枢暂缺→恢复后重连并应答", m.id === 1 && m.result && m.result.serverInfo && m.result.serverInfo.name === "desktop-commander", JSON.stringify(m).slice(0, 140));
    ok("t1 缓冲期间的请求未丢失（protocolVersion 透传）", m.result && m.result.protocolVersion === "2025-11-25", m.result && m.result.protocolVersion);
  } finally { await hub.close(); cli.close(); }
}

async function t2() {
  const sock = path.join(TMP, "s2.sock");
  const cli = spawnClient(sock, { DC_HUB_CMD: "" });
  let hub = startHub(sock);
  try {
    const r1 = await clientCall(cli, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    ok("t2 连接正常时 initialize 成功", r1.id === 1 && !!r1.result, JSON.stringify(r1).slice(0, 120));

    await hub.close(); // 模拟中枢退出
    await sleep(1500);
    ok("t2 中枢退出后客户端仍存活（不卡死/不退出）", cli.proc.exitCode === null && !cli.proc.killed, `exitCode=${cli.proc.exitCode}`);
    ok("t2 中枢退出后客户端未伪造成功响应", cli.reader.buffered === 0, `buffered=${cli.reader.buffered}`);

    hub = startHub(sock); // 中枢恢复
    const r2 = await clientCall(cli, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute_command", arguments: { command: "echo hi" } } }, 12000);
    ok("t2 中枢恢复后请求自愈可用", r2.id === 2 && String(r2.result.content[0].text).startsWith("FAKEHUB:"), JSON.stringify(r2).slice(0, 140));
  } finally { await hub.close(); cli.close(); }
}

async function t3() {
  const sock = path.join(TMP, "s3.sock");
  const spawnLog = path.join(TMP, "s3.spawn.log");
  fs.writeFileSync(spawnLog, "");
  const hubCmd = `echo spawned >> '${spawnLog}'; exec ${NODE} ${path.join(__dirname, "fake-hub.cjs")} ${sock}`;

  const clis = [];
  for (let i = 0; i < 5; i++) clis.push(spawnClient(sock, { DC_HUB_CMD: hubCmd }));
  await sleep(3500);

  const spawned = fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean);
  ok("t3 5 个客户端并发发现中枢故障时只拉起 1 份中枢", spawned.length === 1, `实际拉起 ${spawned.length} 次`);

  let connected = 0;
  for (const cli of clis) {
    try {
      const r = await clientCall(cli, { jsonrpc: "2.0", id: 9, method: "initialize", params: {} }, 8000);
      if (r.id === 9 && r.result) connected++;
    } catch (_) {}
  }
  ok("t3 所有客户端最终都连上同一份中枢", connected === 5, `connected=${connected}`);

  for (const cli of clis) cli.close();
  try { execSync("pkill -f 'test/fake-hub.cjs' 2>/dev/null || true"); } catch (_) {}
}

async function t4() {
  const sock = path.join(TMP, "s4.sock");
  const cli = spawnClient(sock, { DC_HUB_CMD: "" });
  let hub = startHub(sock);
  let allOk = true;
  let detail = "";
  try {
    const r0 = await clientCall(cli, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    if (r0.id !== 1) { allOk = false; detail = "首次 initialize 失败"; }

    for (let k = 0; k < 5 && allOk; k++) {
      await hub.close();
      await sleep(400);
      hub = startHub(sock);
      const id = 100 + k;
      const r = await clientCall(cli, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/agent/jev-event-contract/README.md" } } }, 12000);
      if (r.id !== id) { allOk = false; detail = `第 ${k + 1} 轮断线重连后 id 不匹配（收到 ${r.id}）`; }
    }
    ok("t4 反复断线重连后请求仍可用、id 不串", allOk, detail);
    ok("t4 客户端未随断线产生子进程堆积", childCount(cli.proc.pid) === 0, `children=${childCount(cli.proc.pid)}`);
    ok("t4 断线期间缓冲未无限增长", cli.reader.buffered === 0, `buffered=${cli.reader.buffered}`);
  } finally { await hub.close(); cli.close(); }
}

async function t5() {
  const sock = path.join(TMP, "s5.sock");
  const hub = spawn(NODE, [path.join(ROOT, "dc-hub.cjs"), "--", NODE, path.join(__dirname, "fake-engine.cjs")], {
    env: { ...process.env, DC_HUB_SOCK: sock },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(hub);

  const ready = await waitSock(sock, 8000);
  ok("t5 中枢握手引擎后能监听", ready);
  if (!ready) { try { hub.kill("SIGKILL"); } catch (_) {} return; }

  const c1 = rpcClient(sock);
  const c2 = rpcClient(sock);
  try {
    const init = await c1.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    ok("t5 initialize 由中枢本地应答（引擎只握手一次）", init.id === 1 && init.result && init.result.serverInfo && init.result.serverInfo.name === "desktop-commander", JSON.stringify(init).slice(0, 140));
    ok("t5 ChatGPT 兼容：capabilities.resources 已剥离", !(init.result.capabilities && init.result.capabilities.resources), JSON.stringify(init.result.capabilities));
    c1.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const tl = await c1.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = tl.result.tools;
    const EXPECT_TOOLS = ["read_file", "write_file", "execute_command", "start_process", "read_process_output", "list_processes"];
    ok("t5 tools/list 正常返回假引擎的全部 6 个工具",
      tools.length === EXPECT_TOOLS.length && EXPECT_TOOLS.every((n) => tools.some((t) => t.name === n)),
      tools.map((t) => t.name).join(","));
    ok("t5 ChatGPT 兼容：工具 _meta 已剥离", tools.every((t) => t._meta === undefined));

    const rf = await c1.call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/agent/jev-event-contract/README.md" } } });
    ok("t5 read_file 转发正常（Jev 文件读取）", String(rf.result.content[0].text).startsWith("READ("), JSON.stringify(rf).slice(0, 140));

    const wf = await c1.call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write_file", arguments: { path: "/home/agent/jev-event-contract/tmp.txt", content: "x" } } });
    ok("t5 write_file 转发正常（Jev 文件编辑）", String(wf.result.content[0].text).startsWith("WROTE("), JSON.stringify(wf).slice(0, 140));

    const ec = await c1.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "execute_command", arguments: { command: "ls /home/agent/jev-event-contract" } } });
    ok("t5 execute_command 转发正常（Jev 命令执行）", String(ec.result.content[0].text).startsWith("EXEC("), JSON.stringify(ec).slice(0, 140));

    const pA = c1.call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "read_file", arguments: { path: "A" } } });
    const pB = c2.call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "execute_command", arguments: { command: "B" } } });
    const [rA, rB] = await Promise.all([pA, pB]);
    const tA = String(rA.result.content[0].text);
    const tB = String(rB.result.content[0].text);
    ok("t5 两个并发连接使用相同 id 也能正确路由", tA.startsWith("READ(A)") && tB.startsWith("EXEC(B)"), `${tA} | ${tB}`);
  } finally {
    c1.close(); c2.close();
    try { hub.kill("SIGKILL"); } catch (_) {}
  }
}

// ================= 主流程 =================
(async () => {
  log("== cmd-bridge 本地靶向测试 ==");
  log(`临时目录: ${TMP}`);
  log("");
  for (const [name, fn] of [["t1", t1], ["t2", t2], ["t3", t3], ["t4", t4], ["t5", t5]]) {
    try { await fn(); }
    catch (e) { fail++; results.push(`[FAIL] ${name} 执行异常: ${e.message}`); }
  }
  log(results.join("\n"));
  log("");
  log(`结果: ${pass} 通过 / ${fail} 失败`);
  for (const c of children) { try { c.kill("SIGKILL"); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
