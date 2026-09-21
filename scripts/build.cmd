@echo off
setlocal

set "PROJECT_ROOT=%~dp0.."
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-smart-app-control.ps1"
if errorlevel 1 exit /b %errorlevel%

if not exist "%PROJECT_ROOT%\.tools\node\node.exe" call "%~dp0bootstrap.cmd"
if errorlevel 1 exit /b %errorlevel%

set "CARGO_HOME=%PROJECT_ROOT%\.tools\cargo"
set "RUSTUP_HOME=%PROJECT_ROOT%\.tools\rustup"
set "PATH=%CARGO_HOME%\bin;%PROJECT_ROOT%\.tools\node;%PROJECT_ROOT%\.tools\pnpm\node_modules\.bin;%PATH%"
cd /d "%PROJECT_ROOT%"
call "%PROJECT_ROOT%\.tools\pnpm\node_modules\.bin\pnpm.cmd" tauri build %*
exit /b %errorlevel%
