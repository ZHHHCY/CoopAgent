[CmdletBinding()]
param(
    [string]$NpmRegistry = "",
    [string]$GitHubProxy = "",
    [switch]$SkipOpenCode,
    [switch]$SkipRust
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$nodeVersion = "24.18.0"
$nodeSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"
$pnpmVersion = "10.33.0"
$openCodeVersion = "1.18.8"
$openCodeSha256 = "85baa5de531db8d611fb5d9a62ffee00f6de69ae26e4845ec091dd2da4eb5fd1"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$toolsDir = Join-Path $projectRoot ".tools"
$downloadsDir = Join-Path $toolsDir "downloads"
$nodeDir = Join-Path $toolsDir "node"
$pnpmDir = Join-Path $toolsDir "pnpm"
$openCodeBinDir = Join-Path $toolsDir "opencode\bin"
$cargoHome = Join-Path $toolsDir "cargo"
$rustupHome = Join-Path $toolsDir "rustup"

if ($env:OS -ne "Windows_NT" -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    throw "当前环境准备脚本仅支持 Windows x64。"
}

if (-not $NpmRegistry) {
    $NpmRegistry = if ($env:COOPAGENT_NPM_REGISTRY) {
        $env:COOPAGENT_NPM_REGISTRY
    } else {
        "https://registry.npmmirror.com"
    }
}

if (-not $GitHubProxy -and $env:COOPAGENT_GITHUB_PROXY) {
    $GitHubProxy = $env:COOPAGENT_GITHUB_PROXY
}

. (Join-Path $scriptDir 'lib\setup-prerequisites.ps1')
if (-not $SkipRust) { Assert-CoopSetupPrerequisites -BuildOnly }
New-Item -ItemType Directory -Force -Path $downloadsDir | Out-Null

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Move-InvalidDownload {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        Move-Item -LiteralPath $Path -Destination "$Path.invalid-$timestamp"
    }
}

function Remove-ManagedToolDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ([IO.Path]::GetFullPath((Split-Path -Parent $resolvedPath)).TrimEnd('\') -ne $resolvedRoot) {
        throw "拒绝清理工具目录之外的路径：$resolvedPath"
    }
    if (-not (Test-Path -LiteralPath $resolvedPath)) { return }
    $item = Get-Item -LiteralPath $resolvedPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "拒绝递归清理链接目录：$resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Remove-StaleDirectories {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Prefix
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    Get-ChildItem -LiteralPath $resolvedRoot -Directory -Filter "$Prefix*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-ManagedToolDirectory -Root $resolvedRoot -Path $_.FullName
    }
}

function Test-ToolVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $reported = (& $Executable --version 2>$null | Out-String).Trim()
        return $LASTEXITCODE -eq 0 -and $reported -match [regex]::Escape($ExpectedVersion)
    }
    catch { return $false }
}

function Invoke-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string[]]$Urls,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $ExpectedSha256 = $ExpectedSha256.ToLowerInvariant()
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-Sha256 -Path $Destination) -eq $ExpectedSha256) {
            Write-Host "使用已校验的下载文件：$Destination"
            return
        }

        Write-Warning "缓存文件的校验和不正确，将移动到隔离文件。"
        Move-InvalidDownload -Path $Destination
    }

    $partialPath = "$Destination.part"
    if (Test-Path -LiteralPath $partialPath) {
        try {
            if ((Get-Sha256 -Path $partialPath) -eq $ExpectedSha256) {
                Move-Item -LiteralPath $partialPath -Destination $Destination
                return
            }
        } catch {
            Write-Warning "无法检查未完成的下载：$($_.Exception.Message)"
        }
    }

    $curl = (Get-Command curl.exe -ErrorAction Stop).Source
    foreach ($url in $Urls) {
        Write-Host "正在下载：$url"
        & $curl --fail --location --retry 2 --connect-timeout 15 --speed-limit 1024 --speed-time 30 --continue-at - --output $partialPath $url
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "下载源失败，正在尝试下一个来源。"
            continue
        }

        $actualSha256 = Get-Sha256 -Path $partialPath
        if ($actualSha256 -eq $ExpectedSha256) {
            Move-Item -LiteralPath $partialPath -Destination $Destination
            Write-Host "SHA-256 校验通过：$actualSha256"
            return
        }

        Write-Warning "来自 $url 的文件校验和不匹配，将移动到隔离文件。"
        Move-InvalidDownload -Path $partialPath
    }

    throw "无法下载并校验 $Destination。请重新运行此脚本继续。"
}

Write-Host "正在准备 CoopAgent：$projectRoot"
Remove-StaleDirectories -Root $toolsDir -Prefix 'node-extract-'
Remove-StaleDirectories -Root $toolsDir -Prefix 'opencode-extract-'

$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchive = Join-Path $downloadsDir $nodeArchiveName
$nodeUrls = @(
    "https://mirrors.aliyun.com/nodejs-release/v$nodeVersion/$nodeArchiveName",
    "https://repo.huaweicloud.com/nodejs/v$nodeVersion/$nodeArchiveName",
    "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName"
)

if (-not (Test-ToolVersion -Executable (Join-Path $nodeDir 'node.exe') -ExpectedVersion $nodeVersion)) {
    Invoke-VerifiedDownload -Urls $nodeUrls -Destination $nodeArchive -ExpectedSha256 $nodeSha256

    if (Test-Path -LiteralPath $nodeDir) {
        Move-InvalidDownload -Path $nodeDir
    }
    $extractRoot = Join-Path $toolsDir ("node-extract-" + [guid]::NewGuid().ToString("N"))
    try {
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $extractRoot
        $stagedNode = Join-Path $extractRoot "node-v$nodeVersion-win-x64"
        if (-not (Test-ToolVersion -Executable (Join-Path $stagedNode 'node.exe') -ExpectedVersion $nodeVersion)) {
            throw 'Node.js 解压结果不完整或版本不正确。'
        }
        Move-Item -LiteralPath $stagedNode -Destination $nodeDir
    }
    finally {
        if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    }
}

$nodeExe = Join-Path $nodeDir "node.exe"
$npmCmd = Join-Path $nodeDir "npm.cmd"
$pnpmCmd = Join-Path $pnpmDir "node_modules\.bin\pnpm.cmd"
$env:Path = "$nodeDir;$env:Path"

$installedNodeVersion = (& $nodeExe --version).TrimStart("v")
if ($installedNodeVersion -ne $nodeVersion) {
    throw "需要 Node.js $nodeVersion，但在 $nodeDir 中检测到 $installedNodeVersion。"
}

if (-not (Test-ToolVersion -Executable $pnpmCmd -ExpectedVersion $pnpmVersion)) {
    Write-Host "正在安装 pnpm $pnpmVersion…"
    if (Test-Path -LiteralPath $pnpmDir) { Remove-ManagedToolDirectory -Root $toolsDir -Path $pnpmDir }
    & $npmCmd install --prefix $pnpmDir "pnpm@$pnpmVersion" --registry $NpmRegistry
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm 安装失败，退出代码：$LASTEXITCODE。"
    }
}

$pnpmBinDir = Split-Path -Parent $pnpmCmd
$env:Path = "$nodeDir;$pnpmBinDir;$env:Path"

if (-not $SkipOpenCode) {
    $openCodeExe = Join-Path $openCodeBinDir "opencode.exe"
    if ((Test-Path -LiteralPath $openCodeBinDir) -and -not (Test-ToolVersion -Executable $openCodeExe -ExpectedVersion $openCodeVersion)) {
        Write-Warning '现有 OpenCode 安装不完整或版本不正确，将重新安装。'
        Move-InvalidDownload -Path $openCodeBinDir
    }
    if (-not (Test-Path -LiteralPath $openCodeExe)) {
        $openCodeArchiveName = "opencode-windows-x64.zip"
        $openCodeArchive = Join-Path $downloadsDir "opencode-v$openCodeVersion-windows-x64.zip"
        $openCodeOfficialUrl = "https://github.com/anomalyco/opencode/releases/download/v$openCodeVersion/$openCodeArchiveName"
        $openCodeUrls = @()
        if ($GitHubProxy) {
            $openCodeUrls += $GitHubProxy.TrimEnd("/") + "/" + $openCodeOfficialUrl
        }
        $openCodeUrls += $openCodeOfficialUrl

        Invoke-VerifiedDownload -Urls $openCodeUrls -Destination $openCodeArchive -ExpectedSha256 $openCodeSha256
        $extractRoot = Join-Path $toolsDir ("opencode-extract-" + [guid]::NewGuid().ToString("N"))
        try {
            Expand-Archive -LiteralPath $openCodeArchive -DestinationPath $extractRoot
            $stagedExe = Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter 'opencode.exe' -File | Select-Object -First 1
            if (-not $stagedExe) {
                throw "OpenCode 压缩包中没有 opencode.exe。"
            }
            if (-not (Test-ToolVersion -Executable $stagedExe.FullName -ExpectedVersion $openCodeVersion)) {
                throw 'OpenCode 解压结果不完整或版本不正确。'
            }
            $publishRoot = if ($stagedExe.Directory.FullName -eq (Resolve-Path $extractRoot).Path) {
                $extractRoot
            } else {
                $stagedExe.Directory.FullName
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $openCodeBinDir) | Out-Null
            Move-Item -LiteralPath $publishRoot -Destination $openCodeBinDir
        }
        finally {
            if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
        }
    }
}

if (-not $SkipRust) {
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_HOME = $rustupHome
    $cargoBinDir = Join-Path $cargoHome "bin"
    $rustcExe = Join-Path $cargoBinDir "rustc.exe"

    $rustReady = Test-ToolVersion -Executable $rustcExe -ExpectedVersion 'rustc'
    if (-not $rustReady) {
        $rustTarget = "x86_64-pc-windows-msvc"
        $rustupUrl = "https://static.rust-lang.org/rustup/dist/$rustTarget/rustup-init.exe"
        $rustupExe = Join-Path $downloadsDir "rustup-init.exe"
        $rustupChecksum = Join-Path $downloadsDir "rustup-init.exe.sha256"
        $curl = (Get-Command curl.exe -ErrorAction Stop).Source

        & $curl --fail --location --retry 2 --connect-timeout 15 --output $rustupChecksum "$rustupUrl.sha256"
        if ($LASTEXITCODE -ne 0) {
            throw "无法下载官方 rustup 校验和。"
        }
        $rustupSha256 = ((Get-Content -LiteralPath $rustupChecksum -Raw).Trim() -split "\s+")[0]
        if ($rustupSha256 -notmatch "^[0-9a-fA-F]{64}$") {
            throw "官方 rustup 校验和无效。"
        }

        Invoke-VerifiedDownload -Urls @($rustupUrl) -Destination $rustupExe -ExpectedSha256 $rustupSha256
        & $rustupExe -y --profile minimal --default-toolchain stable --default-host $rustTarget --no-modify-path
        if ($LASTEXITCODE -ne 0) {
            throw "Rust 安装失败，退出代码：$LASTEXITCODE。请重新运行此脚本继续。"
        }
    }

    $env:Path = "$cargoBinDir;$env:Path"
}

Write-Host "正在根据 pnpm-lock.yaml 安装工作区依赖…"
$env:CI = "true"
Push-Location $projectRoot
try {
    & $pnpmCmd install --frozen-lockfile --registry $NpmRegistry
    if ($LASTEXITCODE -ne 0) {
        throw "工作区依赖安装失败，退出代码：$LASTEXITCODE。"
    }

    & $pnpmCmd check
    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript 检查失败，退出代码：$LASTEXITCODE。"
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "CoopAgent 项目环境已准备完成。" -ForegroundColor Green
Write-Host "Node.js: $(& $nodeExe --version)"
Write-Host "pnpm:    $(& $pnpmCmd --version)"
if (-not $SkipRust) {
    Write-Host "Rust:    $(& (Join-Path $cargoHome 'bin\rustc.exe') --version)"
}
if (-not $SkipOpenCode) {
    Write-Host "OpenCode: $openCodeVersion"
}
Write-Host ""
Write-Host "启动开发环境：.\scripts\dev.cmd"
Write-Host "创建发行构建：.\scripts\build.cmd"
