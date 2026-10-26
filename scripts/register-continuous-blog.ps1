param([switch]$Check, [string]$Structure = 'v1.3', [switch]$NoImage)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $project 'scripts\run-continuous-blog.ps1'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$start = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$xmlProject = [Security.SecurityElement]::Escape($project)
$extra = "-Structure $Structure"
if ($NoImage) { $extra += ' -NoImage' }
$xmlArgs = [Security.SecurityElement]::Escape("-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" $extra")
$xml = @"
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Continuous Hermes blog generation. Resumes after sleep, failures and logon; the supervisor gates stay enabled.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$userSid</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$start</StartBoundary><Enabled>true</Enabled></TimeTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><UserId>$userSid</UserId></SessionStateChangeTrigger>
  </Triggers>
  <Principals><Principal id="User"><UserId>$userSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowHardTerminate>true</AllowHardTerminate><Enabled>true</Enabled><Hidden>true</Hidden>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="User"><Exec><Command>powershell.exe</Command><Arguments>$xmlArgs</Arguments><WorkingDirectory>$xmlProject</WorkingDirectory></Exec></Actions>
</Task>
"@
if ($Check) { [xml]$parsed = $xml; Write-Output "Task XML valid: logon + unlock + 5-minute watchdog; no execution limit; battery allowed; arguments: $extra"; return }
$taskName = 'Hermes Continuous Blog Generation'
Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Registered and started '$taskName'. Blog generation resumes and retries continuously while this user is signed in."
