@echo off
setlocal

set "PROJECT_ROOT=%~dp0.."
if not exist "%PROJECT_ROOT%\.tools\node\node.exe" (
    echo Bundled Node.js is missing. Run scripts\bootstrap.cmd first. 1>&2
    exit /b 1
)

"%PROJECT_ROOT%\.tools\node\node.exe" "%PROJECT_ROOT%\runtime\coop-mcp\server.mjs"
exit /b %errorlevel%
