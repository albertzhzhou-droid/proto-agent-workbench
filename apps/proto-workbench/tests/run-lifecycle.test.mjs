import assert from "node:assert/strict";
import test from "node:test";
import { projectRunLifecycle, runAllowedActions } from "../src/shared/run-lifecycle.ts";

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
});

const patch = (overrides = {}) => ({
  id: overrides.id ?? "patch-1",
  runId: overrides.runId ?? "run-1",
  targetPath: overrides.targetPath ?? "C:\\workspace\\designs\\toggle.proto",
  baseSha256: "a".repeat(64),
  baseExists: true,
  before: "design toggle\n",
  after: "design toggle_v2\n",
  afterExists: true,
  unifiedDiff: "-design toggle\n+design toggle_v2\n",
  rationale: "Prepare a reviewable change.",
  status: overrides.status ?? "pending",
  revision: overrides.revision ?? 0,
  restoresCheckpointId: overrides.restoresCheckpointId,
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:01.000Z",
});

const approval = (overrides = {}) => ({
  id: overrides.id ?? "approval-1",
  runId: overrides.runId ?? "run-1",
  threadId: "thread-1",
  workspacePath: "C:\\workspace",
  serviceSessionId: "session-1",
  tool: "proto_run_analysis",
  arguments: { path: "analysis.py" },
  argumentsSha256: "b".repeat(64),
  risk: "code-execution",
  status: overrides.status ?? "pending",
  revision: overrides.revision ?? 0,
  createdAt: "2026-08-30T00:00:02.000Z",
  expiresAt: "2099-08-30T00:10:02.000Z",
});

const operation = (overrides = {}) => ({
  id: overrides.id ?? "operation-1",
  idempotencyKey: "operation-key-1",
  patchId: overrides.patchId ?? "patch-1",
  runId: overrides.runId ?? "run-1",
  targetPath: "C:\\workspace\\designs\\toggle.proto",
  state: overrides.state ?? "validation-failed",
  baseSha256: "a".repeat(64),
  baseExists: true,
  resultSha256: "c".repeat(64),
  resultExists: true,
  checkpointId: overrides.checkpointId ?? "checkpoint-1",
  revision: overrides.revision ?? 4,
  createdAt: "2026-08-30T00:00:03.000Z",
  updatedAt: "2026-08-30T00:00:04.000Z",
  error: overrides.error ?? "Validation needs recovery.",
});

const journal = (step, overrides = {}) => ({
  schema: "proto-workbench.validation-journal.v1",
  operationId: overrides.operationId ?? "operation-1",
  patchId: overrides.patchId ?? "patch-1",
  runId: overrides.runId ?? "run-1",
  planSha256: "d".repeat(64),
  state: overrides.state ?? (step.state === "effect-unknown" || step.state === "interrupted" ? "recovery-required" : "failed"),
  revision: overrides.revision ?? 7,
  steps: [{
    key: step.key,
    title: step.title,
    sequence: 0,
    effect: step.effect,
    inputSha256: "e".repeat(64),
    state: step.state,
    attempt: 1,
    eventId: "validation-event-1",
    eventIds: ["validation-event-1"],
    outputArtifacts: [],
    evidenceIds: [],
    updatedAt: "2026-08-30T00:00:04.000Z",
    error: step.error,
  }],
  nextStepKey: step.key,
  resumable: overrides.resumable ?? step.state !== "effect-unknown",
  createdAt: "2026-08-30T00:00:03.000Z",
  updatedAt: "2026-08-30T00:00:04.000Z",
  snapshotAt: "2026-08-30T00:00:05.000Z",
});

const checkpoint = (overrides = {}) => ({
  id: overrides.id ?? "checkpoint-1",
  operationId: overrides.operationId ?? "operation-1",
  patchId: overrides.patchId ?? "patch-1",
  runId: overrides.runId ?? "run-1",
  targetPath: "C:\\workspace\\designs\\toggle.proto",
  existed: true,
  sha256: "a".repeat(64),
  resultSha256: "c".repeat(64),
  sizeBytes: 14,
  restoreState: "available",
  revision: 0,
  createdAt: "2026-08-30T00:00:03.000Z",
  updatedAt: "2026-08-30T00:00:04.000Z",
});

test("a pending patch takes precedence over an otherwise completed run", () => {
  const events = [
    event({ id: "goal", stage: "goal", actor: "user", title: "Goal defined" }),
    event({ id: "plan", createdAt: "2026-08-30T00:00:03.000Z" }),
  ];

  const lifecycle = projectRunLifecycle({ events, patches: [patch()] });

  assert.equal(lifecycle.state, "waiting-patch-review");
  assert.equal(lifecycle.attention, "patch-review");
  assert.equal(lifecycle.terminal, false);
  assert.match(lifecycle.detail, /toggle\.proto/i);
});

test("effect-unknown recovery disables every decision action without an operation to reconcile", () => {
  const events = [
    event({ id: "goal", stage: "goal", actor: "user", title: "Goal defined" }),
    event({
      id: "recovery",
      actor: "system",
      title: "Run interrupted during startup recovery",
      status: "effect-unknown",
      createdAt: "2026-08-30T00:00:04.000Z",
    }),
  ];
  const review = {
    runId: "run-1",
    packetPath: "C:\\workspace\\build\\review.json",
    gate: "ready",
    summary: "Ready for sign-off.",
    claims: [],
    checklist: [{ id: "human", label: "Human review", status: "done" }],
    unresolvedQuestions: [],
    safetyBoundary: "Software review only.",
  };

  const lifecycle = projectRunLifecycle({ events, patches: [patch()], approvals: [approval()], review });
  const actions = runAllowedActions({ events, patches: [patch()], approvals: [approval()], review });

  assert.equal(lifecycle.state, "effect-unknown");
  assert.equal(lifecycle.terminal, false);
  assert.deepEqual(actions, {
    reviewPatch: false,
    approvePatch: false,
    rejectPatch: false,
    resolveToolApproval: false,
    reconcilePatchEffect: false,
    resumePatchValidation: false,
    prepareCheckpointRestore: false,
    updateReviewChecklist: false,
    approveRun: false,
  });
});

test("an uncertain validation artifact requires explicit reconciliation or checkpoint restore", () => {
  const events = [
    event({ id: "goal", stage: "goal", actor: "user", title: "Goal defined" }),
    event({ id: "validation", stage: "validate", title: "Design workflow", status: "effect-unknown" }),
  ];
  const patchOperation = operation();
  const validationJournal = journal({
    key: "proto-workflow",
    title: "Design workflow",
    effect: "artifact-write",
    state: "effect-unknown",
    error: "The workflow transport ended without a trustworthy result.",
  });
  const input = {
    events,
    patches: [patch({ status: "approved" })],
    patchOperations: [patchOperation],
    validationJournals: [validationJournal],
    checkpoints: [checkpoint()],
  };

  const lifecycle = projectRunLifecycle(input);
  const actions = runAllowedActions(input);

  assert.equal(lifecycle.state, "effect-unknown");
  assert.equal(lifecycle.attention, "recovery");
  assert.match(lifecycle.label, /artifact reconciliation required/i);
  assert.match(lifecycle.detail, /explicit artifact reconciliation or a checkpoint restore is required/i);
  assert.match(lifecycle.detail, /will not replay/i);
  assert.equal(actions.resumePatchValidation, false);
  assert.equal(actions.reconcilePatchEffect, false);
  assert.equal(actions.prepareCheckpointRestore, true);
});

test("a failed workspace-read validation step remains safely resumable", () => {
  const events = [
    event({ id: "goal", stage: "goal", actor: "user", title: "Goal defined" }),
    event({ id: "validation", stage: "validate", title: "Workflow provenance verification", status: "failed" }),
  ];
  const patchOperation = operation({ error: "Workflow provenance did not match." });
  const validationJournal = journal({
    key: "artifact-boundary",
    title: "Workflow provenance verification",
    effect: "workspace-read",
    state: "failed",
    error: "Workflow provenance did not match.",
  }, { resumable: true });
  const input = {
    events,
    patches: [patch({ status: "approved" })],
    patchOperations: [patchOperation],
    validationJournals: [validationJournal],
    checkpoints: [checkpoint()],
  };

  const lifecycle = projectRunLifecycle(input);
  const actions = runAllowedActions(input);

  assert.equal(lifecycle.state, "interrupted");
  assert.match(lifecycle.detail, /provenance did not match/i);
  assert.equal(actions.resumePatchValidation, true);
  assert.equal(actions.prepareCheckpointRestore, true);
});

test("a prepared checkpoint restore remains reviewable after an uncertain artifact write", () => {
  const events = [
    event({ id: "goal", stage: "goal", actor: "user", title: "Goal defined" }),
    event({ id: "validation", stage: "review", title: "Review packet created", status: "effect-unknown" }),
  ];
  const input = {
    events,
    patches: [patch({ id: "restore-patch-1", status: "pending", restoresCheckpointId: "checkpoint-1" })],
    patchOperations: [operation()],
    validationJournals: [journal({
      key: "review-packet",
      title: "Review packet created",
      effect: "artifact-write",
      state: "effect-unknown",
    })],
    checkpoints: [checkpoint()],
  };

  const lifecycle = projectRunLifecycle(input);
  const actions = runAllowedActions(input);

  assert.equal(lifecycle.state, "waiting-patch-review");
  assert.match(lifecycle.label, /checkpoint restore review required/i);
  assert.equal(actions.reviewPatch, true);
  assert.equal(actions.approvePatch, true);
  assert.equal(actions.resumePatchValidation, false);
  assert.equal(actions.prepareCheckpointRestore, false);
});

test("an older uncertain artifact journal takes precedence over a newer resumable operation", () => {
  const uncertainOperation = operation({ id: "operation-uncertain", checkpointId: "checkpoint-uncertain", revision: 4 });
  const newerSafeOperation = operation({ id: "operation-safe", patchId: "patch-safe", checkpointId: "checkpoint-safe", revision: 8 });
  const uncertainJournal = journal({
    key: "proto-workflow",
    title: "Design workflow",
    effect: "artifact-write",
    state: "effect-unknown",
  }, { operationId: uncertainOperation.id, resumable: false });
  const safeJournal = journal({
    key: "artifact-boundary",
    title: "Workflow provenance verification",
    effect: "workspace-read",
    state: "failed",
  }, { operationId: newerSafeOperation.id, patchId: newerSafeOperation.patchId, revision: 9, resumable: true });
  const input = {
    events: [
      event({ id: "goal", stage: "goal", actor: "user", title: "Goal defined" }),
      event({ id: "safe-failure", stage: "validate", title: "Workflow provenance verification", status: "failed" }),
    ],
    patches: [patch({ status: "approved" })],
    patchOperations: [newerSafeOperation, uncertainOperation],
    validationJournals: [safeJournal, uncertainJournal],
    checkpoints: [
      checkpoint({ id: "checkpoint-safe", operationId: newerSafeOperation.id, patchId: newerSafeOperation.patchId }),
      checkpoint({ id: "checkpoint-uncertain", operationId: uncertainOperation.id }),
    ],
  };

  const lifecycle = projectRunLifecycle(input);
  const actions = runAllowedActions(input);

  assert.equal(lifecycle.state, "effect-unknown");
  assert.match(lifecycle.label, /artifact reconciliation required/i);
  assert.equal(actions.resumePatchValidation, false);
  assert.equal(actions.prepareCheckpointRestore, true);
});

const mission = (state, status = "completed") => ({...event({title: "Autonomous mission", status}), payload: {harness: {state}}});

test("durable active mission takes precedence over an approved intermediate review", () => {
  const input = {events: [mission("generating")], review: {gate: "approved", claims: [], checklist: [], summary: "Human reviewed an intermediate artifact"}};
  assert.equal(projectRunLifecycle(input).state, "running");
  assert.equal(runAllowedActions(input).approveRun, false);
});

test("paused, incomplete and unknown mission states never project completion", () => {
  for (const state of ["paused", "incomplete", "blocked", "unknown-future-state"]) {
    const result = projectRunLifecycle({events: [mission(state)]});
    assert.equal(result.state, "interrupted");
    assert.equal(result.terminal, false);
  }
});

test("verified mission completion ignores a historical failed tool but preserves unknown effects", () => {
  const events = [mission("completed"), event({stage: "tool", status: "failed", title: "Recovered transport"})];
  assert.equal(projectRunLifecycle({events}).state, "completed");
  assert.equal(projectRunLifecycle({events, patchOperations: [operation({state: "effect-unknown"})]}).state, "effect-unknown");
});

test("new mission startup remains running before its first checkpoint", () => {
  assert.equal(projectRunLifecycle({events: [event({title: "Autonomous mission", status: "running"})]}).state, "running");
});
