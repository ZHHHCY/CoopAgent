[CmdletBinding()]
param([string]$StarCraftRoot, [switch]$Check, [switch]$LogWorker)

$ErrorActionPreference = 'Stop'
if (-not $LogWorker -and -not $Check) {
    . (Join-Path $PSScriptRoot 'lib\process-log.ps1')
    $parameters = @{ LogWorker = $true }
    if ($StarCraftRoot) { $parameters.StarCraftRoot = $StarCraftRoot }
    exit (Invoke-CoopLoggedScript -ScriptPath $PSCommandPath -ScriptParameters $parameters -LogPrefix 'setup')
}

$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root '.tools\node\node.exe'
$python = Join-Path $root '.tools\python\python.exe'
$opencode = Join-Path $root '.tools\opencode\bin\opencode.exe'
$casc = Join-Path $root '.tools\CascLib\build-coopagent\Release\CascLib.dll'
foreach ($file in @((Join-Path $root 'portable.json'), (Join-Path $root 'CoopAgent.exe'), $node, $python, $opencode, $casc, (Join-Path $root 'runtime\coop-mcp\server.mjs'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "便携包不完整，缺少：$file。请重新解压完整 ZIP。" }
}
$env:Path = "$(Join-Path $root '.tools\python');$(Join-Path $root '.tools\node');$env:Path"
& $python -c 'import ctypes, json, pathlib, zipfile'
if ($LASTEXITCODE -ne 0) { throw '内置 Python 无法运行。' }
& $python -c 'import ctypes, sys; ctypes.CDLL(sys.argv[1])' $casc
if ($LASTEXITCODE -ne 0) { throw '内置 CASCLib 无法加载。' }
& $opencode --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw '内置 OpenCode 无法运行。' }
Push-Location $root
try { & $node --input-type=module -e "import('@xmldom/xmldom')" }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw '便携包的 JavaScript 依赖不完整。' }
Push-Location (Join-Path $root 'runtime\coop-mcp')
try { & $node --input-type=module -e "import('@modelcontextprotocol/sdk/server/index.js')" }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw '便携包的 MCP 依赖不完整。' }
if ($Check) { Write-Host '便携包完整性检查通过。'; exit 0 }

$mutex = [Threading.Mutex]::new($false, 'Local\CoopAgent.Setup')
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw '另一个 CoopAgent 环境准备进程正在运行。' }
    $gameRoot = & (Join-Path $PSScriptRoot 'configure-sc2.ps1') -StarCraftRoot $StarCraftRoot
    if (-not $gameRoot) { throw '尚未选择 StarCraft II 安装目录。' }
    $previousRoot = $env:COOPAGENT_SC2_ROOT
    try {
        $env:COOPAGENT_SC2_ROOT = $gameRoot
        $extraction = @(& (Join-Path $PSScriptRoot 'casc-inspect.ps1') -StarCraftRoot $gameRoot -NoOpen | ForEach-Object { Write-Host $_; $_ })
        $cascRoot = [string]$extraction[-1]
        if (-not (Test-Path -LiteralPath (Join-Path $cascRoot 'manifest.json') -PathType Leaf)) { throw 'CASC 准备过程没有返回完整的提取结果。' }
        & (Join-Path $PSScriptRoot 'casc-database.cmd') build --casc-root $cascRoot
        if ($LASTEXITCODE -ne 0) { throw "数据库准备失败（退出代码 $LASTEXITCODE）。" }
    }
    finally { $env:COOPAGENT_SC2_ROOT = $previousRoot }
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
