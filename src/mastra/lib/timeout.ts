/**
 * Hard time limit for a slow external call (LLM, Exa, page fetch).
 *
 * The callback receives an AbortSignal and SHOULD pass it to the underlying
 * request (fetch / agent.generate) so a timeout actually cancels the request
 * instead of leaving it running in the background. Rejects with TimeoutError
 * when the limit is hit; callers decide how to fall back.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // ms <= 0 disables the limit (escape hatch via env).
  if (!(ms > 0)) return fn(new AbortController().signal);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError;
}
