# Design Agent — Production Dockerfile
# Based on Microsoft's official Playwright Python image (includes Chromium system deps)
FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    UV_SYSTEM_PYTHON=1 \
    PORT=8001

# Install Noto fallback fonts (spec.md §15: fonts-noto-core, fonts-noto-cjk, fonts-noto-color-emoji)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast, reliable package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install project dependencies
COPY pyproject.toml uv.lock ./
RUN uv pip install --system -r pyproject.toml

# Install Playwright Chromium browser
RUN python -m playwright install --with-deps chromium

# Copy application source, templates, brand configuration, and workflows
COPY app/ ./app/
COPY templates/ ./templates/
COPY workflows/ ./workflows/
COPY brand.yaml ./

# Create output directory
RUN mkdir -p output

EXPOSE 8001

# Run with standard production flags
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
