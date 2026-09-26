#!/usr/bin/env bash
# cmd-bridge 停止脚本
#
#   bash stop.sh
#
# 停哪些进程：
#   1) 本桥拥有的进程：命令行匹配 + /proc/<pid>/environ 里 BRIDGE_OWNER 等于本桥 BRIDGE_HOME；
#   2) 改造前启动的「旧实例」（environ 里没有 BRIDGE_OWNER）：不靠全局 pkill，
#      而是用本桥独占的运行时资源认定 —— 监听本桥端口 / env 指向本桥 sock 与 home /
#      持有本桥 dc-hub.sock / 命令行含本桥 home 路径 / 是本桥网关祖先的旧守护。
#      同机另一套桥、别人的同名进程都不会被误停。
#   仅当上述证据全部缺失（极端情况）时，才用 BRIDGE_KILL_LEGACY=1 回退旧的全量 pkill。
#
# 停止顺序：先立 stopping 标志并停掉 keepalive 守护，再停其它进程，
# 避免守护在和手动停止「抢着重启」；最后核对本桥端口是否已释放。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_HOME_DIR="${BRIDGE_HOME:-$HOME/.bridge}"
NPM_PREFIX="${BRIDGE_NPM_PREFIX:-$HOME/.bridge-npm}"
PORT="${BRIDGE_PORT:-8000}"
export BRIDGE_OWNER="$BRIDGE_HOME_DIR"
export BRIDGE_PORT="$PORT"
export DC_HUB_SOCK="${DC_HUB_SOCK:-$BRIDGE_HOME_DIR/dc-hub.sock}"
# shellcheck source=proc-lib.sh
. "$SCRIPT_DIR/proc-lib.sh"

LEGACY_KILL="${BRIDGE_KILL_LEGACY:-0}"
mkdir -p "$BRIDGE_HOME_DIR"
FLAG="$BRIDGE_HOME_DIR/stopping"

SD_RE="$(printf '%s' "$SCRIPT_DIR" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
NPM_RE="$(printf '%s' "$NPM_PREFIX" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
BRIDGE_HOME_RE="$(printf '%s' "$BRIDGE_HOME_DIR" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
SG_PAT="${NPM_RE}/lib/node_modules/supergateway|${NPM_RE}/bin/supergateway"
ENGINE_PAT="${NPM_RE}/bin/desktop-commander|${SD_RE}/(chatgpt-compat|filter-proxy)\\.js"
CF_PAT="${BRIDGE_HOME_RE}/bin/cloudflared"
NG_PAT="${BRIDGE_HOME_RE}/bin/ngrok"
CLIENT_PAT="${SD_RE}/dc-hub-client\\.cjs"
KEEPALIVE_PAT="${SD_RE}/keepalive\\.sh"

# 先挡守护：keepalive.sh 在每轮循环开始时检查该标志，看到就直接退出。
# 立完标志要给它一个循环周期（默认 5s）自己退；直接 SIGTERM 会让它来不及记录
# 「检测到 stopping 标志」，日志就看不出来是谁先动的手。
touch "$FLAG"
cleanup_flag() { rm -f "$FLAG"; }
trap cleanup_flag EXIT

legacy_report=""    # 识别到的旧实例（无 BRIDGE_OWNER）PID 汇总

stop_role() { # $1 说明 $2 模式 [$3 排除模式]
  local before after legacy n
  before="$(scoped_pids "$2" "${3:-}" | tr '\n' ' ')"
  legacy="$(legacy_only_pids "$2" 2>/dev/null | tr '\n' ' ')"
  [ -n "${legacy// /}" ] && legacy_report="$legacy_report $1:${legacy% }"
  if [ -n "${3:-}" ]; then
    scoped_kill "$2" "$3" TERM >/dev/null || true
  else
    scoped_kill "$2" "" TERM >/dev/null || true
  fi
  if [ -n "${before// /}" ]; then
    echo "已停止: ${before% }"
    [ -n "${legacy// /}" ] && echo "  （其中旧实例/无 BRIDGE_OWNER: ${legacy% }）"
  else
    echo "未在运行"
  fi
  if [ "$LEGACY_KILL" = "1" ]; then
    # 最后手段：证据缺失时的旧全量语义（会波及其它同名进程，默认关闭）
    if ! scoped_pids "$2" "${3:-}" >/dev/null 2>&1; then :; fi
    pkill -f "$2" 2>/dev/null && echo "  （BRIDGE_KILL_LEGACY=1：legacy 全量匹配回退已生效，会波及其它同名进程）" || true
  fi
}

echo "停止 keepalive 守护（先立标志、等它自己退，防止它抢着重启）..."
# 旧守护自身没有 BRIDGE_OWNER，靠「是本桥网关/中枢的祖先」被识别
waited=0
while [ "$waited" -lt 12 ]; do
  scoped_pids "$KEEPALIVE_PAT" | grep -q . || break
  sleep 1
  waited=$((waited + 1))
done
stop_role keepalive "$KEEPALIVE_PAT"
sleep 1

echo "停止 supergateway..."
stop_role sg "$SG_PAT"

echo "停止 session 侧转发进程 dc-hub-client..."
# 排除网关自身（它的 --stdio 参数里也含 dc-hub-client.cjs），避免把网关算进 session 进程
stop_role client "$CLIENT_PAT" "$SG_PAT"

echo "停止引擎中枢 dc-hub..."
stop_role hub "${SD_RE}/dc-hub\\.cjs"

echo "停止执行引擎 desktop-commander..."
stop_role engine "$ENGINE_PAT"

echo "停止 tls-proxy..."
stop_role tls "${SD_RE}/tls-proxy\\.cjs"

echo "停止 cloudflared tunnel..."
stop_role cf "$CF_PAT"

echo "停止 ngrok..."
stop_role ng "$NG_PAT"

sleep 1
echo "清理未响应 TERM 的本桥进程..."
for pat in "$KEEPALIVE_PAT" "$SG_PAT" "${SD_RE}/dc-hub\\.cjs" \
           "$ENGINE_PAT" "${SD_RE}/tls-proxy\\.cjs" "$CF_PAT" "$NG_PAT"; do
  for pid in $(scoped_pids "$pat"); do
    if pid_alive_real "$pid"; then
      kill -KILL "$pid" 2>/dev/null && echo "  已强杀: $pid"
    fi
  done
done
for pid in $(scoped_pids "$CLIENT_PAT" "$SG_PAT"); do
  if pid_alive_real "$pid"; then
    kill -KILL "$pid" 2>/dev/null && echo "  已强杀: $pid"
  fi
done

# ---------- 端口释放核对（首次切换最容易在这里踩坑） ----------
sleep 1
echo "核对本桥端口是否已释放..."
port_left=""
for p in $(bridge_ports); do
  owners="$(port_owner_pids "$p" | tr '\n' ' ')"
  if [ -n "${owners// /}" ]; then
    echo "  端口 $p 仍被占用: ${owners% }，尝试强制释放"
    for pid in $owners; do
      # 属于别的桥（环境里指向别的 home/sock）就绝不碰
      if pid_refs_other_bridge "$pid"; then
        echo "    跳过: $pid 属于另一套桥"
        continue
      fi
      kill -KILL "$pid" 2>/dev/null && echo "    已强杀占用者: $pid"
    done
    sleep 1
    owners="$(port_owner_pids "$p" | tr '\n' ' ')"
    [ -n "${owners// /}" ] && port_left="$port_left $p(${owners% })"
  fi
done
if [ -n "${port_left// /}" ]; then
  echo "  ⚠ 端口未能释放:$port_left —— 若是别人的进程请勿强杀，改用其它端口启动" >&2
else
  echo "  端口已释放"
fi

if [ -n "${legacy_report// /}" ]; then
  echo "本次识别到的旧实例（改造前启动、environ 无 BRIDGE_OWNER）:$legacy_report"
fi

pidfile_clear hub; pidfile_clear sg; pidfile_clear cf; pidfile_clear ng; pidfile_clear engine
# 清掉 session 活动标记，下次启动不会读到过期的时间戳
rm -f "$BRIDGE_HOME_DIR/activity"/*.act 2>/dev/null || true
echo "完成。token 与日志保留在 $BRIDGE_HOME_DIR。"
