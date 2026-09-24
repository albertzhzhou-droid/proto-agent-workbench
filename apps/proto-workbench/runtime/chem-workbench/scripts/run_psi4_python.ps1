[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PythonArguments
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$backendPrefix = if ($env:CHEM_PSI4_PREFIX) { $env:CHEM_PSI4_PREFIX } else { Join-Path $repositoryRoot '.chem-backends\psi4' }
$backendPython = Join-Path $backendPrefix 'python.exe'
if (-not (Test-Path -LiteralPath $backendPython -PathType Leaf)) {
    throw 'Psi4 environment is missing. See docs/chemistry-environment.md.'
}
$previousPath = $env:PATH
$previousScratch = $env:PSI_SCRATCH
$previousThreads = $env:OMP_NUM_THREADS
try {
    $env:PATH = "$backendPrefix;$backendPrefix\Library\bin;$backendPrefix\Scripts;$previousPath"
    if (-not $env:PSI_SCRATCH) {
        $env:PSI_SCRATCH = Join-Path $repositoryRoot 'build\psi4-scratch'
    }
    if (-not $env:OMP_NUM_THREADS) {
        $env:OMP_NUM_THREADS = '1'
    }
    New-Item -ItemType Directory -Force $env:PSI_SCRATCH | Out-Null
    & $backendPython @PythonArguments
    $backendExitCode = $LASTEXITCODE
}
finally {
    $env:PATH = $previousPath
    $env:PSI_SCRATCH = $previousScratch
    $env:OMP_NUM_THREADS = $previousThreads
}
exit $backendExitCode
