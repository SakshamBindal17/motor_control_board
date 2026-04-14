#!/bin/bash
# MC Hardware Designer — Launcher (Linux)
# Run with: bash START.sh
# Or make executable once with: chmod +x START.sh  then double-click

# Get the folder where this script lives
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

clear
echo ""
echo " =========================================="
echo "   MC Hardware Designer  |  Starting Up"
echo " =========================================="
echo ""

# ── 1. Check Claude CLI ──────────────────────────────────────
echo " [1/4] Checking Claude CLI..."
if ! command -v claude &>/dev/null; then
    echo ""
    echo " ERROR: Claude CLI not found on this system."
    echo " To install it, open a terminal and run:"
    echo ""
    echo "   curl -fsSL https://claude.ai/install.sh | bash"
    echo ""
    echo " Then run this file again."
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi

if ! claude -p "hi" &>/dev/null 2>&1; then
    echo ""
    echo " WARNING: Claude CLI is not signed in."
    echo " Please open a terminal and run:"
    echo ""
    echo "   claude"
    echo ""
    echo " Sign in with your browser, then run this file again."
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi
echo " Claude CLI .............. OK"

# ── 2. Python venv setup ─────────────────────────────────────
echo " [2/4] Checking Python environment..."
if [ ! -d ".venv" ]; then
    echo ""
    echo " First-time setup: creating Python virtual environment..."
    python3 -m venv .venv
    if [ $? -ne 0 ]; then
        echo ""
        echo " ERROR: Could not create virtual environment."
        echo " Make sure Python 3.10+ is installed: https://www.python.org/downloads/"
        echo ""
        read -rp " Press Enter to exit..." && exit 1
    fi

    echo " Installing Python packages (may take 1-2 minutes)..."
    source .venv/bin/activate
    pip install --quiet -r backend/requirements.txt
    if [ $? -ne 0 ]; then
        echo ""
        echo " ERROR: Python package install failed."
        echo " Check your internet connection and try again."
        echo ""
        read -rp " Press Enter to exit..." && exit 1
    fi
    echo " Python packages installed successfully."
    echo ""
else
    echo " Python environment ....... OK (skipping install)"
fi

# ── 3. Node modules setup ────────────────────────────────────
echo " [3/4] Checking Node.js packages..."
if [ ! -d "frontend/node_modules" ]; then
    echo ""
    echo " First-time setup: installing Node.js packages (may take 1-2 minutes)..."
    cd frontend
    npm install --silent
    if [ $? -ne 0 ]; then
        echo ""
        echo " ERROR: npm install failed."
        echo " Make sure Node.js is installed: https://nodejs.org/"
        echo ""
        cd ..
        read -rp " Press Enter to exit..." && exit 1
    fi
    cd ..
    echo " Node.js packages installed successfully."
    echo ""
else
    echo " Node.js packages ........ OK (skipping install)"
fi

# ── 4. Launch servers ────────────────────────────────────────
echo " [4/4] Starting servers..."
echo ""

# Detect available terminal emulator
open_terminal() {
    local title="$1"
    local cmd="$2"
    if command -v gnome-terminal &>/dev/null; then
        gnome-terminal --title="$title" -- bash -c "$cmd; exec bash"
    elif command -v xterm &>/dev/null; then
        xterm -title "$title" -e bash -c "$cmd; exec bash" &
    elif command -v konsole &>/dev/null; then
        konsole --title "$title" -e bash -c "$cmd; exec bash" &
    else
        # Fallback: run in background, log to file
        echo " (No GUI terminal found — running in background)"
        bash -c "$cmd" > "${DIR}/logs_${title// /_}.log" 2>&1 &
    fi
}

# Start backend
open_terminal "MC Designer — Backend" \
    "echo '' && echo ' MC Designer — Backend (do not close)' && echo '' && cd '$DIR' && source .venv/bin/activate && cd backend && uvicorn main:app --reload --port 8000"

sleep 2

# Start frontend
open_terminal "MC Designer — Frontend" \
    "echo '' && echo ' MC Designer — Frontend (do not close)' && echo '' && cd '$DIR/frontend' && npm run dev"

# Wait then open browser
echo " Waiting for servers to boot..."
sleep 5

# Detect browser open command
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:5173
elif command -v sensible-browser &>/dev/null; then
    sensible-browser http://localhost:5173
fi

echo ""
echo " =========================================="
echo "   Everything is running!"
echo "   Browser opened: http://localhost:5173"
echo ""
echo "   Keep the Backend and Frontend terminals"
echo "   open while you use the app."
echo "   Close them to shut down the servers."
echo " =========================================="
echo ""
