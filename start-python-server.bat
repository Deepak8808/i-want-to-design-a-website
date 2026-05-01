@echo off
setlocal
cd /d "%~dp0"

set "BUNDLED_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
set "LOCAL_PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"

if exist "%BUNDLED_PY%" (
  "%BUNDLED_PY%" server.py
  exit /b %ERRORLEVEL%
)

if exist "%LOCAL_PY%" (
  "%LOCAL_PY%" server.py
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python server.py
  exit /b %ERRORLEVEL%
)

echo Python was not found. Install Python 3.10+ or run with a full python.exe path.
pause
exit /b 1
