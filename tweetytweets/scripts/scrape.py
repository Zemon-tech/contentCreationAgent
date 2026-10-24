#!/usr/bin/env python
"""Scrape posts from any public X account through the logged-in browser session.

No X API, no developer account, no paid tier. This reuses the SAME dedicated,
signed-in CDP browser that post.py publishes through: X requires a login to
render almost anything now, so a logged-in real browser is the only reliable
way to read a profile for free.

How it works:
  1. open https://x.com/<handle> in the automation browser (already signed in),
  2. scroll the timeline to lazy-load posts (X renders them in on scroll),
  3. harvest each <article data-testid="tweet"> as it appears, de-duplicated by
     status URL, until we have enough or run out of new posts.

Only PUBLIC, already-visible timeline posts are read. Nothing is posted, liked,
followed, or otherwise written - this is read-only.

CLI:
  python scrape.py user --handle nasa --limit 50
  python scrape.py user --handle nasa --limit 100 --include-replies --max-scrolls 40
  python scrape.py user --handle nasa --json-only     # machine-readable, no prose
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import browser
from browser import CDPError, Session

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent


# ------------------------------------------------------------------ session

LOGIN_JS = r"""
(() => {
  const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  const raw = btn ? (btn.innerText || '') : '';
  const m = raw.match(/@([A-Za-z0-9_]{1,20})/);
  const prof = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const ph = prof ? (prof.getAttribute('href') || '').replace(/^\//, '') : null;
  const h = (m ? m[1] : ph) || null;
  const login_form = !!document.querySelector('input[name="text"], input[autocomplete="username"]');
  return JSON.stringify({handle: h, logged_in: !!h, login_form});
})()
"""


async def _open(url: str) -> Session:
    ws = await browser.open_page(url)
    sess = Session(ws)
    page = await sess.__aenter__()
    await page.send("Page.enable")
    await page.send("Runtime.enable")
    return page


async def _wait_login(page: Session, timeout: float = 25.0) -> dict:
    """Poll until the session proves itself by exposing the account handle.

    The URL alone lies: x.com renders a login page inline for a beat before
    redirecting, so a URL-only check reports logged-in while the account
    switcher is still absent.
    """
    deadline = time.time() + timeout
    info: dict = {}
    while time.time() < deadline:
        try:
            info = json.loads(await page.eval(LOGIN_JS) or "{}")
        except (CDPError, OSError, asyncio.TimeoutError):
            info = {}
        if info.get("handle") or info.get("login_form"):
            return info
        await asyncio.sleep(1.0)
    return info


# ------------------------------------------------------------------ harvest

# Walk every rendered tweet article and pull the fields that survive without an
# API: text, canonical status URL, author handle, ISO timestamp, and the
# engagement counts X exposes in the aria-labels of the action bar.
HARVEST_JS = r"""
(() => {
  const metric = (art, testid) => {
    const el = art.querySelector('[data-testid="' + testid + '"]');
    if (!el) return null;
    const label = el.getAttribute('aria-label') || el.innerText || '';
    const m = label.replace(/,/g, '').match(/([\d.]+)\s*([KM]?)/i);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1e3;
    if (suf === 'M') n *= 1e6;
    return Math.round(n);
  };
  const out = [];
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const textEl = art.querySelector('[data-testid="tweetText"]');
    const timeEl = art.querySelector('time');
    const link = timeEl ? timeEl.closest('a[href*="/status/"]') : art.querySelector('a[href*="/status/"]');
    const href = link ? link.getAttribute('href') : '';
    const statusUrl = href ? ('https://x.com' + href) : '';
    const handleMatch = href ? href.match(/^\/([A-Za-z0-9_]{1,20})\/status\//) : null;
    const isReply = !!art.querySelector('[data-testid="socialContext"]') &&
                    /replying to/i.test((art.querySelector('[data-testid="socialContext"]')||{}).innerText || '');
    const isRepost = /reposted/i.test((art.querySelector('[data-testid="socialContext"]')||{}).innerText || '');
    out.push({
      text: textEl ? textEl.innerText : '',
      url: statusUrl,
      author_handle: handleMatch ? handleMatch[1] : null,
      at: timeEl ? timeEl.getAttribute('datetime') : '',
      is_reply: isReply,
      is_repost: isRepost,
      replies: metric(art, 'reply'),
      reposts: metric(art, 'retweet'),
      likes: metric(art, 'like'),
      views: (() => {
        const a = art.querySelector('a[href*="/analytics"]');
        if (!a) return null;
        const m = (a.getAttribute('aria-label') || a.innerText || '').replace(/,/g,'').match(/([\d.]+)\s*([KM]?)/i);
        if (!m) return null;
        let n = parseFloat(m[1]); const s=(m[2]||'').toUpperCase();
        if (s==='K') n*=1e3; if (s==='M') n*=1e6; return Math.round(n);
      })(),
    });
  }
  return JSON.stringify(out);
})()
"""


async def scrape_user(handle: str, limit: int = 50, include_replies: bool = False,
                      max_scrolls: int = 30, settle: float = 6.0) -> dict:
    handle = handle.strip().lstrip("@")
    if not handle:
        raise SystemExit(json.dumps({"error": "no handle given"}, indent=2))

    browser.ensure_chrome()
    page = await _open(f"https://x.com/{handle}")
    try:
        await browser.settle_page(page, settle)
        login = await _wait_login(page)
        if login.get("login_form") and not login.get("logged_in"):
            return {
                "error": "not logged in",
                "fix": "sign in to x.com in the automation browser window "
                       "(run launchXBrowser / browser.py launch), then re-run",
            }

        # Is the profile reachable at all? X shows an empty state for
        # suspended / nonexistent / protected accounts.
        state = await page.eval(r"""
          (() => {
            const t = document.body ? document.body.innerText : '';
            return JSON.stringify({
              not_found: /This account doesn.?t exist/i.test(t),
              suspended: /Account suspended/i.test(t),
              protected: /These posts are protected/i.test(t),
            });
          })()
        """)
        st = json.loads(state or "{}")
        if st.get("not_found"):
            return {"error": f"account @{handle} does not exist"}
        if st.get("suspended"):
            return {"error": f"account @{handle} is suspended"}
        if st.get("protected"):
            return {"error": f"account @{handle} is protected; its posts are not public"}

        collected: dict[str, dict] = {}
        stale_rounds = 0
        for _ in range(max_scrolls):
            try:
                rows = json.loads(await page.eval(HARVEST_JS) or "[]")
            except (CDPError, OSError, asyncio.TimeoutError) as err:
                print(f"  ! harvest eval failed: {err}", file=sys.stderr)
                rows = []

            before = len(collected)
            for r in rows:
                url = r.get("url")
                if not url:
                    continue
                if not include_replies and r.get("is_reply"):
                    continue
                # Keep only posts authored by the profile owner (the profile
                # timeline interleaves the owner's reposts of others).
                ah = (r.get("author_handle") or "").lower()
                if ah and ah != handle.lower() and not r.get("is_repost"):
                    continue
                collected.setdefault(url, r)

            if len(collected) >= limit:
                break

            # No new posts after a scroll twice in a row => end of timeline.
            if len(collected) == before:
                stale_rounds += 1
                if stale_rounds >= 2:
                    break
            else:
                stale_rounds = 0

            await page.eval("window.scrollBy(0, Math.round(window.innerHeight * 0.9));")
            await asyncio.sleep(1.6)

        posts = list(collected.values())[:limit]
        return {
            "handle": handle,
            "count": len(posts),
            "profile_url": f"https://x.com/{handle}",
            "posts": posts,
        }
    finally:
        await page.__aexit__(None, None, None)
        try:
            browser.close_tabs_matching(f"/{handle}")
        except Exception:
            pass


# ------------------------------------------------------------------ cli

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", default="user", choices=["user"])
    ap.add_argument("--handle", required=True, help="account handle, with or without @")
    ap.add_argument("--limit", type=int, default=50, help="max posts to return")
    ap.add_argument("--include-replies", action="store_true",
                    help="also include the account's replies (off by default)")
    ap.add_argument("--max-scrolls", type=int, default=30,
                    help="scroll iterations ceiling (guards against infinite scroll)")
    ap.add_argument("--json-only", action="store_true",
                    help="print only the JSON payload (no trailing newline prose)")
    a = ap.parse_args()

    out = asyncio.run(scrape_user(
        a.handle, limit=a.limit, include_replies=a.include_replies,
        max_scrolls=a.max_scrolls))
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
