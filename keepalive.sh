#!/usr/bin/env bash
# cmd-bridge 进程守护（可选）
#
#   nohup bash keepalive.sh >/dev/null 2>&1 &
#
# 每 5 秒检查一次，只在「真的不可用」时重启整条桥；session 进程堆积单独走
# 「掐掉最老的 session」这条温和路径，避免小问题被放大成无限重启。
#
# 只凭「进程名 / 端口 / socket 文件存在」判活会漏掉三类假健康：
#   - 进程在、端口开着，但 supergateway 内部已坏，请求得不到响应（客户端 -32603）；
#   - socket 文件残留（中枢已死但没清掉文件），/dev/tcp 与 -S 都会误判为健康；
#   - 别人的同名进程（同机另一套 supergateway/cloudflared）被当成本桥。
# 因此这里改成：进程身份（BRIDGE_OWNER）+ 端口 + healthz HTTP + 中枢 MCP 级探测。
#
# 可用环境变量：
#   BRIDGE_KEEPALIVE_COOLDOWN     start.sh 失败后的退避秒数（默认 15）
#   BRIDGE_KEEPALIVE_CLIENT_MAX   dc-hub-client 上限，超过即修剪（默认 60）
#   BRIDGE_KEEPALIVE_CLIENT_TARGET 修剪到的目标进程数（默认 20）
#   BRIDGE_KEEPALIVE_PRUNE_STRIKES 修剪「没执行成功」连续几次才升级为整体重启（默认 2）
#
# 修剪策略：按「空闲时间」从长到短掐，优先回收最久没活动的 session（依据 dc-hub-client
# 的活动标记文件）；会话仍在转发消息时标记是新的，不会被掐。进程数长期高于上限只做
# 持续修剪，不重启整桥 —— 客户端狂建 session 是外部输入压力，重启解决不了它，
# 只会把「进程多」放大成「整桥反复重启」，反而打断所有正常调用。
#   BRIDGE_START_SCRIPT           覆盖 start.sh 路径（默认同目录 start.sh）

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_HOME_DIR="${BRIDGE_HOME:-$HOME/.bridge}"
PORT="${BRIDGE_PORT:-8000}"
NPM_PREFIX="${BRIDGE_NPM_PREFIX:-$HOME/.bridge-npm}"
LOG="$BRIDGE_HOME_DIR/keepalive.log"
COOLDOWN="${BRIDGE_KEEPALIVE_COOLDOWN:-15}"
CLIENT_MAX="${BRIDGE_KEEPALIVE_CLIENT_MAX:-60}"
CLIENT_TARGET="${BRIDGE_KEEPALIVE_CLIENT_TARGET:-20}"
PRUNE_STRIKES="${BRIDGE_KEEPALIVE_PRUNE_STRIKES:-2}"
START_SCRIPT="${BRIDGE_START_SCRIPT:-$SCRIPT_DIR/start.sh}"
HUB_SOCK="${BRIDGE_HOME_DIR}/dc-hub.sock"
ACT_DIR="$(dirname "$HUB_SOCK")/activity"
NODE_BIN="$(command -v node 2>/dev/null || echo node)"

# 进程身份标记 + 中枢 socket：这两条必须以「exec 时的环境」存在，stop.sh 的
# scoped_pids 才能认出守护自己。
# 坑：/proc/<pid>/environ 只反映 exec 那一刻的环境，脚本内部 export 不会出现在
# 守护进程自己的 environ 里（它拉起的子进程反而正常，因为子进程是带着 export
# 后的环境 exec 的）。生产上用 `setsid nohup bash keepalive.sh` 启动时环境里没有
# BRIDGE_*，不重新 exec 的话这个守护在 scoped_pids 里既不算 owned、也没有旧实例
# 证据（cmdline 是脚本目录而不是 BRIDGE_HOME），stop.sh 会漏掉它，留下一个停不掉
# 的守护去和下一次 start.sh 抢重启。这里主动用带标记的环境重新 exec 一次自己。
if [ "${BRIDGE_OWNER:-}" != "$BRIDGE_HOME_DIR" ] || [ "${DC_HUB_SOCK:-}" != "$HUB_SOCK" ]; then
  export BRIDGE_OWNER="$BRIDGE_HOME_DIR"
  export DC_HUB_SOCK="$HUB_SOCK"
  SELF="${BASH_SOURCE[0]:-}"
  [ -n "$SELF" ] || SELF="$SCRIPT_DIR/keepalive.sh"
  exec bash "$SELF" "$@"
fi
export BRIDGE_OWNER="$BRIDGE_HOME_DIR"
export DC_HUB_SOCK="$HUB_SOCK"
# shellcheck source=proc-lib.sh
. "$SCRIPT_DIR/proc-lib.sh"
mkdir -p "$BRIDGE_HOME_DIR"

SD_RE="$(printf '%s' "$SCRIPT_DIR" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
NPM_RE="$(printf '%s' "$NPM_PREFIX" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
SG_PAT="${NPM_RE}/lib/node_modules/supergateway|${NPM_RE}/bin/supergateway"
CLIENT_PAT="${SD_RE}/dc-hub-client\\.cjs"
STOP_FLAG="$BRIDGE_HOME_DIR/stopping"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# supergateway 实际监听端口：TLS 模式下退到 PORT+1，由 tls-proxy 对外提供 HTTPS
sg_port() {
  if [ "$(cat "$BRIDGE_HOME_DIR/run_tls" 2>/dev/null || echo 0)" = "1" ]; then
    echo $((PORT + 1))
  else
    echo "$PORT"
  fi
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# healthz HTTP 探测：确认 supergateway 能真正应答，而不是「端口开着但内部坏了」
healthz_ok() {
  local p resp
  p="$(sg_port)"
  resp="$( {
      exec 3<>"/dev/tcp/127.0.0.1/$p" 2>/dev/null || exit 1
      printf 'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' >&3
      timeout 3 cat <&3
    } 2>/dev/null )" || return 1
  case "$resp" in *"200"*) return 0 ;; *) return 1 ;; esac
}

# 中枢 MCP 级探测：真的建连并走一次 initialize -> tools/list。
# 只测「socket 能连上」不够：中枢被 SIGSTOP 时内核照样接受连接。
hub_probe() {
  [ -S "$HUB_SOCK" ] || return 1
  "$NODE_BIN" -e '
const net = require("net");
const sock = process.argv[1];
const c = net.connect(sock);
let buf = "";
const done = (code) => { try { c.destroy(); } catch (e) {} process.exit(code); };
const timer = setTimeout(() => done(1), 4000);
c.on("connect", () => {
  c.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "keepalive", version: "1" } } }) + "\n");
});
c.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === 1 && m.result) {
      c.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      c.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    } else if (m.id === 2) {
      clearTimeout(timer);
      done(m.result && Array.isArray(m.result.tools) && m.result.tools.length > 0 ? 0 : 1);
    }
  }
});
c.on("error", () => { clearTimeout(timer); done(1); });
' "$HUB_SOCK" 2>/dev/null
}

# 本桥拥有的 dc-hub-client：区分 node 本体与 /bin/sh -c 包装壳，只对 node 计数/操作
client_node_pids() {
  local p
  # 排除网关：supergateway 的命令行里包含 `--stdio .../dc-hub-client.cjs`，
  # 不排除就会把网关本身当成 session 进程（修剪时会误杀网关）。
  for p in $(pids_excluding "$CLIENT_PAT" "$SG_PAT"); do
    # 僵尸进程不占内存也不再服务，不计入配额
    [ "$(pid_state "$p")" = "Z" ] && continue
    case "$(pid_cmdline "$p")" in
      *"/bin/sh -c"*|*"sh -c "*) ;;
      *) printf '%s\n' "$p" ;;
    esac
  done
}

client_count() { client_node_pids | grep -c . || true; }

client_total() {
  local p n=0
  for p in $(pids_excluding "$CLIENT_PAT" "$SG_PAT"); do
    [ "$(pid_state "$p")" = "Z" ] && continue
    n=$((n + 1))
  done
  printf '%s\n' "$n"
}

# 某个 session 转发进程的空闲毫秒数：优先读 dc-hub-client 的活动标记文件，
# 拿不到标记（改造前启动的旧进程）按「最久空闲」处理，优先回收。
client_idle_ms() {
  local f="$ACT_DIR/$1.act" m now
  if [ -f "$f" ]; then
    m="$(date -r "$f" +%s%3N 2>/dev/null || echo 0)"
    now="$(date +%s%3N)"
    case "$m" in ''|*[!0-9]*) m=0 ;; esac
    if [ "$m" -gt 0 ]; then echo $(( now - m )); return; fi
  fi
  echo 999999999000
}

# 掐掉「最久没活动」的 session 进程，直到降到目标数。
# supergateway 在 child exit 时会 transport.close() 并释放该 session，
# 所以这是「按 session 回收」，不是杀整条桥。
LAST_PRUNED=()
prune_clients() {
  local target="$1" n to_kill i pid
  local -a pids=()
  while read -r pid; do [ -n "$pid" ] && pids+=("$pid"); done < <(
    client_node_pids | while read -r pid; do
      printf '%s %s %s\n' "$(client_idle_ms "$pid")" "$(pid_startticks "$pid")" "$pid"
    done | sort -k1,1nr -k2,2n | awk '{print $3}'
  )
  n="${#pids[@]}"
  to_kill=$(( n - target ))
  LAST_PRUNED=()
  [ "$to_kill" -lt 1 ] && return 0
  for ((i = 0; i < to_kill; i++)); do
    pid="${pids[$i]}"
    LAST_PRUNED+=("$pid")
    kill -TERM "$pid" 2>/dev/null || true
  done
  log "已修剪最老的 $to_kill 个 session 进程（按空闲时间从长到短，从 $n 个中挑出）"
  return 0
}

# 上一步被要求退出的进程里，还有几个真的没退出（僵尸算已退出）
prune_stragglers() {
  local pid n=0
  for pid in ${LAST_PRUNED[@]+"${LAST_PRUNED[@]}"}; do
    pid_alive_real "$pid" && n=$((n + 1))
  done
  echo "$n"
}

restart() {
  local why="$1" TUN MOD TLSF CFT CFD
  # 手动停止进行中就不要再抢着重启了（stop.sh 会先立这个标志）
  if [ -f "$STOP_FLAG" ]; then
    log "检测到 stopping 标志（手动停止进行中），放弃重启并退出"
    exit 0
  fi
  log "bridge down ($why), restarting"
  TUN="$(cat "$BRIDGE_HOME_DIR/tunnel_mode" 2>/dev/null || echo none)"
  MOD="$(cat "$BRIDGE_HOME_DIR/run_mode" 2>/dev/null || echo full)"
  TLSF="$(cat "$BRIDGE_HOME_DIR/run_tls" 2>/dev/null || echo 0)"
  CFT="$(cat "$BRIDGE_HOME_DIR/cf_token" 2>/dev/null || echo '')"
  CFD="$(cat "$BRIDGE_HOME_DIR/cf_domain" 2>/dev/null || echo '')"
  if BRIDGE_TUNNEL="$TUN" BRIDGE_MODE="$MOD" BRIDGE_TLS="$TLSF" \
     BRIDGE_CF_TOKEN="$CFT" BRIDGE_CF_DOMAIN="$CFD" \
     nohup bash "$START_SCRIPT" >> "$LOG" 2>&1; then
    # start.sh 成功时自身已等到就绪，稍等再进入下一轮
    sleep 2
  else
    # start.sh 失败时退避，别在桥持续起不来的情况下高频重建（越救越死）
    log "start.sh 失败，退避 ${COOLDOWN}s"
    sleep "$COOLDOWN"
  fi
}

log "keepalive 启动（home=$BRIDGE_HOME_DIR port=$PORT client_max=$CLIENT_MAX target=$CLIENT_TARGET）"
strikes=0
prune_rounds=0
while true; do
  if [ -f "$STOP_FLAG" ]; then
    log "检测到 stopping 标志（手动停止进行中），守护退出"
    exit 0
  fi

  if ! bridge_pids "$SG_PAT" | grep -q .; then
    restart "supergateway 进程不在（按身份判定）"
    strikes=0
  elif ! port_open "$(sg_port)"; then
    restart "端口 $(sg_port) 不可连"
    strikes=0
  elif ! hub_probe; then
    restart "中枢 MCP 探测失败（initialize/tools/list 无响应）"
    strikes=0
  elif ! healthz_ok; then
    restart "healthz 探测失败"
    strikes=0
  else
    cnt="$(client_count)"
    if [ "$cnt" -gt "$CLIENT_MAX" ]; then
      prune_clients "$CLIENT_TARGET"
      prune_rounds=$((prune_rounds + 1))
      if [ $((prune_rounds % 6)) -eq 1 ]; then
        log "session 进程持续高于上限（当前 $cnt > $CLIENT_MAX），保持修剪、不重启整桥"
      fi
      sleep 3
      after="$(client_count)"
      stragglers="$(prune_stragglers)"
      if [ "$stragglers" -gt 0 ]; then
        strikes=$((strikes + 1))
        log "修剪后仍有 $stragglers 个被要求退出的 session 进程没退出（当前 $after 个，连续第 $strikes 次）"
        if [ "$strikes" -ge "$PRUNE_STRIKES" ]; then
          restart "session 进程拒绝退出（$stragglers 个 TERM 无效）"
          strikes=0
        fi
      else
        strikes=0
        log "修剪生效：已退出 ${#LAST_PRUNED[@]} 个，现剩 $after 个 session 进程（包装壳共 $(client_total) 个匹配）"
      fi
    else
      strikes=0
      prune_rounds=0
    fi
  fi
  sleep 5
done
