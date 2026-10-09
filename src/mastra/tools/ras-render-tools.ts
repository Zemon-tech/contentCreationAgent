/**
 * RAS Satori render tools.
 *
 *  - renderRasStoryTool    : structured copy -> single 1080x1350 story PNG
 *  - renderRasCarouselTool : structured copy -> 4-5 slide carousel PNGs
 *
 * Both inject strongly-typed props into the React templates and rasterize
 * in-process via Satori + resvg. Rendered files land under
 * <workspaceOutput>/ras/<slug>/ and are returned with view/download URLs
 * (served by routes/ras-assets.ts) plus the absolute file paths that the
 * Instagram publish tool consumes.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import path from "node:path";
import React from "react";

import { RasStoryTemplate } from "../templates/RasStoryTemplate.js";
import {
  CarouselCoverSlide,
  CarouselBodySlide,
  CarouselTextSlide,
} from "../templates/RasCarouselTemplate.js";
import { ACCENT_COLORS } from "../templates/theme.js";
import { renderComponentToPng, RAS_CANVAS } from "../renderer/satori-renderer.js";
import { loadLocalLogo, resolveHeroImage } from "../renderer/images.js";
import { logoPath } from "../renderer/assets.js";
import { ensureRasOutputDir, rasViewUrl, sanitizeSlug } from "../renderer/output.js";

const AccentEnum = z
  .enum(ACCENT_COLORS)
  .describe(
    "Category accent: #2F7C74 AI/Research, #E2A72E Funding, #C7E84A Future, #F25C3D Breaking.",
  );

const RenderedAssetSchema = z.object({
  index: z.number(),
  file: z.string().describe("Filename, e.g. '01.png'."),
  path: z.string().describe("Absolute path to the rendered PNG on disk."),
  view_url: z.string().describe("Server-relative URL to preview the image inline."),
  download_url: z.string().describe("Server-relative URL to download the image."),
  alt_text: z.string(),
});

// ---------------------------------------------------------------------------
// Story tool
// ---------------------------------------------------------------------------

export const renderRasStoryTool = createTool({
  id: "render-ras-story",
  description:
    "Render a single 1080x1350 Rise & Shine editorial STORY post to PNG from structured editorial copy. " +
    "Use for one high-impact post. Provide a hero image (local path or direct http(s) image URL).",
  inputSchema: z.object({
    slug: z.string().min(1).describe("Unique filename identifier, e.g. 'cal-ai-persona'."),
    heroImage: z
      .string()
      .min(1)
      .describe("Local file path OR direct http(s) image URL for the hero photo."),
    categoryTag: z.string().describe("Category path, e.g. 'AI · STARTUPS · FUNDING'."),
    serifHeadline: z.string().describe("Sharp editorial thesis headline (2-3 lines)."),
    deckLead: z.string().describe("Context deck line 1 (ink)."),
    deckHighlight: z.string().describe("Context deck line 2 — the emphasized phrase (accent color)."),
    deckTail: z.string().describe("Context deck line 3 (ink)."),
    accentColor: AccentEnum.default("#2F7C74"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slug: z.string(),
    format: z.literal("single"),
    outputDir: z.string(),
    assets: z.array(RenderedAssetSchema),
  }),
  execute: async (inputData) => {
    const slug = sanitizeSlug(inputData.slug);
    const outputDir = ensureRasOutputDir(slug);

    const heroImageBase64 = await resolveHeroImage(inputData.heroImage);
    const logo = loadLocalLogo(logoPath("ras-logo-dark.svg"));

    const component = React.createElement(RasStoryTemplate, {
      heroImageBase64,
      categoryTag: inputData.categoryTag,
      serifHeadline: inputData.serifHeadline,
      deckLead: inputData.deckLead,
      deckHighlight: inputData.deckHighlight,
      deckTail: inputData.deckTail,
      accentColor: inputData.accentColor,
      logoBase64: logo.dataUrl,
      logoWidth: logo.width,
      logoHeight: logo.height,
    });

    const png = await renderComponentToPng(component, RAS_CANVAS);
    const file = "01.png";
    const filePath = path.join(outputDir, file);
    writeFileSync(filePath, png);

    return {
      success: true,
      slug,
      format: "single" as const,
      outputDir,
      assets: [
        {
          index: 1,
          file,
          path: filePath,
          view_url: rasViewUrl(slug, file),
          download_url: `${rasViewUrl(slug, file)}?download=1`,
          alt_text: inputData.serifHeadline,
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// Carousel tool
// ---------------------------------------------------------------------------

const CoverSchema = z.object({
  heroImage: z.string().min(1).describe("Local path or http(s) URL for the cover hero image."),
  categoryTag: z.string(),
  datelineKicker: z.string(),
  serifHeadline: z.string(),
  deckLead: z.string(),
  deckHighlight: z.string(),
});

const BodySlideSchema = z.object({
  type: z.literal("body"),
  badge: z.string().describe("Short mono badge, e.g. 'THE SHIFT'."),
  title: z.string().describe("Serif slide title."),
  image: z.string().min(1).describe("Local path or http(s) URL for the slide image."),
  kicker: z.string().describe("Small mono kicker above the subtitle."),
  subtitleLead: z.string(),
  subtitleHighlight: z.string(),
});

const TextSlideSchema = z.object({
  type: z.literal("text"),
  badge: z.string(),
  title: z.string(),
  kicker: z.string(),
  subtitleLead: z.string(),
  subtitleHighlight: z.string(),
});

export const renderRasCarouselTool = createTool({
  id: "render-ras-carousel",
  description:
    "Render a 4-5 slide Rise & Shine editorial CAROUSEL to a folder of 1080x1350 PNGs. " +
    "Use when the story needs a multi-slide breakdown. Slide 1 is the cover; provide 3-4 following slides " +
    "(each 'body' with its own image, or 'text' only).",
  inputSchema: z.object({
    deckSlug: z.string().min(1).describe("Unique folder identifier for the carousel."),
    accentColor: AccentEnum.default("#2F7C74"),
    cover: CoverSchema,
    slides: z
      .array(z.discriminatedUnion("type", [BodySlideSchema, TextSlideSchema]))
      .min(3)
      .max(4)
      .describe("3-4 slides after the cover (yielding a 4-5 slide carousel)."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slug: z.string(),
    format: z.literal("carousel"),
    outputDir: z.string(),
    assets: z.array(RenderedAssetSchema),
  }),
  execute: async (inputData) => {
    const slug = sanitizeSlug(inputData.deckSlug);
    const outputDir = ensureRasOutputDir(slug);
    const total = String(inputData.slides.length + 1).padStart(2, "0");

    const assets: z.infer<typeof RenderedAssetSchema>[] = [];

    // Slide 1 — cover
    const coverHero = await resolveHeroImage(inputData.cover.heroImage);
    const coverLogo = loadLocalLogo(logoPath("ras-logo-dark.svg"));
    const coverComponent = React.createElement(CarouselCoverSlide, {
      heroImageBase64: coverHero,
      categoryTag: inputData.cover.categoryTag,
      datelineKicker: inputData.cover.datelineKicker,
      serifHeadline: inputData.cover.serifHeadline,
      deckLead: inputData.cover.deckLead,
      deckHighlight: inputData.cover.deckHighlight,
      accentColor: inputData.accentColor,
      logoBase64: coverLogo.dataUrl,
      logoWidth: coverLogo.width,
      logoHeight: coverLogo.height,
    });
    const coverPng = await renderComponentToPng(coverComponent, RAS_CANVAS);
    const coverFile = "01.png";
    const coverPath = path.join(outputDir, coverFile);
    writeFileSync(coverPath, coverPng);
    assets.push({
      index: 1,
      file: coverFile,
      path: coverPath,
      view_url: rasViewUrl(slug, coverFile),
      download_url: `${rasViewUrl(slug, coverFile)}?download=1`,
      alt_text: inputData.cover.serifHeadline,
    });

    // Following slides
    for (let i = 0; i < inputData.slides.length; i++) {
      const slide = inputData.slides[i];
      const num = String(i + 2).padStart(2, "0");
      let component: React.ReactElement;
      let altText: string;

      if (slide.type === "body") {
        const img = await resolveHeroImage(slide.image);
        component = React.createElement(CarouselBodySlide, {
          num,
          total,
          badge: slide.badge,
          title: slide.title,
          imageSrcBase64: img,
          kicker: slide.kicker,
          subtitleLead: slide.subtitleLead,
          subtitleHighlight: slide.subtitleHighlight,
          accentColor: inputData.accentColor,
        });
        altText = slide.title;
      } else {
        component = React.createElement(CarouselTextSlide, {
          num,
          total,
          badge: slide.badge,
          title: slide.title,
          kicker: slide.kicker,
          subtitleLead: slide.subtitleLead,
          subtitleHighlight: slide.subtitleHighlight,
          accentColor: inputData.accentColor,
        });
        altText = slide.title;
      }

      const png = await renderComponentToPng(component, RAS_CANVAS);
      const file = `${num}.png`;
      const filePath = path.join(outputDir, file);
      writeFileSync(filePath, png);
      assets.push({
        index: i + 2,
        file,
        path: filePath,
        view_url: rasViewUrl(slug, file),
        download_url: `${rasViewUrl(slug, file)}?download=1`,
        alt_text: altText,
      });
    }

    return {
      success: true,
      slug,
      format: "carousel" as const,
      outputDir,
      assets,
    };
  },
});
