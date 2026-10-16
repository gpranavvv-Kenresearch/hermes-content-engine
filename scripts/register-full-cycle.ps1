param(
  [Parameter(Mandatory)][ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$At,
  [ValidateRange(1,72)][int]$Hours = 18
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $project 'scripts\run-full-cycle.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Hours $Hours"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72)
$taskName = 'Hermes Full Content Learning and Generation'
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Refresh platform performance guidance, then resume or start the 60/75/45/60 Hermes generation batch.' -Force | Out-Null
Write-Output "Registered '$taskName' daily at $At local machine time. The task uses checkpoints and will resume unfinished Sheet-writing batches."
