# cmd-bridge 安装脚本（Windows, PowerShell 5.1+）
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 安装内容：
#   1) supergateway + desktop-commander -> $NpmPrefix
#   2) cloudflared                      -> $BridgeHome\bin
#   3) ngrok                            -> $BridgeHome\bin
#
# 两个隧道二进制各自独立安装：任一失败只警告、不阻断另一个。
#
# 可用环境变量：
#   BRIDGE_NPM_PREFIX  MCP 组件安装位置，默认 $HOME\.bridge-npm
#   BRIDGE_HOME        token/日志/隧道二进制存放位置，默认 $HOME\.bridge

$ErrorActionPreference = "Stop"

$NpmPrefix  = if ($env:BRIDGE_NPM_PREFIX) { $env:BRIDGE_NPM_PREFIX } else { Join-Path $HOME ".bridge-npm" }
$BridgeHome = if ($env:BRIDGE_HOME)       { $env:BRIDGE_HOME }       else { Join-Path $HOME ".bridge" }
$BinDir     = Join-Path $BridgeHome "bin"

Write-Host "== cmd-bridge 安装 (Windows) =="
Write-Host "MCP 组件目录: $NpmPrefix"
Write-Host "运行目录:     $BridgeHome"
Write-Host ""

# ---------- 1. 前置检查 ----------
Write-Host "[1/4] 检查环境"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 node，请先安装 Node.js >= 18 (https://nodejs.org)" -ForegroundColor Red
    exit 1
}
Write-Host "node $(node -v) / npm $(npm -v)"
New-Item -ItemType Directory -Force -Path $NpmPrefix, $BinDir | Out-Null

# ---------- 2. 安装 MCP 组件 ----------
Write-Host ""
Write-Host "[2/4] 安装 MCP 组件"
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

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { "arm64" }
    default { "amd64" }
}

# ---------- 3. 安装 cloudflared ----------
Write-Host ""
Write-Host "[3/4] 安装 cloudflared"
$cfExe = Join-Path $BinDir "cloudflared.exe"
if (Test-Path $cfExe) {
    Write-Host "已存在，跳过（要升级请删除 $cfExe 后重跑）"
} else {
    $cfUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
    Write-Host "下载 $cfUrl"
    try {
        Invoke-WebRequest -Uri $cfUrl -OutFile $cfExe -UseBasicParsing
    } catch {
        Write-Host "警告: cloudflared 未装上，可改用 BRIDGE_TUNNEL=ngrok（不影响后续步骤）" -ForegroundColor Yellow
        Remove-Item $cfExe -Force -ErrorAction SilentlyContinue
    }
}
if (Test-Path $cfExe) { & $cfExe --version }

# ---------- 4. 安装 ngrok ----------
Write-Host ""
Write-Host "[4/4] 安装 ngrok"
$ngExe = Join-Path $BinDir "ngrok.exe"
if (Test-Path $ngExe) {
    Write-Host "已存在，跳过（要升级请删除 $ngExe 后重跑）"
} else {
    $ngUrl = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-$arch.zip"
    Write-Host "下载 $ngUrl"
    $zip = Join-Path $env:TEMP "ngrok-v3-stable-windows-$arch.zip"
    $ext = Join-Path $env:TEMP "ngrok-extract"
    try {
        Invoke-WebRequest -Uri $ngUrl -OutFile $zip -UseBasicParsing
        if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $ext -Force
        Copy-Item (Join-Path $ext "ngrok.exe") $ngExe -Force
    } catch {
        Write-Host "警告: ngrok 未装上，可继续用默认的 cloudflared" -ForegroundColor Yellow
        Remove-Item $ngExe -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (Test-Path $ngExe) { & $ngExe --version }

# ---------- 汇总 ----------
$tunnels = @()
if (Test-Path $cfExe) { $tunnels += "cloudflare" }
if (Test-Path $ngExe) { $tunnels += "ngrok" }

Write-Host ""
Write-Host "== 安装完成 =="
Write-Host "MCP 组件: supergateway / desktop-commander -> $NpmPrefix"
if ($tunnels.Count -gt 0) {
    Write-Host "可用隧道: $($tunnels -join ' ')"
} else {
    Write-Host "可用隧道: 无（只能 BRIDGE_TUNNEL=none 本机使用）"
}
Write-Host ""
Write-Host "下一步："
Write-Host "  powershell -ExecutionPolicy Bypass -File start.ps1     # 默认走 cloudflare"
Write-Host "  `$env:BRIDGE_TUNNEL='ngrok'; powershell -ExecutionPolicy Bypass -File start.ps1"
Write-Host "  `$env:BRIDGE_TUNNEL='none';  powershell -ExecutionPolicy Bypass -File start.ps1"
Write-Host ""
Write-Host "提示：ngrok 需要 authtoken（https://dashboard.ngrok.com/get-started/your-authtoken）"
Write-Host "  一次性写入配置: & `"$ngExe`" config add-authtoken <TOKEN>"
Write-Host "  或每次启动前:   `$env:NGROK_AUTHTOKEN='<TOKEN>'"
