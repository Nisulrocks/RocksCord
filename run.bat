@echo off
REM ===========================================================================
REM  RocksCord - start the app in development mode
REM
REM  Runs the API (port 4000) and the web client (port 5173) together.
REM  Open http://localhost:5173 once both have started.
REM ===========================================================================
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo.
  echo   Dependencies are not installed yet. Running setup first...
  echo.
  call npm run setup
)

echo.
echo   Starting RocksCord...
echo   Web client:  http://localhost:5173
echo   API server:  http://localhost:4000
echo.
echo   Press Ctrl+C to stop.
echo.

call npm run dev
