#!/usr/bin/env bash
# cmd-bridge 停止脚本
#
#   bash stop.sh

set -uo pipefail

echo "停止 supergateway / desktop-commander..."
pkill -f 'supergateway' 2>/dev/null && echo "已停止" || echo "未在运行"
pkill -f 'desktop-commander' 2>/dev/null && echo "已停止" || echo "未在运行"

echo "停止 cloudflared tunnel..."
pkill -f 'cloudflared tunnel' 2>/dev/null && echo "已停止" || echo "未在运行"

sleep 1
echo "完成。token 与日志保留在 \${BRIDGE_HOME:-$HOME/.bridge}。"
