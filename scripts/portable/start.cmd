@echo off
chcp 65001 >nul
setlocal
set "PROJECT_ROOT=%~dp0"
if /i "%~1"=="--check" (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\prepare-portable.ps1" -Check
    if errorlevel 1 exit /b 1
    exit /b 0
)
if not exist "%PROJECT_ROOT%CoopAgent.exe" (
    echo 便携包缺少 CoopAgent.exe，请重新解压完整 ZIP。
    exit /b 1
)
cd /d "%PROJECT_ROOT%"
start "" "%PROJECT_ROOT%CoopAgent.exe"
exit /b %errorlevel%
