import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApiRoute } from '@mastra/core/server';

function findPostOutputRoot(): string {
  // `mastra dev` executes the bundled server from .mastra/output, while the
  // source project keeps its workspace at the project root. Walk upwards so
  // this works in both development and a normal production process.
  // Mastra changes process.cwd() to src/mastra/public while it serves Studio,
  // so derive the search from this module's location instead.
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

const POST_OUTPUT_ROOT = findPostOutputRoot();
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

    const assetPath = path.resolve(POST_OUTPUT_ROOT, jobId, filename);
    const jobOutputDir = path.resolve(POST_OUTPUT_ROOT, jobId);

    // Defense in depth: keep route parameters from escaping this job folder.
    if (!assetPath.startsWith(`${jobOutputDir}${path.sep}`)) {
      return c.text('Post asset not found', 404);
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
      return c.text('Post asset not found', 404);
    }
  },
});
