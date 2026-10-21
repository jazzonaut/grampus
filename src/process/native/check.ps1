$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'check.cs')
$request = [Console]::ReadLine() | ConvertFrom-Json
[GrampusCheck]::Run($request.file, [string[]]$request.args, $request.cwd,
    $request.timeoutMs, $request.stdout, $request.stderr, $request.receiptPath, $request.checkId, $request.token, $request.supervisorPid, $request.jobDrainMs)
