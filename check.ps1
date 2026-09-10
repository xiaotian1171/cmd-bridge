# cmd-bridge 配置检查脚本（Windows, PowerShell 5.1+）
#
#   powershell -ExecutionPolicy Bypass -File check.ps1
#
# 检查 node / cloudflared / MCP 组件是否就绪、进程是否在跑。
# 可用环境变量与 start.ps1 相同（BRIDGE_NPM_PREFIX / BRIDGE_HOME / BRIDGE_TOKEN）。

$NpmPrefix  = if ($env:BRIDGE_NPM_PREFIX) { $env:BRIDGE_NPM_PREFIX } else { Join-Path $HOME ".bridge-npm" }
$BridgeHome = if ($env:BRIDGE_HOME)       { $env:BRIDGE_HOME }       else { Join-Path $HOME ".bridge" }

$SgBin = Join-Path $NpmPrefix "supergateway.cmd"
$DcBin = Join-Path $NpmPrefix "desktop-commander.cmd"
$CfExe = Join-Path $BridgeHome "bin\cloudflared.exe"
$TokenFile = Join-Path $BridgeHome "token"

Write-Host "== cmd-bridge 环境检查 =="
Write-Host ""
Write-Host "node / npm"
try { Write-Host ("  node {0} / npm {1}" -f (node -v), (npm -v)) } catch { Write-Host "  未安装 Node.js，请先安装 (>=18) https://nodejs.org" -ForegroundColor Red }
Write-Host "supergateway: $(if (Test-Path $SgBin) { $SgBin } else { '未安装 -> 先跑 install.ps1' })"
Write-Host "desktop-commander: $(if (Test-Path $DcBin) { $DcBin } else { '未安装 -> 先跑 install.ps1' })"
Write-Host "cloudflared: $(if (Test-Path $CfExe) { $CfExe } else { '未安装 -> 先跑 install.ps1' })"
Write-Host "token: $(if (Test-Path $TokenFile) { (Get-Content $TokenFile -Raw).Trim().Substring(0, 8) + '...' } else { '未生成 -> start.ps1 首次运行时自动生成' })"
Write-Host ""
Write-Host "进程:"
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "supergateway|desktop-commander|filter-proxy|cloudflared tunnel" } | ForEach-Object { Write-Host "  PID $($_.ProcessId)  $($_.Name)" }
Write-Host ""
if ($env:BRIDGE_TOKEN -or (Test-Path $TokenFile)) {
    $tok = if ($env:BRIDGE_TOKEN) { $env:BRIDGE_TOKEN } else { (Get-Content $TokenFile -Raw).Trim() }
    Write-Host "自测（服务在跑时执行）:"
    Write-Host "  Initialize-Mcp -Url `"http://localhost:8000/mcp/$tok`""
}
