#!/usr/bin/env node
// t6：会话过期验证（用 3s 超时模拟 30 分钟设置）
//
// 覆盖三件事：
//   a) 协议层：session 过期后用旧 session ID 调用，网关返回什么（状态码 / 错误码）
//   b) 恢复：过期后能否重新 initialize；「复用旧 session ID 重连」这条路径能否恢复
//   c) 真实 SDK 客户端（ChatGPT 连接器 / Operit 同源实现）行为：
//      - 连接保持、持有 SSE GET 流的客户端，session 会不会被回收
//      - 客户端断开后带旧 session ID 重连时的表现
//
// 用法: node test/t6-session-expiry.cjs

const fs = require("fs");
const H = require("./harness.cjs");

const TAG = "t6";
const PORT = 8801;
const TOKEN = "tok-" + TAG;
const TTL = 3000;

const sgLog = (home) => { try { return fs.readFileSync(`${home}/logs/sg.log`, "utf8"); } catch (_) { return ""; } };

(async () => {
  const home = H.makeHome(TAG);
  try {
    H.title(`t6 会话过期（sessionTimeout=${TTL}ms，模拟 30 分钟设置）`);
    H.resetHome(home, TOKEN);
    await H.startBridge(home, PORT, { BRIDGE_SESSION_TIMEOUT: String(TTL) });
    H.ok((await H.waitFor(async () => (await H.healthz(PORT)) === 200, { label: "healthz" })), "桥启动并就绪（healthz 200）");

    // ---------- a) 协议层：过期 session 的表现 ----------
    const s1 = await H.newSession(PORT, TOKEN);
    H.ok(s1.init.status === 200 && !!s1.sessionId, "initialize 建立 session", `status=${s1.init.status}`);
    const list1 = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s1.sessionId);
    H.ok(list1.status === 200 && (list1.json.result.tools || []).length > 0, "session 内 tools/list 正常");
    const beforeCount = H.clientNodePids(home).length;

    H.info(`放置 ${TTL * 2}ms（期间无任何请求、无 SSE 流保持）...`);
    await new Promise((r) => setTimeout(r, TTL * 2));

    const stale = await H.mcpPost(PORT, TOKEN, { jsonrpc: "2.0", id: 3, method: "tools/list" }, s1.sessionId);
    const staleCode = stale.json && stale.json.error ? stale.json.error.code : null;
    H.info(`过期 session 调用: HTTP ${stale.status} code=${staleCode} body=${(stale.text || "").slice(0, 140).replace(/\s+/g, " ")}`);
    H.ok(stale.status === 400 && staleCode === -32000, "过期 session 被拒绝（记为 400 / -32000，非规范建议的 404 / -32001）");

    const expiredCleaned = await H.waitFor(() => H.clientNodePids(home).length < beforeCount, { timeout: 8000, label: "过期 session 被回收" });
    H.ok(expiredCleaned, "过期后该 session 的转发进程被回收（进程数下降）", `${beforeCount} -> ${H.clientNodePids(home).length}`);

    // ---------- b) 重新初始化 / 复用旧 session ID 重连 ----------
    const s2 = await H.newSession(PORT, TOKEN);
    H.ok(s2.init.status === 200 && !!s2.sessionId && s2.sessionId !== s1.sessionId, "过期后可重新 initialize 并拿到新 session");

    let resumeErr = "", resumeOk = false;
    try {
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([H.sdkLoad(), H.transportLoad()]);
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${TOKEN}`), { sessionId: s1.sessionId });
      const client = new Client({ name: "resume-test", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);          // sessionId 已设置 -> 跳过 initialize（「重连」语义）
      const t = await client.listTools();
      resumeOk = (t.tools || []).length > 0;
      await client.close().catch(() => {});
    } catch (e) { resumeErr = String((e && e.message) || e).slice(0, 160); }
    H.ok(!resumeOk, "带旧 session ID 的「重连」路径无法自愈（暴露出客户端侧错误）", resumeOk ? "居然成功了" : resumeErr);
    H.info(`复用旧 session 重连的报错: ${resumeErr || "(无)"}`);

    // ---------- c) 保持连接的客户端不会被超时回收 ----------
    const { client: live } = await H.sdkConnect(PORT, TOKEN);
    await live.listTools();
    const liveSessionBefore = sgLog(home);
    await new Promise((r) => setTimeout(r, TTL * 2));
    let liveStillOk = false;
    try { liveStillOk = (await live.listTools()).tools.length > 0; } catch (_) { liveStillOk = false; }
    const hasGetStream = /GET request for existing session/.test(sgLog(home));
    H.ok(liveStillOk, "持有 SSE 流的在线客户端不受 sessionTimeout 影响（仍可用）");
    H.ok(hasGetStream, "证据：sg.log 记录了 GET 流保持（access count 因此不归零）");
    await live.close().catch(() => {});

    console.log("\n------ t6 结论数据 ------");
    console.log(JSON.stringify({
      sessionTimeoutMs: TTL,
      expiredSession: { httpStatus: stale.status, errorCode: staleCode },
      expiredSessionProcessRecycled: expiredCleaned,
      reinitializeWorks: s2.init.status === 200,
      resumeWithOldSessionIdWorks: resumeOk,
      resumeError: resumeErr || null,
      connectedClientUnaffectedByTimeout: liveStillOk,
    }, null, 2));
  } catch (e) {
    H.ok(false, "t6 执行未抛异常", String((e && e.stack) || e).slice(0, 300));
  } finally {
    await H.stopBridge(home, PORT).catch(() => {});
    H.info("已执行 stop.sh 清理测试实例");
  }
  process.exit(H.summary("t6"));
})();
