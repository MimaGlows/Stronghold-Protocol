$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskNode = Join-Path $taskRoot '.runtime/node.exe'
$taskLogs = Join-Path $taskRoot 'logs'
& $taskNode (Join-Path $taskRoot 'tools/experimental-control.mjs') probe
if ($LASTEXITCODE -eq 0) { & $taskNode (Join-Path $taskRoot 'tools/experimental-control.mjs') status; return }
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
Start-Process -FilePath $taskNode -ArgumentList @('tools/experimental-server.mjs') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs 'experimental.stdout.log') -RedirectStandardError (Join-Path $taskLogs 'experimental.stderr.log') | Out-Null
Start-Sleep -Seconds 3
& $taskNode (Join-Path $taskRoot 'tools/experimental-control.mjs') status
