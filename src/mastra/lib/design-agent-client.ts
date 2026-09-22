import fs from 'node:fs';
import path from 'node:path';

export interface CreateJobParams {
  content: string;
  template_id?: 'tech-announcement' | 'keilhq-editorial' | 'keilhq-text' | 'entrepreneur-post';
  format?: 'single' | 'carousel';
  aspect_ratio?: '4:5' | '1:1' | '3:4';
  max_slides?: number;
}

export interface SlideManifest {
  index: number;
  file: string;
  alt_text: string;
}

export interface PostManifest {
  slides: SlideManifest[];
  caption: string;
  hashtags: string[];
  template_id: string;
  format: string;
  aspect_ratio: string;
}

export interface JobStatusResponse {
  job_id: string;
  status: 'queued' | 'planning' | 'generating_images' | 'compositing' | 'done' | 'failed';
  output_dir?: string | null;
  error?: string | null;
  post?: PostManifest | null;
}

export interface WorkspaceDeliverables {
  destDir: string;
  copiedFiles: string[];
  caption: string;
  hashtags: string[];
  slides: SlideManifest[];
}

function getBaseUrl(): string {
  return (process.env.DESIGN_AGENT_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

function getApiKey(): string {
  return process.env.DESIGN_AGENT_API_KEY || 'change-me';
}

function getDesignOutputDir(): string {
  return process.env.DESIGN_AGENT_OUTPUT_DIR || 'S:/tmp/design-agent/output';
}

/**
 * Submits a new post creation job to the Design Agent REST API.
 */
export async function submitDesignJob(params: CreateJobParams): Promise<{ job_id: string; status: string }> {
  const baseUrl = getBaseUrl();
  const apiKey = getApiKey();

  const url = `${baseUrl}/jobs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      content: params.content,
      template_id: params.template_id || 'tech-announcement',
      format: params.format || 'single',
      aspect_ratio: params.aspect_ratio || '4:5',
      max_slides: params.max_slides ?? 5,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Design Agent /jobs returned HTTP ${res.status}: ${errorBody || res.statusText}`);
  }

  return (await res.json()) as { job_id: string; status: string };
}

/**
 * Queries current job status and deliverables.
 */
export async function getDesignJobStatus(jobId: string): Promise<JobStatusResponse> {
  const baseUrl = getBaseUrl();
  const apiKey = getApiKey();

  const url = `${baseUrl}/jobs/${jobId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
    },
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Design Agent /jobs/${jobId} returned HTTP ${res.status}: ${errorBody || res.statusText}`);
  }

  return (await res.json()) as JobStatusResponse;
}

/**
 * Polls the job status until completion or failure.
 */
export async function waitForDesignJob(
  jobId: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number; onProgress?: (status: string) => void },
): Promise<JobStatusResponse> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
  const startTime = Date.now();

  let lastStatus = '';

  while (Date.now() - startTime < timeoutMs) {
    const data = await getDesignJobStatus(jobId);

    if (data.status !== lastStatus) {
      lastStatus = data.status;
      options?.onProgress?.(data.status);
    }

    if (data.status === 'done') {
      return data;
    }

    if (data.status === 'failed') {
      throw new Error(`Design Agent job ${jobId} failed: ${data.error || 'Unknown error'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Design Agent job ${jobId} timed out after ${timeoutMs / 1000} seconds (last status: ${lastStatus})`);
}

/**
 * Copies the deliverables from design-agent output directory to the Mastra workspace.
 */
export function copyDeliverablesToWorkspace(jobStatus: JobStatusResponse, customWorkspaceDir?: string): WorkspaceDeliverables {
  if (jobStatus.status !== 'done' || !jobStatus.post) {
    throw new Error(`Cannot copy deliverables for job ${jobStatus.job_id}: job is not done`);
  }

  const workspaceRoot = customWorkspaceDir || path.resolve(process.cwd(), 'workspace');
  const destDir = path.join(workspaceRoot, 'output', jobStatus.job_id);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Resolve source output directory
  let sourceDir = jobStatus.output_dir ? path.resolve(jobStatus.output_dir) : '';
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    sourceDir = path.join(getDesignOutputDir(), jobStatus.job_id);
  }

  const copiedFiles: string[] = [];

  if (fs.existsSync(sourceDir)) {
    const entries = fs.readdirSync(sourceDir);
    for (const entry of entries) {
      const srcFile = path.join(sourceDir, entry);
      const destFile = path.join(destDir, entry);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, destFile);
        copiedFiles.push(destFile);
      }
    }
  }

  return {
    destDir,
    copiedFiles,
    caption: jobStatus.post.caption,
    hashtags: jobStatus.post.hashtags,
    slides: jobStatus.post.slides,
  };
}
