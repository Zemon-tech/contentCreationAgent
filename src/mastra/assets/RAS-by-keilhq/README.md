# RAS brand logos for the Satori renderer

Drop the Rise & Shine (RAS) by KeilHQ logo PNGs into **this folder**
(`src/mastra/assets/RAS-by-keilhq/`). The render tools reference them by exact filename.

| Filename                        | Variant                | Suggested size | Used on                          |
| ------------------------------- | ---------------------- | -------------- | -------------------------------- |
| `ras-logo-dark.png`             | Full lockup (dark art) | ~500×250       | Carousel cover masthead          |
| `ras-logo-light.png`            | Full lockup (light art)| ~500×250       | Light backgrounds                |
| `ras-by-keilhq-logo-dark.png`   | Symbol (for dark bg)   | ~160×160       | Story hero top-left mark         |
| `ras-by-keilhq-logo-light.png`  | Symbol (for light bg)  | ~160×124       | Story footer mark                |

Notes
- "dark" / "light" describes the **art color**, i.e. which background it sits on. A dark-background scrim uses the light-art logo and vice versa.
- Transparent PNGs are strongly preferred.
- You already have `*-light-mode.png` / `*-dark-mode.png` variants under `design-agent/assets/`.
  Either copy + rename them to the names above, or tell me the names you want and I'll
  adjust the renderer to match.
