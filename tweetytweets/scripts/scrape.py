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
  python scrape.py search --query "openai" --tab top --limit 40
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.parse
from pathlib import Path

import browser
from browser import CDPError, Session

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent

# ------------------------------------------------------------------ tunables
# Every magic number lives here with a conservative default; override via env.


def _env_int(name: str, dflt: int) -> int:
    v = os.environ.get(name)
    if v is None:
        return dflt
    try:
        n = int(v.strip())
        return n if n > 0 else dflt
    except (ValueError, AttributeError):
        return dflt


# How long to wait (ms) after clicking "Show more" controls for the re-render.
SHOW_MORE_WAIT_MS = _env_int("X_SCRAPE_SHOW_MORE_WAIT_MS", 800)
# Cap on how many posts a single self-thread run contributes thread_texts for.
THREAD_TEXTS_CAP = _env_int("X_SCRAPE_THREAD_TEXTS_CAP", 5)


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
# API: text, canonical status URL, author handle, ISO timestamp, the engagement
# counts X exposes in the aria-labels of the action bar, plus (enrichment)
# outbound links, a truncation flag, and the quoted-tweet subtree.
#
# FIX #1: dom_index is NOT stamped here. The caller owns a monotonic counter and
# assigns dom_index exactly once, when a URL is first seen (see scrape_user).
#
# Every DOM read uses optional chaining / guards so a markup change degrades a
# single field instead of throwing and killing the whole harvest.
HARVEST_JS = r"""
(() => {
  const parseCount = (s) => {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KM]?)/i);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1e3;
    if (suf === 'M') n *= 1e6;
    return Math.round(n);
  };
  // Metric read scoped to the OUTER tweet: pass the quote subtree to exclude so
  // a quoted tweet's own counts never leak into the outer post.
  const metric = (art, testid, quoteRoot) => {
    for (const el of art.querySelectorAll('[data-testid="' + testid + '"]')) {
      if (quoteRoot && quoteRoot.contains(el)) continue;
      const label = el.getAttribute('aria-label') || el.innerText || '';
      const v = parseCount(label);
      return v == null ? 0 : v;
    }
    return null;
  };
  const stripEllipsis = (s) => (s || '').replace(/[\u2026…]+\s*$/, '').trim();
  const hasTld = (s) => /\.[a-z]{2,}([\/:?#]|$)/i.test(s || '');
  const out = [];
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    // The quoted-tweet subtree, if any: a nested div[role="link"] that itself
    // contains a status link. Everything below is scoped to EXCLUDE it.
    let quoteRoot = null;
    for (const cand of art.querySelectorAll('div[role="link"]')) {
      if (cand.querySelector('a[href*="/status/"]')) { quoteRoot = cand; break; }
    }
    const inQuote = (el) => quoteRoot && quoteRoot.contains(el);

    // Outer tweet text: the first tweetText NOT inside the quote subtree.
    let textEl = null;
    for (const t of art.querySelectorAll('[data-testid="tweetText"]')) {
      if (!inQuote(t)) { textEl = t; break; }
    }

    // Outer status link / handle / timestamp (skip the quote subtree).
    let timeEl = null;
    for (const t of art.querySelectorAll('time')) {
      if (!inQuote(t)) { timeEl = t; break; }
    }
    let link = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
    if (!link || inQuote(link)) {
      link = null;
      for (const a of art.querySelectorAll('a[href*="/status/"]')) {
        if (!inQuote(a)) { link = a; break; }
      }
    }
    const href = link ? (link.getAttribute('href') || '') : '';
    const statusUrl = href ? ('https://x.com' + href) : '';
    const handleMatch = href ? href.match(/^\/([A-Za-z0-9_]{1,20})\/status\//) : null;

    const socialEl = art.querySelector('[data-testid="socialContext"]');
    const socialTxt = socialEl ? (socialEl.innerText || '') : '';
    const isReply = !!socialEl && /replying to/i.test(socialTxt);
    const isRepost = /reposted/i.test(socialTxt);

    // text_truncated: a show-more control still present on the OUTER tweet after
    // the pre-harvest click pass means the full text never rendered.
    let textTruncated = false;
    for (const sm of art.querySelectorAll('[data-testid="tweet-text-show-more-link"]')) {
      if (!inQuote(sm)) { textTruncated = true; break; }
    }
    if (!textTruncated && textEl) {
      // Fallback: a visible "Show more" affordance inside the text region.
      for (const a of textEl.parentElement ? textEl.parentElement.querySelectorAll('span,a,div') : []) {
        if (/^show more$/i.test((a.innerText || '').trim())) { textTruncated = true; break; }
      }
    }

    // outbound_urls: anchors in the OUTER tweet text/card region. DOM-only, no
    // navigation. Prefer an absolute `title`, else reconstruct from innerText,
    // else keep the raw t.co href. Drop x.com/twitter.com. Dedupe.
    const outbound = [];
    const seenOut = new Set();
    const anchorRoots = [];
    if (textEl) anchorRoots.push(textEl);
    const card = art.querySelector('[data-testid="card.wrapper"]');
    if (card && !inQuote(card)) anchorRoots.push(card);
    for (const root of anchorRoots) {
      for (const a of root.querySelectorAll('a[href]')) {
        if (inQuote(a)) continue;
        const rawHref = a.getAttribute('href') || '';
        const title = a.getAttribute('title') || '';
        const txt = stripEllipsis(a.innerText || '');
        let resolved = '';
        if (/^https?:\/\//i.test(title)) {
          resolved = title;
        } else if (txt && hasTld(txt) && !/[\u2026…]/.test(a.innerText || '')) {
          resolved = /^https?:\/\//i.test(txt) ? txt : ('https://' + txt);
        } else {
          // Could not reconstruct a clean destination: keep the raw t.co href.
          resolved = /^https?:\/\//i.test(rawHref) ? rawHref : ('https://x.com' + rawHref);
        }
        // A candidate still carrying an ellipsis or lacking a TLD is unusable;
        // fall back to the raw t.co href.
        if (/[\u2026…]/.test(resolved) || !hasTld(resolved)) {
          resolved = /^https?:\/\//i.test(rawHref) ? rawHref : ('https://x.com' + rawHref);
        }
        let host = '';
        try { host = new URL(resolved).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { host = ''; }
        if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') continue;
        if (!resolved || seenOut.has(resolved)) continue;
        seenOut.add(resolved);
        outbound.push(resolved);
      }
    }

    // quoted: pull text/handle/url/at from the nested quote subtree.
    let quoted = null;
    if (quoteRoot) {
      const qLink = quoteRoot.querySelector('a[href*="/status/"]');
      const qHref = qLink ? (qLink.getAttribute('href') || '') : '';
      const qUrl = qHref ? ('https://x.com' + qHref) : '';
      const qHandleMatch = qHref ? qHref.match(/^\/([A-Za-z0-9_]{1,20})\/status\//) : null;
      let qHandle = qHandleMatch ? qHandleMatch[1] : null;
      if (!qHandle) {
        const hm = (quoteRoot.innerText || '').match(/@([A-Za-z0-9_]{1,20})/);
        qHandle = hm ? hm[1] : null;
      }
      const qTextEl = quoteRoot.querySelector('[data-testid="tweetText"]');
      const qTimeEl = quoteRoot.querySelector('time');
      quoted = {
        text: qTextEl ? qTextEl.innerText : '',
        author_handle: qHandle,
        url: qUrl,
        at: qTimeEl ? (qTimeEl.getAttribute('datetime') || '') : '',
      };
    }

    out.push({
      text: textEl ? textEl.innerText : '',
      url: statusUrl,
      author_handle: handleMatch ? handleMatch[1] : null,
      at: timeEl ? (timeEl.getAttribute('datetime') || '') : '',
      is_reply: isReply,
      is_repost: isRepost,
      replies: metric(art, 'reply', quoteRoot),
      reposts: metric(art, 'retweet', quoteRoot),
      likes: metric(art, 'like', quoteRoot),
      views: (() => {
        for (const a of art.querySelectorAll('a[href*="/analytics"]')) {
          if (quoteRoot && quoteRoot.contains(a)) continue;
          return parseCount(a.getAttribute('aria-label') || a.innerText || '');
        }
        return null;
      })(),
      outbound_urls: outbound,
      text_truncated: textTruncated,
      quoted: quoted,
    });
  }
  return JSON.stringify(out);
})()
"""


# Click every visible "Show more" control so the full text renders before we
# harvest. DOM-only clicks on text-expand links; never navigates. Returns the
# number of controls clicked so the caller can decide whether to wait.
SHOW_MORE_JS = r"""
(() => {
  let clicked = 0;
  for (const el of document.querySelectorAll('[data-testid="tweet-text-show-more-link"]')) {
    try { el.click(); clicked++; } catch (e) {}
  }
  return JSON.stringify({ clicked });
})()
"""


# Detect a hard stop (login wall / captcha / "unusual activity" / 429). Pure
# read-only probe; never attempts to solve or bypass anything.
DETECT_BLOCK_JS = r"""
(() => {
  const body = document.body ? (document.body.innerText || '') : '';
  const title = document.title || '';
  const login_wall = !!document.querySelector('input[name="text"], input[autocomplete="username"], [data-testid="LoginForm_Login_Button"]');
  const captcha = !!document.querySelector('[data-testid="arkoseFrame"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]')
    || /verify you.?re human|are you a robot/i.test(body);
  const unusual_activity = /unusual activity|suspicious/i.test(body);
  const http_429 = /rate limit|too many requests/i.test(title) || /rate limit|too many requests/i.test(body);
  return JSON.stringify({ login_wall, captcha, unusual_activity, http_429 });
})()
"""


async def _click_show_more(page: Session) -> None:
    """Best-effort: expand truncated tweets, then wait for the re-render."""
    try:
        res = json.loads(await page.eval(SHOW_MORE_JS) or "{}")
        if res.get("clicked"):
            await asyncio.sleep(SHOW_MORE_WAIT_MS / 1000.0)
    except (CDPError, OSError, asyncio.TimeoutError):
        pass


async def detect_block(page: Session) -> dict:
    """Return {login_wall, captcha, unusual_activity, http_429} booleans.

    Read-only. A True on any key means we abort the X branch immediately; we
    never retry in the same session and never attempt to solve a challenge.
    """
    try:
        return json.loads(await page.eval(DETECT_BLOCK_JS) or "{}")
    except (CDPError, OSError, asyncio.TimeoutError):
        return {}


def _block_stop_reason(block: dict) -> str | None:
    """Map a detect_block result to a single stop_reason, or None."""
    if not block:
        return None
    for key in ("login_wall", "captcha", "unusual_activity", "http_429"):
        if block.get(key):
            return key
    return None


def attach_thread_texts(posts: list[dict], cap: int = THREAD_TEXTS_CAP) -> list[dict]:
    """Group consecutive same-author, non-repost posts into self-threads.

    Sorts by dom_index, walks runs of adjacent posts by the same author that are
    not reposts, and sets `thread_texts` (capped) on the FIRST post of each run;
    every other post gets []. Best-effort: on any ambiguity it leaves [] and it
    never raises.
    """
    try:
        ordered = sorted(posts, key=lambda p: p.get("dom_index", 0))
        for p in posts:
            p["thread_texts"] = []
        i = 0
        n = len(ordered)
        while i < n:
            head = ordered[i]
            author = (head.get("author_handle") or "").lower()
            # A run needs a known author and must not start on a repost.
            if not author or head.get("is_repost"):
                i += 1
                continue
            run = [head]
            j = i + 1
            while j < n:
                nxt = ordered[j]
                if nxt.get("is_repost"):
                    break
                if (nxt.get("author_handle") or "").lower() != author:
                    break
                run.append(nxt)
                j += 1
            if len(run) > 1:
                texts = [(r.get("text") or "") for r in run][:cap]
                head["thread_texts"] = texts
            i = j
        return posts
    except Exception:
        for p in posts:
            if "thread_texts" not in p:
                p["thread_texts"] = []
        return posts


async def _scroll_and_harvest(page: Session, limit: int, max_scrolls: int,
                              keep) -> dict:
    """Shared scroll+harvest loop for both profile and search timelines.

    `keep(row)` decides whether a harvested row is retained. Returns either
    {"blocked": True, "stop_reason": ...} if a hard stop appears, or
    {"posts": [...]} with dom_index stamped monotonically on first sighting.

    FIX #1: a monotonic counter assigns dom_index exactly once, in the branch
    where a URL is first inserted into `collected`.
    """
    # A hard stop can appear at any point; probe once up front before scrolling.
    stop = _block_stop_reason(await detect_block(page))
    if stop:
        return {"blocked": True, "stop_reason": stop}

    collected: dict[str, dict] = {}
    next_index = 0
    stale_rounds = 0
    for _ in range(max_scrolls):
        # Expand truncated tweets before harvesting so text_truncated is honest.
        await _click_show_more(page)
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
            if not keep(r):
                continue
            if url not in collected:
                r["dom_index"] = next_index
                next_index += 1
                collected[url] = r

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
    posts = attach_thread_texts(posts)
    return {"posts": posts}


async def scrape_user(handle: str, limit: int = 50, include_replies: bool = False,
                      max_scrolls: int = 30, settle: float = 6.0) -> dict:
    handle = handle.strip().lstrip("@")
    if not handle:
        raise SystemExit(json.dumps({"error": "no handle given"}, indent=2))

    browser.ensure_chrome()
    page = await _open(f"https://x.com/{handle}")
    try:
        await browser.settle_page(page, settle)

        # Detect a hard stop first: login wall / captcha / unusual activity / 429.
        stop = _block_stop_reason(await detect_block(page))
        if stop:
            return {"error": "blocked", "stop_reason": stop}

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

        def keep(r: dict) -> bool:
            if not include_replies and r.get("is_reply"):
                return False
            # Keep only posts authored by the profile owner (the profile
            # timeline interleaves the owner's reposts of others).
            ah = (r.get("author_handle") or "").lower()
            if ah and ah != handle.lower() and not r.get("is_repost"):
                return False
            return True

        result = await _scroll_and_harvest(page, limit, max_scrolls, keep)
        if result.get("blocked"):
            return {"error": "blocked", "stop_reason": result["stop_reason"]}

        posts = result["posts"]
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


async def scrape_search(query: str, tab: str = "top", max_scrolls: int = 20,
                        limit: int = 40, settle: float = 6.0) -> dict:
    query = (query or "").strip()
    if not query:
        raise SystemExit(json.dumps({"error": "no query given"}, indent=2))

    tab = (tab or "top").strip().lower()
    f = "live" if tab == "latest" else "top"
    q = urllib.parse.quote(query)
    url = f"https://x.com/search?q={q}&src=typed_query&f={f}"

    browser.ensure_chrome()
    page = await _open(url)
    try:
        await browser.settle_page(page, settle)

        stop = _block_stop_reason(await detect_block(page))
        if stop:
            return {"error": "blocked", "stop_reason": stop}

        login = await _wait_login(page)
        if login.get("login_form") and not login.get("logged_in"):
            return {
                "error": "not logged in",
                "fix": "sign in to x.com in the automation browser window "
                       "(run launchXBrowser / browser.py launch), then re-run",
            }

        # Search keeps everything the timeline renders; dedupe is by URL in the
        # shared loop. Replies/reposts are left in so corroboration can see them.
        result = await _scroll_and_harvest(page, limit, max_scrolls, lambda r: True)
        if result.get("blocked"):
            return {"error": "blocked", "stop_reason": result["stop_reason"]}

        posts = result["posts"]
        return {
            "query": query,
            "tab": "latest" if f == "live" else "top",
            "count": len(posts),
            "posts": posts,
        }
    finally:
        await page.__aexit__(None, None, None)
        try:
            browser.close_tabs_matching("/search")
        except Exception:
            pass


# ------------------------------------------------------------------ cli

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", default="user", choices=["user", "search"],
                    help="what to scrape: a user timeline or a search query")
    ap.add_argument("--handle", help="account handle, with or without @ (required for 'user')")
    ap.add_argument("--query", help="search query (required for 'search')")
    ap.add_argument("--tab", choices=["top", "latest"], default="top",
                    help="search tab: 'top' (default) or 'latest'")
    ap.add_argument("--limit", type=int, default=50, help="max posts to return")
    ap.add_argument("--include-replies", action="store_true",
                    help="also include the account's replies (off by default)")
    ap.add_argument("--max-scrolls", type=int, default=30,
                    help="scroll iterations ceiling (guards against infinite scroll)")
    ap.add_argument("--json-only", action="store_true",
                    help="print only the JSON payload (no trailing newline prose)")
    a = ap.parse_args()

    if a.cmd == "user" and not a.handle:
        ap.error("the 'user' command requires --handle")
    if a.cmd == "search" and not a.query:
        ap.error("the 'search' command requires --query")

    if a.cmd == "search":
        out = asyncio.run(scrape_search(
            a.query, tab=a.tab, max_scrolls=a.max_scrolls, limit=a.limit))
    else:
        out = asyncio.run(scrape_user(
            a.handle, limit=a.limit, include_replies=a.include_replies,
            max_scrolls=a.max_scrolls))
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
