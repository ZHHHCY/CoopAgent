param(
    [Alias('Host')][string]$HostId
)

$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'validate-game-a.ps1')
if ([string]::IsNullOrWhiteSpace($HostId)) {
    $componentPath = & (Join-Path $PSScriptRoot 'build-game-a.ps1')
}
else {
    $componentPath = & (Join-Path $PSScriptRoot 'build-game-a.ps1') -HostId $HostId
}
if (-not (Test-Path -LiteralPath $componentPath -PathType Leaf)) {
    throw "Generated Game A component list is missing: $componentPath"
}
if ([string]::IsNullOrWhiteSpace($HostId)) {
    & (Join-Path $PSScriptRoot 'check-game-a-log.ps1')
}
else {
    & (Join-Path $PSScriptRoot 'check-game-a-log.ps1') -HostId $HostId
}

Write-Output 'Game A stable-baseline verification passed.'
