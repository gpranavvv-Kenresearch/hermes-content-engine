param(
  [ValidateSet('fb','li','both')][string]$Platform = 'both',
  [switch]$WriteSheet
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $project 'output\schedule'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("generation-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $logFile -ErrorAction Stop | Out-Null
Push-Location -LiteralPath $project
try {
  $platforms = if ($Platform -eq 'both') { @('fb','li') } else { @($Platform) }
  foreach ($current in $platforms) {
    $args = @('run','hce:next','--','--platform',$current)
    if ($WriteSheet) { $args += '--write-sheet' }
    & npm.cmd @args
    if ($LASTEXITCODE -ne 0) { throw "Generation for $current failed with exit code $LASTEXITCODE" }
  }
} finally {
  Pop-Location
  Stop-Transcript | Out-Null
}
