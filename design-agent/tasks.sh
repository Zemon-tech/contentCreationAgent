#!/usr/bin/env bash
# ==============================================================================
# Design Agent — Development task runner for macOS and Linux (like tasks.ps1)
# Usage: ./tasks.sh {run|check|test|lint|format|typecheck|install|precommit}
# ==============================================================================
set -euo pipefail

cd "$(dirname "$0")"

TASK="${1:-check}"

case "$TASK" in
  install)
    uv sync
    uv run playwright install chromium
    ;;
  lint)
    uv run ruff check .
    ;;
  format)
    uv run ruff format .
    uv run ruff check --fix .
    ;;
  typecheck)
    uv run mypy
    ;;
  test)
    uv run pytest --cov
    ;;
  check)
    uv run ruff check .
    uv run mypy
    uv run pytest --cov
    ;;
  run)
    exec uv run uvicorn app.main:app --host 0.0.0.0 --port 8001
    ;;
  precommit)
    uvx pre-commit install
    ;;
  *)
    echo "Usage: ./tasks.sh {install|lint|format|typecheck|test|check|run|precommit}"
    exit 1
    ;;
esac
