# Runs an entry script in a child PowerShell so native stdout/stderr and the
# final terminating error are captured before the log is closed.
function Invoke-CoopLoggedScript {
    param([string]$ScriptPath, [hashtable]$ScriptParameters, [string]$LogPrefix)
    $encoding = New-Object Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $encoding
    $logRoot = Join-Path (Split-Path (Split-Path $ScriptPath -Parent) -Parent) '.coopagent\logs'
    $logFile = Join-Path $logRoot ("{0}-{1}-{2}.log" -f $LogPrefix, (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
    $writer = $null
    try {
        [IO.Directory]::CreateDirectory($logRoot) | Out-Null
        $writer = New-Object IO.StreamWriter($logFile, $false, $encoding)
        $writer.AutoFlush = $true
    } catch { [Console]::Error.WriteLine("无法创建日志：$($_.Exception.Message)") }
    function Write-ProcessLog([string]$Stream, [string]$Message) {
        if ($writer) {
            try { $writer.WriteLine(("{0:o} [{1}] {2}" -f (Get-Date), $Stream, $Message)) }
            catch { [Console]::Error.WriteLine("日志写入失败：$($_.Exception.Message)") }
        }
        if ($Stream -eq 'stderr') { [Console]::Error.WriteLine($Message) }
        else { [Console]::WriteLine($Message) }
    }
    $scriptLiteral = "'" + $ScriptPath.Replace("'", "''") + "'"
    $parameterEntries = foreach ($key in $ScriptParameters.Keys) {
        $value = $ScriptParameters[$key]
        $literal = if ($value -is [bool]) { if ($value) { '$true' } else { '$false' } } else { "'" + ([string]$value).Replace("'", "''") + "'" }
        "'" + $key.Replace("'", "''") + "'=" + $literal
    }
    $code = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding(`$false)
`$env:PYTHONUTF8 = '1'
`$parameters = @{ $($parameterEntries -join ';') }
`$global:LASTEXITCODE = 0
try { & $scriptLiteral @parameters; exit `$LASTEXITCODE } catch { [Console]::Error.WriteLine((`$_ | Out-String)); exit 1 }
"@
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $PSHOME 'powershell.exe'
    $info.Arguments = '-NoLogo -NoProfile -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $encoding
    $info.StandardErrorEncoding = $encoding
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        Write-ProcessLog 'status' "日志：$logFile"
        $process.Start() | Out-Null
        $stdout = $process.StandardOutput.ReadLineAsync()
        $stderr = $process.StandardError.ReadLineAsync()
        while ($null -ne $stdout -or $null -ne $stderr) {
            if ($null -ne $stdout -and $stdout.IsCompleted) {
                $line = $stdout.GetAwaiter().GetResult()
                if ($null -eq $line) { $stdout = $null }
                else { Write-ProcessLog 'stdout' $line; $stdout = $process.StandardOutput.ReadLineAsync() }
            }
            if ($null -ne $stderr -and $stderr.IsCompleted) {
                $line = $stderr.GetAwaiter().GetResult()
                if ($null -eq $line) { $stderr = $null }
                else { Write-ProcessLog 'stderr' $line; $stderr = $process.StandardError.ReadLineAsync() }
            }
            if (($stdout -and -not $stdout.IsCompleted) -or ($stderr -and -not $stderr.IsCompleted)) { Start-Sleep -Milliseconds 20 }
        }
        $process.WaitForExit()
        Write-ProcessLog 'status' "退出代码：$($process.ExitCode)"
        return $process.ExitCode
    } catch {
        Write-ProcessLog 'stderr' "无法运行 $ScriptPath：$($_.Exception.Message)"
        Write-ProcessLog 'status' '退出代码：1'
        return 1
    } finally {
        $process.Dispose()
        if ($writer) { $writer.Dispose() }
    }
}
