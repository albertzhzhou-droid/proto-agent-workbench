$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\packaged-process-ownership.ps1')
$root='C:\owned\qa\portable-temp'; $session='C:\owned\qa'; $created=[datetime]'2026-09-05T02:00:00Z'
foreach($case in @(@{ticks=0;expected=$true},@{ticks=3;expected=$true},@{ticks=10;expected=$false},@{ticks=-1;expected=$false})) {
  if((Test-PackagedHeldCreation $created.AddTicks($case.ticks) $created) -ne $case.expected){throw 'CIM/held-process creation correlation must match exact common precision.'}
}
$arguments=@('C:\owned\qa\portable-temp\ns1\app\Proto Workbench.exe','--session-root=C:\owned\qa','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222')
$valid=@{ProcessId=21;ParentProcessId=20;CreationDate=$created.AddSeconds(1);ExecutablePath=$arguments[0];Arguments=$arguments}
$cases=@(
  @{name='fresh exact portable child';changes=@{};expected=$true},
  @{name='older reused parent PID';changes=@{CreationDate=$created.AddSeconds(-1)};expected=$false},
  @{name='wrong parent';changes=@{ParentProcessId=99};expected=$false},
  @{name='missing creation';changes=@{CreationDate=$null};expected=$false},
  @{name='missing arguments';changes=@{Arguments=@()};expected=$false},
  @{name='another program';changes=@{ExecutablePath='C:\owned\qa\portable-temp\ns1\app\chrome.exe'};expected=$false},
  @{name='lookalike extraction prefix';changes=@{ExecutablePath='C:\owned\qa\portable-temp-other\Proto Workbench.exe'};expected=$false},
  @{name='parent directory escape';changes=@{ExecutablePath='C:\owned\qa\portable-temp\..\Proto Workbench.exe'};expected=$false},
  @{name='wrong session';changes=@{Arguments=@($arguments[0],'--session-root=C:\someone\qa',$arguments[2],$arguments[3])};expected=$false},
  @{name='duplicate session';changes=@{Arguments=$arguments+@('--session-root=C:\owned\qa')};expected=$false},
  @{name='wrong endpoint';changes=@{Arguments=@($arguments[0],$arguments[1],$arguments[2],'--remote-debugging-port=9223')};expected=$false},
  @{name='renderer is not main';changes=@{Arguments=$arguments+@('--type=renderer')};expected=$false}
)
foreach ($case in $cases) {
  $candidate=$valid.Clone();foreach($key in $case.changes.Keys){$candidate[$key]=$case.changes[$key]}
  $verdict=Get-PackagedMainOwnership ([pscustomobject]$candidate) 20 $created 'portable' $root $session 9222
  if($verdict.owned -ne $case.expected){throw ('Packaged main ownership failed: '+$case.name)}
}
$direct=$valid.Clone();$direct.ProcessId=20;$direct.ExecutablePath=Join-Path $root 'Proto Workbench.exe'
if(-not (Get-PackagedMainOwnership ([pscustomobject]$direct) 20 $created 'installer-payload' $root $session 9222).owned){throw 'Exact direct payload should be eligible for held-handle/hash verification.'}
$direct.ProcessId=21
if((Get-PackagedMainOwnership ([pscustomobject]$direct) 20 $created 'installer-payload' $root $session 9222).owned){throw 'A different PID cannot stand in for the directly launched payload.'}
$child=@{ProcessId=30;ParentProcessId=21;CreationDate=$created.AddSeconds(2);ExecutablePath=$arguments[0];Arguments=@('app','--type=renderer','--user-data-dir=C:\owned\qa\profile')}
$childCases=@(
  @{name='actual profile renderer';changes=@{};expected=$true},
  @{name='wrong profile';changes=@{Arguments=@('app','--type=renderer','--user-data-dir=C:\unrelated')};expected=$false},
  @{name='wrong child parent';changes=@{ParentProcessId=2};expected=$false},
  @{name='old child PID reuse';changes=@{CreationDate=$created.AddSeconds(-2)};expected=$false},
  @{name='owned packaged MCP';changes=@{ExecutablePath='C:\owned\qa\portable-temp\ns1\app\resources\runtime\proto-agent\proto-agent-mcp\proto-agent-mcp.exe';Arguments=@('mcp')};expected=$true},
  @{name='unrelated exe in extraction';changes=@{ExecutablePath='C:\owned\qa\portable-temp\ns1\app\resources\other.exe'};expected=$false}
)
foreach($case in $childCases){
  $candidate=$child.Clone();foreach($key in $case.changes.Keys){$candidate[$key]=$case.changes[$key]}
  if((Get-PackagedChildOwnership ([pscustomobject]$candidate) 21 $created $arguments[0] 'C:\owned\qa\profile') -ne $case.expected){throw ('Packaged child ownership failed: '+$case.name)}
}
$launcher=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\owned-packaged-electron.ps1') -Raw
$tokens=$null;$errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput($launcher,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
if($launcher -match 'taskkill|Stop-Process|\.Kill\(\$true\)|--inspect'){throw 'Packaged helper cannot use tree/name termination or the disabled inspector.'}
$csharp=[regex]::Match($launcher,'(?s)Add-Type @''\r?\n(.*?)\r?\n''@').Groups[1].Value
if(-not $csharp){throw 'Missing bounded native capture definition.'}
Add-Type -TypeDefinition $csharp
$parsed=[OwnedPackagedCapture]::Arguments('"C:\owned\app\Proto Workbench.exe" --session-root="C:\owned\qa with spaces" --remote-debugging-port=9222')
if($parsed.Count -ne 3 -or $parsed[1] -ne '--session-root=C:\owned\qa with spaces'){throw 'Windows command arguments must retain exact quoted session authority.'}
$unstartedCapture=New-Object OwnedPackagedCapture
try { if($unstartedCapture.Drain(1)){throw 'Unclosed standard streams cannot pass the bounded drain.'} } finally {$unstartedCapture.Dispose()}
Write-Output 'PASS 24 packaged identity cases, Windows argument parsing, bounded STA-compatible stream drain, C# compilation and launcher syntax; no application process launched or stopped.'
