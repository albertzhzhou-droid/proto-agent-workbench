import assert from "node:assert/strict";
import test from "node:test";
import { buildGlobalEvidenceSearch, GLOBAL_EVIDENCE_LIMITS } from "../src/main/services/global-evidence.ts";

const now = "2026-08-31T20:00:00.000Z";
const digest = (character) => character.repeat(64);

function event(id, overrides = {}) {
  return {
    id,
    runId: overrides.runId ?? "run-1",
    stage: overrides.stage ?? "design",
    actor: overrides.actor ?? "tool",
    title: overrides.title ?? "Diff ready for review",
    summary: overrides.summary ?? "Prepared a bounded workspace diff.",
    tool: overrides.tool ?? "workspace_propose_patch",
    inputProvenance: overrides.inputProvenance ?? ["designs/input.proto"],
    outputArtifacts: overrides.outputArtifacts ?? ["build/review/diff.patch"],
    evidenceIds: overrides.evidenceIds ?? ["evidence:review-1"],
    status: overrides.status ?? "approval-required",
    createdAt: overrides.createdAt ?? now,
    completedAt: overrides.completedAt,
  };
}

function detail(id = "run-1", overrides = {}) {
  const events = overrides.events ?? [event("event-1", { runId: id })];
  return {
    revision: overrides.revision ?? `revision:${id}`,
    snapshotAt: overrides.snapshotAt ?? now,
    summary: {
      runId: id,
      title: overrides.title ?? "T7 promoter library review",
      createdAt: overrides.createdAt ?? now,
      status: "approval-required",
      archived: overrides.archived ?? false,
      lifecycle: {
        state: overrides.lifecycleState ?? "waiting-patch-review",
        attention: "patch-review",
        label: "Patch review required",
        detail: "Review the recorded proposal before any write.",
        terminal: false,
      },
    },
    events,
    eventHistory: overrides.eventHistory ?? events.map((item, index) => ({
      eventId: item.id,
      eventRevision: 1,
      sequence: index + 1,
      snapshotSha256: digest(String((index + 1) % 10)),
    })),
    historyHead: overrides.historyHead ?? { sequence: events.length, entrySha256: digest("a") },
    taskCheckpoints: overrides.taskCheckpoints ?? [{
      id: "checkpoint-1",
      historyHead: { sequence: 1, entrySha256: digest("a") },
      snapshotDigest: digest("b"),
      createdAt: now,
      messages: [{ id: "message-1" }],
      artifactRefs: ["build/review/diff.patch"],
      workspaceIdentity: digest("c"),
      missionRecipe: { title: "Review saved evidence", mode: "plan" },
    }],
    approvals: overrides.approvals ?? [{
      id: "approval-1",
      tool: "workspace_write",
      risk: "write",
      status: "pending",
      arguments: { secret: "approval-secret-must-not-be-indexed" },
      argumentsSha256: digest("d"),
      createdAt: now,
      executionEventId: "event-1",
    }],
    review: overrides.review ?? {
      packetSha256: digest("e"),
      claims: [{ id: "claim-1", claim: "The proposed diff is reviewable", evidence: ["evidence:review-1"], status: "needs-review" }],
    },
    comments: overrides.comments ?? [{ id: 1, runId: id, comment: "Human reviewer requested clearer provenance.", createdAt: now }],
  };
}

test("Global Evidence indexes redacted cross-run metadata and precise navigation targets", () => {
  const result = buildGlobalEvidenceSearch([detail()], { query: "review" }, now);
  assert.equal(result.schema, "proto-workbench.global-evidence.v1");
  assert.equal(result.sourceRunCount, 1);
  assert.equal(result.hits.some((hit) => hit.kind === "event" && hit.target.eventId === "event-1"), true);
  assert.equal(result.hits.some((hit) => hit.kind === "artifact" && hit.target.evidenceTab === "artifacts"), true);
  assert.equal(result.hits.some((hit) => hit.kind === "claim" && hit.target.view === "reviews"), true);
  assert.equal(result.hits.some((hit) => hit.kind === "checkpoint" && hit.binding === "content-addressed"), true);
  assert.equal(result.hits.some((hit) => hit.kind === "approval" && hit.evidenceDigest === digest("d")), true);
  assert.doesNotMatch(JSON.stringify(result), /approval-secret-must-not-be-indexed/);
  const secret = buildGlobalEvidenceSearch([detail()], { query: "approval-secret-must-not-be-indexed" }, now);
  assert.equal(secret.totalHits, 0);
});

test("Global Evidence applies AND token matching, facets, exact filters, and stable ordering", () => {
  const results = buildGlobalEvidenceSearch([
    detail("run-b", { title: "Older review", createdAt: "2026-08-30T20:00:00.000Z" }),
    detail("run-a", { title: "Newest review", createdAt: "2026-08-31T20:00:00.000Z" }),
  ], { query: "diff review", kinds: ["event", "artifact"], stages: ["design"] }, now);
  assert.equal(results.totalHits > 0, true);
  assert.equal(results.hits.every((hit) => ["event", "artifact"].includes(hit.kind) && hit.stage === "design"), true);
  assert.equal(results.hits[0].runId, "run-a");
  assert.equal(results.facets.kinds.event > 0, true);
  assert.equal(results.facets.kinds.artifact > 0, true);
  assert.equal(results.facets.stages.design > 0, true);
  const exact = buildGlobalEvidenceSearch([
    detail("run-a"),
    detail("run-b"),
  ], { exactRunId: "run-b", lifecycleStates: ["waiting-patch-review"] }, now);
  assert.equal(exact.hits.every((hit) => hit.runId === "run-b"), true);
});

test("Global Evidence cursor binds the catalog and normalized request", () => {
  const first = buildGlobalEvidenceSearch([detail()], { limit: 2 }, now);
  assert.equal(first.hits.length, 2);
  assert.equal(first.truncated, true);
  assert.ok(first.nextCursor);
  const second = buildGlobalEvidenceSearch([detail()], { limit: 2, cursor: first.nextCursor }, "2026-09-01T20:00:00.000Z");
  assert.equal(second.catalogDigest, first.catalogDigest);
  assert.equal(second.hits.some((hit) => first.hits.some((item) => item.id === hit.id)), false);
  const repeated = buildGlobalEvidenceSearch([detail()], { limit: 2 }, "2026-09-01T20:00:00.000Z");
  assert.equal(repeated.digest, first.digest);
  assert.notEqual(repeated.issuedAt, first.issuedAt);
  assert.throws(
    () => buildGlobalEvidenceSearch([detail("run-1", { revision: "revision:changed" })], { limit: 2, cursor: first.nextCursor }, now),
    /invalid or stale/,
  );
  assert.throws(() => buildGlobalEvidenceSearch([detail()], { query: "changed", limit: 2, cursor: first.nextCursor }, now), /invalid or stale/);
});

test("Global Evidence enforces bounded indexing and rejects malformed requests", () => {
  const events = Array.from({ length: GLOBAL_EVIDENCE_LIMITS.eventsPerRun + 25 }, (_, index) => event(`event-${index}`, {
    outputArtifacts: Array.from({ length: 3 }, (__, artifactIndex) => `build/${index}-${artifactIndex}.json`),
    createdAt: new Date(Date.UTC(2026, 7, 31, 20, 0, index)).toISOString(),
  }));
  const result = buildGlobalEvidenceSearch([detail("bounded", { events, eventHistory: [], taskCheckpoints: [], approvals: [], review: { claims: [] }, comments: [] })], { limit: 50 }, now);
  assert.equal(result.hits.filter((hit) => hit.kind === "event").length <= GLOBAL_EVIDENCE_LIMITS.eventsPerRun, true);
  assert.equal(result.facets.kinds.artifact <= GLOBAL_EVIDENCE_LIMITS.artifactsPerRun, true);
  assert.deepEqual(result.limits, GLOBAL_EVIDENCE_LIMITS);
  assert.throws(() => buildGlobalEvidenceSearch([detail()], { query: "x".repeat(161) }, now), /160 characters/);
  assert.throws(() => buildGlobalEvidenceSearch([detail()], { limit: 51 }, now), /between 1 and 50/);
  assert.throws(() => buildGlobalEvidenceSearch([detail()], { cursor: "not-a-cursor" }, now), /invalid or stale/);
  assert.throws(() => buildGlobalEvidenceSearch([], {}, "not-a-date"), /timestamp/);
});
