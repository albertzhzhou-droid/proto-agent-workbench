# Pure identity predicates; callers must additionally retain the Process handle,
# reject reparse points, and verify executable/ASAR hashes before adopting it.
function Test-PackagedHeldCreation {
  param([datetime]$HeldCreatedAt,[datetime]$ObservedCreatedAt)
  # Win32_Process CreationDate preserves microseconds; Process.StartTime also
  # retains the final 100 ns digit. Match their common precision, never a window.
  $heldTicks=$HeldCreatedAt.ToUniversalTime().Ticks
  $observedTicks=$ObservedCreatedAt.ToUniversalTime().Ticks
  return ($heldTicks-($heldTicks%10)) -eq ($observedTicks-($observedTicks%10))
}

function Get-PackagedMainOwnership {
  param($Candidate, [int]$LauncherPid, [datetime]$LauncherCreatedAt, [string]$Kind, [string]$PayloadRoot, [string]$SessionRoot, [int]$CdpPort)
  $reason = $null
  $direct = $Kind -eq 'installer-payload'
  if ($direct -and [int]$Candidate.ProcessId -ne $LauncherPid) { $reason='direct-process-mismatch' }
  elseif (-not $direct -and [int]$Candidate.ParentProcessId -ne $LauncherPid) { $reason='parent-pid-mismatch' }
  elseif (-not $Candidate.CreationDate) { $reason='missing-creation-time' }
  elseif (-not $direct -and ([datetime]$Candidate.CreationDate).ToUniversalTime() -lt $LauncherCreatedAt.ToUniversalTime()) { $reason='predates-owned-launcher' }
  elseif (-not $Candidate.ExecutablePath -or -not $Candidate.Arguments) { $reason='missing-image-or-arguments' }
  else {
    $image=[IO.Path]::GetFullPath($Candidate.ExecutablePath)
    $root=[IO.Path]::GetFullPath($PayloadRoot).TrimEnd('\')
    if (-not $image.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($image) -ne 'Proto Workbench.exe') { $reason='outside-owned-payload' }
    elseif ($direct -and $image -ne (Join-Path $root 'Proto Workbench.exe')) { $reason='direct-image-mismatch' }
    elseif (@($Candidate.Arguments | Where-Object { $_ -like '--type=*' }).Count) { $reason='child-role-is-not-main' }
    elseif (@($Candidate.Arguments | Where-Object { $_ -like '--session-root=*' }).Count -ne 1 -or $Candidate.Arguments -notcontains ('--session-root='+$SessionRoot)) { $reason='session-root-mismatch' }
    elseif ($Candidate.Arguments -notcontains ('--remote-debugging-port='+$CdpPort) -or $Candidate.Arguments -notcontains '--remote-debugging-address=127.0.0.1') { $reason='debug-endpoint-mismatch' }
  }
  return [pscustomobject]@{owned=(-not $reason);reason=$reason}
}

function Get-PackagedChildOwnership {
  param($Candidate, [int]$MainPid, [datetime]$MainCreatedAt, [string]$MainExecutable, [string]$Profile)
  if ([int]$Candidate.ParentProcessId -ne $MainPid -or -not $Candidate.CreationDate -or ([datetime]$Candidate.CreationDate).ToUniversalTime() -lt $MainCreatedAt.ToUniversalTime() -or -not $Candidate.ExecutablePath -or -not $Candidate.Arguments) { return $false }
  $image=[IO.Path]::GetFullPath($Candidate.ExecutablePath)
  if ($image.Equals($MainExecutable,[StringComparison]::OrdinalIgnoreCase)) {
    return $Candidate.Arguments -contains ('--user-data-dir='+$Profile) -and @($Candidate.Arguments | Where-Object { $_ -match '^--type=(renderer|gpu-process|utility)$' }).Count -eq 1
  }
  $runtime=Join-Path ([IO.Path]::GetDirectoryName($MainExecutable)) 'resources\runtime'
  return $image.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($image) -in @('proto-agent.exe','proto-agent-mcp.exe')
}
