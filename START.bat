@echo off
setlocal EnableDelayedExpansion
title MC Hardware Designer — Launcher

echo.
echo  ==========================================
echo    MC Hardware Designer  ^|  Starting Up
echo  ==========================================
echo.

:: ── 1. Check Claude CLI is installed ─────────────────────────
echo  [1/4] Checking Claude CLI...
where claude >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Claude CLI not found on this PC.
    echo  To install it, open PowerShell and run:
    echo.
    echo    irm https://claude.ai/install.ps1 ^| iex
    echo.
    echo  Then run this file again.
    echo.
    pause
    exit /b 1
)
echo  Claude CLI .............. OK
echo  NOTE: Make sure you have signed in to Claude CLI at least once.
echo  If PDF upload fails, open a terminal and run: claude

:: ── 2. Python venv setup ─────────────────────────────────────
echo  [2/4] Checking Python environment...
if not exist ".venv\" (
    echo.
    echo  First-time setup: creating Python virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo.
        echo  ERROR: Could not create virtual environment.
        echo  Make sure Python 3.10+ is installed: https://www.python.org/downloads/
        echo.
        pause
        exit /b 1
    )

    echo  Installing Python packages (may take 1-2 minutes)...
    call .venv\Scripts\activate.bat
    pip install --quiet -r backend\requirements.txt
    if errorlevel 1 (
        echo.
        echo  ERROR: Python package install failed.
        echo  Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo  Python packages installed successfully.
    echo.
) else (
    echo  Python environment ....... OK ^(skipping install^)
)

:: ── 3. Node modules setup ────────────────────────────────────
echo  [3/4] Checking Node.js packages...
if not exist "frontend\node_modules\" (
    echo.
    echo  First-time setup: installing Node.js packages (may take 1-2 minutes)...
    cd frontend
    npm install --silent
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed.
        echo  Make sure Node.js is installed: https://nodejs.org/
        echo.
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo  Node.js packages installed successfully.
    echo.
) else (
    echo  Node.js packages ........ OK ^(skipping install^)
)

:: ── 4. Launch servers ────────────────────────────────────────
echo  [4/4] Starting servers...
echo.

:: Start backend in a new terminal window
start "MC Designer — Backend (do not close)" cmd /k ^
  "cd /d %~dp0 && call .venv\Scripts\activate.bat && cd backend && echo. && echo  Backend running on http://localhost:8000 && echo. && uvicorn main:app --reload --port 8000"

:: Short pause then start frontend in another new terminal window
timeout /t 2 /nobreak >nul
start "MC Designer — Frontend (do not close)" cmd /k ^
  "cd /d %~dp0\frontend && echo. && echo  Frontend running on http://localhost:5173 && echo. && npm run dev"

:: Wait for servers to boot then open browser
echo  Waiting for servers to boot...
timeout /t 5 /nobreak >nul
start http://localhost:5173

echo.
echo  ==========================================
echo    Everything is running!
echo    Browser opened: http://localhost:5173
echo.
echo    Keep the Backend and Frontend windows
echo    open while you use the app.
echo    Close them to shut down the servers.
echo  ==========================================
echo.
pause
