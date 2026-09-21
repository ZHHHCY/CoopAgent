@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\casc-inspect.ps1"
if errorlevel 1 (
  echo.
  echo CASC inspection failed. Keep this window open and send the error to CoopAgent.
  pause
  exit /b 1
)
echo.
echo CASC inspection completed.
pause
