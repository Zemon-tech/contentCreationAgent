import type { CopyGenerate } from "../lib/ras/copywriter";
import { copyConfig, type CopyConfig } from "../config/copy.config";

/**
 * Offline stand-in for the editorial copywriter's model, used by the heuristic
 * demos (auto:dry, ras:render:test) so they run with NO real model and NO real
 * Exa call. It derives short, valid copy from the FACT BRIEF embedded in the
 * prompt — enough to exercise the LLM path end to end offline. Mirrors the
 * heuristic RankGenerate stubs those demos already use.
 */
export const offlineCopyStub: CopyGenerate = async (prompt) => {
  const headline = (prompt.match(/HEADLINE:\s*(.+)/)?.[1] ?? "News update").trim();
  const firstFact = (prompt.match(/KEY FACTS:\n- (.+)/)?.[1] ?? "").trim();
  const figure = (prompt.match(/FIGURES:\s*(.+)/)?.[1] ?? "").split("|")[0]?.trim() ?? "";
  const srcLine = (prompt.match(/Source: (.+)"/)?.[1] ?? "").trim();

  const serifHeadline = headline.slice(0, 118);
  const deckLead = (firstFact || headline).slice(0, 58);
  const deckHighlight = (figure || "Why it matters").slice(0, 38);
  const deckTail = "Here's what it means".slice(0, 58);
  const caption =
    `${headline}. ${firstFact}`.trim().slice(0, 1900) + (srcLine ? `\n\nSource: ${srcLine}` : "");

  return {
    text: JSON.stringify({ serifHeadline, deckLead, deckHighlight, deckTail, caption }),
    usage: { totalTokens: 0 },
  };
};

/** Copy config for offline demos: keep the LLM path on, but never call Exa. */
export const offlineCopyConfig: CopyConfig = { ...copyConfig, exaEnabled: false };
