#!/usr/bin/env python
"""Analyse the user's OWN best-performing posts to extract their voice.

This is the onboarding step that makes the writing theirs instead of generic.
The agent asks the user for posts they are proud of (ideally 100k+ impressions),
pastes them into a file, and this script measures the things that are actually
copyable:

  * length habit, and whether the account is on the 280 free-tier ceiling
  * how the hook is built (first 3-6 words) - the single highest-leverage thing
  * paragraph rhythm: how many blank-line-separated beats per post
  * emoji / hashtag / link / number / question usage
  * recurring topics, ranked by frequency across the corpus

It deliberately does NOT judge quality or invent a style - it reports what is
measurably there. The agent turns this into references/voice-profile.local.md.

Input (any of):
  * JSON list of strings
  * JSON list of objects with a text-ish key (text, tweet, content, body)
  * plain text, posts separated by a line of --- or by a blank line

  python voice_profile.py --in my_top_tweets.txt
  python voice_profile.py --in them.json --json
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

import settings

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

STOPWORDS = set("""
a about above after again against all am an and any are aren't as at be because been before being
below between both but by can cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her
here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's
its itself let's me more most mustn't my myself no nor not of off on once only or other ought our
ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than
that that's the their theirs them themselves then there there's these they they'd they'll they're
they've this those through to too under until up very was wasn't we we'd we'll we're we've were
weren't what what's when when's where where's which while who who's whom why why's with won't would
wouldn't you you'd you'll you're you've your yours yourself yourselves just now get got one like
also new use using make makes made really thing things way still even much many lot
""".split())

TEXT_KEYS = ("text", "tweet", "content", "body", "post", "full_text")


def parse(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8", errors="replace").strip()
    if not raw:
        raise SystemExit("input file is empty")

    if raw[0] in "[{":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as err:
            raise SystemExit(f"looks like JSON but will not parse: {err}")
        out: list[str] = []
        for item in data:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                for k in TEXT_KEYS:
                    if isinstance(item.get(k), str) and item[k].strip():
                        out.append(item[k])
                        break
        if not out:
            raise SystemExit("JSON parsed, but no text field found "
                             f"(looked for {', '.join(TEXT_KEYS)})")
        return [t.strip() for t in out if t.strip()]

    # plain text: split on --- fences if present, else on blank lines
    if re.search(r"^\s*-{3,}\s*$", raw, re.M):
        parts = re.split(r"^\s*-{3,}\s*$", raw, flags=re.M)
    else:
        parts = re.split(r"\n\s*\n\s*\n+", raw)
    return [p.strip() for p in parts if len(p.strip()) > 15]


def chars(t: str) -> int:
    return len(t)


def words(t: str) -> list[str]:
    return [w for w in re.findall(r"[a-z][a-z'-]{1,}", t.lower()) if w not in STOPWORDS]


def analyse(posts: list[str]) -> dict:
    lengths = [chars(p) for p in posts]
    beats = [len([b for b in re.split(r"\n\s*\n", p) if b.strip()]) for p in posts]
    all_words = Counter()
    for p in posts:
        all_words.update(words(p))

    hooks = []
    for p in posts:
        first = p.strip().split("\n")[0].strip()
        hooks.append(" ".join(first.split()[:6]))

    opener_kinds = Counter()
    for p in posts:
        first = p.strip().split("\n")[0].strip()
        if not first:
            continue
        if first.endswith("?") or re.match(r"^(how|why|what|who|when|do you|are you|is |can )",
                                           first, re.I):
            opener_kinds["question"] += 1
        elif re.search(r"\d", first):
            opener_kinds["number / specific figure"] += 1
        elif re.match(r"^(stop|don't|never|everyone|nobody|most people|you )", first, re.I):
            opener_kinds["directive / addressed to the reader"] += 1
        else:
            opener_kinds["statement / claim"] += 1

    # Compare the user's own posts against THEIR account's ceiling, not a
    # hardcoded one: the limit differs per account and is measured, not assumed.
    lim = settings.limit()
    cap = lim["chars"]
    under = sum(1 for n in lengths if n <= cap)
    return {
        "posts_analysed": len(posts),
        "length": {
            "min": min(lengths), "median": int(statistics.median(lengths)), "max": max(lengths),
            "mean": round(statistics.mean(lengths)),
            f"under_{cap}": f"{under}/{len(lengths)}",
            "ceiling_used": cap,
            "ceiling_verified": lim["verified"],
            "verdict": (f"all posts fit the account's {cap}-char ceiling"
                        if max(lengths) <= cap else
                        f"some posts exceed the account's {cap}-char ceiling "
                        f"(they were posted anyway, so that ceiling is probably wrong)") +
                       ("" if lim["verified"] else
                        f" - ceiling NOT verified ({lim['fix']})"),
        },
        "structure": {
            "beats_per_post_median": int(statistics.median(beats)),
            "uses_blank_line_breaks": f"{sum(1 for b in beats if b > 1)}/{len(beats)}",
        },
        "devices": {
            "emoji_posts": sum(1 for p in posts if re.search(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", p)),
            "hashtag_posts": sum(1 for p in posts if re.search(r"(^|\s)#\w+", p)),
            "hashtags_total": sum(len(re.findall(r"(^|\s)#\w+", p)) for p in posts),
            "link_posts": sum(1 for p in posts if re.search(r"https?://|t\.co/", p)),
            "number_posts": sum(1 for p in posts if re.search(r"\d", p)),
            "question_posts": sum(1 for p in posts if "?" in p),
            "emoji_total": sum(len(re.findall(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", p))
                               for p in posts),
        },
        "hook_openers": dict(opener_kinds.most_common()),
        "hook_first_words": [h for h in hooks],
        "recurring_topics": [{"term": w, "posts": c} for w, c in all_words.most_common(25)],
    }


def render(a: dict, path: str) -> str:
    L, S, D = a["length"], a["structure"], a["devices"]
    n = a["posts_analysed"]
    lines = [
        f"VOICE PROFILE — measured from {n} posts ({path})",
        "=" * 62,
        "",
        "LENGTH",
        f"  min {L['min']} | median {L['median']} | mean {L['mean']} | max {L['max']} chars",
        "  within the account's {}-char ceiling: {}   -> {}".format(
            L["ceiling_used"], L.get("under_" + str(L["ceiling_used"])), L["verdict"]),
        "",
        "STRUCTURE",
        f"  beats per post (blank-line separated): median {S['beats_per_post_median']}",
        f"  uses blank-line breaks: {S['uses_blank_line_breaks']}",
        "",
        "DEVICES (how many posts use each)",
        f"  numbers       {D['number_posts']}/{n}",
        f"  questions     {D['question_posts']}/{n}",
        f"  links         {D['link_posts']}/{n}",
        f"  hashtags      {D['hashtag_posts']}/{n} posts, {D['hashtags_total']} total",
        f"  emoji         {D['emoji_posts']}/{n} posts, {D['emoji_total']} total",
        "",
        "HOOK SHAPE — how they open",
    ]
    for k, v in a["hook_openers"].items():
        lines.append(f"  {v:>3}x  {k}")
    lines += ["", "THE ACTUAL FIRST 6 WORDS (pattern-match these):"]
    for i, h in enumerate(a["hook_first_words"], 1):
        lines.append(f"  {i:>2}. {h}")
    lines += ["", "RECURRING TOPICS (stopwords removed, by frequency):"]
    row = []
    for t in a["recurring_topics"]:
        row.append(f"{t['term']}({t['posts']})")
    lines.append("  " + "  ".join(row))
    lines += ["",
              "NEXT: your agent turns this into references/voice-profile.local.md, and every",
              "draft is written against it. This file is git-ignored - it is your voice, not",
              "part of the shared skill."]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--out", default=None, help="where to write the report (default: stdout)")
    ap.add_argument("--json", action="store_true", help="raw JSON instead of the report")
    a = ap.parse_args()

    path = Path(a.infile)
    if not path.exists():
        raise SystemExit(f"no such file: {path}")
    posts = parse(path)
    if len(posts) < 3:
        raise SystemExit(f"only found {len(posts)} posts - give me at least 3, ideally 10-20 "
                         "of your best. Separate them with a line of --- or a blank line.")
    result = analyse(posts)
    text = json.dumps(result, indent=2, ensure_ascii=False) if a.json else render(result, path.name)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"wrote {a.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
