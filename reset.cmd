@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
set "NO_PAUSE="
set "RESET_ARGS="
set "CHECK_ONLY="
title CoopAgent 环境重置

:parse
if "%~1"=="" goto :run
if /i "%~1"=="--check" (set "RESET_ARGS=%RESET_ARGS% -Check"& set "NO_PAUSE=1"& set "CHECK_ONLY=1"& shift& goto :parse)
if /i "%~1"=="--yes" (set "RESET_ARGS=%RESET_ARGS% -Yes"& set "NO_PAUSE=1"& shift& goto :parse)
if /i "%~1"=="-DeleteProjects" (set "RESET_ARGS=%RESET_ARGS% -DeleteProjects"& shift& goto :parse)
if /i "%~1"=="-ClearSharedData" (set "RESET_ARGS=%RESET_ARGS% -ClearSharedData"& shift& goto :parse)
echo 参数不支持。可用：--check、--yes、-DeleteProjects、-ClearSharedData。
exit /b 1

:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\reset-environment.ps1" %RESET_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo CoopAgent 环境重置失败，退出代码：%EXIT_CODE%。
    echo 请关闭 CoopAgent、编辑器和占用仓库文件的终端后重试。
    if not defined NO_PAUSE pause
    exit /b %EXIT_CODE%
)

echo.
if defined CHECK_ONLY (echo 以上仅为检查结果，未删除任何文件。) else (echo CoopAgent 已恢复到可重新运行 setup.cmd 的状态。)
if not defined NO_PAUSE pause
exit /b 0
