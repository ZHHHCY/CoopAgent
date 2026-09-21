$ErrorActionPreference = 'Stop'

$policyPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
$state = $null
try {
    $state = (Get-ItemProperty -Path $policyPath -Name 'VerifiedAndReputablePolicyState' -ErrorAction Stop).VerifiedAndReputablePolicyState
}
catch {
    # The value is absent on systems where Smart App Control is unavailable or inactive.
    exit 0
}

if ($state -eq 1) {
    Write-Host ''
    Write-Host 'CoopAgent cannot compile while Windows Smart App Control is On.' -ForegroundColor Red
    Write-Host 'Rust build scripts are generated locally and are unsigned, so Windows blocks them with error 4551.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Run "Open Smart App Control Settings.cmd" from the project folder,'
    Write-Host 'then choose: App & browser control > Smart App Control settings > Off.'
    Write-Host 'After changing it, run CoopAgent again.'
    Write-Host ''
    exit 1
}

exit 0
