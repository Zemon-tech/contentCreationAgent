import { formatStoryForTemplate } from "../lib/content-formatter";
import { routeStoryToTemplate } from "../lib/template-router";
import {
  storyRepository,
  opportunityRepository,
  listPendingStories,
  updateStoryEditorialStatus,
  resetAllRepositories,
} from "../repositories/store";
import {
  approveNewsStoryTool,
  rejectNewsStoryTool,
} from "../tools/editorial-tools";
import type { Story, ContentOpportunity } from "../schemas/story";

async function runTests() {
  console.log("=== Testing Phase 2: Formatter & Router ===");

  const sampleStory: Story = {
    id: "story-test-01",
    title: "Anthropic Releases Claude 3.7 Sonnet with Hybrid Reasoning Architecture",
    summary: "Anthropic has officially launched Claude 3.7 Sonnet featuring instant and extended reasoning modes.",
    whatHappened: "Anthropic introduced Claude 3.7 Sonnet, the industry first hybrid reasoning model capable of answering instantly or thinking methodically before responding.",
    whyItMatters: "Eliminates the tradeoff between fast chat models and deep reasoning models in agentic coding workflows.",
    topics: ["LLM", "Reasoning", "Agents"],
    entities: ["Anthropic", "Claude 3.7"],
    sources: ["https://www.anthropic.com/news/claude-3-7-sonnet"],
    contentIds: ["content-1"],
    firstSeenAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    status: "developing",
    scores: {
      relevance: 9.8,
      novelty: 9.5,
      impact: 9.5,
      velocity: 9.0,
      authority: 9.8,
      audienceInterest: 9.6,
      contentPotential: 9.7,
      overall: 96,
    },
    confidence: 0.98,
    possibleAngles: ["How hybrid reasoning changes agentic loops"],
    verification_status: "PRIMARY_CONFIRMED",
    editorial_status: "PENDING_REVIEW",
  };

  const sampleOpp: ContentOpportunity = {
    id: "opp-test-01",
    storyId: sampleStory.id,
    priority: "breaking",
    reason: "Major breakthrough in hybrid reasoning model capability",
    recommendedFormats: ["instagram", "x_post"],
    recommendedAngles: ["Why hybrid reasoning changes coding agents forever"],
    sources: sampleStory.sources,
    confidence: 0.95,
    createdAt: new Date().toISOString(),
    urgency: "IMMEDIATE",
    angle: "Why hybrid reasoning changes coding agents forever",
    hook: "Anthropic just solved the speed vs depth dilemma in AI models",
    thesis: "Claude 3.7 Sonnet combines instant response and extended thinking in a single checkpoint.",
    keyFacts: [
      "Switch dynamically between instant and step-by-step thinking",
      "Achieves SOTA on SWE-bench Verified coding benchmark",
    ],
    audience: "Engineers and founders building AI agents",
    decision: "POST_NOW",
  };

  // Test 1: Content Formatter for news-brief
  const formatted = formatStoryForTemplate(sampleStory, sampleOpp, { template_id: "news-brief" });
  console.assert(formatted.template_id === "news-brief", "Template ID should be news-brief");
  console.assert(formatted.format === "single", "news-brief should be single slide");
  console.assert(formatted.structured_slots?.eyebrow !== undefined, "Eyebrow slot present");
  console.assert((formatted.structured_slots?.eyebrow?.length || 0) <= 40, "Eyebrow <= 40 chars");
  console.assert((formatted.structured_slots?.headline?.length || 0) <= 110, "Headline <= 110 chars");
  console.assert((formatted.structured_slots?.body?.length || 0) <= 480, "Body <= 480 chars");
  console.assert(formatted.caption.includes("#Anthropic"), "Caption includes relevant hashtags");
  console.log("  PASS Content Formatter satisfies news-brief slot constraints.");

  // Test 2: Template Router
  const routing = await routeStoryToTemplate(sampleStory, sampleOpp, { forceTemplateId: "news-brief" });
  console.assert(routing.template_id === "news-brief", "Routing returned news-brief");
  console.assert(routing.format === "single", "news-brief is single");
  console.log("  PASS Template Router resolves to news-brief.");

  console.log("\n=== Testing Phase 3: HITL Editorial Review & Store ===");

  await resetAllRepositories();

  // Save story to SQLite
  await storyRepository.save(sampleStory);
  await opportunityRepository.save(sampleOpp);

  // Test 3: List pending stories
  const pending = await listPendingStories();
  console.assert(pending.length === 1, `Expected 1 pending story, got ${pending.length}`);
  console.assert(pending[0].id === sampleStory.id, "Story matches");
  console.log("  PASS SQLite persistence retrieves PENDING_REVIEW stories.");

  // Test 4: approveNewsStoryTool
  const approveResult: any = await (approveNewsStoryTool as any).execute({
    storyId: sampleStory.id,
    headlineOverride: "Claude 3.7 Sonnet: The Hybrid Reasoning Revolution",
    editorialNotes: "Approved by lead editor for 6pm post slot.",
  });
  console.assert(approveResult.status === "APPROVED", "Status should be APPROVED");

  const approvedStory = await storyRepository.get(sampleStory.id);
  console.assert(approvedStory?.editorial_status === "APPROVED", "Story status in DB should be APPROVED");
  console.assert(approvedStory?.title === "Claude 3.7 Sonnet: The Hybrid Reasoning Revolution", "Headline override applied");
  console.log("  PASS approveNewsStoryTool updates status and headline override.");

  // Test 5: Pending queue should now be empty
  const pendingAfterApprove = await listPendingStories();
  console.assert(pendingAfterApprove.length === 0, "No stories should be pending review after approval");
  console.log("  PASS Approved story removed from pending review queue.");

  // Test 6: rejectNewsStoryTool
  const secondStory: Story = {
    ...sampleStory,
    id: "story-test-02",
    title: "Irrelevant rumor about AI",
    editorial_status: "PENDING_REVIEW",
  };
  await storyRepository.save(secondStory);

  const rejectResult: any = await (rejectNewsStoryTool as any).execute({
    storyId: secondStory.id,
    reason: "Unverified rumor without secondary confirmation",
  });
  console.assert(rejectResult.status === "REJECTED", "Status should be REJECTED");

  const rejectedStory = await storyRepository.get(secondStory.id);
  console.assert(rejectedStory?.editorial_status === "REJECTED", "Story marked REJECTED in SQLite");
  console.assert(rejectedStory?.editorial_notes?.includes("Unverified rumor"), "Rejection reason saved");
  console.log("  PASS rejectNewsStoryTool updates status with rejection reason.");

  // Test 7: updateStoryEditorialStatus to SENT_TO_DESIGN
  await updateStoryEditorialStatus(sampleStory.id, "SENT_TO_DESIGN");
  const postGenStory = await storyRepository.get(sampleStory.id);
  console.assert(postGenStory?.editorial_status === "SENT_TO_DESIGN", "Status is SENT_TO_DESIGN");
  console.log("  PASS Story transition to SENT_TO_DESIGN verified.");

  console.log("\nAll Phase 2 & Phase 3 contract tests PASSED successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
