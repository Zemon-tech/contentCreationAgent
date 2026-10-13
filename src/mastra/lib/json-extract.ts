/**
 * extractJson — pull the first well-formed JSON object out of an LLM response.
 *
 * Handles ```json fences and surrounding prose by walking braces (ignoring
 * those inside strings) to find the matching close. Returns `undefined` when
 * no parseable object is present, so callers can treat it as a validation
 * failure and re-prompt rather than crashing.
 *
 * This mirrors the proven approach in lib/leads/judge.ts (which keeps its own
 * private copy); it lives here as a neutral util so the ranking pipeline can
 * reuse it without importing the lead-research graph.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (esc) esc = false;
    else if (ch === "\\") esc = true;
    else if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "{") depth++;
    else if (!inStr && ch === "}" && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
