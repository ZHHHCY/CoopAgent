[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$Check,
    [switch]$DeleteProjects,
    [switch]$ClearSharedData
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\', '/')
$localRoot = Join-Path $env:LOCALAPPDATA 'CoopAgent'
$webViewRoot = Join-Path $env:LOCALAPPDATA 'com.coopagent.desktop'
$roamingRoot = Join-Path $env:APPDATA 'CoopAgent'

function Assert-Repository {
    if ([IO.Path]::GetPathRoot($repositoryRoot).TrimEnd('\', '/') -eq $repositoryRoot) {
        throw "拒绝在磁盘根目录执行重置：$repositoryRoot"
    }
    foreach ($required in @('package.json', 'scripts\bootstrap.ps1', 'src-tauri\tauri.conf.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $required))) {
            throw "当前目录不是完整的 CoopAgent 仓库，缺少：$required"
        }
    }
}

function Assert-GeneratedPath([string]$Path, [string]$AllowedRoot) {
    $target = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $allowed = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\', '/')
    if ($target -ne $allowed -and -not $target.StartsWith("$allowed\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝删除允许范围之外的路径：$target"
    }
    for ($ancestor = $target; $ancestor.Length -ge $allowed.Length; $ancestor = Split-Path $ancestor -Parent) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "拒绝通过链接目录清理：$ancestor"
            }
        }
        if ($ancestor -eq $allowed) { break }
    }
}

# pnpm creates directory junctions. Unlink them without traversing their targets.
function Remove-TreeWithoutFollowingLinks([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) {
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) { Remove-TreeWithoutFollowingLinks $child.FullName }
        }
        [IO.Directory]::Delete($Path)
    } else { Remove-Item -LiteralPath $Path -Force }
}

function Remove-GeneratedPath([string]$Path, [string]$AllowedRoot) {
    Assert-GeneratedPath $Path $AllowedRoot
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $target = [IO.Path]::GetFullPath($Path)
    Write-Host "删除 $target"
    for ($attempt = 0; ; $attempt++) {
        try {
            Remove-TreeWithoutFollowingLinks $target
            return
        }
        catch {
            if ($attempt -ge 2) { throw }
            Start-Sleep -Milliseconds (250 * ($attempt + 1))
        }
    }
}

Assert-Repository

$repositoryPaths = @(
    '.tools',
    'node_modules',
    'runtime\coop-mcp\node_modules',
    'dist',
    'dist-ssr',
    'src-tauri\target',
    'game-a\build'
)
if ($DeleteProjects) {
    $repositoryPaths += @('projects', '.coopagent\projects.json', '.coopagent\projects.json.tmp')
} else {
    foreach ($project in @(Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'projects') -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $project.FullName 'coop-project.json')) {
            $repositoryPaths += "projects\$($project.Name)\game-a\build"
        }
    }
}
$targets = @($repositoryPaths | ForEach-Object { [pscustomobject]@{ Path = Join-Path $repositoryRoot $_; Root = $repositoryRoot } })
if ($ClearSharedData) {
    $targets += @([pscustomobject]@{ Path = $localRoot; Root = $localRoot },
        [pscustomobject]@{ Path = $webViewRoot; Root = $webViewRoot },
        [pscustomobject]@{ Path = Join-Path $roamingRoot 'sc2-installation.json'; Root = $roamingRoot })
}
foreach ($target in $targets) { Assert-GeneratedPath $target.Path $target.Root }
if ($Check) { $targets | ConvertTo-Json -Depth 3; exit 0 }

Write-Host ''
Write-Host '此操作将删除：'
Write-Host '  - 当前副本的工具链、依赖及可重建地图/应用构建缓存'
if ($DeleteProjects) { Write-Host '  - 已选择 -DeleteProjects：删除当前 projects 下的全部项目、会话、修改及最近项目列表' }
if ($ClearSharedData) { Write-Host '  - 已选择 -ClearSharedData：删除所有 CoopAgent 副本共用的数据库、CASC、WebView 缓存及 SC2 路径配置' }
Write-Host ''
Write-Host '不会删除：'
Write-Host '  - 源码、日志与验收报告'
if (-not $DeleteProjects) { Write-Host '  - 项目源文件、修改、会话和最近项目列表' }
if (-not $ClearSharedData) { Write-Host '  - 共享数据库、CASC、缓存和 SC2 路径配置' }
Write-Host '  - 手动放在仓库外的项目目录'
Write-Host '  - 模型设置和 OpenCode/API 凭据'
Write-Host ''

if (-not $Yes) {
    $answer = Read-Host '输入 RESET 继续'
    if ($answer -cne 'RESET') {
        Write-Host '已取消。'
        exit 0
    }
}

$running = Get-CimInstance Win32_Process -Filter "Name='coopagent.exe' OR Name='node.exe' OR Name='opencode.exe' OR Name='cargo.exe' OR Name='rustc.exe' OR Name='SC2_x64.exe' OR Name='SC2Editor_x64.exe'" | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith("$repositoryRoot\", [StringComparison]::OrdinalIgnoreCase)) -or
    ($ClearSharedData -and $_.Name -in @('coopagent.exe', 'opencode.exe')) -or $_.Name -in @('SC2_x64.exe', 'SC2Editor_x64.exe')
}
if ($running) { throw '请先关闭相关 CoopAgent、开发终端及 SC2 游戏/编辑器，再重置环境。' }
foreach ($target in $targets) { Remove-GeneratedPath $target.Path $target.Root }

Write-Host ''
Write-Host '重置完成。现在可以运行 setup.cmd 重新测试完整安装流程。'
