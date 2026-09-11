# cmd-bridge 停止脚本（Windows, PowerShell 5.1+）
#
#   powershell -ExecutionPolicy Bypass -File stop.ps1

$ErrorActionPreference = "SilentlyContinue"

Write-Host "停止 supergateway / desktop-commander / cloudflared / ngrok..."
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match "supergateway|desktop-commander|filter-proxy|cloudflared tunnel|ngrok http"
} | ForEach-Object {
    Write-Host "停止 PID $($_.ProcessId) ($($_.Name))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "完成。token 与日志保留在 `$env:BRIDGE_HOME 或 $HOME\.bridge。"
