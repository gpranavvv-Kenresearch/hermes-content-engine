param(
  [Parameter(Mandatory)][ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$At,
  [ValidateSet('fb','li','both')][string]$Platform = 'both',
  [switch]$WriteSheet
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $project 'scripts\run-generation.ps1'
$safeRunner = $runner.Replace('"','')
$args = "-NoProfile -ExecutionPolicy Bypass -File `"$safeRunner`" -Platform $Platform"
if ($WriteSheet) { $args += ' -WriteSheet' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$taskName = 'Hermes Content Engine Generation'
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Generate Ken Research FB/LI text into the Hermes Content Engine' -Force | Out-Null
Write-Output "Registered $taskName at $At local machine time (platform=$Platform, sheetWrite=$WriteSheet)."
