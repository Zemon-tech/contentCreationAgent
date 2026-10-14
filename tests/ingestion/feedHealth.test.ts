import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOutcome, isProbeDue, type FeedHealthRow } from "../../src/mastra/repositories/feedHealth";
import { ingestionConfig } from "../../src/mastra/config/ingestion.config";

function row(overrides: Partial<FeedHealthRow> = {}): FeedHealthRow {
  return {
    id: "s1",
    status: "active",
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastItemAt: null,
    disabledAt: null,
    nextProbeAt: null,
    etag: null,
    lastModified: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const N = ingestionConfig.health.autoDisableAfter;

test("success resets consecutiveFailures and stamps lastSuccess", () => {
  const t = applyOutcome(row({ consecutiveFailures: 3 }), { kind: "success", itemAt: "2026-10-14T00:00:00Z" });
  assert.equal(t.row.consecutiveFailures, 0);
  assert.equal(t.row.lastItemAt, "2026-10-14T00:00:00Z");
  assert.equal(t.event, null);
});

test(`auto-disables after ${N} consecutive failures and schedules a probe`, () => {
  let r = row();
  let event = null;
  for (let i = 0; i < N; i++) {
    const t = applyOutcome(r, { kind: "failure", error: "boom" });
    r = t.row;
    event = t.event;
  }
  assert.equal(r.status, "disabled_auto");
  assert.ok(r.nextProbeAt);
  assert.equal(event, "auto_disabled");
});

test("stale is handled as success (reset), NOT a failure", () => {
  const t = applyOutcome(row({ consecutiveFailures: 2 }), { kind: "success", stale: true, itemAt: "2020-01-01T00:00:00Z" });
  assert.equal(t.row.consecutiveFailures, 0);
  assert.equal(t.row.status, "active");
});

test("a due probe that succeeds re-enables the source", () => {
  const disabled = row({ status: "disabled_auto", consecutiveFailures: N, disabledAt: "x", nextProbeAt: "2020-01-01T00:00:00Z" });
  assert.equal(isProbeDue(disabled, new Date("2026-01-01")), true);
  const t = applyOutcome(disabled, { kind: "success" });
  assert.equal(t.row.status, "active");
  assert.equal(t.event, "reenabled");
  assert.equal(t.row.nextProbeAt, null);
});

test("disabled_manual is NEVER auto-enabled by a success", () => {
  const manual = row({ status: "disabled_manual" });
  const t = applyOutcome(manual, { kind: "success", itemAt: "2026-10-14T00:00:00Z" });
  assert.equal(t.row.status, "disabled_manual");
  assert.equal(t.event, null);
});
