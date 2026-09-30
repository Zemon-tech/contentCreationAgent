# Model Adaptation (style fixed, syntax varies)

## general (default) — model-agnostic natural language
Order: medium + hero + metaphor + composition + contrast + color + texture + light + mood.
No vendor flags. `model_parameters: {}`.

## midjourney — concept seed, discovery room
CONCEPT + STYLE + DETAILS + COMPOSITION + params at end.
Official (docs.midjourney.com 2026): short prompts win; params `--ar --s/--stylize --c/--chaos
--no --sref --sw --cw --style raw --v --q --weird --tile --seed`; place params last, no commas.
V8 notes: 30–60 words, natural sentences, personalization carries aesthetics.
Strategy: concise seed, `--ar 16:9`, low-mid `--s`, `--no glossy CGI, stock photo, bokeh, text, watermark`;
use `--sref` only with user reference; `--style raw` for photographic adaptations.

## openai (gpt-image-1/2/2.5) — instructable paragraph
Per developers.openai.com/api/docs/guides/image-prompting: define result + use
(scene/subject/details/constraints), labeled sections OK, assign reference roles
("reference 1 = style…"), state exclusions ("no text, no watermark"), iterate one change.
No `--` params. Put `size/quality` in generation_parameters.model_parameters
(e.g. `{"size":"1536x1024","quality":"high"}`). Strong world-knowledge + text rendering:
quote exact text.

## flux (FLUX.1/2/pro/max/kontext) — front-loaded
Per docs.bfl.ml: Subject+Action+Style+Context, most important first, 30–80 words sweet
spot, ≤512 tokens, natural sentences not keyword dumps, HEX as "the X is #HEX",
JSON-structured OK. NO negative prompts — keep negative_prompt.enabled=false.
Kontext edits: name change + what to preserve.

## google (Imagen/Gemini) — descriptive + quoted text
Per ai.google.dev / DeepMind Nano Banana guide: Subject+Composition+Action+Location+Style,
descriptive adjectives, iterate bit-by-bit, `"exact text"` in quotes + font hint,
aspect in words ("vertical social post"). Conversational edits supported.
