@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify-game-a.ps1"
set "VERIFY_EXIT=%ERRORLEVEL%"
echo.
if "%VERIFY_EXIT%"=="0" (
    echo Game A stable-baseline verification PASSED.
) else (
    echo Game A stable-baseline verification FAILED with exit code %VERIFY_EXIT%.
)
echo.
pause
endlocal & exit /b %VERIFY_EXIT%
