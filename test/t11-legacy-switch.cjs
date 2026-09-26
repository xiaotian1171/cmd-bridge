#!/usr/bin/env node
// t11 首次从「无 BRIDGE_OWNER 的旧版」切到新版
//
// 场景（不触碰线上，全部在 /tmp 与高位端口）：
//   1) 用 HEAD（改造前）代码在 /tmp/bridge-t11/dir 启动旧桥 A + 旧 keepalive 守护
//      （旧守护自身没有任何 home 标记，只能靠「是本桥网关的祖先」识别）
//   2) 同机另一套桥 B 用新版代码（这是升级后机器的真实样子）
//      —— 新版 B 启动时的清理不能碰旧桥 A（不同 home / 不同端口）
//   3) 三个「同机同名诱饵」：别人的 supergateway、别的 home 的中枢、别的 home 的转发进程
//   4) 把新版代码原地覆盖到 A 的目录（模拟真实升级方式），用新 stop.sh 只停 A：
//      A 的旧网关/旧中枢/旧转发进程/旧守护全部精确停掉、端口释放、12s 内没被旧守护拉起；
//      B 与三个诱饵全部存活；全程不需要 BRIDGE_KILL_LEGACY=1
//   5) 再用新版 start.sh 在同一个目录/端口起 A：healthz 200 + initialize + tools/call

"use strict";
const H = require("./harness.cjs");
const path = require("path");
const fs = require("fs");
const { execFileSync, spawn } = require("child_process");

const { ok, info, title, summary, waitFor } = H;

const LEGDIR = "/tmp/bridge-t11/dir";
const HOME_A = "/tmp/bridge-test-t11a";
const HOME_B = "/tmp/bridge-test-t11b";
const HOME_DECOY = "/tmp/bridge-test-t11-decoy";
const PORT_A = 8809;
const PORT_B = 8810;

const SD_RE = LEGDIR.replace(/[][\\.^$*+?(){}|]/g, (m) => "\\" + m);
const NPM_RE = H.PREFIX.replace(/[][\\.^$*+?(){}|]/g, (m) => "\\" + m);
const SG_PAT = `${NPM_RE}/lib/node_modules/supergateway|${NPM_RE}/bin/supergateway`;
const HUB_PAT = `${SD_RE}/dc-hub\\.cjs`;
const CLIENT_PAT = `${SD_RE}/dc-hub-client\\.cjs`;
const KEEPALIVE_PAT = `${SD_RE}/keepalive\\.sh`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function envFor(home, port, extra = {}) {
  return H.baseEnv(home, port, { DC_HUB_SOCK: path.join(home, "dc-hub.sock"), ...extra });
}

// 用 proc-lib.sh 的 scoped_pids 查询「新版 owned ∪ 旧实例」
function scopedPids(home, port, pattern, exclude) {
  const script = `. "${path.join(H.COPY, "proc-lib.sh")}"; scoped_pids "$1" "$2"`;
  try {
    const out = execFileSync("bash", ["-c", script, "bash", pattern, exclude || ""], {
      env: { ...process.env, BRIDGE_HOME: home, BRIDGE_PORT: String(port), DC_HUB_SOCK: path.join(home, "dc-hub.sock") },
      encoding: "utf8",
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

function pidAlive(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
    return s !== "Z";
  } catch (_) { return false; }
}

function portListening(port) {
  try {
    const out = execFileSync("bash", ["-c", `ss -ltnH 2>/dev/null | awk '{split($4,a,":"); if (a[length(a)]=="${port}") print}'`], { encoding: "utf8" });
    return out.trim().length > 0;
  } catch (_) { return false; }
}

// 旧版代码的基准：proc-lib.sh 是本次修复才引入的文件，它的「新增提交」的父提交
// 就是最后一份「带 dc-hub 引擎但还没有进程作用域化逻辑」的代码。不能用 HEAD，
// 因为修复提交之后 HEAD 已经变成新版，装出来的就不是旧版了。
function legacyRef() {
  try {
    const add = execFileSync("git", ["log", "--format=%H", "-1", "--diff-filter=A", "--", "proc-lib.sh"],
      { cwd: H.COPY, encoding: "utf8" }).trim();
    if (add) return `${add}^`;
  } catch (_) { /* 落到 HEAD 兜底 */ }
  return "HEAD";
}

function writeLegacyDir() {
  fs.rmSync(LEGDIR, { recursive: true, force: true });
  fs.mkdirSync(LEGDIR, { recursive: true });
  const ref = legacyRef();
  const files = ["start.sh", "stop.sh", "keepalive.sh", "dc-hub.cjs", "dc-hub-client.cjs",
                 "sg-hook.cjs", "chatgpt-compat.cjs", "tls-proxy.cjs", "engine-guard.sh",
                 "filter-proxy.js"];
  for (const f of files) {
    const body = execFileSync("git", ["show", `${ref}:${f}`], { cwd: H.COPY, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    fs.writeFileSync(path.join(LEGDIR, f), body);
  }
  return ref;
}

function upgradeInPlace() {
  const files = ["start.sh", "stop.sh", "keepalive.sh", "proc-lib.sh", "dc-hub.cjs",
                 "dc-hub-client.cjs", "sg-hook.cjs", "chatgpt-compat.cjs", "tls-proxy.cjs",
                 "engine-guard.sh", "filter-proxy.js"];
  for (const f of files) {
    const src = path.join(H.COPY, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(LEGDIR, f));
  }
}

const readToken = (home) => fs.readFileSync(path.join(home, "token"), "utf8").trim();

(async () => {
  title("t11 首次切换：旧版（无 BRIDGE_OWNER）→ 新版");

  // ---------- 准备 ----------
  H.resetHome(HOME_A, "tok-t11a");
  H.resetHome(HOME_B, "tok-t11b");
  fs.rmSync(HOME_DECOY, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME_DECOY, "logs"), { recursive: true });
  const legRef = writeLegacyDir();
  info(`旧版代码（${legRef}）已写入 ${LEGDIR}`);

  // 旧桥 A + 旧守护
  const aStart = await H.run(path.join(LEGDIR, "start.sh"), [], envFor(HOME_A, PORT_A));
  ok(aStart.code === 0 && /已就绪/.test(aStart.out), `旧版 A 启动成功（${legRef} 代码，environ 无 BRIDGE_OWNER）`, `rc=${aStart.code}`);
  const aKeep = spawn("bash", [path.join(LEGDIR, "keepalive.sh")], { env: envFor(HOME_A, PORT_A), detached: true, stdio: "ignore" });
  aKeep.unref(); children.push(aKeep);
  ok(await waitFor(() => scopedPids(HOME_A, PORT_A, KEEPALIVE_PAT).length > 0, { timeout: 8000, label: "旧守护出现" }),
    "旧版 A 的 keepalive 守护已运行（自身没有 BRIDGE_OWNER 标记）");

  // 同机另一套桥 B：新版代码
  await H.startBridge(HOME_B, PORT_B);
  ok(portListening(PORT_B), "同机另一套桥 B（新版代码）已启动并监听 8810");
  ok(portListening(PORT_A), "新版 B 启动时的清理没有碰到旧桥 A（A 的 8809 仍在监听）");

  // 三个同名诱饵
  const decoySg = spawn("bash", ["-c", `exec -a ${H.PREFIX}/bin/supergateway sleep 900`], { detached: true, stdio: "ignore" });
  decoySg.unref(); children.push(decoySg);
  const decoyHub = spawn(process.execPath, [path.join(H.COPY, "dc-hub.cjs"), "--", "sh", "-c", `${H.PREFIX}/bin/desktop-commander`], {
    env: { ...process.env, DC_HUB_SOCK: path.join(HOME_DECOY, "dc-hub.sock") }, detached: true, stdio: "ignore",
  });
  decoyHub.unref(); children.push(decoyHub);
  // 注意：转发进程在 stdin 关闭时会自行退出，诱饵必须给一个常开的 stdin
  const decoyClient = spawn(process.execPath, [path.join(H.COPY, "dc-hub-client.cjs")], {
    env: { ...process.env, DC_HUB_SOCK: path.join(HOME_DECOY, "dc-hub.sock") }, detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  decoyClient.unref(); children.push(decoyClient);
  await sleep(2500);
  ok(pidAlive(decoySg.pid) && pidAlive(decoyHub.pid) && pidAlive(decoyClient.pid), "三个同名诱饵已就位");

  // A 上开一个 session（制造旧版 session 转发进程）
  const tokA = await readToken(HOME_A);
  const s = await H.newSession(PORT_A, tokA);
  ok(!!s.sessionId, "旧版 A 上能建立 MCP session（HTTP initialize 成功）");
  await sleep(1000);
  const legacyClients = scopedPids(HOME_A, PORT_A, CLIENT_PAT, SG_PAT);
  ok(legacyClients.length >= 1, "旧版 A 的 session 转发进程已出现", `count=${legacyClients.length}`);

  const aGateway = scopedPids(HOME_A, PORT_A, SG_PAT);
  const aHub = scopedPids(HOME_A, PORT_A, HUB_PAT);
  const aKeepPid = scopedPids(HOME_A, PORT_A, KEEPALIVE_PAT);
  ok(aGateway.length === 1 && aHub.length === 1 && aKeepPid.length >= 1,
    "新 stop.sh 的识别口径把 A 的旧网关/旧中枢/旧守护都认了出来",
    `gw=${aGateway.length} hub=${aHub.length} keep=${aKeepPid.length}`);
  ok(!aGateway.includes(String(decoySg.pid)) && !aHub.includes(String(decoyHub.pid)) && !aHub.includes(String(decoyClient.pid)),
    "识别口径不会把别人的同名进程算成 A 的（诱饵 PID 不在列表里）");
  const bSeen = scopedPids(HOME_B, PORT_B, SG_PAT);
  ok(!bSeen.includes(aGateway[0]), "识别口径按 home/端口区分：B 的视角里看不到 A 的网关");

  // ---------- 原地升级 ----------
  upgradeInPlace();
  info("新版代码已原地覆盖到同一目录（模拟真实升级方式）");

  // ---------- 只停 A ----------
  const stopA = await H.run(path.join(LEGDIR, "stop.sh"), [], envFor(HOME_A, PORT_A));
  ok(stopA.code === 0, "新 stop.sh 执行成功（未使用 BRIDGE_KILL_LEGACY）", `rc=${stopA.code}`);
  ok(/旧实例/.test(stopA.out), "stop.sh 明确报告识别到旧实例（无 BRIDGE_OWNER）",
    stopA.out.split("\n").filter((l) => /旧实例/.test(l)).join(" | ").slice(0, 200));
  ok(!/回退全量匹配|BRIDGE_KILL_LEGACY=1 回退/.test(stopA.out), "本次没有走 BRIDGE_KILL_LEGACY 全量回退路径");
  ok(/端口已释放/.test(stopA.out), "stop.sh 自带端口释放核对并报告已释放");

  ok(await waitFor(() => !portListening(PORT_A), { timeout: 8000, label: "A 端口释放" }), "A 的端口 8809 已释放（没有被旧网关占着）");
  ok(await waitFor(() => aGateway.every((p) => !pidAlive(p)), { timeout: 8000, label: "A 网关退出" }), "A 的旧网关进程已退出");
  ok(await waitFor(() => aHub.every((p) => !pidAlive(p)), { timeout: 8000, label: "A 中枢退出" }), "A 的旧中枢进程已退出");
  ok(await waitFor(() => legacyClients.every((p) => !pidAlive(p)), { timeout: 8000, label: "A 转发进程退出" }), "A 的旧 session 转发进程已退出");
  ok(await waitFor(() => aKeepPid.every((p) => !pidAlive(p)), { timeout: 8000, label: "A 旧守护退出" }), "A 的旧 keepalive 守护已退出（不会再拉起重启）");

  ok(portListening(PORT_B) && pidAlive(decoySg.pid) && pidAlive(decoyHub.pid) && pidAlive(decoyClient.pid),
    "同机另一套桥 B 与三个同名诱饵全部存活",
    `B端口=${portListening(PORT_B)} sg=${pidAlive(decoySg.pid)} hub=${pidAlive(decoyHub.pid)} client=${pidAlive(decoyClient.pid)}`);
  const tokB = await readToken(HOME_B);
  const sB = await H.newSession(PORT_B, tokB);
  ok(!!sB.sessionId, "B 在被停 A 之后仍能建立 MCP session（确实没被波及）",
    `status=${sB.init.status} text=${String(sB.init.text).slice(0, 120)}`);

  // ---------- 12 秒观察：旧守护有没有偷偷把 A 拉回来 ----------
  info("观察 12s（旧守护循环 5s/次），确认 A 没有被偷偷重启");
  await sleep(12000);
  ok(!portListening(PORT_A), "12s 后 A 的端口仍然空闲（旧守护已被停掉，没有再拉起重启）");

  // ---------- 新版在 A 上启动 ----------
  const aNewStart = await H.run(path.join(LEGDIR, "start.sh"), [], envFor(HOME_A, PORT_A));
  ok(aNewStart.code === 0, "新版 start.sh 在同一个目录/端口上启动成功（端口没被旧实例占用）", `rc=${aNewStart.code}`);
  ok(await waitFor(async () => (await H.healthz(PORT_A)) === 200, { timeout: 15000, label: "A healthz" }), "新版 A 的 healthz 返回 200");
  const tokA2 = await readToken(HOME_A);
  const sA2 = await H.newSession(PORT_A, tokA2);
  ok(!!sA2.sessionId, "新版 A 可以正常建立 MCP session");
  const call = await H.callTool(PORT_A, tokA2, sA2.sessionId, "list_directory", { path: "/tmp" });
  ok(call.status === 200, "新版 A 上 tools/call 正常", `status=${call.status}`);

  // ---------- 清理 ----------
  await H.run(path.join(LEGDIR, "stop.sh"), [], envFor(HOME_A, PORT_A));
  await H.stopBridge(HOME_B, PORT_B);
  for (const c of children) { try { process.kill(-c.pid, "SIGKILL"); } catch (_) { try { c.kill("SIGKILL"); } catch (__) {} } }
  info("已清理测试实例（A/B 与三个诱饵）");

  process.exit(summary("t11"));
})().catch((e) => { console.error("t11 异常:", e); process.exit(1); });
