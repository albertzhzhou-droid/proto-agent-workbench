param(
  [string]$Python = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $AppRoot "..\..")).Path
$RuntimeRoot = Join-Path $AppRoot "runtime"
$Destination = Join-Path $RuntimeRoot "proto-agent"
$BuildRoot = Join-Path $AppRoot "build\pyinstaller"
$LockRoot = Join-Path $AppRoot "build\locks"
$BuildId = [Guid]::NewGuid().ToString("N")
$Staging = Join-Path $RuntimeRoot ".proto-agent-staging-$BuildId"
$Backup = Join-Path $RuntimeRoot ".proto-agent-backup-$BuildId"
$Failed = Join-Path $RuntimeRoot ".proto-agent-failed-$BuildId"
$ReadmeSource = Join-Path $Destination "README.md"
$McpRequestRelative = "apps/proto-workbench/build/pyinstaller/mcp-tools-list-$BuildId.json"
$McpRequestPath = Join-Path $RepoRoot ($McpRequestRelative -replace "/", "\")

if ([string]::IsNullOrWhiteSpace($Python)) {
  $Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
}
if (Test-Path -LiteralPath $Python -PathType Leaf) {
  $Python = (Resolve-Path -LiteralPath $Python).Path
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw "The project-local Python executable is missing: $Python. Create .venv and install PyInstaller there."
}
if (-not (Test-Path -LiteralPath $ReadmeSource -PathType Leaf)) {
  throw "The sidecar README source is missing: $ReadmeSource"
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $LockRoot | Out-Null

$LockPath = Join-Path $LockRoot "sidecar-build.lock"
$LockStream = $null
try {
  $LockStream = [System.IO.File]::Open(
    $LockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch [System.IO.IOException] {
  throw "Another sidecar build owns the project lock: $LockPath"
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

function Assert-File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $Item = Get-Item -LiteralPath $Path -Force
  if ($Item.PSIsContainer -or $Item.Length -le 0 -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be a non-empty regular file: $Path"
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Stream = [IO.File]::OpenRead($Path)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Bytes = $Hasher.ComputeHash($Stream)
    return -join ($Bytes | ForEach-Object { $_.ToString("x2") })
  } finally {
    $Hasher.Dispose()
    $Stream.Dispose()
  }
}

function Assert-SidecarRuntime {
  param([Parameter(Mandatory = $true)][string]$Root)

  $RootItem = Get-Item -LiteralPath $Root -Force
  if (-not $RootItem.PSIsContainer -or ($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "The staged sidecar root must be a real directory: $Root"
  }

  $ExpectedEntries = @("proto-agent", "proto-agent-mcp", "README.md")
  $ActualEntries = @(Get-ChildItem -LiteralPath $Root -Force | ForEach-Object { $_.Name } | Sort-Object)
  $Difference = @(Compare-Object -ReferenceObject ($ExpectedEntries | Sort-Object) -DifferenceObject $ActualEntries)
  if ($Difference.Count -ne 0) {
    throw "The sidecar root must contain exactly proto-agent, proto-agent-mcp, and README.md."
  }

  $AdminPath = Join-Path $Root "proto-agent\proto-agent.exe"
  $McpPath = Join-Path $Root "proto-agent-mcp\proto-agent-mcp.exe"
  Assert-File -Path $AdminPath -Label "Packaged admin CLI"
  Assert-File -Path $McpPath -Label "Packaged MCP sidecar"
  Assert-File -Path (Join-Path $Root "README.md") -Label "Sidecar README"

  Push-Location $RepoRoot
  try {
    $Capabilities = Invoke-JsonCommand -Executable $AdminPath -Arguments @("capabilities", "--json") -Label "Packaged admin capability check"
    if (-not $Capabilities.ok -or
        @($Capabilities.mcp_tools) -notcontains "proto_skills_list" -or
        @($Capabilities.mcp_tools) -notcontains "proto_skills_resolve") {
      throw "The packaged admin CLI is missing the vendor-neutral Skill capabilities."
    }

    $Audit = Invoke-JsonCommand -Executable $AdminPath -Arguments @("skills", "audit") -Label "Packaged Skill audit"
    if (-not $Audit.ok -or
        $Audit.pass_count -ne 3 -or
        $Audit.status_counts.available -ne 7 -or
        $Audit.status_counts.partial -ne 0 -or
        $Audit.status_counts.unavailable -ne 0 -or
        @($Audit.findings).Count -ne 0) {
      throw "The packaged admin CLI did not pass the expected 7/7 three-pass Skill audit."
    }

    $ToolsResponse = Invoke-JsonCommand -Executable $McpPath -Arguments @("--once-file", $McpRequestRelative) -Label "Packaged MCP tools/list check"
    $ResultProperty = $ToolsResponse.PSObject.Properties["result"]
    if ($null -eq $ResultProperty -or $null -eq $ResultProperty.Value) {
      $ResponseFields = @($ToolsResponse.PSObject.Properties | ForEach-Object { $_.Name }) -join ","
      $ErrorProperty = $ToolsResponse.PSObject.Properties["error"]
      $ErrorSummary = if ($null -ne $ErrorProperty -and $null -ne $ErrorProperty.Value) {
        " code=$($ErrorProperty.Value.code) message=$($ErrorProperty.Value.message)"
      } else {
        ""
      }
      throw "Packaged MCP tools/list returned no result object (fields: $ResponseFields).$ErrorSummary"
    }
    $ToolsProperty = $ResultProperty.Value.PSObject.Properties["tools"]
    if ($null -eq $ToolsProperty -or $null -eq $ToolsProperty.Value) {
      throw "Packaged MCP tools/list returned no tools array."
    }
    $ToolNames = @($ToolsProperty.Value | ForEach-Object { $_.name })
    if ($ToolNames -notcontains "proto_skills_list" -or $ToolNames -notcontains "proto_skills_resolve") {
      throw "The packaged MCP sidecar is missing the vendor-neutral Skill tools."
    }
  } finally {
    Pop-Location
  }

  return [ordered]@{
    AdminSha256 = Get-Sha256 -Path $AdminPath
    McpSha256 = Get-Sha256 -Path $McpPath
    SkillCatalogSha256 = [string]$Audit.catalog_sha256
    ConnectorRegistrySha256 = [string]$Audit.connector_registry_sha256
  }
}

function Build-Sidecar {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$EntryPoint
  )

  $Arguments = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name", $Name,
    "--paths", (Join-Path $RepoRoot "src"),
    "--distpath", $Staging,
    "--workpath", (Join-Path $BuildRoot $Name),
    "--specpath", $BuildRoot,
    $EntryPoint
  )

  & $Python @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed while building $Name."
  }
}

function Restore-PreviousRuntime {
  if (-not (Test-Path -LiteralPath $Backup -PathType Container)) {
    return
  }
  if (Test-Path -LiteralPath $Destination) {
    Move-Item -LiteralPath $Destination -Destination $Failed
  }
  Move-Item -LiteralPath $Backup -Destination $Destination
  if (Test-Path -LiteralPath $Failed) {
    Remove-Item -LiteralPath $Failed -Recurse -Force
  }
}

try {
  & $Python -c "import PyInstaller"
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is not installed in the project-local .venv."
  }

  [IO.File]::WriteAllText(
    $McpRequestPath,
    '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    [Text.UTF8Encoding]::new($false)
  )
  New-Item -ItemType Directory -Path $Staging | Out-Null
  Copy-Item -LiteralPath $ReadmeSource -Destination (Join-Path $Staging "README.md")

  Push-Location $RepoRoot
  try {
    Build-Sidecar -Name "proto-agent-mcp" -EntryPoint (Join-Path $PSScriptRoot "proto_mcp_entry.py")
    Build-Sidecar -Name "proto-agent" -EntryPoint (Join-Path $PSScriptRoot "proto_cli_entry.py")
  } finally {
    Pop-Location
  }

  $StagedEvidence = Assert-SidecarRuntime -Root $Staging

  if (Test-Path -LiteralPath $Destination) {
    Move-Item -LiteralPath $Destination -Destination $Backup
  }
  try {
    Move-Item -LiteralPath $Staging -Destination $Destination
    $PublishedEvidence = Assert-SidecarRuntime -Root $Destination
    if ($PublishedEvidence.AdminSha256 -ne $StagedEvidence.AdminSha256 -or
        $PublishedEvidence.McpSha256 -ne $StagedEvidence.McpSha256 -or
        $PublishedEvidence.SkillCatalogSha256 -ne $StagedEvidence.SkillCatalogSha256 -or
        $PublishedEvidence.ConnectorRegistrySha256 -ne $StagedEvidence.ConnectorRegistrySha256) {
      throw "Published sidecar hashes do not match the verified staging tree."
    }
  } catch {
    Restore-PreviousRuntime
    throw
  }

  if (Test-Path -LiteralPath $Backup) {
    Remove-Item -LiteralPath $Backup -Recurse -Force
  }
  Write-Host ("Proto sidecars published: admin={0}, mcp={1}, skills={2}" -f `
    $PublishedEvidence.AdminSha256,
    $PublishedEvidence.McpSha256,
    $PublishedEvidence.SkillCatalogSha256)
} finally {
  if (Test-Path -LiteralPath $Staging) {
    Remove-Item -LiteralPath $Staging -Recurse -Force
  }
  if (Test-Path -LiteralPath $McpRequestPath) {
    Remove-Item -LiteralPath $McpRequestPath -Force
  }
  if ($null -ne $LockStream) {
    $LockStream.Dispose()
  }
}
