/**
 * Deterministic hash-based embeddings. No API key required, so dedup and
 * clustering work offline and in tests. Swap `embedText` for a real model
 * (e.g. OpenAI text-embedding-3-small) when available — the vector
 * interface (number[], cosine similarity) stays identical, which is what
 * makes a later move to pgvector trivial.
 */

function tokenHash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Signed random-projection style embedding over hashed tokens. */
export function hashEmbedding(text: string, dims = 128): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  for (const token of tokens) {
    const h = tokenHash(token);
    const idx = h % dims;
    // Random sign from a second hash bit so unrelated tokens cancel out.
    const sign = (tokenHash(`s:${token}`) & 1) === 0 ? 1 : -1;
    vec[idx]! += sign;
  }
  // L2-normalize so cosine similarity == dot product.
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Replace with a model-backed embedder later; same signature. */
export async function embedText(
  text: string,
  dims = 128,
): Promise<number[]> {
  return hashEmbedding(text, dims);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SimilarityPair {
  idA: string;
  idB: string;
  similarity: number;
}

export function findSimilarContent(
  items: { id: string; embedding: number[] }[],
  threshold = 0.82,
): SimilarityPair[] {
  const pairs: SimilarityPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const similarity = cosineSimilarity(
        items[i]!.embedding,
        items[j]!.embedding,
      );
      if (similarity >= threshold) {
        pairs.push({ idA: items[i]!.id, idB: items[j]!.id, similarity });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/** Token Jaccard — cheap pre-filter / short-text similarity. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
