param(
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$QaRoot,
  [int]$MaximumSeconds = 600,
  [switch]$OwnedModelMission,
  [ValidateRange(1,5)][int]$LaunchIndex = 1,
  [switch]$ContinueSnapshot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-ownership.ps1')
if ($MaximumSeconds -lt 5 -or $MaximumSeconds -gt 1200 -or ($MaximumSeconds -gt 600 -and -not $OwnedModelMission)) { throw 'Native UI verification is bounded to600seconds; the explicitly authorized single model mission allows1200seconds including owned unload.' }
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$allowed = [IO.Path]::GetFullPath((Join-Path $repository 'build\upgrade-20260904\native-qa'))
$resolvedQa = [IO.Path]::GetFullPath($QaRoot)
$resolvedApp = (Resolve-Path -LiteralPath $AppRoot).Path
if (-not $resolvedQa.StartsWith($allowed + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $resolvedApp.StartsWith($allowed + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Only the private native QA snapshot is permitted.' }
$ownerPath = Join-Path $resolvedQa 'qa-owner.json'
if (-not (Test-Path -LiteralPath $ownerPath)) { throw 'A harness-owned QA fixture is required.' }
$owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
if ($owner.schema -ne 'proto-workbench.native-qa-owner.v1' -or $owner.qaRoot -ne $resolvedQa -or ($owner.appRoot -ne $resolvedApp -and -not $ContinueSnapshot)) { throw 'The fixture owner must bind the exact QA root and app snapshot.' }
if ($ContinueSnapshot -and ($LaunchIndex -lt 2 -or -not ([IO.Path]::GetFullPath($owner.appRoot)).StartsWith($allowed + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'A snapshot continuation must retain a previous controlled native QA owner.' }
$launchSuffix = if ($LaunchIndex -eq 1) { '' } else { '-' + $LaunchIndex }
$receiptPath = Join-Path $resolvedQa ('owned-launch' + $launchSuffix + '.json')
if (Test-Path -LiteralPath $receiptPath) { throw 'Refusing to overwrite a native launch receipt.' }
if ($LaunchIndex -gt 1) {
  $previousSuffix = if ($LaunchIndex -eq 2) { '' } else { '-' + ($LaunchIndex - 1) }
  $previousPath = Join-Path $resolvedQa ('owned-launch' + $previousSuffix + '.json')
  $previous = Get-Content -LiteralPath $previousPath -Raw | ConvertFrom-Json
  $priorApp = if ($ContinueSnapshot) { [string]$previous.appRoot } else { $resolvedApp }
  if (-not $priorApp.StartsWith($allowed + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-NativeRestartReceipt $previous $resolvedQa $priorApp)) { throw 'Restart requires a completed, clean launch of this exact isolated profile.' }
  $previousProcess = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
  if ($previousProcess) {
    try { if (Test-NativeProcessIdentity $previousProcess ([datetime]$previous.processCreatedAt) $previous.executable) { throw 'The prior owned Electron process is still alive.' } }
    finally { $previousProcess.Dispose() }
  }
}
$profile = Join-Path $resolvedQa 'profile'
$workspace = Join-Path $resolvedQa 'workspace'
if (-not (Test-Path -LiteralPath $profile) -or -not (Test-Path -LiteralPath $workspace)) { throw 'Prepared QA profile and workspace are required.' }
$executable = Join-Path $repository 'apps\proto-workbench\node_modules\electron\dist\electron.exe'
$python = Join-Path $repository '.venv\Scripts\python.exe'
$stdout = Join-Path $resolvedQa ('electron' + $launchSuffix + '.stdout.log')
$stderr = Join-Path $resolvedQa ('electron' + $launchSuffix + '.stderr.log')
$stopPath = Join-Path $resolvedQa ('stop-owned-app' + $launchSuffix)

Add-Type @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
public sealed class OwnedStartupCapture : IDisposable {
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  public Process Child;
  StreamWriter Output, Error;
  public void Start(ProcessStartInfo info, string outputPath, string errorPath) {
    Output = new StreamWriter(outputPath, false) { AutoFlush = true };
    Error = new StreamWriter(errorPath, false) { AutoFlush = true };
    Child = new Process { StartInfo = info, EnableRaisingEvents = true };
    Child.OutputDataReceived += (sender,eventData) => { if(eventData.Data != null) lock(Output) Output.WriteLine(DateTime.UtcNow.ToString("o") + " " + eventData.Data); };
    Child.ErrorDataReceived += (sender,eventData) => { if(eventData.Data != null) lock(Error) Error.WriteLine(DateTime.UtcNow.ToString("o") + " " + eventData.Data); };
    uint previous = SetErrorMode(0x0001 | 0x0002);
    try { if(!Child.Start()) throw new Exception("Owned Electron did not start."); }
    finally { SetErrorMode(previous); }
    Child.BeginOutputReadLine(); Child.BeginErrorReadLine();
  }
  public void Dispose() { if(Child != null) Child.Dispose(); if(Output != null) Output.Dispose(); if(Error != null) Error.Dispose(); }
}
'@
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $executable
$start.Arguments = '"' + $resolvedApp + '" --inspect=0 --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --enable-logging=stderr'
if ($ContinueSnapshot) { $start.Arguments += ' --session-root="' + $resolvedQa + '"' }
$start.WorkingDirectory = $resolvedApp
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$savedEnvironment = @{}
foreach ($key in @('SystemRoot','WINDIR','SystemDrive','ProgramFiles','ComSpec','PATH','PATHEXT','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE')) { if ($envValue = [Environment]::GetEnvironmentVariable($key)) { $savedEnvironment[$key] = $envValue } }
$start.EnvironmentVariables.Clear()
foreach ($key in $savedEnvironment.Keys) { $start.EnvironmentVariables[$key] = $savedEnvironment[$key] }
if (-not $ContinueSnapshot) { $start.EnvironmentVariables['PROTO_WORKBENCH_QA_ROOT'] = $resolvedQa }
$start.EnvironmentVariables['PROTO_AGENT_PYTHON'] = $python
$start.EnvironmentVariables['PROTO_AGENT_MATERIALS_ROOT'] = Join-Path $repository '..\Proto CLI Materials'
$capture = New-Object OwnedStartupCapture
$receipt = [ordered]@{ schema='proto-workbench.owned-scientific-launch.v2'; launchIndex=$LaunchIndex; continuedSnapshot=$ContinueSnapshot.IsPresent; originalAppRoot=$owner.appRoot; startedAt=[DateTime]::UtcNow.ToString('o'); executable=$executable; executableSha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant(); appRoot=$resolvedApp; qaRoot=$resolvedQa; maximumSeconds=$MaximumSeconds; errorMode='inherited SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX on owned child only'; permissionMode='normal approved desktop execution'; stdout=$stdout; stderr=$stderr; modelsMayLoad=$OwnedModelMission.IsPresent; children=@(); rejectedDescendants=@(); cleanupActions=@(); windows=@() }
try {
  $capture.Start($start, $stdout, $stderr)
  $receipt.pid = $capture.Child.Id
  $ownedCreatedAt = $capture.Child.StartTime
  $receipt.processCreatedAt = $ownedCreatedAt.ToUniversalTime().ToString('o')
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
  Write-Output ('OWNED_PID=' + $capture.Child.Id)
  $deadline = [DateTime]::UtcNow.AddSeconds($MaximumSeconds)
  $seen = @{}
  while ([DateTime]::UtcNow -lt $deadline -and -not $capture.Child.HasExited -and -not (Test-Path -LiteralPath $stopPath)) {
    $capture.Child.Refresh()
    if ($capture.Child.MainWindowHandle -ne [IntPtr]::Zero -and $receipt.windows.Count -eq 0) { $receipt.windows += [ordered]@{ observedAt=[DateTime]::UtcNow.ToString('o'); handle=$capture.Child.MainWindowHandle.ToString(); title=$capture.Child.MainWindowTitle } }
    foreach ($child in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $capture.Child.Id) -ErrorAction SilentlyContinue)) {
      $identityKey = [string]$child.ProcessId + ':' + [string]$child.CreationDate
      if (-not $seen.ContainsKey($identityKey)) {
        $seen[$identityKey]=$true
        $verdict = Get-NativeChildOwnership $child $capture.Child.Id $ownedCreatedAt $executable $python $profile
        $record = [ordered]@{ pid=$child.ProcessId; parentPid=$child.ParentProcessId; createdAt=$child.CreationDate.ToString('o'); name=$child.Name; executable=$child.ExecutablePath }
        if ($verdict.owned) { $record.commandLine=$child.CommandLine; $receipt.children += $record }
        else { $record.reason=$verdict.reason; $receipt.rejectedDescendants += $record }
      }
    }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    Start-Sleep -Milliseconds 1500
  }
  $receipt.observedWindow = $receipt.windows.Count -gt 0
  $receipt.naturalExit = $capture.Child.HasExited
  if ($capture.Child.HasExited) { $receipt.exitCode=$capture.Child.ExitCode }
} catch { $receipt.error=$_.Exception.ToString(); throw }
finally {
  if ($capture.Child -and -not $capture.Child.HasExited) {
    $null = $capture.Child.CloseMainWindow()
    $receipt.cleanupActions += [ordered]@{ action='close-owned-window'; pid=$capture.Child.Id }
    $cooperativeCloseMs = if ($OwnedModelMission) { 45000 } else { 10000 }
    $receipt.cooperativeCloseTimeoutMs = $cooperativeCloseMs
    if (-not $capture.Child.WaitForExit($cooperativeCloseMs)) {
      if (Test-NativeProcessIdentity $capture.Child $ownedCreatedAt $executable) { $capture.Child.Kill(); $null=$capture.Child.WaitForExit(3000); $receipt.cleanupActions += [ordered]@{ action='kill-held-owned-process-only'; pid=$capture.Child.Id; createdAt=$receipt.processCreatedAt } }
      else { $receipt.cleanupActions += [ordered]@{ action='refused-identity-mismatch'; pid=$capture.Child.Id } }
    }
  }
  if ($capture.Child) { $receipt.processExited = $capture.Child.HasExited; if ($capture.Child.HasExited) { $receipt.exitCode=$capture.Child.ExitCode; $capture.Child.WaitForExit() } }
  $receipt.remainingOwnedChildren = @()
  if ($capture.Child) {
    foreach ($remaining in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $capture.Child.Id) -ErrorAction SilentlyContinue)) {
      $verdict = Get-NativeChildOwnership $remaining $capture.Child.Id $ownedCreatedAt $executable $python $profile
      if ($verdict.owned) { $receipt.remainingOwnedChildren += [ordered]@{ pid=$remaining.ProcessId; parentPid=$remaining.ParentProcessId; createdAt=$remaining.CreationDate.ToString('o'); name=$remaining.Name; executable=$remaining.ExecutablePath } }
    }
  }
  $receipt.completedAt=[DateTime]::UtcNow.ToString('o')
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
  $capture.Dispose()
  Write-Output ('REPORT=' + $receiptPath)
}
