#!/usr/bin/env bash
# cmd-bridge 启动脚本
#
#   bash start.sh
#
# 不要用 `bash -c "$(cat start.sh)"` 或把内容整段粘进 shell 执行：
# 脚本内部会 pkill 同名进程，命令行里带同样字符串会导致自杀。
#
# 可用环境变量：
#   BRIDGE_TOKEN       路径 token，不传则复用 ~/.bridge/token，首次自动生成
#   BRIDGE_PORT        supergateway 端口，默认 8000
#   BRIDGE_MODE        full（默认，26 工具全开）| safe（白名单 6 个终端工具）
#   BRIDGE_NO_TUNNEL   设为 1 则只监听本地，不启动 cloudflared
#   BRIDGE_NPM_PREFIX  MCP 组件安装位置，默认 ~/.bridge-npm
#   BRIDGE_HOME        token/日志存放位置，默认 ~/.bridge

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NPM_PREFIX="${BRIDGE_NPM_PREFIX:-$HOME/.bridge-npm}"
BRIDGE_HOME_DIR="${BRIDGE_HOME:-$HOME/.bridge}"
LOG_DIR="$BRIDGE_HOME_DIR/logs"

PORT="${BRIDGE_PORT:-8000}"
MODE="${BRIDGE_MODE:-full}"
NO_TUNNEL="${BRIDGE_NO_TUNNEL:-0}"

mkdir -p "$LOG_DIR"

# ---------- 前置检查 ----------
[ -x "$NPM_PREFIX/bin/supergateway" ] || { echo "未安装 supergateway，请先执行 bash install.sh" >&2; exit 1; }
[ -x "$NPM_PREFIX/bin/desktop-commander" ] || { echo "未安装 desktop-commander，请先执行 bash install.sh" >&2; exit 1; }
NODE_BIN="$(command -v node)"

# ---------- token ----------
TOKEN_FILE="$BRIDGE_HOME_DIR/token"
if [ -n "${BRIDGE_TOKEN:-}" ]; then
  TOKEN="$BRIDGE_TOKEN"
elif [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  TOKEN="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "已生成新 token 并保存到 $TOKEN_FILE"
fi

# ---------- 选择执行引擎 ----------
if [ "$MODE" = "safe" ]; then
  if [ ! -f "$SCRIPT_DIR/filter-proxy.js" ]; then
    echo "错误: BRIDGE_MODE=safe 需要 $SCRIPT_DIR/filter-proxy.js" >&2
    exit 1
  fi
  ENGINE="$NODE_BIN $SCRIPT_DIR/filter-proxy.js"
  ENGINE_DESC="filter-proxy.js 白名单代理（终端类 6 个工具）"
else
  ENGINE="$NPM_PREFIX/bin/desktop-commander"
  ENGINE_DESC="desktop-commander（26 个工具全开）"
fi

# ---------- 启动协议转换层 ----------
pkill -f 'supergateway' 2>/dev/null || true
pkill -f 'desktop-commander' 2>/dev/null || true
sleep 1

setsid nohup "$NPM_PREFIX/bin/supergateway" \
  --stateful --cors \
  --stdio "$ENGINE" \
  --streamableHttpPath "/mcp/$TOKEN" \
  --port "$PORT" --outputTransport streamableHttp \
  > "$LOG_DIR/sg.log" 2>&1 </dev/null &

for _ in $(seq 1 15); do
  grep -q 'Listening' "$LOG_DIR/sg.log" 2>/dev/null && break
  sleep 1
done

if ! grep -q 'Listening' "$LOG_DIR/sg.log" 2>/dev/null; then
  echo "启动失败，最后 20 行日志：" >&2
  tail -n 20 "$LOG_DIR/sg.log" >&2
  exit 1
fi

LOCAL_URL="http://localhost:$PORT/mcp/$TOKEN"
echo "✔ 桥已就绪（$ENGINE_DESC）"

# ---------- 启动公网隧道 ----------
PUBLIC_URL=""
if [ "$NO_TUNNEL" != "1" ]; then
  CF_BIN="$BRIDGE_HOME_DIR/bin/cloudflared"
  [ -x "$CF_BIN" ] || { echo "未找到 cloudflared（$CF_BIN），请先执行 bash install.sh" >&2; exit 1; }

  pkill -f 'cloudflared tunnel' 2>/dev/null || true
  sleep 1
  : > "$LOG_DIR/cf.log"
  setsid nohup "$CF_BIN" tunnel --url "http://localhost:$PORT" --no-autoupdate \
    > "$LOG_DIR/cf.log" 2>&1 </dev/null &

  for _ in $(seq 1 30); do
    PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/cf.log" 2>/dev/null | head -1 || true)"
    [ -n "$PUBLIC_URL" ] && break
    sleep 2
  done

  if [ -z "$PUBLIC_URL" ]; then
    echo "⚠ 隧道地址未取到，稍后查看 $LOG_DIR/cf.log" >&2
  fi
fi

# ---------- 输出 ----------
echo
echo "本地入口: $LOCAL_URL"
if [ -n "$PUBLIC_URL" ]; then
  echo "公网入口: $PUBLIC_URL/mcp/$TOKEN"
fi
echo
echo "客户端配置（把 url 换成上面的入口）:"
cat <<EOF
{
  "mcpServers": {
    "cmd-bridge": {
      "type": "streamable-http",
      "url": "${PUBLIC_URL:-http://localhost:$PORT}/mcp/$TOKEN"
    }
  }
}
EOF
echo
echo "日志: $LOG_DIR/sg.log , $LOG_DIR/cf.log"
echo "停止: bash $SCRIPT_DIR/stop.sh"
