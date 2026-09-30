#!/usr/bin/env bash
# ==============================================================================
# Design Agent — Single-command runner for macOS and Linux
# Usage: ./run.sh
# ==============================================================================
set -euo pipefail

# Always run from the project root directory
cd "$(dirname "$0")"

echo "=================================================="
echo "          Starting Design Agent                   "
echo "=================================================="

# 1. Create .env if missing
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "[init] No .env file found. Copying from .env.example..."
        cp .env.example .env
    else
        echo "[init] Creating default .env file..."
        cat << 'EOF' > .env
DESIGN_AGENT_API_KEY=change-me
SARVAM_API_KEY=your-sarvam-api-key-here
COMFYUI_BASE_URL=http://localhost:8188
COMFYUI_WS_URL=ws://localhost:8188/ws
ENVIRONMENT=development
LOG_RENDERER=console
PORT=8001
EOF
    fi
fi

# 2. Check and install uv package manager if not present
if ! command -v uv &> /dev/null; then
    echo "[init] uv not found. Installing uv (fast Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

# 3. Sync dependencies using uv
echo "[init] Syncing Python dependencies..."
uv sync

# 4. Ensure Playwright Chromium browser is installed
echo "[init] Checking Playwright Chromium browser..."
uv run playwright install chromium

# 5. Start the FastAPI server
echo "[run] Design Agent listening on http://0.0.0.0:8001"
exec uv run uvicorn app.main:app --host 0.0.0.0 --port 8001
