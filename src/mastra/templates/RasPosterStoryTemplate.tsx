/**
 * RAS Poster Story Post — single 1080x1350 image ("cutout poster" style).
 *
 * Layout (top to bottom, all on grid paper):
 *  - Masthead: RAS lockup (its art already includes "by KeilHQ") top-left,
 *    "BY KEILHQ" watermark top-right
 *  - Optional kicker (top-center): NEW badge + category tag
 *  - 3-tier condensed headline, centered:
 *      line 1 -> accent colour
 *      line 2 -> ink
 *      line 3 -> white text on an accent pill (the "punch" line)
 *  - Hero zone: transparent-PNG cutout sitting on a soft accent circle,
 *    with a brush-style smear underneath and two small ink markers
 *  - Footer: "Rise & Shine" (left), arrow pill (right)
 *
 * IMPORTANT inputs:
 *  - heroCutoutBase64 must be a PNG with a TRANSPARENT background. A full-bleed
 *    photo will look wrong here; use this template only when the pipeline can
 *    produce a cutout.
 *  - The display font "Anton" must be registered with Satori (weight 400).
 *
 * Satori rules observed: flexbox only, inline styles only, overlays after
 * backgrounds in DOM order, explicit width/height on the canvas and <img>,
 * Latin glyphs only (the arrow is drawn with divs, not a glyph).
 */

import React from "react";
import { RAS_THEME } from "./theme.js";

export interface RasPosterStoryProps {
  /** Transparent PNG cutout of the subject (data URI). */
  heroCutoutBase64: string;
  /** Line 1 (accent colour). Ideal 20-30 chars, hard max ~40 (see checkPosterCopy). */
  headlineTop: string;
  /** Line 2 (ink). Ideal 20-30 chars, hard max ~40. */
  headlineMid: string;
  /** Line 3 (white on accent pill). Ideal 10-25 chars, hard max ~37. */
  headlineHighlight: string;
  /** Optional kicker, e.g. "AI · STARTUPS · FUNDING". Omit to hide the kicker row. */
  categoryTag?: string;
  accentColor?: string;
  /**
   * RAS lockup for the top-left masthead. It sits on cream paper, so it must be
   * the BLACK transparent version (ras-logo-black.png), not the light one used
   * over hero images. If omitted, a "Rise & Shine" text wordmark is drawn.
   */
  logoBase64?: string;
  logoWidth?: number;
  logoHeight?: number;
  /** The two small ink triangles flanking the circle. Default true. */
  showMarkers?: boolean;
}

// --------------------------------------------------------------------------
// Layout constants — tweak here, not inside the JSX.
// --------------------------------------------------------------------------

const W = 1080;
const H = 1350;
const MARGIN = 72;
const GRID = 90; // grid cell size (divides both W and H)
const DISPLAY_FONT = "Anton"; // register in the Satori font loader, weight 400
const CHAR_EM = 0.44; // conservative uppercase advance of Anton incl. spaces, in em (test renders measured 0.40-0.43 depending on letter mix)

const MAST_H = 85; // masthead row height = logo height (same as the existing RAS templates)
const HEADLINE_TOP = 156; // leaves room for the masthead above
const HEADLINE_MAX = 104; // max font size px
const HEADLINE_MIN = 56; // never shrink below this
const TEXT_PAD = 40; // horizontal padding inside the highlight pill

/** Max characters that still fit on one line at HEADLINE_MIN (the hard limit). */
export const POSTER_LIMITS = {
  line: Math.floor((W - MARGIN * 2) / (HEADLINE_MIN * CHAR_EM)), // ~40
  highlight: Math.floor((W - MARGIN * 2 - TEXT_PAD * 2) / (HEADLINE_MIN * CHAR_EM)), // ~37
};

/**
 * Call before rendering. Returns a list of problems (empty = OK) so the agent
 * can ask the copywriter step for shorter lines instead of shipping a clipped image.
 */
export function checkPosterCopy(
  p: Pick<RasPosterStoryProps, "headlineTop" | "headlineMid" | "headlineHighlight">,
): string[] {
  const issues: string[] = [];
  if (p.headlineTop.length > POSTER_LIMITS.line)
    issues.push(`headlineTop is ${p.headlineTop.length} chars (max ${POSTER_LIMITS.line})`);
  if (p.headlineMid.length > POSTER_LIMITS.line)
    issues.push(`headlineMid is ${p.headlineMid.length} chars (max ${POSTER_LIMITS.line})`);
  if (p.headlineHighlight.length > POSTER_LIMITS.highlight)
    issues.push(
      `headlineHighlight is ${p.headlineHighlight.length} chars (max ${POSTER_LIMITS.highlight})`,
    );
  return issues;
}
const HERO = { top: 540, height: 700 };
const CIRCLE = { size: 560, top: 660 };
const SMEAR = { width: 940, height: 46, top: 1196 };

export function RasPosterStoryTemplate(props: RasPosterStoryProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.vermilion;
  const showMarkers = props.showMarkers !== false;
  const textWidth = W - MARGIN * 2; // 936
  const pillPad = TEXT_PAD;

  const top = props.headlineTop.toUpperCase();
  const mid = props.headlineMid.toUpperCase();
  const hi = props.headlineHighlight.toUpperCase();

  const sizeTop = fitFont(top, textWidth);
  const sizeMid = fitFont(mid, textWidth);
  const sizeHi = fitFont(hi, textWidth - pillPad * 2);

  const logo =
    props.logoBase64 && props.logoWidth && props.logoHeight
      ? scaleToHeight(props.logoWidth, props.logoHeight, MAST_H)
      : null;

  const gridCols = Array.from({ length: W / GRID + 1 }, (_, i) => i * GRID);
  const gridRows = Array.from({ length: H / GRID + 1 }, (_, i) => i * GRID);

  return (
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        position: "relative",
        background: t.colors.paper,
        overflow: "hidden",
      }}
    >
      {/* 1. GRID PAPER */}
      {gridCols.map((x) => (
        <div
          key={`c${x}`}
          style={{
            position: "absolute",
            left: x,
            top: 0,
            width: 1,
            height: H,
            display: "flex",
            background: "rgba(19,17,14,0.055)",
          }}
        />
      ))}
      {gridRows.map((y) => (
        <div
          key={`r${y}`}
          style={{
            position: "absolute",
            left: 0,
            top: y,
            width: W,
            height: 1,
            display: "flex",
            background: "rgba(19,17,14,0.055)",
          }}
        />
      ))}

      {/* 2a. MASTHEAD: RAS lockup (logo already contains "by KeilHQ") left, "BY KEILHQ" watermark right */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: MARGIN,
          right: MARGIN,
          height: MAST_H,
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {logo ? (
          <img
            src={props.logoBase64}
            width={logo.width}
            height={logo.height}
            style={{ width: logo.width, height: logo.height, objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              fontFamily: t.fonts.sans,
              fontSize: 36,
              fontWeight: 800,
              color: t.colors.ink,
            }}
          >
            Rise &amp; Shine
          </div>
        )}
        <div
          style={{
            display: "flex",
            fontFamily: t.fonts.mono,
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: 3,
            color: t.colors.ink,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          BY KEILHQ
        </div>
      </div>

      {/* 2b. KICKER (optional), centered between the two masthead items */}
      {props.categoryTag ? (
        <div
          style={{
            position: "absolute",
            top: 44 + (MAST_H - 30) / 2,
            left: 0,
            width: W,
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              background: accent,
              borderRadius: 999,
              paddingLeft: 12,
              paddingRight: 14,
              paddingTop: 5,
              paddingBottom: 5,
            }}
          >
            <div style={{ width: 6, height: 6, borderRadius: 3, background: t.colors.paper }} />
            <div
              style={{
                fontFamily: t.fonts.mono,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: 2,
                color: t.colors.paper,
              }}
            >
              NEW
            </div>
          </div>
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 14,
              letterSpacing: 2,
              color: t.colors.inkMuted,
            }}
          >
            {props.categoryTag}
          </div>
        </div>
      ) : null}

      {/* 3. HEADLINE */}
      <div
        style={{
          position: "absolute",
          top: HEADLINE_TOP,
          left: MARGIN,
          width: textWidth,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            width: textWidth,
            whiteSpace: "nowrap",
            fontFamily: DISPLAY_FONT,
            fontWeight: 400,
            fontSize: sizeTop,
            lineHeight: 1.04,
            color: accent,
          }}
        >
          {top}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            width: textWidth,
            whiteSpace: "nowrap",
            fontFamily: DISPLAY_FONT,
            fontWeight: 400,
            fontSize: sizeMid,
            lineHeight: 1.04,
            color: t.colors.ink,
          }}
        >
          {mid}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            marginTop: 22,
            background: accent,
            borderRadius: 16,
            paddingLeft: pillPad,
            paddingRight: pillPad,
            paddingTop: 10,
            paddingBottom: 14,
            whiteSpace: "nowrap",
            fontFamily: DISPLAY_FONT,
            fontWeight: 400,
            fontSize: sizeHi,
            lineHeight: 1.04,
            color: t.colors.white,
          }}
        >
          {hi}
        </div>
      </div>

      {/* 4. HERO BACKDROP: circle, smear, markers (all behind the cutout) */}
      <div
        style={{
          position: "absolute",
          left: (W - CIRCLE.size) / 2,
          top: CIRCLE.top,
          width: CIRCLE.size,
          height: CIRCLE.size,
          borderRadius: CIRCLE.size / 2,
          display: "flex",
          background: withAlpha(accent, 0.3),
        }}
      />
      <div
        style={{
          position: "absolute",
          left: (W - SMEAR.width) / 2,
          top: SMEAR.top,
          width: SMEAR.width,
          height: SMEAR.height,
          borderRadius: SMEAR.height / 2,
          display: "flex",
          background: `radial-gradient(ellipse at center, ${withAlpha(accent, 0.38)} 0%, ${withAlpha(accent, 0.22)} 55%, ${withAlpha(accent, 0)} 100%)`,
        }}
      />
      {showMarkers ? (
        <>
          <div
            style={{
              position: "absolute",
              left: 336,
              top: 1066,
              width: 0,
              height: 0,
              display: "flex",
              borderLeft: "19px solid transparent",
              borderRight: "19px solid transparent",
              borderTop: `32px solid ${t.colors.ink}`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 686,
              top: 1066,
              width: 0,
              height: 0,
              display: "flex",
              borderLeft: "19px solid transparent",
              borderRight: "19px solid transparent",
              borderTop: `32px solid ${t.colors.ink}`,
            }}
          />
        </>
      ) : null}

      {/* 5. HERO CUTOUT (transparent PNG) */}
      <img
        src={props.heroCutoutBase64}
        width={W}
        height={HERO.height}
        style={{
          position: "absolute",
          left: 0,
          top: HERO.top,
          width: W,
          height: HERO.height,
          objectFit: "contain",
        }}
      />

      {/* 6. FOOTER */}
      <div
        style={{
          position: "absolute",
          left: MARGIN,
          right: MARGIN,
          bottom: 52,
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: t.fonts.sans,
            fontSize: 28,
            fontWeight: 800,
            color: t.colors.ink,
          }}
        >
          Rise &amp; Shine
        </div>

        {/* Arrow pill — arrow drawn with divs to stay Latin-glyph safe */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 116,
            height: 48,
            borderRadius: 999,
            background: accent,
          }}
        >
          <div style={{ display: "flex", position: "relative", width: 46, height: 20 }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 8,
                width: 44,
                height: 3,
                display: "flex",
                background: t.colors.paper,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 29,
                top: 3,
                width: 13,
                height: 13,
                display: "flex",
                borderTop: `3px solid ${t.colors.paper}`,
                borderRight: `3px solid ${t.colors.paper}`,
                transform: "rotate(45deg)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Largest font size (clamped) at which `text` fits on one line in `maxWidth`. */
function fitFont(text: string, maxWidth: number): number {
  const est = Math.floor(maxWidth / (Math.max(text.length, 1) * CHAR_EM));
  return Math.max(HEADLINE_MIN, Math.min(HEADLINE_MAX, est));
}

/** "#RRGGBB" / "#RGB" -> rgba(...) string. */
function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Scales (w,h) so the height equals `targetHeight`, preserving aspect ratio. */
function scaleToHeight(
  w: number,
  h: number,
  targetHeight: number,
): { width: number; height: number } {
  if (!w || !h) return { width: targetHeight, height: targetHeight };
  const width = Math.round((w / h) * targetHeight);
  return { width, height: targetHeight };
}