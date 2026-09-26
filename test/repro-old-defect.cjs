#!/usr/bin/env node
// 缺陷最小复现（对照旧版/新版 dc-hub-client）
//   node test/repro-old-defect.cjs <dc-hub-client.cjs 路径>
//
// 场景：
//   A 中枢暂不存在（DC_HUB_CMD 为空）→ 客户端是否退出？之后中枢起来能否重连？
//   B 中枢暂不存在（给了 DC_HUB_CMD）→ 客户端是否仍退出（导致重连根本不发生）？
//   C 已连上中枢后中枢退出 → 客户端是否退出？

"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const clientPath = process.argv[2];
if (!clientPath) { console.error("用法: node repro-old-defect.cjs <dc-hub-client.cjs>"); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cmdbridge-repro-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnClient(sock, hubCmd) {
  return spawn(process.execPath, [clientPath], {
    env: { ...process.env, DC_HUB_SOCK: sock, DC_HUB_CMD: hubCmd || "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function kill(p) { try { p.kill("SIGKILL"); } catch (_) {} }

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
        if (msg.method === "initialize" && msg.id !== undefined) {
          conn.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "desktop-commander" } } }) + "\n");
        }
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => conns.delete(conn));
  });
  server.listen(sock);
  return {
    async close() {
      for (const c of conns) { try { c.destroy(); } catch (_) {} }
      await new Promise((r) => server.close(r));
      try { fs.unlinkSync(sock); } catch (_) {}
    },
  };
}

// 场景 A：中枢暂缺 → 之后中枢起来，能否重连并应答
async function caseA() {
  const sock = path.join(TMP, "a.sock");
  const p = spawnClient(sock, "");
  await sleep(1300);
  const exitedEarly = p.exitCode !== null;

  let revived = false;
  if (!exitedEarly) {
    const hub = startHub(sock);
    const got = await new Promise((resolve) => {
      let buf = "";
      const timer = setTimeout(() => resolve(false), 6000);
      p.stdout.on("data", (d) => {
        buf += d.toString();
        if (buf.includes('"id":1')) { clearTimeout(timer); resolve(true); }
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    });
    revived = got;
    await hub.close();
  }
  kill(p);
  return { exitedEarly, code: p.exitCode, revived };
}

// 场景 B：给 DC_HUB_CMD，中枢暂缺，观察是否仍退出、命令是否被拉起
async function caseB() {
  const sock = path.join(TMP, "b.sock");
  const pullLog = path.join(TMP, "b.pull.log");
  fs.writeFileSync(pullLog, "");
  const p = spawnClient(sock, `echo pulled >> '${pullLog}'`);
  await sleep(1300);
  const exited = p.exitCode !== null;
  const pulled = fs.readFileSync(pullLog, "utf8").split("\n").filter(Boolean).length;
  kill(p);
  return { exited, code: p.exitCode, pulled };
}

// 场景 C：先连上中枢，再让中枢退出
async function caseC() {
  const sock = path.join(TMP, "c.sock");
  const hub = startHub(sock);
  const p = spawnClient(sock, "");
  await sleep(800); // 等它连上
  await hub.close(); // 中枢退出
  await sleep(1300);
  const exited = p.exitCode !== null;
  kill(p);
  return { exited, code: p.exitCode };
}

(async () => {
  console.log(`被检客户端: ${clientPath}`);
  const a = await caseA();
  const b = await caseB();
  const c = await caseC();

  console.log("");
  console.log(`A 中枢暂缺:`);
  console.log(`   - 启动 1.3s 后是否已退出: ${a.exitedEarly}${a.exitedEarly ? `（exitCode=${a.code}）` : ""}`);
  console.log(`   - 中枢事后恢复能否重连并应答: ${a.revived}`);
  console.log(`B 中枢暂缺 + DC_HUB_CMD:`);
  console.log(`   - 启动 1.3s 后是否已退出: ${b.exited}${b.exited ? `（exitCode=${b.code}）` : ""}`);
  console.log(`   - 拉起命令被执行的次数: ${b.pulled}`);
  console.log(`C 已连上后中枢退出:`);
  console.log(`   - 是否退出: ${c.exited}${c.exited ? `（exitCode=${c.code}）` : ""}`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
})();
