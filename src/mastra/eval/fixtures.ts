import fs from "node:fs";
import path from "node:path";
import { RankInputItemSchema, type RankInputItem } from "../schemas/ranking";

/**
 * Loader for fixtures/ranking-golden.json. Each fixture stores its item WITHOUT
 * publishedAt plus an `ageHours`; we synthesize a fresh publishedAt at load
 * time so recency is reproducible and items don't age out of the hard filter.
 */

export type GoldenLabel = "post" | "maybe" | "skip" | "";

export interface GoldenFixture {
  label: GoldenLabel;
  ageHours?: number;
  item: Record<string, unknown>; // RankInputItem minus publishedAt
}

export interface GoldenFile {
  notes?: string;
  fixtures: GoldenFixture[];
}

export const GOLDEN_PATH = path.resolve(process.cwd(), "fixtures", "ranking-golden.json");

export function loadGoldenFile(file = GOLDEN_PATH): GoldenFile {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as GoldenFile;
}

export interface LoadedFixture {
  label: GoldenLabel;
  item: RankInputItem;
}

/** Build validated RankInputItems with publishedAt = now - ageHours. */
export function loadFixtures(now: Date, file = GOLDEN_PATH): LoadedFixture[] {
  const { fixtures } = loadGoldenFile(file);
  return fixtures.map((f, i) => {
    const ageHours = f.ageHours ?? 2;
    const publishedAt = new Date(now.getTime() - ageHours * 3_600_000).toISOString();
    const parsed = RankInputItemSchema.safeParse({ ...f.item, publishedAt });
    if (!parsed.success) {
      throw new Error(
        `Fixture #${i + 1} (${String(f.item.id)}) is invalid: ${parsed.error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("; ")}`,
      );
    }
    return { label: f.label, item: parsed.data };
  });
}
