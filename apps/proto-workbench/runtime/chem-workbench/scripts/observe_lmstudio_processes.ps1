# Read-only native process/module observation. No model requests or process mutation.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$observed = @()
$selected = Get-CimInstance Win32_Process -Filter "Name='LM Studio.exe' OR Name='llmster.exe' OR Name='llama-server.exe'"
foreach ($item in $selected) {
    if ($item.Name -eq 'LM Studio.exe' -and $item.CommandLine -match '--type=') { continue }
    if ($item.Name -ne 'LM Studio.exe' -and $item.ExecutablePath -notmatch '(?i)\\\.lmstudio\\') { continue }
    $rawCommandLine = [string]$item.CommandLine
    $redacted = [regex]::Replace(
        $rawCommandLine,
        '(?i)(--(?:api[-_]key|password|token|secret|authorization)(?:=|\s+))("[^"]*"|\S+)',
        '$1<redacted>'
    )
    $commandDigest = [System.Security.Cryptography.SHA256]::Create()
    try {
        $commandHash = [BitConverter]::ToString($commandDigest.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes($rawCommandLine)
        )).Replace('-', '').ToLowerInvariant()
    } finally { $commandDigest.Dispose() }
    $process = Get-Process -Id $item.ProcessId -ErrorAction Stop
    $image = [Diagnostics.FileVersionInfo]::GetVersionInfo($item.ExecutablePath)
    $modules = @()
    $moduleError = $null
    if ($item.Name -eq 'llama-server.exe' -or $item.Name -eq 'llmster.exe') {
        try {
            $modules = @($process.Modules | Where-Object {
                $_.FileName -match '(?i)\\\.lmstudio\\extensions\\backends\\|\\nvcuda(?:64)?\.dll$'
            } | ForEach-Object {
                [ordered]@{
                    path = $_.FileName
                    module_name = $_.ModuleName
                    file_version = $_.FileVersionInfo.FileVersion
                    product_version = $_.FileVersionInfo.ProductVersion
                }
            })
        } catch { $moduleError = $_.Exception.GetType().Name }
    }
    $observed += [ordered]@{
        pid = [int]$item.ProcessId
        parent_pid = [int]$item.ParentProcessId
        name = $item.Name
        executable_path = $item.ExecutablePath
        created_at_utc = $item.CreationDate.ToUniversalTime().ToString('o')
        command_line_redacted = $redacted
        command_line_sha256 = $commandHash
        executable_file_version = $image.FileVersion
        executable_product_version = $image.ProductVersion
        loaded_modules = $modules
        module_enumeration_error = $moduleError
    }
}
[ordered]@{
    version = 'lmstudio-native-process-observation/v1'
    observed_at_utc = [DateTime]::UtcNow.ToString('o')
    processes = $observed
} | ConvertTo-Json -Depth 8 -Compress
