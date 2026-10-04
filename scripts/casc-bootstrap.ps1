[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $repoRoot '.tools'
$sourceRoot = Join-Path $toolsRoot 'CascLib'
$buildRoot = Join-Path $sourceRoot 'build-coopagent'
$dllPath = Join-Path $buildRoot 'Release\CascLib.dll'
$cascTag = '3.0'
$cascCommit = '4971d363e665551ac4142f541e5f2d71f1cda653'

# A portable release ships the verified DLL and never needs Git or a C++ compiler.
if (Test-Path -LiteralPath (Join-Path $repoRoot 'portable.json') -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $dllPath -PathType Leaf)) {
        throw "便携包缺少 CASCLib：$dllPath"
    }
    Write-Output $dllPath
    exit 0
}

if (-not (Test-Path -LiteralPath $toolsRoot)) {
    New-Item -ItemType Directory -Path $toolsRoot | Out-Null
}

function Remove-ManagedDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $expectedParent = [IO.Path]::GetFullPath($toolsRoot).TrimEnd('\')
    $actualParent = [IO.Path]::GetFullPath((Split-Path -Parent $Path)).TrimEnd('\')
    if ($actualParent -ne $expectedParent) { throw "拒绝清理工具目录之外的路径：$Path" }
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "拒绝递归清理链接目录：$Path"
        }
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Test-CascSource {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Commit
    )
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $Path 'CMakeLists.txt') -PathType Leaf)) {
        return $false
    }
    try {
        $head = (& git -C $Path rev-parse --verify HEAD 2>$null | Select-Object -First 1)
        return $head -and $head.Trim() -eq $Commit
    }
    catch { return $false }
}

Get-ChildItem -LiteralPath $toolsRoot -Directory -Filter 'CascLib.clone-*' -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-ManagedDirectory -Path $_.FullName
}

if (-not (Test-CascSource -Path $sourceRoot -Commit $cascCommit)) {
    if (Test-Path -LiteralPath $sourceRoot) {
        Write-Warning '检测到不完整或版本不匹配的 CASCLib 源码，将重新下载。'
        Remove-ManagedDirectory -Path $sourceRoot
    }
    $cloneRoot = Join-Path $toolsRoot ("CascLib.clone-" + [guid]::NewGuid().ToString('N'))
    try {
        Write-Host "正在下载官方 CASCLib $cascTag 源码…"
        & git -c advice.detachedHead=false clone --depth 1 --branch $cascTag https://github.com/ladislav-zezula/CascLib.git $cloneRoot
        $cloneExitCode = $LASTEXITCODE
        if ($cloneExitCode -ne 0) {
            throw "无法下载 CASCLib（git 退出代码 $cloneExitCode）。"
        }
        if (-not (Test-CascSource -Path $cloneRoot -Commit $cascCommit)) {
            throw "CASCLib 下载完成，但源码提交与内置版本不一致（应为 $cascCommit）。"
        }
        Move-Item -LiteralPath $cloneRoot -Destination $sourceRoot
    }
    finally {
        if (Test-Path -LiteralPath $cloneRoot) { Remove-ManagedDirectory -Path $cloneRoot }
    }
}

if (Test-Path -LiteralPath $dllPath -PathType Leaf) {
    Write-Output $dllPath
    exit 0
}

. (Join-Path $PSScriptRoot 'lib\setup-prerequisites.ps1')
$visualStudio = Get-CoopVisualStudio
if (-not $visualStudio) { throw '找不到完整的 Visual Studio 2022/2026 C++ 与 CMake 工具，请运行 setup.cmd 查看缺少的组件。' }
$vsRoot = $visualStudio.Root
$vsMajor = $visualStudio.Major
$generator = switch ($vsMajor) {
    18 { 'Visual Studio 18 2026' }
    17 { 'Visual Studio 17 2022' }
    default { throw "不支持的 Visual Studio Build Tools 版本：$vsMajor" }
}

$cmake = $visualStudio.CMake
if (-not (Test-Path -LiteralPath $cmake)) {
    throw "找不到 Visual Studio 附带的 CMake：$cmake"
}

Write-Host '正在构建只读 CASC 库…'
$hadBuildRoot = Test-Path -LiteralPath $buildRoot
& $cmake `
    -S $sourceRoot `
    -B $buildRoot `
    -G $generator `
    -A x64 `
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5' `
    '-DCASC_BUILD_SHARED_LIB=ON' `
    '-DCASC_BUILD_STATIC_LIB=OFF' `
    '-DCASC_BUILD_TESTS=OFF'
if ($LASTEXITCODE -ne 0 -and $hadBuildRoot) {
    Write-Warning '检测到不可复用的 CASCLib 构建目录，将清理后重试一次。'
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
    & $cmake `
        -S $sourceRoot `
        -B $buildRoot `
        -G $generator `
        -A x64 `
        '-DCMAKE_POLICY_VERSION_MINIMUM=3.5' `
        '-DCASC_BUILD_SHARED_LIB=ON' `
        '-DCASC_BUILD_STATIC_LIB=OFF' `
        '-DCASC_BUILD_TESTS=OFF'
}
if ($LASTEXITCODE -ne 0) {
    throw "CASCLib 配置失败（CMake 退出代码 $LASTEXITCODE）。"
}

& $cmake --build $buildRoot --config Release --target casc --parallel
if ($LASTEXITCODE -ne 0) {
    throw "CASCLib 构建失败（CMake 退出代码 $LASTEXITCODE）。"
}

if (-not (Test-Path -LiteralPath $dllPath)) {
    throw "CASCLib 已完成构建，但找不到 DLL：$dllPath"
}

Write-Output $dllPath
