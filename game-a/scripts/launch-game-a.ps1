param(
    [Alias('Host')][string]$HostId,
    [string]$StarCraftRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

if (Get-Process -Name 'SC2_x64', 'SC2' -ErrorAction SilentlyContinue) {
    throw '星际争霸 II 正在运行。请先结束当前游戏，再更新并运行地图。'
}

$applicationGameARoot = Split-Path -Parent $PSScriptRoot
$gameARoot = if ($env:COOPAGENT_WORKSPACE_ROOT) { Join-Path $env:COOPAGENT_WORKSPACE_ROOT 'game-a' } else { $applicationGameARoot }
$gameABuilder = Join-Path $PSScriptRoot 'build-game-a.ps1'
if ([string]::IsNullOrWhiteSpace($HostId)) {
    $mapComponents = & $gameABuilder
}
else {
    $mapComponents = & $gameABuilder -HostId $HostId
}
$documentTitleFragment = Split-Path -Leaf (Split-Path -Parent $mapComponents)
$documentTitlePrefix = $documentTitleFragment -replace '-[0-9a-fA-F]{12}\.SC2Map$', ''
$sc2Root = if (-not [string]::IsNullOrWhiteSpace($StarCraftRoot)) {
    $StarCraftRoot
}
elseif (-not [string]::IsNullOrWhiteSpace($env:COOPAGENT_SC2_ROOT)) {
    $env:COOPAGENT_SC2_ROOT
}
else {
    'C:\Program Files (x86)\StarCraft II'
}
$editorCandidates = @(
    (Join-Path $sc2Root 'StarCraft II Editor_x64.exe'),
    (Join-Path $sc2Root 'StarCraft II Editor.exe'),
    (Join-Path $sc2Root 'Support64\SC2Editor_x64.exe'),
    (Join-Path $sc2Root 'Support\SC2Editor.exe')
)
$editorPath = $editorCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($editorPath)) {
    $editorPath = $editorCandidates[0]
}
$sc2Variables = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'StarCraft II\Variables.txt'
$editorPreferences = 'HKCU:\Software\Blizzard Entertainment\StarCraft II Editor\Preferences'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class GameAEditorWindow {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumCount);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindowEnabled(IntPtr window);

    public static string Title(IntPtr window) {
        StringBuilder title = new StringBuilder(1024);
        GetWindowText(window, title, title.Capacity);
        return title.ToString();
    }

    public static IntPtr Find(int processId, string titleFragment) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate (IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) {
                return true;
            }

            StringBuilder title = new StringBuilder(1024);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString().IndexOf(titleFragment, StringComparison.OrdinalIgnoreCase) >= 0) {
                result = window;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@

if (-not (Test-Path -LiteralPath $editorPath)) {
    throw "StarCraft II Editor was not found: $editorPath"
}

if (-not (Test-Path -LiteralPath $mapComponents)) {
    throw "Map Runtime component map was not found: $mapComponents"
}

# SC2 display mode 1 is borderless windowed fullscreen.
if (Test-Path -LiteralPath $sc2Variables) {
    $variablesText = [IO.File]::ReadAllText($sc2Variables)
    if ($variablesText -match '(?m)^displaymode=\d+\r?$') {
        $variablesText = [regex]::Replace($variablesText, '(?m)^displaymode=\d+\r?$', 'displaymode=1')
    }
    else {
        $variablesText += "`r`ndisplaymode=1`r`n"
    }
    [IO.File]::WriteAllText($sc2Variables, $variablesText, (New-Object Text.UTF8Encoding($false)))
}

# Test Document has its own display-mode preference and otherwise overrides Variables.txt.
if (-not (Test-Path -LiteralPath $editorPreferences)) {
    New-Item -Path $editorPreferences -Force | Out-Null
}
New-ItemProperty -Path $editorPreferences -Name 'TestDocWindowedFullscreen' -PropertyType DWord -Value 1 -Force | Out-Null

function Get-ReadyEditor {
    Get-Process -Name 'SC2Editor_x64' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
}

function Get-GameADocumentWindow {
    param([int]$ProcessId)

    [GameAEditorWindow]::Find($ProcessId, $documentTitleFragment)
}

function Wait-ForEditor {
    param([int]$TimeoutSeconds = 90)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $editor = Get-ReadyEditor
        if ($null -ne $editor) {
            return $editor
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw 'Timed out waiting for the StarCraft II Editor window.'
}

$editorWasStarted = $false
$shell = New-Object -ComObject WScript.Shell
$editor = Get-ReadyEditor
if ($null -eq $editor) {
    $editorWasStarted = $true
    Start-Process -FilePath $editorPath -ArgumentList @('-product', 'SC2') | Out-Null
    $editor = Wait-ForEditor
    # The first process is relaunched through Battle.net; wait for its UI to settle.
    Start-Sleep -Seconds 4
    $editor = Wait-ForEditor
}

$documentWindow = Get-GameADocumentWindow -ProcessId $editor.Id
if ($documentWindow -eq [IntPtr]::Zero) {
    # A generated map that is already open may keep its component folder locked.
    # Close only the active, clean generated document. Ctrl+F4 closes the document
    # tab while keeping the editor process alive. A modified document is left alone.
    $previousGeneratedWindow = [GameAEditorWindow]::Find($editor.Id, $documentTitlePrefix)
    if ($previousGeneratedWindow -ne [IntPtr]::Zero) {
        $previousTitle = [GameAEditorWindow]::Title($previousGeneratedWindow)
        if ($previousTitle.Contains('*')) {
            Write-Warning "The previous generated Map Runtime map has unsaved changes and was left open: $previousTitle"
        }
        else {
            if ($shell.AppActivate($editor.Id)) {
                [GameAEditorWindow]::SetForegroundWindow($previousGeneratedWindow) | Out-Null
                Start-Sleep -Milliseconds 250
                $shell.SendKeys('^{F4}')
                Start-Sleep -Milliseconds 750
                $editor = Get-ReadyEditor
                if ($null -eq $editor) {
                    throw 'The SC2 Editor exited while closing the previous generated Map Runtime document.'
                }
            }
        }
    }

    $quotedComponents = '"' + $mapComponents + '"'
    Start-Process -FilePath $editorPath -ArgumentList @('-loadfile', $quotedComponents, '-product', 'SC2') | Out-Null

    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        $editor = Get-ReadyEditor
        if ($null -ne $editor) {
            $documentWindow = Get-GameADocumentWindow -ProcessId $editor.Id
        }
        if ($documentWindow -ne [IntPtr]::Zero) {
            break
        }
    } while ((Get-Date) -lt $deadline)

    if ($null -eq $editor -or $documentWindow -eq [IntPtr]::Zero) {
        throw 'The editor started, but the generated Map Runtime map did not open.'
    }
}

# Old content-addressed maps are disposable. Once the previous document has
# closed, reclaim versions that are no longer current. Versions still open in
# another editor tab remain locked and are retried on a later launch.
$currentMap = [IO.Path]::GetFullPath((Split-Path -Parent $mapComponents))
$versionsRoot = [IO.Path]::GetFullPath((Split-Path -Parent $currentMap))
Get-ChildItem -LiteralPath $versionsRoot -Directory -Filter ($documentTitlePrefix + '-*.SC2Map') |
    Where-Object { [IO.Path]::GetFullPath($_.FullName) -ne $currentMap } |
    ForEach-Object {
        $candidate = [IO.Path]::GetFullPath($_.FullName)
        if ([IO.Path]::GetDirectoryName($candidate).TrimEnd('\') -ne $versionsRoot.TrimEnd('\')) {
            throw "Refusing to clean a generated map outside its version directory: $candidate"
        }
        try {
            Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove an older Map Runtime build that is probably still open: $candidate"
        }
    }

if (-not $shell.AppActivate($editor.Id)) {
    throw 'Could not activate the StarCraft II Editor window.'
}

# Only a process started by this launcher may receive the automatic Escape used to
# dismiss startup Tips. Never dismiss a user's save/reload/error dialog in an editor
# that was already open.
if ($editorWasStarted) {
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('{ESC}')
    Start-Sleep -Milliseconds 300
    if (-not $shell.AppActivate($editor.Id)) {
        throw 'Could not reactivate the StarCraft II Editor window after closing startup dialogs.'
    }
}

$documentWindow = Get-GameADocumentWindow -ProcessId $editor.Id
if ($documentWindow -eq [IntPtr]::Zero) {
    throw 'Could not activate the Map Runtime document window.'
}
if ([GameAEditorWindow]::Title($documentWindow).Contains('*')) {
    throw '生成地图在编辑器中存在未保存的改动。请先另存或关闭该文档，再返回 CoopAgent 更新并运行。'
}

# SetForegroundWindow may report false when Windows' foreground-lock policy has
# already activated the editor through AppActivate. Do not turn that benign state
# into a launcher failure.
[GameAEditorWindow]::SetForegroundWindow($documentWindow) | Out-Null

Start-Sleep -Seconds 1
$manualStartRequired = -not [GameAEditorWindow]::IsWindowEnabled($documentWindow)
if (-not $manualStartRequired) { $shell.SendKeys('^{F9}') }
# Opening the exact generated document is confirmed; sending the shortcut does
# not prove that a game started. The desktop observes the game process separately.
$result = [ordered]@{
    status = 'ok'
    editor = 'opened'
    documentName = $documentTitleFragment
    manualStartRequired = $manualStartRequired
}
Write-Output ('COOPAGENT_EDITOR_RESULT ' + ($result | ConvertTo-Json -Compress))
