@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "VENV_DIR=tools\jlink_flasher\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PY%" (
  echo Creating virtual environment...
  set "BOOTSTRAP="
  py -3 -c "import sys" >nul 2>&1
  if not errorlevel 1 set "BOOTSTRAP=py -3"
  if not defined BOOTSTRAP (
    python -c "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)" >nul 2>&1
    if not errorlevel 1 set "BOOTSTRAP=python"
  )
  if not defined BOOTSTRAP (
    echo Python 3 is not installed or not on PATH.
    echo Install from https://www.python.org then run this again.
    echo SEGGER J-Link software is also required: https://www.segger.com/downloads/jlink/
    if "%~1"=="" pause
    exit /b 1
  )
  !BOOTSTRAP! -m venv "%VENV_DIR%"
  if errorlevel 1 (
    echo Failed to create virtual environment.
    if "%~1"=="" pause
    exit /b 1
  )
)

echo Installing J-Link flasher dependencies...
"%VENV_PY%" -m pip install -q -r tools\jlink_flasher\requirements.txt
if errorlevel 1 (
  echo pip install failed.
  if "%~1"=="" pause
  exit /b 1
)

"%VENV_PY%" -m tools.jlink_flasher %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%
