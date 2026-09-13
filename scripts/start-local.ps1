$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$workRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '../../work'))
$runtimeRoot = Join-Path $workRoot 'runtime'
$nodeDir = (Get-ChildItem $runtimeRoot -Directory -Filter 'node-v24*-win-x64' | Select-Object -First 1).FullName
if (!$nodeDir) { throw 'Local portable runtime missing. Follow README for standard setup.' }
$env:PATH = "$nodeDir;$env:PATH"
Set-Location $projectRoot
$logDir = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pgCtl = Join-Path $runtimeRoot 'postgres16/package/native/bin/pg_ctl.exe'
$pgData = Join-Path $workRoot 'pgdata16'
& $pgCtl -D $pgData status | Out-Null
if ($LASTEXITCODE -ne 0) { & $pgCtl -D $pgData -l (Join-Path $workRoot 'postgres16.log') -o '-p 55432 -h 127.0.0.1' -w start; if ($LASTEXITCODE -ne 0) {throw 'PostgreSQL startup failed'} }
function PortOpen([int]$Port) { $socket = New-Object Net.Sockets.TcpClient; try {$socket.Connect('127.0.0.1',$Port); return $true} catch {return $false} finally {$socket.Dispose()} }
if (!(PortOpen 56379)) { $redis = (Get-ChildItem (Join-Path $runtimeRoot 'redis') -Recurse -Filter redis-server.exe | Select-Object -First 1).FullName; Start-Process $redis -ArgumentList '--bind 127.0.0.1 --port 56379 --appendonly no' -WorkingDirectory (Split-Path $redis) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'redis.log') -RedirectStandardError (Join-Path $logDir 'redis.err') | Out-Null }
$node = Join-Path $nodeDir 'node.exe'
if (!(PortOpen 3100)) { Start-Process $node -ArgumentList 'dist/apps/api/src/main.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'api.log') -RedirectStandardError (Join-Path $logDir 'api.err') | Out-Null }
if (!(PortOpen 5173)) { Start-Process $node -ArgumentList 'node_modules/vite/bin/vite.js --config apps/web/vite.config.ts' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'web.log') -RedirectStandardError (Join-Path $logDir 'web.err') | Out-Null }
$workerPidFile = Join-Path $logDir 'worker.pid'
$workerRunning = $false
if (Test-Path -LiteralPath $workerPidFile) { $savedWorkerPid = [int](Get-Content -LiteralPath $workerPidFile); $savedWorker = Get-CimInstance Win32_Process -Filter "ProcessId=$savedWorkerPid" -ErrorAction SilentlyContinue; $workerRunning = $savedWorker -and $savedWorker.ExecutablePath -eq $node -and $savedWorker.CommandLine -like '*dist/apps/worker/src/main.js*' }
if (!$workerRunning) { $startedWorker = Start-Process $node -ArgumentList 'dist/apps/worker/src/main.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'worker.log') -RedirectStandardError (Join-Path $logDir 'worker.err') -PassThru; Set-Content -LiteralPath $workerPidFile -Value $startedWorker.Id }
Write-Output 'Local workspace: http://localhost:5173 . Login details: LOCAL_ACCESS.md'
