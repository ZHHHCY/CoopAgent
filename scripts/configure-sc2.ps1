[CmdletBinding()]
param(
    [string]$StarCraftRoot,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\sc2-installation.ps1')

if (-not [string]::IsNullOrWhiteSpace($StarCraftRoot)) {
    $root = Resolve-CoopSc2Root $StarCraftRoot
}
elseif ($NonInteractive) {
    if (-not [string]::IsNullOrWhiteSpace($env:COOPAGENT_SC2_ROOT)) {
        $root = Resolve-CoopSc2Root $env:COOPAGENT_SC2_ROOT
    } else {
        $saved = Get-CoopSc2SavedRoot
        if (-not $saved) { throw 'No valid saved installation. Specify -StarCraftRoot <folder-or-exe>.' }
        $root = Resolve-CoopSc2Root $saved
    }
}
else {
    # Interactive setup always shows a real Windows folder picker. A saved path
    # is only the initial location, so rerunning setup can change installations.
    $initial = $env:COOPAGENT_SC2_ROOT
    if ([string]::IsNullOrWhiteSpace($initial)) {
        try { $initial = Get-CoopSc2SavedRoot } catch { $initial = $null }
    }
    if ([string]::IsNullOrWhiteSpace($initial) -and (Test-Path -LiteralPath 'C:\Program Files (x86)\StarCraft II' -PathType Container)) {
        $initial = 'C:\Program Files (x86)\StarCraft II'
    }
    $root = $null
    while (-not $root) {
        $selection = Show-CoopSc2FolderPicker $initial
        if ([string]::IsNullOrWhiteSpace($selection)) {
            throw 'Setup cancelled. Installation configuration was not changed.'
        }
        try { $root = Resolve-CoopSc2Root $selection }
        catch {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show(
                $_.Exception.Message,
                'CoopAgent - Invalid StarCraft II folder',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            ) | Out-Null
            $initial = $selection
        }
    }
}
Save-CoopSc2Root $root
Write-Host "StarCraft II: $root"
Write-Host "Saved for setup and desktop: $(Get-CoopSc2ConfigPath)"
Write-Output $root
