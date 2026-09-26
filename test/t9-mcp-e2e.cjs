#!/usr/bin/env node
// t9：真正可用（不是「端口活着」）——完整 MCP 链路 + 中枢退出/恢复
//   1) initialize -> tools/list -> tools/call（读/写/执行）
//   2) 长任务 start_process -> read_process_output（按游标读增量）
//   3) 中枢（dc-hub）被强杀：在途请求得到明确 -32603 错误（不挂死），中枢被自动拉起
//   4) 恢复后：新老 session 都还能用；新的长任务能继续；旧任务的句柄明确报「找不到」，
//      不会伪造成功
//
// 用法: node test/t9-mcp-e2e.cjs

const fs = require("fs");
const H = require("./harness.cjs");

const TAG = "t9";
const HOME = H.makeHome(TAG);
const PORT = 8807;
const TOKEN = "tok-" + TAG;

const hubAlive = (h) => H.hubPids(h).length > 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyJson = (r) => { try { return JSON.parse(r.json.result.content[0].text); } catch (_) { return null; } };

(async () => {
  try {
    H.title("t9 完整 MCP 链路与中枢退出/恢复");
    H.resetHome(HOME, TOKEN);
    await H.startBridge(HOME, PORT);
    H.ok((await H.healthz(PORT)) === 200, "桥启动并就绪（healthz 200）");
    H.ok(H.hubPids(HOME).length === 1, "中枢进程唯一（单例）", `hub=${H.hubPids(HOME).length}`);

    // ---------- 1) 完整链路 ----------
    const s = await H.newSession(PORT, TOKEN);
    H.ok(s.init.status === 200 && !!s.init.json.result.serverInfo, "initialize 成功并返回 serverInfo",
      `status=${s.init.status}`);
    const tl = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s.sessionId);
    const toolNames = ((tl.json || {}).result || {}).tools ? tl.json.result.tools.map((t) => t.name) : [];
    H.ok(tl.status === 200 && toolNames.includes("read_file") && toolNames.includes("start_process"),
      "tools/list 成功且工具齐全", `工具数=${toolNames.length}`);
    H.ok(!tl.json.result.tools.some((t) => t._meta !== undefined),
      "工具 _meta 已被兼容层剥离（ChatGPT 兼容）");

    const rf = await H.callTool(PORT, TOKEN, s.sessionId, "read_file", { path: "/tmp/x.txt" }, 3);
    H.ok(rf.status === 200 && /READ\(/.test(H.toolText(rf) || ""), "tools/call read_file 成功", `status=${rf.status}`);
    const wf = await H.callTool(PORT, TOKEN, s.sessionId, "write_file", { path: "/tmp/x.txt", content: "hi" }, 4);
    H.ok(wf.status === 200 && /WROTE\(/.test(H.toolText(wf) || ""), "tools/call write_file 成功", `status=${wf.status}`);
    const ec = await H.callTool(PORT, TOKEN, s.sessionId, "execute_command", { command: "echo hello" }, 5);
    H.ok(ec.status === 200 && /EXEC\(/.test(H.toolText(ec) || ""), "tools/call execute_command 成功", `status=${ec.status}`);

    // ---------- 2) 长任务 ----------
    const sp = await H.callTool(PORT, TOKEN, s.sessionId, "start_process",
      { command: "echo tick1; sleep 3; echo tick2" }, 6);
    const spInfo = bodyJson(sp) || {};
    H.ok(sp.status === 200 && spInfo.pid, "start_process 返回长任务 pid", `pid=${spInfo.pid}`);
    const r1 = bodyJson(await H.callTool(PORT, TOKEN, s.sessionId, "read_process_output", { pid: spInfo.pid }, 7)) || {};
    H.ok(/tick1/.test(r1.output || ""), "read_process_output 读到首批输出", JSON.stringify(r1.output));
    await sleep(3500);
    const r2 = bodyJson(await H.callTool(PORT, TOKEN, s.sessionId, "read_process_output", { pid: spInfo.pid }, 8)) || {};
    H.ok(/tick2/.test(r2.output || "") && r2.isRunning === false,
      "游标增量读取到后续输出且任务已结束", `output=${JSON.stringify(r2.output)} isRunning=${r2.isRunning}`);

    // ---------- 3) 中枢被强杀：在途请求不挂死 + 自动拉起 ----------
    const hubPid = Number(H.hubPids(HOME)[0]);
    process.kill(hubPid, "SIGSTOP");
    const t0 = Date.now();
    const inFlight = H.mcpPost(PORT, TOKEN, {
      jsonrpc: "2.0", id: 55, method: "tools/call",
      params: { name: "execute_command", arguments: { command: "echo never" } },
    }, s.sessionId, 15000);
    await sleep(1500);
    process.kill(hubPid, "SIGKILL");
    const rInFlight = await inFlight;
    const elapsed = Date.now() - t0;
    const code = rInFlight.json && rInFlight.json.error ? rInFlight.json.error.code : null;
    H.ok(!rInFlight.aborted && elapsed < 14000, "中枢断开时在途请求没有被无限挂住（超时前返回）", `耗时=${elapsed}ms`);
    H.ok(rInFlight.status === 200 && code === -32603,
      "在途请求收到明确的 -32603 错误（客户端可安全重试）", `status=${rInFlight.status} code=${code}`);

    const hubBack = await H.waitFor(() => hubAlive(HOME), { timeout: 30000, label: "中枢被自动拉起" });
    H.ok(hubBack, "会话侧自动把中枢拉回来了（无需人工干预）");
    await H.waitFor(() => H.hubPids(HOME).length === 1, { timeout: 10000, label: "中枢单例" });
    H.ok(H.hubPids(HOME).length === 1, "拉起后中枢仍然只有一份（文件锁生效）", `hub=${H.hubPids(HOME).length}`);

    // ---------- 4) 恢复之后 ----------
    const s2 = await H.newSession(PORT, TOKEN);
    H.ok(s2.init.status === 200, "恢复后可以建立新 session");
    const tl2 = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 9, method: "tools/list" }, s.sessionId);
    H.ok(tl2.status === 200, "恢复后老 session 依然可用", `status=${tl2.status}`);

    // 引擎重启后，旧的长任务句柄必须明确报「找不到」：引擎的任务表在内存里，
    // 随引擎一起消失，不能假装还能读到（在真引擎上同样是新引擎不认识旧 pid）
    const old = await H.callTool(PORT, TOKEN, s.sessionId, "read_process_output", { pid: spInfo.pid }, 12);
    const oldBody = bodyJson(old);
    H.ok(old.status !== 200 || !oldBody || oldBody.found === false || !!old.json.error,
      "中枢重启后旧任务句柄明确失败（不会伪造成功）",
      `status=${old.status} found=${oldBody ? oldBody.found : "n/a"}`);

    const sp2 = await H.callTool(PORT, TOKEN, s.sessionId, "start_process",
      { command: "echo after-restart; sleep 1; echo done" }, 10);
    const sp2Info = bodyJson(sp2) || {};
    H.ok(sp2.status === 200 && sp2Info.pid, "恢复后仍可启动新的长任务", `pid=${sp2Info.pid}`);
    await sleep(1800);
    const r3 = bodyJson(await H.callTool(PORT, TOKEN, s.sessionId, "read_process_output", { pid: sp2Info.pid }, 11)) || {};
    H.ok(/after-restart/.test(r3.output || "") && /done/.test(r3.output || ""),
      "恢复后长任务 start_process -> read_process_output 继续可用", `output=${JSON.stringify(r3.output)}`);

    H.ok((await H.healthz(PORT)) === 200, "整条链路在恢复后仍然健康（healthz 200）");
  } catch (e) {
    H.ok(false, "t9 执行未抛异常", String((e && e.stack) || e).slice(0, 300));
  } finally {
    await H.stopBridge(HOME, PORT).catch(() => {});
    H.info("已用 stop.sh 清理测试实例");
  }
  process.exit(H.summary("t9"));
})();
