@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "PLAN=%PROJECT_ROOT%docs\examples\commander-tools.patch-plan.json"
set "FIX_PLAN=%PROJECT_ROOT%docs\examples\commander-tools-vitals-fix.patch-plan.json"
set "VISUAL_PLAN=%PROJECT_ROOT%docs\examples\commander-tools-visual-fix.patch-plan.json"
set "CATALOG=%LOCALAPPDATA%\CoopAgent\database\B97579\merged\GameData"

if not exist "%CATALOG%\UnitData.xml" (
  echo Coop database was not found:
  echo %CATALOG%
  echo Run the CoopAgent database builder first.
  pause
  exit /b 1
)

echo [1/3] Checking the PatchPlan without changing Game A...
if exist "%PROJECT_ROOT%game-a\patches\example-artanis-tempest-tools.patch-plan.json" goto :check_fix
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%PLAN%" --check --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed
goto :confirm

:check_fix
if not exist "%PROJECT_ROOT%game-a\patches\example-artanis-tempest-tools-vitals-fix.patch-plan.json" (
  call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%FIX_PLAN%" --check --catalog-root "%CATALOG%"
  if errorlevel 1 goto :failed
  goto :confirm
)
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%VISUAL_PLAN%" --check --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed
goto :confirm

:confirm
echo.
echo This test will persistently add the example Artanis Tempest change to Game A.
echo Artanis Tempests will use a cloned unit with 450 life.
choice /C YN /N /M "Apply it and launch Oblivion Express? [Y/N] "
if errorlevel 2 exit /b 0

echo [2/3] Applying the checked PatchPlan...
if exist "%PROJECT_ROOT%game-a\patches\example-artanis-tempest-tools.patch-plan.json" goto :apply_fix
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%PLAN%" --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed

:apply_fix
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%FIX_PLAN%" --check --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%FIX_PLAN%" --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%VISUAL_PLAN%" --check --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed
call "%PROJECT_ROOT%scripts\patch-plan.cmd" "%VISUAL_PLAN%" --catalog-root "%CATALOG%"
if errorlevel 1 goto :failed

echo [3/3] Building and launching Game A...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%game-a\scripts\launch-game-a.ps1"
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo Commander tool test failed. Keep the output above for troubleshooting.
pause
exit /b 1
