[CmdletBinding()]
param([switch]$LogWorker)
$ErrorActionPreference = 'Stop'
if (-not $LogWorker) {
    . (Join-Path $PSScriptRoot 'lib\process-log.ps1')
    exit (Invoke-CoopLoggedScript -ScriptPath $PSCommandPath -ScriptParameters @{ LogWorker = $true } -LogPrefix 'start')
}
. (Join-Path $PSScriptRoot 'lib\desktop-app.ps1')
Start-CoopDesktop -Root (Split-Path -Parent $PSScriptRoot)
exit 0
