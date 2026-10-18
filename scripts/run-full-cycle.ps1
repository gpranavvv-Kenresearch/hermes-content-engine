param(
  [ValidateRange(1,72)][int]$Hours = 18,
  [switch]$SkipFeedback,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nightRoot = Join-Path $project 'output\supervisor-hermes\overnight'
$lockFile = Join-Path $nightRoot 'writer.lock'

Push-Location -LiteralPath $project
try {
  if (Test-Path -LiteralPath $lockFile) {
    try {
      $owner = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
      if ($owner.pid -and (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) {
        Write-Output "An overnight generation batch is already running under PID $($owner.pid). No duplicate worker was started."
        exit 0
      }
    } catch {
      Write-Warning 'The existing writer lock could not be verified. The overnight runner will validate or reclaim it safely.'
    }
  }

  $unfinished = $null
  if (Test-Path -LiteralPath $nightRoot) {
    $unfinished = Get-ChildItem -LiteralPath $nightRoot -Filter '*.json' -File |
      ForEach-Object {
        try {
          $plan = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
          if ($plan.writeSheet -eq $true -and $plan.status -in @('running','incomplete')) {
            [pscustomobject]@{ Id = $plan.id; UpdatedAt = [int64]$plan.updatedAt; Status = $plan.status }
          }
        } catch { }
      } |
      Sort-Object UpdatedAt -Descending |
      Select-Object -First 1
  }

  if (!$unfinished) {
    Write-Output 'Preflight: checking Hermes and enough pending rows for X 60, Facebook 75, LinkedIn 45 and Tumblr 60.'
    # Check mode never enables the sleep hold, so do not forward the KeepAwake switch
    # through a child PowerShell process because Windows PowerShell treats it as a string.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\run-overnight.ps1" -X 60 -Facebook 75 -LinkedIn 45 -Tumblr 60 -Hours $Hours -WriteSheet -Check
    if ($LASTEXITCODE -ne 0) { throw "Generation preflight failed with exit code $LASTEXITCODE." }
  }

  if (!$SkipFeedback) {
    Write-Output 'Running all-platform performance analysis and replacing future-post guidance.'
    & npm.cmd run performance:auto-all
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "One or more feedback loops failed. Generation will continue with each failed platform's previous valid guidance."
    }
  }

  $background = !$Foreground
  $launch = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"$PSScriptRoot\run-overnight.ps1")
  if ($unfinished) {
    Write-Output "Resuming saved batch $($unfinished.Id) ($($unfinished.Status)); targets and completed counts are preserved."
    $launch += @('-Resume',"$($unfinished.Id)",'-ExtendHours',"$Hours",'-WriteSheet')
  } else {
    Write-Output 'Starting a new 240-post batch: X 60, Facebook 75, LinkedIn 45 and Tumblr 60.'
    $launch += @('-X','60','-Facebook','75','-LinkedIn','45','-Tumblr','60','-Hours',"$Hours",'-WriteSheet')
  }
  if ($background) { $launch += '-Background' }
  & powershell.exe @launch
  if ($LASTEXITCODE -ne 0) { throw "Generation launcher failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}
