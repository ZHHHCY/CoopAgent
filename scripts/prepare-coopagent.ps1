[CmdletBinding()]
param([string]$StarCraftRoot)

$ErrorActionPreference = 'Stop'
$root = & (Join-Path $PSScriptRoot 'configure-sc2.ps1') -StarCraftRoot $StarCraftRoot
if (-not $root) { throw 'StarCraft II installation was not selected.' }
$previousRoot = $env:COOPAGENT_SC2_ROOT
try {
    $env:COOPAGENT_SC2_ROOT = $root
    & (Join-Path $PSScriptRoot 'bootstrap.cmd')
    if ($LASTEXITCODE -ne 0) { throw "Toolchain preparation failed ($LASTEXITCODE)." }

    # The final output line identifies this extraction, not another cached build.
    $extraction = @(& (Join-Path $PSScriptRoot 'casc-inspect.ps1') -StarCraftRoot $root -NoOpen)
    $extraction | ForEach-Object { Write-Host $_ }
    $cascRoot = [string]$extraction[-1]
    if (-not (Test-Path -LiteralPath (Join-Path $cascRoot 'manifest.json') -PathType Leaf)) {
        throw 'CASC preparation did not return a completed extraction.'
    }
    & (Join-Path $PSScriptRoot 'casc-database.cmd') build --casc-root $cascRoot
    if ($LASTEXITCODE -ne 0) { throw "Database preparation failed ($LASTEXITCODE)." }
}
finally { $env:COOPAGENT_SC2_ROOT = $previousRoot }
