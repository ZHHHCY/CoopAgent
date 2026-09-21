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
    throw "This bootstrap supports Windows x64 only. Use ./scripts/bootstrap on macOS arm64."
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

function Invoke-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string[]]$Urls,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $ExpectedSha256 = $ExpectedSha256.ToLowerInvariant()
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-Sha256 -Path $Destination) -eq $ExpectedSha256) {
            Write-Host "Using verified download: $Destination"
            return
        }

        Write-Warning "The cached file has the wrong checksum and will be quarantined."
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
            Write-Warning "Unable to inspect the partial download: $($_.Exception.Message)"
        }
    }

    $curl = (Get-Command curl.exe -ErrorAction Stop).Source
    foreach ($url in $Urls) {
        Write-Host "Downloading: $url"
        & $curl --fail --location --retry 2 --connect-timeout 15 --speed-limit 1024 --speed-time 30 --continue-at - --output $partialPath $url
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Download source failed; trying the next source."
            continue
        }

        $actualSha256 = Get-Sha256 -Path $partialPath
        if ($actualSha256 -eq $ExpectedSha256) {
            Move-Item -LiteralPath $partialPath -Destination $Destination
            Write-Host "SHA-256 verified: $actualSha256"
            return
        }

        Write-Warning "Checksum mismatch from $url; quarantining the file."
        Move-InvalidDownload -Path $partialPath
    }

    throw "Unable to download and verify $Destination. Run this script again to resume."
}

function Test-VisualCppBuildTools {
    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
        return $true
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) {
        return $false
    }

    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    return -not [string]::IsNullOrWhiteSpace(($installation | Select-Object -First 1))
}

Write-Host "Preparing CoopAgent in $projectRoot"

$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchive = Join-Path $downloadsDir $nodeArchiveName
$nodeUrls = @(
    "https://mirrors.aliyun.com/nodejs-release/v$nodeVersion/$nodeArchiveName",
    "https://repo.huaweicloud.com/nodejs/v$nodeVersion/$nodeArchiveName",
    "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName"
)

if (-not (Test-Path -LiteralPath (Join-Path $nodeDir "node.exe"))) {
    Invoke-VerifiedDownload -Urls $nodeUrls -Destination $nodeArchive -ExpectedSha256 $nodeSha256

    if (Test-Path -LiteralPath $nodeDir) {
        Move-InvalidDownload -Path $nodeDir
    }
    $extractRoot = Join-Path $toolsDir ("node-extract-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $extractRoot
    Move-Item -LiteralPath (Join-Path $extractRoot "node-v$nodeVersion-win-x64") -Destination $nodeDir
}

$nodeExe = Join-Path $nodeDir "node.exe"
$npmCmd = Join-Path $nodeDir "npm.cmd"
$pnpmCmd = Join-Path $pnpmDir "node_modules\.bin\pnpm.cmd"
$env:Path = "$nodeDir;$env:Path"

$installedNodeVersion = (& $nodeExe --version).TrimStart("v")
if ($installedNodeVersion -ne $nodeVersion) {
    throw "Expected Node.js $nodeVersion but found $installedNodeVersion in $nodeDir."
}

$installedPnpmVersion = if (Test-Path -LiteralPath $pnpmCmd) {
    (& $pnpmCmd --version)
} else {
    ""
}

if ($installedPnpmVersion -ne $pnpmVersion) {
    Write-Host "Installing pnpm $pnpmVersion..."
    & $npmCmd install --prefix $pnpmDir "pnpm@$pnpmVersion" --registry $NpmRegistry
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm installation failed with exit code $LASTEXITCODE."
    }
}

$pnpmBinDir = Split-Path -Parent $pnpmCmd
$env:Path = "$nodeDir;$pnpmBinDir;$env:Path"

if (-not $SkipOpenCode) {
    $openCodeExe = Join-Path $openCodeBinDir "opencode.exe"
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
        if (Test-Path -LiteralPath $openCodeBinDir) {
            Move-InvalidDownload -Path $openCodeBinDir
        }
        New-Item -ItemType Directory -Force -Path $openCodeBinDir | Out-Null
        Expand-Archive -LiteralPath $openCodeArchive -DestinationPath $openCodeBinDir

        if (-not (Test-Path -LiteralPath $openCodeExe)) {
            $nestedExe = Get-ChildItem -LiteralPath $openCodeBinDir -Recurse -Filter "opencode.exe" | Select-Object -First 1
            if (-not $nestedExe) {
                throw "The OpenCode archive did not contain opencode.exe."
            }
            Move-Item -LiteralPath $nestedExe.FullName -Destination $openCodeExe
        }
    }
}

if (-not $SkipRust) {
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_HOME = $rustupHome
    $cargoBinDir = Join-Path $cargoHome "bin"
    $rustcExe = Join-Path $cargoBinDir "rustc.exe"

    if (-not (Test-Path -LiteralPath $rustcExe)) {
        $rustTarget = "x86_64-pc-windows-msvc"
        $rustupUrl = "https://static.rust-lang.org/rustup/dist/$rustTarget/rustup-init.exe"
        $rustupExe = Join-Path $downloadsDir "rustup-init.exe"
        $rustupChecksum = Join-Path $downloadsDir "rustup-init.exe.sha256"
        $curl = (Get-Command curl.exe -ErrorAction Stop).Source

        & $curl --fail --location --retry 2 --connect-timeout 15 --output $rustupChecksum "$rustupUrl.sha256"
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to download the official rustup checksum."
        }
        $rustupSha256 = ((Get-Content -LiteralPath $rustupChecksum -Raw).Trim() -split "\s+")[0]
        if ($rustupSha256 -notmatch "^[0-9a-fA-F]{64}$") {
            throw "The official rustup checksum is invalid."
        }

        Invoke-VerifiedDownload -Urls @($rustupUrl) -Destination $rustupExe -ExpectedSha256 $rustupSha256
        & $rustupExe -y --profile minimal --default-toolchain stable --default-host $rustTarget --no-modify-path
        if ($LASTEXITCODE -ne 0) {
            throw "Rust installation failed with exit code $LASTEXITCODE. Run this script again to continue."
        }
    }

    $env:Path = "$cargoBinDir;$env:Path"
}

Write-Host "Installing workspace dependencies from pnpm-lock.yaml..."
$env:CI = "true"
Push-Location $projectRoot
try {
    & $pnpmCmd install --frozen-lockfile --registry $NpmRegistry
    if ($LASTEXITCODE -ne 0) {
        throw "Workspace dependency installation failed with exit code $LASTEXITCODE."
    }

    & $pnpmCmd check
    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript check failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "CoopAgent project-local environment is ready." -ForegroundColor Green
Write-Host "Node.js: $(& $nodeExe --version)"
Write-Host "pnpm:    $(& $pnpmCmd --version)"
if (-not $SkipRust) {
    Write-Host "Rust:    $(& (Join-Path $cargoHome 'bin\rustc.exe') --version)"
}
if (-not $SkipOpenCode) {
    Write-Host "OpenCode: $openCodeVersion"
}
Write-Host ""
Write-Host "Start development: .\scripts\dev.cmd"
Write-Host "Create a build:    .\scripts\build.cmd"

if (-not (Test-VisualCppBuildTools)) {
    Write-Warning @"
Tauri desktop builds also require Microsoft Visual Studio 2022 or 2026 Build Tools with
the 'Desktop development with C++' workload and Windows 10/11 SDK. This is a
system component and is intentionally not installed inside the repository.
Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/
"@
}
