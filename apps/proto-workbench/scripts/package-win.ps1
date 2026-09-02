Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent $PSScriptRoot
$BuildRoot = Join-Path $AppRoot "build"
$LockRoot = Join-Path $BuildRoot "locks"
$BuildId = [Guid]::NewGuid().ToString("N")
$StagingRoot = Join-Path $BuildRoot "release-staging-$BuildId"
$BackupRoot = Join-Path $BuildRoot "release-backup-$BuildId"
$FailedRoot = Join-Path $BuildRoot "release-failed-$BuildId"
$ReleaseRoot = Join-Path $AppRoot "release"
$Verifier = Join-Path $PSScriptRoot "verify-packaged-integrity.mjs"
$ElectronBuilder = Join-Path $AppRoot "node_modules\.bin\electron-builder.cmd"

New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $LockRoot | Out-Null

$LockPath = Join-Path $LockRoot "package-win.lock"
$LockStream = $null
try {
  $LockStream = [IO.File]::Open(
    $LockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch [IO.IOException] {
  throw "Another Windows release build owns the project package lock: $LockPath"
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label exited with code $LASTEXITCODE."
  }
}

function Invoke-JsonCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $Output = & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label exited with code $LASTEXITCODE."
  }
  try {
    return ($Output -join "`n") | ConvertFrom-Json
  } catch {
    throw "$Label did not emit valid JSON."
  }
}

function Assert-SameSnapshot {
  param(
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)][string]$Boundary
  )

  if ($Expected.schemaVersion -ne "proto-workbench.package-inputs.v1" -or
      $Actual.schemaVersion -ne $Expected.schemaVersion -or
      $Actual.fileCount -ne $Expected.fileCount -or
      $Actual.totalBytes -ne $Expected.totalBytes -or
      $Actual.treeSha256 -ne $Expected.treeSha256) {
    throw "Packaging inputs changed across $Boundary; the staged release will not be published."
  }
}

function Assert-SameReleaseSnapshot {
  param(
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)]$Actual
  )

  if ($Expected.schemaVersion -ne "proto-workbench.release-tree.v1" -or
      $Actual.schemaVersion -ne $Expected.schemaVersion -or
      $Actual.fileCount -ne $Expected.fileCount -or
      $Actual.totalBytes -ne $Expected.totalBytes -or
      $Actual.treeSha256 -ne $Expected.treeSha256) {
    throw "Published release bytes do not match the verified staging tree."
  }
}

function Assert-ManagedBuildDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Prefix
  )

  $CanonicalBuildRoot = [IO.Path]::GetFullPath($BuildRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $CanonicalPath = [IO.Path]::GetFullPath($Path)
  $ExpectedPrefix = $CanonicalBuildRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $CanonicalPath.StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $CanonicalPath).StartsWith($Prefix, [StringComparison]::Ordinal)) {
    throw "Refusing to manage a release directory outside the build staging namespace: $CanonicalPath"
  }
}

function Remove-ManagedBuildDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Prefix
  )

  Assert-ManagedBuildDirectory -Path $Path -Prefix $Prefix
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Find-UnpackedApplication {
  param([Parameter(Mandatory = $true)][string]$Root)

  $Candidates = @(Get-ChildItem -LiteralPath $Root -Directory | Where-Object { $_.Name -match '^win(?:-[^-]+)?-unpacked$' })
  if ($Candidates.Count -ne 1) {
    throw "Expected exactly one unpacked Windows application in the staged release output."
  }
  return $Candidates[0].FullName
}

function Restore-PreviousRelease {
  if (Test-Path -LiteralPath $ReleaseRoot) {
    Assert-ManagedBuildDirectory -Path $FailedRoot -Prefix "release-failed-"
    Move-Item -LiteralPath $ReleaseRoot -Destination $FailedRoot
  }
  if (Test-Path -LiteralPath $BackupRoot) {
    Move-Item -LiteralPath $BackupRoot -Destination $ReleaseRoot
  }
  if (Test-Path -LiteralPath $FailedRoot) {
    Remove-ManagedBuildDirectory -Path $FailedRoot -Prefix "release-failed-"
  }
}

try {
  $Pnpm = (Get-Command "pnpm.cmd" -ErrorAction Stop).Source
  $Node = (Get-Command "node.exe" -ErrorAction Stop).Source
  if (-not (Test-Path -LiteralPath $ElectronBuilder -PathType Leaf)) {
    throw "The project-local electron-builder command is missing: $ElectronBuilder"
  }

  Push-Location $AppRoot
  try {
    Invoke-CheckedCommand -Executable $Pnpm -Arguments @("build:icon") -Label "Application icon build"
    Invoke-CheckedCommand -Executable $Pnpm -Arguments @("sync:workspace-template") -Label "Workspace template synchronization"
    Invoke-CheckedCommand -Executable $Pnpm -Arguments @("build:sidecars") -Label "Sidecar build"
    Invoke-CheckedCommand -Executable $Pnpm -Arguments @("verify:sidecars") -Label "Sidecar verification"
    Invoke-CheckedCommand -Executable $Pnpm -Arguments @("build:desktop") -Label "Desktop build and manifest generation"
    Invoke-CheckedCommand -Executable $Pnpm -Arguments @("verify:workspace-template") -Label "Workspace template verification"

    $SnapshotArguments = @("--experimental-strip-types", $Verifier, "snapshot")
    $BeforePackage = Invoke-JsonCommand -Executable $Node -Arguments $SnapshotArguments -Label "Pre-package source snapshot"

    Assert-ManagedBuildDirectory -Path $StagingRoot -Prefix "release-staging-"
    $StagingRelative = "build/release-staging-$BuildId"
    Invoke-CheckedCommand -Executable $ElectronBuilder `
      -Arguments @("--win", "nsis", "portable", "--config.directories.output=$StagingRelative") `
      -Label "Electron Builder"

    $AfterPackage = Invoke-JsonCommand -Executable $Node -Arguments $SnapshotArguments -Label "Post-package source snapshot"
    Assert-SameSnapshot -Expected $BeforePackage -Actual $AfterPackage -Boundary "electron-builder"

    $StagedUnpacked = Find-UnpackedApplication -Root $StagingRoot
    $VerifyArguments = @("--experimental-strip-types", $Verifier, "verify", "--unpacked", $StagedUnpacked)
    $StagedEvidence = Invoke-JsonCommand -Executable $Node -Arguments $VerifyArguments -Label "Staged packaged-payload verification"
    $StagedRelease = Invoke-JsonCommand -Executable $Node `
      -Arguments @("--experimental-strip-types", $Verifier, "release-snapshot", "--root", $StagingRoot) `
      -Label "Staged release-tree snapshot"
    $TopLevelExecutables = @($StagedRelease.topLevelExecutables)
    if ($TopLevelExecutables.Count -ne 2 -or
        @($TopLevelExecutables | Where-Object { $_ -match '-setup\.exe$' }).Count -ne 1 -or
        @($TopLevelExecutables | Where-Object { $_ -match '-portable\.exe$' }).Count -ne 1) {
      throw "The staged release must contain exactly one top-level setup EXE and one top-level portable EXE."
    }

    if (Test-Path -LiteralPath $ReleaseRoot) {
      Assert-ManagedBuildDirectory -Path $BackupRoot -Prefix "release-backup-"
      Move-Item -LiteralPath $ReleaseRoot -Destination $BackupRoot
    }
    try {
      Move-Item -LiteralPath $StagingRoot -Destination $ReleaseRoot
      $PublishedUnpacked = Find-UnpackedApplication -Root $ReleaseRoot
      $PublishedEvidence = Invoke-JsonCommand -Executable $Node `
        -Arguments @("--experimental-strip-types", $Verifier, "verify", "--unpacked", $PublishedUnpacked) `
        -Label "Published packaged-payload verification"
      $PublishedRelease = Invoke-JsonCommand -Executable $Node `
        -Arguments @("--experimental-strip-types", $Verifier, "release-snapshot", "--root", $ReleaseRoot) `
        -Label "Published release-tree snapshot"
      Assert-SameReleaseSnapshot -Expected $StagedRelease -Actual $PublishedRelease
      $AfterPublish = Invoke-JsonCommand -Executable $Node -Arguments $SnapshotArguments -Label "Post-publish source snapshot"
      Assert-SameSnapshot -Expected $BeforePackage -Actual $AfterPublish -Boundary "final publication"
    } catch {
      Restore-PreviousRelease
      throw
    }

    if (Test-Path -LiteralPath $BackupRoot) {
      Remove-ManagedBuildDirectory -Path $BackupRoot -Prefix "release-backup-"
    }
    Write-Host ("Windows release published: manifest={0}, asar={1}, runtime-files={2}" -f `
      $PublishedEvidence.manifestSha256,
      $PublishedEvidence.asarSha256,
      $PublishedEvidence.verifiedRuntimeResources)
  } finally {
    Pop-Location
  }
} finally {
  if (Test-Path -LiteralPath $StagingRoot) {
    Remove-ManagedBuildDirectory -Path $StagingRoot -Prefix "release-staging-"
  }
  if (Test-Path -LiteralPath $FailedRoot) {
    Remove-ManagedBuildDirectory -Path $FailedRoot -Prefix "release-failed-"
  }
  if ($null -ne $LockStream) {
    $LockStream.Dispose()
  }
}
