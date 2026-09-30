import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApiRoute } from '@mastra/core/server';

function findProjectPostOutputRoot(): string {
  // The development bundle is under .mastra/output; search upward from it to
  // retain access to posts produced before Studio began using its own cwd.
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  let directory = moduleDirectory;

  while (true) {
    const candidate = path.join(directory, 'workspace', 'output');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return path.join(moduleDirectory, 'workspace', 'output');
    }
    directory = parent;
  }
}

// Studio runs the server with src/mastra/public as cwd. This is also the
// location used by copyDeliverablesToWorkspace(), so it must be searched
// first. The project root remains a fallback for already-saved posts.
const POST_OUTPUT_ROOTS = [
  path.resolve(process.cwd(), 'workspace', 'output'),
  findProjectPostOutputRoot(),
].filter((value, index, values) => values.indexOf(value) === index);
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLIDE_FILENAME_PATTERN = /^slide_\d+\.jpe?g$/i;

/**
 * URLs emitted by the post tools resolve against the Mastra server. Keeping
 * this route narrowly scoped means Studio can display a generated slide
 * without exposing arbitrary workspace files.
 */
export const postAssetRoute = registerApiRoute('/post-assets/:jobId/:filename', {
  method: 'GET',
  handler: async (c) => {
    const jobId = c.req.param('jobId');
    const filename = c.req.param('filename');

    if (!JOB_ID_PATTERN.test(jobId) || !SLIDE_FILENAME_PATTERN.test(filename)) {
      return c.text('Post asset not found', 404);
    }

    for (const outputRoot of POST_OUTPUT_ROOTS) {
      const assetPath = path.resolve(outputRoot, jobId, filename);
      const jobOutputDir = path.resolve(outputRoot, jobId);

      // Defense in depth: keep route parameters from escaping this job folder.
      if (!assetPath.startsWith(`${jobOutputDir}${path.sep}`)) {
        continue;
      }

      try {
        const asset = await readFile(assetPath);
        const download = c.req.query('download') === '1';

        return c.body(asset, 200, {
          'Content-Type': 'image/jpeg',
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
          'X-Content-Type-Options': 'nosniff',
        });
      } catch {
        // Try the legacy workspace location before reporting a missing asset.
      }
    }

    return c.text('Post asset not found', 404);
  },
});
