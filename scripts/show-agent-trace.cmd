@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0show-agent-trace.ps1" %*
echo.
pause
