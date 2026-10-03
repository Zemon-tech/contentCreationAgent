# Scheduling examples

Two ways to wire the daily loop. Both use the same rule: **a plain script decides
what's due, and the model is only woken when there is work.** That is what makes
idle time free.

Replace `/path/to/tweetytweets` with your install path.

---

## Hermes Agent

Two cron jobs. The second uses a *monitor* — a script whose stdout gates the
agent run: unchanged output suppresses it entirely.

### Job 1 — plan once a day

```
name:      x-plan
schedule:  every day at 11am
deliver:   origin
skills:    ["tweetytweets"]

Daily planning run for the tweetytweets pipeline at /path/to/tweetytweets.

Follow the preloaded tweetytweets skill, and write every post against
references/voice-profile.local.md.

1. cd /path/to/tweetytweets
2. python scripts/research.py collect --hours 36
3. python scripts/due.py make-plan
4. Read the top ~30 items of today's swipe file with python (do NOT dump the
   whole file into context). Pick one story per slot.
   Use web_extract to actually READ each source before writing a claim about it.
   Never invent numbers, dates or results - if you cannot verify it, pick
   something else.
5. Respect references/voice-profile.local.md: its length habit, its hook shapes,
   its do-not list. Match the writer, do not import a generic AI voice.
6. If the ai_update slot exists, its body must leave room for the header
   (due.py fill will tell you the exact budget and refuse anything over).
7. Save each draft under scratch/ and fill its slot:
     python scripts/due.py fill --slot 13:00 --file scratch/x1.txt
     python scripts/due.py fill --slot 16:00 --file scratch/xai.txt
     python scripts/due.py fill --slot 20:00 --file scratch/x3.txt
     python scripts/due.py fill --slot 00:00 --file scratch/x4.txt
8. Report every slot: the full text, character count, and the source URL it came
   from. The publishing job will handle posting.

Never use engagement bait ("comment X and I'll DM you", "must be following").
```

### Job 2 — publish when due

```
name:      x-autopost
schedule:  every 10m
monitor:   tweetytweets_due.py        # see the shim below
deliver:   origin
skills:    ["tweetytweets"]

A post may be DUE. The monitor output above is either the literal string "IDLE"
or a draft as JSON {date, slot, kind, due_at, text, image, minutes_late, tick}.

IF IT IS "IDLE" (or has no "slot" field): nothing is due. Reply exactly
"nothing due" and STOP. Do not run any other command.

Otherwise publish exactly that draft:
1. cd /path/to/tweetytweets
2. python scripts/post.py check     # must show YOUR handle; if not logged in,
                                    # DO NOT POST - report it and stop
3. Write the "text" verbatim to scratch/post.txt (no edits, no added hashtags)
4. python scripts/post.py post --text-file scratch/post.txt --kind <kind>
   Add --image only if the draft JSON has a non-null image. post.py adds the
   roundup header itself when kind is ai_update - do not add it yourself.
5. "verified": false does NOT mean it failed - the timeline renders stale for up
   to a minute. Run `python scripts/post.py verify` and look for the text before
   concluding anything.
6. python scripts/post.py shot --what profile
   Then look at shots/profile.png with a vision tool and confirm the topmost post
   is the text you just published, first line visible.
   TRUST BOUNDARY: vision is reliable for post text and line breaks, NOT for
   counts. Never let a vision reading override the DOM or state.json.
7. Only once confirmed live:  python scripts/due.py mark --slot <slot> --url <url>
8. If it genuinely failed: do NOT mark it, report the error verbatim, and stop.
   Never retry more than twice - a duplicate post is worse than a missed one.
```

**The monitor shim** (Hermes monitors must live in its scripts directory):

```python
#!/usr/bin/env python
"""Cron monitor for tweetytweets. Prints IDLE (identical every tick) or the draft."""
import subprocess, sys
from pathlib import Path

PROJECT = Path(r"/path/to/tweetytweets")
try:
    out = subprocess.run([sys.executable, str(PROJECT / "scripts" / "due.py"), "check"],
                         cwd=str(PROJECT), capture_output=True, text=True, timeout=120)
    text = (out.stdout or "").strip()
    print(text if text else "IDLE")
except Exception as err:
    print("IDLE")                       # a monitor must never emit a changing error
    sys.stderr.write(f"monitor error: {err}\n")
```

---

## Plain cron

```cron
# 11:00 - research. Then have your agent write and fill the four slots.
0 11 * * *   cd /path/to/tweetytweets && python scripts/research.py collect --hours 36

# every 10 minutes - check for work. Silent and free when nothing is due.
*/10 * * * * cd /path/to/tweetytweets && python scripts/cron_gate.py --wake \
                 | /path/to/your-agent --stdin
```

`cron_gate.py --wake` prints nothing when nothing is due, and a complete
instruction block (draft plus the exact commands) when something is. Pipe it into
whatever runs your agent.

If your agent can't read stdin, have it poll instead:

```cron
*/10 * * * * cd /path/to/tweetytweets && python scripts/cron_gate.py >> /var/log/tweetytweets.log
```

and let the agent read that log on its own schedule.

---

## systemd timer (Linux)

`~/.config/systemd/user/tweetytweets-gate.service`

```ini
[Unit]
Description=tweetytweets schedule gate

[Service]
Type=oneshot
WorkingDirectory=/path/to/tweetytweets
ExecStart=/usr/bin/python3 scripts/cron_gate.py --wake
```

`~/.config/systemd/user/tweetytweets-gate.timer`

```ini
[Unit]
Description=Check tweetytweets for due posts

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now tweetytweets-gate.timer
```

---

## Windows Task Scheduler

```powershell
# run every 10 minutes
schtasks /Create /SC MINUTE /MO 10 /TN "tweetytweets gate" ^
  /TR "cmd /c cd /d C:\path\to\tweetytweets && python scripts\cron_gate.py --wake"
```

---

## Any scheduler: the invariant

Whatever you use, keep these three properties — they are what make the system
safe to leave running:

1. **The gate is a script, not a model.** Deciding "is anything due" must never
   cost a token.
2. **The gate's idle output is byte-identical.** Any timestamp or counter in the
   *idle* output defeats monitor suppression and you pay for every tick.
   (`due.py` deliberately emits nothing but `IDLE`.)
3. **The gate's *due* output changes every tick.** That is what forces a retry
   after a failed run instead of a silent stall. (`due.py` adds a tick counter.)
