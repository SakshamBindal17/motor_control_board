#!/bin/bash
# MC Hardware Designer — Launcher (Linux)
# Run with: bash START.sh
# Or make executable once: chmod +x START.sh  then  ./START.sh

# NOTE on .venv:
#   .venv is always created next to this script (same folder).
#   Works in this worktree now. After merge to main, works there
#   too — no path changes needed on any machine.
#   To force clean reinstall: delete .venv folder, run again.

chmod +x "${BASH_SOURCE[0]}" 2>/dev/null

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

clear
echo ""
echo " =========================================="
echo "   MC Hardware Designer  |  Starting Up"
echo " =========================================="
echo ""

# ── 1. Python version + venv + packages ──────────────────────
echo " [1/3] Checking Python environment..."

if ! command -v python3 &>/dev/null; then
    echo ""
    echo " ERROR: Python 3 not found on this system."
    echo " Install from: https://www.python.org/downloads/"
    echo " Ubuntu/Debian: sudo apt install python3 python3-venv python3-pip"
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi

# Verify Python version is 3.10+
PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    echo ""
    echo " ERROR: Python 3.10+ required, but found Python $PY_VER"
    echo " Download the latest version: https://www.python.org/downloads/"
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi

# Early file existence checks — catch incomplete project copies
if [ ! -f "$DIR/backend/requirements.txt" ]; then
    echo ""
    echo " ERROR: backend/requirements.txt not found."
    echo " Make sure you have the complete project files."
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi
if [ ! -f "$DIR/frontend/package.json" ]; then
    echo ""
    echo " ERROR: frontend/package.json not found."
    echo " Make sure you have the complete project files."
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi

if [ ! -d "$DIR/.venv" ]; then
    echo ""
    echo " First-time setup: creating Python virtual environment..."
    python3 -m venv "$DIR/.venv"
    if [ $? -ne 0 ]; then
        echo ""
        echo " ERROR: Could not create virtual environment."
        echo " Ubuntu/Debian: sudo apt install python3-venv"
        echo ""
        read -rp " Press Enter to exit..." && exit 1
    fi
fi

# Venv health probe — presence of activate does not guarantee venv is usable
if ! "$DIR/.venv/bin/python" -c "import sys" &>/dev/null; then
    echo ""
    echo " WARNING: Virtual environment is corrupted. Recreating..."
    rm -rf "$DIR/.venv"
    python3 -m venv "$DIR/.venv"
    if [ $? -ne 0 ]; then
        echo ""
        echo " ERROR: Could not recreate virtual environment."
        echo ""
        read -rp " Press Enter to exit..." && exit 1
    fi
fi

# Always activate + pip install so new packages are picked up on updates
source "$DIR/.venv/bin/activate"
echo " Installing / verifying Python packages..."
"$DIR/.venv/bin/python" -m pip install -r "$DIR/backend/requirements.txt"
if [ $? -ne 0 ]; then
    echo ""
    echo " ERROR: Python package install failed."
    echo " Check the output above to see which package failed."
    echo " Check your internet connection and try again."
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi
echo " Python environment ....... OK"
echo ""

# ── 2. Node modules setup ────────────────────────────────────
echo " [2/3] Checking Node.js packages..."

if ! command -v node &>/dev/null; then
    echo ""
    echo " ERROR: Node.js not found on this system."
    echo " Install from: https://nodejs.org/"
    echo " Ubuntu/Debian: sudo apt install nodejs npm"
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi

if ! command -v npm &>/dev/null; then
    echo ""
    echo " ERROR: npm not found. Reinstall Node.js from: https://nodejs.org/"
    echo " Ubuntu/Debian: sudo apt install npm"
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
    echo ""
    echo " ERROR: Node.js 18+ required, but found $(node --version 2>/dev/null)"
    echo " Download from: https://nodejs.org/"
    echo " Ubuntu/Debian: sudo apt install nodejs"
    echo ""
    read -rp " Press Enter to exit..." && exit 1
fi

# Determine if install is needed
NEED_NPM=false
CORRUPTED=false
if [ ! -d "$DIR/frontend/node_modules" ]; then
    NEED_NPM=true
elif [ ! -f "$DIR/frontend/node_modules/.package-lock.json" ]; then
    echo ""
    echo " WARNING: node_modules is corrupted (incomplete install). Reinstalling..."
    NEED_NPM=true
    CORRUPTED=true
fi

if [ "$NEED_NPM" = true ]; then
    echo ""
    echo " Installing Node.js packages (may take 1-2 minutes)..."
    NPM_ERR=0
    cd "$DIR/frontend"
    if [ -f "package-lock.json" ]; then
        npm ci
        NPM_ERR=$?
        if [ $NPM_ERR -ne 0 ]; then
            echo " npm ci failed (exit $NPM_ERR). Retrying with npm install..."
            npm install --no-audit --no-fund
            NPM_ERR=$?
        fi
    else
        echo " No package-lock.json found. Using npm install to generate one..."
        [ "$CORRUPTED" = true ] && rm -rf "node_modules"
        npm install --no-audit --no-fund
        NPM_ERR=$?
    fi
    cd "$DIR"
    if [ $NPM_ERR -ne 0 ]; then
        echo ""
        echo " ERROR: npm dependency install failed (exit code $NPM_ERR)."
        echo " Check the output above for details."
        echo " Make sure you have internet access."
        echo ""
        read -rp " Press Enter to exit..." && exit 1
    fi
fi
echo " Node.js packages ........ OK"
echo ""

# ── 3. Port conflict check ────────────────────────────────────
echo " Checking ports..."

port_in_use() {
    local port="$1"
    if command -v lsof &>/dev/null; then
        lsof -ti:"$port" &>/dev/null
    elif command -v ss &>/dev/null; then
        ss -tlnp | grep -q ":$port "
    else
        netstat -tlnp 2>/dev/null | grep -q ":$port "
    fi
}

kill_port() {
    local port="$1"
    if command -v lsof &>/dev/null; then
        kill $(lsof -ti:"$port") 2>/dev/null
    elif command -v ss &>/dev/null; then
        local pid
        pid=$(ss -tlnp | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
    else
        local pid
        pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | awk '{print $7}' | cut -d/ -f1 | head -1)
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
    fi
}

check_port() {
    local port="$1"
    local name="$2"
    if port_in_use "$port"; then
        echo ""
        echo " WARNING: Port $port is already in use ($name)."
        read -rp " Kill it and continue? [Y/N]: " choice
        if [[ "$choice" =~ ^[Yy]$ ]]; then
            kill_port "$port"
            sleep 1
            echo " Port $port freed."
        else
            echo " Aborting. Close whatever is using port $port and try again."
            echo ""
            read -rp " Press Enter to exit..." && exit 1
        fi
    fi
}

check_port 8472 "Backend"
check_port 5742 "Frontend"
echo " Ports 8472 + 5742 ........ OK"
echo ""

# ── 4. Launch servers ────────────────────────────────────────
echo " [3/3] Starting servers..."
echo ""

open_terminal() {
    local title="$1"
    local cmd="$2"
    if command -v gnome-terminal &>/dev/null; then
        gnome-terminal --title="$title" -- bash -c "$cmd; exec bash" 2>/dev/null &
    elif command -v konsole &>/dev/null; then
        konsole --title "$title" -e bash -c "$cmd; exec bash" 2>/dev/null &
    elif command -v xfce4-terminal &>/dev/null; then
        xfce4-terminal --title="$title" -e "bash -c \"$cmd; exec bash\"" 2>/dev/null &
    elif command -v xterm &>/dev/null; then
        xterm -title "$title" -e bash -c "$cmd; exec bash" 2>/dev/null &
    else
        echo " (No GUI terminal found — running $title in background)"
        bash -c "$cmd" > "$DIR/log_${title// /_}.log" 2>&1 &
        echo " Log: $DIR/log_${title// /_}.log"
    fi
}

open_terminal "MC Designer Backend (do not close)" \
    "echo '' && echo '  ==========================================' && echo '    MC Designer Backend | http://localhost:8472' && echo '    Logs appear here when PDFs are uploaded.' && echo '  ==========================================' && echo '' && cd '$DIR' && source '$DIR/.venv/bin/activate' && cd '$DIR/backend' && python -m uvicorn main:app --reload --port 8472 --log-level info"

sleep 2

open_terminal "MC Designer Frontend (do not close)" \
    "echo '' && echo '  Frontend running on http://localhost:5742' && echo '' && cd '$DIR/frontend' && npm run dev"

# ── 5. Backend readiness poll ─────────────────────────────────
echo " Waiting for backend to start (Application startup complete)..."
READY=0
for i in $(seq 1 15); do
    if curl -s --max-time 2 http://localhost:8472 >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 2
done
if [ $READY -eq 0 ]; then
    echo " WARNING: Backend did not respond in 30s."
    echo " Open http://localhost:5742 manually once backend shows startup complete."
fi

if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:5742
elif command -v sensible-browser &>/dev/null; then
    sensible-browser http://localhost:5742
fi

echo ""
echo " =========================================="
echo "   Everything is running!"
echo "   Browser: http://localhost:5742"
echo ""
echo "   Keep Backend + Frontend windows open."
echo "   Close them to stop the servers."
echo " =========================================="
echo ""
