@echo off
setlocal

set "PROJECT_ROOT=%~dp0.."
if not exist "%PROJECT_ROOT%\.tools\opencode\bin\opencode.exe" call "%~dp0bootstrap.cmd"
if errorlevel 1 exit /b %errorlevel%

set "PATH=%PROJECT_ROOT%\.tools\node;%PATH%"
cd /d "%PROJECT_ROOT%"
"%PROJECT_ROOT%\.tools\opencode\bin\opencode.exe" %*
exit /b %errorlevel%
