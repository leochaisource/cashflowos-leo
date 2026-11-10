# Creates (or re-creates) the Windows Task Scheduler task "SpeakFunnels progress sync".
# It runs scripts/progress-sync.ts every 30 minutes, 2 minutes after you log on and
# 1 minute after you unlock the laptop: it sends the last week of Claude Code session
# summaries (claude-mem) to the Command Centre, which sorts them to clients.
#
# Run once, in PowerShell, from the cashflowos-leo folder:
#   powershell -ExecutionPolicy Bypass -File scripts\progress-sync-task.ps1
# Remove it:
#   Unregister-ScheduledTask -TaskName "SpeakFunnels progress sync" -Confirm:$false
#
# Runs hidden (conhost --headless), on battery too, only while you're logged on, never
# two at once, and catches up after the laptop wakes. It needs nothing from you after
# this; the 9am Today message tells you if it hasn't reported for two days.

$ErrorActionPreference = 'Stop'
$name = 'SpeakFunnels progress sync'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless `"$node`" --disable-warning=ExperimentalWarning --env-file=.env scripts/progress-sync.ts" `
  -WorkingDirectory $repo

$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT2M'
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$cls = Get-CimClass -Namespace ROOT\Microsoft\Windows\TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
$unlock = New-CimInstance -CimClass $cls -ClientOnly
$unlock.StateChange = 8   # session unlock
$unlock.UserId = $user
$unlock.Delay = 'PT1M'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $every, $unlock) -Settings $settings -Principal $principal `
  -Description 'Sends Claude Code session summaries to the SpeakFunnels Command Centre (client progress + to-dos). See cashflowos-leo/docs/progress-sync.md.' | Out-Null

Start-ScheduledTask -TaskName $name
Write-Host "Created '$name' and ran it once. The log is at $env:LOCALAPPDATA\SpeakFunnels\progress-sync.log"
