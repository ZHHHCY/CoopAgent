@echo off
setlocal
node "%~dp0..\scripts\game-a-runtime-test.mjs" start %*
if errorlevel 1 pause
endlocal
