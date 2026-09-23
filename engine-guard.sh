#!/bin/bash
# engine-guard: 限制引擎（desktop-commander）进程数量，超限杀最老的，防小内存容器 OOM
# 背景：supergateway 每个 MCP session 独占一份引擎，客户端不复用 session 时会持续堆积
MAX="${MAX_ENGINES:-4}"
LOG="${GUARD_LOG:-$HOME/.bridge/logs/guard.log}"
mkdir -p "$(dirname "$LOG")"
echo "$(date -u +%FT%TZ) guard started (MAX=$MAX)" >> "$LOG"
while true; do
  N=$(pgrep -cf "[d]esktop-commander")
  if [ "$N" -gt "$MAX" ]; then
    EX=$((N - MAX))
    for p in $(pgrep -f "[d]esktop-commander" | sort -n | head -n "$EX"); do
      PP=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")
      kill -9 "$p" 2>/dev/null
      if [ -n "$PP" ] && [ "$PP" -gt 1 ] 2>/dev/null; then kill -9 "$PP" 2>/dev/null; fi
    done
    echo "$(date -u +%FT%TZ) trimmed $EX (was dc=$N)" >> "$LOG"
  fi
  sleep 10
done
