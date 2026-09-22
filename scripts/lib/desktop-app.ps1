function Start-CoopDesktop {
    param([Parameter(Mandatory = $true)][string]$Root)
    $Root = [IO.Path]::GetFullPath($Root)
    $executable = Join-Path $Root 'src-tauri\target\release\coopagent.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        Write-Host '首次启动：正在构建桌面程序，完成后自动打开。'
        & (Join-Path $Root 'scripts\build.cmd')
        if ($LASTEXITCODE -ne 0) { throw "桌面程序构建失败，退出代码：$LASTEXITCODE。修复后重新运行 start.cmd 即可。" }
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "构建未生成桌面程序：$executable" }
    }
    # Keep the launcher independent of the app lifetime and of console pipes.
    # CoopAgent is an interactive desktop window and intentionally opens visibly.
    Start-Process -FilePath $executable -WorkingDirectory $Root -ErrorAction Stop | Out-Null
    Write-Host 'CoopAgent 已启动，启动窗口可以关闭。'
    Write-Host '更新源码后请运行 scripts\build.cmd 重新构建；开发调试使用 scripts\dev.cmd。'
}
