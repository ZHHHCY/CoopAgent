[CmdletBinding()]
param([string]$StarCraftRoot, [switch]$LogWorker)

$ErrorActionPreference = 'Stop'
if (-not $LogWorker) {
    . (Join-Path $PSScriptRoot 'lib\process-log.ps1')
    $workerParameters = @{ LogWorker = $true }
    if ($StarCraftRoot) { $workerParameters.StarCraftRoot = $StarCraftRoot }
    exit (Invoke-CoopLoggedScript -ScriptPath $PSCommandPath -ScriptParameters $workerParameters -LogPrefix 'setup')
}

$setupMutex = [Threading.Mutex]::new($false, 'Local\CoopAgent.Setup')
$mutexAcquired = $false
try {
    try { $mutexAcquired = $setupMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
    if (-not $mutexAcquired) { throw '另一个 CoopAgent 环境准备进程正在运行，请等待它结束后再试。' }

    . (Join-Path $PSScriptRoot 'lib\setup-prerequisites.ps1')
    Assert-CoopSetupPrerequisites

    $root = & (Join-Path $PSScriptRoot 'configure-sc2.ps1') -StarCraftRoot $StarCraftRoot
    if (-not $root) { throw '尚未选择 StarCraft II 安装目录。' }
    $previousRoot = $env:COOPAGENT_SC2_ROOT
    try {
        $env:COOPAGENT_SC2_ROOT = $root
        & (Join-Path $PSScriptRoot 'bootstrap.cmd')
        if ($LASTEXITCODE -ne 0) { throw "工具链准备失败（退出代码 $LASTEXITCODE）。" }

        # The final output line identifies this extraction, not another cached build.
        $extraction = @(& (Join-Path $PSScriptRoot 'casc-inspect.ps1') -StarCraftRoot $root -NoOpen | ForEach-Object { Write-Host $_; $_ })
        $cascRoot = [string]$extraction[-1]
        if (-not (Test-Path -LiteralPath (Join-Path $cascRoot 'manifest.json') -PathType Leaf)) {
            throw 'CASC 准备过程没有返回完整的提取结果。'
        }
        & (Join-Path $PSScriptRoot 'casc-database.cmd') build --casc-root $cascRoot
        if ($LASTEXITCODE -ne 0) { throw "数据库准备失败（退出代码 $LASTEXITCODE）。" }
    }
    finally { $env:COOPAGENT_SC2_ROOT = $previousRoot }
}
finally {
    if ($mutexAcquired) { $setupMutex.ReleaseMutex() }
    $setupMutex.Dispose()
}
