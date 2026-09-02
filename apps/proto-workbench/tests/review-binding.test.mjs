import assert from "node:assert/strict";
import test from "node:test";
import {
  bindReviewToValidation,
  reviewBindingMatches,
  reviewPacketSha256,
} from "../src/main/services/review-binding.ts";

function review() {
  return {
    runId: "run-review-binding",
    packetPath: "build/review.md",
    gate: "review-required",
    summary: "Software evidence requires human review.",
    claims: [{ id: "C1", claim: "Checks completed", evidence: ["build/evidence.json"], status: "supported" }],
    checklist: [{ id: "human", label: "Human review", status: "pending" }],
    unresolvedQuestions: ["Has a reviewed parts library replaced the fixture?"],
    safetyBoundary: "Software validation only.",
  };
}

test("review packets bind to one operation, plan, and journal revision", () => {
  const bound = bindReviewToValidation(review(), "operation-1", "a".repeat(64), 7);
  assert.match(bound.packetSha256, /^[a-f0-9]{64}$/);
  assert.equal(reviewBindingMatches(bound, "operation-1", "a".repeat(64), 7), true);
  assert.equal(reviewBindingMatches(bound, "operation-2", "a".repeat(64), 7), false);
  assert.equal(reviewBindingMatches(bound, "operation-1", "b".repeat(64), 7), false);
});

test("human decisions can change without changing generated packet identity", () => {
  const bound = bindReviewToValidation(review(), "operation-1", "a".repeat(64), 7);
  const decided = {
    ...bound,
    gate: "approved",
    approvedAt: "2026-08-31T00:00:00.000Z",
    checklist: bound.checklist.map((item) => ({ ...item, status: "done" })),
  };
  assert.equal(reviewPacketSha256(decided), bound.packetSha256);
  assert.equal(reviewBindingMatches(decided, "operation-1", "a".repeat(64), 7), true);
});

test("mutating generated evidence invalidates the binding", () => {
  const bound = bindReviewToValidation(review(), "operation-1", "a".repeat(64), 7);
  assert.equal(reviewBindingMatches({ ...bound, summary: "Changed" }, "operation-1", "a".repeat(64), 7), false);
  assert.equal(reviewBindingMatches({ ...bound, claims: [] }, "operation-1", "a".repeat(64), 7), false);
});
