@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
title CoopAgent

echo.
echo ========================================
echo   CoopAgent - SC2 Co-op Workbench
echo ========================================
echo.
echo Starting CoopAgent. Keep this window open.
echo.

if /i "%~1"=="--check" (
    echo CoopAgent launcher check passed.
    exit /b 0
)

call "%PROJECT_ROOT%scripts\dev.cmd"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo CoopAgent failed to start. Exit code: %EXIT_CODE%
    echo Keep the error output above for troubleshooting.
    echo.
    pause
)

exit /b %EXIT_CODE%
