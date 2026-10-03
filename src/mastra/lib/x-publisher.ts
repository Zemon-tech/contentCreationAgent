import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

function findTweetyTweetsDir(): string {
  // 1. Search upward from process.cwd() (Studio uses src/mastra/public as cwd)
  let curr = process.cwd();
  while (true) {
    const candidate = path.join(curr, 'tweetytweets');
    if (existsSync(candidate) && existsSync(path.join(candidate, 'scripts', 'post.py'))) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  // 2. Search upward from the current module file
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    curr = moduleDir;
    while (true) {
      const candidate = path.join(curr, 'tweetytweets');
      if (existsSync(candidate) && existsSync(path.join(candidate, 'scripts', 'post.py'))) {
        return candidate;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
  } catch {}

  return path.resolve(process.cwd(), 'tweetytweets');
}

const TWEETYTWEETS_DIR = findTweetyTweetsDir();
const SCRIPTS_DIR = path.join(TWEETYTWEETS_DIR, 'scripts');
const SCRATCH_DIR = path.join(TWEETYTWEETS_DIR, 'scratch');
const STATE_FILE = path.join(TWEETYTWEETS_DIR, 'state.json');

const PYTHON_BIN = process.env.PYTHON_PATH || 'python';

export interface XSessionInfo {
  loggedIn: boolean;
  handle: string | null;
  loginUrl?: string | null;
  maxChars?: number;
  error?: string | null;
  fix?: string | null;
  message: string;
}

export interface XPublishOptions {
  text: string;
  imagePath?: string;
  kind?: 'value' | 'ai_update';
  dryRun?: boolean;
}

export interface XPublishResult {
  success: boolean;
  tweetUrl?: string;
  verified: boolean;
  text: string;
  image?: string;
  screenshot?: string;
  dryRun?: boolean;
  message: string;
  error?: string;
}

/**
 * Checks the status of the dedicated X browser session.
 */
export async function checkXSession(): Promise<XSessionInfo> {
  const scriptPath = path.join(SCRIPTS_DIR, 'post.py');
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [scriptPath, 'check'], {
      cwd: TWEETYTWEETS_DIR,
      timeout: 35000,
    });
    const parsed = JSON.parse(stdout.trim());
    return {
      loggedIn: !!parsed.logged_in,
      handle: parsed.handle || null,
      maxChars: parsed.max_chars ?? 280,
      message: parsed.logged_in
        ? `Logged in to X as @${parsed.handle} (Max chars: ${parsed.max_chars ?? 280})`
        : 'Browser is connected, but account is not logged in.',
    };
  } catch (err: any) {
    const rawOutput = err.stdout || err.stderr || err.message;
    try {
      const parsed = JSON.parse(rawOutput.trim());
      return {
        loggedIn: false,
        handle: parsed.handle || null,
        loginUrl: parsed.url || null,
        error: parsed.error,
        fix: parsed.fix,
        message: parsed.fix || parsed.error || 'Failed to detect active session',
      };
    } catch {
      return {
        loggedIn: false,
        handle: null,
        error: rawOutput,
        message: `Session check error: ${rawOutput}`,
      };
    }
  }
}

/**
 * Launches the dedicated Chrome/Edge browser for initial sign-in.
 */
export async function launchXBrowser(): Promise<{ success: boolean; message: string }> {
  const scriptPath = path.join(SCRIPTS_DIR, 'browser.py');
  try {
    await execFileAsync(PYTHON_BIN, [scriptPath, 'launch'], {
      cwd: TWEETYTWEETS_DIR,
      timeout: 30000,
    });
    return {
      success: true,
      message: 'Dedicated automation browser launched. Please sign into X in that window.',
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to launch browser: ${err.message}`,
    };
  }
}

/**
 * Measures the empirical character limit of the logged-in account (280 vs Premium 25k).
 */
export async function measureXLimit(): Promise<any> {
  const scriptPath = path.join(SCRIPTS_DIR, 'post.py');
  const { stdout } = await execFileAsync(PYTHON_BIN, [scriptPath, 'measure', '--save'], {
    cwd: TWEETYTWEETS_DIR,
    timeout: 60000,
  });
  return JSON.parse(stdout.trim());
}

/**
 * Posts text (and optional image) directly to X using tweetytweets CDP browser automation.
 */
export async function publishToX(options: XPublishOptions): Promise<XPublishResult> {
  const { text, imagePath, kind = 'value', dryRun = false } = options;

  if (!text || text.trim().length === 0) {
    throw new Error('Tweet text cannot be empty');
  }

  // Ensure scratch dir exists
  await fs.mkdir(SCRATCH_DIR, { recursive: true });

  const draftFileName = `post_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`;
  const draftFilePath = path.join(SCRATCH_DIR, draftFileName);
  await fs.writeFile(draftFilePath, text.trim(), 'utf-8');

  const scriptPath = path.join(SCRIPTS_DIR, 'post.py');
  const args = ['post', '--text-file', draftFilePath, '--kind', kind];

  if (imagePath && existsSync(imagePath)) {
    args.push('--image', path.resolve(imagePath));
  }

  if (dryRun) {
    args.push('--dry-run');
  }

  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [scriptPath, ...args], {
      cwd: TWEETYTWEETS_DIR,
      timeout: 180000, // up to 3 mins for typing, uploading, posting and 90s profile verification polling
    });

    let parsed: any;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      // Fallback: check state.json
      if (existsSync(STATE_FILE)) {
        const stateData = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
        const posts = stateData.posts || [];
        parsed = posts[posts.length - 1];
      }
    }

    if (!parsed) {
      throw new Error(`Unexpected empty output from post.py: ${stdout}`);
    }

    if (parsed.error) {
      return {
        success: false,
        verified: false,
        text,
        error: parsed.error,
        screenshot: parsed.screenshot,
        message: `Failed to post: ${parsed.error}`,
      };
    }

    if (parsed.dry_run) {
      return {
        success: true,
        dryRun: true,
        verified: false,
        text,
        screenshot: parsed.screenshot,
        message: `Dry-run completed successfully (${parsed.chars} chars). Screenshot captured at ${parsed.screenshot}.`,
      };
    }

    const tweetUrl = parsed.tweet_url || undefined;
    const verified = !!parsed.verified;

    return {
      success: true,
      tweetUrl,
      verified,
      text,
      image: parsed.image,
      screenshot: parsed.screenshot,
      message: verified && tweetUrl
        ? `Successfully posted and verified on profile! Live at: ${tweetUrl}`
        : 'Posted to X, awaiting timeline index.',
    };
  } catch (err: any) {
    const raw = err.stdout || err.stderr || err.message;
    let errMsg = raw;
    try {
      const jsonErr = JSON.parse(raw.trim());
      errMsg = jsonErr.error || jsonErr.fix || raw;
    } catch {}

    return {
      success: false,
      verified: false,
      text,
      error: errMsg,
      message: `Failed to post to X: ${errMsg}`,
    };
  }
}
