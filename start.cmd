@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
title CoopAgent

echo.
echo ========================================
echo   CoopAgent - SC2 合作模式工作台
echo ========================================
echo.
echo 正在启动 CoopAgent。首次启动会构建桌面程序，请稍候。
echo.

if /i "%~1"=="--check" (
    echo CoopAgent 启动器检查通过。
    exit /b 0
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\start-coopagent.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo CoopAgent 启动失败，退出代码：%EXIT_CODE%
    echo 日志保存在 .coopagent\logs\start-*.log。
    echo.
    pause
)

exit /b %EXIT_CODE%
