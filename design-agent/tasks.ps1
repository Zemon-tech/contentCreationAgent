<#
.SYNOPSIS
  Development task runner (Windows/PowerShell equivalent of the Makefile).
.EXAMPLE
  ./tasks.ps1 check
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "lint", "format", "typecheck", "test", "check", "run", "precommit")]
    [string]$Task = "check"
)

$ErrorActionPreference = "Stop"

switch ($Task) {
    "install"   { uv sync }
    "lint"      { uv run ruff check . }
    "format"    { uv run ruff format .; uv run ruff check --fix . }
    "typecheck" { uv run mypy }
    "test"      { uv run pytest --cov }
    "check"     { uv run ruff check .; uv run mypy; uv run pytest --cov }
    "run"       { uv run uvicorn app.main:app }
    "precommit" { uvx pre-commit install }
}
