// supergateway 崩溃护栏（由 start.sh 通过 `node -r` 预加载）
//
// 现象：MCP 客户端断开连接时，supergateway 内部会出现未处理的异步异常
// （典型为 unhandledRejection: "No connection established for request ID: n"），
// Node.js 的默认策略是直接退出整个进程——一次普通的客户端断开就会杀死对
// 其他客户端仍然可用的桥。
//
// 本文件把这两类异常记录下来，默认不退出进程，保证一次客户端断开不会拖垮
// 整个桥。但要区分两种情况：
//   1) 已知可恢复（客户端/流已关闭导致的写失败）——降噪记录，不退出；
//   2) 其他未知异常——说明进程可能已处于不一致状态，默认仍保留进程（与旧行为
//      一致），可设 SG_HOOK_EXIT_ON_UNCAUGHT=1 改为记录后退出，交由 keepalive
//      快速重建，避免“半死”进程继续对外服务。
//
// 环境变量：
//   SG_HOOK_EXIT_ON_UNCAUGHT=1    未知未捕获异常时退出（默认 0，保留进程）
//   SG_HOOK_THROTTLE_MS           同类错误日志节流窗口（默认 60000）
//   SG_HOOK_VERBOSE=1             每次都打印完整堆栈（默认只在首次/窗口末打印）

const EXIT_ON_UNCAUGHT = process.env.SG_HOOK_EXIT_ON_UNCAUGHT === "1";
const VERBOSE = process.env.SG_HOOK_VERBOSE === "1";
const THROTTLE_MS = Number(process.env.SG_HOOK_THROTTLE_MS || 60000);

// 客户端断开引发的、可安全忽略的写失败模式
const RECOVERABLE = [
  /No connection established for request ID/,
  /write after end/i,
  /EPIPE/,
  /ECONNRESET/,
  /ERR_STREAM_DESTROYED/,
  /Cannot write to a closed/i,
];

const seen = new Map(); // key -> { count, firstAt, lastLoggedAt }

function isRecoverable(err) {
  const s = String((err && err.message) || err || "");
  return RECOVERABLE.some((re) => re.test(s));
}

function signature(err) {
  const s = String((err && (err.message || err.stack)) || err || "");
  return s.split("\n")[0].slice(0, 160) || "unknown";
}

function report(kind, err) {
  const recoverable = isRecoverable(err);
  const key = kind + "::" + signature(err);
  const now = Date.now();
  let rec = seen.get(key);
  if (!rec) {
    rec = { count: 0, firstAt: now, lastLoggedAt: 0 };
    seen.set(key, rec);
  }
  rec.count++;

  const shouldLog =
    VERBOSE ||
    rec.lastLoggedAt === 0 ||
    now - rec.lastLoggedAt >= THROTTLE_MS;
  if (!shouldLog) return;
  rec.lastLoggedAt = now;

  const detail = VERBOSE || rec.count === 1 ? ((err && err.stack) || err) : signature(err);
  console.error(
    `[sg-hook] ${kind} ${recoverable ? "recoverable" : "UNEXPECTED"}` +
    ` (累计 ${rec.count} 次，本窗口末次): ${detail}`
  );

  if (!recoverable && EXIT_ON_UNCAUGHT) {
    console.error("[sg-hook] SG_HOOK_EXIT_ON_UNCAUGHT=1，未知异常，退出进程交由 keepalive 重建");
    process.exit(1);
  }
}

process.on("uncaughtException", (e) => {
  report("uncaughtException", e);
});
process.on("unhandledRejection", (e) => {
  report("unhandledRejection", e);
});
