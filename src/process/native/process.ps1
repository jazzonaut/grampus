param([int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
$targetProcess = $null
try {
    try { $targetProcess = [System.Diagnostics.Process]::GetProcessById($TargetProcessId) }
    catch [System.ArgumentException] { '{"state":"absent"}'; exit }
    # Keep a handle open so this observation stays bound to one process
    # even if it exits and its numeric id is immediately recycled.
    $null = $targetProcess.Handle
    $startedAt = $targetProcess.StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)
    if ($targetProcess.HasExited) { '{"state":"absent"}' }
    else { @{ state = 'present'; startedAt = $startedAt } | ConvertTo-Json -Compress }
}
catch { '{"state":"unknown"}' }
finally { if ($null -ne $targetProcess) { $targetProcess.Dispose() } }
