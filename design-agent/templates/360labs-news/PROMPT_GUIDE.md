# 360labs-news — Image Prompt Guide (COVER vs CONTENT)

Reference: uploaded carousel (TypeSafe AI / Jev, 5 slides, `01/05` cover + content slides).
Canvas: Daybreak Paper `#F4F0E6`, Ink `#151615`, Soft Linen card `#E8E3D9`, footer = official `ras-by-keilhq-light-mode.png`.

Single `hero` slot (`fit: cover`, 16/10 card, grayscale, viewfinder corners).
Slide 0 renders `.is-cover`, slides 1+ render `.is-content` — same slot, different prompt contract:

## COVER (slide 0) — logo card
Layout: eyebrow (`AI NEWS`) → huge headline (announcement) → centered logo card → 2 short body paras → footer.
Image prompt MUST:
- Center ONE company/product logotype on a flat Soft Linen (`#E8E3D9`) studio background
- Perfectly symmetrical, generous empty margins on all sides
- NO people, NO photos, NO text overlays, NO badge/label, NO scenery
- Small viewfinder corner ticks are added by CSS — do not draw them in the image

Example: `flat vector-style mark of "TypeSafe AI" logotype centered on a solid soft-linen #E8E3D9 background, symmetrical, generous margins, minimalist editorial, no people, no photo, no overlay text`

## CONTENT (slides 1+) — editorial photo + overlay badge
Layout: eyebrow → headline (person/idea) → full-bleed B&W photo card → 2–3 body paras with bold highlights → footer.
Image prompt MUST:
- Black-and-white editorial photograph, subject RIGHT-of-center
- Leave the LEFT third as soft blurred copy-space for the overlay ID badge (badge is baked into the image by the generator: two-row bordered box — row 1: small logo mark + `NAME` + `×`, row 2: lowercase `role of Company`)
- Shallow depth of field, blurred office/light background, NO readable body text, NO headlines in image

Example: `black-and-white editorial portrait of a founder in his 30s, three-quarter view looking left, positioned right-of-center, soft blurred office window light background, empty blurred copy-space on the left third for a small two-row bordered ID badge overlay, photorealistic, no readable text besides the badge`

## EVIDENCE variant (e.g. "Why it matters" slide)
Same CONTENT slot: prompt a flat screenshot-style document on Soft Linen — large title + short bullet lines, blurred just enough to read as texture, never dense paragraphs.
