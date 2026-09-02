param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("cuda", "cpu")]
  [string]$Flavor,

  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [string]$CompanionArchivePath
)

$ErrorActionPreference = "Stop"
$AppRoot = Split-Path -Parent $PSScriptRoot
$LockPath = Join-Path $AppRoot "runtime\llama.cpp\release-lock.json"
if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
  throw "Missing pinned llama.cpp release lock: $LockPath"
}
$Lock = Get-Content -Raw -LiteralPath $LockPath | ConvertFrom-Json
$ExpectedRepository = "https://github.com/ggml-org/llama.cpp"
if ($Lock.repository -cne $ExpectedRepository -or -not $Lock.releaseTag -or -not $Lock.assets) {
  throw "Invalid pinned llama.cpp release lock"
}
$ExpectedArchive = $Lock.assets.$Flavor
if (-not $ExpectedArchive -or -not $ExpectedArchive.name -or -not $ExpectedArchive.sha256) {
  throw "The release lock does not define the $Flavor archive"
}
if ((Split-Path -Leaf $ArchivePath) -cne [string]$ExpectedArchive.name) {
  throw "Archive name does not match the locked $Flavor asset"
}

$ExpectedCompanion = $null
if ($Flavor -eq "cuda") {
  if (-not $CompanionArchivePath) {
    throw "CUDA staging requires the locked CUDA runtime companion archive"
  }
  $ExpectedCompanion = $Lock.assets.cudaRuntime
  if (-not $ExpectedCompanion -or -not $ExpectedCompanion.name -or -not $ExpectedCompanion.sha256) {
    throw "The release lock does not define the CUDA runtime companion archive"
  }
  if ((Split-Path -Leaf $CompanionArchivePath) -cne [string]$ExpectedCompanion.name) {
    throw "Companion archive name does not match the locked CUDA runtime asset"
  }
} elseif ($CompanionArchivePath) {
  throw "CPU staging does not accept a companion archive"
}

$Archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$CompanionArchive = if ($Flavor -eq "cuda") {
  (Resolve-Path -LiteralPath $CompanionArchivePath).Path
} else {
  $null
}

function Assert-ArchiveHash {
  param(
    [string]$Path,
    [string]$Expected
  )

  if (-not $Expected -or $Expected -notmatch "^[0-9a-fA-F]{64}$") {
    throw "Invalid locked SHA256 for $Path"
  }
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      $Actual = [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
  if ($Actual -cne $Expected.ToLowerInvariant()) {
    throw "SHA256 mismatch for $Path"
  }
  return $Actual
}

$ArchiveHash = Assert-ArchiveHash -Path $Archive -Expected ([string]$ExpectedArchive.sha256)
$CompanionHash = if ($CompanionArchive) {
  Assert-ArchiveHash -Path $CompanionArchive -Expected ([string]$ExpectedCompanion.sha256)
} else {
  $null
}

$TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$UnpackRoot = Join-Path $TempRoot ("proto-workbench-llama-" + [guid]::NewGuid().ToString("N"))
$MainUnpack = Join-Path $UnpackRoot "main"
$CompanionUnpack = Join-Path $UnpackRoot "companion"
$RuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $AppRoot "runtime\llama.cpp"))
$RuntimePrefix = $RuntimeRoot.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
$Target = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot $Flavor))
$OperationId = [guid]::NewGuid().ToString("N")
$StageTarget = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot (".staging-" + $Flavor + "-" + $OperationId)))
$BackupTarget = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot (".backup-" + $Flavor + "-" + $OperationId)))
foreach ($OwnedPath in @($Target, $StageTarget, $BackupTarget)) {
  if (-not $OwnedPath.StartsWith($RuntimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage outside the owned llama.cpp runtime root"
  }
}
$BackupCreated = $false
$Installed = $false

try {
  New-Item -ItemType Directory -Force -Path $MainUnpack | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $MainUnpack
  $Server = Get-ChildItem -LiteralPath $MainUnpack -Recurse -File -Filter "llama-server.exe" | Select-Object -First 1
  if (-not $Server) {
    throw "The archive does not contain llama-server.exe"
  }

  New-Item -ItemType Directory -Force -Path $StageTarget | Out-Null
  Get-ChildItem -LiteralPath $Server.Directory.FullName -File | Copy-Item -Destination $StageTarget -Force

  if ($CompanionArchive) {
    New-Item -ItemType Directory -Force -Path $CompanionUnpack | Out-Null
    Expand-Archive -LiteralPath $CompanionArchive -DestinationPath $CompanionUnpack
    $CompanionDlls = Get-ChildItem -LiteralPath $CompanionUnpack -Recurse -File -Filter "*.dll"
    if (-not $CompanionDlls) {
      throw "The companion archive does not contain CUDA runtime DLLs"
    }
    $CompanionDlls | Copy-Item -Destination $StageTarget -Force
  }

  $Archives = @(
    [ordered]@{
      name = Split-Path -Leaf $Archive
      sha256 = $ArchiveHash
    }
  )
  if ($CompanionArchive) {
    $Archives += [ordered]@{
      name = Split-Path -Leaf $CompanionArchive
      sha256 = $CompanionHash
    }
  }

  [ordered]@{
    flavor = $Flavor
    sourceRepository = [string]$Lock.repository
    releaseTag = [string]$Lock.releaseTag
    archives = $Archives
    stagedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StageTarget "runtime-manifest.json") -Encoding utf8

  if (Test-Path -LiteralPath $Target) {
    Move-Item -LiteralPath $Target -Destination $BackupTarget
    $BackupCreated = $true
  }
  try {
    Move-Item -LiteralPath $StageTarget -Destination $Target
    $Installed = $true
  } catch {
    if ($BackupCreated -and -not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $BackupTarget)) {
      Move-Item -LiteralPath $BackupTarget -Destination $Target
      $BackupCreated = $false
    }
    throw
  }
  if ($BackupCreated -and (Test-Path -LiteralPath $BackupTarget)) {
    Remove-Item -LiteralPath $BackupTarget -Recurse -Force
    $BackupCreated = $false
  }
} finally {
  if (-not $Installed -and $BackupCreated -and -not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $BackupTarget)) {
    Move-Item -LiteralPath $BackupTarget -Destination $Target
    $BackupCreated = $false
  }
  if (Test-Path -LiteralPath $StageTarget) {
    Remove-Item -LiteralPath $StageTarget -Recurse -Force
  }
  $ResolvedUnpack = [System.IO.Path]::GetFullPath($UnpackRoot)
  if ($ResolvedUnpack.StartsWith($TempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $ResolvedUnpack)) {
    Remove-Item -LiteralPath $ResolvedUnpack -Recurse -Force
  }
}

Write-Host "Independent llama.cpp $Flavor runtime staged at $Target"
