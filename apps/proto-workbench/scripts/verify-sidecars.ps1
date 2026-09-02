Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent $PSScriptRoot
$TemplateRoot = Join-Path $AppRoot "runtime\workspace-template"
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$Workspace = Join-Path $TempRoot ("proto-sidecar-verify-" + [Guid]::NewGuid().ToString("N"))
$Confirmation = "YES_START_OWNED_SIDECARS"
$PreviousConfirmation = [Environment]::GetEnvironmentVariable("PROTO_AGENT_ALLOW_SIDECAR_TESTS", "Process")

function Remove-DisposableWorkspace {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Resolved = [IO.Path]::GetFullPath($Path)
  $ExpectedPrefix = $TempRoot + [IO.Path]::DirectorySeparatorChar
  $Leaf = Split-Path -Leaf $Resolved
  if (-not $Resolved.StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not $Leaf.StartsWith("proto-sidecar-verify-", [StringComparison]::Ordinal)) {
    throw "Refusing to remove a workspace outside the managed temporary namespace: $Resolved"
  }
  if (Test-Path -LiteralPath $Resolved) {
    Remove-Item -LiteralPath $Resolved -Recurse -Force
  }
}

try {
  if (-not (Test-Path -LiteralPath $TemplateRoot -PathType Container)) {
    throw "The packaged workspace template is missing: $TemplateRoot"
  }
  New-Item -ItemType Directory -Path $Workspace | Out-Null
  foreach ($Entry in Get-ChildItem -LiteralPath $TemplateRoot -Force) {
    Copy-Item -LiteralPath $Entry.FullName -Destination $Workspace -Recurse -Force
  }
  [IO.File]::WriteAllText(
    (Join-Path $Workspace ".proto-agent-disposable-workspace"),
    "PROTO_AGENT_DISPOSABLE_WORKSPACE_V1`n",
    [Text.UTF8Encoding]::new($false)
  )

  [Environment]::SetEnvironmentVariable("PROTO_AGENT_ALLOW_SIDECAR_TESTS", $Confirmation, "Process")
  & node (Join-Path $PSScriptRoot "verify-sidecars.mjs") `
    $Workspace `
    $AppRoot `
    "--confirm-owned-execution=$Confirmation"
  if ($LASTEXITCODE -ne 0) {
    throw "Packaged sidecar verification failed with exit code $LASTEXITCODE."
  }
} finally {
  [Environment]::SetEnvironmentVariable("PROTO_AGENT_ALLOW_SIDECAR_TESTS", $PreviousConfirmation, "Process")
  Remove-DisposableWorkspace -Path $Workspace
}
