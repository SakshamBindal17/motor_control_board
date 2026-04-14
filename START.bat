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

:: ── 1. Check Claude CLI is installed and signed in ───────────
echo  [1/4] Checking Claude CLI...
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Claude CLI not found on this PC.
    echo  To install it, open PowerShell and run:
    echo.
    echo    irm https://claude.ai/install.ps1 ^| iex
    echo.
    echo  Then run this file again.
    echo.
    goto :fail
)

claude -p "hi" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  WARNING: Claude CLI is not signed in.
    echo  Please open a terminal and run:
    echo.
    echo    claude
    echo.
    echo  Sign in with your browser, then run this file again.
    echo.
    goto :fail
)
echo  Claude CLI .............. OK
echo.

:: ── 2. Python venv + packages ────────────────────────────────
echo  [2/4] Checking Python environment...
if not exist "%ROOT%.venv\Scripts\activate.bat" (
    echo.
    echo  First-time setup: creating Python virtual environment...
    python -m venv "%ROOT%.venv"
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: Could not create virtual environment.
        echo  Make sure Python 3.10+ is installed: https://www.python.org/downloads/
        echo  During install, check the box: "Add Python to PATH"
        echo.
        goto :fail
    )
)

:: Always run pip install so new packages are picked up on updates
call "%ROOT%.venv\Scripts\activate.bat"
echo  Installing / verifying Python packages...
pip install -q -r "%ROOT%backend\requirements.txt"
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Python package install failed.
    echo  Check your internet connection and try again.
    echo.
    goto :fail
)
echo  Python environment ....... OK
echo.

:: ── 3. Node modules setup ────────────────────────────────────
echo  [3/4] Checking Node.js packages...
if not exist "%ROOT%frontend\node_modules\" (
    echo.
    echo  First-time setup: installing Node.js packages ^(may take 1-2 minutes^)...
    cd "%ROOT%frontend"
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: npm install failed.
        echo  Make sure Node.js is installed: https://nodejs.org/
        echo.
        cd "%ROOT%"
        goto :fail
    )
    cd "%ROOT%"
)
echo  Node.js packages ........ OK
echo.

:: ── 4. Launch servers ────────────────────────────────────────
echo  [4/4] Starting servers...
echo.

:: Write backend launcher to a temp file to avoid path-with-spaces quoting issues
set "BACK_TMP=%TEMP%\mc_backend_launch.bat"
(
    echo @echo off
    echo cd /d "%ROOT%"
    echo call "%ROOT%.venv\Scripts\activate.bat"
    echo cd "%ROOT%backend"
    echo echo.
    echo echo  Backend running on http://localhost:8000
    echo echo.
    echo uvicorn main:app --reload --port 8000
) > "%BACK_TMP%"

:: Write frontend launcher to a temp file
set "FRONT_TMP=%TEMP%\mc_frontend_launch.bat"
(
    echo @echo off
    echo cd /d "%ROOT%frontend"
    echo echo.
    echo echo  Frontend running on http://localhost:5173
    echo echo.
    echo npm run dev
) > "%FRONT_TMP%"

start "MC Designer — Backend (do not close)" cmd /k "%BACK_TMP%"
timeout /t 2 /nobreak >nul
start "MC Designer — Frontend (do not close)" cmd /k "%FRONT_TMP%"

echo  Waiting for servers to boot...
timeout /t 5 /nobreak >nul
start http://localhost:5173

echo.
echo  ==========================================
echo    Everything is running!
echo    Browser: http://localhost:5173
echo.
echo    Keep Backend + Frontend windows open.
echo    Close them to stop the servers.
echo  ==========================================
echo.
pause
exit /b 0

:fail
echo.
echo  Press any key to close...
pause >nul
exit /b 1
