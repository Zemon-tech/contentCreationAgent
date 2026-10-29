/**
 * In-process rendering engine: React element -> Satori SVG -> resvg PNG.
 *
 * Satori (v0.44) turns a pure, stateless React element tree into an SVG using
 * flexbox layout. resvg-js (v2.6) rasterizes that SVG to a PNG buffer. No
 * browser, no external service.
 *
 * Constraints enforced by the templates (not here): flexbox only, inline
 * styles, explicit dimensions on the canvas and all <img>, Latin glyphs only.
 */

import type { ReactElement } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { loadFonts } from "./fonts.js";

export interface RenderOptions {
  width: number;
  height: number;
}

/** Renders a React element to an SVG string via Satori. */
export async function renderComponentToSvg(
  component: ReactElement,
  options: RenderOptions,
): Promise<string> {
  const fonts = loadFonts();
  return satori(component, {
    width: options.width,
    height: options.height,
    fonts,
  });
}


/** Renders a React element to a PNG buffer (Satori SVG -> resvg PNG). */
export async function renderComponentToPng(
  component: ReactElement,
  options: RenderOptions,
): Promise<Buffer> {
  const svg = await renderComponentToSvg(component, options);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.width },
    font: { loadSystemFonts: false },
  });
  return Buffer.from(resvg.render().asPng());
}

/** The RAS canvas is a fixed Instagram portrait: 1080 x 1350 (4:5). */
export const RAS_CANVAS = { width: 1080, height: 1350 } as const;
