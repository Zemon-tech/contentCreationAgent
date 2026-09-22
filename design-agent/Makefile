# Development tasks. Run e.g. `make check`.
# On Windows without make, use ./tasks.ps1 (same targets).

.PHONY: install lint format typecheck test check run precommit

install:
	uv sync

lint:
	uv run ruff check .

format:
	uv run ruff format .
	uv run ruff check --fix .

typecheck:
	uv run mypy

test:
	uv run pytest --cov

# Full gate: lint, types, tests. Run before pushing.
check: lint typecheck test

run:
	uv run uvicorn app.main:app --host 0.0.0.0 --port 8001

precommit:
	uvx pre-commit install
