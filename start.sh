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
#   BRIDGE_MODE        full（默认，26 工具全开）| admin（清黑名单=权限全开）| safe（白名单 6 个终端工具）
#   BRIDGE_TUNNEL      cloudflare（默认）| ngrok | none
#   BRIDGE_NO_TUNNEL   旧参数，设为 1 等价于 BRIDGE_TUNNEL=none
#   BRIDGE_TLS         1 = 直连模式（BRIDGE_TUNNEL=none）强制 HTTPS：supergateway 退到
#                      本机内部端口，由 tls-proxy.cjs 用自签证书在 BRIDGE_PORT 提供 HTTPS
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
CF_TOKEN="${BRIDGE_CF_TOKEN:-}"
CF_DOMAIN="${BRIDGE_CF_DOMAIN:-}"
case "$MODE" in
  full|admin|safe) ;;
  *) echo "错误: BRIDGE_MODE 只能是 full | admin | safe（当前: $MODE）" >&2; exit 1 ;;
esac
case "$TUNNEL" in
  cloudflare|ngrok|none) ;;
  *) echo "错误: BRIDGE_TUNNEL 只能是 cloudflare | ngrok | none（当前: $TUNNEL）" >&2; exit 1 ;;
esac
TLS="${BRIDGE_TLS:-0}"
case "$TLS" in
  0|1) ;;
  *) echo "错误: BRIDGE_TLS 只能是 0 或 1（当前: $TLS）" >&2; exit 1 ;;
esac

mkdir -p "$LOG_DIR"

# BRIDGE_TLS：仅直连模式生效；隧道出口本身是 HTTPS，无需重复 TLS
TLS_ON=0
if [ "$TLS" = "1" ]; then
  if [ "$TUNNEL" != "none" ]; then
    echo "⚠ BRIDGE_TLS=1 仅在 BRIDGE_TUNNEL=none 时生效（$TUNNEL 隧道出口已是 HTTPS），本次忽略" >&2
  elif ! command -v openssl >/dev/null 2>&1; then
    echo "⚠ 未找到 openssl，无法生成自签证书，本次忽略 BRIDGE_TLS" >&2
  else
    TLS_DIR="$BRIDGE_HOME_DIR/tls"
    mkdir -p "$TLS_DIR"
    if [ ! -f "$TLS_DIR/cert.pem" ] || [ ! -f "$TLS_DIR/key.pem" ]; then
      openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
        -days 3650 -subj "/CN=cmd-bridge" >/dev/null 2>&1
      chmod 600 "$TLS_DIR/key.pem"
    fi
    TLS_ON=1
  fi
fi
printf '%s' "$TUNNEL" > "$BRIDGE_HOME_DIR/tunnel_mode"
printf '%s' "$MODE" > "$BRIDGE_HOME_DIR/run_mode"
printf '%s' "$TLS_ON" > "$BRIDGE_HOME_DIR/run_tls"
printf '%s' "$CF_TOKEN" > "$BRIDGE_HOME_DIR/cf_token"
printf '%s' "$CF_DOMAIN" > "$BRIDGE_HOME_DIR/cf_domain"

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
# 环境（容器/一次性虚拟机/独立低权账号）或明确知晓风险时使用。
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
pkill -f 'dc-hu[b]' 2>/dev/null || true
sleep 1

# ---------- 启动单例引擎中枢 ----------
# 每个 MCP session 不再各起一份引擎，全部复用中枢持有的同一份；
# session 侧只跑轻量转发进程（dc-hub-client.cjs），
# 避免客户端不复用 session 时引擎数随调用量增长撑爆小内存容器。
export DC_HUB_CMD="$NODE_BIN $SCRIPT_DIR/dc-hub.cjs -- sh -c \"$ENGINE\""
HUB_SOCK="$BRIDGE_HOME_DIR/dc-hub.sock"
rm -f "$HUB_SOCK"
setsid nohup "$NODE_BIN" "$SCRIPT_DIR/dc-hub.cjs" -- sh -c "$ENGINE" \
  > "$LOG_DIR/hub.log" 2>&1 </dev/null &
for _ in $(seq 1 20); do
  [ -S "$HUB_SOCK" ] && break
  sleep 1
done
if [ ! -S "$HUB_SOCK" ]; then
  echo "引擎中枢启动失败，最后 20 行日志：" >&2
  tail -n 20 "$LOG_DIR/hub.log" >&2
  exit 1
fi

# supergateway 3.4.3 有已知崩溃 bug：客户端断开连接会触发未处理异常直接杀进程。
# 存在 dist/index.js 时用 `node -r` 预加载 sg-hook.cjs 护栏；否则退回 bin 启动（无护栏）。
SG_ENTRY="$NPM_PREFIX/lib/node_modules/supergateway/dist/index.js"
SG_LAUNCH=("$NPM_PREFIX/bin/supergateway")
[ -f "$SG_ENTRY" ] && SG_LAUNCH=("$NODE_BIN" -r "$SCRIPT_DIR/sg-hook.cjs" "$SG_ENTRY")
SG_PORT="$PORT"
[ "$TLS_ON" = "1" ] && SG_PORT=$((PORT+1))
setsid nohup "${SG_LAUNCH[@]}" \
  --stateful --cors --sessionTimeout 60000 \
  --stdio "$NODE_BIN $SCRIPT_DIR/dc-hub-client.cjs" \
  --streamableHttpPath "/mcp/$TOKEN" \
  --port "$SG_PORT" --outputTransport streamableHttp \
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

if [ "$TLS_ON" = "1" ]; then
  pkill -f 'tls-proxy.cjs' 2>/dev/null || true
  sleep 1
  : > "$LOG_DIR/tls.log"
  setsid nohup "$NODE_BIN" "$SCRIPT_DIR/tls-proxy.cjs" "$PORT" "$SG_PORT" \
    "$BRIDGE_HOME_DIR/tls/cert.pem" "$BRIDGE_HOME_DIR/tls/key.pem" \
    > "$LOG_DIR/tls.log" 2>&1 </dev/null &
  for _ in $(seq 1 10); do
    grep -q 'listening' "$LOG_DIR/tls.log" 2>/dev/null && break
    sleep 1
  done
  if ! grep -q 'listening' "$LOG_DIR/tls.log" 2>/dev/null; then
    echo "tls-proxy 启动失败，日志：$LOG_DIR/tls.log" >&2
    tail -n 10 "$LOG_DIR/tls.log" >&2
    exit 1
  fi
  LOCAL_URL="https://localhost:$PORT/mcp/$TOKEN"
else
  LOCAL_URL="http://localhost:$PORT/mcp/$TOKEN"
fi
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

    if [ -n "$CF_TOKEN" ]; then
      # 自有域名模式：connector 用 token 接入，域名/路由在 CF 后台（remotely-managed）配置
      setsid nohup "$CF_BIN" --no-autoupdate tunnel run --token "$CF_TOKEN" \
        > "$LOG_DIR/cf.log" 2>&1 </dev/null &
      for _ in $(seq 1 30); do
        grep -q 'Registered tunnel connection' "$LOG_DIR/cf.log" 2>/dev/null && break
        if grep -qE 'lvl=(error|crit|fatal)' "$LOG_DIR/cf.log" 2>/dev/null; then break; fi
        sleep 2
      done
      if grep -q 'Registered tunnel connection' "$LOG_DIR/cf.log" 2>/dev/null; then
        if [ -n "$CF_DOMAIN" ]; then
          PUBLIC_URL="https://$CF_DOMAIN"
        else
          echo "隧道已连上。域名在 CF 后台 Public Hostname 绑定（Service 填 http://localhost:$PORT）；设 BRIDGE_CF_DOMAIN 可在启动时回显完整地址" >&2
        fi
      else
        echo "⚠ CF tunnel（token 模式）未确认就绪，查看 $LOG_DIR/cf.log" >&2
        grep -E 'lvl=(error|crit|fatal)' "$LOG_DIR/cf.log" 2>/dev/null | head -3 >&2 || true
      fi
    else
      # 快速通道：trycloudflare 临时域名，免账号免域名，地址随机
      setsid nohup "$CF_BIN" tunnel --url "http://localhost:$PORT" --no-autoupdate \
        > "$LOG_DIR/cf.log" 2>&1 </dev/null &

      for _ in $(seq 1 30); do
        PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/cf.log" 2>/dev/null | head -1 || true)"
        [ -n "$PUBLIC_URL" ] && break
        sleep 2
      done
    fi

    if [ -z "$PUBLIC_URL" ] && [ -z "$CF_TOKEN" ]; then
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
if [ "$TLS_ON" = "1" ]; then
  echo "强制 HTTPS: 已启用（supergateway 实际监听 127.0.0.1:$SG_PORT，对外仅 $PORT 的 HTTPS）"
  echo "  自签证书: $BRIDGE_HOME_DIR/tls/cert.pem；严格校验证书的客户端（如 ChatGPT 连接器）会拒绝，"
  echo "  此类场景请改走 BRIDGE_TUNNEL=ngrok/cloudflare，或自备正规证书反代"
fi
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
      "url": "${PUBLIC_URL:-${LOCAL_URL%/mcp/*}}/mcp/$TOKEN"
    }
  }
}
EOF
echo
echo "日志: $LOG_DIR/sg.log , $LOG_DIR/tls.log , $LOG_DIR/cf.log , $LOG_DIR/ng.log"
echo "停止: bash $SCRIPT_DIR/stop.sh"
