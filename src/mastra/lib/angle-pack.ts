/**
 * Pure angle-pack builder: viral / controversy / unique-angle mining.
 * Shared by the generateAnglePack tool and the news-to-post workflow.
 */

export interface BuiltAnglePack {
  stakeholders: string[];
  moneyAndNumbers: string[];
  openQuestions: string[];
  viralAngle: string;
  controversyAngle: string;
  uniqueAngle: string;
  recommendedAngle: string;
  rationale: string;
}

const ORG_HINT = /\b([A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,2})\b/g;
const NUMBER_HINT = /\b\d[\d,]*(?:\.\d+)?\s*(?:million|billion|trillion|M|B|K|%|percent)?\b/gi;
const QUESTION_HINT = /[^.!?]*\?/g;
const STOPWORDS = new Set([
  "The", "This", "That", "These", "Those", "Chinese", "After", "While",
  "When", "What", "Which", "There", "Here", "They", "Their",
]);

function topPhrases(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(ORG_HINT)) {
    const phrase = m[1].trim();
    if (phrase.length < 3 || STOPWORDS.has(phrase.split(" ")[0])) continue;
    if (/^[a-z]/.test(phrase)) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([p]) => p);
}

function topNumbers(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_HINT)) {
    const n = m[0].trim();
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

function openQuestions(text: string, limit: number): string[] {
  const found = (text.match(QUESTION_HINT) ?? []).map((q) => q.trim()).filter((q) => q.length > 12);
  const hedges = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) =>
      /unresolved|unclear|unknown|denies|denied|claims|alleges|under investigation|nothing .* proven|whether/i.test(s),
    )
    .map((s) => s.trim().slice(0, 160));
  return [...found, ...hedges].slice(0, limit);
}

function allegationRoles(full: string, stakeholders: string[]): { accuser: string; accused: string } {
  const accuserMatch = full.match(/\b([A-Z][A-Za-z0-9&.-]+) (?:accuses?|accused|claims?|alleges?|alleged|says?)\b/);
  const accuser = accuserMatch?.[1] ?? stakeholders[1] ?? "the accuser";
  const accusedPool = stakeholders.filter((s) => s !== accuser);
  const accused =
    accusedPool.length >= 2
      ? `${accusedPool[0]} and ${accusedPool[1]}`
      : (accusedPool[0] ?? "the accused labs");
  return { accuser, accused };
}

export function buildAnglePack(articleTitle: string, articleText: string): BuiltAnglePack {
  const full = `${articleTitle}. ${articleText}`;
  const stakeholders = topPhrases(full, 5);
  const moneyAndNumbers = topNumbers(full, 5);
  const questions = openQuestions(articleText, 4);
  const { accuser, accused } = allegationRoles(full, stakeholders);
  const num = moneyAndNumbers[0] ?? "undisclosed volume";

  const viralAngle = `Scale shock: ${num} routed exchanges put "${articleTitle}" in one number — lead the carousel with the count, then the human stake.`;
  const controversyAngle =
    questions.length > 0
      ? `Unresolved fault line: ${accuser} accuses ${accused} — "${questions[0].slice(0, 120)}" Nothing proven yet; frame both claims side by side.`
      : `Fault line: ${accuser} accuses ${accused} while regulators circle — frame allegation vs denial with evidence each side has actually shown.`;
  const uniqueAngle = `Second-order lens: who bears the cost if the allegation is true (users whose data moved without consent) vs if it is false (open labs under a cloud) — the incentives angle nobody leads with.`;
  const recommendedAngle =
    /controvers|accus|investigat|breach|leak|denies|claims/i.test(full) ? controversyAngle : uniqueAngle;

  return {
    stakeholders,
    moneyAndNumbers,
    openQuestions: questions,
    viralAngle,
    controversyAngle,
    uniqueAngle,
    recommendedAngle,
    rationale:
      "Controversy leads when allegation + investigation + denial are all present (engagement with balance); otherwise the second-order incentives angle differentiates from plain news recaps.",
  };
}
