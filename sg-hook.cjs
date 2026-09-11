// supergateway 3.4.3 崩溃护栏（由 start.sh 通过 `node -r` 预加载）
//
// 现象：MCP 客户端断开连接时，supergateway 内部会出现未处理的异步异常
// （典型为 unhandledRejection: "No connection established for request ID: n"），
// Node.js 的默认策略是直接退出整个进程——一次普通的客户端断开就会杀死对
// 其他客户端仍然可用的桥。
//
// 本文件把这两类异常记录到日志（[sg-hook] 前缀）后吞掉，进程继续存活。
// 若在日志中频繁看到同一条异常，说明上游有更深层问题，欢迎提 issue。
process.on("uncaughtException", (e) => {
  console.error("[sg-hook] uncaughtException kept-alive:", (e && e.stack) || e);
});
process.on("unhandledRejection", (e) => {
  console.error("[sg-hook] unhandledRejection kept-alive:", (e && (e.stack || e)) || e);
});
