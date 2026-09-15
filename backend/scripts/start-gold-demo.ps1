# Manual start script for the gold DEMO stack  -  backend API, collector, and
# the standalone gold-execution scheduler. Deliberately NOT a Windows
# Scheduled Task / service / startup shortcut (explicitly out of scope for
# this work)  -  run it by hand from a PowerShell window whenever you want the
# stack up, same posture as collector/scripts/run.ps1 already uses for the
# collector alone.
#
# PID/lock files live under .gold-demo-runtime/ at the repo root so
# status-gold-demo.ps1 / stop-gold-demo.ps1 can find exactly these
# processes and nothing else  -  never a blanket node/python match.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\start-gold-demo.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backendRoot = Join-Path $repoRoot 'backend'
$collectorRoot = Join-Path $repoRoot 'collector'
$runtimeDir = Join-Path $repoRoot '.gold-demo-runtime'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-PidAlive($pidPath) {
    if (-not (Test-Path $pidPath)) { return $false }
    $storedPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if (-not $storedPid) { return $false }
    $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    return $null -ne $proc
}

# Beyond our own lock files (which only catch processes THIS script itself
# started), also check for any node process whose command line already
# matches, by substring, one already running THAT THIS SCRIPT DID NOT
# START (e.g. launched by hand in another window) - lock files alone can't
# see those. Best-effort (CIM command-line matching), not a guarantee, but
# closes the most likely real double-launch case.
function Test-CommandLineRunning($matchSubstring) {
    $rows = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$matchSubstring*" }
    return @($rows).Count -gt 0
}

function Start-Component($name, $pidFile, $workDir, $exe, $argString, $logFile, $cmdLineMatch) {
    $pidPath = Join-Path $runtimeDir $pidFile
    if (Test-PidAlive $pidPath) {
        Write-Host "$name already running (pid $(Get-Content $pidPath))  -  skipping. Use stop-gold-demo.ps1 first if you want to restart it."
        return
    }
    if ($cmdLineMatch -and (Test-CommandLineRunning $cmdLineMatch)) {
        Write-Warning "$name : a matching process (command line contains '$cmdLineMatch') is already running but NOT tracked by this script's lock file (started by hand, in another window). Skipping to avoid a duplicate - stop it manually first if you want this script to manage it instead."
        return
    }
    Write-Host "Starting $name ..."
    $proc = Start-Process -FilePath $exe -ArgumentList $argString -WorkingDirectory $workDir `
        -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -WindowStyle Hidden -PassThru
    Set-Content -Path $pidPath -Value $proc.Id
    Write-Host "$name started, pid=$($proc.Id), log=$logFile"
}

# --- Refuse to start if the backend port is already bound (someone/something else already up) ---
$backendPort = 8420
$envPortLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' }
if ($envPortLine) {
    $parsed = ($envPortLine -split '=', 2)[1].Trim()
    if ($parsed) { $backendPort = [int]$parsed }
}
$portInUse = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue
$backendPidFile = Join-Path $runtimeDir 'backend.pid'
# Port-listening alone is not sufficient: a stuck/crashed-but-still-alive
# `ts-node-dev` process holds no listening socket yet still exists and must
# not be duplicated - checked here too, not just the port.
$backendProcessRunning = Test-CommandLineRunning 'ts-node-dev'
if (($portInUse -or $backendProcessRunning) -and -not (Test-PidAlive $backendPidFile)) {
    Write-Warning "Backend port $backendPort is bound and/or a ts-node-dev process is already running, but NOT tracked by this script's lock file (started by hand, in another window). Not starting a duplicate backend. Check status-gold-demo.ps1 / netstat manually if unsure - if the port is not listening AND ts-node-dev is running, it may be crashed/stuck; check its own console before restarting it."
} else {
    Start-Component -name 'backend' -pidFile 'backend.pid' -workDir $backendRoot `
        -exe 'npm.cmd' -argString 'run dev' -logFile (Join-Path $logDir 'backend.log')
}

Start-Component -name 'collector' -pidFile 'collector.pid' -workDir $collectorRoot `
    -exe 'powershell.exe' -argString '-NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1' `
    -logFile (Join-Path $logDir 'collector.log') -cmdLineMatch 'main.py'

Start-Component -name 'gold-scheduler' -pidFile 'gold-scheduler.pid' -workDir $backendRoot `
    -exe 'npm.cmd' -argString 'run gold-execution:scheduler' -logFile (Join-Path $logDir 'gold-scheduler.log') `
    -cmdLineMatch 'gold-execution-scheduler'

Write-Host ""
Write-Host "Frontend is NOT started by this script (separate dev workflow  -  run 'npm run dev' in frontend/ yourself if you need the dashboard)."
Write-Host "Run status-gold-demo.ps1 to check on everything."
