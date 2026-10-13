/**
 * rank:eval — calibrate the ranker against fixtures/ranking-golden.json.
 *
 *   npx -y tsx --env-file=.env src/mastra/eval/rankEval.ts            # 3 runs (variance)
 *   npx -y tsx --env-file=.env src/mastra/eval/rankEval.ts --runs=1   # single pass
 *
 * Reports, against your human labels (post | maybe | skip):
 *   - tier agreement (exact) and post/not-post agreement
 *   - the biggest disagreements (with score + the model's reason)
 *   - whether the ranker's top pick matches a story you labeled `post`
 *   - stability across runs: per-item finalScore stdev and tier flips
 *
 * The LLM judges meaning; the final score is deterministic. Low temperature
 * keeps runs close — this quantifies how close.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { rankingConfig } from "../config/ranking.config";
import type { RankResult, RankedStory } from "../schemas/ranking";
import { rankStories } from "../lib/ranking/rankStories";
import { createStubGateway } from "../lib/ranking/storage";
import { loadFixtures, type GoldenLabel, type LoadedFixture } from "./fixtures";

type Tier = "post" | "maybe" | "skip";
const TIER_RANK: Record<Tier, number> = { skip: 0, maybe: 1, post: 2 };

const runsArg = process.argv.find((a) => a.startsWith("--runs="));
const RUNS = Math.max(1, Number(runsArg?.split("=")[1] ?? 3) || 3);

/** Map a final score (or a dropped item) to a predicted tier. */
const MAYBE_THRESHOLD = Math.round(rankingConfig.minScore * 0.6);
function tierOf(score: number | null): Tier {
  if (score === null) return "skip"; // filtered out in Stage A
  if (score >= rankingConfig.minScore) return "post";
  if (score >= MAYBE_THRESHOLD) return "maybe";
  return "skip";
}

function predictedById(result: RankResult): Map<string, { tier: Tier; score: number | null; reason: string }> {
  const m = new Map<string, { tier: Tier; score: number | null; reason: string }>();
  for (const r of result.ranked) {
    m.set(r.item.id, { tier: tierOf(r.finalScore), score: r.finalScore, reason: r.reason });
  }
  for (const d of result.drops) {
    if (!m.has(d.id)) m.set(d.id, { tier: "skip", score: null, reason: `dropped: ${d.reason}` });
  }
  return m;
}

async function runOnce(fixtures: LoadedFixture[], now: Date): Promise<RankResult> {
  return rankStories(
    fixtures.map((f) => f.item),
    { gateway: createStubGateway(), persist: false, now, log: () => {} },
  );
}

async function main(): Promise<void> {
  const now = new Date();
  const fixtures = loadFixtures(now);
  const labeled = fixtures.filter((f) => f.label === "post" || f.label === "maybe" || f.label === "skip");

  console.log(`\n=== rank:eval ===`);
  console.log(`Fixtures: ${fixtures.length} (${labeled.length} labeled) · MIN_SCORE=${rankingConfig.minScore} · maybe>=${MAYBE_THRESHOLD} · runs=${RUNS}`);

  const results: RankResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    results.push(await runOnce(fixtures, now));
  }
  const primary = results[0]!;
  const pred = predictedById(primary);

  // ---- Agreement ----
  let exact = 0;
  let postAgree = 0;
  const disagreements: { id: string; title: string; human: GoldenLabel; predicted: Tier; score: number | null; reason: string; dist: number }[] = [];
  for (const f of labeled) {
    const p = pred.get(f.item.id);
    if (!p) continue;
    const human = f.label as Tier;
    if (p.tier === human) exact++;
    if ((human === "post") === (p.tier === "post")) postAgree++;
    const dist = Math.abs(TIER_RANK[human] - TIER_RANK[p.tier]);
    if (dist > 0) {
      disagreements.push({ id: f.item.id, title: f.item.title, human: f.label, predicted: p.tier, score: p.score, reason: p.reason, dist });
    }
  }
  const n = labeled.length || 1;
  console.log(`\n-- Agreement --`);
  console.log(`Exact tier:     ${exact}/${labeled.length} (${pct(exact / n)})`);
  console.log(`Post / not-post:${postAgree}/${labeled.length} (${pct(postAgree / n)})`);

  // ---- Biggest disagreements ----
  disagreements.sort((a, b) => b.dist - a.dist || (b.score ?? 0) - (a.score ?? 0));
  console.log(`\n-- Biggest disagreements (${disagreements.length}) --`);
  for (const d of disagreements.slice(0, 8)) {
    console.log(`  [you=${d.human} · ranker=${d.predicted} · score=${fmt(d.score)}] ${d.title.slice(0, 80)}`);
    console.log(`      reason: ${d.reason}`);
  }
  if (disagreements.length === 0) console.log(`  (none — full agreement)`);

  // ---- Top pick ----
  const top = primary.selected[0] ?? primary.ranked[0];
  if (top) {
    const humanLabel = labeled.find((f) => f.item.id === top.item.id)?.label ?? "(unlabeled)";
    const selected = primary.selected.length > 0;
    console.log(`\n-- Top pick --`);
    console.log(`  ${selected ? "SELECTED" : "top-ranked (below MIN_SCORE)"}: ${top.item.title.slice(0, 90)}`);
    console.log(`  score=${fmt(top.finalScore)} · your label=${humanLabel} · ${humanLabel === "post" ? "MATCH ✔" : "review"}`);
  } else {
    console.log(`\n-- Top pick -- none (empty input)`);
  }

  // ---- Variance across runs ----
  if (RUNS > 1) {
    console.log(`\n-- Stability across ${RUNS} runs --`);
    const byId = new Map<string, number[]>();
    const tiersById = new Map<string, Set<Tier>>();
    for (const res of results) {
      for (const r of res.ranked) {
        if (!byId.has(r.item.id)) byId.set(r.item.id, []);
        if (!tiersById.has(r.item.id)) tiersById.set(r.item.id, new Set());
        byId.get(r.item.id)!.push(r.finalScore);
        tiersById.get(r.item.id)!.add(tierOf(r.finalScore));
      }
    }
    const rows = [...byId.entries()].map(([id, scores]) => ({ id, stdev: stdev(scores), mean: mean(scores), scores }));
    rows.sort((a, b) => b.stdev - a.stdev);
    const flips = [...tiersById.values()].filter((s) => s.size > 1).length;
    console.log(`  Tier flips: ${flips}/${tiersById.size} items changed tier across runs`);
    console.log(`  Highest score variance:`);
    for (const r of rows.slice(0, 6)) {
      console.log(`    ${r.id}: mean=${fmt(r.mean)} stdev=${fmt(r.stdev)} [${r.scores.map(fmt).join(", ")}]`);
    }
  }

  // ---- Cost ----
  const tokens = results.reduce((a, r) => a + r.tokenEstimate.totalTokens, 0);
  const cost = results.reduce((a, r) => a + r.tokenEstimate.costUsd, 0);
  console.log(`\n-- Cost (all runs) --`);
  console.log(`  tokens=${tokens} · estCostUsd=${fmt(cost)}`);
  console.log(`\nTune weights/penalties in src/mastra/config/ranking.config.ts and re-run.\n`);
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const fmt = (v: number | null): string => (v === null ? "—" : v.toFixed(2));
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

main().catch((err) => {
  console.error("rank:eval failed:", err);
  process.exit(1);
});
