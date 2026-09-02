import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { patchValidationOutcome } from "../src/main/services/patch-validation.ts";

function event(overrides) {
  return {
    id: crypto.randomUUID(),
    runId: "validation-run",
    stage: "validate",
    actor: "tool",
    title: "Deterministic validation",
    summary: "Recorded.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    ...overrides,
  };
}

test("patch validation fails closed on explicit failure or incomplete terminal evidence", () => {
  const explicit = patchValidationOutcome([
    event({ status: "failed", title: "Proto validation", summary: "Schema mismatch." }),
  ]);
  assert.equal(explicit.ok, false);
  assert.match(explicit.error, /Proto validation: Schema mismatch/);

  const incomplete = patchValidationOutcome([
    event({ stage: "design", status: "approved" }),
    event({ stage: "validate", status: "completed" }),
  ]);
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /terminal review event/i);

  assert.deepEqual(patchValidationOutcome([
    event({ stage: "validate", status: "completed" }),
    event({ stage: "review", status: "completed" }),
  ]), { ok: true });
});

test("a failed outcome is durably projected as validation-failed and remains resumable", () => {
  const database = new AppDatabase(":memory:");
  database.appendEvent(event({ id: "validation-goal", stage: "goal", actor: "user", title: "Goal defined" }));
  const patch = {
    id: "validation-patch",
    runId: "validation-run",
    targetPath: "C:\\workspace\\designs\\validation.proto",
    baseSha256: "base",
    baseExists: true,
    before: "before",
    after: "after",
    afterExists: true,
    unifiedDiff: "-before\n+after",
    rationale: "Validate failure mapping.",
    status: "pending",
    revision: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  database.savePatch(patch);
  const resultSha256 = createHash("sha256").update(patch.after, "utf8").digest("hex");
  const prepared = database.preparePatchOperation(patch.id, patch.revision, {
    targetPath: patch.targetPath,
    existed: true,
    content: patch.before,
    sha256: patch.baseSha256,
    resultSha256,
    resultExists: true,
  });
  const applying = database.markPatchOperationApplying(prepared.operation.id, prepared.operation.revision);
  const applied = database.markPatchOperationApplied(applying.id, applying.revision, resultSha256);
  const validating = database.beginPatchValidation(applied.operation.id, applied.operation.revision);
  const outcome = patchValidationOutcome([event({ status: "failed", title: "Proto validation", summary: "Fixture failure." })]);
  const failed = database.finishPatchValidation(validating.id, validating.revision, outcome.ok, outcome.error);
  const detail = database.getRunDetail(patch.runId);

  assert.equal(failed.state, "validation-failed");
  assert.match(failed.error, /Fixture failure/);
  assert.equal(detail.allowedActions.resumePatchValidation, true);
  assert.equal(detail.allowedActions.approveRun, false);
  database.close();
});
