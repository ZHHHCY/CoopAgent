param(
    [Alias('Host')][string]$HostId
)

$ErrorActionPreference = 'Stop'

$gameARoot = Split-Path -Parent $PSScriptRoot
$baselinePath = Join-Path $gameARoot 'runtime-baseline.json'
$hostRegistryPath = Join-Path $gameARoot 'hosts.json'
$gameLogs = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'StarCraft II\GameLogs'

if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
    throw "Runtime baseline is missing: $baselinePath"
}

$baseline = Get-Content -LiteralPath $baselinePath -Raw -Encoding utf8 | ConvertFrom-Json
$hostRegistry = Get-Content -LiteralPath $hostRegistryPath -Raw -Encoding utf8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($HostId)) {
    $HostId = [string]$hostRegistry.defaultHost
}
$matchingHosts = @($hostRegistry.hosts | Where-Object { $_.id -eq $HostId })
if ($matchingHosts.Count -ne 1) {
    throw "Unknown Game A host: $HostId"
}
$buildRoot = [IO.Path]::GetFullPath((Join-Path $gameARoot 'build'))
$latestPointer = Join-Path $buildRoot ('latest\' + $HostId + '.json')
if (Test-Path -LiteralPath $latestPointer -PathType Leaf) {
    $pointer = Get-Content -LiteralPath $latestPointer -Raw -Encoding utf8 | ConvertFrom-Json
    if ([string]$pointer.hostId -ne $HostId -or [string]::IsNullOrWhiteSpace([string]$pointer.output)) {
        throw "Invalid Game A latest-build pointer: $latestPointer"
    }
    $outputMap = [IO.Path]::GetFullPath((Join-Path $buildRoot ([string]$pointer.output).Replace('/', '\')))
    if (-not $outputMap.StartsWith($buildRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Game A latest-build pointer escapes the build directory: $latestPointer"
    }
}
else {
    # Compatibility with build artifacts produced before versioned outputs.
    $outputMap = Join-Path $buildRoot ([string]$matchingHosts[0].outputName)
}
$buildStamp = Join-Path $outputMap '.gamea-build-hash'
if (-not (Test-Path -LiteralPath $buildStamp -PathType Leaf)) {
    throw "Game A build stamp is missing: $buildStamp"
}
$latestLog = Get-ChildItem -LiteralPath $gameLogs -File -Filter '*ScriptError.txt' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $latestLog) {
    throw "No SC2 ScriptError log was found under: $gameLogs"
}
if ($latestLog.LastWriteTimeUtc -le (Get-Item -LiteralPath $buildStamp).LastWriteTimeUtc) {
    throw "The latest SC2 log predates host '$HostId'. Run that generated map before accepting the runtime result."
}

$logText = [IO.File]::ReadAllText($latestLog.FullName)
$versionMatch = [regex]::Match($logText, '(?m)^<Version>\s+([^\r\n]+)\r?$')
$buildMatch = [regex]::Match($logText, '(?m)^<DataBuild>\s+([^\r\n]+)\r?$')
if (-not $versionMatch.Success -or -not $buildMatch.Success) {
    throw "Could not read the SC2 version from: $($latestLog.FullName)"
}

$actualVersion = $versionMatch.Groups[1].Value.Trim()
$actualBuild = $buildMatch.Groups[1].Value.Trim()
if ($actualVersion -ne $baseline.sc2.version -or $actualBuild -ne $baseline.sc2.dataBuild) {
    throw "SC2 changed from the accepted baseline $($baseline.sc2.version)/$($baseline.sc2.dataBuild) to $actualVersion/$actualBuild. Rebuild the CASC database and repeat runtime acceptance."
}

foreach ($blockingPattern in $baseline.blockingLogPatterns) {
    if ($logText.Contains([string]$blockingPattern)) {
        throw "Blocking SC2 error '$blockingPattern' was found in: $($latestLog.FullName)"
    }
}

$knownWarningPattern = @'
(?ms)^'libCOMI_[^\r\n]*'[^\r\n]*'StatEvent(?:Create|LastCreated|AddDataInt|AddDataString|Send)'\r?\n\s+Near line \d+ in libCOOC_gf_CC_StatEvent(?:Create|LastCreated|AddInt|AddStr|Done)\(\) in LibCOOC\.galaxy\r?\n?
'@
$knownWarnings = [regex]::Matches($logText, $knownWarningPattern).Count
$unclassifiedLog = [regex]::Replace($logText, $knownWarningPattern, '')
if ($unclassifiedLog.Contains([string]$baseline.triggerErrorMarker)) {
    throw "An unclassified trigger error was found in: $($latestLog.FullName)"
}

Write-Output 'Latest Game A runtime log passed.'
Write-Output "SC2: $actualVersion / $actualBuild"
Write-Output "Known offline StatEvent warnings: $knownWarnings"
Write-Output "Log: $($latestLog.FullName)"
