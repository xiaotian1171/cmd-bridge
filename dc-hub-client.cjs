#!/usr/bin/env node
// dc-hub-client.cjs —— supergateway 每个 MCP session 的轻量 stdio↔socket 桥
//
// 真正的桌面引擎由常驻单例 dc-hub.cjs 持有，本文件只做管道转发，
// 每个 session 的内存开销从 ~130MB 降到几十 MB 量级。
//
// 注意：这个进程由 supergateway 按 session 启动，它的生命周期由上游决定
// （session 结束时会 child.kill()）。因此本进程**不能因为 socket 断开就退出**：
// 一旦退出，supergateway 侧该 session 的请求会永远拿不到响应，客户端表现为
// -32603 / 请求挂死。正确行为是保持存活并持续重连，直到上游把它杀掉。
//
// 可靠性设计：
//   1. 连接失败（中枢没起来/被清理）与已连接后断开，都进入重连，不退出；
//   2. 指数退避 + 抖动，避免多 session 同时重连造成惊群；
//   3. 重试有上限（默认 20 次），超过后退出并把控制权交回 supergateway；
//   4. 只在首次失败时尝试拉起中枢，并用文件锁保证多个 client 并发时只拉起一份；
//   5. 未连上期间缓冲客户端请求，连上后按序补发，不丢 initialize；
//   6. 重连前清理旧连接监听与管道，避免监听器/管道泄漏；
//   7. 已发出但还没拿到响应的「在途请求」在连接中断时，主动回 -32603 错误，
//      而不是让客户端一直挂到超时（客户端收到明确错误后可安全重试）。
//
// 可用环境变量（一般无需设置）：
//   DC_HUB_SOCK                   中枢 socket 路径
//   DC_HUB_CMD                    中枢拉起命令（缺省则不自动拉起）
//   DC_HUB_CLIENT_MAX_RETRIES     连续重连上限，0 = 无限（默认 20）
//   DC_HUB_CLIENT_BASE_DELAY_MS   退避基数（默认 500）
//   DC_HUB_CLIENT_MAX_DELAY_MS    退避上限（默认 15000）
//   DC_HUB_CLIENT_MAX_BACKLOG     未连接期间最大缓冲请求数（默认 256）
//
// 用法（由 start.sh 作为 supergateway 的 --stdio 命令启动）。

const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const sock = process.env.DC_HUB_SOCK || ((process.env.HOME || "/root") + "/.bridge/dc-hub.sock");

const MAX_RETRIES = Number(process.env.DC_HUB_CLIENT_MAX_RETRIES || 20);
const BASE_DELAY = Number(process.env.DC_HUB_CLIENT_BASE_DELAY_MS || 500);
const MAX_DELAY = Number(process.env.DC_HUB_CLIENT_MAX_DELAY_MS || 15000);
const MAX_BACKLOG = Number(process.env.DC_HUB_CLIENT_MAX_BACKLOG || 256);
const SPAWN_LOCK = sock + ".spawn.lock";
const SPAWN_LOCK_STALE_MS = Number(process.env.DC_HUB_CLIENT_SPAWN_LOCK_STALE_MS || 60000);

// 活动标记：守护进程（keepalive.sh）按 session 数修剪配额时，用它判断「谁最久没活动」，
// 保证被掐掉的是闲置会话，而不是正在使用的那一个。每转发一条消息刷新一次。
const ACTIVITY_DIR = path.join(path.dirname(sock), "activity");
const ACTIVITY_FILE = path.join(ACTIVITY_DIR, String(process.pid) + ".act");

function touchActivity() {
  const now = new Date();
  try {
    fs.utimesSync(ACTIVITY_FILE, now, now);
  } catch (_) {
    try {
      fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
      fs.writeFileSync(ACTIVITY_FILE, "");
    } catch (_) { /* 活动标记只是尽力而为，失败不影响转发 */ }
  }
}

function dropActivity() {
  try { fs.unlinkSync(ACTIVITY_FILE); } catch (_) {}
}

let conn = null;
let attached = false;
let retries = 0;
let stdinEnded = false;
let shuttingDown = false;

// 未连上中枢期间，把客户端请求暂存起来，连上后按序补发
const backlog = [];

// 已发出、还没拿到响应的请求 id：连接断掉时给它们回明确错误，避免客户端挂死
const pendingIds = new Set();
let stdinBuf = "";
let hubBuf = "";
const MAX_BUF = 1024 * 1024;

// 从文本里抽出请求（带 id + method）的 id
function extractIds(text) {
  const ids = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let m; try { m = JSON.parse(t); } catch (_) { continue; }
    for (const it of Array.isArray(m) ? m : [m]) {
      if (it && typeof it === "object" && it.id !== undefined && it.id !== null && typeof it.method === "string") {
        ids.push(String(it.id));
      }
    }
  }
  return ids;
}

// 只有「真的写给了中枢」的请求才登记为在途：还在 backlog 里等重连的请求不算，
// 它们会被补发，不应该在重连过程中被回错误。
function recordAttachedRequests(chunk) {
  stdinBuf += chunk.toString("utf8");
  let i;
  while ((i = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, i);
    stdinBuf = stdinBuf.slice(i + 1);
    for (const id of extractIds(line)) pendingIds.add(id);
  }
  if (stdinBuf.length > MAX_BUF) stdinBuf = "";
}

// 从中枢回包里去掉已完成的 request id；整行才解析，避免把跨包的行解析坏
function trackResponses(chunk) {
  hubBuf += chunk.toString("utf8");
  let i;
  while ((i = hubBuf.indexOf("\n")) >= 0) {
    const line = hubBuf.slice(0, i);
    hubBuf = hubBuf.slice(i + 1);
    const t = line.trim();
    if (!t) continue;
    let m; try { m = JSON.parse(t); } catch (_) { continue; }
    for (const it of Array.isArray(m) ? m : [m]) {
      if (it && typeof it === "object" && it.id !== undefined && it.id !== null &&
          (it.result !== undefined || it.error !== undefined)) {
        pendingIds.delete(String(it.id));
      }
    }
  }
  if (hubBuf.length > MAX_BUF) hubBuf = "";
}

function failPending(reason) {
  if (pendingIds.size === 0) return;
  const n = pendingIds.size;
  let out = "";
  for (const id of pendingIds) {
    const raw = /^-?\d+$/.test(id) ? Number(id) : id;
    out += JSON.stringify({
      jsonrpc: "2.0", id: raw,
      error: { code: -32603, message: "Internal error: " + reason },
    }) + "\n";
  }
  pendingIds.clear();
  try { process.stdout.write(out); } catch (_) {}
  console.error(`[dc-hub-client] 中枢连接中断，已为 ${n} 个在途请求回 -32603（客户端可安全重试）`);
}

process.stdin.on("data", (chunk) => {
  touchActivity();
  if (attached && conn && !conn.destroyed) {
    recordAttachedRequests(chunk);
    conn.write(chunk);
    return;
  }
  backlog.push(chunk);
  if (backlog.length > MAX_BACKLOG) backlog.shift();
});
const onStdinDone = () => { stdinEnded = true; shutdown(0); };
process.stdin.on("end", onStdinDone);
process.stdin.on("error", onStdinDone);

function backoffDelay() {
  const raw = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(2, Math.max(0, retries - 1)));
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(raw + jitter));
}

// 多个 client 同时发现中枢故障时，只允许一个去拉起中枢。
// 用 O_CREAT|O_EXCL 文件锁；锁过期（默认 60s）视为 stale，可被抢占。
function tryReviveHub() {
  const nodeBin = process.env.DC_HUB_NODE;
  const hubScript = process.env.DC_HUB_SCRIPT;
  const engineCmd = process.env.DC_HUB_ENGINE;
  const hubCmd = process.env.DC_HUB_CMD;
  const hasArgv = !!(nodeBin && hubScript && engineCmd);
  if (!hasArgv && !hubCmd) return;

  let fd;
  try {
    fd = fs.openSync(SPAWN_LOCK, "wx");
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        const st = fs.statSync(SPAWN_LOCK);
        if (Date.now() - st.mtimeMs > SPAWN_LOCK_STALE_MS) {
          fs.unlinkSync(SPAWN_LOCK);
          fd = fs.openSync(SPAWN_LOCK, "wx");
        }
      } catch (_) { /* 抢占失败就放弃，交给持锁者 */ }
    }
  }
  if (fd === undefined) {
    console.error("[dc-hub-client] 中枢拉起已由其他客户端负责，跳过");
    return;
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (_) {}
  try {
    if (hasArgv) {
      // 优先按参数直接拉起（start.sh 会导出这三个变量）：不多留一层 sh，
      // 否则那个 sh 的命令行里也含 dc-hub.cjs，会被当成第二个中枢。
      spawn(nodeBin, [hubScript, "--", "sh", "-c", engineCmd], { detached: true, stdio: "ignore" }).unref();
    } else {
      // 只有字符串命令时（例如测试或自定义 DC_HUB_CMD）：简单命令用 exec 让 sh
      // 自我替换成中枢；含 ; & | 的复合命令保持 sh 包装，不能盲加 exec。
      const simple = !/[;&|><`$()]/.test(hubCmd) && !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(hubCmd);
      spawn("/bin/sh", ["-c", (simple ? "exec " : "") + hubCmd], { detached: true, stdio: "ignore" }).unref();
    }
    console.error("[dc-hub-client] 已拉起引擎中枢");
  } catch (e) {
    console.error("[dc-hub-client] 拉起中枢失败: " + e.message);
    try { fs.unlinkSync(SPAWN_LOCK); } catch (_) {}
  }
}

function cleanupConn() {
  if (!conn) return;
  try { conn.removeAllListeners("data"); } catch (_) {}
  try { conn.unpipe(process.stdout); } catch (_) {}
  try { conn.removeAllListeners(); } catch (_) {}
  try { if (!conn.destroyed) conn.destroy(); } catch (_) {}
  conn = null;
  attached = false;
  hubBuf = "";
}

function scheduleReconnect(reason) {
  if (shuttingDown || stdinEnded) return;
  cleanupConn();
  // 在途请求不会自己回来：立刻回明确错误，别让客户端等到超时
  failPending("engine hub connection lost, retry the request");

  if (MAX_RETRIES > 0 && retries >= MAX_RETRIES) {
    console.error(`[dc-hub-client] 连续 ${retries} 次重连失败（${reason}），退出交给上游重建`);
    process.exit(1);
  }
  retries++;
  // 第一次连不上、以及之后每隔几次重试，都尝试把中枢拉起来（文件锁保证只拉一份）；
  // 中枢被外部杀掉时，光靠「从未连上过」的判定不会触发拉起，会话侧会一直连不上。
  if (retries === 1 || retries % 4 === 0) tryReviveHub();
  const delay = backoffDelay();
  console.error(`[dc-hub-client] ${reason}，${delay}ms 后进行第 ${retries} 次重连`);
  setTimeout(connect, delay);
}

function connect() {
  if (shuttingDown || stdinEnded) return;
  const c = net.connect(sock);
  conn = c;

  c.on("connect", () => {
    if (shuttingDown || stdinEnded) return;
    attached = true;
    retries = 0;
    touchActivity();
    // 不能用 c.pipe：要同时观察回包里的 request id（用于判断在途请求是否完成）
    c.on("data", (d) => {
      trackResponses(d);
      try { process.stdout.write(d); } catch (_) {}
    });
    while (backlog.length) {
      const chunk = backlog.shift();
      try {
        // 补发的请求这时才真正写给中枢，登记为在途
        for (const id of extractIds(chunk.toString("utf8"))) pendingIds.add(id);
        c.write(chunk);
      } catch (_) {}
    }
    console.error(`[dc-hub-client] 已连接引擎中枢 ${sock}`);
  });

  c.on("error", (e) => {
    // close 紧随其后，统一在 close 里重连，避免重复调度
    console.error("[dc-hub-client] 连接错误: " + (e && e.message));
  });

  c.on("close", () => {
    scheduleReconnect(attached ? "与中枢连接断开" : "无法连接中枢");
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupConn();
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("exit", dropActivity);

touchActivity();
connect();
