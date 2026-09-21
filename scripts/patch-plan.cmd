@echo off
setlocal

set "PROJECT_ROOT=%~dp0.."
if not exist "%PROJECT_ROOT%\.tools\node\node.exe" call "%~dp0bootstrap.cmd"
if errorlevel 1 exit /b %errorlevel%

cd /d "%PROJECT_ROOT%"
"%PROJECT_ROOT%\.tools\node\node.exe" "%PROJECT_ROOT%\scripts\patch-plan.mjs" %*
exit /b %errorlevel%
