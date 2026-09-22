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
    Write-Host 'Windows 智能应用控制开启时，CoopAgent 无法完成编译。' -ForegroundColor Red
    Write-Host 'Rust 构建脚本由本机生成且没有签名，因此 Windows 会以错误 4551 阻止它们。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '请在项目目录运行 "scripts\open-smart-app-control-settings.cmd"，'
    Write-Host '然后选择：应用和浏览器控制 > 智能应用控制设置 > 关闭。'
    Write-Host '更改后重新运行 CoopAgent。'
    Write-Host ''
    exit 1
}

exit 0
