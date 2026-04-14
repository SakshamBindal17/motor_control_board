#!/bin/bash
# MC Hardware Designer — Launcher (macOS)
# Double-click this file to start the app.
# First time: right-click → Open (to bypass Gatekeeper)

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
    echo " ERROR: Claude CLI not found on this Mac."
    echo " To install it, open Terminal and run:"
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
    echo " Please open Terminal and run:"
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

# Start backend in a new Terminal window
osascript <<EOF
tell application "Terminal"
    set backendWin to do script "echo '' && echo ' MC Designer — Backend (do not close)' && echo '' && cd '$DIR' && source .venv/bin/activate && cd backend && uvicorn main:app --reload --port 8000"
    set custom title of front window to "MC Designer — Backend"
end tell
EOF

# Short pause then start frontend in another Terminal window
sleep 2
osascript <<EOF
tell application "Terminal"
    set frontendWin to do script "echo '' && echo ' MC Designer — Frontend (do not close)' && echo '' && cd '$DIR/frontend' && npm run dev"
    set custom title of front window to "MC Designer — Frontend"
end tell
EOF

# Wait for servers to boot then open browser
echo " Waiting for servers to boot..."
sleep 5
open http://localhost:5173

echo ""
echo " =========================================="
echo "   Everything is running!"
echo "   Browser opened: http://localhost:5173"
echo ""
echo "   Keep the Backend and Frontend windows"
echo "   open while you use the app."
echo "   Close them to shut down the servers."
echo " =========================================="
echo ""
