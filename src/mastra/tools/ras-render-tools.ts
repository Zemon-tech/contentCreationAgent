/**
 * RAS Satori render tools.
 *
 *  - renderRasStoryTool       : structured copy -> single 1080x1350 story PNG
 *  - renderRasCarouselTool    : structured copy -> 4-5 slide carousel PNGs
 *  - renderRasPosterStoryTool : structured copy + hero cutout -> single 1080x1350 poster PNG
 *
 * All inject strongly-typed props into the React templates and rasterize
 * in-process via Satori + resvg. Rendered files land under
 * <workspaceOutput>/ras/<slug>/ and are returned with view/download URLs
 * (served by routes/ras-assets.ts) plus the absolute file paths that the
 * Instagram publish tool consumes.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import React from "react";

import { RasStoryTemplate } from "../templates/RasStoryTemplate.js";
import {
  CarouselCoverSlide,
  CarouselBodySlide,
  CarouselTextSlide,
} from "../templates/RasCarouselTemplate.js";
import { RasPosterStoryTemplate } from "../templates/RasPosterStoryTemplate.js";
import { ACCENT_COLORS } from "../templates/theme.js";
import { renderComponentToPng, RAS_CANVAS } from "../renderer/satori-renderer.js";
import { loadLocalLogo, resolveHeroImage } from "../renderer/images.js";
import { preparePosterStory, loadLogoAsset } from "./Postertools.js";
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

// ---------------------------------------------------------------------------
// Poster story tool
// ---------------------------------------------------------------------------
//
// IN-PROCESS Satori template (template id 'ras-poster-story'). Deliberately NOT
// part of the external Design Agent template_id enums (see design-tools.ts):
// it renders here, not via the external Python Design Agent REST service.
//
// Logo handling: the only brand assets shipped in this repo are SVGs, but
// loadLogoAsset() reads a RASTER PNG via sharp (it throws on an SVG). So the
// black raster logo is loaded only when it actually exists on disk; when it is
// absent, the logo props are stripped and the template falls back to its
// "Rise & Shine" text wordmark. Rendering MUST succeed with no logo binary
// present. The tool is non-throwing on bad copy/image — it surfaces `ready`
// and `problems` instead (matching the makeHeroCutout convention).

export const renderRasPosterStoryTool = createTool({
  id: "render-ras-poster-story",
  description:
    "Render a single 1080x1350 Rise & Shine POSTER story post to PNG from a hero image and a 3-line condensed headline. " +
    "Use for a high-impact 'cutout poster' post: the hero image is automatically background-removed into a transparent cutout " +
    "on a cream grid-paper poster. Returns `ready`/`problems` so copy or image issues surface without throwing.",
  inputSchema: z.object({
    slug: z.string().min(1).describe("Unique filename identifier, e.g. 'ai-models-upgrade'."),
    heroImage: z
      .string()
      .min(1)
      .describe("Rectangular hero source (http(s) URL, local path, or data URI) to cut out."),
    headlineTop: z.string().describe("Headline line 1 (accent colour)."),
    headlineMid: z.string().describe("Headline line 2 (ink)."),
    headlineHighlight: z.string().describe("Headline line 3 (white on accent pill)."),
    categoryTag: z.string().optional().describe("Optional kicker, e.g. 'AI · STARTUPS · FUNDING'."),
    accentColor: AccentEnum.optional(),
    showMarkers: z.boolean().optional().describe("Draw the two small ink triangles. Default true."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slug: z.string(),
    format: z.literal("single"),
    outputDir: z.string(),
    assets: z.array(RenderedAssetSchema),
    ready: z.boolean().describe("True when both copy and hero cutout passed their checks."),
    problems: z.array(z.string()).describe("Copy/image issues; empty when ready."),
  }),
  execute: async (inputData) => {
    const slug = sanitizeSlug(inputData.slug);
    const outputDir = ensureRasOutputDir(slug);

    // Load the black raster logo only if a real PNG exists; otherwise fall back
    // to the template's text wordmark (SVGs would make loadLogoAsset throw).
    const blackLogoPath = logoPath("ras-logo-black.png");
    const brand =
      existsSync(blackLogoPath)
        ? await loadLogoAsset(blackLogoPath)
        : { logoBase64: "", logoWidth: 0, logoHeight: 0 };

    const prepared = await preparePosterStory(
      {
        heroSource: inputData.heroImage,
        headlineTop: inputData.headlineTop,
        headlineMid: inputData.headlineMid,
        headlineHighlight: inputData.headlineHighlight,
        categoryTag: inputData.categoryTag,
        accentColor: inputData.accentColor,
      },
      brand,
    );

    const props = { ...prepared.props };
    // When no logo binary is present, drop the logo props so the template draws
    // its text wordmark (it only renders the logo when all three are truthy).
    if (!brand.logoBase64 || !brand.logoWidth || !brand.logoHeight) {
      delete props.logoBase64;
      delete props.logoWidth;
      delete props.logoHeight;
    }
    if (inputData.showMarkers !== undefined) {
      props.showMarkers = inputData.showMarkers;
    }

    const component = React.createElement(RasPosterStoryTemplate, props);
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
          alt_text: `${inputData.headlineTop} ${inputData.headlineMid} ${inputData.headlineHighlight}`,
        },
      ],
      ready: prepared.ready,
      problems: prepared.problems,
    };
  },
});
