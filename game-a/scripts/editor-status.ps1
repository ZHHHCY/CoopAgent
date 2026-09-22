param([string]$DocumentName)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$editors = @(Get-Process -Name 'SC2Editor_x64', 'SC2Editor' -ErrorAction SilentlyContinue)
$games = @(Get-Process -Name 'SC2_x64', 'SC2' -ErrorAction SilentlyContinue)
$document = if ($DocumentName) {
    $editors | Where-Object { $_.MainWindowTitle.IndexOf($DocumentName, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
}
[ordered]@{
    editorRunning = $editors.Count -gt 0
    gameRunning = $games.Count -gt 0
    documentOpen = $null -ne $document
    documentModified = $null -ne $document -and $document.MainWindowTitle.Contains('*')
} | ConvertTo-Json -Compress
