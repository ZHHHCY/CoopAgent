[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$artifacts = Join-Path $root 'artifacts'
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$name = "CoopAgent-$version-windows-x64"
$stage = Join-Path $artifacts $name
$archive = Join-Path $artifacts "$name.zip"
$node = Join-Path $root '.tools\node\node.exe'
$pnpm = Join-Path $root '.tools\pnpm\node_modules\.bin\pnpm.cmd'
$opencode = Join-Path $root '.tools\opencode\bin\opencode.exe'
$exe = Join-Path $root 'src-tauri\target\release\coopagent.exe'
$cascSource = Join-Path $root '.tools\CascLib'
$cascBuild = Join-Path $cascSource 'build-portable'
$pythonVersion = '3.14.7'
$pythonSha256 = 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15'
$pythonArchive = Join-Path (Join-Path $root '.tools\downloads') "python-$pythonVersion-embed-amd64.zip"

function Get-CoopFileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $hasher.Dispose(); $stream.Dispose() }
}

foreach ($required in @($node, $pnpm, $opencode, (Join-Path $cascSource 'CMakeLists.txt'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少本机打包工具：$required。请先运行源码版 setup.cmd。" }
}
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build.cmd')
    if ($LASTEXITCODE -ne 0) { throw "桌面构建失败：$LASTEXITCODE" }
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "缺少桌面程序：$exe" }

. (Join-Path $PSScriptRoot 'lib\setup-prerequisites.ps1')
$visualStudio = Get-CoopVisualStudio
if (-not $visualStudio) { throw '打包机器缺少 Visual Studio C++/CMake/SDK。' }
$generator = switch ($visualStudio.Major) { 17 { 'Visual Studio 17 2022' } 18 { 'Visual Studio 18 2026' } default { throw '不支持的 Visual Studio 版本。' } }
& $visualStudio.CMake -S $cascSource -B $cascBuild -G $generator -A x64 `
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5' '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW' `
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded' '-DCASC_BUILD_SHARED_LIB=ON' `
    '-DCASC_BUILD_STATIC_LIB=OFF' '-DCASC_BUILD_TESTS=OFF'
if ($LASTEXITCODE -ne 0) { throw '便携版 CASCLib 配置失败。' }
& $visualStudio.CMake --build $cascBuild --config Release --target casc --parallel
if ($LASTEXITCODE -ne 0) { throw '便携版 CASCLib 构建失败。' }
$cascDll = Join-Path $cascBuild 'Release\CascLib.dll'
if (-not (Test-Path -LiteralPath $cascDll -PathType Leaf)) { throw "缺少 CASCLib：$cascDll" }

if (-not (Test-Path -LiteralPath $pythonArchive -PathType Leaf) -or
    (Get-CoopFileSha256 $pythonArchive) -ne $pythonSha256) {
    Write-Host "正在下载 Python $pythonVersion Windows x64 embeddable package…"
    $partial = "$pythonArchive.partial"
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip" -OutFile $partial
    if ((Get-CoopFileSha256 $partial) -ne $pythonSha256) { throw 'Python 归档 SHA-256 校验失败。' }
    Move-Item -LiteralPath $partial -Destination $pythonArchive -Force
}

[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$expectedParent = [IO.Path]::GetFullPath($artifacts).TrimEnd('\')
if ([IO.Path]::GetFullPath((Split-Path -Parent $stage)).TrimEnd('\') -ne $expectedParent) { throw '便携包输出路径越界。' }
if (Test-Path -LiteralPath $stage) {
    $item = Get-Item -LiteralPath $stage -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '拒绝清理链接目录。' }
    Remove-Item -LiteralPath $stage -Recurse -Force
}
[IO.Directory]::CreateDirectory($stage) | Out-Null

$tracked = & git -C $root -c core.quotePath=false ls-files -- .opencode game-a runtime scripts
if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 跟踪文件。' }
foreach ($relative in $tracked) {
    if ($relative -like 'scripts/portable/*') { continue }
    $source = Join-Path $root $relative
    $target = Join-Path $stage $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
foreach ($relative in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'opencode.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $root $relative) -Destination (Join-Path $stage $relative)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'prepare-portable.ps1') -Destination (Join-Path $stage 'scripts\prepare-portable.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable\setup.cmd') -Destination (Join-Path $stage 'setup.cmd')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable\start.cmd') -Destination (Join-Path $stage 'start.cmd')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable\README.txt') -Destination (Join-Path $stage 'README.txt')
Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'CoopAgent.exe')

$nodeTarget = Join-Path $stage '.tools\node'
$pythonTarget = Join-Path $stage '.tools\python'
$openCodeTarget = Join-Path $stage '.tools\opencode\bin'
$cascTarget = Join-Path $stage '.tools\CascLib\build-coopagent\Release'
foreach ($directory in @($nodeTarget, $pythonTarget, $openCodeTarget, $cascTarget)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
Copy-Item -LiteralPath $node -Destination (Join-Path $nodeTarget 'node.exe')
Copy-Item -LiteralPath (Join-Path $root '.tools\node\LICENSE') -Destination (Join-Path $nodeTarget 'LICENSE')
Copy-Item -LiteralPath $opencode -Destination (Join-Path $openCodeTarget 'opencode.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable\LICENSE-OpenCode.txt') -Destination (Join-Path $openCodeTarget 'LICENSE.txt')
Copy-Item -LiteralPath $cascDll -Destination (Join-Path $cascTarget 'CascLib.dll')
Copy-Item -LiteralPath (Join-Path $cascSource 'LICENSE') -Destination (Join-Path $cascTarget 'LICENSE')
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonTarget

@{
    format = 1
    product = 'CoopAgent'
    version = $version
    platform = 'windows-x64'
    python = $pythonVersion
    cascLibCommit = '4971d363e665551ac4142f541e5f2d71f1cda653'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'portable.json') -Encoding UTF8

Write-Host '正在安装便携包的生产运行依赖…'
$priorPath = $env:Path
try {
    $env:Path = "$nodeTarget;$env:Path"
    Push-Location $stage
    try { & $pnpm install --prod --frozen-lockfile --config.node-linker=hoisted }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "生产依赖安装失败：$LASTEXITCODE" }
}
finally { $env:Path = $priorPath }

& (Join-Path $stage 'setup.cmd') --check
if ($LASTEXITCODE -ne 0) { throw '便携包完整性检查失败。' }
if (Test-Path -LiteralPath $archive -PathType Leaf) { Remove-Item -LiteralPath $archive -Force }
& tar.exe --dereference -a -c -f $archive -C $artifacts $name
if ($LASTEXITCODE -ne 0) { throw '便携包 ZIP 创建失败。' }
Write-Host "便携包：$archive"
