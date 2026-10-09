/**
 * RAS Editorial Carousel — 1080x1350 slides.
 *
 * Three slide components:
 *  - CarouselCoverSlide: hook cover with hero image + masthead
 *  - CarouselBodySlide:  image-led breakdown slide
 *  - CarouselTextSlide:  text-only strategy slide (colored header band)
 *
 * Same Satori rules as the story template (flexbox, inline styles, DOM paint
 * order, explicit dimensions, Latin glyphs).
 */

import React from "react";
import { RAS_THEME } from "./theme.js";

// --------------------------------------------------------------------------
// Slide 1 — Cover
// --------------------------------------------------------------------------

export interface CarouselCoverProps {
  heroImageBase64: string;
  categoryTag: string;
  datelineKicker: string;
  serifHeadline: string;
  deckLead: string;
  deckHighlight: string;
  accentColor?: string;
  /** Full RAS lockup (dark-art, for the dark hero band). */
  logoBase64: string;
  logoWidth: number;
  logoHeight: number;
}

export function CarouselCoverSlide(props: CarouselCoverProps) {
  const t = RAS_THEME;
  const accent = props.accentColor || t.colors.categories.AI_RESEARCH;
  const mark = scaleToHeight(props.logoWidth, props.logoHeight, 85);

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
      <div
        style={{
          width: 1080,
          height: 810,
          position: "relative",
          display: "flex",
          overflow: "hidden",
          background: "#D96246",
        }}
      >
        <img
          src={props.heroImageBase64}
          width={1080}
          height={810}
          style={{ width: 1080, height: 810, objectFit: "cover" }}
        />
        {/* Top scrim */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1080,
            height: 150,
            background: "linear-gradient(180deg, rgba(15,15,18,0.65) 0%, rgba(15,15,18,0) 100%)",
            display: "flex",
          }}
        />
        {/* Bottom scrim */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: 1080,
            height: 280,
            background: "linear-gradient(180deg, rgba(244,240,230,0) 0%, #F4F0E6 100%)",
            display: "flex",
          }}
        />
        {/* Masthead */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingLeft: 72,
            paddingRight: 72,
            paddingTop: 44,
          }}
        >
          <img
            src={props.logoBase64}
            width={mark.width}
            height={mark.height}
            style={{ width: mark.width, height: mark.height, objectFit: "contain" }}
          />
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 15,
              fontWeight: 700,
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

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: 540,
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 32,
          paddingBottom: 48,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                display: "flex",
                background: t.colors.vermilion,
                borderRadius: 999,
                paddingLeft: 12,
                paddingRight: 14,
                paddingTop: 5,
                paddingBottom: 5,
                fontFamily: t.fonts.mono,
                fontSize: 13,
                fontWeight: 700,
                color: t.colors.paper,
                letterSpacing: 2,
              }}
            >
              • NEW
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
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 14,
              letterSpacing: 2,
              color: t.colors.inkMuted,
            }}
          >
            {props.datelineKicker}
          </div>
        </div>

        <div
          style={{
            fontFamily: t.fonts.serif,
            fontSize: 72,
            lineHeight: 0.98,
            color: t.colors.ink,
            marginTop: 14,
          }}
        >
          {props.serifHeadline}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            columnGap: 7,
            fontFamily: t.fonts.sans,
            fontSize: 22,
            color: t.colors.ink,
            marginTop: 18,
          }}
        >
          <span>{props.deckLead}</span>
          <span style={{ fontWeight: 700, color: accent }}>{props.deckHighlight}</span>
        </div>

        <div
          style={{
            marginTop: "auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 16,
            borderTop: `1px solid ${t.colors.rule}`,
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
              fontSize: 14,
              letterSpacing: 2,
              color: t.colors.inkMuted,
            }}
          >
            SWIPE FOR BREAKDOWN »
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Body slide (image-led)
// --------------------------------------------------------------------------

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
    <div
      style={{
        width: 1080,
        height: 1350,
        display: "flex",
        position: "relative",
        background: t.colors.paper,
        overflow: "hidden",
      }}
    >
      {/* Full-bleed image background */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1080,
          height: 1350,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#D96246",
        }}
      >
        <img
          src={props.imageSrcBase64}
          width={1080}
          height={1350}
          style={{ width: 1080, height: 1350, objectFit: "cover" }}
        />
      </div>
      {/* Top paper fade */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1080,
          height: 360,
          display: "flex",
          background:
            "linear-gradient(180deg, #F4F0E6 0%, #F4F0E6 48%, rgba(244,240,230,0) 100%)",
        }}
      />
      {/* Bottom paper fade */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: 1080,
          height: 550,
          display: "flex",
          background:
            "linear-gradient(180deg, rgba(244,240,230,0) 0%, #F4F0E6 56%, #F4F0E6 100%)",
        }}
      />
      {/* Content */}
      <div
        style={{
          position: "relative",
          width: 1080,
          height: 1350,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 44,
          paddingBottom: 48,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                fontFamily: t.fonts.mono,
                fontSize: 13,
                letterSpacing: 2,
                background: t.colors.vermilion,
                color: t.colors.white,
                borderRadius: 999,
                paddingLeft: 14,
                paddingRight: 14,
                paddingTop: 5,
                paddingBottom: 5,
                fontWeight: 700,
              }}
            >
              {props.badge}
            </div>
            <div
              style={{
                fontFamily: t.fonts.mono,
                fontSize: 14,
                letterSpacing: 2,
                color: t.colors.inkMuted,
              }}
            >
              {`${props.num} / ${props.total}`}
            </div>
          </div>
          <div
            style={{
              fontFamily: t.fonts.serif,
              fontSize: 62,
              lineHeight: 1.02,
              color: t.colors.ink,
              marginTop: 18,
            }}
          >
            {props.title}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 14,
              letterSpacing: 2,
              color: t.colors.inkMuted,
            }}
          >
            {props.kicker}
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 7,
              fontFamily: t.fonts.sans,
              fontSize: 32,
              fontWeight: 500,
              lineHeight: 1.45,
              color: t.colors.ink,
              marginTop: 12,
            }}
          >
            <span>{props.subtitleLead}</span>
            <span style={{ fontWeight: 700, color: accent }}>{props.subtitleHighlight}</span>
          </div>
          <div
            style={{
              marginTop: 28,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              paddingTop: 16,
              borderTop: `1px solid ${t.colors.rule}`,
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
                fontSize: 14,
                letterSpacing: 2,
                color: t.colors.inkMuted,
              }}
            >
              SWIPE NEXT »
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Text-only slide
// --------------------------------------------------------------------------

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
    <div
      style={{
        width: 1080,
        height: 1350,
        display: "flex",
        flexDirection: "column",
        background: t.colors.paper,
      }}
    >
      <div
        style={{
          height: 450,
          background: "linear-gradient(180deg, #D96246 0%, #B84D34 100%)",
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 44,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              fontFamily: t.fonts.mono,
              fontSize: 13,
              letterSpacing: 2,
              background: "rgba(255,255,255,0.2)",
              color: t.colors.white,
              borderRadius: 999,
              paddingLeft: 14,
              paddingRight: 14,
              paddingTop: 5,
              paddingBottom: 5,
              fontWeight: 700,
            }}
          >
            {props.badge}
          </div>
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 14,
              letterSpacing: 2,
              color: "rgba(255,255,255,0.8)",
            }}
          >
            {`${props.num} / ${props.total}`}
          </div>
        </div>
        <div
          style={{
            fontFamily: t.fonts.serif,
            fontSize: 62,
            lineHeight: 1.02,
            color: "#F4F0E6",
            marginTop: 24,
          }}
        >
          {props.title}
        </div>
      </div>

      <div
        style={{
          height: 900,
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 48,
          paddingBottom: 48,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontFamily: t.fonts.mono,
              fontSize: 14,
              letterSpacing: 2,
              color: t.colors.inkMuted,
            }}
          >
            {props.kicker}
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 7,
              fontFamily: t.fonts.sans,
              fontSize: 34,
              fontWeight: 500,
              lineHeight: 1.5,
              color: t.colors.ink,
              marginTop: 16,
            }}
          >
            <span>{props.subtitleLead}</span>
            <span style={{ fontWeight: 700, color: accent }}>{props.subtitleHighlight}</span>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 16,
            borderTop: `1px solid ${t.colors.rule}`,
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
              fontSize: 14,
              letterSpacing: 2,
              color: t.colors.inkMuted,
            }}
          >
            SWIPE NEXT »
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
