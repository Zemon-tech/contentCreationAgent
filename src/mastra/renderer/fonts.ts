/**
 * Loads the RAS brand fonts into memory for Satori.
 *
 * Satori needs real font binaries (it does not read system fonts). The files
 * are WOFF1 under src/mastra/assets/fonts and are read once, then cached for
 * the process lifetime.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFontsDir } from "./assets.js";

export interface FontConfig {
  name: string;
  data: Buffer;
  weight: 400 | 700 | 800;
  style: "normal";
}

let cachedFonts: FontConfig[] | null = null;

interface FontSpec {
  file: string;
  name: string;
  weight: 400 | 700 | 800;
}

const FONT_SPECS: FontSpec[] = [
  { file: "Inter-Regular.woff", name: "Inter", weight: 400 },
  { file: "Inter-Bold.woff", name: "Inter", weight: 700 },
  { file: "Inter-ExtraBold.woff", name: "Inter", weight: 800 },
  { file: "InstrumentSerif-Regular.woff", name: "Instrument Serif", weight: 400 },
  { file: "IBMPlexMono-Regular.woff", name: "IBM Plex Mono", weight: 400 },
];

/**
 * Reads and caches all RAS fonts. Throws a clear error naming the missing
 * file if a font is absent, so a bad deploy fails loudly rather than
 * rendering tofu boxes.
 */
export function loadFonts(): FontConfig[] {
  if (cachedFonts) return cachedFonts;

  const fontsDir = getFontsDir();
  const fonts: FontConfig[] = [];

  for (const spec of FONT_SPECS) {
    const abs = join(fontsDir, spec.file);
    let data: Buffer;
    try {
      data = readFileSync(abs);
    } catch {
      throw new Error(
        `Missing RAS font "${spec.file}" (expected at ${abs}). ` +
          `Add all five WOFF fonts to src/mastra/assets/fonts (see its README).`,
      );
    }
    fonts.push({ name: spec.name, data, weight: spec.weight, style: "normal" });
  }

  cachedFonts = fonts;
  return fonts;
}
