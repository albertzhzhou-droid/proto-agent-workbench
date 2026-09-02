import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";

const WORKSPACE = "C:\\workspace";

const event = (overrides = {}) => ({
  id: overrides.id ?? "event-1",
  runId: overrides.runId ?? "run-1",
  stage: overrides.stage ?? "plan",
  actor: overrides.actor ?? "assistant",
  title: overrides.title ?? "Agent plan started",
  summary: overrides.summary ?? "Run event",
  inputProvenance: [],
  outputArtifacts: [],
  evidenceIds: [],
  status: overrides.status ?? "completed",
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:00.000Z",
  payload: overrides.payload,
});

const patch = (overrides = {}) => ({
  id: overrides.id ?? "patch-1",
  runId: overrides.runId ?? "run-1",
  targetPath: overrides.targetPath ?? `${WORKSPACE}\\designs\\toggle.proto`,
  baseSha256: "a".repeat(64),
  baseExists: true,
  before: "design toggle\n",
  after: "design toggle_v2\n",
  afterExists: true,
  unifiedDiff: "-design toggle\n+design toggle_v2\n",
  rationale: "Prepare a reviewable change.",
  status: overrides.status ?? "pending",
  revision: overrides.revision ?? 0,
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:02.000Z",
});

const approval = (overrides = {}) => ({
  id: overrides.id ?? "approval-1",
  runId: overrides.runId ?? "run-1",
  threadId: overrides.threadId ?? "thread-1",
  workspacePath: WORKSPACE,
  serviceSessionId: "session-1",
  tool: "proto_run_analysis",
  arguments: { path: "analysis.py" },
  argumentsSha256: "b".repeat(64),
  risk: "code-execution",
  status: overrides.status ?? "pending",
  revision: overrides.revision ?? 0,
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:03.000Z",
  expiresAt: "2099-08-30T00:10:03.000Z",
});

const review = (runId = "run-1") => ({
  runId,
  packetPath: `${WORKSPACE}\\build\\review.json`,
  gate: "ready",
  summary: "Evidence packet is ready for sign-off.",
  claims: [{ id: "claim-1", claim: "The software check completed.", evidence: ["event-1"], status: "supported" }],
  checklist: [{ id: "human", label: "Human review", status: "done" }],
  unresolvedQuestions: ["Scientific validity remains under human review."],
  safetyBoundary: "Software validation only.",
});

function createThread(database, id = "thread-1") {
  database.createThread({
    id,
    workspacePath: WORKSPACE,
    title: "Durable run",
    mode: "act",
    modelId: "model-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  });
}

function addRun(database, runId = "run-1", threadId = "thread-1") {
  database.recordRunStart(event({
    id: `${runId}-goal`,
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: `Recover ${runId}`,
    payload: { threadId, workspacePath: WORKSPACE, serviceSessionId: "session-1" },
  }), threadId, WORKSPACE);
  database.appendEvent(event({
    id: `${runId}-plan`,
    runId,
    createdAt: "2026-08-30T00:00:01.000Z",
  }));
}

test("getRunDetail atomically restores the run-scoped patch, review, approval, thread, messages, and comments", () => {
  const database = new AppDatabase(":memory:");
  try {
    createThread(database);
    addRun(database);
    database.addMessage("thread-1", {
      id: "message-user",
      role: "user",
      content: "Prepare a reviewable patch.",
      createdAt: "2026-08-30T00:00:00.100Z",
    });
    database.addMessage("thread-1", {
      id: "message-assistant",
      role: "assistant",
      content: "The patch is ready for review.",
      createdAt: "2026-08-30T00:00:00.200Z",
    });
    database.savePatch(patch());
    database.saveApproval(approval());
    database.saveReview(review());
    const comment = database.addReviewComment("run-1", "Verified the software-only boundary.");

    const detail = database.getRunDetail("run-1");

    assert.equal(detail.summary.runId, "run-1");
    assert.equal(detail.summary.lifecycle.state, "waiting-tool-approval");
    assert.equal(detail.threadId, "thread-1");
    assert.equal(detail.workspacePath, WORKSPACE);
    assert.equal(detail.thread?.id, "thread-1");
    assert.deepEqual(detail.messages.map((item) => item.id), ["message-user", "message-assistant"]);
    assert.deepEqual(detail.patches.map((item) => item.id), ["patch-1"]);
    assert.equal(detail.activePatch?.id, "patch-1");
    assert.deepEqual(detail.approvals.map((item) => item.id), ["approval-1"]);
    assert.equal(detail.review.runId, "run-1");
    assert.equal(detail.review.gate, "ready");
    assert.deepEqual(detail.comments, [comment]);
    assert.equal(detail.contextWarning, undefined);
    assert.ok(detail.revision.length > 0);
  } finally {
    database.close();
  }
});

test("getRunDetail quarantines malformed patch, review, and message payloads without blocking recovery", () => {
  const database = new AppDatabase(":memory:");
  try {
    createThread(database, "thread-malformed");
    addRun(database, "run-malformed", "thread-malformed");
    database.addMessage("thread-malformed", {
      id: "message-valid",
      role: "user",
      content: "Keep this valid message.",
      createdAt: "2026-08-30T00:00:00.100Z",
    });
    database.db.prepare(
      "INSERT INTO messages(id, thread_id, role, content, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(
      "message-malformed",
      "thread-malformed",
      "assistant",
      "indexed fallback must not be trusted as a payload",
      "not-json",
      "2026-08-30T00:00:00.200Z",
    );
    database.db.prepare(
      "INSERT INTO patches(id, run_id, status, payload, created_at) VALUES(?, ?, ?, ?, ?)",
    ).run(
      "patch-malformed",
      "run-malformed",
      "pending",
      "not-json",
      "2026-08-30T00:00:02.000Z",
    );
    database.db.prepare(
      "INSERT INTO reviews(run_id, payload, updated_at) VALUES(?, ?, ?)",
    ).run(
      "run-malformed",
      "not-json",
      "2026-08-30T00:00:03.000Z",
    );

    const detail = database.getRunDetail("run-malformed");

    assert.deepEqual(detail.messages.map((item) => item.id), ["message-valid"]);
    assert.equal(detail.patches.length, 1);
    assert.equal(detail.patches[0].id, "patch-malformed");
    assert.equal(detail.patches[0].status, "stale");
    assert.equal(detail.activePatch, undefined);
    assert.equal(detail.review.runId, "run-malformed");
    assert.equal(detail.review.gate, "review-required");
    assert.equal(detail.thread?.id, "thread-malformed");
    assert.equal(detail.contextWarning, undefined);
  } finally {
    database.close();
  }
});
