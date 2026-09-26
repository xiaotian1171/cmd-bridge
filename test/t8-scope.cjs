#!/usr/bin/env node
// t8：操作范围与「守护不和手动停止抢重启」
//   1) 同机存在「另一套桥」（同 SCRIPT_DIR、同 npm 前缀，只是 BRIDGE_HOME / 端口不同）
//      以及一个「别人的同名 supergateway 进程」（命令行匹配、但没有本桥身份标记）时：
//      - stop.sh A 只停 A 自己的进程，B 与诱饵进程不受影响
//      - start.sh A（重启）的清理阶段同样不动 B 与诱饵
//   2) 手动 stop.sh 进行中时，keepalive 守护应退出而不是把桥拉回来
//   3) 保留的旧语义（BRIDGE_KILL_LEGACY=1 全量 pkill）会误伤 B —— 演示它为什么默认关闭
//
// 用法: node test/t8-scope.cjs

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const H = require("./harness.cjs");

const A = H.makeHome("t8a");
const B = H.makeHome("t8b");
const PORT_A = 8805;
const PORT_B = 8806;
const TOK_A = "tok-t8a";
const TOK_B = "tok-t8b";
const PREFIX_RE = H.PREFIX.replace(/[][\\.^$*+?(){}|]/g, (m) => "\\" + m);

const enginePids = (h) => H.ownedPids(h, `${PREFIX_RE}/bin/desktop-commander`);
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (_) { return false; } };
const snapshot = (h) => ({ sg: H.sgPids(h), hub: H.hubPids(h), engine: enginePids(h), client: H.clientNodePids(h) });
const describeSnapshot = (s) => Object.entries(s).map(([k, v]) => `${k}=${v.length}`).join(" ");
const allAlive = (s) => Object.entries(s).every(([, pids]) => pids.length > 0 && pids.every(alive));

// 「别人的 supergateway」：命令行匹配 SG_PAT，但不带 BRIDGE_OWNER
function startDecoy() {
  const env = { ...process.env };
  delete env.BRIDGE_OWNER;
  delete env.DC_HUB_SOCK;
  const p = spawn("bash", ["-c", `exec -a ${H.PREFIX}/bin/supergateway sleep 900`], {
    env, detached: true, stdio: "ignore",
  });
  p.unref();
  return p.pid;
}

// 脚本目录（做 ERE 转义），用于拼出「本套脚本自己的 keepalive.sh」匹配式
function SD_RE() {
  return H.COPY.replace(/[][\\\\.^$*+?(){}|]/g, (m) => "\\" + m);
}

const kaLog = (h) => { try { return fs.readFileSync(`${h}/keepalive.log`, "utf8"); } catch (_) { return ""; } };

(async () => {
  let decoy = null;
  let ka = null;
  let prodKa = null;
  let strayPid = null;
  try {
    H.title("t8 操作范围（不误停其它桥/别人的进程）与守护抢重启");
    H.resetHome(A, TOK_A);
    H.resetHome(B, TOK_B);
    await H.startBridge(A, PORT_A);
    await H.startBridge(B, PORT_B);
    H.ok((await H.healthz(PORT_A)) === 200 && (await H.healthz(PORT_B)) === 200, "两套桥（A/B，同目录同 npm 前缀不同 HOME）都就绪");

    await H.newSession(PORT_B, TOK_B);
    await H.waitFor(() => H.clientNodePids(B).length >= 1, { timeout: 10000, label: "B 的 session 转发进程" });
    const snapB = snapshot(B);
    H.ok(snapB.sg.length > 0 && snapB.hub.length > 0 && snapB.engine.length > 0 && snapB.client.length > 0,
      "B 拥有完整的 supergateway/中枢/引擎/session 进程", describeSnapshot(snapB));

    decoy = startDecoy();
    await new Promise((r) => setTimeout(r, 800));
    H.ok(alive(decoy), "诱饵（别人的 supergateway，无身份标记）已在运行", `pid=${decoy}`);

    // ---------- 1) stop.sh A：只停 A ----------
    const stopA = await H.stopBridge(A, PORT_A);
    H.ok(stopA.code === 0, "stop.sh A 正常退出", `code=${stopA.code}`);
    H.ok(!/legacy 全量匹配/.test(stopA.out), "stop.sh A 走的是「按身份」路径而不是全量 pkill");
    const aGone = await H.waitFor(() =>
      H.sgPids(A).length === 0 && H.hubPids(A).length === 0 && enginePids(A).length === 0 && H.clientNodePids(A).length === 0,
      { timeout: 15000, label: "A 的进程清空" });
    H.ok(aGone, "A 自己的 supergateway/中枢/引擎/session 进程全部停止",
      `sg=${H.sgPids(A).length} hub=${H.hubPids(A).length} engine=${enginePids(A).length} client=${H.clientNodePids(A).length}`);
    H.ok(allAlive(snapB), "同机 B 的一套进程全部存活（未被误停）", describeSnapshot(snapB));
    H.ok(alive(decoy), "别人的同名 supergateway 进程存活（未被误停）");
    H.ok((await H.healthz(PORT_B)) === 200, "B 的网关仍然可用（healthz 200）");
    const bCall = await H.mcpPost(PORT_B, TOK_B, { jsonrpc: "2.0", id: 2, method: "tools/list" },
      (await H.newSession(PORT_B, TOK_B)).sessionId);
    H.ok(bCall.status === 200, "stop.sh A 之后 B 仍能建会话并工具列表", `status=${bCall.status}`);

    // ---------- 2) start.sh A 的清理阶段不动 B ----------
    await H.startBridge(A, PORT_A);
    H.ok((await H.healthz(PORT_A)) === 200, "A 重新启动并就绪");
    H.ok(allAlive(snapB), "A 启动时的清理阶段没有误停 B 的进程", describeSnapshot(snapB));
    H.ok(alive(decoy), "A 启动时的清理阶段没有误停别人的同名进程");

    // ---------- 3) keepalive 不与手动停止抢重启 ----------
    ka = spawn("bash", [path.join(H.COPY, "keepalive.sh")], {
      env: H.baseEnv(A, PORT_A, { BRIDGE_KEEPALIVE_COOLDOWN: "5" }),
      detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    ka.unref();
    await new Promise((r) => setTimeout(r, 4000));
    H.ok(alive(ka.pid), "keepalive 守护已启动");
    const kaBefore = alive(ka.pid);
    const stopAgain = await H.stopBridge(A, PORT_A);
    H.ok(stopAgain.code === 0, "手动 stop.sh 正常退出", `code=${stopAgain.code}`);
    await new Promise((r) => setTimeout(r, 20000));
    H.ok(!alive(ka.pid), "手动停止期间守护进程已退出，没有继续守护");
    H.ok(H.sgPids(A).length === 0, "手动停止后 20s 内没有出现新的网关进程（守护没有抢着重启）",
      `sg=${H.sgPids(A).length}`);
    H.ok(/stopping 标志/.test(kaLog(A)), "守护日志记录了「检测到 stopping 标志」");
    H.ok(!/restarting/.test(kaLog(A).split("\n").slice(-3).join("\n")) , "守护最后阶段没有执行重启动作");
    H.ok(allAlive(snapB) && alive(decoy), "这段期间 B 与诱饵进程仍然存活");

    // ---------- 4) 旧语义（全量 pkill）会误伤同机其它桥：演示为什么默认关闭 ----------
    const legacyStop = await H.run(path.join(H.COPY, "stop.sh"), [], H.baseEnv(A, PORT_A, { BRIDGE_KILL_LEGACY: "1" }));
    H.ok(/legacy 全量匹配/.test(legacyStop.out), "BRIDGE_KILL_LEGACY=1 时确实回退到了全量 pkill 语义");
    const collateral = await H.waitFor(() => !alive(decoy) && H.sgPids(B).length === 0,
      { timeout: 10000, label: "legacy 语义的连带影响" });
    H.ok(collateral, "（反证）全量 pkill 会连带杀掉别人的同名进程与同机 B 的网关，所以默认必须为 0");
    // ---------- 5) 守护自身的身份标记（生产启动方式：环境里没有 BRIDGE_*）----------
    // 线上是 `setsid nohup bash keepalive.sh`，环境里没有任何 BRIDGE_ 变量。
    // /proc/<pid>/environ 只反映 exec 时刻的环境，脚本内部 export 不会出现在守护
    // 自己的 environ 里，所以必须靠守护自我 re-exec 才能被 stop.sh 精确识别。
    H.title("生产启动方式下的守护身份（environ 里没有 BRIDGE_*）");
    const KA_HOME = "/tmp/bridge-test-t8-ka";
    const KA_BRIDGE = `${KA_HOME}/.bridge`;
    const KA_PORT = 8811;
    fs.rmSync(KA_HOME, { recursive: true, force: true });
    fs.mkdirSync(KA_BRIDGE, { recursive: true });
    const kaProd = spawn("bash", [path.join(H.COPY, "keepalive.sh")], {
      env: { PATH: process.env.PATH, HOME: KA_HOME, BRIDGE_PORT: String(KA_PORT) },
      detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    kaProd.unref();
    prodKa = kaProd.pid;
    await H.waitFor(() => alive(kaProd.pid), { timeout: 5000, label: "生产方式的守护" });
    await new Promise((r) => setTimeout(r, 1500));
    const kaEnv = (() => {
      try { return fs.readFileSync(`/proc/${kaProd.pid}/environ`, "utf8"); } catch (_) { return ""; }
    })();
    H.ok(kaEnv.split("\0").includes(`BRIDGE_OWNER=${KA_BRIDGE}`),
      "守护自身 environ 里带着 BRIDGE_OWNER（自我 re-exec 生效）",
      `pid=${kaProd.pid}`);
    const kaOwned = H.ownedPids(KA_BRIDGE, `${SD_RE()}/keepalive\\.sh`);
    H.ok(kaOwned.includes(String(kaProd.pid)), "stop.sh 的 owned 口径能认出这个守护（不再只能靠旧实例推断）",
      `owned=${kaOwned}`);
    const kaStop = await H.run(path.join(H.COPY, "stop.sh"), [],
      { ...process.env, HOME: KA_HOME, BRIDGE_HOME: KA_BRIDGE, BRIDGE_PORT: String(KA_PORT) });
    H.ok(kaStop.code === 0 && /已停止/.test(kaStop.out),
      "stop.sh 按身份停止了这个守护（输出里有「已停止」）",
      `code=${kaStop.code} out=${kaStop.out.split("\n").find((l) => l.includes("keepalive") || l.includes("已停止")) || ""}`);
    const kaGone = await H.waitFor(() => !alive(kaProd.pid), { timeout: 15000, label: "守护退出" });
    H.ok(kaGone, "生产方式启动的守护已被停掉（首切后不会留下停不掉的旧守护）", `pid=${kaProd.pid}`);

    // 改造前启动的守护：命令行匹配、但没有任何标记。凭本桥独占资源无法判定归属，
    // stop.sh 只能提示人工确认，绝不能误杀（万一它其实是同机另一套桥的守护）。
    const stray = spawn("bash", ["-c", `exec -a ${path.join(H.COPY, "keepalive.sh")} sleep 900`], {
      env: { PATH: process.env.PATH, HOME: "/tmp/bridge-test-t8-stray" }, detached: true, stdio: "ignore",
    });
    stray.unref();
    strayPid = stray.pid;
    await new Promise((r) => setTimeout(r, 800));
    H.ok(alive(strayPid), "无标记守护（模拟改造前启动）已在运行", `pid=${strayPid}`);
    const stopStray = await H.run(path.join(H.COPY, "stop.sh"), [],
      { ...process.env, HOME: KA_HOME, BRIDGE_HOME: KA_BRIDGE, BRIDGE_PORT: String(KA_PORT) });
    H.ok(/警告/.test(stopStray.out) && stopStray.out.includes(String(strayPid)),
      "stop.sh 提示「无法判定归属的守护进程」并要求人工确认");
    H.ok(alive(strayPid), "无标记守护没有被误杀（首切时需人工确认后停掉）");
  } catch (e) {
    H.ok(false, "t8 执行未抛异常", String((e && e.stack) || e).slice(0, 300));
  } finally {
    if (ka) { try { process.kill(ka.pid, "SIGKILL"); } catch (_) {} }
    if (prodKa) { try { process.kill(prodKa, "SIGKILL"); } catch (_) {} }
    if (strayPid) { try { process.kill(strayPid, "SIGKILL"); } catch (_) {} }
    if (decoy) { try { process.kill(Number(decoy), "SIGKILL"); } catch (_) {} }
    await H.stopBridge(A, PORT_A).catch(() => {});
    await H.stopBridge(B, PORT_B).catch(() => {});
    H.info("已用 stop.sh 清理 A/B 两套测试实例并杀掉诱饵进程");
  }
  process.exit(H.summary("t8"));
})();
