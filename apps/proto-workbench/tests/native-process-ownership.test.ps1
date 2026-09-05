$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\native-process-ownership.ps1')
$electronPath='C:\owned\electron.exe'; $pythonPath='C:\owned\python.exe'; $profilePath='C:\owned\qa\profile'
$parentTime=[datetime]'2026-09-04T23:58:00Z'
$valid = @{ ProcessId=21; ParentProcessId=20; CreationDate=[datetime]'2026-09-04T23:58:01Z'; ExecutablePath=$electronPath; CommandLine='"C:\owned\electron.exe" --type=renderer --user-data-dir="C:\owned\qa\profile"' }
$cases=@(
  @{ name='owned exact renderer'; changes=@{}; expected=$true },
  @{ name='older PID-reuse Chrome'; changes=@{CreationDate=[datetime]'2026-09-04T18:20:57Z';ExecutablePath='C:\Program Files\Google\Chrome\Application\chrome.exe'};expected=$false },
  @{ name='new unrelated Chrome'; changes=@{ExecutablePath='C:\Program Files\Google\Chrome\Application\chrome.exe'};expected=$false },
  @{ name='wrong Electron profile';changes=@{CommandLine='electron --type=renderer --user-data-dir="C:\someone\profile"'};expected=$false },
  @{ name='wrong parent';changes=@{ParentProcessId=99};expected=$false },
  @{ name='missing creation';changes=@{CreationDate=$null};expected=$false },
  @{ name='missing executable';changes=@{ExecutablePath=$null};expected=$false },
  @{ name='owned MCP Python';changes=@{ExecutablePath=$pythonPath;CommandLine='"C:\owned\python.exe" -m proto_agent.mcp_server'};expected=$true },
  @{ name='unrelated Python script';changes=@{ExecutablePath=$pythonPath;CommandLine='python user-project.py'};expected=$false }
)
foreach ($case in $cases) {
  $candidate=$valid.Clone(); foreach($key in $case.changes.Keys) { $candidate[$key]=$case.changes[$key] }
  $verdict=Get-NativeChildOwnership ([pscustomobject]$candidate) 20 $parentTime $electronPath $pythonPath $profilePath
  if($verdict.owned -ne $case.expected) { throw ('Ownership fixture failed: '+$case.name) }
}
$launcher=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\owned-scientific-electron.ps1') -Raw
$driver=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\verify-scientific-native.mjs') -Raw
if($launcher.Contains('taskkill') -or $driver.Contains('terminateOwnedProcessTree')) { throw 'Native QA must not use PID-based process-tree termination.' }
$validReceipt=@{schema='proto-workbench.owned-scientific-launch.v2';qaRoot='C:\owned\qa';appRoot='C:\owned\app';processExited=$true;completedAt='2026-09-05T00:00:00Z';remainingOwnedChildren=@()}
$restartCases=@(
  @{name='clean same-profile restart';changes=@{};expected=$true},
  @{name='live parent';changes=@{processExited=$false};expected=$false},
  @{name='missing completion';changes=@{completedAt=$null};expected=$false},
  @{name='remaining owned child';changes=@{remainingOwnedChildren=@(@{pid=12})};expected=$false},
  @{name='missing child audit';changes=@{remainingOwnedChildren=$null};expected=$false},
  @{name='another QA profile';changes=@{qaRoot='C:\unrelated'};expected=$false},
  @{name='another app';changes=@{appRoot='C:\unrelated'};expected=$false},
  @{name='prior launcher error';changes=@{error='failed'};expected=$false}
)
foreach($case in $restartCases) {
  $receipt=$validReceipt.Clone();foreach($key in $case.changes.Keys){$receipt[$key]=$case.changes[$key]}
  if((Test-NativeRestartReceipt ([pscustomobject]$receipt) 'C:\owned\qa' 'C:\owned\app') -ne $case.expected){throw ('Restart fixture failed: '+$case.name)}
}
$tokens=$null;$errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput($launcher,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
Write-Output ('PASS '+$cases.Count+' ownership and '+$restartCases.Count+' restart fixture cases; no process spawned or stopped; tree termination absent; launcher syntax valid.')
