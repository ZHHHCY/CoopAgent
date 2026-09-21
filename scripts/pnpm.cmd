@echo off
setlocal

set "PROJECT_ROOT=%~dp0.."
if not exist "%PROJECT_ROOT%\.tools\node\node.exe" goto :prepare
if not exist "%PROJECT_ROOT%\.tools\pnpm\node_modules\.bin\pnpm.cmd" goto :prepare
goto :prepared

:prepare
call "%~dp0bootstrap.cmd"
if errorlevel 1 exit /b %errorlevel%

:prepared
set "CARGO_HOME=%PROJECT_ROOT%\.tools\cargo"
set "RUSTUP_HOME=%PROJECT_ROOT%\.tools\rustup"
set "PATH=%CARGO_HOME%\bin;%PROJECT_ROOT%\.tools\node;%PROJECT_ROOT%\.tools\pnpm\node_modules\.bin;%PATH%"
cd /d "%PROJECT_ROOT%"
call "%PROJECT_ROOT%\.tools\pnpm\node_modules\.bin\pnpm.cmd" %*
exit /b %errorlevel%
