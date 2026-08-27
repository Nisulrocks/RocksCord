@echo off
REM ===========================================================================
REM  RocksCord - build the Windows executable
REM
REM  Produces, in apps\desktop\release\:
REM    RocksCord.exe          portable, no install needed
REM    RocksCord-Setup-1.0.0.exe    normal installer
REM
REM  Takes a few minutes the first time (it downloads the Electron runtime).
REM ===========================================================================
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo   Dependencies are not installed yet. Running setup first...
  call npm run setup
)

echo.
echo   Building the Windows executable...
echo.

call npm run build:exe
if errorlevel 1 (
  echo.
  echo   Build failed. Scroll up for the error.
  echo.
  pause
  exit /b 1
)

echo.
echo   Done. Your executable is at:
echo     %~dp0apps\desktop\release\RocksCord.exe
echo.
pause
