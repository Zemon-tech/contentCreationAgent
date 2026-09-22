"""Stage 2 — ComfyUI Image Engine (spec.md §9, §11).

Communicates with ComfyUI over HTTP and WebSocket APIs:
- Loads API-format workflows and injects prompts, seeds, and dimensions via companion map files.
- Enforces single-slot GPU serialization (two concurrent diffusions will OOM).
- Polls WebSocket execution messages and downloads generated PNG artifacts.
"""

from __future__ import annotations

import asyncio
import copy
import json
import random
import re
import uuid
from pathlib import Path
from typing import Any

import httpx
import websockets
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.exceptions import ImageGenerationError
from app.models import PostPlan, TemplateManifest

# Process-wide single-slot GPU lock ensuring serialized diffusion jobs (spec §9)
_gpu_lock = asyncio.Lock()


class WorkflowMap(BaseModel):
    """Declarative node injection map for ComfyUI API-format workflows."""

    model_config = ConfigDict(frozen=True)

    prompt_node: str = Field(description="Node ID for positive CLIPTextEncode")
    prompt_input: str = Field(default="text")
    seed_node: str | None = Field(default=None, description="Node ID for KSampler seed")
    seed_input: str | None = Field(default="seed")
    width_node: str | None = Field(default=None, description="Node ID for EmptyLatentImage width")
    width_input: str | None = Field(default="width")
    height_node: str | None = Field(default=None, description="Node ID for EmptyLatentImage height")
    height_input: str | None = Field(default="height")


def load_workflow(
    workflow_name: str,
    workflows_dir: Path | str | None = None,
) -> tuple[dict[str, Any], WorkflowMap]:
    """Load API-format workflow JSON and its companion .map.json file (spec §11.1, §11.2)."""
    base_dir = Path(workflows_dir) if workflows_dir is not None else Path("workflows")
    wf_path = base_dir / workflow_name
    map_name = workflow_name.replace(".json", "") + ".map.json"
    map_path = base_dir / map_name

    if not wf_path.is_file():
        raise ImageGenerationError(
            f"Workflow file not found: {wf_path}",
            details={"workflow_file": str(wf_path)},
        )

    if not map_path.is_file():
        raise ImageGenerationError(
            f"Companion workflow map file not found: {map_path}",
            details={"map_file": str(map_path)},
        )

    try:
        wf_content = wf_path.read_text(encoding="utf-8")
        workflow_data = json.loads(wf_content)
        map_content = map_path.read_text(encoding="utf-8")
        map_data = json.loads(map_content)
        wf_map = WorkflowMap.model_validate(map_data)
        return workflow_data, wf_map
    except Exception as exc:
        raise ImageGenerationError(
            f"Failed to parse workflow or companion map: {exc}",
            details={"workflow": str(wf_path), "error": str(exc)},
        ) from exc


def inject_workflow_params(
    workflow: dict[str, Any],
    wf_map: WorkflowMap,
    prompt: str,
    seed: int,
    width: int,
    height: int,
) -> dict[str, Any]:
    """Inject prompt, seed, and dimensions into workflow nodes via the map (spec §11.2, §11.3)."""
    injected = copy.deepcopy(workflow)

    # 1. Inject prompt
    if wf_map.prompt_node not in injected:
        raise ImageGenerationError(
            f"Node '{wf_map.prompt_node}' declared in map does not exist in workflow."
        )
    injected[wf_map.prompt_node]["inputs"][wf_map.prompt_input] = prompt

    # 2. Inject seed
    if wf_map.seed_node and wf_map.seed_input and wf_map.seed_node in injected:
        injected[wf_map.seed_node]["inputs"][wf_map.seed_input] = seed

    # 3. Inject dimensions
    if wf_map.width_node and wf_map.width_input and wf_map.width_node in injected:
        injected[wf_map.width_node]["inputs"][wf_map.width_input] = width
    if wf_map.height_node and wf_map.height_input and wf_map.height_node in injected:
        injected[wf_map.height_node]["inputs"][wf_map.height_input] = height

    return injected


class ComfyUIClient:
    """HTTP & WebSocket client for ComfyUI running on the GPU VM."""

    def __init__(
        self,
        base_url: str | None = None,
        timeout_s: int | None = None,
    ) -> None:
        settings = get_settings()
        self.base_url = (base_url or str(settings.comfyui_base_url)).rstrip("/")
        self.timeout_s = timeout_s or settings.comfyui_timeout_s

    async def check_health(self) -> bool:
        """Check if ComfyUI is reachable."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(f"{self.base_url}/system_stats")
                return res.status_code == httpx.codes.OK
        except httpx.HTTPError:
            return False

    async def submit_prompt(
        self,
        workflow: dict[str, Any],
        client_id: str,
    ) -> str:
        """Submit a prompt workflow to ComfyUI (spec §11.4).

        Raises:
            ImageGenerationError: If ComfyUI reports node_errors (non-retryable).
        """
        url = f"{self.base_url}/prompt"
        payload = {"prompt": workflow, "client_id": client_id}

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.post(url, json=payload)

            if res.status_code != httpx.codes.OK:
                raise ImageGenerationError(
                    f"ComfyUI /prompt returned HTTP {res.status_code}: {res.text}",
                    details={"status_code": res.status_code, "body": res.text},
                )

            data = res.json()
            if data.get("node_errors"):
                raise ImageGenerationError(
                    f"ComfyUI node validation failed: {data['node_errors']}",
                    details={"node_errors": data["node_errors"]},
                )

            prompt_id = data.get("prompt_id")
            if not prompt_id:
                raise ImageGenerationError(
                    "ComfyUI did not return a prompt_id in /prompt response.",
                    details={"response": data},
                )
            return str(prompt_id)

        except httpx.HTTPError as exc:
            raise ImageGenerationError(
                f"Failed to connect to ComfyUI at {url}: {exc}",
                details={"error": str(exc)},
            ) from exc

    async def wait_for_completion(self, prompt_id: str, client_id: str) -> None:
        """Listen to ComfyUI WebSocket messages until execution finishes (spec §11.5)."""
        ws_base = re.sub(r"^http", "ws", self.base_url)
        ws_url = f"{ws_base}/ws?clientId={client_id}"

        async def _listen() -> None:
            async with websockets.connect(ws_url) as ws:
                async for raw_msg in ws:
                    if isinstance(raw_msg, bytes):
                        # Binary preview frame, ignore per spec §11.5
                        continue

                    try:
                        msg = json.loads(raw_msg)
                    except json.JSONDecodeError:
                        continue

                    msg_type = msg.get("type")
                    data = msg.get("data", {})

                    if msg_type == "execution_error":
                        raise ImageGenerationError(
                            f"ComfyUI execution error: {data.get('exception_message')}",
                            details={"data": data},
                        )

                    # Completion: executing with node == null for our prompt_id
                    if (
                        msg_type == "executing"
                        and data.get("node") is None
                        and data.get("prompt_id") == prompt_id
                    ):
                        return

        try:
            await asyncio.wait_for(_listen(), timeout=self.timeout_s)
        except TimeoutError as exc:
            raise ImageGenerationError(
                f"ComfyUI timed out after {self.timeout_s}s waiting for prompt {prompt_id}.",
                details={"prompt_id": prompt_id, "timeout_s": self.timeout_s},
            ) from exc
        except (websockets.WebSocketException, OSError) as exc:
            raise ImageGenerationError(
                f"WebSocket connection failure to ComfyUI: {exc}",
                details={"ws_url": ws_url, "error": str(exc)},
            ) from exc

    async def get_history(self, prompt_id: str) -> dict[str, Any]:
        """Fetch execution history for prompt_id (spec §11.6)."""
        url = f"{self.base_url}/history/{prompt_id}"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.get(url)
            if res.status_code != httpx.codes.OK:
                raise ImageGenerationError(
                    f"ComfyUI /history/{prompt_id} failed with HTTP {res.status_code}",
                    details={"status_code": res.status_code},
                )
            data: dict[str, Any] = res.json()
            return data
        except httpx.HTTPError as exc:
            raise ImageGenerationError(
                f"Failed to fetch ComfyUI history for {prompt_id}: {exc}",
                details={"error": str(exc)},
            ) from exc

    async def download_image(
        self,
        filename: str,
        subfolder: str = "",
        folder_type: str = "output",
    ) -> bytes:
        """Download generated image file bytes from ComfyUI /view (spec §11.6)."""
        url = f"{self.base_url}/view"
        params = {"filename": filename, "subfolder": subfolder, "type": folder_type}
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.get(url, params=params)
            if res.status_code != httpx.codes.OK:
                raise ImageGenerationError(
                    f"Failed to download image from ComfyUI: HTTP {res.status_code}",
                    details={"params": params},
                )
            return res.content
        except httpx.HTTPError as exc:
            raise ImageGenerationError(
                f"HTTP transport failure downloading {filename}: {exc}",
                details={"error": str(exc)},
            ) from exc

    async def generate_image(
        self,
        workflow_filename: str,
        prompt: str,
        width: int,
        height: int,
        workflows_dir: Path | str | None = None,
        seed: int | None = None,
    ) -> bytes:
        """Run a single diffusion generation job under the process-wide GPU lock (spec §9, §11)."""
        client_id = str(uuid.uuid4())
        chosen_seed = seed if seed is not None else random.randint(1, 10**14)

        raw_workflow, wf_map = load_workflow(workflow_filename, workflows_dir)
        injected = inject_workflow_params(
            workflow=raw_workflow,
            wf_map=wf_map,
            prompt=prompt,
            seed=chosen_seed,
            width=width,
            height=height,
        )

        async with _gpu_lock:
            prompt_id = await self.submit_prompt(injected, client_id)
            await self.wait_for_completion(prompt_id, client_id)
            history = await self.get_history(prompt_id)

            prompt_output = history.get(prompt_id, {})
            outputs = prompt_output.get("outputs", {})

            # Find generated image files across output nodes
            images_found: list[dict[str, str]] = []
            for _node_id, node_data in outputs.items():
                if "images" in node_data:
                    images_found.extend(node_data["images"])

            if not images_found:
                raise ImageGenerationError(
                    f"No output images found in ComfyUI history for prompt {prompt_id}.",
                    details={"history": history},
                )

            first_img = images_found[0]
            return await self.download_image(
                filename=first_img["filename"],
                subfolder=first_img.get("subfolder", ""),
                folder_type=first_img.get("type", "output"),
            )


def cover_slot_id(manifest: TemplateManifest) -> str | None:
    """Return the first prompt_slot image slot id (the cover hero), if any."""
    for img_slot in manifest.image_slots:
        if img_slot.prompt_slot:
            return img_slot.id
    return None


async def download_url_to_image(
    url: str,
    dest: Path,
    timeout_s: int = 30,
    max_bytes: int = 15_000_000,
) -> Path:
    """Download a user-provided image URL to dest as PNG, validating it decodes (spec §11).

    Raises:
        ImageGenerationError: On transport failure, oversize payload, or non-image content.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as client:
            res = await client.get(url)
        if res.status_code != httpx.codes.OK:
            raise ImageGenerationError(
                f"Cover image URL returned HTTP {res.status_code}: {url}",
                details={"status_code": res.status_code, "url": str(url)},
            )
    except httpx.HTTPError as exc:
        raise ImageGenerationError(
            f"Failed to download cover image URL {url}: {exc}",
            details={"url": str(url), "error": str(exc)},
        ) from exc

    content = res.content
    if len(content) > max_bytes:
        raise ImageGenerationError(
            f"Cover image URL payload ({len(content)} bytes) exceeds {max_bytes} byte cap.",
            details={"url": str(url)},
        )

    content_type = res.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type and not content_type.startswith("image/"):
        raise ImageGenerationError(
            f"Cover image URL did not return image content (content-type: {content_type or 'missing'}).",
            details={"url": str(url), "content_type": content_type},
        )

    import io as _io

    try:
        img = Image.open(_io.BytesIO(content))
        img.load()
    except Exception as exc:
        raise ImageGenerationError(
            f"Cover image URL content is not a decodable image: {exc}",
            details={"url": str(url)},
        ) from exc

    dest = dest.with_suffix(".png")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    img.save(dest, format="PNG")
    return dest


async def generate_images_for_post(
    post_plan: PostPlan,
    manifest: TemplateManifest,
    output_dir: Path,
    comfy_client: ComfyUIClient | None = None,
    workflows_dir: Path | str | None = None,
    skip: set[tuple[int, str]] | None = None,
) -> dict[tuple[int, str], Path]:
    """Generate all images required for prompt_slot=True image slots across all slides (spec §11).

    Saves images to output_dir and returns mapping from (slide_idx, slot_id) to image file path.
    Entries in `skip` (e.g. cover overridden by a provided URL) are not generated.
    """
    client = comfy_client or ComfyUIClient()
    target_width, target_height = post_plan.aspect_ratio.dimensions
    output_dir.mkdir(parents=True, exist_ok=True)  # noqa: ASYNC240

    generated_map: dict[tuple[int, str], Path] = {}

    for slide_idx, slide in enumerate(post_plan.slides):
        for img_slot in manifest.image_slots:
            if not img_slot.prompt_slot:
                continue

            if skip and (slide_idx, img_slot.id) in skip:
                continue

            if not img_slot.comfy_workflow:
                raise ImageGenerationError(
                    f"Slot '{img_slot.id}' has prompt_slot=True but no comfy_workflow specified."
                )

            slot_prompt = slide.images[img_slot.id].prompt

            png_bytes = await client.generate_image(
                workflow_filename=img_slot.comfy_workflow,
                prompt=slot_prompt,
                width=target_width,
                height=target_height,
                workflows_dir=workflows_dir,
            )

            file_name = f"slot_{img_slot.id}_slide_{slide_idx + 1:02d}.png"
            file_path = output_dir / file_name
            file_path.write_bytes(png_bytes)

            generated_map[(slide_idx, img_slot.id)] = file_path

    return generated_map
