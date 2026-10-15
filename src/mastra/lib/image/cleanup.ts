import fs from "node:fs";
import path from "node:path";
import { imageConfig, type ImageConfig } from "../../config/image.config";

/**
 * Delete downloaded images older than retentionDays — but NEVER delete a file
 * that belongs to a story still pending approval or currently publishing
 * (pass those paths in `protect`). Pure-ish: callers supply `protect` and
 * optionally `now`, so it is testable.
 */
export interface CleanupResult {
  deleted: string[];
  kept: number;
  protectedSkipped: number;
}

export function cleanupImages(args: { protect?: Set<string>; now?: Date; config?: ImageConfig } = {}): CleanupResult {
  const cfg = args.config ?? imageConfig;
  const protect = args.protect ?? new Set<string>();
  const now = (args.now ?? new Date()).getTime();
  const cutoff = now - cfg.retentionDays * 86_400_000;

  const result: CleanupResult = { deleted: [], kept: 0, protectedSkipped: 0 };
  if (!fs.existsSync(cfg.imageDir)) return result;

  for (const name of fs.readdirSync(cfg.imageDir)) {
    const filePath = path.join(cfg.imageDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (protect.has(filePath)) {
      result.protectedSkipped++;
      continue;
    }
    if (stat.mtimeMs < cutoff) {
      try {
        fs.unlinkSync(filePath);
        result.deleted.push(filePath);
      } catch {
        /* ignore */
      }
    } else {
      result.kept++;
    }
  }
  return result;
}
