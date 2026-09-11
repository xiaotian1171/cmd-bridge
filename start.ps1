# cmd-bridge 启动脚本（Windows, PowerShell 5.1+）
#
#   powershell -ExecutionPolicy Bypass -File start.ps1
#
# 可用环境变量：
#   BRIDGE_TOKEN       路径 token，不传则复用 $HOME\.bridge\token，首次自动生成
#   BRIDGE_PORT        supergateway 端口，默认 8000
#   BRIDGE_MODE        full（默认，26 工具全开）| safe（白名单 6 个终端工具）
#   BRIDGE_TUNNEL      cloudflare（默认）| ngrok | none
#   BRIDGE_NO_TUNNEL   旧参数，设为 1 等价于 BRIDGE_TUNNEL=none
#   NGROK_AUTHTOKEN    BRIDGE_TUNNEL=ngrok 时用；ngrok 自身也会读取该变量
#   BRIDGE_NPM_PREFIX  MCP 组件安装位置，默认 $HOME\.bridge-npm
#   BRIDGE_HOME        token/日志存放位置，默认 $HOME\.bridge
#
# 与 Linux 端的差异：
#   - 引擎/隧道用 Start-Process 常驻，注销不会像 SSH 会话那样被杀
#   - 桌面版 Windows 是单用户系统，桥拿到的是你当前用户的全部权限
#     （含桌面文件），比 Linux 多用户环境下 token 泄露的后果更重，务必自用

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$NpmPrefix  = if ($env:BRIDGE_NPM_PREFIX) { $env:BRIDGE_NPM_PREFIX } else { Join-Path $HOME ".bridge-npm" }
$BridgeHome = if ($env:BRIDGE_HOME)       { $env:BRIDGE_HOME }       else { Join-Path $HOME ".bridge" }
$LogDir     = Join-Path $BridgeHome "logs"

$Port   = if ($env:BRIDGE_PORT)   { $env:BRIDGE_PORT }   else { "8000" }
$Mode   = if ($env:BRIDGE_MODE)   { $env:BRIDGE_MODE }   else { "full" }
$Tunnel = if ($env:BRIDGE_TUNNEL) { $env:BRIDGE_TUNNEL } else { "cloudflare" }
if ($env:BRIDGE_NO_TUNNEL -eq "1") { $Tunnel = "none" }
if ($Tunnel -notin @("cloudflare", "ngrok", "none")) {
    Write-Host "错误: BRIDGE_TUNNEL 只能是 cloudflare | ngrok | none（当前: $Tunnel）" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---------- 前置检查 ----------
$SgBin = Join-Path $NpmPrefix "supergateway.cmd"
$DcBin = Join-Path $NpmPrefix "desktop-commander.cmd"
if (-not (Test-Path $SgBin)) { Write-Host "未安装 supergateway，请先执行 install.ps1" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $DcBin)) { Write-Host "未安装 desktop-commander，请先执行 install.ps1" -ForegroundColor Red; exit 1 }

# ---------- token ----------
$TokenFile = Join-Path $BridgeHome "token"
if ($env:BRIDGE_TOKEN) {
    $Token = $env:BRIDGE_TOKEN
} elseif (Test-Path $TokenFile) {
    $Token = (Get-Content $TokenFile -Raw).Trim()
} else {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 16
    $rng.GetBytes($bytes)
    $Token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-Content -Path $TokenFile -Value $Token -NoNewline
    Write-Host "已生成新 token 并保存到 $TokenFile"
}

# ---------- 选择执行引擎 ----------
if ($Mode -eq "safe") {
    $FilterProxy = Join-Path $ScriptDir "filter-proxy.js"
    if (-not (Test-Path $FilterProxy)) { Write-Host "错误: BRIDGE_MODE=safe 需要 $FilterProxy" -ForegroundColor Red; exit 1 }
    $Engine     = "node $FilterProxy"
    $EngineDesc = "filter-proxy.js 白名单代理（终端类 6 个工具）"
} else {
    $Engine     = $DcBin
    $EngineDesc = "desktop-commander（26 个工具全开）"
}

# ---------- 停掉旧进程 ----------
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "supergateway|desktop-commander|filter-proxy" } | ForEach-Object {
    Write-Host "停止旧进程 PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# ---------- 启动协议转换层 ----------
$SgArgs = @("--stateful", "--cors", "--stdio", $Engine,
            "--streamableHttpPath", "/mcp/$Token",
            "--port", $Port, "--outputTransport", "streamableHttp")
$SgLog = Join-Path $LogDir "sg.log"
$SgProc = Start-Process -FilePath $SgBin -ArgumentList $SgArgs -WindowStyle Hidden -RedirectStandardOutput $SgLog -RedirectStandardError (Join-Path $LogDir "sg.err.log") -PassThru

$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if ((Select-String -Path $SgLog -Pattern "Listening" -Quiet -ErrorAction SilentlyContinue) -or (($SgProc.HasExited -eq $false) -and ($i -ge 6))) { $ready = $true; break }
}
if (-not $ready) {
    Write-Host "启动失败，日志：" -ForegroundColor Red
    Get-Content $SgLog -Tail 20
    exit 1
}
Write-Host "OK 桥已就绪（$EngineDesc）"

$LocalUrl = "http://localhost:$Port/mcp/$Token"

# ---------- 启动公网隧道 ----------
$PublicUrl = ""
switch ($Tunnel) {
    "none" {
        Write-Host "（BRIDGE_TUNNEL=none，只监听本机）"
    }

    "cloudflare" {
        $CfExe = Join-Path $BridgeHome "bin\cloudflared.exe"
        if (-not (Test-Path $CfExe)) {
            Write-Host "未找到 cloudflared（$CfExe），请先执行 install.ps1，或改用 BRIDGE_TUNNEL=ngrok" -ForegroundColor Red
            exit 1
        }

        Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1

        $CfLog = Join-Path $LogDir "cf.log"
        $CfErr = Join-Path $LogDir "cf.err.log"
        if (Test-Path $CfLog) { Clear-Content $CfLog -ErrorAction SilentlyContinue }
        $CfProc = Start-Process -FilePath $CfExe -ArgumentList @("tunnel", "--url", "http://localhost:$Port", "--no-autoupdate") -WindowStyle Hidden -RedirectStandardOutput $CfLog -RedirectStandardError $CfErr -PassThru

        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 2
            $hit = Select-String -Path $CfLog, $CfErr -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { $PublicUrl = $hit.Matches[0].Value; break }
        }
        if (-not $PublicUrl) { Write-Host "警告: 隧道地址未取到，稍后查看 $CfLog" -ForegroundColor Yellow }
    }

    "ngrok" {
        $NgExe = Join-Path $BridgeHome "bin\ngrok.exe"
        if (-not (Test-Path $NgExe)) {
            Write-Host "未找到 ngrok（$NgExe），请先执行 install.ps1" -ForegroundColor Red
            exit 1
        }

        $NgArgs = @("http", $Port, "--log", "stdout", "--log-format", "logfmt")

        Get-CimInstance Win32_Process -Filter "Name='ngrok.exe'" | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1

        $NgLog = Join-Path $LogDir "ng.log"
        $NgErr = Join-Path $LogDir "ng.err.log"
        if (Test-Path $NgLog) { Clear-Content $NgLog -ErrorAction SilentlyContinue }
        $NgProc = Start-Process -FilePath $NgExe -ArgumentList $NgArgs -WindowStyle Hidden -RedirectStandardOutput $NgLog -RedirectStandardError $NgErr -PassThru

        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 2
            # logfmt 成功行形如: ... msg="started tunnel" ... url=https://xxxx.ngrok-free.app
            $hit = Select-String -Path $NgLog, $NgErr -Pattern "url=(https://[a-z0-9.-]+)" -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { $PublicUrl = $hit.Matches[0].Groups[1].Value }
            # 兜底：只认 ngrok 自有域名后缀，避免误抓日志里的 dashboard.ngrok.com
            if (-not $PublicUrl) {
                $hit2 = Select-String -Path $NgLog, $NgErr -Pattern "https://[a-z0-9-]+\.ngrok(-free)?\.(app|dev|io|pizza|pro)" -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($hit2) { $PublicUrl = $hit2.Matches[0].Value }
            }
            if ($PublicUrl) { break }
            # 鉴权类错误不会自愈，提前退出
            if (Select-String -Path $NgLog, $NgErr -Pattern "ERR_NGROK_\d+" -Quiet -ErrorAction SilentlyContinue) { break }
        }
        if (-not $PublicUrl) {
            Write-Host "警告: 隧道地址未取到，ngrok 报错：" -ForegroundColor Yellow
            Select-String -Path $NgLog, $NgErr -Pattern "lvl=crit|^ERROR" -ErrorAction SilentlyContinue | Select-Object -First 3 | ForEach-Object { Write-Host "  $($_.Line)" }
            Write-Host "  多数情况是缺 authtoken：& `"$NgExe`" config add-authtoken <TOKEN>，或启动前 `$env:NGROK_AUTHTOKEN='<TOKEN>'"
            Write-Host "  完整日志：$NgLog"
        }
    }
}

# ---------- 输出 ----------
Write-Host ""
Write-Host "本地入口: $LocalUrl"
if ($PublicUrl) {
    Write-Host "公网入口: $PublicUrl/mcp/$Token"
    Write-Host "隧道类型: $Tunnel"
}
Write-Host ""
Write-Host "客户端配置（把 url 换成上面的入口）:"
$url = if ($PublicUrl) { "$PublicUrl/mcp/$Token" } else { $LocalUrl }
@'
{
  "mcpServers": {
    "cmd-bridge": {
      "type": "streamable-http",
      "url": "REPLACE_ME"
    }
  }
}
'@ -replace "REPLACE_ME", $url | Write-Host
Write-Host ""
Write-Host "日志: $LogDir"
Write-Host "停止: powershell -ExecutionPolicy Bypass -File $ScriptDir\stop.ps1"
