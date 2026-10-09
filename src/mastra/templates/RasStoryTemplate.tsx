/**
 * RAS Editorial Story Post — single 1080x1350 image (cover-style).
 *
 * Layout (matches the RAS carousel title slide):
 *  - Full-bleed hero: 810px (3/5 of canvas) with top + bottom gradient scrims
 *    and an overlaid masthead (RAS lockup logo + "BY KEILHQ").
 *  - Editorial body on paper: 540px (2/5) — badge + category kicker row,
 *    serif display headline, a 3-line context deck with one accent line, and a
 *    locked footer ("Rise & Shine" + vermilion marker).
 *
 * Satori rules observed: flexbox only, inline styles only, overlays after
 * backgrounds in DOM order, explicit width/height on the canvas and <img>,
 * Latin glyphs only.
 */

import React from "react";
import { RAS_THEME } from "./theme.js";

export interface RasStoryProps {
  heroImageBase64: string;
  categoryTag: string; // e.g. "AI · STARTUPS · FUNDING"
  serifHeadline: string;
  deckLead: string; // line 1 (ink)
  deckHighlight: string; // line 2 (accent, emphasized)
  deckTail: string; // line 3 (ink)
  accentColor?: string;
  /** RAS lockup logo (dark art) for the hero masthead. */
  logoBase64: string;
  logoWidth: number;
  logoHeight: number;
}

export function RasStoryTemplate(props: RasStoryProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.categories.AI_RESEARCH;
  const mast = scaleToHeight(props.logoWidth, props.logoHeight, 85);

  return (
    <div
      style={{
        width: 1080,
        height: 1350,
        display: "flex",
        flexDirection: "column",
        background: t.colors.paper,
      }}
    >
      {/* 1. FULL-BLEED HERO (810px = 3/5) */}
      <div
        style={{
          display: "flex",
          width: 1080,
          height: 810,
          position: "relative",
          background: "#13110E",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <img
          src={props.heroImageBase64}
          width={1080}
          height={810}
          style={{ width: 1080, height: 810, objectFit: "cover" }}
        />

        {/* Top scrim for masthead contrast */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1080,
            height: 190,
            display: "flex",
            background:
              "linear-gradient(180deg, rgba(15,15,18,0.72) 0%, rgba(15,15,18,0.32) 55%, rgba(15,15,18,0) 100%)",
          }}
        />

        {/* Bottom scrim fading into Daybreak Paper */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: 1080,
            height: 300,
            display: "flex",
            background:
              "linear-gradient(180deg, rgba(244,240,230,0) 0%, rgba(244,240,230,0.04) 20%, rgba(244,240,230,0.16) 40%, rgba(244,240,230,0.42) 60%, rgba(244,240,230,0.75) 80%, rgba(244,240,230,0.95) 93%, #F4F0E6 100%)",
          }}
        />

        {/* Overlaid masthead */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingLeft: 72,
            paddingRight: 72,
            paddingTop: 44,
          }}
        >
          <img
            src={props.logoBase64}
            width={mast.width}
            height={mast.height}
            style={{ width: mast.width, height: mast.height, objectFit: "contain" }}
          />
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: 3,
              color: t.colors.paper,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            BY KEILHQ
          </div>
        </div>
      </div>

      {/* 2. EDITORIAL BODY ON PAPER (540px = 2/5) */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: 540,
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 32,
          paddingBottom: 48,
          boxSizing: "border-box",
        }}
      >
        {/* Kicker row: NEW badge + category */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
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
              background: t.colors.vermilion,
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

        {/* Serif display headline */}
        <div
          style={{
            fontFamily: t.fonts.serif,
            fontSize: 70,
            fontWeight: 400,
            lineHeight: 0.98,
            color: t.colors.ink,
            marginTop: 14,
          }}
        >
          {props.serifHeadline}
        </div>

        {/* Context deck: 3 stacked lines, middle line accented */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontFamily: t.fonts.sans,
            fontSize: 24,
            fontWeight: 400,
            lineHeight: 1.42,
            color: t.colors.ink,
            marginTop: 16,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7 }}>{props.deckLead}</div>
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7 }}>
            <span style={{ fontWeight: 700, color: accent }}>{props.deckHighlight}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 7 }}>{props.deckTail}</div>
        </div>

        {/* Locked footer */}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ width: "100%", height: 1, background: t.colors.rule }} />
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div
              style={{
                fontFamily: t.fonts.sans,
                fontSize: 22,
                fontWeight: 800,
                color: t.colors.ink,
              }}
            >
              Rise &amp; Shine
            </div>
            <div
              style={{
                fontFamily: t.fonts.mono,
                fontSize: 16,
                fontWeight: 700,
                color: t.colors.vermilion,
              }}
            >
              »
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
