#!/usr/bin/env bash
# cmd-bridge 安装脚本（幂等，可重复执行）
#
#   bash install.sh
#
# 安装内容：
#   1) supergateway + desktop-commander -> $BRIDGE_NPM_PREFIX
#   2) cloudflared                      -> $BRIDGE_HOME/bin
#   3) ngrok                            -> $BRIDGE_HOME/bin
#
# 两个隧道二进制各自独立安装：任一失败只警告、不阻断另一个。
# 例如某些云主机上 cloudflared 装不上或连不通，仍可用 ngrok 起桥。
#
# 可用环境变量：
#   BRIDGE_NPM_PREFIX  MCP 组件安装位置，默认 ~/.bridge-npm
#   BRIDGE_HOME        token/日志/隧道二进制存放位置，默认 ~/.bridge

set -euo pipefail

NPM_PREFIX="${BRIDGE_NPM_PREFIX:-$HOME/.bridge-npm}"
BRIDGE_HOME_DIR="${BRIDGE_HOME:-$HOME/.bridge}"
BIN_DIR="$BRIDGE_HOME_DIR/bin"

echo "== cmd-bridge 安装 =="
echo "MCP 组件目录: $NPM_PREFIX"
echo "运行目录:     $BRIDGE_HOME_DIR"
echo

# ---------- 1. 前置检查 ----------
echo "[1/4] 检查环境"
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node，请先安装 Node.js >= 18" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误: 未找到 npm" >&2
  exit 1
fi
echo "node $(node -v) / npm $(npm -v)"

if ! command -v curl >/dev/null 2>&1; then
  echo "错误: 未找到 curl" >&2
  exit 1
fi

mkdir -p "$NPM_PREFIX" "$BIN_DIR"

case "$(uname -m)" in
  x86_64)        ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "错误: 未支持的架构 $(uname -m)" >&2; exit 1 ;;
esac

# ---------- 2. 安装 MCP 组件 ----------
echo
echo "[2/4] 安装 MCP 组件"
if [ -x "$NPM_PREFIX/bin/supergateway" ] && [ -x "$NPM_PREFIX/bin/desktop-commander" ]; then
  echo "已安装，跳过（要重装请先删除 $NPM_PREFIX）"
else
  npm install -g --prefix "$NPM_PREFIX" supergateway @wonderwhy-er/desktop-commander
  # npm 11 可能拦截 postinstall，补跑一次构建
  if [ ! -x "$NPM_PREFIX/bin/desktop-commander" ]; then
    npm rebuild -g --prefix "$NPM_PREFIX" desktop-commander || true
  fi
fi

for b in supergateway desktop-commander; do
  if [ ! -x "$NPM_PREFIX/bin/$b" ]; then
    echo "错误: $b 安装失败" >&2
    exit 1
  fi
done
echo "supergateway      -> $NPM_PREFIX/bin/supergateway"
DC_PKG="$NPM_PREFIX/lib/node_modules/@wonderwhy-er/desktop-commander/package.json"
if [ -f "$DC_PKG" ]; then
  echo "desktop-commander $(node -p "require('$DC_PKG').version" 2>/dev/null || echo ok)"
fi

# ---------- 3. 安装 cloudflared ----------
echo
echo "[3/4] 安装 cloudflared"
if [ -x "$BIN_DIR/cloudflared" ]; then
  echo "已存在，跳过（要升级请删除 $BIN_DIR/cloudflared 后重跑）"
else
  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
  echo "下载 $CF_URL"
  if curl -fL --retry 3 -o "$BIN_DIR/cloudflared" "$CF_URL"; then
    chmod +x "$BIN_DIR/cloudflared"
  else
    rm -f "$BIN_DIR/cloudflared"
    echo "警告: cloudflared 未装上，可改用 BRIDGE_TUNNEL=ngrok（不影响后续步骤）" >&2
  fi
fi
[ -x "$BIN_DIR/cloudflared" ] && { "$BIN_DIR/cloudflared" --version || true; }

# ---------- 4. 安装 ngrok ----------
echo
echo "[4/4] 安装 ngrok"
if [ -x "$BIN_DIR/ngrok" ]; then
  echo "已存在，跳过（要升级请删除 $BIN_DIR/ngrok 后重跑）"
else
  NG_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-$ARCH.tgz"
  echo "下载 $NG_URL"
  NG_TGZ="$(mktemp)"
  if curl -fL --retry 3 -o "$NG_TGZ" "$NG_URL" && tar -xzf "$NG_TGZ" -C "$BIN_DIR" ngrok; then
    chmod +x "$BIN_DIR/ngrok"
  else
    echo "警告: ngrok 未装上，可继续用默认的 cloudflared" >&2
  fi
  rm -f "$NG_TGZ"
fi
[ -x "$BIN_DIR/ngrok" ] && { "$BIN_DIR/ngrok" --version || true; }

# ---------- 汇总 ----------
TUNNELS=""
[ -x "$BIN_DIR/cloudflared" ] && TUNNELS="$TUNNELS cloudflare"
[ -x "$BIN_DIR/ngrok" ] && TUNNELS="$TUNNELS ngrok"

echo
echo "== 安装完成 =="
echo "MCP 组件: supergateway / desktop-commander -> $NPM_PREFIX/bin"
if [ -n "$TUNNELS" ]; then
  echo "可用隧道:$TUNNELS"
else
  echo "可用隧道: 无（只能 BRIDGE_TUNNEL=none 本机使用）"
fi
echo
echo "下一步："
echo "  bash start.sh                      # 默认走 cloudflare"
echo "  BRIDGE_TUNNEL=ngrok bash start.sh  # 换 ngrok"
echo "  BRIDGE_TUNNEL=none  bash start.sh  # 只监听本地"
echo
echo "提示：ngrok 需要 authtoken（https://dashboard.ngrok.com/get-started/your-authtoken）"
echo "  一次性写入配置: $BIN_DIR/ngrok config add-authtoken <TOKEN>"
echo "  或每次启动前:   export NGROK_AUTHTOKEN=<TOKEN>"
