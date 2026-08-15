$ErrorActionPreference = 'Continue'
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$cmdline = $null
if ($conn) {
  $pidX = $conn.OwningProcess
  $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidX").CommandLine
  Write-Host "停止旧实例 (pid $pidX)..."
  Stop-Process -Id $pidX -Force
  Start-Sleep -Seconds 2
} else {
  Write-Host '端口 3080 没有在监听，直接启动...'
}
if (-not $cmdline) { $cmdline = '"node" "C:\Users\Tisitan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web' }
Write-Host "启动: $cmdline"
Start-Process cmd.exe -ArgumentList '/k', "title DSH Web && $cmdline" -WorkingDirectory "$env:USERPROFILE\Desktop"
$up = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if ($up) {
  Write-Host 'DSH Web 已就绪 (http://127.0.0.1:3080)'
  try {
    $state = (Invoke-WebRequest 'http://127.0.0.1:3080/live2d/state' -UseBasicParsing -TimeoutSec 5).Content
    Write-Host "Live2D 插件: $state"
  } catch { Write-Host 'Live2D 插件未响应，检查 cordis.patch.yml 的 insert 行' }
} else {
  Write-Host '等待超时，请查看新窗口的启动日志'
}
