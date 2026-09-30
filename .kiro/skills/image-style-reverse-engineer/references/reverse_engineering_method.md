# 18-Dimension Visual Forensics Framework

Method synthesized from: Midjourney `/describe` + `--sref/--cref` practice, CLIP-Interrogator 4-layer extraction (subject/medium/lighting/camera), Higgsfield Soul preset logic, and commercial cinematography reverse-engineering.

## How to inspect (order matters)

Describe STYLE only. For each dimension ask the question, then record a transferable rule (not a caption of the source).

| # | Dimension | Ask | Record as (transferable) |
|---|---|---|---|
| 1 | Medium & realism | Photo, 3D, illustration, paint? What gives it away (pores vs brush vs render smoothness)? | `photoeditorial-flash / analog-35mm / UE5-render / gouache / risograph` + realism 1–5 |
| 2 | Composition geometry | Symmetry? Rule-of-thirds? Centered? Leading lines, frames-within-frame? | framing rule + plane split FG/MG/BG + eye path 1→2→3 |
| 3 | Shot scale | Close-up / medium / wide / aerial? Cropping tight or airy? | shot type + subject-to-environment ratio |
| 4 | Optics, lens, DOF | Wide distortion (24mm) / normal (35–50mm) / compressed tele (85mm+)? Focus plane? Bokeh shape? | focal length + aperture + DOF + focus priority |
| 5 | Lighting source | Motivated by what visible fixture? Window, flash, neon, overcast sky, practical lamp? | named in-world source + direction/angle |
| 6 | Lighting quality, Kelvin, ratio | Hard/soft? Temp (2700K tungsten → 5600K daylight → 7000K shade)? Contrast ratio? | quality + Kelvin + ratio (1.5:1 soft … 8:1 hard) + shadow edge |
| 7 | Exposure & dynamic range | Lifted filmic blacks or crushed? Highlight rolloff soft/hard? Clipped? | black point + highlight behavior + overall key (high/low) |
| 8 | Palette (5 colors) | Dominant, secondary, accent? Where does saturation live? | 5 HEX + plain names + saturation map |
| 9 | Grade / LUT | Warm/cool split? Teal shadows + amber skin? Faded matte? High-saturation commercial? | named curve: `Kodak 2383 / Portra-warm / Eterna-pastel / bleach-bypass` |
| 10 | Texture & materiality | Skin (pores/peach-fuzz/plastic)? Fabric weave (canvas/denim/wool/silk)? Surface (grain wood, brushed steel, glass)? | 3+ tactile nouns with light response |
| 11 | Grain, halation, post | 35mm grain / digicam noise / halation bloom / chromatic aberration / sharpening / compression? | film stock + grain size + halation + digital traces |
| 12 | Atmosphere & air | Dust motes, steam, haze, rain sheen, smoke? Clean studio void? | physical air descriptor or `clean-void` |
| 13 | Background logic | Storytelling env vs seamless void vs blurred crowd vs graphic flat? | BG type + depth + detail level |
| 14 | Styling & era | Fashion/design era? Y2K, 90s editorial, contemporary minimal, medieval fantasy, Frutiger Aero? | era + cultural codes + wardrobe/material language |
| 15 | Theme & concept | What idea holds it together (solitude, status, play, ritual, nostalgia)? | 1-sentence conceptual intent |
| 16 | Mood & psychology | Viewer feeling? Intimate, aloof, eerie, euphoric, clinical? | emotion + viewing distance (voyeuristic vs confrontational) |
| 17 | Density & negative space | Cluttered/maximal vs silent/minimal? Where is empty space? | density 1–5 + negative-space location |
| 18 | Instantaneity | Posed studio / frozen mid-action / candid drift / suspended float? | motion state + shutter feel (flash-freeze vs motion blur) |

## CLIP-Interrogator 4-layer shortcut

When short on time, cover minimum: (1) Subject→STRIP, (2) Medium→dimension 1+11, (3) Lighting→5+6+7, (4) Camera→3+4. Then add palette (8) + texture (10) + mood (16). Never ship without palette + lens + Kelvin + film stock.

## Subject-strip rule (critical)

Delete: proper names, celebrity face claims, exact logo/text strings, brand names, plot events ("holding Heinz bottle at Wimbledon"). Keep generic craft: "centered waist-up figure, direct gaze, red condiment-bottle-shaped hero prop" → generalize to "centered waist-up figure with single saturated hero product accent".
