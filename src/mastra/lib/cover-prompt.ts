/**
 * Pure cover-prompt builder driven by the `neoclassical-editorial-image`
 * skill (.agents/skills/neoclassical-editorial-image/SKILL.md).
 * Shared by the generateCoverPrompt tool and the news-to-post workflow
 * so both produce byte-identical canonical JSON.
 */

export const HOUSE_BLUE = "#087FEA";
export const HOUSE_INK = "#0B0C0C";
export const HOUSE_PAPER = "#F3EFE5";
export const HOUSE_YELLOW = "#F4E900";

export interface MetaphorRoute {
  match: RegExp;
  thesis: string;
  metaphor: string;
  hero: string;
  supporting: string[];
  composition: string;
  palette: [string, string, string, string];
  accentWhat: string;
}

export const COVER_ROUTES: MetaphorRoute[] = [
  {
    match: /rout|divert|leak|investigat|accus|secret|breach|scrap|distill|plagiar/i,
    thesis: "The image is really about hidden diversion behind rival facades under unresolved scrutiny.",
    metaphor:
      "a monumental engraved aqueduct-manifold with twin pavilion-server towers secretly diverting glowing scroll-streams through hidden copper tubes beneath a sealed border wall into a veiled oracle head, watched by a giant inspector seal-magnifier",
    hero: "monumental engraved aqueduct-manifold block with twin pavilion-server towers, cut open to reveal hidden copper tubes diverting glowing scroll-streams sideways",
    supporting: [
      "glowing scroll-exchange streams flowing through exposed tubes",
      "a segmented border wall with wax inspection seals straddling the tubes",
      "a veiled classical oracle head receiving the diverted streams at right",
      "a giant inspector seal-magnifier hovering top-left over the junction",
    ],
    composition:
      "Pattern F diagrammatic cutaway: hero manifold center-left at 65% scale, hidden tubes running diagonally under the border wall to the veiled head at right edge, seal-magnifier top-left counterweight, blue negative space top-right",
    palette: [HOUSE_BLUE, HOUSE_INK, HOUSE_PAPER, HOUSE_YELLOW],
    accentWhat: "diverted streams in acid yellow #F4E900",
  },
  {
    match: /fund|rais|valuation|market|stock|investor|ipo|revenue|profit|crash|rally/i,
    thesis: "The image is really about steering through unstable fortune.",
    metaphor:
      "a robed classical navigator balancing atop a giant astrolabe wheel whose rings are volatile candlestick chart arcs, clutching a glowing ledger while engraved waves churn below",
    hero: "robed classical navigator figure balanced atop a giant astrolabe-chart wheel rendered in deep ink engraving",
    supporting: [
      "candlestick chart arcs forming the astrolabe rings",
      "a glowing ledger tablet clutched under the arm",
      "engraved waves with tiny paper boats below",
    ],
    composition:
      "Pattern G surreal scale shift: giant wheel center at 70% scale, tiny figure on its apex, one chart spike breaking the top-right edge, calm paper negative space left",
    palette: [HOUSE_PAPER, HOUSE_INK, "#6A39D7", "#D96532"],
    accentWhat: "chart spike in ultraviolet #6A39D7",
  },
  {
    match: /launch|release|unveil|announc|introduc|debut|model|breakthrough/i,
    thesis: "The image is really about classical craft collaborating with autonomous machine labor.",
    metaphor:
      "a marble sculptor-figure and a floating robotic arm co-carving a glowing blueprint-column of code",
    hero: "life-size marble sculptor figure in black-cream engraving, holding a chisel to a half-marble half-glowing-code column",
    supporting: [
      "an articulated robotic arm mirroring the sculptor gesture",
      "floating code glyphs and blueprint grid fragments",
      "a small laurel-wrapped laptop at the base",
    ],
    composition:
      "Pattern B classical-figure-plus-modern-tech: hero left-of-center at 65% scale, robotic arm entering top-right, generous blue negative space right",
    palette: [HOUSE_BLUE, HOUSE_INK, HOUSE_PAPER, HOUSE_YELLOW],
    accentWhat: "code nodes in acid yellow #F4E900",
  },
  {
    match: /secur|attack|hack|threat|defen|vulnerab|malware|ransom|cyber/i,
    thesis: "The image is really about fragile openness guarded by ancient vigilance.",
    metaphor:
      "a marble watchtower-owl perched on a server bastion, wings spread over a tiny engraved city threaded with glowing cables",
    hero: "large marble owl with spread engraved wings perched on a server-rack bastion block",
    supporting: [
      "a tiny engraved city with glowing cable threads",
      "small shield-seals and beacon lights",
      "fragmented firewall portcullis bars",
    ],
    composition:
      "Pattern A hero-plus-symbolic-object: owl-bastion center at 65% scale, city cradled below wings, diagonal cables leading the eye",
    palette: ["#18A8C7", HOUSE_INK, HOUSE_PAPER, "#FF8A00"],
    accentWhat: "beacons in orange #FF8A00",
  },
];

export const COVER_FALLBACK: MetaphorRoute = {
  match: /.*/s,
  thesis: "The image is really about classical knowledge placed inside a modern moment.",
  metaphor:
    "a classical scholar-figure operating a futuristic console-desk that extrudes glowing diagram scrolls into the air",
  hero: "classical scholar-figure in black-cream engraving seated at a futuristic console-desk extruding glowing scrolls",
  supporting: [
    "glowing diagram scrolls rising from the console",
    "floating old charts rewired with bright nodes",
    "a small antique globe beside a modern tablet",
  ],
  composition:
    "Pattern F diagrammatic collage: hero center at 60% scale, scroll-streams rising diagonally, negative space upper right",
  palette: [HOUSE_BLUE, HOUSE_INK, HOUSE_PAPER, HOUSE_YELLOW],
  accentWhat: "diagram nodes in acid yellow #F4E900",
};

export function pickCoverRoute(text: string): MetaphorRoute {
  return COVER_ROUTES.find((r) => r.match.test(text)) ?? COVER_FALLBACK;
}

function firstSentences(text: string, n: number): string {
  const parts = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, n).join(" ").slice(0, 400);
}

export interface BuiltCoverPrompt {
  thesis: string;
  visualMetaphor: string;
  fluxPrompt: string;
  compact: string;
  colorPalette: string[];
  composition: string;
  coverPromptJson: Record<string, unknown>;
}

export function buildCoverPrompt(
  articleTitle: string,
  articleText: string,
  targetModel: string = "flux",
): BuiltCoverPrompt {
  const route = pickCoverRoute(`${articleTitle}\n${articleText}`);
  const contextSeed = firstSentences(articleText, 2);

  const fluxPrompt =
    `${route.hero}, ${route.supporting[0]}, copperplate engraving and screen-print editorial style, ` +
    `hero in deep ink ${route.palette[1]} with paper ${route.palette[2]} on field ${route.palette[0]} ` +
    `with ${route.accentWhat}, diagrammatic poster composition`;

  const compact =
    `${route.metaphor.split(",")[0]}, engraved editorial collage, ` +
    `${route.palette[0]} ground, ink hero, accent ${route.palette[3]}.`;

  const coverPromptJson: Record<string, unknown> = {
    meta: {
      schema_version: "1.0",
      skill: "neoclassical-editorial-image",
      style_system: "contemporary-neoclassical-editorial-collage",
      target_model: targetModel,
      task_type: "text_to_image",
      prompt_complexity: "standard",
    },
    creative_brief: {
      source: `article: ${articleTitle}`,
      topic: articleTitle,
      thesis: route.thesis,
      abstract_concept: `Classical visual logic applied to: ${contextSeed.slice(0, 160)}`,
      visual_metaphor: route.metaphor,
      image_goal: "Editorial cover hero communicating the idea, not illustrating literal words",
    },
    art_direction: {
      style_name: "Contemporary Neoclassical Editorial Collage",
      style_archetype: "neoclassical-pop-editorial",
      historical_language: "engraving, classical architecture and figures, old diagrams and seals",
      contemporary_language: "servers, data streams, modern devices and interfaces",
      medium: "mixed-media editorial collage, copperplate etching plus halftone screen print",
      rendering_language: "cross-hatched ink drawing with stipple and halftone glow",
      composition_language: route.composition,
      color_strategy: `dominant ${route.palette[0]} ground, black-cream hero, single ${route.palette[3]} accent`,
      texture_strategy: "dense cross-hatching, engraving lines, stipple, halftone, paper grain, misregistration",
      mood: "intellectually curious, surreal, sophisticated, provocative",
    },
    visual_spec: {
      hero_subject: route.hero,
      supporting_elements: route.supporting,
      environment: `saturated ${route.palette[0]} field with faint diagram grid`,
      composition: route.composition,
      lighting: "directional graphic light, ink shadow masses, symbolic glow",
      color_palette: route.palette,
      color_hierarchy: "saturated background, black-cream hero, one high-saturation accent",
      materials: ["carved stone", "aged paper", "engraved metal", "ink"],
      textures: ["dense cross-hatching", "stipple dots", "halftone", "paper grain"],
      typography: "no text, wordless editorial illustration",
    },
    style_constraints: {
      non_negotiables: [
        "old x new tension",
        "strong visual metaphor",
        "engraved tactile rendering",
        "saturated contemporary color",
        "black-cream anchor",
        "print texture",
      ],
      preferred: ["asymmetric poster layout", "large negative space"],
      avoid: ["company logos", "real persons", "glossy CGI", "readable text", "watermark"],
    },
    prompts: { primary: fluxPrompt, compact, model_specific: fluxPrompt },
    negative_prompt: { enabled: false, content: "" },
    generation_parameters: { aspect_ratio: "4:5" },
  };

  return {
    thesis: route.thesis,
    visualMetaphor: route.metaphor,
    fluxPrompt,
    compact,
    colorPalette: [...route.palette],
    composition: route.composition,
    coverPromptJson,
  };
}
