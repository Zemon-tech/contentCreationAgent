"""In-process asynchronous job queue and worker pool (spec.md §3, §4, §9).

Coordinates the four-stage pipeline:
queued -> planning -> generating_images -> compositing -> done | failed
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

from playwright.async_api import Browser
from pydantic import BaseModel, ConfigDict, Field

from app.assembler import assemble_job_output
from app.compositor import composite_post
from app.config import Settings, get_settings
from app.exceptions import JobNotFoundError
from app.images import ComfyUIClient, cover_slot_id, download_url_to_image, generate_images_for_post
from app.logging_config import get_logger
from app.models import (
    CreateJobRequest,
    JobStatus,
    JobStatusResponse,
    PostManifest,
)
from app.planner import plan_post
from app.sarvam import SarvamClient

logger = get_logger("app.queue")


class JobRecord(BaseModel):
    """Internal state record for an asynchronous post generation job."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: str
    request: CreateJobRequest
    status: JobStatus = JobStatus.QUEUED
    output_dir: str | None = None
    error: str | None = None
    post: PostManifest | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    def to_status_response(self) -> JobStatusResponse:
        """Convert record to the public API response envelope (spec §4)."""
        return JobStatusResponse(
            job_id=self.id,
            status=self.status,
            output_dir=self.output_dir,
            error=self.error,
            post=self.post,
        )


class JobManager:
    """Manages the in-process job queue, worker pool, and job lifecycle."""

    def __init__(
        self,
        settings: Settings | None = None,
        browser: Browser | None = None,
        sarvam_client: SarvamClient | None = None,
        comfy_client: ComfyUIClient | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.browser = browser
        self.sarvam_client = sarvam_client
        self.comfy_client = comfy_client

        self._queue: asyncio.Queue[str] | None = None
        self._jobs: dict[str, JobRecord] = {}
        self._workers: list[asyncio.Task[None]] = []
        self._running: bool = False

    def _ensure_queue(self) -> asyncio.Queue[str]:
        if self._queue is None:
            self._queue = asyncio.Queue()
        return self._queue

    def set_browser(self, browser: Browser) -> None:
        """Inject the persistent Playwright browser instance."""
        self.browser = browser

    def enqueue(self, job_id: str, request: CreateJobRequest) -> JobRecord:
        """Register a new job and push its ID onto the processing queue."""
        record = JobRecord(id=job_id, request=request)
        self._jobs[job_id] = record
        self._ensure_queue().put_nowait(job_id)
        logger.info("job_enqueued", job_id=job_id)
        return record

    def get_job(self, job_id: str) -> JobRecord:
        """Retrieve a job by ID or raise JobNotFoundError."""
        if job_id not in self._jobs:
            raise JobNotFoundError(
                f"Job '{job_id}' not found.",
                details={"job_id": job_id},
            )
        return self._jobs[job_id]

    async def start(self, num_workers: int | None = None) -> None:
        """Start the background queue workers."""
        if self._running:
            return
        self._running = True
        self._queue = asyncio.Queue()
        worker_count = num_workers or self.settings.job_workers

        for i in range(worker_count):
            task = asyncio.create_task(self._worker_loop(i), name=f"job-worker-{i}")
            self._workers.append(task)
        logger.info("job_workers_started", count=worker_count)

    async def stop(self) -> None:
        """Signal and cancel worker tasks on application shutdown."""
        self._running = False
        for task in self._workers:
            task.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        self._queue = None
        logger.info("job_workers_stopped")

    async def process_job(self, job_id: str) -> None:
        """Execute the end-to-end pipeline for a single job."""
        job = self.get_job(job_id)
        output_base = self.settings.output_dir
        job_output_dir = output_base / job_id

        try:
            # Stage 1: Planning
            job.status = JobStatus.PLANNING
            job.updated_at = datetime.now(UTC)
            logger.info("stage_planning_started", job_id=job_id)

            post_plan, manifest = await plan_post(
                request=job.request,
                sarvam_client=self.sarvam_client,
                templates_dir=self.settings.templates_dir,
            )

            # Stage 2: Image Engine (ComfyUI)
            job.status = JobStatus.GENERATING_IMAGES
            job.updated_at = datetime.now(UTC)
            logger.info("stage_images_started", job_id=job_id)

            images_map: dict[tuple[int, str], Path] = {}
            needs_generation = any(slot.prompt_slot for slot in manifest.image_slots)
            skip_generation: set[tuple[int, str]] = set()

            # Caller-provided cover image: use as-is for slide 0 hero, skip its generation.
            if job.request.cover_image_url:
                cover_slot = cover_slot_id(manifest)
                if cover_slot is None:
                    logger.warning(
                        "cover_image_url_ignored_no_image_slot",
                        job_id=job_id,
                    )
                else:
                    try:
                        job_output_dir.mkdir(parents=True, exist_ok=True)
                        cover_path = await download_url_to_image(
                            str(job.request.cover_image_url),
                            job_output_dir / "cover_source",
                        )
                        images_map[(0, cover_slot)] = cover_path
                        skip_generation.add((0, cover_slot))
                        logger.info("cover_image_downloaded", job_id=job_id)
                    except Exception as exc:
                        logger.warning(
                            "cover_image_download_failed_using_generation",
                            job_id=job_id,
                            error=str(exc),
                        )

            if needs_generation:
                comfy = self.comfy_client or ComfyUIClient()
                is_reachable = await comfy.check_health()

                if is_reachable:
                    images_map.update(
                        await generate_images_for_post(
                            post_plan=post_plan,
                            manifest=manifest,
                            output_dir=job_output_dir,
                            comfy_client=comfy,
                            skip=skip_generation,
                        )
                    )
                else:
                    logger.warning(
                        "comfyui_unreachable_using_placeholders",
                        job_id=job_id,
                    )

            # Stage 3: Compositor
            job.status = JobStatus.COMPOSITING
            job.updated_at = datetime.now(UTC)
            logger.info("stage_compositing_started", job_id=job_id)

            if not self.browser:
                raise RuntimeError("Persistent Playwright browser has not been initialized.")

            render_result = await composite_post(
                post_plan=post_plan,
                browser=self.browser,
                images=images_map,  # type: ignore[arg-type]
                templates_dir=self.settings.templates_dir,
                concurrency=self.settings.render_concurrency,
            )

            # Stage 4: Assembler
            post_manifest = assemble_job_output(
                job_id=job_id,
                content=job.request.content,
                post_plan=post_plan,
                render_result=render_result,
                output_base_dir=output_base,
            )

            # Mark complete
            job.status = JobStatus.DONE
            job.output_dir = str(job_output_dir.resolve())
            job.post = post_manifest
            job.updated_at = datetime.now(UTC)
            logger.info("job_completed", job_id=job_id, slides_count=len(post_manifest.slides))

        except Exception as exc:
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.updated_at = datetime.now(UTC)
            logger.error("job_failed", job_id=job_id, error=str(exc))

    async def _worker_loop(self, worker_id: int) -> None:
        """Worker loop continuously popping jobs from the queue."""
        queue = self._ensure_queue()
        while self._running:
            try:
                job_id = await queue.get()
                try:
                    await self.process_job(job_id)
                finally:
                    queue.task_done()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("worker_unexpected_error", worker_id=worker_id, error=str(exc))
                await asyncio.sleep(0.1)


# Process-wide singleton JobManager instance
_job_manager: JobManager | None = None


def get_job_manager() -> JobManager:
    """Return the global JobManager singleton."""
    global _job_manager
    if _job_manager is None:
        _job_manager = JobManager()
    return _job_manager


def reset_job_manager() -> None:
    """Reset the global JobManager singleton (used in test teardown)."""
    global _job_manager
    _job_manager = None
