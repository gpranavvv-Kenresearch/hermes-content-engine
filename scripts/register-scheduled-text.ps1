param([switch]$Check, [switch]$NoStart)
# Two daily windows for text generation (X, Facebook, LinkedIn, Tumblr). Local time of this PC.
#   Morning: starts 10:30, stopped by Task Scheduler at 18:00 (7h30m)
#   Night:   starts 00:00, stopped by Task Scheduler at 06:00 (6h)
# Rows are chosen by the Sheet: a platform's own Status and Post URL cells must be empty.
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $project 'scripts\run-continuous-text.ps1'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$xmlProject = [Security.SecurityElement]::Escape($project)
$xmlArgs = [Security.SecurityElement]::Escape("-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`"")
$today = (Get-Date).ToString('yyyy-MM-dd')

function New-WindowXml([string]$description, [string]$startTime, [string]$limit) {
@"
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$description</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>${today}T$startTime</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="User"><UserId>$userSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowHardTerminate>true</AllowHardTerminate><Enabled>true</Enabled><Hidden>true</Hidden>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>$limit</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="User"><Exec><Command>powershell.exe</Command><Arguments>$xmlArgs</Arguments><WorkingDirectory>$xmlProject</WorkingDirectory></Exec></Actions>
</Task>
"@
}

$windows = @(
  @{ Name = 'Hermes Text Morning 1030-1800'; Start = '10:30:00'; Limit = 'PT7H30M'; Description = 'Hermes text generation, daily 10:30 to 18:00.' },
  @{ Name = 'Hermes Text Night 0000-0600';   Start = '00:00:00'; Limit = 'PT6H';    Description = 'Hermes text generation, daily 00:00 to 06:00.' }
)
foreach ($w in $windows) {
  $xml = New-WindowXml $w.Description $w.Start $w.Limit
  if ($Check) { [xml]$parsed = $xml; Write-Output "$($w.Name): XML valid (start $($w.Start), stops after $($w.Limit))"; continue }
  Register-ScheduledTask -TaskName $w.Name -Xml $xml -Force | Out-Null
  Write-Output "Registered '$($w.Name)': daily $($w.Start), stopped after $($w.Limit)."
}
if (-not $Check) {
  # The old always-on watchdog would run outside these windows.
  $old = Get-ScheduledTask -TaskName 'Hermes Continuous Text Generation' -ErrorAction SilentlyContinue
  if ($old) { Stop-ScheduledTask -InputObject $old -ErrorAction SilentlyContinue; Disable-ScheduledTask -InputObject $old | Out-Null; Write-Output "Disabled 'Hermes Continuous Text Generation'." }
}
