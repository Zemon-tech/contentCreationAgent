"""Convenience CLI script to generate posts directly from terminal without manual HTTP requests."""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from playwright.async_api import async_playwright

from app.config import get_settings
from app.models import AspectRatio, CreateJobRequest, Format, JobStatus
from app.queue import get_job_manager


async def main() -> None:
    parser = argparse.ArgumentParser(description="Generate an Instagram post from text.")
    parser.add_argument(
        "content",
        nargs="?",
        default="Simplicity is not the lack of clutter. It is the clarity of purpose. When every word and boundary has earned its place, the work speaks quietly and endures.",
        help="The raw text content or insight to transform into a post.",
    )
    parser.add_argument(
        "--template",
        "-t",
        default="keilhq-text",
        choices=["keilhq-text", "keilhq-editorial", "entrepreneur-post", "tech-announcement"],
        help="Template to use (default: keilhq-text).",
    )
    parser.add_argument(
        "--format",
        "-f",
        default="single",
        choices=["single", "carousel"],
        help="Post format (default: single).",
    )
    parser.add_argument(
        "--aspect-ratio",
        "-a",
        default="4:5",
        choices=["4:5", "3:4", "1:1"],
        help="Aspect ratio (default: 4:5).",
    )
    parser.add_argument(
        "--max-slides",
        "-s",
        type=int,
        default=5,
        help="Maximum slides for carousel (default: 5).",
    )

    args = parser.parse_args()

    settings = get_settings()
    if not settings.sarvam_api_key:
        print("\n[ERROR] SARVAM_API_KEY is not set in your .env file.")
        print("Please add SARVAM_API_KEY=your_key to .env before generating.\n")
        sys.exit(1)

    print("\n------------------------------------------------------------")
    print("                KeilHQ Design Agent Generator                ")
    print("------------------------------------------------------------")
    print(f"Template     : {args.template}")
    print(f"Format       : {args.format}")
    print(f"Aspect Ratio : {args.aspect_ratio}")
    print(f'Input Text   :\n"{args.content}"\n')

    job_id = str(uuid.uuid4())
    job_mgr = get_job_manager()

    request = CreateJobRequest(
        content=args.content,
        template_id=args.template,
        format=Format(args.format),
        aspect_ratio=AspectRatio(args.aspect_ratio),
        max_slides=args.max_slides,
    )

    job_mgr.enqueue(job_id=job_id, request=request)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        job_mgr.set_browser(browser)

        try:
            print("-> Planning copy with Sarvam AI...")
            await job_mgr.process_job(job_id)
        finally:
            await browser.close()

    record = job_mgr.get_job(job_id)

    if record.status == JobStatus.DONE and record.post:
        print("\n[SUCCESS] Post generated successfully.")
        print(f"Output Directory : {record.output_dir}")
        print(f"Slides Produced  : {len(record.post.slides)}")
        for slide in record.post.slides:
            print(f"  * Slide {slide.index + 1}: {slide.file}")
        print(f"\nCaption preview  :\n{record.post.caption}")
        print(f"\nHashtags         : {' '.join('#' + tag for tag in record.post.hashtags)}")
        print("\nAll deliverables are ready in the output directory!")
    else:
        print(f"\n[FAILED]: {record.error}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
