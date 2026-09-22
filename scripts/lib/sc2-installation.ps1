# Windows setup and CASC entry points share the desktop's application config.
function Get-CoopSc2ConfigPath {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { throw '系统未设置 APPDATA。' }
    return Join-Path $env:APPDATA 'CoopAgent\sc2-installation.json'
}

function Get-CoopSc2SavedRoot {
    $configPath = Get-CoopSc2ConfigPath
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($config.rootPath)) { throw "配置文件缺少 rootPath：$configPath" }
    return [string]$config.rootPath
}

function Show-CoopSc2FolderPicker {
    param([string]$InitialPath)
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    try {
        $dialog.Description = '请选择 StarCraft II 安装文件夹。'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.PSObject.Properties.Name -contains 'AutoUpgradeEnabled') {
            $dialog.AutoUpgradeEnabled = $true
        }
        if (-not [string]::IsNullOrWhiteSpace($InitialPath) -and (Test-Path -LiteralPath $InitialPath -PathType Container)) {
            $dialog.SelectedPath = (Get-Item -LiteralPath $InitialPath).FullName
        }
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
        return $dialog.SelectedPath
    }
    finally { $dialog.Dispose() }
}

function Resolve-CoopSc2Root {
    param([Parameter(Mandatory = $true)][string]$Selection)
    $candidate = $Selection.Trim().Trim('"')
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        if ([IO.Path]::GetExtension($candidate) -ine '.exe') { throw '请选择 StarCraft II 文件夹或可执行文件。' }
        $directory = (Get-Item -LiteralPath $candidate).Directory
        while ($null -ne $directory -and -not (Test-Path -LiteralPath (Join-Path $directory.FullName '.build.info') -PathType Leaf)) {
            $directory = $directory.Parent
        }
        if ($null -eq $directory) { throw '无法从这个可执行文件向上找到 StarCraft II 安装目录。' }
        $candidate = $directory.FullName
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { throw "找不到 StarCraft II 文件夹：$candidate" }
    $root = (Get-Item -LiteralPath $candidate).FullName
    $missing = @()
    if (-not (Test-Path -LiteralPath (Join-Path $root '.build.info') -PathType Leaf)) { $missing += '.build.info' }
    $casc = if (Test-Path -LiteralPath (Join-Path $root 'SC2Data') -PathType Container) { 'SC2Data' } else { 'Data' }
    foreach ($part in @('data', 'indices')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root "$casc\$part") -PathType Container)) { $missing += "$casc/$part" }
    }
    # Keep installation checks aligned with validate_sc2_installation in the desktop.
    $editors = @('StarCraft II Editor_x64.exe', 'StarCraft II Editor.exe', 'Support64/SC2Editor_x64.exe', 'Support/SC2Editor.exe')
    if (-not ($editors | Where-Object { Test-Path -LiteralPath (Join-Path $root $_) -PathType Leaf })) { $missing += 'StarCraft II Editor' }
    $versions = Join-Path $root 'Versions'
    $game = @()
    if (Test-Path -LiteralPath $versions -PathType Container) {
        $game = @(Get-ChildItem -LiteralPath $versions -Directory | Where-Object {
            $_.Name -match '^Base[0-9]+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'SC2_x64.exe') -PathType Leaf)
        })
    }
    if ($game.Count -eq 0) { $missing += 'Versions/Base*/SC2_x64.exe' }
    if ($missing.Count -gt 0) { throw "StarCraft II 安装不完整（${root}），缺少：$($missing -join ', ')" }
    return $root
}

function Save-CoopSc2Root {
    param([Parameter(Mandatory = $true)][string]$Root)
    $configPath = Get-CoopSc2ConfigPath
    [IO.Directory]::CreateDirectory((Split-Path -Parent $configPath)) | Out-Null
    $temp = "$configPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = @{ rootPath = $Root } | ConvertTo-Json
        [IO.File]::WriteAllText($temp, $json + "`n", (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $configPath) { [IO.File]::Replace($temp, $configPath, [NullString]::Value) }
        else { [IO.File]::Move($temp, $configPath) }
    }
    finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
