param([Parameter(Mandatory=$true)][string]$OwnerPath,[ValidateRange(5,300)][int]$MaximumSeconds=300)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-transaction.ps1')
. (Join-Path $PSScriptRoot 'native-process-ownership.ps1')
. (Join-Path $PSScriptRoot 'packaged-process-ownership.ps1')
$repository=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$qaBoundary=Join-Path $repository 'build\upgrade-20260904\native-qa'
$candidateBoundary=Join-Path $repository 'apps\proto-workbench\build'
function Resolve-OwnedPath([string]$Path,[string]$Boundary) {
  Assert-BuildManagedPath -Path $Path -Boundary $Boundary
  return (Resolve-Path -LiteralPath $Path).Path
}
function File-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$ownerFile=Resolve-OwnedPath $OwnerPath $qaBoundary
$owner=Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
if ($owner.schema -ne 'proto-workbench.packaged-qa-owner.v1' -or $owner.kind -notin @('portable','installer-payload')) { throw 'Unsupported owned packaged smoke contract.' }
$sessionRoot=Resolve-OwnedPath $owner.sessionRoot $qaBoundary
if ($ownerFile -ne (Join-Path $sessionRoot 'packaged-owner.json')) { throw 'Owner must be directly inside its exact session root.' }
$tempRoot=Resolve-OwnedPath $owner.tempRoot $sessionRoot
if ($tempRoot -ne (Join-Path $sessionRoot 'portable-temp') -or @(Get-ChildItem -LiteralPath $tempRoot -Force).Count) { throw 'Portable temp must be a fresh empty directory directly inside this session.' }
$profile=Resolve-OwnedPath (Join-Path $sessionRoot 'profile') $sessionRoot
$workspace=Resolve-OwnedPath (Join-Path $sessionRoot 'workspace') $sessionRoot
$reportPath=Resolve-OwnedPath $owner.candidateReportPath $candidateBoundary
if ((File-Sha256 $reportPath) -ne $owner.candidateReportSha256) { throw 'Candidate report hash changed.' }
$candidate=Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
if ($candidate.schemaVersion -ne 'proto-workbench.release-candidate.v2' -or $candidate.status -ne 'payload-verified; native smoke pending') { throw 'A verified immutable candidate report is required.' }
$payloadRecord=@($candidate.distributionEvidence.unpackedPayload.executableArtifacts | Where-Object {$_.path -eq 'Proto Workbench.exe'})
if ($payloadRecord.Count -ne 1 -or $owner.expectedPayloadSha256 -ne $payloadRecord[0].sha256 -or $owner.expectedAsarSha256 -ne $candidate.packageEvidence.asarSha256) { throw 'Expected payload identity differs from the verified candidate.' }
$executable=Resolve-OwnedPath $owner.executablePath $candidateBoundary
if ($owner.kind -eq 'portable') {
  $wrapperRecord=@($candidate.releaseSnapshot.executableArtifacts | Where-Object {$_.path -eq [IO.Path]::GetFileName($executable)})
  if ($executable -ne $candidate.smoke.portableExecutable -or $wrapperRecord.Count -ne 1 -or $owner.executableSha256 -ne $wrapperRecord[0].sha256 -or $owner.allowedPayloadRoot -ne $tempRoot) { throw 'Portable wrapper or extraction authority differs from candidate.' }
  $payloadRoot=$tempRoot
} else {
  $distribution=@($candidate.distributionEvidence.distributions | Where-Object {$_.kind -eq 'installer' -and $_.payloadStatus -eq 'verified-exact-unpacked-bytes'})
  if ($distribution.Count -ne 1 -or $owner.allowedPayloadRoot -ne $distribution[0].payloadRoot) { throw 'Only the exact independently extracted installer payload may launch.' }
  $payloadRoot=Resolve-OwnedPath $owner.allowedPayloadRoot $candidateBoundary
  if ($executable -ne (Join-Path $payloadRoot 'Proto Workbench.exe') -or $owner.executableSha256 -ne $owner.expectedPayloadSha256) { throw 'Extracted payload executable does not match the verified candidate.' }
}
if ((File-Sha256 $executable) -ne $owner.executableSha256) { throw 'Launch executable hash changed.' }
$cdpPort=[int]$owner.cdpPort
if ($cdpPort -lt 1024 -or $cdpPort -gt 65535) { throw 'An explicit unprivileged localhost CDP port is required.' }
$receiptPath=Join-Path $sessionRoot 'packaged-launch.json'
$bindingPath=Join-Path $sessionRoot 'main-binding.json'
$stopPath=Join-Path $sessionRoot 'stop-owned-app'
foreach ($path in @($receiptPath,$bindingPath,$stopPath,(Join-Path $sessionRoot 'packaged.stdout.log'),(Join-Path $sessionRoot 'packaged.stderr.log'))) { if (Test-Path -LiteralPath $path) { throw 'A fresh packaged launch evidence namespace is required.' } }
Add-Type @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class OwnedPackagedCapture : IDisposable {
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public Process Child; StreamWriter Output, Error; volatile bool Closed;
  ManualResetEvent OutputDone=new ManualResetEvent(false), ErrorDone=new ManualResetEvent(false);
  void Append(StreamWriter writer,ManualResetEvent done,string line) {
    if(line==null){try{done.Set();}catch(ObjectDisposedException){}return;}
    lock(writer){if(!Closed)writer.WriteLine(DateTime.UtcNow.ToString("o")+" "+line);}
  }
  public bool Drain(int milliseconds){var clock=Stopwatch.StartNew();if(!OutputDone.WaitOne(milliseconds))return false;return ErrorDone.WaitOne(Math.Max(0,milliseconds-(int)clock.ElapsedMilliseconds));}
  public static string[] Arguments(string command) {
    int count; IntPtr argv=CommandLineToArgvW(command,out count);
    if(argv==IntPtr.Zero) throw new Exception("Cannot parse observed process arguments.");
    try { string[] result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size)); return result; } finally { LocalFree(argv); }
  }
  public void Start(ProcessStartInfo info,string stdout,string stderr) {
    Output=new StreamWriter(stdout,false){AutoFlush=true}; Error=new StreamWriter(stderr,false){AutoFlush=true};
    Child=new Process{StartInfo=info,EnableRaisingEvents=true};
    Child.OutputDataReceived+=(sender,data)=>Append(Output,OutputDone,data.Data);
    Child.ErrorDataReceived+=(sender,data)=>Append(Error,ErrorDone,data.Data);
    uint previous=SetErrorMode(0x0001|0x0002);
    try {if(!Child.Start())throw new Exception("Owned packaged process did not start.");}finally{SetErrorMode(previous);}
    Child.BeginOutputReadLine();Child.BeginErrorReadLine();
  }
  public void Dispose(){Closed=true;if(Child!=null){try{Child.CancelOutputRead();}catch(InvalidOperationException){}try{Child.CancelErrorRead();}catch(InvalidOperationException){}Child.Dispose();}if(Output!=null)lock(Output)Output.Dispose();if(Error!=null)lock(Error)Error.Dispose();OutputDone.Dispose();ErrorDone.Dispose();}
}
'@
$start=New-Object Diagnostics.ProcessStartInfo
$start.FileName=$executable
$start.Arguments='--session-root="'+$sessionRoot+'" --remote-debugging-address=127.0.0.1 --remote-debugging-port='+$cdpPort+' --enable-logging=stderr'
$start.WorkingDirectory=[IO.Path]::GetDirectoryName($executable)
$start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
$start.EnvironmentVariables.Clear()
foreach ($key in @('SystemRoot','WINDIR','SystemDrive','ProgramFiles','ComSpec','PATH','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE')) { $value=[Environment]::GetEnvironmentVariable($key); if ($value) { $start.EnvironmentVariables[$key]=$value } }
$start.EnvironmentVariables['TEMP']=$tempRoot; $start.EnvironmentVariables['TMP']=$tempRoot
$capture=New-Object OwnedPackagedCapture
$mainProcess=$null; $mainCreatedAt=$null; $mainExecutable=$null; $ownedCreatedAt=$null
$forcedCleanup=$false
$receipt=[ordered]@{schema='proto-workbench.owned-packaged-launch.v1';kind=$owner.kind;sessionRoot=$sessionRoot;tempRoot=$tempRoot;executablePath=$executable;executableSha256=$owner.executableSha256;candidateReportPath=$reportPath;candidateReportSha256=$owner.candidateReportSha256;startedAt=[DateTime]::UtcNow.ToString('o');modelsMayLoad=$false;maximumSeconds=$MaximumSeconds;errorMode='owned child SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX';securityFuses='unchanged; no Node inspector requested';children=@();rejectedCandidates=@();cleanupActions=@();observedWindow=$false;error=$null;cleanupError=$null}
function Save-LaunchReceipt { $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
function Read-ObservedProcess([string]$Filter) {
  foreach ($entry in @(Get-CimInstance Win32_Process -Filter $Filter -OperationTimeoutSec 5 -ErrorAction Stop)) {
    $entry | Add-Member -NotePropertyName Arguments -NotePropertyValue $(if ($entry.CommandLine) {[OwnedPackagedCapture]::Arguments($entry.CommandLine)} else {@()})
    Write-Output $entry
  }
}
function Observe-MainChildren {
  $observed=@()
  if ($mainProcess) {
    foreach ($child in @(Read-ObservedProcess ('ParentProcessId = '+$mainProcess.Id))) {
      if (Get-PackagedChildOwnership $child $mainProcess.Id $mainCreatedAt $mainExecutable $profile) { $observed += [ordered]@{pid=$child.ProcessId;parentPid=$child.ParentProcessId;createdAt=$child.CreationDate.ToUniversalTime().ToString('o');executablePath=$child.ExecutablePath;arguments=$child.Arguments} }
    }
  }
  return $observed
}
Save-LaunchReceipt
try {
  $capture.Start($start,(Join-Path $sessionRoot 'packaged.stdout.log'),(Join-Path $sessionRoot 'packaged.stderr.log'))
  $null=$capture.Child.Handle; $ownedCreatedAt=$capture.Child.StartTime
  $receipt.pid=$capture.Child.Id; $receipt.processCreatedAt=$ownedCreatedAt.ToUniversalTime().ToString('o'); Save-LaunchReceipt
  Write-Output ('OWNED_PID='+$capture.Child.Id)
  $deadline=[DateTime]::UtcNow.AddSeconds($MaximumSeconds)
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $stopPath)) {
    if (-not $mainProcess) {
      $filter=if ($owner.kind -eq 'portable') {'ParentProcessId = '+$capture.Child.Id} else {'ProcessId = '+$capture.Child.Id}
      foreach ($entry in @(Read-ObservedProcess $filter)) {
        $verdict=Get-PackagedMainOwnership $entry $capture.Child.Id $ownedCreatedAt $owner.kind $payloadRoot $sessionRoot $cdpPort
        if (-not $verdict.owned) { $receipt.rejectedCandidates += @{pid=$entry.ProcessId;reason=$verdict.reason}; continue }
        $held=Get-Process -Id $entry.ProcessId -ErrorAction Stop
        try {
          $null=$held.Handle; $created=$held.StartTime
          if (-not (Test-PackagedHeldCreation $created $entry.CreationDate)) { throw 'Observed PID was replaced before its process handle was retained.' }
          $image=Resolve-OwnedPath $entry.ExecutablePath $payloadRoot
          $asar=Resolve-OwnedPath (Join-Path ([IO.Path]::GetDirectoryName($image)) 'resources\app.asar') $payloadRoot
          if (-not (Test-NativeProcessIdentity $held $created $image) -or (File-Sha256 $image) -ne $owner.expectedPayloadSha256 -or (File-Sha256 $asar) -ne $owner.expectedAsarSha256 -or -not (Test-NativeProcessIdentity $held $created $image)) { throw 'Observed child identity or payload hash differs from verified candidate.' }
          $mainProcess=$held; $held=$null; $mainCreatedAt=$created; $mainExecutable=$image
          $receipt.actualMain=@{pid=$mainProcess.Id;createdAt=$created.ToUniversalTime().ToString('o');executablePath=$image;executableSha256=$owner.expectedPayloadSha256;asarPath=$asar;asarSha256=$owner.expectedAsarSha256}
        } finally { if ($held) {$held.Dispose()} }
        break
      }
    }
    if ($mainProcess) {
      $mainProcess.Refresh(); if ($mainProcess.HasExited) { break }
      if ($mainProcess.MainWindowHandle -ne [IntPtr]::Zero) { $receipt.observedWindow=$true }
      $receipt.children=@(Observe-MainChildren)
      $profileChild=@($receipt.children | Where-Object {$_.executablePath -eq $mainExecutable -and $_.arguments -contains ('--user-data-dir='+$profile)})
      if ($profileChild.Count -and -not (Test-Path -LiteralPath $bindingPath)) {
        [ordered]@{schema='proto-workbench.packaged-main-binding.v1';pid=$mainProcess.Id;createdAt=$mainCreatedAt.ToUniversalTime().ToString('o');executablePath=$mainExecutable;executableSha256=$owner.expectedPayloadSha256;asarPath=$receipt.actualMain.asarPath;asarSha256=$owner.expectedAsarSha256;sessionRoot=$sessionRoot;userData=$profile;workspacePath=$workspace;observedAt=[DateTime]::UtcNow.ToString('o');profileChild=$profileChild[0];workspaceEvidence='Expected explicit session workspace; Node must confirm existing read-only getSettings result.'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bindingPath -Encoding utf8
      }
    } elseif ($capture.Child.HasExited) { break }
    Save-LaunchReceipt
    Start-Sleep -Milliseconds 500
  }
  if (-not $mainProcess -or -not (Test-Path -LiteralPath $bindingPath)) { throw 'No exact owned main process and actual Chromium profile binding were established.' }
  if ([DateTime]::UtcNow -ge $deadline) { throw 'Owned packaged smoke exceeded its deadline.' }
} catch { $receipt.error=$_.Exception.ToString() }
finally {
  try {
    if ($mainProcess -and -not $mainProcess.HasExited) {
      if (-not (Test-NativeProcessIdentity $mainProcess $mainCreatedAt $mainExecutable)) { throw 'Refusing cleanup after main identity mismatch.' }
      $null=$mainProcess.CloseMainWindow(); $receipt.cleanupActions += @{action='close-held-owned-main-window';pid=$mainProcess.Id}
      if (-not $mainProcess.WaitForExit(45000)) {
        if (-not (Test-NativeProcessIdentity $mainProcess $mainCreatedAt $mainExecutable)) { throw 'Refusing main fallback after identity mismatch.' }
        $mainProcess.Kill(); $null=$mainProcess.WaitForExit(3000); $forcedCleanup=$true; $receipt.cleanupActions += @{action='kill-held-owned-main-only';pid=$mainProcess.Id}
      }
    }
    if ($capture.Child -and -not $capture.Child.HasExited -and -not $capture.Child.WaitForExit(10000)) {
      if (-not (Test-NativeProcessIdentity $capture.Child $ownedCreatedAt $executable)) { throw 'Refusing wrapper fallback after identity mismatch.' }
      $capture.Child.Kill(); $null=$capture.Child.WaitForExit(3000); $forcedCleanup=$true; $receipt.cleanupActions += @{action='kill-held-owned-launcher-only';pid=$capture.Child.Id}
    }
    $receipt.processExited=($capture.Child -and $capture.Child.HasExited)
    $receipt.mainProcessExited=($mainProcess -and $mainProcess.HasExited)
    $receipt.remainingOwnedChildren=@(Observe-MainChildren)
    if ($capture.Child -and $capture.Child.HasExited) { $receipt.exitCode=$capture.Child.ExitCode; $receipt.standardStreamsClosed=$capture.Drain(3000) }
    if ($mainProcess -and $mainProcess.HasExited) { $receipt.mainExitCode=$mainProcess.ExitCode }
    if (-not $receipt.processExited -or -not $receipt.mainProcessExited -or $receipt.remainingOwnedChildren.Count) { throw 'Owned packaged processes did not all exit cleanly.' }
    if (-not $receipt.standardStreamsClosed) { throw 'Owned launcher standard streams did not close within the bounded drain.' }
    if ((File-Sha256 $executable) -ne $owner.executableSha256 -or (File-Sha256 $reportPath) -ne $owner.candidateReportSha256) { throw 'Candidate identity changed during smoke.' }
    if ($forcedCleanup -or $receipt.exitCode -ne 0 -or $receipt.mainExitCode -ne 0) { throw 'Forced fallback or nonzero process exit cannot count as a clean native smoke pass.' }
  } catch { $receipt.cleanupError=$_.Exception.ToString() }
  $receipt.completedAt=[DateTime]::UtcNow.ToString('o'); Save-LaunchReceipt
  if ($mainProcess) {$mainProcess.Dispose()}; $capture.Dispose()
  Write-Output ('REPORT='+$receiptPath)
}
if ($receipt.error -or $receipt.cleanupError) { throw 'Owned packaged smoke failed; see the retained launch receipt.' }
