@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\select-game-a-host.ps1"
if errorlevel 1 pause
endlocal
