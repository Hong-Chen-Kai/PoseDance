$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$taskArchive=Join-Path $taskRoot 'SMPL/local_data/computational_dancer/run-20261126-web-v1'
try {
    $taskResponse=Invoke-WebRequest -Uri 'http://127.0.0.1:8380/catalog.json' -UseBasicParsing -TimeoutSec 2
    if (($taskResponse.Content | ConvertFrom-Json).version -eq '1.0.0') { Write-Output 'PoseDance已在執行：http://127.0.0.1:8380/'; return }
} catch {}
$taskNode=(Get-Command node -ErrorAction Stop).Source
$taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$taskProcess=Start-Process -FilePath $taskNode -ArgumentList @((Join-Path $PSScriptRoot 'server.mjs')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskArchive "server-$taskStamp.stdout.log") -RedirectStandardError (Join-Path $taskArchive "server-$taskStamp.stderr.log") -PassThru
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskArchive 'server.pid')
Write-Output 'PoseDance正在啟動，請開啟：http://127.0.0.1:8380/'
Write-Output '本輪僅限本機，不提供LAN或外部存取。'
