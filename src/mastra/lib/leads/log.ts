/**
 * Structured JSON logging for the lead pipeline (PRD R5/R6).
 * Same shape as the content pipeline's log(): one JSON object per line.
 * Contact values are NEVER logged: any field whose key looks like contact
 * data is replaced, and string values that look like emails/phones are masked.
 */

const CONTACT_KEY = /(email|phone|mobile|contact_value)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Standalone digit runs only, so ids/hashes like "s1_4deb0123456789ab" are left intact.
const PHONE_RE = /(?<![A-Za-z0-9_])\+?\d[\d\s().-]{7,}\d(?![A-Za-z0-9_])/g;
const ID_KEY = /^(batchId|rowId|runId|cacheKey|module|event|ts)$/;
const SECRET_RE = /(sk_[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]+)/g;

export function redact(value: unknown, key = ""): unknown {
  if (CONTACT_KEY.test(key) && value !== null && value !== undefined && typeof value !== "number" && typeof value !== "boolean") {
    return "[redacted]";
  }
  if (typeof value === "string") {
    if (ID_KEY.test(key)) return value;
    return value
      .replace(EMAIL_RE, "[email]")
      .replace(PHONE_RE, (m) =>
        m.replace(/\D/g, "").length >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? "[phone]" : m,
      )
      .replace(SECRET_RE, "[secret]");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

export function leadLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "lead", event, ...(redact(fields) as object) }));
  } catch {
    console.log(JSON.stringify({ scope: "lead", event, note: "unserialisable log fields" }));
  }
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return String(redact(msg)).slice(0, 500);
}
