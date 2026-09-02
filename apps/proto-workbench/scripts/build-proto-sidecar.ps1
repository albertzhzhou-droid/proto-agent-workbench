param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$AppRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Resolve-Path (Join-Path $AppRoot "..\..")
$Destination = Join-Path $AppRoot "runtime\proto-agent"
$BuildRoot = Join-Path $AppRoot "build\pyinstaller"

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null

function Build-Sidecar {
  param(
    [string]$Name,
    [string]$EntryPoint,
    [switch]$CollectGguf
  )

  $Arguments = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name", $Name,
    "--paths", (Join-Path $RepoRoot "src"),
    "--distpath", $Destination,
    "--workpath", (Join-Path $BuildRoot $Name),
    "--specpath", $BuildRoot
  )
  if ($CollectGguf) {
    $Arguments += @("--collect-all", "gguf")
  }
  $Arguments += $EntryPoint

  & $Python @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed while building $Name"
  }
}

Push-Location $RepoRoot
try {
  Build-Sidecar `
    -Name "proto-workbench-sidecar" `
    -EntryPoint (Join-Path $PSScriptRoot "proto_sidecar_entry.py") `
    -CollectGguf
  Build-Sidecar `
    -Name "proto-agent-mcp" `
    -EntryPoint (Join-Path $PSScriptRoot "proto_mcp_entry.py")
  Build-Sidecar `
    -Name "proto-agent" `
    -EntryPoint (Join-Path $PSScriptRoot "proto_cli_entry.py")
} finally {
  Pop-Location
}

Write-Host "Proto sidecars staged at $Destination"
