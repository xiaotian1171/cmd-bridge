#!/usr/bin/env bash
# cmd-bridge 进程守护（可选）
#
#   nohup bash keepalive.sh >/dev/null 2>&1 &
#
# 每 5 秒检查一次桥进程与端口，意外退出时按上次的隧道模式
# （start.sh 记录在 ~/.bridge/tunnel_mode）自动重启。
# bash stop.sh 会一并停掉本守护。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_HOME_DIR="${BRIDGE_HOME:-$HOME/.bridge}"
PORT="${BRIDGE_PORT:-8000}"
LOG="$BRIDGE_HOME_DIR/keepalive.log"
mkdir -p "$BRIDGE_HOME_DIR"

while true; do
  if ! pgrep -f 'supergateway' >/dev/null 2>&1 \
     || ! ss -tln 2>/dev/null | grep -q ":${PORT} "; then
    echo "$(date '+%F %T') bridge down, restarting" >> "$LOG"
    TUN="$(cat "$BRIDGE_HOME_DIR/tunnel_mode" 2>/dev/null || echo none)"
    MOD="$(cat "$BRIDGE_HOME_DIR/run_mode" 2>/dev/null || echo full)"
    TLSF="$(cat "$BRIDGE_HOME_DIR/run_tls" 2>/dev/null || echo 0)"
    CFT="$(cat "$BRIDGE_HOME_DIR/cf_token" 2>/dev/null || echo '')"
    CFD="$(cat "$BRIDGE_HOME_DIR/cf_domain" 2>/dev/null || echo '')"
    BRIDGE_TUNNEL="$TUN" BRIDGE_MODE="$MOD" BRIDGE_TLS="$TLSF" \
      BRIDGE_CF_TOKEN="$CFT" BRIDGE_CF_DOMAIN="$CFD" \
      nohup bash "$SCRIPT_DIR/start.sh" >> "$LOG" 2>&1
  fi
  sleep 5
done
