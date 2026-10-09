/**
 * Rise & Shine (RAS) by KeilHQ — brand design tokens.
 *
 * Single source of truth for colors and font family names used by the Satori
 * templates. Font family names here MUST match the `name` values registered
 * in renderer/fonts.ts, or Satori falls back and the layout breaks.
 */

export const RAS_THEME = {
  colors: {
    ink: "#151615", // Midnight Ink — headlines, dark body text
    paper: "#F4F0E6", // Daybreak Paper — light editorial background
    rule: "#D6CFBF", // Hairline divider
    vermilion: "#F25C3D", // Daybreak Vermilion — brand/signal marker
    inkMuted: "rgba(21,22,21,0.60)", // Subtext, dateline, labels
    quoteAccent: "#C7E84A", // Fresh Lime — pull-quote accent bar
    white: "#FFFFFF",

    /** Category accents — pick one per post based on domain. */
    categories: {
      AI_RESEARCH: "#2F7C74", // Signal Teal (default)
      FUNDING: "#E2A72E", // Harvest Gold
      FUTURE: "#C7E84A", // Fresh Lime
      BREAKING: "#F25C3D", // Vermilion
    },
  },
  fonts: {
    sans: "Inter",
    serif: "Instrument Serif",
    mono: "IBM Plex Mono",
  },
} as const;

/** The allowed accent color values (used by Zod enums in the tools). */
export const ACCENT_COLORS = [
  RAS_THEME.colors.categories.AI_RESEARCH,
  RAS_THEME.colors.categories.FUNDING,
  RAS_THEME.colors.categories.FUTURE,
  RAS_THEME.colors.categories.BREAKING,
] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];
