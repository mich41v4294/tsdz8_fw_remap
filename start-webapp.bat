@echo off
setlocal
cd /d "%~dp0webapp"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install the LTS build from https://nodejs.org then run this again.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm is not on PATH. Reinstall Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo Opening http://localhost:5173
start "" "http://localhost:5173"
echo Starting the patcher. Leave this window open. Close it to stop the server.
call npm run dev
if errorlevel 1 pause
