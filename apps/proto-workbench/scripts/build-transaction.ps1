Set-StrictMode -Version Latest

function Enter-ProjectBuildLease {
  param([Parameter(Mandatory = $true)][string]$AppRoot, $ParentLease = $null)
  if ($null -ne $ParentLease) {
    # Only a live FileStream in this PowerShell process can delegate ownership.
    if ($ParentLease.OwnerPid -ne $PID -or
        $ParentLease.Stream -isnot [IO.FileStream] -or -not $ParentLease.Stream.CanWrite -or
        $ParentLease.Stream.Name -ne $ParentLease.LockPath) {
      throw "The parent build lease is invalid or no longer owns its lock."
    }
    return [pscustomobject]@{ Stream = $ParentLease.Stream; LockPath = $ParentLease.LockPath; OwnerPid = $PID; Owned = $false }
  }
  $LockRoot = Join-Path ([IO.Path]::GetFullPath($AppRoot)) "build\locks"
  Assert-BuildManagedPath -Path $LockRoot -Boundary $AppRoot
  New-Item -ItemType Directory -Force -Path $LockRoot | Out-Null
  $LockPath = Join-Path $LockRoot "project-build.lock"
  try {
    $Stream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    throw "Another desktop, sidecar, development, or release build owns the project build lock: $LockPath"
  }
  return [pscustomobject]@{ Stream = $Stream; LockPath = $LockPath; OwnerPid = $PID; Owned = $true }
}

function Exit-ProjectBuildLease {
  param($Lease)
  if ($null -ne $Lease -and $Lease.Owned) { $Lease.Stream.Dispose() }
}

function Assert-BuildManagedPath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Boundary)
  $ResolvedBoundary = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $ResolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $ResolvedPath.StartsWith($ResolvedBoundary + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Build path is outside the managed boundary: $ResolvedPath"
  }
  $Current = $ResolvedPath
  while ($Current.Length -ge $ResolvedBoundary.Length) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Managed build paths cannot cross a reparse point: $Current" }
    }
    if ($Current -eq $ResolvedBoundary) { break }
    $Current = Split-Path -Parent $Current
  }
}

function Invoke-BuildCommand {
  param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Build command exited with code ${LASTEXITCODE}: $Executable" }
}

function Move-FailedBuildEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$SourceBoundary,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$BuildRoot
  )
  Assert-BuildManagedPath -Path $Path -Boundary $SourceBoundary
  Assert-BuildManagedPath -Path $Destination -Boundary $BuildRoot
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "Failed build evidence source must be an existing directory." }
  if (Test-Path -LiteralPath $Destination) { throw "Refusing to overwrite earlier failed build evidence: $Destination" }
  Move-Item -LiteralPath $Path -Destination $Destination
}

function Move-FailedReleaseStage {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$BuildId
  )
  if ($BuildId -cnotmatch '^[a-f0-9]{32}$') { throw "Failed release evidence requires a complete build GUID." }
  $Expected = Join-Path ([IO.Path]::GetFullPath($BuildRoot)) "release-staging-$BuildId"
  if ([IO.Path]::GetFullPath($Path) -cne $Expected) { throw "Failed release source does not match its exact build identity." }
  $Destination = Join-Path $BuildRoot "release-failed-build-$BuildId"
  Move-FailedBuildEvidence -Path $Path -SourceBoundary $BuildRoot -Destination $Destination -BuildRoot $BuildRoot
  return $Destination
}
