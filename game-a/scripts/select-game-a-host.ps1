$ErrorActionPreference = 'Stop'

$gameARoot = Split-Path -Parent $PSScriptRoot
$registryPath = Join-Path $gameARoot 'hosts.json'
$registry = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 | ConvertFrom-Json
$hosts = @($registry.hosts)
if ($hosts.Count -eq 0) {
    throw 'No Game A hosts are registered.'
}

Write-Output 'Available Game A hosts:'
for ($index = 0; $index -lt $hosts.Count; $index += 1) {
    Write-Output ('  {0}. {1} [{2}]' -f ($index + 1), $hosts[$index].displayName, $hosts[$index].id)
}

$defaultIndex = 0
for ($index = 0; $index -lt $hosts.Count; $index += 1) {
    if ($hosts[$index].id -eq $registry.defaultHost) {
        $defaultIndex = $index
        break
    }
}

$answer = Read-Host ('Select host (default {0})' -f ($defaultIndex + 1))
if ([string]::IsNullOrWhiteSpace($answer)) {
    $selectedIndex = $defaultIndex
}
else {
    $parsed = 0
    if (-not [int]::TryParse($answer, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt $hosts.Count) {
        throw "Invalid host selection: $answer"
    }
    $selectedIndex = $parsed - 1
}

& (Join-Path $PSScriptRoot 'launch-game-a.ps1') -HostId ([string]$hosts[$selectedIndex].id)
