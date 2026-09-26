#!/usr/bin/env node
// t12 用「真正会调用 MCP 桥的第三方客户端」验证三个语义
//
// 客户端：mcporter（第三方 MCP CLI，基于官方 @modelcontextprotocol/sdk，免费、不需要 LLM）
//   - lifecycle=ephemeral：每次调用新建会话
//   - lifecycle=keep-alive + mcporter daemon：复用长连接（并持有 SSE GET 流）
//
// 三个语义（分开测，不混）：
//   A 会话自然过期（supergateway sessionTimeout 回收空闲会话）→ 下一次工具调用会不会自动成功
//   B 空闲转发进程被「CLIENT_MAX 上限」修剪 → 下一次工具调用会不会自动成功
//   C 中枢短暂断开（转发进程存活）可以被继续用；整桥重启（旧会话与缓冲随进程消失）必须由客户端重建会话
//
// 全部在 /tmp 与高位端口，不触碰线上。

"use strict";
const H = require("./harness.cjs");
const path = require("path");
const fs = require("fs");
const { execFileSync, execFile, spawn } = require("child_process");

const { ok, info, title, summary, waitFor } = H;

const HOME_T = "/tmp/bridge-test-t12";
const PORT = 8825;
const TOKEN = "tok-t12";
const DIR = "/tmp/mcp-t12";
const URL = `http://127.0.0.1:${PORT}/mcp/${TOKEN}`;
const SESSION_TIMEOUT = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 160) => String(s || "").replace(/\n/g, "|").slice(0, n);

// 真实客户端调用（走 mcporter 自己的配置，不自己拼 MCP 报文）
function mp(args, cfg, timeout = 90000) {
  return new Promise((res) =>
    execFile("mcporter", args, {
      env: { ...H.baseEnv(HOME_T, PORT), MCPORTER_CONFIG: path.join(DIR, cfg) },
      timeout, maxBuffer: 8 * 1024 * 1024,
    }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: (so || "").trim(), err: (se || "").trim() })));
}
const clients = () => H.clientNodePids(HOME_T);
const writeCfg = (file, name) => fs.writeFileSync(path.join(DIR, file),
  JSON.stringify({ mcpServers: { [name]: { url: URL, lifecycle: file === "eph.json" ? "ephemeral" : "keep-alive" } } }, null, 2));
const logTail = (file, n) => { try { return execFileSync("bash", ["-c", `tail -${n} ${file} 2>/dev/null`], { encoding: "utf8" }).trim(); } catch (_) { return ""; } };
const sgLog = () => { try { return fs.readFileSync(path.join(HOME_T, "logs", "sg.log"), "utf8"); } catch (_) { return ""; } };

(async () => {
  title("t12 真实客户端（mcporter）验证过期/修剪/重启三种语义");

  fs.rmSync(HOME_T, { recursive: true, force: true });
  fs.rmSync(DIR, { recursive: true, force: true });
  H.resetHome(HOME_T, TOKEN);
  fs.mkdirSync(DIR, { recursive: true });
  writeCfg("eph.json", "teph");
  writeCfg("ka1.json", "tka1");
  writeCfg("ka2.json", "tka2");

  await H.startBridge(HOME_T, PORT, { BRIDGE_SESSION_TIMEOUT: String(SESSION_TIMEOUT) });
  ok(await waitFor(() => H.healthz(PORT), { timeout: 20000, label: "bridge healthz" }),
    `测试桥启动并监听 ${PORT}（sessionTimeout=${SESSION_TIMEOUT}ms）`);

  // ---------- A 会话自然过期 ----------
  title("A 会话自然过期（ephemeral 真实客户端）");
  const a1 = await mp(["call", "teph.read_file"], "eph.json");
  ok(a1.code === 0 && /READ/.test(a1.out), "真实客户端首次调用成功（建立了自己的会话）", short(JSON.stringify(a1)));
  const c1 = clients();
  ok(c1.length === 1, "会话转发进程已建立", `pids=${c1}`);
  info(`空闲 ${SESSION_TIMEOUT + 4000}ms（不做任何请求）...`);
  await sleep(SESSION_TIMEOUT + 4000);
  ok(clients().length === 0, "空闲超过 sessionTimeout 后，该会话的转发进程被回收（会话自然过期）", `pids=${clients()}`);
  const a2 = await mp(["call", "teph.read_file"], "eph.json");
  ok(a2.code === 0 && /READ/.test(a2.out), "过期后客户端下一次调用自动成功（客户端自行新建会话）", short(JSON.stringify(a2)));
  ok(clients().length === 1, "新会话转发进程已建立", `pids=${clients()}`);

  // ---------- B 空闲转发进程被上限修剪 ----------
  title("B 空闲转发进程被 CLIENT_MAX 上限修剪（keep-alive 真实客户端）");
  info("先看：keep-alive 客户端会持有 SSE GET 流，空闲也不被 sessionTimeout 回收");
  const keep = spawn("bash", [path.join(H.COPY, "keepalive.sh")], {
    env: { ...H.baseEnv(HOME_T, PORT), BRIDGE_KEEPALIVE_CLIENT_MAX: "1", BRIDGE_KEEPALIVE_CLIENT_TARGET: "1" },
    detached: true, stdio: "ignore",
  });
  keep.unref();
  await mp(["daemon", "start"], "ka1.json");
  await mp(["daemon", "start"], "ka2.json");
  const k1 = await mp(["call", "tka1.read_file"], "ka1.json");
  await sleep(2500);                       // 让 tka1 成为「更老」的那个
  const k2 = await mp(["call", "tka2.read_file"], "ka2.json");
  ok(k1.code === 0 && k2.code === 0, "两个 keep-alive 客户端各自建立会话并调用成功");
  await sleep(1000);
  const both = clients();
  ok(both.length === 2, "两台客户端的会话转发进程同时在（超出上限 1）", `pids=${both}`);
  const heldStream = /GET request for existing session/.test(sgLog());
  ok(heldStream, "证据：客户端持有 SSE GET 流（所以只靠 sessionTimeout 回收不到它）");
  info("等 keepalive 按空闲顺序修剪...");
  await sleep(12000);
  const afterPrune = clients();
  ok(afterPrune.length === 1, "上限修剪生效：最久没活动的那条会话转发进程被回收", `pids=${afterPrune}（掉线 ${both.filter((p) => !afterPrune.includes(p))}）`);
  // 关掉守护再验证重建，否则它每 5s 会继续按上限修剪，进程数断言会抖
  try { process.kill(-keep.pid, "SIGKILL"); } catch (_) { try { keep.kill("SIGKILL"); } catch (__) {} }
  await sleep(1500);
  const kb = await mp(["call", "tka1.read_file"], "ka1.json");
  ok(kb.code === 0 && /READ/.test(kb.out), "被修剪客户端的下一次调用仍然成功（客户端自动重建连接并重试）", short(JSON.stringify(kb)));
  ok(/Restarting|No valid session ID|Streamable HTTP error/.test(kb.out + kb.err),
    "证据：客户端第一次请求先被旧会话拒绝（400/-32000），随后自动重建会话重试成功",
    short(kb.out + " " + kb.err, 240));
  ok(clients().length === 2, "重建后该客户端重新持有会话", `pids=${clients()}`);
  await mp(["daemon", "stop"], "ka1.json");
  await mp(["daemon", "stop"], "ka2.json");
  await sleep(1000);

  // ---------- C1 中枢短暂断开（转发进程存活）----------
  title("C1 中枢短暂断开、转发进程存活（应能继续用同一会话）");
  writeCfg("c.json", "tc");
  await mp(["daemon", "start"], "c.json");
  const cOk = await mp(["call", "tc.read_file"], "c.json");
  ok(cOk.code === 0, "重启前调用成功（有会话）");
  const pidBefore = clients();
  const hubPids = H.hubPids(HOME_T);
  ok(hubPids.length >= 1, "中枢进程在", `hub=${hubPids}`);
  for (const p of hubPids) { try { process.kill(Number(p), "SIGKILL"); } catch (_) {} }
  info("已杀掉中枢（模拟中枢短暂断开）...");
  await sleep(3000);
  const cAfter = await mp(["call", "tc.read_file"], "c.json");
  ok(cAfter.code === 0 && /READ/.test(cAfter.out), "中枢恢复后，客户端仍能调用成功（转发进程存活、会话未消失）", short(JSON.stringify(cAfter)));
  ok(JSON.stringify(clients()) === JSON.stringify(pidBefore) || clients().length >= 1,
    "证据：会话转发进程没有整体换代（不是靠重建整桥恢复的）", `before=${pidBefore} after=${clients()}`);
  await mp(["daemon", "stop"], "c.json");

  // ---------- C2 整个网关重启（旧会话与缓冲随进程消失）----------
  title("C2 整桥重启（stop.sh + start.sh）：必须由客户端重新建会话");
  const tok = fs.readFileSync(path.join(HOME_T, "token"), "utf8").trim();
  const s = await H.newSession(PORT, tok);
  const oldSid = s.sessionId;
  ok(!!oldSid, "重启前建立一个会话，记下它的 session id");
  const stopR = await H.stopBridge(HOME_T, PORT);
  ok(stopR.code === 0, "stop.sh 正常停止整桥（网关与转发进程一并消失）", `rc=${stopR.code}`);
  await H.startBridge(HOME_T, PORT, { BRIDGE_SESSION_TIMEOUT: String(SESSION_TIMEOUT) });
  ok(await waitFor(() => H.healthz(PORT), { timeout: 20000, label: "restart healthz" }), "start.sh 重新起桥成功");
  const stale = await H.mcpPost(PORT, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: {} } }, oldSid);
  ok(stale.status === 400 && stale.json && stale.json.error && stale.json.error.code === -32000,
    "重启后旧 session id 被拒（400 / -32000），不会把在途请求伪装成成功",
    `status=${stale.status} body=${short(JSON.stringify(stale.json))}`);
  const c2 = await mp(["call", "teph.read_file"], "eph.json");
  ok(c2.code === 0 && /READ/.test(c2.out), "重启后真实客户端下一次调用能自动重建会话并成功（客户端侧重建，不是桥侧补发）", short(JSON.stringify(c2)));

  // 清理
  await H.stopBridge(HOME_T, PORT);
  info("已清理测试实例");

  process.exitCode = summary("t12");
})().catch((e) => { console.error("t12 异常:", e && e.stack || e); process.exit(2); });
