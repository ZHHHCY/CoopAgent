@echo off
setlocal

call "%~dp0scripts\casc-database.cmd" build
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo CoopAgent database build completed.
) else (
  echo CoopAgent database build failed with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
