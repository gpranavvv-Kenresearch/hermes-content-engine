param(
  [ValidateRange(1,72)][int]$Hours = 18,
  [ValidateRange(10,3600)][int]$RetrySeconds = 300,
  [ValidateRange(10,3600)][int]$IdleSeconds = 600,
  [switch]$Check,
  [switch]$Status,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nightRoot = Join-Path $project 'output\supervisor-hermes\overnight'
$statePath = Join-Path $nightRoot 'continuous-state.json'
$logPath = Join-Path $nightRoot 'continuous.log'

function Get-UnfinishedTextBatch {
  if (!(Test-Path -LiteralPath $nightRoot)) { return $null }
  $plans = @(Get-ChildItem -LiteralPath $nightRoot -Filter '*.json' -File | ForEach-Object {
    try {
      $p = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
      if ($p.version -eq 1 -and $p.writeSheet -eq $true -and $p.status -in @('running','incomplete','blocked') -and $p.id -match '^[a-zA-Z0-9_-]{1,80}$') {
        [pscustomobject]@{ Id = $p.id; Status = $p.status; UpdatedAt = [int64]$p.updatedAt; Reason = [string]$p.reason }
      }
    } catch { }
  })
  return $plans | Sort-Object UpdatedAt -Descending | Select-Object -First 1
}
function Write-ContinuousState([string]$phase, [string]$batch, [string]$message) {
  $record = [ordered]@{ pid = $PID; phase = $phase; batch = $batch; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); message = $message }
  $temp = "$statePath.$PID.tmp"
  [IO.File]::WriteAllText($temp, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $temp -Destination $statePath -Force
  $line = '[{0}] {1}: {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $phase, $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Output $line
}
function Wait-Continuous([int]$seconds, [string]$phase, [string]$batch, [string]$message) {
  $until = [DateTimeOffset]::UtcNow.AddSeconds($seconds)
  while ([DateTimeOffset]::UtcNow -lt $until) {
    Write-ContinuousState $phase $batch $message
    Start-Sleep -Seconds ([Math]::Min(30, [Math]::Max(1, [int]($until - [DateTimeOffset]::UtcNow).TotalSeconds)))
  }
}

if ($Status) {
  if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw }
  else { Write-Output 'Continuous text runner has not started yet.' }
  return
}
if ($Check) {
  $next = Get-UnfinishedTextBatch
  [pscustomobject]@{ Project = $project; NextBatch = $next; HoursPerWorker = $Hours; RetrySeconds = $RetrySeconds; IdleSeconds = $IdleSeconds; HoldsLaptopAwake = $false } | ConvertTo-Json -Depth 4
  return
}

New-Item -ItemType Directory -Path $nightRoot -Force | Out-Null
$lease = $null
try {
  # Exclusive handle survives sleep; a crashed process releases it automatically.
  try { $lease = [IO.File]::Open((Join-Path $nightRoot 'continuous.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch [IO.IOException] { Write-Output 'Continuous text runner is already running; no duplicate started.'; exit 0 }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $runner = Join-Path $project 'supervisor-hermes\src\overnight-cli.ts'
  Push-Location -LiteralPath $project
  try {
    for (;;) {
      $batch = ''
      try {
        $writer = Join-Path $nightRoot 'writer.lock'
        if (Test-Path -LiteralPath $writer) {
          $owner = Get-Content -LiteralPath $writer -Raw | ConvertFrom-Json
          if ($owner.pid -and (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) {
            if ($Once) { Write-Output "Existing text writer PID $($owner.pid); leaving it running."; break }
            Wait-Continuous 60 'waiting-for-worker' '' "Text writer PID $($owner.pid) is active; waiting without starting a duplicate."
            continue
          }
        }
        $unfinished = Get-UnfinishedTextBatch
        if ($unfinished) {
          $batch = $unfinished.Id
          $workerArgs = @('--resume',$batch,'--extend-hours',"$Hours")
          $message = "Resuming $batch; saved approved text and completed counts are preserved."
        } else {
          $batch = 'continuous_' + (Get-Date -Format 'yyyyMMdd_HHmmss_fff')
          $workerArgs = @('--id',$batch,'--x','60','--fb','75','--li','45','--tumblr','60','--hours',"$Hours",'--write-sheet')
          $message = "Starting $batch; next pending Sheet rows, X 60 / FB 75 / LI 45 / Tumblr 60."
        }
        Write-ContinuousState 'running' $batch $message
        # Existing watchdog handles stalled calls and sleep-related timeouts.
        # A fresh deadline is supplied on EVERY resume; no permanent time-limit stop.
        & $node --import tsx $runner @workerArgs 1>> (Join-Path $nightRoot 'continuous-worker.stdout.log') 2>> (Join-Path $nightRoot 'continuous-worker.stderr.log')
        $workerExit = $LASTEXITCODE
        if ($Once) { Write-ContinuousState 'one-pass-ended' $batch "Worker exited $workerExit."; break }
        if ($workerExit -eq 0) {
          Wait-Continuous 15 'next-batch' $batch 'Batch complete; looking for the next pending rows.'
        } else {
          $wait = $RetrySeconds
          $saved = Get-Content -LiteralPath (Join-Path $nightRoot "$batch.json") -Raw | ConvertFrom-Json
          if ($saved.reason -match 'No .*rows|no .*candidate|exhaust') { $wait = $IdleSeconds }
          Wait-Continuous $wait 'retry-wait' $batch "Worker exited $workerExit. $($saved.reason) Will retry the saved batch automatically."
        }
      } catch {
        if ($Once) { throw }
        Wait-Continuous $RetrySeconds 'retry-wait' $batch "Runner error: $($_.Exception.Message). Retrying automatically; validation gates stay enabled."
      }
    }
  } finally { Pop-Location }
} finally { if ($lease) { $lease.Dispose() } }
