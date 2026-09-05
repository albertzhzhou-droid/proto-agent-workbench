param([Parameter(Mandatory=$true)][string]$BindingPath)
# Test-only observer. It never obtains terminate access or enumerates processes.
$ErrorActionPreference='Stop'
$binding=Get-Content -LiteralPath $BindingPath -Raw | ConvertFrom-Json
$parentHandle=[IntPtr]::Zero; $descendantHandle=[IntPtr]::Zero
$result=[ordered]@{ ok=$false; handlesClosed=$false }
function Write-AtomicJson([string]$Path,$Value) {
 [IO.File]::WriteAllText(($Path+'.tmp'),($Value | ConvertTo-Json -Depth 8))
 [IO.File]::Move(($Path+'.tmp'),$Path)
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HeldOwnedProcess {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder buffer,ref uint length);
}
'@
function Read-Identity([IntPtr]$Handle,[int]$ProcessId) {
 [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0
 if(-not [HeldOwnedProcess]::GetProcessTimes($Handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)){throw 'GetProcessTimes failed'}
 $buffer=[Text.StringBuilder]::new(32768); [uint32]$length=$buffer.Capacity
 if(-not [HeldOwnedProcess]::QueryFullProcessImageName($Handle,0,$buffer,[ref]$length)){throw 'QueryFullProcessImageName failed'}
 return [ordered]@{ pid=$ProcessId; createdFileTime=$created.ToString(); createdAt=[DateTime]::FromFileTimeUtc($created).ToString('o'); executable=$buffer.ToString() }
}
try {
 $parentHandle=[HeldOwnedProcess]::OpenProcess(0x00101000,$false,[uint32]$binding.parentPid)
 if($parentHandle -eq [IntPtr]::Zero){throw ('Parent OpenProcess failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 $descendantHandle=[HeldOwnedProcess]::OpenProcess(0x00101000,$false,[uint32]$binding.descendantPid)
 if($descendantHandle -eq [IntPtr]::Zero){throw ('Descendant OpenProcess failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 $parent=Read-Identity $parentHandle $binding.parentPid
 $descendant=Read-Identity $descendantHandle $binding.descendantPid
 if(-not [String]::Equals($parent.executable,$binding.executable,[StringComparison]::OrdinalIgnoreCase) -or -not [String]::Equals($descendant.executable,$binding.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Executable identity mismatch'}
 if([long]$descendant.createdFileTime -lt [long]$parent.createdFileTime){throw 'Descendant predates the owned parent'}
 if([DateTime]::Parse($parent.createdAt) -lt [DateTime]::Parse($binding.startedAt).AddMilliseconds(-100)){throw 'Parent predates this test launch'}
 $ready=Get-Content -LiteralPath $binding.descendantReadyPath -Raw | ConvertFrom-Json
 if($ready.nonce -ne $binding.nonce -or $ready.pid -ne $binding.descendantPid -or $ready.ppid -ne $binding.parentPid -or $ready.cwd -ne $binding.workspace){throw 'Descendant startup binding mismatch'}
 $result.parent=$parent; $result.descendant=$descendant
 $result.parentInitialWait=[HeldOwnedProcess]::WaitForSingleObject($parentHandle,0)
 $result.descendantInitialWait=[HeldOwnedProcess]::WaitForSingleObject($descendantHandle,0)
 if($result.parentInitialWait -ne 258 -or $result.descendantInitialWait -ne 258){throw 'Both original processes must be alive before termination'}
 Write-AtomicJson $binding.observerReadyPath $result
 # This is a kernel-object wait, not a filesystem retry or PID-reuse lookup.
 # The descendant's natural lifetime is longer than this deadline.
 $result.descendantFinalWait=[HeldOwnedProcess]::WaitForSingleObject($descendantHandle,5000)
 $result.parentFinalWait=[HeldOwnedProcess]::WaitForSingleObject($parentHandle,1000)
 $result.ok=$result.descendantFinalWait -eq 0 -and $result.parentFinalWait -eq 0
 if(-not $result.ok){$result.error='The exact held process objects did not become signaled in time'}
}catch{$result.error=$_.Exception.ToString()}
finally {
 if($descendantHandle -ne [IntPtr]::Zero){[void][HeldOwnedProcess]::CloseHandle($descendantHandle)}
 if($parentHandle -ne [IntPtr]::Zero){[void][HeldOwnedProcess]::CloseHandle($parentHandle)}
 $result.handlesClosed=$true
 Write-AtomicJson $binding.observerResultPath $result
}
if(-not $result.ok){exit 1}
