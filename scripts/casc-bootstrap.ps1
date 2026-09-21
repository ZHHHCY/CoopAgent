[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $repoRoot '.tools'
$sourceRoot = Join-Path $toolsRoot 'CascLib'
$buildRoot = Join-Path $sourceRoot 'build-coopagent'
$dllPath = Join-Path $buildRoot 'Release\CascLib.dll'
$cascTag = '3.0'

if (Test-Path -LiteralPath $dllPath) {
    Write-Output $dllPath
    exit 0
}

if (-not (Test-Path -LiteralPath $toolsRoot)) {
    New-Item -ItemType Directory -Path $toolsRoot | Out-Null
}

if (-not (Test-Path -LiteralPath $sourceRoot)) {
    Write-Host "Downloading official CASCLib $cascTag source..."
    & git clone --depth 1 --branch $cascTag https://github.com/ladislav-zezula/CascLib.git $sourceRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to download CASCLib (git exit code $LASTEXITCODE)."
    }
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Visual Studio Build Tools were not found. Install the Desktop development with C++ workload first.'
}

$vsRoot = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $vsRoot) {
    throw 'Visual Studio Build Tools with MSBuild were not found.'
}
$vsVersion = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationVersion
$vsMajor = [int](($vsVersion -split '\.')[0])
$generator = switch ($vsMajor) {
    18 { 'Visual Studio 18 2026' }
    17 { 'Visual Studio 17 2022' }
    default { throw "Unsupported Visual Studio Build Tools version: $vsVersion" }
}

$cmake = Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path -LiteralPath $cmake)) {
    throw "CMake bundled with Visual Studio was not found: $cmake"
}

Write-Host 'Building the read-only CASC library...'
& $cmake `
    -S $sourceRoot `
    -B $buildRoot `
    -G $generator `
    -A x64 `
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5' `
    '-DCASC_BUILD_SHARED_LIB=ON' `
    '-DCASC_BUILD_STATIC_LIB=OFF' `
    '-DCASC_BUILD_TESTS=OFF'
if ($LASTEXITCODE -ne 0) {
    throw "CASCLib configuration failed (CMake exit code $LASTEXITCODE)."
}

& $cmake --build $buildRoot --config Release --target casc --parallel
if ($LASTEXITCODE -ne 0) {
    throw "CASCLib build failed (CMake exit code $LASTEXITCODE)."
}

if (-not (Test-Path -LiteralPath $dllPath)) {
    throw "CASCLib finished building but the DLL was not found: $dllPath"
}

Write-Output $dllPath
