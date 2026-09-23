#!/usr/bin/env node
// dc-hub-client.cjs —— supergateway 每个 MCP session 的轻量 stdio↔socket 桥
//
// 真正的桌面引擎由常驻单例 dc-hub.cjs 持有，本文件只做管道转发，
// 每个 session 的内存开销从 ~130MB 降到几十 MB 量级。
// 中枢缺席时（被清理或崩溃），本文件会按 DC_HUB_CMD 自行拉起一次再重连，
// 避免必须重启整个桥才能恢复。
//
// 用法（由 start.sh 作为 supergateway 的 --stdio 命令启动）。

const net = require("net");
const { spawn } = require("child_process");

const sock = process.env.DC_HUB_SOCK || ((process.env.HOME || "/root") + "/.bridge/dc-hub.sock");
let revived = false;

function attach(conn) {
  process.stdin.pipe(conn, { end: false });
  conn.pipe(process.stdout, { end: false });
}

function connect() {
  const conn = net.connect(sock);
  conn.on("connect", () => attach(conn));
  conn.on("close", () => process.exit(0));
  conn.on("error", (e) => {
    if (!revived && process.env.DC_HUB_CMD) {
      revived = true;
      try {
        spawn("/bin/sh", ["-c", process.env.DC_HUB_CMD], { detached: true, stdio: "ignore" }).unref();
      } catch (_) { /* 拉不起来就按失败处理 */ }
      setTimeout(connect, 2000);
      return;
    }
    console.error("[dc-hub-client] " + e.message);
    process.exit(1);
  });
}

process.stdin.on("end", () => process.exit(0));
connect();
