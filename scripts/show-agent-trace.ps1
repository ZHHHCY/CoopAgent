param(
    [string]$RunId,
    [switch]$Raw,
    [int]$Limit = 200
)

$ErrorActionPreference = 'Stop'
$traceRoot = Join-Path $env:APPDATA 'CoopAgent\traces'
if (-not (Test-Path -LiteralPath $traceRoot -PathType Container)) {
    throw "CoopAgent trace directory does not exist yet: $traceRoot"
}

if ([string]::IsNullOrWhiteSpace($RunId)) {
    $traceFile = Get-ChildItem -LiteralPath $traceRoot -Filter 'run-*.jsonl' -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $traceFile) {
        throw "No CoopAgent trace has been recorded in: $traceRoot"
    }
}
else {
    if ($RunId -notmatch '^run-[a-z0-9-]{1,92}$') {
        throw "Invalid CoopAgent run ID: $RunId"
    }
    $traceFile = Get-Item -LiteralPath (Join-Path $traceRoot ($RunId + '.jsonl'))
}

Write-Host ('Trace: ' + $traceFile.FullName)
if ($Raw) {
    Get-Content -LiteralPath $traceFile.FullName -Encoding UTF8
    exit 0
}

$events = Get-Content -LiteralPath $traceFile.FullName -Encoding UTF8 |
    Select-Object -Last ([Math]::Max(1, [Math]::Min($Limit, 5000))) |
    ForEach-Object { $_ | ConvertFrom-Json }

$events |
    Select-Object @{
        Name = 'Time'
        Expression = {
            if ($null -eq $_.timestampMs) {
                '?'
            }
            else {
                [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$_.timestampMs).ToLocalTime().ToString('HH:mm:ss.fff')
            }
        }
    }, sequence, event, status, @{
        Name = 'Details'
        Expression = {
            $text = $_.details | ConvertTo-Json -Compress -Depth 12
            if ($text.Length -gt 180) { $text.Substring(0, 177) + '...' } else { $text }
        }
    } |
    Format-Table -AutoSize -Wrap
