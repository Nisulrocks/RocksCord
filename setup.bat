@echo off
REM ===========================================================================
REM  RocksCord - one-time setup
REM
REM  Installs dependencies, creates .env, applies migrations, seeds demo data.
REM  Safe to run again at any time.
REM ===========================================================================
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install Node 20 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

call npm run setup
if errorlevel 1 (
  echo.
  echo   Setup failed. Scroll up for the error.
  echo.
  pause
  exit /b 1
)

echo.
echo   Setup finished. Run run.bat to start RocksCord.
echo.
pause
