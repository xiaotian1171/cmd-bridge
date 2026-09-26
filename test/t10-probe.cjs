#!/usr/bin/env node
// t10：健康检查必须覆盖「真能用」，而不是「进程在 / 端口开着 / socket 文件在」
//   1) SIGSTOP 网关：TCP 端口仍可连（内核 backlog），但 healthz 已经答不出来 →
//      守护必须靠 healthz 判定并重启；
//   2) SIGSTOP 中枢：socket 仍可 connect（内核层），但 MCP 探测无响应 →
//      守护必须靠 MCP 级探测判定并重启；
//   3) stopping 标志存在时守护直接退出，不对「桥不可用」做任何重启动作。
//
// 用法: node test/t10-probe.cjs

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const H = require("./harness.cjs");

const TAG = "t10";
const HOME = H.makeHome(TAG);
const PORT = 8808;
const TOKEN = "tok-" + TAG;
const HUB_SOCK = `${HOME}/dc-hub.sock`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (_) { return false; } };
const kaLog = () => { try { return fs.readFileSync(`${HOME}/keepalive.log`, "utf8"); } catch (_) { return ""; } };
const restarts = () => (kaLog().match(/bridge down \(/g) || []).length;
const countLine = (re) => (kaLog().match(re) || []).length;

function tcpOpen(port, ms = 1500) {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res(true); });
    s.on("error", () => { clearTimeout(t); s.destroy(); res(false); });
  });
}
function unixOpen(p, ms = 1500) {
  return new Promise((res) => {
    const s = net.connect(p);
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res(true); });
    s.on("error", () => { clearTimeout(t); s.destroy(); res(false); });
  });
}

(async () => {
  let ka = null;
  try {
    H.title("t10 真探测（healthz / 中枢 MCP 探测）与 stopping 标志");
    H.resetHome(HOME, TOKEN);
    await H.startBridge(HOME, PORT);
    H.ok((await H.healthz(PORT)) === 200, "桥启动并就绪");

    ka = spawn("bash", [path.join(H.COPY, "keepalive.sh")], {
      env: H.baseEnv(HOME, PORT, { BRIDGE_KEEPALIVE_COOLDOWN: "5" }),
      detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    ka.unref();
    await sleep(4000);
    H.ok(alive(ka.pid), "keepalive 守护已启动");

    // ---------- 1) SIGSTOP 网关 ----------
    const sgOld = H.sgPids(HOME).map(Number);
    for (const pid of sgOld) process.kill(pid, "SIGSTOP");
    await sleep(500);
    const portStillOpen = await tcpOpen(PORT);
    const hzWhileStopped = await H.healthz(PORT, 2500);
    H.ok(portStillOpen, "网关被 SIGSTOP 后 TCP 端口仍可连（说明只看端口是假健康）");
    H.ok(hzWhileStopped !== 200, "此时 healthz 已经答不出来（真探测能识别假健康）", `healthz=${hzWhileStopped}`);
    const sgRestarted = await H.waitFor(async () => {
      const cur = H.sgPids(HOME).map(Number);
      return cur.length > 0 && !cur.some((p) => sgOld.includes(p)) && (await H.healthz(PORT)) === 200;
    }, { timeout: 30000, label: "守护按 healthz 重启网关" });
    H.ok(sgRestarted, "守护按 healthz 判定并重启了网关（新 PID、healthz 恢复 200）",
      `old=${sgOld.join(",")} new=${H.sgPids(HOME).join(",")}`);

    // ---------- 2) SIGSTOP 中枢 ----------
    const hubOld = H.hubPids(HOME).map(Number);
    for (const pid of hubOld) process.kill(pid, "SIGSTOP");
    await sleep(500);
    const sockOpen = await unixOpen(HUB_SOCK);
    H.ok(sockOpen, "中枢被 SIGSTOP 后 socket 仍可 connect（说明只看 socket 是假健康）");
    const hubRestarted = await H.waitFor(async () => {
      const cur = H.hubPids(HOME).map(Number);
      return cur.length > 0 && !cur.some((p) => hubOld.includes(p));
    }, { timeout: 30000, label: "守护按 MCP 探测重启中枢" });
    H.ok(hubRestarted, "守护按中枢 MCP 探测判定并重启（新中枢 PID）",
      `old=${hubOld.join(",")} new=${H.hubPids(HOME).join(",")}`);
    const fullyUp = await H.waitFor(async () => {
      if ((await H.healthz(PORT)) !== 200) return false;
      const t = await H.newSession(PORT, TOKEN);
      return t.init.status === 200;
    }, { timeout: 30000, label: "重启后完整就绪" });
    H.ok(fullyUp, "重启后网关 healthz 恢复 200 且能 initialize");
    const s = await H.newSession(PORT, TOKEN);
    const tl = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s.sessionId);
    H.ok(s.init.status === 200 && tl.status === 200 && tl.json.result.tools.length > 0,
      "重启后完整 MCP 调用可用（initialize + tools/list）", `init=${s.init.status} list=${tl.status}`);

    // ---------- 3) stopping 标志 ----------
    const restartsBefore = restarts();
    fs.writeFileSync(`${HOME}/stopping`, "");
    const kaExited = await H.waitFor(() => !alive(ka.pid), { timeout: 15000, label: "守护退出" });
    H.ok(kaExited, "stopping 标志出现后守护自动退出");
    H.ok(/stopping 标志/.test(kaLog()), "守护日志记录了 stopping 标志");
    H.ok(restarts() === restartsBefore && countLine(/检测到 stopping 标志/g) === 1,
      "守护没有在退出前额外重启一次", `restarts=${restarts()}`);
    const sgPidsAfterFlag = H.sgPids(HOME).length;
    await sleep(8000);
    H.ok(H.sgPids(HOME).length === sgPidsAfterFlag, "守护退出后 8s 内没有任何新的启动动作");
    fs.rmSync(`${HOME}/stopping`, { force: true });
  } catch (e) {
    H.ok(false, "t10 执行未抛异常", String((e && e.stack) || e).slice(0, 300));
  } finally {
    if (ka) { try { process.kill(ka.pid, "SIGKILL"); } catch (_) {} }
    await H.stopBridge(HOME, PORT).catch(() => {});
    H.info("已用 stop.sh 清理测试实例");
  }
  process.exit(H.summary("t10"));
})();
