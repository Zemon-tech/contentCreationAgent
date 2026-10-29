import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { imageConfig, type ImageConfig } from "../../config/image.config";
import { downloadAndValidate } from "./validate";
import { hostOf } from "../article-body";
import { searchExa } from "../../tools/exa-tools";

/**
 * Image sourcing (Step 5). Candidate order: FEED image -> Exa image search ->
 * none (text-only). No generation (no Flux). The first candidate that passes
 * deterministic validation is downloaded to IMAGE_DIR (filename = content hash,
 * so the same image is never saved twice) and its LOCAL path is returned for
 * RAS to composite. Rights are never verified here: rightsStatus is always
 * "unverified" and nothing is marked cleared.
 */

export interface ImageResult {
  imageLocalPath: string | null;
  imageSourceUrl: string | null;
  imageAttribution: string | null;
  rightsStatus: "unverified";
  under1080: boolean;
  chosenFrom: "feed" | "exa" | "none";
  candidatesTried: number;
  reason?: string;
}

const TEXT_ONLY: Omit<ImageResult, "candidatesTried"> = {
  imageLocalPath: null,
  imageSourceUrl: null,
  imageAttribution: null,
  rightsStatus: "unverified",
  under1080: false,
  chosenFrom: "none",
};

async function exaImageCandidates(headline: string, cfg: ImageConfig): Promise<string[]> {
  if (!process.env.EXA_API_KEY) return [];
  try {
    const res = await searchExa({ query: headline, numResults: cfg.exaCandidates, includeText: false, includeImages: true });
    return (res?.results ?? [])
      .map((r) => (r as { image?: string }).image)
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  } catch {
    return [];
  }
}

function saveImage(buffer: Buffer, ext: string, cfg: ImageConfig): string {
  fs.mkdirSync(cfg.imageDir, { recursive: true });
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const filePath = path.join(cfg.imageDir, `${hash}.${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer); // dedup: never save twice
  return filePath;
}

export async function sourceImage(args: {
  headline: string;
  feedCandidateUrls?: string[];
  config?: ImageConfig;
}): Promise<ImageResult> {
  const cfg = args.config ?? imageConfig;
  const feed = [...new Set((args.feedCandidateUrls ?? []).filter(Boolean))];
  let tried = 0;

  const tryList = async (urls: string[], from: "feed" | "exa"): Promise<ImageResult | null> => {
    for (const url of urls) {
      tried++;
      const v = await downloadAndValidate(url, cfg);
      if (v.ok && v.buffer && v.ext) {
        const localPath = saveImage(v.buffer, v.ext, cfg);
        return {
          imageLocalPath: localPath,
          imageSourceUrl: url,
          imageAttribution: hostOf(url),
          rightsStatus: "unverified",
          under1080: !!v.under1080,
          chosenFrom: from,
          candidatesTried: tried,
        };
      }
    }
    return null;
  };

  const fromFeed = await tryList(feed, "feed");
  if (fromFeed) return fromFeed;

  const exa = await exaImageCandidates(args.headline, cfg);
  const fromExa = await tryList(exa, "exa");
  if (fromExa) return fromExa;

  return { ...TEXT_ONLY, candidatesTried: tried, reason: tried === 0 ? "no candidates" : "no candidate passed validation" };
}
