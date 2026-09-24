param(
  [ValidateSet("Desktop", "Renderer", "DevDesktop", "SyncTemplate", "Icon")][string]$Task = "Desktop",
  $BuildLease = $null
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$AppRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "build-transaction.ps1")
$Lease = Enter-ProjectBuildLease -AppRoot $AppRoot -ParentLease $BuildLease
try {
  $Node = (Get-Command node.exe -ErrorAction Stop).Source
  Push-Location $AppRoot
  try {
    $ContentIdentity = $null
    if ($Task -in @("Desktop", "Renderer")) {
      $RepoRoot = (Resolve-Path (Join-Path $AppRoot "..\..")).Path
      $IdentityRoot = Join-Path $AppRoot ("build\content-identity\" + [Guid]::NewGuid().ToString("N"))
      $InputIdentity = Join-Path $IdentityRoot "inputs.json"
      $ContentIdentity = Join-Path $IdentityRoot "identity.json"
      Invoke-BuildCommand $Node @("scripts/build-content-identity.mjs", "capture", "--repo", $RepoRoot, "--profile", $Task.ToLowerInvariant(), "--manifest", $InputIdentity)
    }
    switch ($Task) {
      "Desktop" {
        Invoke-BuildCommand $Node @("scripts/sync-chem-workbench.mjs")
        Invoke-BuildCommand $Node @("scripts/sync-workspace-template.mjs", "--write")
        Invoke-BuildCommand $Node @("node_modules/electron-vite/bin/electron-vite.js", "build")
        Invoke-BuildCommand $Node @("--experimental-strip-types", "scripts/generate-module-manifest.mjs")
      }
      "Renderer" { Invoke-BuildCommand $Node @("scripts/sync-chem-workbench.mjs"); Invoke-BuildCommand $Node @("node_modules/vite/bin/vite.js", "build", "--configLoader", "runner") }
      "DevDesktop" { Invoke-BuildCommand $Node @("scripts/sync-chem-workbench.mjs"); Invoke-BuildCommand $Node @("node_modules/electron-vite/bin/electron-vite.js", "dev") }
      "SyncTemplate" { Invoke-BuildCommand $Node @("scripts/sync-workspace-template.mjs", "--write") }
      "Icon" { Invoke-BuildCommand $Node @("scripts/build-app-icon.mjs") }
    }
    if ($null -ne $ContentIdentity) {
      Invoke-BuildCommand $Node @("scripts/build-content-identity.mjs", "seal", "--repo", $RepoRoot, "--capture", $InputIdentity, "--manifest", $ContentIdentity)
      Write-Output ("BUILD_CONTENT_IDENTITY " + $ContentIdentity)
    }
  } finally { Pop-Location }
} finally { Exit-ProjectBuildLease $Lease }
