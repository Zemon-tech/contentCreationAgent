# PRD: Mastra AI Design Agent for Rise & Shine (RAS) Social Graphics

## 1. Executive Summary & Objective

### 1.1 Goal
Recreate and integrate the Satori-based social graphic generation engine into an existing **Mastra Framework** (`@mastra/core`) project. The resulting Mastra Agent will automatically research topics, structure editorial content, and render production-ready static social media graphics for **Rise & Shine (RAS) by KeilHQ**.

### 1.2 Target Formats
1. **RAS Editorial Story Post** (Single Image, 1080×1350): Full-bleed hero photo, overlaid masthead & category badge, serif thesis headline, context deck with inline accent highlight, 3-metric spec strip, pull quote, and locked brand footer.
2. **RAS Editorial Carousel** (4–5 Slides, 1080×1350 each): Cover hook slide, image-led breakdown slides, text-only strategy slide, and action/CTA slide.

### 1.3 Core Architectural Pattern: Parameterized Templates (Props-Driven)
Instead of forcing the LLM agent to generate raw, fragile JSX/TSX code on every turn (which frequently leads to Satori flexbox bugs, unescaped characters, or layout shifts), the system uses **Parameterized React Templates**:
- **Pre-built Templates:** Pixel-perfect React components implementing Satori layout rules and the RAS brand design system.
- **Structured Agent Output:** The Mastra Agent outputs strongly-typed JSON conforming to a strict **Zod schema**.
- **In-Process Satori Engine:** Mastra Tools feed the JSON into the template and invoke `satori` + `@resvg/resvg-js` directly in Node/TypeScript memory to generate PNG files.

```text
User Topic / Prompt
        │
        ▼
Mastra Agent (Researches with Exa / Synthesizes Editorial Copy)
        │
        ▼
Outputs Structured Zod Payload (Headline, Deck, Specs, Quotes, Slides)
        │
        ▼
Mastra Tool (renderRasStoryTool / renderRasCarouselTool)
        │
        ├─► Injects Props into React Template (RasStoryTemplate / RasCarouselTemplate)
        ├─► Calls satori() (JSX ➔ SVG)
        └─► Calls resvg (SVG ➔ PNG)
        │
        ▼
Production-Ready PNGs in ./output/ (1080×1350)
```

---

## 2. Dependencies & Static Assets

### 2.1 NPM Packages to Install in the Mastra Repo
```bash
npm install satori @resvg/resvg-js react
npm install -D @types/react
```
*(Note: `@mastra/core` and `zod` are already present in your Mastra project).*

### 2.2 Static Assets to Copy from This Repo
Copy the following folders from this repository into the Mastra project (e.g., inside `public/` or `assets/`):

1. **Fonts (`public/fonts/`):**
   - `Inter-Regular.woff`, `Inter-Bold.woff`, `Inter-ExtraBold.woff` (Sans primary)
   - `InstrumentSerif-Regular.woff` (Editorial Serif display & headlines)
   - `IBMPlexMono-Regular.woff` (Monospace kickers, metadata, tags)
2. **Brand Logos (`public/RAS-by-keilhq/`):**
   - `ras-logo-dark.png` (500×250 lockup for dark backgrounds)
   - `ras-logo-light.png` (500×250 lockup for light backgrounds)
   - `ras-by-keilhq-logo-dark.png` (160×160 symbol)
   - `ras-by-keilhq-logo-light.png` (160×124 symbol)
3. **Brand Token Definition:**
   - Copy `public/assets/ras-by-keilhq.json` for reference tokens (palette, spacing, typography).

---

## 3. Brand Tokens & Design Rules

### 3.1 Colors
```ts
export const RAS_THEME = {
  colors: {
    ink: "#151615",                 // Midnight Ink (headlines, dark body)
    paper: "#F4F0E6",               // Daybreak Paper (light editorial background)
    rule: "#D6CFBF",                // Hairline divider
    vermilion: "#F25C3D",           // Daybreak Vermilion (brand marker/signal)
    inkMuted: "rgba(21,22,21,0.60)",// Subtext, dateline, labels
    quoteAccent: "#C7E84A",         // Fresh Lime vertical accent bar
    
    // Category Accents (select one based on domain)
    categories: {
      AI_RESEARCH: "#2F7C74",       // Signal Teal (default)
      FUNDING: "#E2A72E",           // Harvest Gold
      FUTURE: "#C7E84A",            // Fresh Lime
      BREAKING: "#F25C3D",          // Vermilion
    }
  },
  fonts: {
    sans: "Inter",
    serif: "Instrument Serif",
    mono: "IBM Plex Mono",
  }
} as const;
```

### 3.2 Satori Hard Constraints (Must Observe in Templates)
1. **Flexbox Only:** No CSS Grid (`display: grid`). All containers must be `display: "flex"` with explicit `flexDirection: "column"` or `"row"`.
2. **Inline Styles Only:** No external CSS, CSS modules, or Tailwind classes.
3. **Paint Order is DOM Order:** `z-index` is ignored by Satori. Overlays must appear *after* backgrounds in the JSX tree.
4. **Dimensions Required:** The root canvas (`1080×1350`) and all `<img>` elements must have explicit numeric `width` and `height`.
5. **Safe Glyphs Only:** Bundled fonts only include Latin glyphs. Use `»`, `›`, `•`, `+`, `—`. **Never use** `→`, `▲`, `▼`, or emojis (they render as tofu boxes).
6. **Single-String Text Nodes:** A `<div>` without `display: flex` must contain exactly one string. For mixed styling/highlighting, wrap words in `<div style={{ display: "flex", flexWrap: "wrap", columnGap: 7 }}>` with `<span>` children.

---

## 4. System Architecture in Mastra

```text
src/mastra/
  ├── renderer/
  │   ├── fonts.ts              # Loads WOFF fonts into memory
  │   ├── images.ts             # Resolves local paths to base64 data URLs
  │   └── satori-renderer.ts    # React Element -> Satori SVG -> resvg PNG
  ├── templates/
  │   ├── RasStoryTemplate.tsx   # Reusable component for single story posts
  │   └── RasCarouselTemplate.tsx# Reusable components for carousel slides
  ├── tools/
  │   ├── renderRasStoryTool.ts    # Mastra Tool (Zod schema -> Single Story PNG)
  │   └── renderRasCarouselTool.ts # Mastra Tool (Zod schema -> Multi-slide PNGs)
  └── agents/
      └── rasDesignAgent.ts        # Mastra Agent with editorial copy instructions
```

---

## 5. Module 1: In-Process Satori Engine (`renderer/`)

### 5.1 `fonts.ts`
Loads font files from the local filesystem once and caches them:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FontConfig {
  name: string;
  data: Buffer;
  weight: 400 | 700 | 800;
  style: "normal";
}

let cachedFonts: FontConfig[] | null = null;

export function loadFonts(fontsDir: string): FontConfig[] {
  if (cachedFonts) return cachedFonts;
  cachedFonts = [
    { name: "Inter", data: readFileSync(join(fontsDir, "Inter-Regular.woff")), weight: 400, style: "normal" },
    { name: "Inter", data: readFileSync(join(fontsDir, "Inter-Bold.woff")), weight: 700, style: "normal" },
    { name: "Inter", data: readFileSync(join(fontsDir, "Inter-ExtraBold.woff")), weight: 800, style: "normal" },
    { name: "Instrument Serif", data: readFileSync(join(fontsDir, "InstrumentSerif-Regular.woff")), weight: 400, style: "normal" },
    { name: "IBM Plex Mono", data: readFileSync(join(fontsDir, "IBMPlexMono-Regular.woff")), weight: 400, style: "normal" },
  ];
  return cachedFonts;
}
```

### 5.2 `images.ts`
Converts local image files into base64 data URIs (required by Satori):
```ts
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function getLocalImageDataUrl(filePath: string): string {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`Image not found: ${abs}`);
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}
```

### 5.3 `satori-renderer.ts`
Renders a React component directly to a PNG Buffer:
```ts
import type { ReactElement } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { loadFonts } from "./fonts.js";

export async function renderComponentToPng(
  component: ReactElement,
  options: { width: number; height: number; fontsDir: string }
): Promise<Buffer> {
  const fonts = loadFonts(options.fontsDir);
  const svg = await satori(component, {
    width: options.width,
    height: options.height,
    fonts,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.width },
    font: { loadSystemFonts: false },
  });

  return Buffer.from(resvg.render().asPng());
}
```

---

## 6. Module 2: Parameterized Templates (`templates/`)

### 6.1 `RasStoryTemplate.tsx` (Single Story Post)
```tsx
import React from "react";
import { RAS_THEME } from "./theme.js";

export interface RasStoryProps {
  heroImageBase64: string;
  categoryTag: string;           // e.g. "AI · ENTERPRISE · JOBS"
  datelineKicker: string;        // e.g. "09 OCT 2026 · TOPIC DISPATCH"
  serifHeadline: string;         // e.g. "Anthropic isn't just building AI. It's building the workforce."
  deckLead: string;              // Text before the highlight
  deckHighlight: string;         // Emphasized phrase
  deckTail: string;              // Text after the highlight
  accentColor?: string;          // Default: #2F7C74
  specs: [
    { value: string; unit?: string; label: string; hot?: boolean },
    { value: string; unit?: string; label: string; hot?: boolean },
    { value: string; unit?: string; label: string; hot?: boolean }
  ];
  pullQuote: string;
  quoteAttribution: string;      // e.g. "ACCENTURE · MCKINSEY · BAIN"
  sourceEntity: string;          // e.g. "ANTHROPIC"
  darkLogoBase64: string;        // Top hero logo
  lightLogoBase64: string;       // Footer logo
}

export function RasStoryTemplate(props: RasStoryProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.categories.AI_RESEARCH;

  return (
    <div style={{ width: 1080, height: 1350, display: "flex", flexDirection: "column", background: t.colors.paper }}>
      {/* 1. HERO (Height: 620px) */}
      <div style={{ width: 1080, height: 620, position: "relative", display: "flex" }}>
        <img
          src={props.heroImageBase64}
          width={1080}
          height={620}
          style={{ width: 1080, height: 620, objectFit: "cover" }}
        />
        {/* Top Scrim */}
        <div style={{
          position: "absolute", top: 0, left: 0, width: 1080, height: 200,
          background: "linear-gradient(180deg, rgba(5,5,6,0.75) 0%, rgba(5,5,6,0) 100%)",
          display: "flex", justifyContent: "space-between", alignItems: "center", paddingLeft: 72, paddingRight: 72, paddingTop: 40
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img src={props.darkLogoBase64} width={40} height={40} style={{ width: 40, height: 40 }} />
            <div style={{ fontFamily: t.fonts.sans, fontSize: 24, fontWeight: 800, color: t.colors.paper, letterSpacing: 1 }}>
              RISE & SHINE
            </div>
          </div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 15, letterSpacing: 3, color: "rgba(244,240,230,0.70)" }}>
            BY KEILHQ
          </div>
        </div>

        {/* Bottom Scrim & Category Marker */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, width: 1080, height: 160,
          background: "linear-gradient(180deg, rgba(244,240,230,0) 0%, #F4F0E6 100%)",
          display: "flex", alignItems: "flex-end", paddingLeft: 72, paddingBottom: 28
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              background: t.colors.vermilion, borderRadius: 999, paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4,
              fontFamily: t.fonts.mono, fontSize: 13, fontWeight: 700, color: "#FFF", letterSpacing: 2
            }}>
              ● NEW
            </div>
            <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 3, color: t.colors.ink, fontWeight: 700 }}>
              {props.categoryTag}
            </div>
          </div>
        </div>
      </div>

      {/* 2. BODY CONTENT */}
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, paddingLeft: 72, paddingRight: 72, paddingTop: 16, paddingBottom: 50 }}>
        {/* Dateline */}
        <div style={{ fontFamily: t.fonts.mono, fontSize: 15, letterSpacing: 3, color: t.colors.inkMuted }}>
          {props.datelineKicker}
        </div>

        {/* Serif Headline */}
        <div style={{ fontFamily: t.fonts.serif, fontSize: 74, lineHeight: 1.0, color: t.colors.ink, marginTop: 12 }}>
          {props.serifHeadline}
        </div>

        {/* Context Deck */}
        <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7, fontFamily: t.fonts.sans, fontSize: 24, lineHeight: 1.45, color: t.colors.ink, marginTop: 18 }}>
          <span>{props.deckLead}</span>
          <span style={{ fontWeight: 700, color: accent }}>{props.deckHighlight}</span>
          <span>{props.deckTail}</span>
        </div>

        {/* 3-Column Spec Strip */}
        <div style={{ display: "flex", flexDirection: "row", marginTop: 32, paddingTop: 20, paddingBottom: 20, borderTop: `1px solid ${t.colors.rule}`, borderBottom: `1px solid ${t.colors.rule}` }}>
          {props.specs.map((spec, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", flex: 1, borderRight: i < 2 ? `1px solid ${t.colors.rule}` : undefined, paddingLeft: i > 0 ? 24 : 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontFamily: t.fonts.sans, fontSize: 44, fontWeight: 800, color: spec.hot ? accent : t.colors.ink, letterSpacing: -1 }}>{spec.value}</span>
                {spec.unit && <span style={{ fontFamily: t.fonts.sans, fontSize: 18, fontWeight: 700, color: t.colors.inkMuted }}>{spec.unit}</span>}
              </div>
              <div style={{ fontFamily: t.fonts.sans, fontSize: 16, color: t.colors.inkMuted, marginTop: 4 }}>{spec.label}</div>
            </div>
          ))}
        </div>

        {/* Pull Quote */}
        <div style={{ display: "flex", flexDirection: "row", gap: 16, marginTop: 28, alignItems: "center" }}>
          <div style={{ width: 4, height: 64, background: t.colors.quoteAccent, borderRadius: 2 }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontFamily: t.fonts.serif, fontSize: 32, lineHeight: 1.15, color: t.colors.ink }}>
              "{props.pullQuote}"
            </div>
            <div style={{ fontFamily: t.fonts.mono, fontSize: 13, letterSpacing: 2, color: t.colors.inkMuted, marginTop: 6 }}>
              {props.quoteAttribution}
            </div>
          </div>
        </div>

        {/* Locked Footer */}
        <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 18, borderTop: `1px solid ${t.colors.rule}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src={props.lightLogoBase64} width={40} height={31} style={{ width: 40, height: 31 }} />
            <span style={{ fontFamily: t.fonts.sans, fontSize: 20, fontWeight: 800, color: t.colors.ink }}>Rise & Shine</span>
          </div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 15, letterSpacing: 2, color: t.colors.inkMuted }}>
            SOURCE · {props.sourceEntity}
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

### 6.2 `RasCarouselTemplate.tsx` (Multi-Slide Editorial Carousel)
```tsx
import React from "react";
import { RAS_THEME } from "./theme.js";

// --- Slide 1: Cover Slide ---
export interface CarouselCoverProps {
  heroImageBase64: string;
  categoryTag: string;
  datelineKicker: string;
  serifHeadline: string;
  deckLead: string;
  deckHighlight: string;
  accentColor?: string;
  darkLogoBase64: string;
}

export function CarouselCoverSlide(props: CarouselCoverProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.categories.AI_RESEARCH;

  return (
    <div style={{ width: 1080, height: 1350, display: "flex", flexDirection: "column", background: t.colors.paper }}>
      <div style={{ width: 1080, height: 810, position: "relative", display: "flex", overflow: "hidden", background: "#D96246" }}>
        <img src={props.heroImageBase64} width={1080} height={640} style={{ width: 1080, height: 640, objectFit: "contain", marginTop: 40 }} />
        {/* Top Scrim */}
        <div style={{ position: "absolute", top: 0, left: 0, width: 1080, height: 150, background: "linear-gradient(180deg, rgba(15,15,18,0.65) 0%, rgba(15,15,18,0) 100%)" }} />
        {/* Bottom Scrim */}
        <div style={{ position: "absolute", bottom: 0, left: 0, width: 1080, height: 280, background: "linear-gradient(180deg, rgba(244,240,230,0) 0%, #F4F0E6 100%)" }} />
        {/* Masthead */}
        <div style={{ position: "absolute", top: 0, left: 0, width: 1080, display: "flex", justifyContent: "space-between", alignItems: "center", paddingLeft: 72, paddingRight: 72, paddingTop: 44 }}>
          <img src={props.darkLogoBase64} width={170} height={85} style={{ width: 170, height: 85, objectFit: "contain" }} />
          <div style={{ fontFamily: t.fonts.mono, fontSize: 15, fontWeight: 700, letterSpacing: 3, color: t.colors.paper }}>BY KEILHQ</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", height: 540, paddingLeft: 72, paddingRight: 72, paddingTop: 32, paddingBottom: 48 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ background: t.colors.vermilion, borderRadius: 999, paddingLeft: 12, paddingRight: 14, paddingTop: 5, paddingBottom: 5, fontFamily: t.fonts.mono, fontSize: 13, fontWeight: 700, color: t.colors.paper, letterSpacing: 2 }}>
              ● NEW
            </div>
            <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>{props.categoryTag}</div>
          </div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>{props.datelineKicker}</div>
        </div>
        <div style={{ fontFamily: t.fonts.serif, fontSize: 72, lineHeight: 0.98, color: t.colors.ink, marginTop: 14 }}>{props.serifHeadline}</div>
        <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7, fontFamily: t.fonts.sans, fontSize: 22, color: t.colors.ink, marginTop: 18 }}>
          <span>{props.deckLead}</span>
          <span style={{ fontWeight: 700, color: accent }}>{props.deckHighlight}</span>
        </div>
        <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 16, borderTop: `1px solid ${t.colors.rule}` }}>
          <div style={{ fontFamily: t.fonts.sans, fontSize: 22, fontWeight: 800, color: t.colors.ink }}>Rise & Shine</div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>SWIPE FOR BREAKDOWN »</div>
        </div>
      </div>
    </div>
  );
}

// --- Slide 2 & 4: Body Slide with Image ---
export interface CarouselBodyProps {
  num: string;
  total: string;
  badge: string;
  title: string;
  imageSrcBase64: string;
  kicker: string;
  subtitleLead: string;
  subtitleHighlight: string;
  accentColor?: string;
}

export function CarouselBodySlide(props: CarouselBodyProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.categories.AI_RESEARCH;

  return (
    <div style={{ width: 1080, height: 1350, display: "flex", position: "relative", background: t.colors.paper, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, width: 1080, height: 1350, display: "flex", alignItems: "center", justifyContent: "center", background: "#D96246" }}>
        <img src={props.imageSrcBase64} width={1080} height={760} style={{ width: 1080, height: 760, objectFit: "contain" }} />
      </div>
      <div style={{ position: "absolute", top: 0, left: 0, width: 1080, height: 360, background: "linear-gradient(180deg, #F4F0E6 0%, #F4F0E6 48%, rgba(244,240,230,0) 100%)" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, width: 1080, height: 550, background: "linear-gradient(180deg, rgba(244,240,230,0) 0%, #F4F0E6 56%, #F4F0E6 100%)" }} />
      <div style={{ position: "relative", width: 1080, height: 1350, display: "flex", flexDirection: "column", justifyContent: "space-between", paddingLeft: 72, paddingRight: 72, paddingTop: 44, paddingBottom: 48 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontFamily: t.fonts.mono, fontSize: 13, letterSpacing: 2, background: t.colors.vermilion, color: "#FFF", borderRadius: 999, padding: "5px 14px", fontWeight: 700 }}>{props.badge}</div>
            <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>{props.num} / {props.total}</div>
          </div>
          <div style={{ fontFamily: t.fonts.serif, fontSize: 62, lineHeight: 1.02, color: t.colors.ink, marginTop: 18 }}>{props.title}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>{props.kicker}</div>
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7, fontFamily: t.fonts.sans, fontSize: 32, fontWeight: 500, lineHeight: 1.45, color: t.colors.ink, marginTop: 12 }}>
            <span>{props.subtitleLead}</span>
            <span style={{ fontWeight: 700, color: accent }}>{props.subtitleHighlight}</span>
          </div>
          <div style={{ marginTop: 28, display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 16, borderTop: `1px solid ${t.colors.rule}` }}>
            <div style={{ fontFamily: t.fonts.sans, fontSize: 22, fontWeight: 800, color: t.colors.ink }}>Rise & Shine</div>
            <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>SWIPE NEXT »</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Slide 3: Text-Only Strategy Slide ---
export interface CarouselTextProps {
  num: string;
  total: string;
  badge: string;
  title: string;
  kicker: string;
  subtitleLead: string;
  subtitleHighlight: string;
  accentColor?: string;
}

export function CarouselTextSlide(props: CarouselTextProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.categories.AI_RESEARCH;

  return (
    <div style={{ width: 1080, height: 1350, display: "flex", flexDirection: "column", background: t.colors.paper }}>
      <div style={{ height: 450, background: "linear-gradient(180deg, #D96246 0%, #B84D34 100%)", paddingLeft: 72, paddingRight: 72, paddingTop: 44, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 13, letterSpacing: 2, background: "rgba(255,255,255,0.2)", color: "#FFF", borderRadius: 999, padding: "5px 14px", fontWeight: 700 }}>{props.badge}</div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: "rgba(255,255,255,0.8)" }}>{props.num} / {props.total}</div>
        </div>
        <div style={{ fontFamily: t.fonts.serif, fontSize: 62, lineHeight: 1.02, color: "#F4F0E6", marginTop: 24 }}>{props.title}</div>
      </div>
      <div style={{ height: 900, paddingLeft: 72, paddingRight: 72, paddingTop: 48, paddingBottom: 48, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>{props.kicker}</div>
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7, fontFamily: t.fonts.sans, fontSize: 34, fontWeight: 500, lineHeight: 1.5, color: t.colors.ink, marginTop: 16 }}>
            <span>{props.subtitleLead}</span>
            <span style={{ fontWeight: 700, color: accent }}>{props.subtitleHighlight}</span>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 16, borderTop: `1px solid ${t.colors.rule}` }}>
          <div style={{ fontFamily: t.fonts.sans, fontSize: 22, fontWeight: 800, color: t.colors.ink }}>Rise & Shine</div>
          <div style={{ fontFamily: t.fonts.mono, fontSize: 14, letterSpacing: 2, color: t.colors.inkMuted }}>SWIPE NEXT »</div>
        </div>
      </div>
    </div>
  );
}
```

---

## 7. Module 3: Mastra Tools (`tools/`)

### 7.1 `renderRasStoryTool.ts`
```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import React from "react";
import { RasStoryTemplate } from "../templates/RasStoryTemplate.js";
import { renderComponentToPng } from "../renderer/satori-renderer.js";
import { getLocalImageDataUrl } from "../renderer/images.js";

export const renderRasStoryTool = createTool({
  id: "render-ras-story",
  description: "Renders a high-resolution 1080x1350 Rise & Shine editorial story graphic to PNG",
  inputSchema: z.object({
    slug: z.string().describe("Unique filename identifier, e.g. 'anthropic-academy'"),
    heroImagePath: z.string().describe("Relative or absolute path to local hero image"),
    categoryTag: z.string().describe("Category path, e.g. 'AI · INFRASTRUCTURE'"),
    datelineKicker: z.string().describe("Dateline, e.g. '09 OCT 2026 · APPLIED FRONTIER'"),
    serifHeadline: z.string().describe("Sharp thesis headline (max 2-3 lines)"),
    deckLead: z.string().describe("Context deck lead-in text"),
    deckHighlight: z.string().describe("Key emphasized phrase to highlight in accent color"),
    deckTail: z.string().describe("Remaining context deck text"),
    accentColor: z.enum(["#2F7C74", "#E2A72E", "#C7E84A", "#F25C3D"]).default("#2F7C74"),
    specs: z.array(z.object({
      value: z.string(),
      unit: z.string().optional(),
      label: z.string(),
      hot: z.boolean().default(false),
    })).length(3).describe("Exactly 3 metrics for the spec strip"),
    pullQuote: z.string().describe("Impactful one-sentence quote or takeaway"),
    quoteAttribution: z.string().describe("Entities or source attribution in uppercase mono"),
    sourceEntity: z.string().describe("Primary source entity, e.g. 'ANTHROPIC'"),
    outputDir: z.string().default("./output"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filePath: z.string(),
  }),
  execute: async (input) => {
    const fontsDir = resolve("./public/fonts");
    const darkLogo = getLocalImageDataUrl("./public/RAS-by-keilhq/ras-by-keilhq-logo-dark.png");
    const lightLogo = getLocalImageDataUrl("./public/RAS-by-keilhq/ras-by-keilhq-logo-light.png");
    const heroImage = getLocalImageDataUrl(input.heroImagePath);

    const component = React.createElement(RasStoryTemplate, {
      heroImageBase64: heroImage,
      categoryTag: input.categoryTag,
      datelineKicker: input.datelineKicker,
      serifHeadline: input.serifHeadline,
      deckLead: input.deckLead,
      deckHighlight: input.deckHighlight,
      deckTail: input.deckTail,
      accentColor: input.accentColor,
      specs: input.specs as any,
      pullQuote: input.pullQuote,
      quoteAttribution: input.quoteAttribution,
      sourceEntity: input.sourceEntity,
      darkLogoBase64: darkLogo,
      lightLogoBase64: lightLogo,
    });

    const pngBuffer = await renderComponentToPng(component, {
      width: 1080,
      height: 1350,
      fontsDir,
    });

    const destination = resolve(input.outputDir, `${input.slug}.png`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, pngBuffer);

    return {
      success: true,
      filePath: destination,
    };
  },
});
```

---

### 7.2 `renderRasCarouselTool.ts`
```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import React from "react";
import {
  CarouselCoverSlide,
  CarouselBodySlide,
  CarouselTextSlide,
} from "../templates/RasCarouselTemplate.js";
import { renderComponentToPng } from "../renderer/satori-renderer.js";
import { getLocalImageDataUrl } from "../renderer/images.js";

export const renderRasCarouselTool = createTool({
  id: "render-ras-carousel",
  description: "Renders a 4-5 slide Rise & Shine editorial carousel deck to a folder of PNG images",
  inputSchema: z.object({
    deckSlug: z.string().describe("Unique folder identifier for the carousel"),
    accentColor: z.enum(["#2F7C74", "#E2A72E", "#C7E84A", "#F25C3D"]).default("#2F7C74"),
    cover: z.object({
      heroImagePath: z.string(),
      categoryTag: z.string(),
      datelineKicker: z.string(),
      serifHeadline: z.string(),
      deckLead: z.string(),
      deckHighlight: z.string(),
    }),
    slides: z.array(z.discriminatedUnion("type", [
      z.object({
        type: z.literal("body"),
        badge: z.string(),
        title: z.string(),
        imagePath: z.string(),
        kicker: z.string(),
        subtitleLead: z.string(),
        subtitleHighlight: z.string(),
      }),
      z.object({
        type: z.literal("text"),
        badge: z.string(),
        title: z.string(),
        kicker: z.string(),
        subtitleLead: z.string(),
        subtitleHighlight: z.string(),
      }),
    ])).min(3).max(4).describe("3 to 4 following slides (yielding a 4-5 slide carousel)"),
    outputDir: z.string().default("./output"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slidePaths: z.array(z.string()),
  }),
  execute: async (input) => {
    const fontsDir = resolve("./public/fonts");
    const darkLogo = getLocalImageDataUrl("./public/RAS-by-keilhq/ras-logo-dark.png");
    const coverHero = getLocalImageDataUrl(input.cover.heroImagePath);
    const targetDir = resolve(input.outputDir, input.deckSlug);
    mkdirSync(targetDir, { recursive: true });

    const totalSlides = String(input.slides.length + 1).padStart(2, "0");
    const renderedPaths: string[] = [];

    // 1. Render Cover Slide
    const coverComponent = React.createElement(CarouselCoverSlide, {
      ...input.cover,
      heroImageBase64: coverHero,
      accentColor: input.accentColor,
      darkLogoBase64: darkLogo,
    });
    const coverPng = await renderComponentToPng(coverComponent, { width: 1080, height: 1350, fontsDir });
    const coverPath = join(targetDir, "01.png");
    writeFileSync(coverPath, coverPng);
    renderedPaths.push(coverPath);

    // 2. Render Remaining Slides
    for (let i = 0; i < input.slides.length; i++) {
      const slide = input.slides[i];
      const slideNum = String(i + 2).padStart(2, "0");
      let slideComponent: React.ReactElement;

      if (slide.type === "body") {
        const bodyImg = getLocalImageDataUrl(slide.imagePath);
        slideComponent = React.createElement(CarouselBodySlide, {
          num: slideNum,
          total: totalSlides,
          badge: slide.badge,
          title: slide.title,
          imageSrcBase64: bodyImg,
          kicker: slide.kicker,
          subtitleLead: slide.subtitleLead,
          subtitleHighlight: slide.subtitleHighlight,
          accentColor: input.accentColor,
        });
      } else {
        slideComponent = React.createElement(CarouselTextSlide, {
          num: slideNum,
          total: totalSlides,
          badge: slide.badge,
          title: slide.title,
          kicker: slide.kicker,
          subtitleLead: slide.subtitleLead,
          subtitleHighlight: slide.subtitleHighlight,
          accentColor: input.accentColor,
        });
      }

      const png = await renderComponentToPng(slideComponent, { width: 1080, height: 1350, fontsDir });
      const dest = join(targetDir, `${slideNum}.png`);
      writeFileSync(dest, png);
      renderedPaths.push(dest);
    }

    return {
      success: true,
      slidePaths: renderedPaths,
    };
  },
});
```

---

## 8. Module 4: Mastra Agent Configuration (`agents/`)

### 8.1 `rasDesignAgent.ts`
Configures the Mastra Agent with copy guidelines and the render tools:
```ts
import { Agent } from "@mastra/core/agent";
import { renderRasStoryTool } from "../tools/renderRasStoryTool.js";
import { renderRasCarouselTool } from "../tools/renderRasCarouselTool.js";

export const rasDesignAgent = new Agent({
  id: "ras-design-agent",
  name: "Rise & Shine Design Agent",
  instructions: `
You are the Lead Editorial Director for "Rise & Shine (RAS) by KeilHQ" — "The daily signal for people building what's next".

Your role is to synthesize news, research, and startup announcements into publication-grade editorial social media graphics.

### Editorial Philosophy:
Ink. Paper. Daybreak.
- Midnight Ink (#151615): Intelligence, depth, seriousness.
- Daybreak Paper (#F4F0E6): Editorial credibility, calm, clarity.
- Daybreak Vermilion (#F25C3D): The sunrise signal marker (urgent, breaking).

### Copywriting Rules:
1. **Headline:** Write a sharp editorial thesis, NOT a bland press release title.
   - GOOD: "Anthropic isn't just building AI. It's building the people who deploy it."
   - BAD: "Anthropic Announces $100M Claude Frontier Academy Program"
2. **Context Deck:** 2 short lines establishing the strategic tension and human consequence. Select exactly ONE key phrase for deckHighlight.
3. **Spec Strip (for Story Posts):** Exactly 3 punchy numbers. Make 1 or 2 metrics hot: true.
4. **Pull Quote:** One memorable takeaway line summarizing the paradigm shift.
5. **Category Accents:**
   - AI & Research: #2F7C74 (Signal Teal)
   - Funding & Deals: #E2A72E (Harvest Gold)
   - Emerging Tech / Future: #C7E84A (Fresh Lime)
   - Urgent / Breaking: #F25C3D (Vermilion)

### Capabilities:
- Use \`render-ras-story\` when the user asks for a single editorial post.
- Use \`render-ras-carousel\` when the user asks for a 4-5 slide carousel deck.
Always construct the payload strictly adhering to the tool's input schema.
`,
  model: "openai/gpt-4o",
  tools: {
    renderRasStoryTool,
    renderRasCarouselTool,
  },
});
```

---

## 9. Implementation Checklist for the Target Mastra Agent

When an AI agent in the target repo executes this PRD, follow these exact steps:

- [ ] **Step 1: Install packages**
  Run `npm install satori @resvg/resvg-js react` and `npm install -D @types/react`.
- [ ] **Step 2: Copy static fonts & assets**
  Copy `public/fonts/` (`Inter`, `InstrumentSerif`, `IBMPlexMono`) and `public/RAS-by-keilhq/` into the project root.
- [ ] **Step 3: Create the Satori rendering helper**
  Implement `src/mastra/renderer/fonts.ts`, `images.ts`, and `satori-renderer.ts`.
- [ ] **Step 4: Create the Parameterized Templates**
  Implement `src/mastra/templates/RasStoryTemplate.tsx` and `RasCarouselTemplate.tsx` with all Satori styling rules.
- [ ] **Step 5: Register the Mastra Tools**
  Create `src/mastra/tools/renderRasStoryTool.ts` and `renderRasCarouselTool.ts` using `createTool` with Zod schemas.
- [ ] **Step 6: Configure the Agent**
  Register both tools on `rasDesignAgent` with editorial prompt instructions.
- [ ] **Step 7: Verification Run**
  Run a test call to both tools with mock payloads and verify that 1080×1350 PNGs are generated in `./output/` without Satori errors.
