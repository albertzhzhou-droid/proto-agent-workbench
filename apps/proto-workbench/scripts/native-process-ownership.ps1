# Pure identity checks. Parent PID alone never proves that a process is ours.
function Get-NativeChildOwnership {
  param($Candidate, [int]$ParentPid, [datetime]$ParentCreatedAt, [string]$ElectronExecutable, [string]$PythonExecutable, [string]$ProfilePath)
  $reason = $null
  if ([int]$Candidate.ParentProcessId -ne $ParentPid) { $reason = 'parent-pid-mismatch' }
  elseif (-not $Candidate.CreationDate) { $reason = 'missing-creation-time' }
  elseif (([datetime]$Candidate.CreationDate).ToUniversalTime() -lt $ParentCreatedAt.ToUniversalTime()) { $reason = 'predates-owned-parent-pid-reuse' }
  elseif (-not $Candidate.ExecutablePath -or -not $Candidate.CommandLine) { $reason = 'missing-executable-or-command' }
  else {
    $image = [IO.Path]::GetFullPath($Candidate.ExecutablePath)
    $command = [string]$Candidate.CommandLine
    if ($image.Equals([IO.Path]::GetFullPath($ElectronExecutable), [StringComparison]::OrdinalIgnoreCase)) {
      $quotedProfile = '--user-data-dir="' + $ProfilePath + '"'
      $plainProfile = '--user-data-dir=' + $ProfilePath + ' '
      if ($command.IndexOf($quotedProfile, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and ($command + ' ').IndexOf($plainProfile, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $reason = 'electron-profile-mismatch' }
      elseif ($command -notmatch '(?:^|\s)--type=(renderer|gpu-process|utility)(?:\s|$)') { $reason = 'unsupported-electron-child-role' }
    } elseif ($image.Equals([IO.Path]::GetFullPath($PythonExecutable), [StringComparison]::OrdinalIgnoreCase)) {
      if ($command -notmatch '(?:^|\s)-m\s+proto_agent\.mcp_server(?:\s|$)') { $reason = 'python-module-mismatch' }
    } else { $reason = 'executable-outside-owned-allowlist' }
  }
  return [pscustomobject]@{ owned = -not $reason; reason = $reason }
}

function Test-NativeProcessIdentity {
  param($Process, [datetime]$ExpectedCreatedAt, [string]$ExpectedExecutable)
  try {
    # Open and retain this process handle before examining its identity; a later
    # PID reuse cannot redirect Process.Kill() to another process.
    $null = $Process.Handle
    return -not $Process.HasExited -and $Process.StartTime.ToUniversalTime().Ticks -eq $ExpectedCreatedAt.ToUniversalTime().Ticks -and $Process.MainModule.FileName.Equals($ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Test-NativeRestartReceipt {
  param($Receipt, [string]$QaRoot, [string]$AppRoot)
  return $Receipt.schema -eq 'proto-workbench.owned-scientific-launch.v2' -and $Receipt.qaRoot -eq $QaRoot -and $Receipt.appRoot -eq $AppRoot -and $Receipt.processExited -eq $true -and [bool]$Receipt.completedAt -and $null -ne $Receipt.remainingOwnedChildren -and @($Receipt.remainingOwnedChildren).Count -eq 0 -and -not $Receipt.error
}
