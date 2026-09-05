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
    switch ($Task) {
      "Desktop" {
        Invoke-BuildCommand $Node @("scripts/sync-workspace-template.mjs", "--write")
        Invoke-BuildCommand $Node @("node_modules/electron-vite/bin/electron-vite.js", "build")
        Invoke-BuildCommand $Node @("--experimental-strip-types", "scripts/generate-module-manifest.mjs")
      }
      "Renderer" { Invoke-BuildCommand $Node @("node_modules/vite/bin/vite.js", "build", "--configLoader", "runner") }
      "DevDesktop" { Invoke-BuildCommand $Node @("node_modules/electron-vite/bin/electron-vite.js", "dev") }
      "SyncTemplate" { Invoke-BuildCommand $Node @("scripts/sync-workspace-template.mjs", "--write") }
      "Icon" { Invoke-BuildCommand $Node @("scripts/build-app-icon.mjs") }
    }
  } finally { Pop-Location }
} finally { Exit-ProjectBuildLease $Lease }
