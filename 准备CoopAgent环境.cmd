@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
title CoopAgent Environment Setup

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\prepare-coopagent.ps1" %*
if errorlevel 1 goto :failed

echo.
echo CoopAgent environment setup completed.
pause
exit /b 0

:failed
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo CoopAgent environment setup failed with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
