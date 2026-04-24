@echo off
setlocal EnableDelayedExpansion

:: Always run from the folder this .bat file lives in
cd /d "%~dp0"
set "ROOT=%~dp0"

title MC Hardware Designer — Launcher

echo.
echo  ==========================================
echo    MC Hardware Designer  ^|  Starting Up
echo  ==========================================
echo.

:: ── NOTE on .venv ─────────────────────────────────────────────
::  .venv is always created next to this script (same folder).
::  Works in this worktree now. After merge to main, works there
::  too — no path changes needed on any machine.
::  To force clean reinstall: delete .venv folder, run again.
:: ─────────────────────────────────────────────────────────────

:: ── 1. Python version + venv + packages ──────────────────────
echo  [1/3] Checking Python environment...

:: Try python3 first, then python, then py launcher
set "PY_CMD="
where python3 >nul 2>&1
if !errorlevel! equ 0 set "PY_CMD=python3"
if "!PY_CMD!"=="" where python >nul 2>&1
if "!PY_CMD!"=="" if !errorlevel! equ 0 set "PY_CMD=python"
if "!PY_CMD!"=="" where py >nul 2>&1
if "!PY_CMD!"=="" if !errorlevel! equ 0 set "PY_CMD=py"
if "!PY_CMD!"=="" (
    echo.
    echo  ERROR: Python not found on this PC.
    echo  Download Python 3.10+ from: https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe
    echo  During install, check the box: "Add Python to PATH"
    echo.
    goto :fail
)

:: Verify Python version is 3.10 or newer
for /f "tokens=2 delims= " %%v in ('"!PY_CMD!" --version 2^>^&1') do set "PY_VER=%%v"
for /f "tokens=1,2 delims=." %%a in ("!PY_VER!") do (
    set "PY_MAJOR=%%a"
    set "PY_MINOR=%%b"
)
if !PY_MAJOR! LSS 3 goto :py_old
if !PY_MAJOR! EQU 3 if !PY_MINOR! LSS 10 goto :py_old
goto :py_ok
:py_old
echo.
echo  ERROR: Python 3.10+ required, but found Python !PY_VER!
echo  Download the latest version: https://www.python.org/downloads/
echo.
goto :fail
:py_ok

:: Early file existence checks — catch incomplete project copies
if not exist "%ROOT%backend\requirements.txt" (
    echo.
    echo  ERROR: backend\requirements.txt not found.
    echo  Make sure you have the complete project files.
    echo.
    goto :fail
)
if not exist "%ROOT%frontend\package.json" (
    echo.
    echo  ERROR: frontend\package.json not found.
    echo  Make sure you have the complete project files.
    echo.
    goto :fail
)

if not exist "%ROOT%.venv\Scripts\activate.bat" (
    echo.
    echo  First-time setup: creating Python virtual environment...
    "!PY_CMD!" -m venv "%ROOT%.venv"
    if !errorlevel! neq 0 (
        echo.
        echo  ERROR: Could not create virtual environment.
        echo  Make sure Python 3.10+ is installed with "Add Python to PATH" ticked.
        echo.
        goto :fail
    )
)

:: Venv health probe — activate.bat existing does not guarantee venv is usable
"%ROOT%.venv\Scripts\python.exe" -c "import sys" >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo  WARNING: Virtual environment is corrupted. Recreating...
    rmdir /s /q "%ROOT%.venv"
    "!PY_CMD!" -m venv "%ROOT%.venv"
    if !errorlevel! neq 0 (
        echo.
        echo  ERROR: Could not recreate virtual environment.
        echo.
        goto :fail
    )
)

:: Always run pip install so new packages are picked up on updates
call "%ROOT%.venv\Scripts\activate.bat"
echo  Installing / verifying Python packages...
"%ROOT%.venv\Scripts\python.exe" -m pip install -r "%ROOT%backend\requirements.txt"
if !errorlevel! neq 0 (
    echo.
    echo  ERROR: Python package install failed.
    echo  Check the output above to see which package failed.
    echo  Check your internet connection and try again.
    echo.
    goto :fail
)
echo  Python environment ....... OK
echo.

:: ── 2. Node modules setup ────────────────────────────────────
echo  [2/3] Checking Node.js packages...

:: Check Node.js is installed
where node >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo  ERROR: Node.js not found on this PC.
    echo  Download Node.js LTS from: https://nodejs.org/dist/v24.15.0/node-v24.15.0-x64.msi
    echo  During install, check the box: "Add to PATH"
    echo.
    goto :fail
)
where npm >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo  ERROR: npm not found. Reinstall Node.js from: https://nodejs.org/dist/v24.15.0/node-v24.15.0-x64.msi
    echo.
    goto :fail
)
for /f "tokens=1 delims=." %%a in ('node --version 2^>^&1') do set "NODE_VER_RAW=%%a"
set "NODE_MAJOR=!NODE_VER_RAW:~1!"
if !NODE_MAJOR! LSS 18 (
    echo.
    echo  ERROR: Node.js 18+ required, but found !NODE_VER_RAW!
    echo  Download Node.js LTS from: https://nodejs.org/dist/v24.15.0/node-v24.15.0-x64.msi
    echo.
    goto :fail
)

:: Determine if install is needed
set "NEED_NPM=0"
set "CORRUPTED=0"
if not exist "%ROOT%frontend\node_modules\" set "NEED_NPM=1"
if exist "%ROOT%frontend\node_modules\" (
    if not exist "%ROOT%frontend\node_modules\.package-lock.json" (
        echo.
        echo  WARNING: node_modules is corrupted ^(incomplete install^). Reinstalling...
        set "NEED_NPM=1"
        set "CORRUPTED=1"
    )
)

if !NEED_NPM! equ 1 (
    echo.
    echo  Installing Node.js packages ^(may take 1-2 minutes^)...
    set "NPM_ERR=0"
    pushd "%ROOT%frontend"
    if exist "package-lock.json" (
        if exist "node_modules" rmdir /s /q "node_modules"
        call npm ci
        set "NPM_ERR=!errorlevel!"
        if !NPM_ERR! neq 0 (
            echo  npm ci failed with code !NPM_ERR!. Retrying with npm install...
            call npm install --no-audit --no-fund
            set "NPM_ERR=!errorlevel!"
        )
    ) else (
        echo  No package-lock.json found. Using npm install to generate one...
        if !CORRUPTED! equ 1 rmdir /s /q "node_modules"
        call npm install --no-audit --no-fund
        set "NPM_ERR=!errorlevel!"
    )
    popd
    if !NPM_ERR! neq 0 (
        echo.
        echo  ERROR: npm dependency install failed ^(exit code: !NPM_ERR!^).
        echo  Check the output above for details.
        echo  Make sure you have internet access.
        echo.
        goto :fail
    )
)
echo  Node.js packages ........ OK
echo.

:: ── 3. Single-instance guard — check if ports already in use ──
set "PORT_CONFLICT="
netstat -ano | findstr "LISTENING" | findstr ":8472" >nul 2>&1
if !errorlevel! equ 0 set "PORT_CONFLICT=8472"
netstat -ano | findstr "LISTENING" | findstr ":5742" >nul 2>&1
if !errorlevel! equ 0 (
    if "!PORT_CONFLICT!"=="" (
        set "PORT_CONFLICT=5742"
    ) else (
        set "PORT_CONFLICT=!PORT_CONFLICT! and 5742"
    )
)
if not "!PORT_CONFLICT!"=="" (
    echo.
    echo  WARNING: Port^(s^) !PORT_CONFLICT! already in use.
    echo  App may already be running. Close existing terminals first.
    echo.
    echo  Press any key to launch anyway, or Ctrl+C to cancel...
    pause >nul
    echo.
)

:: ── 4. Launch servers ─────────────────────────────────────────
echo  [3/3] Starting servers...
echo.

:: Strip trailing backslash from ROOT to avoid \" quote-escape bug in temp bats
set "R=%ROOT:~0,-1%"

:: Write backend launcher next to this script
set "BACK_TMP=%ROOT%_backend_launch.bat"
(
    echo @echo off
    echo cd /d "%R%"
    echo call "%R%\.venv\Scripts\activate.bat"
    echo cd "%R%\backend"
    echo echo.
    echo echo  ==========================================
    echo echo    MC Designer Backend - http://localhost:8472
    echo echo    Logs appear here when PDFs are uploaded.
    echo echo  ==========================================
    echo echo.
    echo python -m uvicorn main:app --reload --port 8472 --log-level info
) > "%BACK_TMP%"

:: Write frontend launcher next to this script
set "FRONT_TMP=%ROOT%_frontend_launch.bat"
(
    echo @echo off
    echo cd /d "%R%\frontend"
    echo echo.
    echo echo  Frontend running - http://localhost:5742
    echo echo.
    echo npm run dev
) > "%FRONT_TMP%"

if not exist "%BACK_TMP%" (
    echo.
    echo  ERROR: Could not write backend launcher. Check folder permissions or antivirus.
    echo.
    goto :fail
)
if not exist "%FRONT_TMP%" (
    echo.
    echo  ERROR: Could not write frontend launcher. Check folder permissions or antivirus.
    echo.
    goto :fail
)

start "MC Designer Backend (do not close)" cmd /k "%BACK_TMP%"
timeout /t 2 /nobreak >nul
start "MC Designer Frontend (do not close)" cmd /k "%FRONT_TMP%"

:: ── 5. Backend readiness poll — wait for uvicorn to be ready ──
echo  Waiting for backend to start ^(Application startup complete^)...
where curl >nul 2>&1
if !errorlevel! neq 0 goto :no_curl

set "CURL_TRIES=0"
:curl_loop
set /a CURL_TRIES+=1
curl -s --max-time 2 http://localhost:8472 >nul 2>&1
if !errorlevel! equ 0 goto :backend_ready
if !CURL_TRIES! geq 15 goto :backend_timeout
timeout /t 2 /nobreak >nul
goto :curl_loop

:no_curl
timeout /t 8 /nobreak >nul
goto :backend_ready

:backend_timeout
echo.
echo  WARNING: Backend did not respond in 30s.
echo  Open http://localhost:5742 manually once the backend window shows startup complete.
echo.

:backend_ready
start http://localhost:5742

:: ── 6. Cleanup temp bat files ─────────────────────────────────
timeout /t 2 /nobreak >nul
del "%BACK_TMP%" >nul 2>&1
del "%FRONT_TMP%" >nul 2>&1

echo.
echo  ==========================================
echo    Everything is running!
echo    Browser: http://localhost:5742
echo.
echo    Two new terminal windows should be open:
echo    - MC Designer Backend
echo    - MC Designer Frontend
echo    Keep them open. Close to stop servers.
echo  ==========================================
echo.
echo  Press any key to close THIS launcher window.
echo  Backend and Frontend will keep running.
echo.
pause
exit /b 0

:fail
echo.
echo  Press any key to close...
pause >nul
exit /b 1
