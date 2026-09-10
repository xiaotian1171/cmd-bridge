# cmd-bridge 安装脚本（Windows, PowerShell 5.1+）
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 可用环境变量：
#   BRIDGE_NPM_PREFIX  MCP 组件安装位置，默认 $HOME\.bridge-npm
#   BRIDGE_HOME        token/日志/cloudflared 存放位置，默认 $HOME\.bridge

$ErrorActionPreference = "Stop"

$NpmPrefix  = if ($env:BRIDGE_NPM_PREFIX) { $env:BRIDGE_NPM_PREFIX } else { Join-Path $HOME ".bridge-npm" }
$BridgeHome = if ($env:BRIDGE_HOME)       { $env:BRIDGE_HOME }       else { Join-Path $HOME ".bridge" }
$BinDir     = Join-Path $BridgeHome "bin"

Write-Host "== cmd-bridge 安装 (Windows) =="
Write-Host "MCP 组件目录: $NpmPrefix"
Write-Host "运行目录:     $BridgeHome"
Write-Host ""

# ---------- 1. 前置检查 ----------
Write-Host "[1/3] 检查环境"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 node，请先安装 Node.js >= 18 (https://nodejs.org)" -ForegroundColor Red
    exit 1
}
Write-Host "node $(node -v) / npm $(npm -v)"
New-Item -ItemType Directory -Force -Path $NpmPrefix, $BinDir | Out-Null

# ---------- 2. 安装 MCP 组件 ----------
Write-Host ""
Write-Host "[2/3] 安装 MCP 组件"
$sgBin = Join-Path $NpmPrefix "supergateway.cmd"
$dcBin = Join-Path $NpmPrefix "desktop-commander.cmd"
if ((Test-Path $sgBin) -and (Test-Path $dcBin)) {
    Write-Host "已安装，跳过（要重装请先删除 $NpmPrefix）"
} else {
    npm install -g --prefix "$NpmPrefix" supergateway "@wonderwhy-er/desktop-commander"
    if (-not (Test-Path $dcBin)) {
        npm rebuild -g --prefix "$NpmPrefix" "@wonderwhy-er/desktop-commander"
    }
}
if (-not (Test-Path $sgBin)) { Write-Host "错误: supergateway 安装失败" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $dcBin)) { Write-Host "错误: desktop-commander 安装失败" -ForegroundColor Red; exit 1 }
Write-Host "supergateway      -> $sgBin"
Write-Host "desktop-commander -> $dcBin"

# ---------- 3. 安装 cloudflared ----------
Write-Host ""
Write-Host "[3/3] 安装 cloudflared"
$cfExe = Join-Path $BinDir "cloudflared.exe"
if (Test-Path $cfExe) {
    Write-Host "已存在，跳过（要升级请删除 $cfExe 后重跑）"
} else {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        "ARM64" { "arm64" }
        default { "amd64" }
    }
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
    Write-Host "下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $cfExe -UseBasicParsing
}
& $cfExe --version

Write-Host ""
Write-Host "安装完成。下一步："
Write-Host "  powershell -ExecutionPolicy Bypass -File start.ps1"
