@echo off
setlocal
cd /d "%~dp0webapp"
set PORT=8080

where py >nul 2>&1
if not errorlevel 1 (
  set PY=py -3
  goto serve
)
where python >nul 2>&1
if not errorlevel 1 (
  set PY=python
  goto serve
)

echo Python 3 is not installed or not on PATH.
echo Install it from https://www.python.org then run this again.
pause
exit /b 1

:serve
echo Opening http://localhost:%PORT%
start "" "http://localhost:%PORT%"
echo Starting the patcher. Leave this window open. Close it to stop the server.
%PY% serve.py
if errorlevel 1 pause
