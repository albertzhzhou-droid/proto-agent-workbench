import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorCockpit, OPERATOR_COCKPIT_LIMITS } from "../src/main/services/operator-cockpit.ts";

const now = "2026-08-31T18:00:00.000Z";
const actions = (overrides = {}) => ({
  reviewPatch: false,
  approvePatch: false,
  rejectPatch: false,
  resolveToolApproval: false,
  reconcilePatchEffect: false,
  resumePatchValidation: false,
  prepareCheckpointRestore: false,
  updateReviewChecklist: false,
  approveRun: false,
  ...overrides,
});

function detail(id, attention, overrides = {}) {
  return {
    revision: overrides.revision ?? `revision:${id}`,
    summary: {
      runId: id,
      title: overrides.title ?? id,
      createdAt: overrides.createdAt ?? now,
      status: "completed",
      archived: overrides.archived ?? false,
      lifecycle: {
        state: overrides.state ?? "review-required",
        attention,
        label: overrides.label ?? `${attention} label`,
        detail: overrides.detail ?? `${attention} detail`,
        terminal: false,
      },
    },
    allowedActions: actions(overrides.allowedActions),
    taskCheckpoints: overrides.taskCheckpoints ?? [],
  };
}

function checkpoint({ id, digest, goalSha256, createdAt }) {
  return {
    id,
    createdAt,
    missionRecipe: {
      schema: "proto-workbench.mission-recipe.v1",
      digest,
      title: "Reusable evidence mission",
      mode: "plan",
      goal: "Review durable evidence without changing files.",
      goalSha256,
      intent: { network: false, writes: false, execution: false },
    },
  };
}

test("Operator Cockpit orders trusted attention and keeps navigation separate from effects", () => {
  const projection = buildOperatorCockpit([
    detail("human", "human-review", { createdAt: "2026-08-31T17:00:00.000Z" }),
    detail("patch", "patch-review", { createdAt: "2026-08-31T18:00:00.000Z", allowedActions: { reviewPatch: true } }),
    detail("failure", "failure", { createdAt: "2026-08-30T18:00:00.000Z" }),
    detail("clear", "none"),
    detail("archived", "recovery", { archived: true }),
  ], now);
  assert.deepEqual(projection.attentionItems.map((item) => item.runId), ["failure", "patch", "human"]);
  assert.deepEqual(projection.attentionItems.map((item) => item.action), ["inspect-failure", "review-patch", "review-human"]);
  assert.equal(projection.attentionItems.every((item) => ["runs", "reviews"].includes(item.target)), true);
  assert.equal(projection.attentionCounts.total, 3);
  assert.equal(projection.sourceRunCount, 4);
  const laterIssue = buildOperatorCockpit([
    detail("human", "human-review", { createdAt: "2026-08-31T17:00:00.000Z" }),
    detail("patch", "patch-review", { createdAt: "2026-08-31T18:00:00.000Z", allowedActions: { reviewPatch: true } }),
    detail("failure", "failure", { createdAt: "2026-08-30T18:00:00.000Z" }),
    detail("clear", "none"),
  ], "2026-09-01T18:00:00.000Z");
  assert.equal(projection.digest, laterIssue.digest);
  assert.notEqual(projection.issuedAt, laterIssue.issuedAt);
});

test("Mission Library deduplicates equivalent checkpoint goals and keeps recent immutable provenance", () => {
  const older = checkpoint({ id: "older", digest: "a".repeat(64), goalSha256: "b".repeat(64), createdAt: "2026-08-30T10:00:00.000Z" });
  const newer = checkpoint({ id: "newer", digest: "c".repeat(64), goalSha256: "b".repeat(64), createdAt: "2026-08-31T10:00:00.000Z" });
  const projection = buildOperatorCockpit([
    detail("recipe-run", "none", { title: "Recipe source", taskCheckpoints: [older, newer] }),
  ], now);
  const saved = projection.missionLibrary.filter((entry) => entry.source === "checkpoint");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].recipeDigest, newer.missionRecipe.digest);
  assert.equal(saved[0].capturedAt, newer.createdAt);
  assert.equal(saved[0].sourceRunId, "recipe-run");
  assert.equal(projection.missionLibrary.filter((entry) => entry.source === "builtin").length, 4);
  assert.equal(projection.missionLibrary.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest)), true);
});

test("Cockpit scan and rendering payloads stay bounded while counts retain scanned truth", () => {
  const details = Array.from({ length: 115 }, (_, index) => detail(
    `run-${String(index).padStart(3, "0")}`,
    "patch-review",
    { createdAt: new Date(Date.UTC(2026, 7, 31, 18, 0, index)).toISOString(), allowedActions: { reviewPatch: true } },
  ));
  const projection = buildOperatorCockpit(details, now);
  assert.equal(projection.sourceRunCount, OPERATOR_COCKPIT_LIMITS.runScan);
  assert.equal(projection.attentionCounts.total, OPERATOR_COCKPIT_LIMITS.runScan);
  assert.equal(projection.attentionItems.length, OPERATOR_COCKPIT_LIMITS.attentionItems);
  assert.deepEqual(projection.limits, OPERATOR_COCKPIT_LIMITS);
});

test("Cockpit digest changes when a durable run snapshot revision changes", () => {
  const first = buildOperatorCockpit([detail("run-1", "patch-review", { revision: "revision:1" })], now);
  const second = buildOperatorCockpit([detail("run-1", "patch-review", { revision: "revision:2" })], now);
  assert.notEqual(first.attentionItems[0].digest, second.attentionItems[0].digest);
  assert.notEqual(first.digest, second.digest);
  assert.throws(() => buildOperatorCockpit([], "not-a-date"), /timestamp/);
});
