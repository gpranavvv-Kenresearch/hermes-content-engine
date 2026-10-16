param(
  [ValidateRange(0,500)][int]$X = 60,
  [ValidateRange(0,500)][int]$Facebook = 75,
  [ValidateRange(0,500)][int]$LinkedIn = 45,
  [ValidateRange(0,500)][int]$Tumblr = 60,
  [ValidateRange(1,72)][int]$Hours = 18,
  [ValidatePattern('^[a-zA-Z0-9_-]{1,80}$')][string]$Id,
  [ValidatePattern('^[a-zA-Z0-9_-]{1,80}$')][string]$Resume,
  [ValidateRange(0,72)][int]$ExtendHours = 0,
  [switch]$WriteSheet,
  [switch]$Background,
  [switch]$Check,
  [switch]$KeepAwake = $true
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($Id -and $Resume) { throw 'Use -Id or -Resume, not both.' }
if (!$Id -and !$Resume) {
  $indiaNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'India Standard Time')
  $Id = 'night_' + $indiaNow.ToString('yyyyMMdd_HHmmss')
}
$batchId = if ($Resume) { $Resume } else { $Id }
$logDir = Join-Path $project 'output\supervisor-hermes\overnight'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if ($Background) {
  $launchArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),'-Hours',"$Hours")
  if ($Resume) { $launchArgs += @('-Resume',$Resume) }
  else { $launchArgs += @('-Id',$Id,'-X',"$X",'-Facebook',"$Facebook",'-LinkedIn',"$LinkedIn",'-Tumblr',"$Tumblr") }
  if ($ExtendHours) { $launchArgs += @('-ExtendHours',"$ExtendHours") }
  if ($WriteSheet) { $launchArgs += '-WriteSheet' }
  if ($Check) { $launchArgs += '-Check' }
  if (!$KeepAwake) { $launchArgs += '-KeepAwake:$false' }
  $stdout = Join-Path $logDir "$batchId.stdout.log"
  $stderr = Join-Path $logDir "$batchId.stderr.log"
  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $launchArgs -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  if ($Check) {
    Write-Output "Started background read-only preflight PID $($child.Id). No generation batch will be created."
    Write-Output "Log: $stdout"
    exit 0
  }
  Write-Output "Started background runner PID $($child.Id), batch $batchId."
  Write-Output "Progress: npm run hermes:overnight -- --status --resume $batchId"
  Write-Output "Log: $stdout"
  exit 0
}

$nightArgs = @()
if ($Resume) { $nightArgs += @('--resume',$Resume) }
else { $nightArgs += @('--id',$Id,'--x',"$X",'--fb',"$Facebook",'--li',"$LinkedIn",'--tumblr',"$Tumblr",'--hours',"$Hours") }
if ($ExtendHours) { $nightArgs += @('--extend-hours',"$ExtendHours") }
if ($WriteSheet) { $nightArgs += '--write-sheet' }
if ($Check) { $nightArgs += '--check' }
$heldAwake = $false
$nightExitCode = 1
Push-Location -LiteralPath $project
try {
  if ($KeepAwake -and !$Check) {
    if (!('HermesOvernight.Power' -as [type])) {
      Add-Type -Namespace HermesOvernight -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
    }
    $heldAwake = [HermesOvernight.Power]::SetThreadExecutionState([uint32]2147483649) -ne 0
    if (!$heldAwake) { throw 'Could not hold this process awake; review the PC sleep setting before an unattended run.' }
  }
  & npm.cmd run hermes:overnight -- @nightArgs
  $nightExitCode = $LASTEXITCODE
} finally {
  if ($heldAwake) { [HermesOvernight.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null }
  Pop-Location
}
exit $nightExitCode
