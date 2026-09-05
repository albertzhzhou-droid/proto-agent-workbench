param([string]$EvidenceRoot = "")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$OriginalAppRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $OriginalAppRoot "..\..")).Path
. (Join-Path $PSScriptRoot "build-transaction.ps1")
if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) { $EvidenceRoot = Join-Path $RepoRoot "build\upgrade-20260904\native-qa" }
Assert-BuildManagedPath -Path $EvidenceRoot -Boundary (Join-Path $RepoRoot "build")
$Lease = Enter-ProjectBuildLease -AppRoot $OriginalAppRoot
try {
  $Node = (Get-Command node.exe -ErrorAction Stop).Source
  $RunRoot = Join-Path $EvidenceRoot ("desktop-" + [Guid]::NewGuid().ToString("N"))
  $InputRepoRoot = Join-Path $RunRoot "repository"
  $Manifest = Join-Path $RunRoot "build-inputs.json"
  New-Item -ItemType Directory -Path $RunRoot -Force | Out-Null
  $Snapshotter = Join-Path $PSScriptRoot "build-input-snapshot.mjs"
  Invoke-BuildCommand $Node @($Snapshotter, "create", "--source", $RepoRoot, "--destination", $InputRepoRoot, "--manifest", $Manifest, "--profile", "desktop-qa")
  $CapturedInputs = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
  $CaptureSeal = [ordered]@{
    schemaVersion = "proto-workbench.native-qa-capture.v1"
    status = "source-capture-sealed; desktop-build-pending"
    repository = $InputRepoRoot
    inputManifest = $Manifest
    sourceTreeSha256 = $CapturedInputs.treeSha256
  }
  $CaptureSeal | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunRoot "capture-seal.json") -Encoding UTF8
  Write-Output ("NATIVE_QA_CAPTURE_SEALED " + ($CaptureSeal | ConvertTo-Json -Compress))
  $StagedAppRoot = Join-Path $InputRepoRoot "apps\proto-workbench"
  & (Join-Path $StagedAppRoot "scripts\build-desktop.ps1") -Task Desktop -BuildLease $Lease
  Invoke-BuildCommand $Node @($Snapshotter, "verify", "--root", $InputRepoRoot, "--manifest", $Manifest)
  $Report = [ordered]@{
    schemaVersion = "proto-workbench.native-qa-build.v1"
    appRoot = $StagedAppRoot
    repoRoot = $InputRepoRoot
    inputManifest = $Manifest
    mainEntry = (Join-Path $StagedAppRoot "out\main\index.js")
    electron = (Join-Path $StagedAppRoot "node_modules\electron\dist\electron.exe")
    pythonExecutable = (Join-Path $RepoRoot ".venv\Scripts\python.exe")
    dependencyIsolation = "Shared installed dependency tree; do not modify dependencies during this development QA build. Release isolation is not claimed."
    scope = "Development Electron desktop build with copied source, private output, current copied Python source and retained runtime bytes; no installer or release claim."
  }
  $Report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunRoot "desktop-build.json") -Encoding UTF8
  $Report | ConvertTo-Json
} finally { Exit-ProjectBuildLease $Lease }
