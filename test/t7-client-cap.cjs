#!/usr/bin/env node
// t7：进程上限（session 堆积）与守护重启行为
//   1) 超过 CLIENT_MAX 时，守护「掐掉最老的 session」而不是重启整条桥：
//      - 不发生重启（keepalive.log 无 restarting）
//      - supergateway 主进程 PID 不变
//      - 仍在使用的 session 不受影响（调用照常成功）
//   2) 网关真挂掉时只重启一次，且不会进入重启循环
//   3) start.sh 持续失败时按 COOLDOWN 退避，不形成高频重建
//
// 用法: node test/t7-client-cap.cjs

const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const H = require("./harness.cjs");

const TAG = "t7";
const PORT = 8802;
const TOKEN = "tok-" + TAG;
const CLIENT_MAX = 5;
const CLIENT_TARGET = 2;

const logText = (home) => { try { return fs.readFileSync(`${home}/keepalive.log`, "utf8"); } catch (_) { return ""; } };
const countRestarts = (home) => (logText(home).match(/bridge down \(/g) || []).length;

function startKeepalive(home, extra = {}) {
  const p = spawn("bash", [path.join(H.COPY, "keepalive.sh")], {
    env: H.baseEnv(home, PORT, {
      BRIDGE_KEEPALIVE_CLIENT_MAX: String(CLIENT_MAX),
      BRIDGE_KEEPALIVE_CLIENT_TARGET: String(CLIENT_TARGET),
      BRIDGE_KEEPALIVE_PRUNE_STRIKES: "2",
      BRIDGE_KEEPALIVE_COOLDOWN: "5",
      BRIDGE_SESSION_TIMEOUT: "60000",
      ...extra,
    }),
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  p.unref();
  return p;
}

(async () => {
  const home = H.makeHome(TAG);
  let ka = null;
  try {
    H.title("t7 session 进程上限与守护重启行为");
    H.resetHome(home, TOKEN);
    await H.startBridge(home, PORT, { BRIDGE_SESSION_TIMEOUT: "60000" });
    H.ok((await H.waitFor(async () => (await H.healthz(PORT)) === 200, { label: "healthz" })), "桥启动并就绪");

    ka = startKeepalive(home);
    await new Promise((r) => setTimeout(r, 1500));
    const sgBefore = H.sgPids(home);
    H.ok(sgBefore.length > 0, "守护启动前 supergateway 进程存在", JSON.stringify(sgBefore));

    // ---------- 1) 造 8 个 session，超过上限 5 ----------
    const sessions = [];
    for (let i = 0; i < 8; i++) sessions.push((await H.newSession(PORT, TOKEN)).sessionId);
    const grew = await H.waitFor(() => H.clientNodePids(home).length >= 8, { timeout: 15000, label: "8 个 session 进程出现" });
    H.ok(grew, "8 个并发 session 各生成一个转发进程（模拟客户端不复用 session）", `count=${H.clientNodePids(home).length}`);

    const pruned = await H.waitFor(() => H.clientNodePids(home).length <= CLIENT_MAX, { timeout: 25000, label: "修剪到上限以内" });
    const afterPrune = H.clientNodePids(home).length;
    H.ok(pruned, `超过上限后被修剪到 <= ${CLIENT_MAX}`, `count=${afterPrune}`);
    H.ok(countRestarts(home) === 0, "修剪路径没有触发整桥重启（keepalive.log 无 restarting）", `restarts=${countRestarts(home)}`);
    H.ok(H.sgPids(home).some((p) => sgBefore.includes(p)), "supergateway 主进程未被重启（PID 不变）");

    // 修剪后，仍在使用的最新 session 必须照常可用
    const alive = sessions[sessions.length - 1];
    const callAfterPrune = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 9, method: "tools/list" }, alive);
    H.ok(callAfterPrune.status === 200 && (callAfterPrune.json.result.tools || []).length > 0,
      "修剪期间「新 session」的调用未被打断", `status=${callAfterPrune.status}`);
    const log1 = logText(home);
    const pruneLogged = await H.waitFor(
      () => /已修剪最老的/.test(logText(home)) && /修剪生效/.test(logText(home)),
      { timeout: 15000, label: "修剪动作与生效日志" }
    );
    H.ok(pruneLogged, "守护日志记录了修剪动作与结果");
    H.info((logText(home).split("\n").filter((l) => /修剪|重启|restart/.test(l)).slice(-4).join(" | ")) || "(无相关日志)");

    // ---------- 1b) 反复大量新建 session，验证不会变成重启循环 ----------
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) await H.newSession(PORT, TOKEN);
      await new Promise((r) => setTimeout(r, 8000));
    }
    const stillBounded = await H.waitFor(() => H.clientNodePids(home).length <= CLIENT_MAX, { timeout: 20000, label: "持续超限后仍被压回上限内" });
    H.ok(stillBounded, "持续产生新 session 时进程数被持续压回上限内", `count=${H.clientNodePids(home).length}`);
    H.ok(countRestarts(home) === 0, "累计 38 个 session 的情况下仍未发生重启（无重启循环）", `restarts=${countRestarts(home)}`);

    // ---------- 1c) 持续在用的 session 不应该被修剪掉（按空闲时间裁剪） ----------
    const busy = (await H.newSession(PORT, TOKEN)).sessionId;
    let busyOk = true;
    let busyCalls = 0;
    let busyStop = false;
    const busyLoop = (async () => {
      while (!busyStop) {
        const r = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 77, method: "tools/list" }, busy);
        busyCalls++;
        if (r.status !== 200) busyOk = false;
        await new Promise((r2) => setTimeout(r2, 200));
      }
    })();
    for (let i = 0; i < 12; i++) {
      await H.newSession(PORT, TOKEN);
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 7000));
    busyStop = true;
    await busyLoop;
    H.ok(busyOk && busyCalls >= 20,
      "持续在用的 session 在修剪中存活（按空闲时间裁剪，不掐活跃会话）", `调用 ${busyCalls} 次，全部 200=${busyOk}`);
    const boundedAgain = await H.waitFor(() => H.clientNodePids(home).length <= CLIENT_MAX, { timeout: 20000, label: "空闲 session 被回收" });
    H.ok(boundedAgain, "空闲 session 被回收、进程数回到上限以内", `count=${H.clientNodePids(home).length}`);
    // 修剪稳定后，刚才一直在用的 session 仍应在（没有被误当成闲置会话回收）
    await new Promise((r) => setTimeout(r, 6000));
    const busyAfter = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 78, method: "tools/list" }, busy);
    H.ok(busyAfter.status === 200, "修剪稳定后该 session 依然可用（未被当作闲置会话回收）", `status=${busyAfter.status}`);
    H.ok(countRestarts(home) === 0, "按空闲时间修剪期间依然没有重启整桥", `restarts=${countRestarts(home)}`);

    // ---------- 2) 网关真挂掉：只重启一次 ----------
    const restartsBefore = countRestarts(home);
    for (const pid of H.sgPids(home)) { try { process.kill(Number(pid), "SIGKILL"); } catch (_) {} }
    const recovered = await H.waitFor(async () => (await H.healthz(PORT)) === 200 && H.sgPids(home).length > 0,
      { timeout: 30000, label: "守护重启网关" });
    H.ok(recovered, "supergateway 被 SIGKILL 后守护将其拉起（healthz 恢复 200）");
    await new Promise((r) => setTimeout(r, 12000));
    const restartsAfter = countRestarts(home);
    H.ok(restartsAfter - restartsBefore === 1, "只重启一次，未进入重启循环", `新增 ${restartsAfter - restartsBefore} 次`);
    // 10/10 的 session id 被重新扫描验证
    const fresh = await H.newSession(PORT, TOKEN);
    H.ok(fresh.init.status === 200, "重启后新 session 立即可用");
    const staleForced = await H.waitFor(() => H.clientNodePids(home).length <= CLIENT_MAX, { timeout: 20000, label: "重启后进程数正常" });
    H.ok(staleForced, "重启清掉了旧 session 进程（不再堆积）", `count=${H.clientNodePids(home).length}`);

    // ---------- 3) start.sh 持续失败：退避，不高频重建 ----------
    try { process.kill(ka.pid, "SIGKILL"); } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
    const failScript = "/tmp/bridge-etest/fail-start.sh";
    fs.writeFileSync(failScript, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(failScript, 0o755);
    for (const pid of H.sgPids(home)) { try { process.kill(Number(pid), "SIGKILL"); } catch (_) {} }
    await new Promise((r) => setTimeout(r, 500));
    const logLenBefore = logText(home).length;
    const ka2 = startKeepalive(home, { BRIDGE_START_SCRIPT: failScript, BRIDGE_KEEPALIVE_COOLDOWN: "6" });
    await new Promise((r) => setTimeout(r, 25000));
    const newLog = logText(home).slice(logLenBefore);
    const attempts = (newLog.match(/start\.sh 失败，退避/g) || []).length;
    H.ok(attempts <= 3, "start.sh 持续失败时按 COOLDOWN 退避（25s 内尝试不超过 3 次）", `attempts=${attempts}`);
    try { process.kill(ka2.pid, "SIGKILL"); } catch (_) {}
    H.info(`失败退避日志片段: ${(newLog.split("\n").filter(Boolean).slice(0, 3).join(" | "))}`);
  } catch (e) {
    H.ok(false, "t7 执行未抛异常", String((e && e.stack) || e).slice(0, 300));
  } finally {
    if (ka) { try { process.kill(ka.pid, "SIGKILL"); } catch (_) {} }
    await H.stopBridge(home, PORT).catch(() => {});
    H.info("已执行 stop.sh 清理测试实例");
  }
  process.exit(H.summary("t7"));
})();
