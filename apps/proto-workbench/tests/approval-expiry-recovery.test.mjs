import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { AgentService } from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";

const testRoot = resolve("tests", `.tmp-approval-expiry-${process.pid}`);

const approval = (overrides = {}) => ({
  id: overrides.id ?? "approval-1",
  runId: overrides.runId ?? "run-1",
  threadId: overrides.threadId ?? "thread-1",
  workspacePath: overrides.workspacePath ?? "C:\\workspace",
  serviceSessionId: overrides.serviceSessionId ?? "session-1",
  tool: overrides.tool ?? "proto_run_analysis",
  arguments: overrides.arguments ?? { path: "analysis.py" },
  argumentsSha256: overrides.argumentsSha256 ?? "a".repeat(64),
  risk: overrides.risk ?? "code-execution",
  status: overrides.status ?? "pending",
  revision: overrides.revision ?? 0,
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:00.000Z",
  expiresAt: overrides.expiresAt ?? "2099-08-30T00:10:00.000Z",
});

const event = (overrides = {}) => ({
  id: overrides.id ?? "execution-event-1",
  runId: overrides.runId ?? "run-1",
  stage: overrides.stage ?? "validate",
  actor: overrides.actor ?? "tool",
  title: overrides.title ?? "Run approved tool",
  summary: overrides.summary ?? "Tool execution is durable.",
  inputProvenance: [],
  outputArtifacts: [],
  evidenceIds: [],
  status: overrides.status ?? "running",
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:02.000Z",
});

test.before(async () => {
  await mkdir(testRoot, { recursive: true });
});

test.after(async () => {
  const relative = testRoot.slice(resolve(".").length);
  assert.ok(relative.includes("tests"), "test cleanup must stay under the app workspace");
  await rm(testRoot, { recursive: true, force: true });
});

test("database expiry and CAS are authoritative, so a late approval cannot authorize execution", () => {
  const database = new AppDatabase(":memory:");
  try {
    const expiring = database.saveApproval(approval({
      id: "approval-expired",
      expiresAt: "2026-08-30T00:01:00.000Z",
    }));
    const expired = database.resolvePendingApproval(
      expiring.id,
      "approved",
      expiring.revision,
      "2026-08-30T00:01:00.001Z",
    );

    assert.equal(expired.status, "expired");
    assert.equal(expired.decisionKey, "approval-expired:expired");
    assert.equal(expired.executionEventId, undefined);
    assert.equal(expired.consumedAt, undefined);
    assert.match(expired.invalidationReason, /no action was executed/i);
    assert.throws(
      () => database.markApprovalConsumed(expired.id, "must-not-execute"),
      /Approval is expired and cannot authorize execution/,
    );
    assert.equal(
      database.resolvePendingApproval(expired.id, "approved", expired.revision, "2026-08-30T00:02:00.000Z").status,
      "expired",
    );

    const competing = database.saveApproval(approval({ id: "approval-cas" }));
    const lostRace = database.resolvePendingApproval(
      competing.id,
      "approved",
      competing.revision + 1,
      "2026-08-30T00:00:10.000Z",
    );
    assert.equal(lostRace.status, "pending");
    assert.equal(lostRace.revision, competing.revision);

    const winner = database.resolvePendingApproval(
      competing.id,
      "approved",
      competing.revision,
      "2026-08-30T00:00:11.000Z",
    );
    const duplicate = database.resolvePendingApproval(
      competing.id,
      "rejected",
      winner.revision,
      "2026-08-30T00:00:12.000Z",
    );
    assert.equal(winner.status, "approved");
    assert.equal(duplicate.status, "approved");
    assert.equal(duplicate.decisionKey, "approval-cas:approved");
  } finally {
    database.close();
  }
});

test("startup recovery quarantines an approved decision that has no durable execution event", () => {
  const database = new AppDatabase(":memory:");
  try {
    const saved = database.saveApproval(approval({ id: "approval-unconsumed" }));
    const approved = database.resolvePendingApproval(
      saved.id,
      "approved",
      saved.revision,
      "2026-08-30T00:00:10.000Z",
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.consumedAt, undefined);

    const report = database.reconcileStartupState("Restarted.", "Restarted before approval execution.");
    const recovered = database.getApproval(saved.id);

    assert.equal(report.invalidatedApprovals, 1);
    assert.equal(recovered?.status, "stale");
    assert.equal(recovered?.executionEventId, undefined);
    assert.equal(recovered?.consumedAt, undefined);
    assert.match(recovered?.invalidationReason ?? "", /decision was recorded but had not been consumed/i);
  } finally {
    database.close();
  }
});

test("startup recovery preserves a consumed approval and its persistent executionEventId", () => {
  const databasePath = resolve(testRoot, "consumed-approval.sqlite");
  let database = new AppDatabase(databasePath);
  try {
    const saved = database.saveApproval(approval({ id: "approval-consumed" }));
    const approved = database.resolvePendingApproval(
      saved.id,
      "approved",
      saved.revision,
      "2026-08-30T00:00:10.000Z",
    );
    const execution = event({ id: "execution-persisted" });
    database.appendEvent(execution);
    const consumed = database.markApprovalConsumed(approved.id, execution.id);

    assert.equal(consumed.status, "approved");
    assert.equal(consumed.executionEventId, execution.id);
    assert.ok(consumed.consumedAt);
  } finally {
    database.close();
  }

  database = new AppDatabase(databasePath);
  try {
    const report = database.reconcileStartupState("Restarted.", "Restarted before approval execution.");
    const recovered = database.getApproval("approval-consumed");
    const durableExecution = database.getRunEvents("run-1").find((item) => item.id === "execution-persisted");

    assert.equal(report.invalidatedApprovals, 0);
    assert.equal(recovered?.status, "approved");
    assert.equal(recovered?.executionEventId, "execution-persisted");
    assert.ok(recovered?.consumedAt);
    assert.equal(durableExecution?.status, "effect-unknown");

    const duplicateConsumption = database.markApprovalConsumed("approval-consumed", "execution-must-not-rebind");
    assert.equal(duplicateConsumption.executionEventId, "execution-persisted");
  } finally {
    database.close();
  }
});

test("AgentService expires an unanswered approval without a click or side effect", async (context) => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const database = new AppDatabase(":memory:");
  try {
    const pendingApproval = database.saveApproval(approval({
      id: "approval-timer",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
    }));
    const service = new AgentService(database, {}, {}, {}, () => {});
    const controller = new AbortController();
    const decisionPromise = service.waitForApproval(
      pendingApproval,
      controller.signal,
      pendingApproval.threadId,
      event({ id: "approval-wait-event", status: "approval-required" }),
    );

    context.mock.timers.tick(999);
    assert.equal(database.getApproval(pendingApproval.id)?.status, "pending");
    context.mock.timers.tick(1);

    assert.equal(await decisionPromise, "expired");
    const expired = database.getApproval(pendingApproval.id);
    assert.equal(expired?.status, "expired");
    assert.equal(expired?.executionEventId, undefined);
    assert.equal(expired?.consumedAt, undefined);
    assert.equal(database.getRunEvents(pendingApproval.runId).length, 0);
  } finally {
    database.close();
    context.mock.timers.reset();
  }
});
