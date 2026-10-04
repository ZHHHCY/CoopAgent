@echo off
chcp 65001 >nul
setlocal
set "PROJECT_ROOT=%~dp0"
if /i "%~1"=="--check" (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\prepare-portable.ps1" -Check
    if errorlevel 1 exit /b 1
    exit /b 0
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\prepare-portable.ps1" %*
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
