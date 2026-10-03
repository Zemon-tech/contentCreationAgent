# references/

## `voice-profile.local.md` — your file, deliberately not committed

This is where the measured voice of **your** account lives. It is git-ignored
because it is yours: publishing someone's voice profile by accident is a worse
failure than publishing an empty folder.

Create it during onboarding. The agent writes it after running:

```bash
python scripts/voice_profile.py --in scratch/my_top_tweets.txt
```

Every draft is then written against this file. If it does not exist, the agent is
instructed to go back and ask for your top posts again rather than guess.

### Template to fill in

````markdown
# Voice profile — @<handle>

Measured from <N> posts (<source: pasted from profile / exported>), <date>.
Raw output of `voice_profile.py` is at the bottom of this file.

## The shape of a post
- length: median <N> chars, max <N>  → <free tier 280 ceiling? premium?>
- beats: median <N> blank-line-separated blocks
- line 1 is ALWAYS <what it does — a claim / a number / a direct address>

## Hooks — how they actually open
Paste 5 of your real first lines here, verbatim. Then the pattern in words.
- "<exact first line>"
- "<exact first line>"

Pattern: <e.g. "a specific number in the first six words, then the payoff">

## Recurring topics
<their words, not yours — e.g. "AI tooling for developers, open-weight models,
post-mortems of things I shipped">

## Devices
- numbers: <N>/<N> posts use them → use them
- questions: <...>
- links: <...>
- hashtags: <N> → <never / rarely / on roundups>
- emoji: <N> → <never / sparingly>

## NEVER (the do-not list)
Be specific. This list is what stops the agent drifting into generic AI voice.
- words and phrases: <e.g. "game-changer", "delve", "in today's fast-paced world">
- formats: <e.g. no "threads 🧵", no "bookmark this", no engagement bait>
- topics: <e.g. no politics, no price predictions>
- persona: <e.g. never humble-brags, never uses "we" for a solo account>

## Sounds like
<One short paragraph the agent can hold in mind, written in your register and
corrected by you. Example: "A practitioner explaining something they just
figured out, to peers. Dry, specific, slightly impatient with hype. Ends on the
consequence, not on a call to action.">

## Raw measurement
<paste the full voice_profile.py output here>
````

## Other files you might add

Anything that helps the writer sound like you, and nothing that identifies you
publicly. Common additions:

- `style-examples.md` — 5–10 of your own posts annotated with *why* each worked
  (the hook, the turn, the ending). Keep it factual; this is pattern reference,
  not a scrapbook.
- `admired-accounts.md` — posts from accounts you respect, labelled **structure
  only**. The agent may copy their *shapes*; it must never copy their voice.
- `banned-topics.md` — if your do-not list outgrows the voice profile.

Everything in this directory is loaded as context on every writing run, so keep
it tight. A 400-line voice profile that nobody reads is worse than 30 lines that
get followed.
