$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot
& "$repositoryRoot\.venv\Scripts\python.exe" -m chem_workbench.web @args
