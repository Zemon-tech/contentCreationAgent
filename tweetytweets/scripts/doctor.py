#!/usr/bin/env python
"""Readiness check - run this first, and after anything breaks.

Tells you exactly which parts of the pipeline can run right now, what is
missing, and the one command that fixes each gap. Nothing here changes state or
posts anything.

  python doctor.py
  python doctor.py --live     # also try the network + the browser session
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import settings  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

OK, WARN, BAD = "OK", "WARN", "MISSING"


def check_python() -> tuple[str, str]:
    if sys.version_info < (3, 10):
        return BAD, f"python {sys.version.split()[0]} - needs 3.10+ for zoneinfo and X | Y types"
    return OK, f"python {sys.version.split()[0]}"


def check_deps() -> tuple[str, str]:
    try:
        import websockets  # noqa: F401
        return OK, "websockets installed"
    except ImportError:
        return BAD, "websockets missing - run:  pip install -r requirements.txt"


def check_config() -> tuple[str, str]:
    if not settings.CONFIG_PATH.exists():
        return BAD, f"no config.json - run:  cp {settings.EXAMPLE_PATH.name} config.json"
    c = settings.load()
    if not (c.get("handle") or "").strip():
        return WARN, "config.json exists but handle is empty - finish the onboarding interview"
    lim = settings.limit(c)
    cap = f"{lim['chars']} chars" + ("" if lim["verified"] else "  (NOT verified)")
    return OK, f"config.json ok - handle @{c['handle'].lstrip('@')}, cap {cap}"


def check_chrome() -> tuple[str, str]:
    cfg = settings.load()
    explicit = (cfg.get("browser") or {}).get("chrome_path") or ""
    found = settings.find_chrome(explicit)
    if not found:
        return BAD, ("no Chrome/Chromium/Edge found - install one, or set "
                     "browser.chrome_path in config.json")
    return OK, str(found)


def check_dirs() -> tuple[str, str]:
    made = []
    for name in ("swipe", "drafts", "shots", "scratch"):
        (ROOT / name).mkdir(exist_ok=True)
        made.append(name)
    return OK, "writable: " + ", ".join(made)


def check_live() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    try:
        import research
        got = research.hn(points=50, hours=24, limit=3)
        out.append((OK, f"Hacker News reachable ({len(got)} stories in 24h)"))
    except Exception as err:
        out.append((BAD, f"Hacker News unreachable: {type(err).__name__}: {str(err)[:70]}"))

    try:
        import research
        items, status = research.rss(hours=48, per_feed=3)
        good = sum(1 for v in status.values() if v.startswith("ok"))
        bad = [k for k, v in status.items() if not v.startswith("ok")]
        lvl = OK if good else BAD
        extra = f" - failing: {', '.join(bad[:4])}" if bad else ""
        out.append((lvl, f"RSS feeds: {good}/{len(status)} reachable{extra}"))
    except Exception as err:
        out.append((BAD, f"RSS check failed: {type(err).__name__}: {str(err)[:70]}"))

    try:
        import browser
        if not browser.alive():
            browser.ensure_chrome()
        out.append((OK, f"automation browser up on port {browser._port()}"))
    except Exception as err:
        out.append((WARN, f"browser not running: {str(err)[:80]} "
                          f"- it starts on demand, so this is only a problem if it persists"))
        return out

    try:
        import post
        info = post.asyncio.run(post.session_info())
        if info.get("logged_in"):
            out.append((OK, f"X session live as @{info['handle']}"))
        else:
            out.append((WARN, "X session is NOT logged in - sign in to x.com in the "
                              "automation browser window"))
    except Exception as err:
        out.append((WARN, f"could not check the X session: {str(err)[:80]}"))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also test network + browser")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    results = [("python", check_python()), ("dependencies", check_deps()),
               ("config", check_config()), ("chrome", check_chrome()),
               ("directories", check_dirs())]
    if a.live:
        results += [("live", r) for r in check_live()]

    if a.json:
        print(json.dumps([{"check": k, "status": s, "detail": d} for k, (s, d) in results],
                         indent=2))
        return

    icon = {OK: "OK     ", WARN: "WARN   ", BAD: "MISSING"}
    print("\ntweetytweets - readiness\n" + "=" * 60)
    worst = OK
    for name, (status, detail) in results:
        print(f"[{icon[status]}] {name:<14} {detail}")
        if status == BAD:
            worst = BAD
        elif status == WARN and worst == OK:
            worst = WARN
    print("=" * 60)
    blocked = sum(1 for _, (s, _) in results if s == BAD)
    if blocked:
        print(f"{blocked} blocking item(s). Fix those, then re-run this.")
    else:
        print("Nothing blocking. Next: python scripts/due.py make-plan, "
              "then have your agent write and fill the drafts.")
    if not a.live:
        print("(network and browser were not tested - re-run with --live)")


if __name__ == "__main__":
    main()
