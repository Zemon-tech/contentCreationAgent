"""FastAPI application entrypoint.

Wires together configuration, logging, middleware, exception handlers,
the persistent Playwright browser lifecycle, job queue workers, and routes.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import FileResponse, HTMLResponse
from playwright.async_api import async_playwright

from app import __version__
from app.config import Settings, get_settings
from app.error_handlers import register_exception_handlers
from app.logging_config import configure_logging, get_logger
from app.middleware import RequestContextMiddleware
from app.models import (
    CreateJobRequest,
    CreateJobResponse,
    JobStatus,
    JobStatusResponse,
)
from app.queue import JobManager, get_job_manager
from app.security import require_api_key

logger = get_logger("app.main")


async def _comfyui_reachable(settings: Settings) -> bool:
    """Best-effort check that the ComfyUI server responds (spec §4)."""
    url = f"{str(settings.comfyui_base_url).rstrip('/')}/system_stats"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(url)
        return response.status_code == httpx.codes.OK
    except httpx.HTTPError:
        return False


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Application startup/shutdown managing the persistent Playwright browser and job workers (spec §9)."""
    settings = get_settings()
    logger.info(
        "startup",
        version=__version__,
        environment=settings.environment,
        log_renderer=settings.resolved_log_renderer,
        # Host only (no secrets): proves which ComfyUI the worker will call.
        comfyui_base_url=str(settings.comfyui_base_url).rstrip("/"),
    )

    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )

    job_mgr = get_job_manager()
    job_mgr.set_browser(browser)
    await job_mgr.start()

    try:
        yield
    finally:
        logger.info("shutdown_started")
        await job_mgr.stop()
        await browser.close()
        await playwright.stop()
        logger.info("shutdown_completed")


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    settings = get_settings()
    configure_logging(
        level=settings.log_level,
        renderer=settings.resolved_log_renderer,
    )

    app = FastAPI(
        title="Design Agent",
        version=__version__,
        lifespan=lifespan,
    )

    app.add_middleware(RequestContextMiddleware)
    register_exception_handlers(app)

    @app.get("/health", tags=["ops"])
    async def health(
        settings: Annotated[Settings, Depends(get_settings)],
    ) -> dict[str, str]:
        """Liveness + ComfyUI reachability check. Public (no API key)."""
        reachable = await _comfyui_reachable(settings)
        return {
            "status": "ok",
            "comfyui": "reachable" if reachable else "unreachable",
        }

    @app.get("/", tags=["ops"], dependencies=[Depends(require_api_key)])
    async def root() -> dict[str, str]:
        """Authenticated service info endpoint."""
        return {"service": "design-agent", "version": __version__}

    @app.post(
        "/jobs",
        status_code=status.HTTP_202_ACCEPTED,
        tags=["jobs"],
        dependencies=[Depends(require_api_key)],
    )
    async def create_job(
        request: CreateJobRequest,
        job_mgr: Annotated[JobManager, Depends(get_job_manager)],
    ) -> CreateJobResponse:
        """Create a new post generation job (spec §4)."""
        job_id = str(uuid.uuid4())
        record = job_mgr.enqueue(job_id=job_id, request=request)
        return CreateJobResponse(job_id=record.id, status=record.status)

    @app.get(
        "/jobs/{job_id}",
        tags=["jobs"],
        dependencies=[Depends(require_api_key)],
    )
    async def get_job_status(
        job_id: str,
        job_mgr: Annotated[JobManager, Depends(get_job_manager)],
    ) -> JobStatusResponse:
        """Query status and deliverables for a post generation job (spec §4)."""
        record = job_mgr.get_job(job_id)
        return record.to_status_response()

    @app.get(
        "/jobs/{job_id}/preview",
        tags=["jobs"],
        dependencies=[Depends(require_api_key)],
    )
    async def get_job_preview(
        job_id: str,
        job_mgr: Annotated[JobManager, Depends(get_job_manager)],
    ) -> HTMLResponse:
        """Return the preview.html gallery for a finished job."""
        record = job_mgr.get_job(job_id)
        if record.status != JobStatus.DONE or not record.output_dir:
            raise HTTPException(status_code=409, detail="Job is not finished yet.")
        preview_path = Path(record.output_dir) / "preview.html"
        if not preview_path.is_file():
            raise HTTPException(status_code=404, detail="Preview not found for this job.")
        return HTMLResponse(content=preview_path.read_text(encoding="utf-8"))

    @app.get(
        "/jobs/{job_id}/download",
        tags=["jobs"],
        dependencies=[Depends(require_api_key)],
    )
    async def download_job_bundle(
        job_id: str,
        job_mgr: Annotated[JobManager, Depends(get_job_manager)],
    ) -> FileResponse:
        """Download bundle.zip (slides + caption + manifests) for a finished job."""
        record = job_mgr.get_job(job_id)
        if record.status != JobStatus.DONE or not record.output_dir:
            raise HTTPException(status_code=409, detail="Job is not finished yet.")
        bundle_path = Path(record.output_dir) / "bundle.zip"
        if not bundle_path.is_file():
            raise HTTPException(status_code=404, detail="Bundle not found for this job.")
        return FileResponse(
            path=str(bundle_path),
            media_type="application/zip",
            filename=f"{job_id}.zip",
        )

    return app


app = create_app()
