function Get-CoopVisualStudio {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { return $null }
    $installations = @(& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 Microsoft.Component.MSBuild -format json | ConvertFrom-Json)
    foreach ($installation in $installations) {
        $major = [int]($installation.installationVersion.Split('.')[0])
        $cmake = Join-Path $installation.installationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
        if ($major -in @(17, 18) -and (Test-Path -LiteralPath $cmake -PathType Leaf)) {
            return [pscustomobject]@{ Root = $installation.installationPath; Major = $major; CMake = $cmake }
        }
    }
    return $null
}

function Test-CoopWindowsSdk([string]$KitsRoot) {
    if (-not $KitsRoot) {
        $kits = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue
        if ($kits) { $KitsRoot = $kits.KitsRoot10 }
    }
    if (-not $KitsRoot) { return $false }
    foreach ($version in @(Get-ChildItem -LiteralPath (Join-Path $KitsRoot 'Include') -Directory -ErrorAction SilentlyContinue)) {
        $required = @("Include\$($version.Name)\um\Windows.h", "Include\$($version.Name)\ucrt\stdio.h",
            "Lib\$($version.Name)\um\x64\kernel32.lib", "Lib\$($version.Name)\ucrt\x64\ucrt.lib")
        if (@($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $KitsRoot $_) -PathType Leaf) }).Count -eq 0) { return $true }
    }
    return $false
}

function Assert-CoopSetupPrerequisites {
    param([switch]$BuildOnly)
    $missing = New-Object 'System.Collections.Generic.List[string]'
    if (-not $BuildOnly) {
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        $pythonReady = $false
        if ($python) {
            try {
                $probe = & $python.Source -c 'import sys,struct; print(int(sys.version_info >= (3,10) and struct.calcsize(chr(80)) == 8))' 2>$null
                $pythonReady = $LASTEXITCODE -eq 0 -and "$probe".Trim() -eq '1'
            } catch { $pythonReady = $false }
        }
        if (-not $pythonReady) { $missing.Add('Python 3.10 或更新的 64 位版本（安装时勾选 Add python.exe to PATH）：https://www.python.org/downloads/windows/') }
        $git = Get-Command git.exe -ErrorAction SilentlyContinue
        $gitReady = $false
        if ($git) { try { $null = & $git.Source --version 2>$null; $gitReady = $LASTEXITCODE -eq 0 } catch {} }
        if (-not $gitReady) { $missing.Add('Git for Windows（允许命令行使用 Git）：https://git-scm.com/download/win') }
    }
    if (-not (Get-CoopVisualStudio)) { $missing.Add('Visual Studio 2022/2026 Build Tools：安装“使用 C++ 的桌面开发”，包含 MSVC、MSBuild 和“适用于 Windows 的 C++ CMake 工具”：https://visualstudio.microsoft.com/visual-cpp-build-tools/') }
    if (-not (Test-CoopWindowsSdk)) { $missing.Add('Windows 10/11 SDK（含 x64 库），通过 Visual Studio Installer 安装。') }
    if ($missing.Count) { throw ("安装前检查未通过，请先补齐以下组件，再运行 setup.cmd：`n- " + ($missing -join "`n- ")) }
    Write-Host '安装前检查通过。'
}
