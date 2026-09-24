import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";

const digest = (letter) => letter.repeat(64);
const base = (overrides = {}) => ({
  schema: "proto-workbench.model-evaluation-attempt.v1",
  evaluationId: "eval-protocol-v1",
  attemptId: randomUUID(),
  caseId: "case-001",
  caseRevision: "1",
  caseSha256: digest("a"),
  datasetSha256: digest("b"),
  referenceSha256: digest("c"),
  scorerVersion: "fixture-scorer-v1",
  provider: "lmstudio",
  providerModelId: "fixture/model",
  modelId: "fixture-model",
  modelFingerprint: digest("d"),
  instanceId: "instance-exact-1",
  runtimeFingerprint: digest("e"),
  toolSchemaSha256: digest("f"),
  promptTemplateSha256: digest("1"),
  startedAt: "2026-09-22T10:00:00.000Z",
  finishedAt: "2026-09-22T10:00:01.000Z",
  status: "success",
  toolSelection: { result: "pass", expectedTool: "lookup", observedTool: "lookup", expectedArgumentsSha256: digest("2"), observedArgumentsSha256: digest("2") },
  execution: { result: "pass", effectState: "no-effect", recovery: "not-needed", receiptSha256: digest("3") },
  scientificAnswer: { result: "pass", unitCheck: "pass", sourceCheck: "pass", reviewRecordSha256: digest("4") },
  ...overrides,
});

test("evaluation summaries retain failures and interruptions in each independent denominator", () => {
  const db = new AppDatabase(":memory:");
  try {
    db.appendModelEvaluationAttempt(base());
    db.appendModelEvaluationAttempt(base({
      attemptId: randomUUID(), status: "interrupted", finishedAt: undefined,
      toolSelection: { result: "unscored" }, execution: { result: "not-run" }, scientificAnswer: { result: "not-run" },
      failureCode: "PROCESS_INTERRUPTED",
    }));
    db.appendModelEvaluationAttempt(base({
      attemptId: randomUUID(), status: "error", failureCode: "TOOL_RECEIPT_MISSING",
      toolSelection: { result: "fail", expectedTool: "lookup", observedTool: "write" },
      execution: { result: "fail", effectState: "effect-unknown", recovery: "effect-unknown" },
      scientificAnswer: { result: "not-run" },
    }));

    const summary = db.summarizeModelEvaluation("eval-protocol-v1");
    assert.equal(summary.attempts, 3);
    assert.deepEqual(summary.statuses, { success: 1, error: 1, timeout: 0, cancelled: 0, unsupported: 0, refused: 0, interrupted: 1 });
    assert.deepEqual(summary.toolSelection, { attempts: 3, pass: 1, fail: 1, unscored: 1, notRun: 0 });
    assert.deepEqual(summary.execution, { attempts: 3, pass: 1, fail: 1, unscored: 0, notRun: 1 });
    assert.deepEqual(summary.scientificAnswer, { attempts: 3, pass: 1, fail: 0, unscored: 0, notRun: 2, needsHumanReview: 0 });
    assert.equal(db.listModelEvaluationAttempts("eval-protocol-v1").length, 3);
    assert.deepEqual(db.listModelEvaluationSummaries(), [summary]);
  } finally { db.close(); }
});

test("evaluation records reject raw/unreviewed fields and digest mismatches", () => {
  const db = new AppDatabase(":memory:");
  try {
    assert.throws(() => db.appendModelEvaluationAttempt(base({ answerText: "raw answer must not enter the ledger" })), /MODEL_EVALUATION_UNEXPECTED_FIELD/);
    db.appendModelEvaluationAttempt(base());
    db.db.prepare("UPDATE model_evaluation_attempts SET payload=? WHERE attempt_id=?").run("{}", db.listModelEvaluationAttempts("eval-protocol-v1")[0].attemptId);
    assert.throws(() => db.listModelEvaluationAttempts("eval-protocol-v1"), /MODEL_EVALUATION_DIGEST_MISMATCH/);
  } finally { db.close(); }
});
