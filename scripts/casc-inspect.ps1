[CmdletBinding()]
param(
    [string]$StarCraftRoot,
    [string]$Output,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\sc2-installation.ps1')
if ([string]::IsNullOrWhiteSpace($StarCraftRoot)) {
    $StarCraftRoot = if (-not [string]::IsNullOrWhiteSpace($env:COOPAGENT_SC2_ROOT)) {
        $env:COOPAGENT_SC2_ROOT
    } else { Get-CoopSc2SavedRoot }
    if ([string]::IsNullOrWhiteSpace($StarCraftRoot)) { $StarCraftRoot = 'C:\Program Files (x86)\StarCraft II' }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$bootstrap = Join-Path $PSScriptRoot 'casc-bootstrap.ps1'
$inspector = Join-Path $PSScriptRoot 'casc-inspect.py'

if (-not (Test-Path -LiteralPath $StarCraftRoot)) {
    throw "找不到 StarCraft II：$StarCraftRoot"
}

$dllPath = & $bootstrap | ForEach-Object { Write-Host $_; $_ } | Select-Object -Last 1
if (-not (Test-Path -LiteralPath $dllPath)) {
    throw "工具准备完成后仍找不到 CASCLib：$dllPath"
}

$arguments = @($inspector, '--sc2', $StarCraftRoot, '--dll', $dllPath)
if ($Output) {
    $arguments += @('--output', $Output)
}

& python @arguments
if ($LASTEXITCODE -ne 0) {
    throw "CASC 读取失败（Python 退出代码 $LASTEXITCODE）。"
}

$buildInfoLines = Get-Content -LiteralPath (Join-Path $StarCraftRoot '.build.info')
$buildInfoHeaders = $buildInfoLines[0].Split('|')
$buildInfoValues = $buildInfoLines[1].Split('|')
$versionIndex = 0..($buildInfoHeaders.Length - 1) | Where-Object { $buildInfoHeaders[$_].StartsWith('Version!') } | Select-Object -First 1
$version = if ($null -ne $versionIndex) { $buildInfoValues[$versionIndex] } else { 'unknown' }
$buildNumber = if ($version -match '(\d+)$') { "B$($Matches[1])" } else { $version }
$resolvedOutput = if ($Output) {
    [System.IO.Path]::GetFullPath($Output)
} else {
    Join-Path $env:LOCALAPPDATA "CoopAgent\casc\$buildNumber"
}

Write-Host "CASC 提取结果：$resolvedOutput"
if (-not $NoOpen) {
    Start-Process explorer.exe -ArgumentList $resolvedOutput
}
Write-Output $resolvedOutput
