param(
  [string]$Structure = 'v1.3',
  [switch]$NoImage,
  [ValidateRange(10,3600)][int]$RestartSeconds = 60,
  [switch]$Check,
  [switch]$Status,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$blogRoot = Join-Path $project 'output\blog-supervisor'
$logPath = Join-Path $blogRoot 'continuous.log'
$cli = Join-Path $project 'browser-generation\blog-supervisor\src\cli.ts'

function Write-BlogLog([string]$phase, [string]$message) {
  $line = '[{0}] {1}: {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $phase, $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Output $line
}

$runArgs = @('run', '--loop', "--structure=$Structure")
if (-not $NoImage) { $runArgs += '--with-image' }

if ($Status) {
  $beat = Join-Path $blogRoot 'heartbeat.json'
  if (Test-Path -LiteralPath $beat) { Get-Content -LiteralPath $beat -Raw } else { Write-Output 'Continuous blog engine has not started yet.' }
  return
}
if ($Check) {
  [pscustomobject]@{ Project = $project; Cli = $cli; CliExists = (Test-Path -LiteralPath $cli); Arguments = ($runArgs -join ' '); RestartSeconds = $RestartSeconds; HoldsLaptopAwake = $false } | ConvertTo-Json -Depth 3
  return
}

New-Item -ItemType Directory -Path $blogRoot -Force | Out-Null
$lease = $null
try {
  # Exclusive handle survives sleep; a crashed process releases it automatically.
  try { $lease = [IO.File]::Open((Join-Path $blogRoot 'wrapper.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch [IO.IOException] { Write-Output 'Continuous blog engine is already running; no duplicate started.'; exit 0 }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Push-Location -LiteralPath $project
  try {
    for (;;) {
      try {
        Write-BlogLog 'running' ("node cli.ts " + ($runArgs -join ' '))
        & $node --import tsx $cli @runArgs 1>> (Join-Path $blogRoot 'continuous-worker.stdout.log') 2>> (Join-Path $blogRoot 'continuous-worker.stderr.log')
        $exit = $LASTEXITCODE
        if ($Once) { Write-BlogLog 'one-pass-ended' "Worker exited $exit."; break }
        # Exit 2 is the engine restarting itself after a stuck browser; anything else is an unexpected stop. Either way, start again.
        Write-BlogLog 'restart-wait' "Worker exited $exit. Starting again in $RestartSeconds seconds; saved state and approved drafts are kept."
      } catch {
        if ($Once) { throw }
        Write-BlogLog 'restart-wait' "Runner error: $($_.Exception.Message). Starting again in $RestartSeconds seconds."
      }
      Start-Sleep -Seconds $RestartSeconds
    }
  } finally { Pop-Location }
} finally { if ($lease) { $lease.Dispose() } }
