@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
title CoopAgent 环境准备

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\prepare-coopagent.ps1" %*
if errorlevel 1 goto :failed

echo.
echo CoopAgent 环境准备完成。
pause
exit /b 0

:failed
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo CoopAgent 环境准备失败，退出代码：%EXIT_CODE%。
pause
exit /b %EXIT_CODE%
