#!/usr/bin/env python
"""Plain-cron entry point for the schedule gate.

Use this when your scheduler (cron, systemd timer, Task Scheduler) can run a
command but has no "monitor" concept. It is the same logic the Hermes monitor
shim uses, with a shell-friendly shape:

  exit 0, no output    -> nothing due (do nothing, spend nothing)
  exit 0, JSON output  -> something is due; hand it to your agent
  exit 1               -> an error worth looking at

Typical wiring - run every 10 minutes, and only wake your agent when there is
work:

  */10 * * * * cd /path/to/tweetytweets && python scripts/cron_gate.py --wake

With --wake it prints a complete instruction block (draft + the exact commands to
publish and verify it), so an agent can consume it directly:

  */10 * * * * cd /path/to/tweetytweets && \
      python scripts/cron_gate.py --wake | your-agent --stdin

Without --wake it just prints the draft JSON.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wake", action="store_true",
                    help="print a full instruction block for an agent, not just JSON")
    ap.add_argument("--timeout", type=int, default=120)
    a = ap.parse_args()

    try:
        proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "due.py"), "check"],
                              cwd=str(ROOT), capture_output=True, text=True, timeout=a.timeout)
    except Exception as err:
        print(f"cron_gate: could not run due.py: {type(err).__name__}: {err}", file=sys.stderr)
        return 1

    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        print(f"cron_gate: due.py exited {proc.returncode}: {(proc.stderr or '')[:400]}",
              file=sys.stderr)
        return 1

    if not out or out == "IDLE":
        return 0                      # nothing due: silent, so the caller spends nothing

    try:
        draft = json.loads(out)
    except json.JSONDecodeError:
        print(out)
        return 0

    if not a.wake:
        print(json.dumps(draft, ensure_ascii=False))
        return 0

    kind = draft.get("kind", "value")
    extra = " --kind ai_update" if kind == "ai_update" else ""
    print(f"""A post is DUE for @{draft.get('handle') or 'your account'}.

  slot       {draft.get('slot')}  ({kind}, {draft.get('minutes_late')} min late)
  due at     {draft.get('due_at')}

Draft text (publish VERBATIM - do not edit, do not add hashtags or emoji):
---8<---
{draft.get('text')}
---8<---

Then, in {ROOT}:
  python scripts/post.py check                      # must show your handle
  python scripts/post.py post --text-file scratch/post.txt{extra}
  python scripts/post.py shot --what profile        # then LOOK at shots/profile.png
  python scripts/due.py mark --slot {draft.get('slot')} --url <tweet_url>

Only mark the slot once the post is confirmed live. If it failed, do NOT mark it.""")

    # leave the text where the next command expects it
    scratch = ROOT / "scratch"
    scratch.mkdir(exist_ok=True)
    (scratch / "post.txt").write_text(draft.get("text", ""), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
