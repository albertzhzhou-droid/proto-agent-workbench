[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repositoryRoot ".venv\Scripts\python.exe"
$ruff = Join-Path $repositoryRoot ".venv\Scripts\ruff.exe"
$mypy = Join-Path $repositoryRoot ".venv\Scripts\mypy.exe"
$pytestDirectory = Join-Path $repositoryRoot ("build\pytest-" + [guid]::NewGuid().ToString("N"))

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Missing .venv. Run 'uv sync --offline' after the lockfile artifacts are cached."
}

Push-Location $repositoryRoot
try {
    & $ruff format --check src tests
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $ruff check src tests
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $mypy
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $python -m pytest -q -p no:cacheprovider --basetemp $pytestDirectory
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
