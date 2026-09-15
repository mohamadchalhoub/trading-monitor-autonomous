# Manual start script for the gold DEMO stack - backend API, collector, and
# the standalone gold-execution scheduler. Deliberately NOT a Windows
# Scheduled Task / service / startup shortcut (explicitly out of scope for
# this work) - run it by hand from a PowerShell window whenever you want the
# stack up, same posture as collector/scripts/run.ps1 already uses for the
# collector alone.
#
# STABLE (non-watching) run mode: builds the backend once (tsc -> dist/),
# then runs the COMPILED output directly (node dist/src/main.js,
# node dist/scripts/gold-execution-scheduler.js) - the same commands
# package.json's own "start" script uses, never `npm run dev`/tsx's
# file-watching dev mode. A watcher that respawns on every file change is
# fine for active development but is NOT what you want for a stable manual
# demo session: this session's own repeated "the backend silently stopped
# listening after a respawn, with no captured logs" problem was exactly
# that failure mode. This script exists so a demo session survives without
# that risk. Both backend and scheduler processes are started with their
# stdout/stderr redirected to a real log file (see $logDir below) precisely
# so a crash THIS time leaves a trail, unlike the unlogged interactive
# consoles this session kept losing.
#
# PID/lock files live under .gold-demo-runtime/ at the repo root so
# status-gold-demo.ps1 / stop-gold-demo.ps1 can find exactly these
# processes and nothing else - never a blanket node/python match.
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
        Write-Host "$name already running (pid $(Get-Content $pidPath)) - skipping. Use stop-gold-demo.ps1 first if you want to restart it."
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

# --- Build once, stable, before starting anything (tsc -> dist/) ---
Write-Host "Building backend (tsc)..."
Push-Location $backendRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "backend build failed (exit $LASTEXITCODE) - not starting anything. Check the build output above." }
} finally {
    Pop-Location
}
$backendEntry = Join-Path $backendRoot 'dist\src\main.js'
$schedulerEntry = Join-Path $backendRoot 'dist\scripts\gold-execution-scheduler.js'
if (-not (Test-Path $backendEntry)) { throw "Expected compiled entry point not found: $backendEntry - build output layout may have changed, check dist/ manually." }
if (-not (Test-Path $schedulerEntry)) { throw "Expected compiled entry point not found: $schedulerEntry - build output layout may have changed, check dist/ manually." }
Write-Host "Build OK. Compiled entry points confirmed present."

# --- Refuse to start if the backend port is already bound (someone/something else already up) ---
$backendPort = 8420
$envPortLine = Get-Content (Join-Path $backendRoot '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' }
if ($envPortLine) {
    $parsed = ($envPortLine -split '=', 2)[1].Trim()
    if ($parsed) { $backendPort = [int]$parsed }
}
$portInUse = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue
$backendPidFile = Join-Path $runtimeDir 'backend.pid'
# Port-listening alone is not sufficient: a stuck-but-alive process holds no
# listening socket yet still exists and must not be duplicated - checked
# here too (both the stable dist/src/main.js command line AND the older
# dev-mode ts-node-dev, in case that's what's actually running right now).
$backendProcessRunning = (Test-CommandLineRunning 'dist\src\main.js') -or (Test-CommandLineRunning 'ts-node-dev')
if (($portInUse -or $backendProcessRunning) -and -not (Test-PidAlive $backendPidFile)) {
    Write-Warning "Backend port $backendPort is bound and/or a backend process is already running, but NOT tracked by this script's lock file (started by hand, in another window). Not starting a duplicate backend. Check status-gold-demo.ps1 / netstat manually if unsure - if the port is not listening AND a process is running, it may be crashed/stuck; check its log (or console) before restarting it."
} else {
    Start-Component -name 'backend' -pidFile 'backend.pid' -workDir $backendRoot `
        -exe 'node.exe' -argString 'dist\src\main.js' -logFile (Join-Path $logDir 'backend.log')
}

Start-Component -name 'collector' -pidFile 'collector.pid' -workDir $collectorRoot `
    -exe 'powershell.exe' -argString '-NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1' `
    -logFile (Join-Path $logDir 'collector.log') -cmdLineMatch 'main.py'

Start-Component -name 'gold-scheduler' -pidFile 'gold-scheduler.pid' -workDir $backendRoot `
    -exe 'node.exe' -argString 'dist\scripts\gold-execution-scheduler.js' -logFile (Join-Path $logDir 'gold-scheduler.log') `
    -cmdLineMatch 'gold-execution-scheduler'

Write-Host ""
Write-Host "Frontend is NOT started by this script (separate dev workflow - run 'npm run dev' in frontend/ yourself if you need the dashboard)."
Write-Host "Run status-gold-demo.ps1 to check on everything."
