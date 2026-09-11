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
#   BRIDGE_TUNNEL      cloudflare（默认）| ngrok | none
#   BRIDGE_NO_TUNNEL   旧参数，设为 1 等价于 BRIDGE_TUNNEL=none
#   NGROK_AUTHTOKEN    BRIDGE_TUNNEL=ngrok 时用；ngrok 自身也会读取该变量
#   BRIDGE_NPM_PREFIX  MCP 组件安装位置，默认 ~/.bridge-npm
#   BRIDGE_HOME        token/日志存放位置，默认 ~/.bridge

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NPM_PREFIX="${BRIDGE_NPM_PREFIX:-$HOME/.bridge-npm}"
BRIDGE_HOME_DIR="${BRIDGE_HOME:-$HOME/.bridge}"
LOG_DIR="$BRIDGE_HOME_DIR/logs"

PORT="${BRIDGE_PORT:-8000}"
MODE="${BRIDGE_MODE:-full}"
TUNNEL="${BRIDGE_TUNNEL:-cloudflare}"
if [ "${BRIDGE_NO_TUNNEL:-0}" = "1" ]; then TUNNEL=none; fi
case "$MODE" in
  full|admin|safe) ;;
  *) echo "错误: BRIDGE_MODE 只能是 full | admin | safe（当前: $MODE）" >&2; exit 1 ;;
esac
case "$TUNNEL" in
  cloudflare|ngrok|none) ;;
  *) echo "错误: BRIDGE_TUNNEL 只能是 cloudflare | ngrok | none（当前: $TUNNEL）" >&2; exit 1 ;;
esac

mkdir -p "$LOG_DIR"
printf '%s' "$TUNNEL" > "$BRIDGE_HOME_DIR/tunnel_mode"
printf '%s' "$MODE" > "$BRIDGE_HOME_DIR/run_mode"

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
  # chatgpt-compat.cjs 剥离 desktop-commander 工具上的 Apps SDK widget 元数据，
  # 否则 ChatGPT 自定义连接器会转走 widget 流程导致创建失败（详见该文件头注释）。
  ENGINE="$NODE_BIN $SCRIPT_DIR/chatgpt-compat.cjs -- $NPM_PREFIX/bin/desktop-commander"
  ENGINE_DESC="desktop-commander（26 个工具全开，含 ChatGPT 兼容层）"
fi

# BRIDGE_MODE=admin：清空 desktop-commander 的命令黑名单（sudo/apt 等全部放行），权限全开。
# 桥的 token 就是全部凭据，此模式下持有 URL 的人可执行任意命令（含 root），仅在隔离
# 环境（容器/一次性虚拟机/独立低权账号）或明确知晓风险时使用。若需免 sudo 操作
# docker，另执行一次：sudo usermod -aG docker "$USER"
if [ "$MODE" = "admin" ]; then
  python3 - "$HOME" <<'PY' || true
import json, os, sys
cands = [
    os.path.join(sys.argv[1], ".claude-server-commander", "config.json"),
    os.path.join(sys.argv[1], "desktop-commander", "config.json"),
]
for p in cands:
    if os.path.isfile(p):
        c = json.load(open(p))
        c["blockedCommands"] = []
        json.dump(c, open(p, "w"), indent=2)
        print("已清空命令黑名单:", p)
        break
else:
    print("⚠ 未找到 desktop-commander 配置文件，黑名单保持默认；桥跑过一次后再执行 start.sh 即可生效")
PY
  ENGINE_DESC="desktop-commander（26 个工具全开，黑名单已清空 = 权限全开）"
fi

# ---------- 启动协议转换层 ----------
pkill -f 'supergateway' 2>/dev/null || true
pkill -f 'desktop-commander' 2>/dev/null || true
sleep 1

# supergateway 3.4.3 有已知崩溃 bug：客户端断开连接会触发未处理异常直接杀进程。
# 存在 dist/index.js 时用 `node -r` 预加载 sg-hook.cjs 护栏；否则退回 bin 启动（无护栏）。
SG_ENTRY="$NPM_PREFIX/lib/node_modules/supergateway/dist/index.js"
SG_LAUNCH=("$NPM_PREFIX/bin/supergateway")
[ -f "$SG_ENTRY" ] && SG_LAUNCH=("$NODE_BIN" -r "$SCRIPT_DIR/sg-hook.cjs" "$SG_ENTRY")
setsid nohup "${SG_LAUNCH[@]}" \
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
case "$TUNNEL" in
  none)
    echo "（BRIDGE_TUNNEL=none，只监听本机）"
    ;;

  cloudflare)
    CF_BIN="$BRIDGE_HOME_DIR/bin/cloudflared"
    [ -x "$CF_BIN" ] || { echo "未找到 cloudflared（$CF_BIN），请先执行 bash install.sh，或改用 BRIDGE_TUNNEL=ngrok" >&2; exit 1; }

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
    ;;

  ngrok)
    NG_BIN="$BRIDGE_HOME_DIR/bin/ngrok"
    [ -x "$NG_BIN" ] || { echo "未找到 ngrok（$NG_BIN），请先执行 bash install.sh" >&2; exit 1; }

    pkill -f 'ngrok http' 2>/dev/null || true
    sleep 1
    : > "$LOG_DIR/ng.log"
    setsid nohup "$NG_BIN" http "$PORT" --log stdout --log-format logfmt \
      > "$LOG_DIR/ng.log" 2>&1 </dev/null &

    for _ in $(seq 1 30); do
      # logfmt 成功行形如: ... msg="started tunnel" obj=tunnels ... url=https://xxxx.ngrok-free.app
      PUBLIC_URL="$(grep -oE 'url=https://[a-z0-9.-]+' "$LOG_DIR/ng.log" 2>/dev/null | head -1 | cut -d= -f2- || true)"
      # 兜底：只认 ngrok 自有域名后缀，避免误抓日志里的 dashboard.ngrok.com
      if [ -z "$PUBLIC_URL" ]; then
        PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.ngrok(-free)?\.(app|dev|io|pizza|pro)' "$LOG_DIR/ng.log" 2>/dev/null | head -1 || true)"
      fi
      [ -n "$PUBLIC_URL" ] && break
      # 鉴权类错误不会自愈，提前退出并给出线索
      if grep -qE 'ERR_NGROK_[0-9]+' "$LOG_DIR/ng.log" 2>/dev/null; then break; fi
      sleep 2
    done

    if [ -z "$PUBLIC_URL" ]; then
      echo "⚠ 隧道地址未取到，ngrok 报错：" >&2
      grep -E 'lvl=crit|^ERROR' "$LOG_DIR/ng.log" 2>/dev/null | head -3 >&2 || true
      echo "  多数情况是缺 authtoken：$NG_BIN config add-authtoken <TOKEN>，或启动前 export NGROK_AUTHTOKEN=<TOKEN>" >&2
      echo "  完整日志：$LOG_DIR/ng.log" >&2
    fi
    ;;
esac

# ---------- 输出 ----------
echo
echo "本地入口: $LOCAL_URL"
if [ -n "$PUBLIC_URL" ]; then
  echo "公网入口: $PUBLIC_URL/mcp/$TOKEN"
  echo "隧道类型: $TUNNEL"
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
echo "日志: $LOG_DIR/sg.log , $LOG_DIR/cf.log , $LOG_DIR/ng.log"
echo "停止: bash $SCRIPT_DIR/stop.sh"
