import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { AgentService } from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";
import { patchValidationOutcome } from "../src/main/services/patch-validation.ts";
import { validationPlanForPatch } from "../src/main/services/validation-journal.ts";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runEvent(runId, step, overrides = {}) {
  return {
    id: randomUUID(),
    runId,
    stage: step.key === "design-approval" ? "design" : step.key === "review-packet" ? "review" : "validate",
    actor: step.key === "design-approval" ? "user" : "tool",
    title: step.title,
    summary: "",
    tool: step.key === "proto-check"
      ? "proto_check"
      : step.key === "proto-workflow"
        ? "proto_workflow_run"
        : step.key === "review-packet"
          ? "proto_review_packet"
          : undefined,
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: step.key === "design-approval" ? "approved" : "running",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function prepareValidatingOperation(database, { runId, targetPath, after = "after\n" }) {
  database.appendEvent({
    id: `${runId}-goal`,
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "Exercise durable validation replay.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:00.000Z",
  });
  const before = "before\n";
  const patch = database.savePatch({
    id: `${runId}-patch`,
    runId,
    targetPath,
    baseSha256: sha256(before),
    baseExists: true,
    before,
    after,
    afterExists: true,
    unifiedDiff: `-${before}+${after}`,
    rationale: "Exercise journaled validation.",
    status: "pending",
    revision: 0,
    createdAt: "2026-08-30T00:00:01.000Z",
  });
  const prepared = database.preparePatchOperation(patch.id, patch.revision, {
    targetPath,
    existed: true,
    content: before,
    sha256: sha256(before),
    resultSha256: sha256(after),
    resultExists: true,
  });
  const applying = database.markPatchOperationApplying(prepared.operation.id, prepared.operation.revision);
  const applied = database.markPatchOperationApplied(applying.id, applying.revision, sha256(after));
  const validating = database.beginPatchValidation(applied.operation.id, applied.operation.revision);
  return { patch: applied.patch, operation: validating };
}

function completeJournalStep(database, journal, step, event, review) {
  const started = database.beginValidationJournalStep(journal.operationId, journal.revision, step.key, event);
  event.status = step.key === "design-approval" ? "approved" : "completed";
  event.summary = `${step.title} completed.`;
  event.completedAt = new Date().toISOString();
  return database.finishValidationJournalStep(started.operationId, started.revision, step.key, event, review);
}

function journalAgent(database, mcp) {
  const model = { id: "journal-model", name: "Journal model" };
  return new AgentService(
    database,
    { get: () => model, getActiveModel: () => model, setToolCapability: () => {} },
    { read: async () => { throw new Error("No evidence fixture."); } },
    mcp,
    () => {},
  );
}

test("validation journal uses CAS and exposes a complete immutable step snapshot", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-cas-run",
    targetPath: "C:\\workspace\\analysis.md",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  assert.equal(journal.state, "pending");
  assert.equal(journal.nextStepKey, "design-approval");

  const design = runEvent(patch.runId, plan[0]);
  const started = database.beginValidationJournalStep(operation.id, journal.revision, plan[0].key, design);
  assert.throws(
    () => database.beginValidationJournalStep(operation.id, journal.revision, plan[0].key, runEvent(patch.runId, plan[0])),
    /journal changed/i,
  );
  design.completedAt = new Date().toISOString();
  journal = database.finishValidationJournalStep(operation.id, started.revision, plan[0].key, design);
  assert.equal(journal.steps[0].attempt, 1);
  assert.match(journal.steps[0].outputSha256, /^[a-f0-9]{64}$/);

  journal = completeJournalStep(database, journal, plan[1], runEvent(patch.runId, plan[1]));
  const review = {
    runId: patch.runId,
    packetPath: patch.targetPath,
    gate: "review-required",
    summary: "Software artifact ready for human review.",
    claims: [],
    checklist: [{ id: "human-review", label: "Human review", status: "pending" }],
    unresolvedQuestions: [],
    safetyBoundary: "Software validation only; human scientific review is still required.",
  };
  journal = completeJournalStep(database, journal, plan[2], runEvent(patch.runId, plan[2]), review);

  assert.equal(journal.state, "completed");
  assert.equal(journal.resumable, false);
  assert.equal(journal.nextStepKey, undefined);
  assert.deepEqual(journal.steps.map((step) => step.state), ["completed", "completed", "completed"]);
  assert.equal(database.getRunDetail(patch.runId).validationJournals[0].operationId, operation.id);
  const storedReview = database.getReview(patch.runId);
  const immutableReview = database.getValidationReviewSnapshot(operation.id);
  assert.equal(storedReview.operationId, operation.id);
  assert.equal(storedReview.validationPlanSha256, journal.planSha256);
  assert.equal(storedReview.validationJournalRevision, journal.revision);
  assert.match(storedReview.packetSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(immutableReview, storedReview);
  assert.deepEqual(database.reconcileValidationJournals("Clean restart."), {
    reconciled: 0,
    stepsNeedingReplay: 0,
    runIds: [],
  });
  database.close();
});

test("validation journal finish is bound to the patch-operation revision captured at begin", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-operation-cas-run",
    targetPath: "C:\\workspace\\operation-cas.md",
  });
  const plan = validationPlanForPatch(patch, operation);
  const journal = database.prepareValidationJournal(operation.id, plan);
  const event = runEvent(patch.runId, plan[0]);
  const started = database.beginValidationJournalStep(operation.id, journal.revision, plan[0].key, event);
  const durableBegin = database.getRunEvent(event.id);

  assert.equal(durableBegin.payload.validationJournal.operationRevision, operation.revision);
  let changed = database.finishPatchValidation(operation.id, operation.revision, false, "Force a newer validation revision.");
  changed = database.beginPatchValidation(changed.id, changed.revision);
  assert.equal(changed.state, "validating");
  assert.notEqual(changed.revision, operation.revision);

  event.status = "approved";
  event.completedAt = new Date().toISOString();
  assert.throws(
    () => database.finishValidationJournalStep(operation.id, started.revision, plan[0].key, event),
    /patch operation changed/i,
  );
  database.close();
});

test("an artifact result arriving after the patch-operation CAS changed is quarantined as effect-unknown", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-artifact-operation-race-run",
    targetPath: "C:\\workspace\\artifact-operation-race.proto",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  journal = completeJournalStep(database, journal, plan[0], runEvent(patch.runId, plan[0]));
  journal = completeJournalStep(database, journal, plan[1], runEvent(patch.runId, plan[1]));
  const output = { ok: true, artifacts: ["C:\\workspace\\build\\manifest.json"] };
  const workflowEvent = runEvent(patch.runId, plan[2], {
    payload: { output, outputSha256: sha256(JSON.stringify(output)) },
    outputArtifacts: [...output.artifacts],
  });
  journal = database.beginValidationJournalStep(operation.id, journal.revision, plan[2].key, workflowEvent);

  let changed = database.finishPatchValidation(operation.id, operation.revision, false, "Force a newer validation revision.");
  changed = database.beginPatchValidation(changed.id, changed.revision);
  workflowEvent.status = "completed";
  workflowEvent.summary = "Workflow returned after the competing transition.";
  workflowEvent.completedAt = new Date().toISOString();
  journal = database.finishValidationJournalStep(operation.id, journal.revision, plan[2].key, workflowEvent);

  assert.equal(changed.state, "validating");
  assert.equal(journal.state, "recovery-required");
  assert.equal(journal.resumable, false);
  assert.equal(journal.steps[2].state, "effect-unknown");
  assert.equal(database.getRunEvent(workflowEvent.id).status, "effect-unknown");
  assert.match(journal.steps[2].error, /result was not accepted/i);
  assert.throws(
    () => database.beginValidationJournalStep(
      operation.id,
      journal.revision,
      plan[3].key,
      runEvent(patch.runId, plan[3]),
    ),
    /unknown artifact effect/i,
  );
  database.close();
});

test("startup reconciliation makes an uncertain workspace read safely resumable", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-restart-run",
    targetPath: "C:\\workspace\\restart.proto",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  journal = completeJournalStep(database, journal, plan[0], runEvent(patch.runId, plan[0]));
  const firstAttempt = runEvent(patch.runId, plan[1]);
  journal = database.beginValidationJournalStep(operation.id, journal.revision, plan[1].key, firstAttempt);

  const report = database.reconcileStartupState("Application restarted.", "Approval state restarted.");
  const recovered = database.getValidationJournal(operation.id);
  assert.equal(report.reconciledValidationJournals, 1);
  assert.equal(report.validationStepsNeedingReplay, 1);
  assert.equal(recovered.state, "recovery-required");
  assert.equal(recovered.nextStepKey, "proto-check");
  assert.equal(recovered.resumable, true);
  assert.equal(recovered.steps[1].state, "interrupted");
  assert.equal(recovered.steps[1].attempt, 1);
  assert.equal(database.getRunEvent(firstAttempt.id).status, "effect-unknown");

  const replay = runEvent(patch.runId, plan[1]);
  journal = database.beginValidationJournalStep(operation.id, recovered.revision, plan[1].key, replay);
  replay.status = "completed";
  replay.summary = "Explicit replay completed.";
  replay.completedAt = new Date().toISOString();
  journal = database.finishValidationJournalStep(operation.id, journal.revision, plan[1].key, replay);
  assert.equal(journal.steps[1].attempt, 2);
  assert.deepEqual(journal.steps[1].eventIds, [firstAttempt.id, replay.id]);
  assert.equal(journal.nextStepKey, "proto-workflow");
  database.close();
});

test("a missing review snapshot invalidates only the dependent journal tail", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-snapshot-run",
    targetPath: "C:\\workspace\\snapshot.md",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  journal = completeJournalStep(database, journal, plan[0], runEvent(patch.runId, plan[0]));
  journal = completeJournalStep(database, journal, plan[1], runEvent(patch.runId, plan[1]));
  journal = completeJournalStep(
    database,
    journal,
    plan[2],
    runEvent(patch.runId, plan[2]),
    {
      runId: patch.runId,
      packetPath: patch.targetPath,
      gate: "review-required",
      summary: "Review snapshot.",
      claims: [],
      checklist: [],
      unresolvedQuestions: [],
      safetyBoundary: "Software validation only.",
    },
  );
  database.db.prepare("DELETE FROM reviews WHERE run_id = ?").run(patch.runId);
  database.db.prepare("DELETE FROM validation_review_snapshots WHERE operation_id = ?").run(operation.id);

  const result = database.reconcileValidationJournals("Review snapshot audit.");
  journal = database.getValidationJournal(operation.id);
  assert.deepEqual(result, { reconciled: 1, stepsNeedingReplay: 1, runIds: [patch.runId] });
  assert.deepEqual(journal.steps.map((step) => step.state), ["completed", "completed", "interrupted"]);
  assert.equal(journal.nextStepKey, "review-packet");
  assert.match(journal.steps[2].error, /review snapshot is missing/i);
  database.close();
});

test("run-scoped review updates cannot alias an operation's immutable validation snapshot", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-review-alias-run",
    targetPath: "C:\\workspace\\review-alias.md",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  journal = completeJournalStep(database, journal, plan[0], runEvent(patch.runId, plan[0]));
  journal = completeJournalStep(database, journal, plan[1], runEvent(patch.runId, plan[1]));
  journal = completeJournalStep(
    database,
    journal,
    plan[2],
    runEvent(patch.runId, plan[2]),
    {
      runId: patch.runId,
      packetPath: patch.targetPath,
      gate: "review-required",
      summary: "Operation-bound review snapshot.",
      claims: [],
      checklist: [],
      unresolvedQuestions: [],
      safetyBoundary: "Software validation only.",
    },
  );
  const immutableReview = database.getValidationReviewSnapshot(operation.id);
  database.saveReview({
    runId: patch.runId,
    gate: "blocked",
    summary: "A newer run-scoped review projection.",
    claims: [],
    checklist: [],
    unresolvedQuestions: ["Unrelated follow-up review."],
    safetyBoundary: "Software validation only.",
  });

  assert.notEqual(database.getReview(patch.runId).packetSha256, immutableReview.packetSha256);
  assert.deepEqual(database.getValidationReviewSnapshot(operation.id), immutableReview);
  assert.deepEqual(database.reconcileValidationJournals("Operation snapshot audit."), {
    reconciled: 0,
    stepsNeedingReplay: 0,
    runIds: [],
  });
  database.close();
});

test("startup reconciliation rejects a completed step whose captured tool output was mutated", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-event-integrity-run",
    targetPath: "C:\\workspace\\event-integrity.md",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  const output = { ok: true, checked: 1 };
  const designEvent = runEvent(patch.runId, plan[0], {
    payload: { output, outputSha256: sha256(JSON.stringify(output)) },
  });
  journal = completeJournalStep(database, journal, plan[0], designEvent);
  journal = completeJournalStep(database, journal, plan[1], runEvent(patch.runId, plan[1]));
  journal = completeJournalStep(
    database,
    journal,
    plan[2],
    runEvent(patch.runId, plan[2]),
    {
      runId: patch.runId,
      gate: "review-required",
      summary: "Review snapshot.",
      claims: [],
      checklist: [],
      unresolvedQuestions: [],
      safetyBoundary: "Software validation only.",
    },
  );
  const storedEvent = database.getRunEvent(designEvent.id);
  storedEvent.payload.output.checked = 2;
  database.appendEvent(storedEvent);

  const result = database.reconcileValidationJournals("Durable event integrity audit.");
  journal = database.getValidationJournal(operation.id);
  assert.deepEqual(result, { reconciled: 1, stepsNeedingReplay: 3, runIds: [patch.runId] });
  assert.deepEqual(journal.steps.map((step) => step.state), ["interrupted", "pending", "pending"]);
  assert.match(journal.steps[0].error, /durable event evidence/i);
  database.close();
});

test("reconciliation preserves an executed review-packet tail when provenance evidence is invalidated", () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-completed-review-tail-run",
    targetPath: "C:\\workspace\\completed-review-tail.proto",
  });
  const plan = validationPlanForPatch(patch, operation);
  let journal = database.prepareValidationJournal(operation.id, plan);
  journal = completeJournalStep(database, journal, plan[0], runEvent(patch.runId, plan[0]));
  journal = completeJournalStep(database, journal, plan[1], runEvent(patch.runId, plan[1]));
  journal = completeJournalStep(database, journal, plan[2], runEvent(patch.runId, plan[2]));
  const provenanceOutput = { ok: true, checked: 2, mismatches: [] };
  const provenanceEvent = runEvent(patch.runId, plan[3], {
    payload: {
      output: provenanceOutput,
      outputSha256: sha256(JSON.stringify(provenanceOutput)),
    },
  });
  journal = completeJournalStep(database, journal, plan[3], provenanceEvent);
  journal = completeJournalStep(
    database,
    journal,
    plan[4],
    runEvent(patch.runId, plan[4]),
    {
      runId: patch.runId,
      packetPath: "C:\\workspace\\build\\review.md",
      gate: "review-required",
      summary: "Completed operation-bound review packet.",
      claims: [],
      checklist: [],
      unresolvedQuestions: [],
      safetyBoundary: "Software validation only.",
    },
  );
  const completedReviewEventId = journal.steps[4].eventId;
  const immutableReview = database.getValidationReviewSnapshot(operation.id);
  const storedProvenanceEvent = database.getRunEvent(provenanceEvent.id);
  storedProvenanceEvent.payload.output.checked = 3;
  database.appendEvent(storedProvenanceEvent);

  const result = database.reconcileValidationJournals("Completed review tail integrity audit.");
  journal = database.getValidationJournal(operation.id);
  assert.deepEqual(result, { reconciled: 1, stepsNeedingReplay: 2, runIds: [patch.runId] });
  assert.deepEqual(
    journal.steps.map((step) => step.state),
    ["completed", "completed", "completed", "interrupted", "effect-unknown"],
  );
  assert.equal(journal.steps[4].eventId, completedReviewEventId);
  assert.equal(journal.resumable, false);
  assert.deepEqual(database.getValidationReviewSnapshot(operation.id), immutableReview);
  assert.throws(
    () => database.beginValidationJournalStep(
      operation.id,
      journal.revision,
      plan[3].key,
      runEvent(patch.runId, plan[3]),
    ),
    /unknown artifact effect/i,
  );
  database.close();
});

test("an artifact-write transport error becomes effect-unknown and is never generically replayed", async () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-agent-run",
    targetPath: "C:\\workspace\\agent.proto",
  });
  const calls = [];
  const provenanceDigest = "c".repeat(64);
  const mcp = {
    tools: async () => [],
    call: async (name) => {
      calls.push(name);
      if (name === "proto_check") return { ok: true, summary: "Check passed." };
      if (name === "proto_workflow_run") {
        return {
          ok: true,
          summary: "Workflow passed.",
          manifest_path: "C:\\workspace\\build\\manifest.json",
          provenance_path: "C:\\workspace\\build\\provenance.json",
          artifacts: ["C:\\workspace\\build\\manifest.json"],
        };
      }
      if (name === "proto_provenance_verify") return {
        ok: true,
        summary: "Workflow provenance matched.",
        subject: { path: "manifest.json", sha256: provenanceDigest, size: 128 },
        checked: 2,
        mismatches: [],
      };
      throw new Error("Review transport interrupted.");
    },
  };
  const agent = journalAgent(database, mcp);

  await assert.rejects(
    agent.afterPatchApplied(patch, operation.id),
    /Review transport interrupted/,
  );
  assert.deepEqual(calls, [
    "proto_check",
    "proto_workflow_run",
    "proto_provenance_verify",
    "proto_review_packet",
  ]);
  const journal = database.getValidationJournal(operation.id);
  const provenanceStep = journal.steps.find((step) => step.key === "artifact-boundary");
  const reviewStep = journal.steps.find((step) => step.key === "review-packet");
  const provenanceEvent = database.getRunEvent(provenanceStep.eventId);
  assert.equal(journal.state, "recovery-required");
  assert.equal(journal.resumable, false);
  assert.equal(journal.nextStepKey, "review-packet");
  assert.equal(reviewStep.state, "effect-unknown");
  assert.equal(database.getRunEvent(reviewStep.eventId).status, "effect-unknown");
  assert.equal(provenanceEvent.payload.output.subject.sha256, provenanceDigest);
  assert.match(provenanceStep.outputSha256, /^[a-f0-9]{64}$/);

  await assert.rejects(agent.afterPatchApplied(patch, operation.id), /unknown artifact effect/i);
  assert.deepEqual(calls, [
    "proto_check",
    "proto_workflow_run",
    "proto_provenance_verify",
    "proto_review_packet",
  ]);
  assert.equal(database.getValidationJournal(operation.id).steps.find((step) => step.key === "review-packet").attempt, 1);
  database.close();
});

test("a terminal non-ok artifact write becomes effect-unknown and is not replayed", async () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-artifact-non-ok-run",
    targetPath: "C:\\workspace\\artifact-non-ok.proto",
  });
  const calls = [];
  const agent = journalAgent(database, {
    tools: async () => [],
    call: async (name) => {
      calls.push(name);
      if (name === "proto_check") return { ok: true, summary: "Check passed." };
      if (name === "proto_workflow_run") {
        return { ok: false, summary: "Workflow reported a terminal failure.", artifacts: ["build\\partial.json"] };
      }
      throw new Error(`Unexpected call: ${name}`);
    },
  });

  const events = await agent.afterPatchApplied(patch, operation.id);
  const outcome = patchValidationOutcome(events);
  const journal = database.getValidationJournal(operation.id);
  const workflowStep = journal.steps.find((step) => step.key === "proto-workflow");
  assert.equal(outcome.ok, false);
  assert.deepEqual(calls, ["proto_check", "proto_workflow_run"]);
  assert.equal(events.find((event) => event.tool === "proto_workflow_run").status, "effect-unknown");
  assert.equal(workflowStep.state, "effect-unknown");
  assert.equal(journal.resumable, false);

  await assert.rejects(agent.afterPatchApplied(patch, operation.id), /unknown artifact effect/i);
  assert.deepEqual(calls, ["proto_check", "proto_workflow_run"]);
  assert.equal(database.getValidationJournal(operation.id).steps.find((step) => step.key === "proto-workflow").attempt, 1);
  database.close();
});

test("a failed provenance read blocks review but safely resumes without repeating the workflow write", async () => {
  const database = new AppDatabase(":memory:");
  const { patch, operation } = prepareValidatingOperation(database, {
    runId: "journal-provenance-retry-run",
    targetPath: "C:\\workspace\\provenance-retry.proto",
  });
  const calls = [];
  let provenanceAttempts = 0;
  const provenanceDigest = "d".repeat(64);
  const agent = journalAgent(database, {
    tools: async () => [],
    call: async (name) => {
      calls.push(name);
      if (name === "proto_check") return { ok: true, summary: "Check passed." };
      if (name === "proto_workflow_run") return {
        ok: true,
        summary: "Workflow passed.",
        manifest_path: "C:\\workspace\\build\\manifest.json",
        provenance_path: "C:\\workspace\\build\\provenance.json",
        artifacts: ["C:\\workspace\\build\\manifest.json"],
      };
      if (name === "proto_provenance_verify") {
        provenanceAttempts += 1;
        return {
          ok: provenanceAttempts > 1,
          summary: provenanceAttempts > 1 ? "Workflow provenance matched." : "Workflow provenance did not match.",
          subject: { path: "manifest.json", sha256: provenanceDigest, size: 128 },
          checked: 2,
          mismatches: provenanceAttempts > 1 ? [] : [{ code: "DIGEST_MISMATCH" }],
        };
      }
      return {
        ok: true,
        summary: "Review packet ready; human scientific review is required.",
        packet_path: "C:\\workspace\\build\\review.md",
        artifacts: ["C:\\workspace\\build\\review.md"],
      };
    },
  });

  const firstEvents = await agent.afterPatchApplied(patch, operation.id);
  assert.equal(patchValidationOutcome(firstEvents).ok, false);
  let journal = database.getValidationJournal(operation.id);
  assert.deepEqual(calls, ["proto_check", "proto_workflow_run", "proto_provenance_verify"]);
  assert.equal(journal.nextStepKey, "artifact-boundary");
  assert.equal(journal.steps.find((step) => step.key === "artifact-boundary").state, "failed");
  assert.equal(journal.resumable, true);
  assert.equal(database.getReview(patch.runId).gate, "blocked");

  const resumedEvents = await agent.afterPatchApplied(patch, operation.id);
  const outcome = patchValidationOutcome(resumedEvents);
  let current = database.getPatchOperation(operation.id);
  current = database.finishPatchValidation(current.id, current.revision, outcome.ok, outcome.error);
  journal = database.getValidationJournal(operation.id);
  const provenanceStep = journal.steps.find((step) => step.key === "artifact-boundary");
  const provenanceEvent = database.getRunEvent(provenanceStep.eventId);
  assert.deepEqual(calls, [
    "proto_check",
    "proto_workflow_run",
    "proto_provenance_verify",
    "proto_provenance_verify",
    "proto_review_packet",
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(current.state, "verified");
  assert.equal(journal.state, "completed");
  assert.deepEqual(journal.steps.map((step) => step.attempt), [1, 1, 1, 2, 1]);
  assert.equal(provenanceEvent.payload.output.subject.sha256, provenanceDigest);
  assert.deepEqual(provenanceStep.outputArtifacts, ["C:\\workspace\\build\\provenance.json"]);
  assert.match(provenanceStep.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(database.getReview(patch.runId).gate, "review-required");
  database.close();
});
