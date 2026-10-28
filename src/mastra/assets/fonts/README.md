# Fonts for the Satori RAS renderer

Drop the following WOFF font files into **this folder** (`src/mastra/assets/fonts/`).
The Satori renderer loads them by exact filename, so names must match.

| Filename                      | Family           | Weight | Used for                              |
| ----------------------------- | ---------------- | ------ | ------------------------------------- |
| `Inter-Regular.woff`          | Inter            | 400    | Body text, decks                      |
| `Inter-Bold.woff`             | Inter            | 700    | Highlights, emphasis                  |
| `Inter-ExtraBold.woff`        | Inter            | 800    | Spec numbers, logo wordmark           |
| `InstrumentSerif-Regular.woff`| Instrument Serif | 400    | Editorial serif headlines, pull quote |
| `IBMPlexMono-Regular.woff`    | IBM Plex Mono    | 400    | Kickers, datelines, tags, metadata    |
| `Anton-Regular.woff`          | Anton            | 400    | Poster story display headline         |

Notes
- Satori needs real font binaries embedded (no system fonts). Prefer `.woff` (what the renderer expects); `.ttf`/`.otf` also work if the loader is updated to match.
- All three families are open source (Inter — OFL, Instrument Serif — OFL, IBM Plex Mono — OFL) so they can ship with the repo.
- Bundled fonts carry Latin glyphs only. The templates avoid non-Latin glyphs and emoji (they would render as empty boxes).
