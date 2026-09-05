param([switch]$CandidateOnly, [string]$ArchiveTool = "")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$OriginalAppRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = $OriginalAppRoot
$RepoRoot = (Resolve-Path (Join-Path $AppRoot "..\..")).Path
. (Join-Path $PSScriptRoot "build-transaction.ps1")
$BuildRoot = Join-Path $AppRoot "build"
# Keep evidence in the application build boundary and private source at the
# shallower repository build boundary. NSIS includes also obey MAX_PATH.
$InputId = [Guid]::NewGuid().ToString("N")
$InputRoot = Join-Path $BuildRoot ("i-" + $InputId)
$RepositoryBuildRoot = Join-Path $RepoRoot "build"
$InputRepoRoot = Join-Path $RepositoryBuildRoot $InputId
$InputManifest = Join-Path $InputRoot "build-inputs.json"
$PrivateInputManifest = Join-Path $InputRoot "private-build-inputs.json"
$RelocationReceipt = Join-Path $InputRoot "private-dependency-relocation.json"
$SourceSnapshotter = Join-Path $PSScriptRoot "build-input-snapshot.mjs"
$BuildId = [Guid]::NewGuid().ToString("N")
$StagingRoot = Join-Path $BuildRoot "release-staging-$BuildId"
$BackupRoot = Join-Path $BuildRoot "release-backup-$BuildId"
$FailedRoot = Join-Path $BuildRoot "release-failed-$BuildId"
$ReleaseRoot = Join-Path $AppRoot "release"
$RetainCandidate = $false
$BuildFailure = $null
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$Lease = Enter-ProjectBuildLease -AppRoot $OriginalAppRoot

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
  Assert-BuildManagedPath -Path $Path -Boundary $BuildRoot
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

function Get-DistributionSignature {
  param([Parameter(Mandatory=$true)][string]$Path)
  $Signature = Get-AuthenticodeSignature -LiteralPath $Path
  return [ordered]@{
    path = $Path
    sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    status = [string]$Signature.Status
    signerThumbprint = $(if ($Signature.SignerCertificate) { $Signature.SignerCertificate.Thumbprint } else { $null })
    timestampThumbprint = $(if ($Signature.TimeStamperCertificate) { $Signature.TimeStamperCertificate.Thumbprint } else { $null })
    reputation = "Windows reputation and SmartScreen were not tested by Authenticode inspection."
  }
}

function Restore-PreviousRelease {
  Assert-BuildManagedPath -Path $ReleaseRoot -Boundary $OriginalAppRoot
  Assert-ManagedBuildDirectory -Path $BackupRoot -Prefix "release-backup-"
  if (Test-Path -LiteralPath $ReleaseRoot) {
    Assert-ManagedBuildDirectory -Path $FailedRoot -Prefix "release-failed-"
    Move-FailedBuildEvidence -Path $ReleaseRoot -SourceBoundary $OriginalAppRoot -Destination $FailedRoot -BuildRoot $BuildRoot
  }
  if (Test-Path -LiteralPath $BackupRoot) {
    Move-Item -LiteralPath $BackupRoot -Destination $ReleaseRoot
  }
}

try {
  $Node = (Get-Command "node.exe" -ErrorAction Stop).Source
  if ([string]::IsNullOrWhiteSpace($ArchiveTool)) {
    $ArchiveCommand = Get-Command "7z.exe" -ErrorAction SilentlyContinue
    if ($ArchiveCommand) { $ArchiveTool = $ArchiveCommand.Source }
    elseif (Test-Path -LiteralPath "C:\Program Files\7-Zip\7z.exe" -PathType Leaf) { $ArchiveTool = "C:\Program Files\7-Zip\7z.exe" }
    else { throw "Specify -ArchiveTool with an existing NSIS-capable full 7z.exe or 7zz.exe. The limited Electron Builder 7za is insufficient." }
  }
  $ArchiveTool = (Resolve-Path -LiteralPath $ArchiveTool).Path
  $ArchiveProbe = Invoke-JsonCommand -Executable $Node -Arguments @("--experimental-strip-types", (Join-Path $PSScriptRoot "verify-distribution-payloads.mjs"), "--probe", "--7zip", $ArchiveTool) -Label "NSIS archive verifier preflight"
  Assert-BuildManagedPath -Path $InputRoot -Boundary $BuildRoot
  Assert-BuildManagedPath -Path $RepositoryBuildRoot -Boundary $RepoRoot
  Assert-BuildManagedPath -Path $InputRepoRoot -Boundary $RepositoryBuildRoot
  New-Item -ItemType Directory -Path $InputRoot | Out-Null
  $ProjectedPaths = Invoke-JsonCommand -Executable $Node `
    -Arguments @((Join-Path $PSScriptRoot "package-paths.mjs"), "project", "--source", $RepoRoot, "--private", $InputRepoRoot) `
    -Label "Projected NSIS working-directory verification"
  $ProjectedPathReceipt = Join-Path $InputRoot "projected-build-paths.json"
  $ProjectedPaths | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ProjectedPathReceipt -Encoding UTF8
  Invoke-CheckedCommand -Executable $Node -Arguments @($SourceSnapshotter, "create", "--source", $RepoRoot, "--destination", $InputRepoRoot, "--manifest", $InputManifest) -Label "Private build input capture"
  $SourceInputs = Get-Content -LiteralPath $InputManifest -Raw | ConvertFrom-Json
  $AppRoot = Join-Path $InputRepoRoot "apps\proto-workbench"
  $StageScripts = Join-Path $AppRoot "scripts"
  $PrivateRelocation = Invoke-JsonCommand -Executable $Node `
    -Arguments @((Join-Path $StageScripts "relocate-private-pnpm.mjs"), "--source", $RepoRoot, "--private", $InputRepoRoot, "--input-manifest", $InputManifest, "--private-manifest", $PrivateInputManifest, "--receipt", $RelocationReceipt) `
    -Label "Private pnpm metadata relocation"
  $Verifier = Join-Path $StageScripts "verify-packaged-integrity.mjs"
  $ElectronBuilder = Join-Path $StageScripts "package-builder.mjs"
  $BuilderPolicyReceipt = Join-Path $InputRoot "builder-policy.json"
  $Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
  $Toolchain = [ordered]@{
    schemaVersion = "proto-workbench.build-toolchain.v1"
    nodeSha256 = (Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant()
    pythonSha256 = (Get-FileHash -LiteralPath $Python -Algorithm SHA256).Hash.ToLowerInvariant()
    archiveToolSha256 = (Get-FileHash -LiteralPath $ArchiveTool -Algorithm SHA256).Hash.ToLowerInvariant()
    archiveDependencies = @($ArchiveProbe.tool.dependencies)
    archiveToolVersion = $ArchiveProbe.tool.version
    isolation = "Private source and dependency copies; external Windows and Python toolchains are not hermetic."
  }
  $Toolchain | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $InputRoot "toolchain.json") -Encoding UTF8

  Push-Location $AppRoot
  try {
    & (Join-Path $StageScripts "build-desktop.ps1") -Task Icon -BuildLease $Lease
    & (Join-Path $StageScripts "build-desktop.ps1") -Task SyncTemplate -BuildLease $Lease
    & (Join-Path $StageScripts "build-proto-sidecar.ps1") -Python $Python -BuildLease $Lease
    & (Join-Path $StageScripts "verify-sidecars.ps1")
    & (Join-Path $StageScripts "build-desktop.ps1") -Task Desktop -BuildLease $Lease
    Invoke-CheckedCommand -Executable $Node -Arguments @("scripts/sync-workspace-template.mjs", "--check") -Label "Workspace template verification"
    Invoke-CheckedCommand -Executable $Node -Arguments @($SourceSnapshotter, "verify", "--root", $InputRepoRoot, "--manifest", $PrivateInputManifest) -Label "Built private source verification"

    $SnapshotArguments = @("--experimental-strip-types", $Verifier, "snapshot")
    $BeforePackage = Invoke-JsonCommand -Executable $Node -Arguments $SnapshotArguments -Label "Pre-package source snapshot"
    $ActualPaths = Invoke-JsonCommand -Executable $Node `
      -Arguments @((Join-Path $StageScripts "package-paths.mjs"), "verify", "--private", $InputRepoRoot, "--projected", $ProjectedPathReceipt) `
      -Label "Actual private NSIS working-directory verification"
    $ActualPaths | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $InputRoot "actual-build-paths.json") -Encoding UTF8

    Assert-ManagedBuildDirectory -Path $StagingRoot -Prefix "release-staging-"
    Invoke-CheckedCommand -Executable $Node `
      -Arguments @($ElectronBuilder, "--source", $RepoRoot, "--private", $InputRepoRoot, "--release", $StagingRoot, "--receipt", $BuilderPolicyReceipt) `
      -Label "Electron Builder"

    $AfterPackage = Invoke-JsonCommand -Executable $Node -Arguments $SnapshotArguments -Label "Post-package source snapshot"
    Assert-SameSnapshot -Expected $BeforePackage -Actual $AfterPackage -Boundary "electron-builder"

    $StagedUnpacked = Find-UnpackedApplication -Root $StagingRoot
    $VerifyArguments = @("--experimental-strip-types", $Verifier, "verify", "--unpacked", $StagedUnpacked)
    $StagedEvidence = Invoke-JsonCommand -Executable $Node -Arguments $VerifyArguments -Label "Staged packaged-payload verification"
    $DistributionEvidence = Invoke-JsonCommand -Executable $Node `
      -Arguments @("--experimental-strip-types", (Join-Path $StageScripts "verify-distribution-payloads.mjs"), "--release", $StagingRoot, "--unpacked", $StagedUnpacked, "--evidence", (Join-Path $InputRoot "distribution-verification"), "--7zip", $ArchiveTool) `
      -Label "Installer and Portable embedded-payload verification"
    $StagedRelease = Invoke-JsonCommand -Executable $Node `
      -Arguments @("--experimental-strip-types", $Verifier, "release-snapshot", "--root", $StagingRoot) `
      -Label "Staged release-tree snapshot"
    $TopLevelExecutables = @($StagedRelease.topLevelExecutables)
    if ($TopLevelExecutables.Count -ne 2 -or
        @($TopLevelExecutables | Where-Object { $_ -match '-setup\.exe$' }).Count -ne 1 -or
        @($TopLevelExecutables | Where-Object { $_ -match '-portable\.exe$' }).Count -ne 1) {
      throw "The staged release must contain exactly one top-level setup EXE and one top-level portable EXE."
    }

    Invoke-CheckedCommand -Executable $Node -Arguments @($SourceSnapshotter, "verify", "--root", $RepoRoot, "--manifest", $InputManifest) -Label "Original source verification before publication"
    Invoke-CheckedCommand -Executable $Node -Arguments @($SourceSnapshotter, "verify", "--root", $InputRepoRoot, "--manifest", $PrivateInputManifest) -Label "Private source verification before publication"
    if ((Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Toolchain.nodeSha256 -or
        (Get-FileHash -LiteralPath $Python -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Toolchain.pythonSha256 -or
        (Get-FileHash -LiteralPath $ArchiveTool -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Toolchain.archiveToolSha256) {
      throw "Recorded build toolchain executables changed; publication is blocked."
    }
    foreach ($ArchiveDependency in $Toolchain.archiveDependencies) {
      if ((Get-FileHash -LiteralPath $ArchiveDependency.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ArchiveDependency.sha256) {
        throw "Archive decoder library changed; publication is blocked."
      }
    }
    if ($CandidateOnly) {
      $PackageMetadata = Get-Content -LiteralPath (Join-Path $AppRoot "package.json") -Raw | ConvertFrom-Json
      $UnpackedExecutable = Join-Path $StagedUnpacked ($PackageMetadata.productName + ".exe")
      if (-not (Test-Path -LiteralPath $UnpackedExecutable -PathType Leaf)) { throw "The candidate smoke launch executable is missing." }
      $Signatures = @($TopLevelExecutables | ForEach-Object { Get-DistributionSignature -Path (Join-Path $StagingRoot $_) })
      $Signatures += Get-DistributionSignature -Path $UnpackedExecutable
      $Candidate = [ordered]@{
        schemaVersion = "proto-workbench.release-candidate.v2"
        status = "payload-verified; native smoke pending"
        version = $PackageMetadata.version
        releaseRoot = $StagingRoot
        inputRoot = $InputRoot
        inputManifest = $InputManifest
        inputManifestSha256 = (Get-FileHash -LiteralPath $InputManifest -Algorithm SHA256).Hash.ToLowerInvariant()
        privateInputManifest = $PrivateInputManifest
        privateInputManifestSha256 = (Get-FileHash -LiteralPath $PrivateInputManifest -Algorithm SHA256).Hash.ToLowerInvariant()
        privateDependencyRelocation = $PrivateRelocation
        builderPolicy = (Get-Content -LiteralPath $BuilderPolicyReceipt -Raw | ConvertFrom-Json)
        sourceTreeSha256 = $SourceInputs.treeSha256
        workingDirectories = [ordered]@{ projected = $ProjectedPaths; actual = $ActualPaths }
        builtPayload = $BeforePackage
        toolchain = $Toolchain
        packageEvidence = $StagedEvidence
        distributionEvidence = $DistributionEvidence
        signatures = $Signatures
        releaseSnapshot = $StagedRelease
        smoke = [ordered]@{
          status = "not-run"
          unpackedExecutable = $UnpackedExecutable
          portableExecutable = (Join-Path $StagingRoot (@($TopLevelExecutables | Where-Object { $_ -match '-portable\.exe$' })[0]))
          sessionArgument = "--session-root=<existing absolute owned QA session directory>"
          workspaceRequirement = "The explicit session binds profile and workspace directly beneath its canonical root and skips default Documents workspace seeding. Prepare authorized workspace inputs before launch and verify the actual runtime paths."
          requirement = "Owned native launch with isolated profile/workspace, visible window, verified module integrity, packaged sidecar response, clean shutdown and logs; recheck executable and ASAR hashes before recording success."
          installerOsIntegration = "not-run; embedded payload verification does not test installer registry, shortcuts, upgrades, or uninstallation"
        }
        publication = "Candidate only; the prior local release is unchanged and nothing was uploaded."
      }
      $Candidate | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $InputRoot "release-candidate.json") -Encoding UTF8
      $RetainCandidate = $true
      $Candidate | ConvertTo-Json -Depth 12
      return
    }
    if (Test-Path -LiteralPath $ReleaseRoot) {
      Assert-BuildManagedPath -Path $ReleaseRoot -Boundary $OriginalAppRoot
      Assert-ManagedBuildDirectory -Path $BackupRoot -Prefix "release-backup-"
      Move-Item -LiteralPath $ReleaseRoot -Destination $BackupRoot
    }
    try {
      Assert-BuildManagedPath -Path $ReleaseRoot -Boundary $OriginalAppRoot
      Assert-ManagedBuildDirectory -Path $StagingRoot -Prefix "release-staging-"
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
      Invoke-CheckedCommand -Executable $Node -Arguments @($SourceSnapshotter, "verify", "--root", $RepoRoot, "--manifest", $InputManifest) -Label "Original source verification after publication"
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
} catch {
  $BuildFailure = $_
  throw
} finally {
  try {
    if (-not $RetainCandidate -and (Test-Path -LiteralPath $StagingRoot)) {
      if ($null -ne $BuildFailure) {
        $PreservedFailure = Move-FailedReleaseStage -Path $StagingRoot -BuildRoot $BuildRoot -BuildId $BuildId
        [ordered]@{ schemaVersion = "proto-workbench.failed-release.v1"; status = "unverified; do not distribute";
          primaryError = [string]$BuildFailure; originalStagingRoot = $StagingRoot; retainedRoot = $PreservedFailure;
          buildId = $BuildId; inputRoot = $InputRoot } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $InputRoot "release-failure.json") -Encoding UTF8
        Write-Warning "Unverified failed release retained at $PreservedFailure"
      } else {
        Remove-ManagedBuildDirectory -Path $StagingRoot -Prefix "release-staging-"
      }
    }
  } catch {
    if ($null -eq $BuildFailure) { throw }
    Write-Warning "Failure-evidence retention also failed; original build error is preserved. Staging remains at its last path. $($_.Exception.Message)"
  } finally {
    Exit-ProjectBuildLease $Lease
  }
}
