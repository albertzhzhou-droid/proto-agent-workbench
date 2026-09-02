import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";

const event = (overrides) => ({
  id: overrides.id,
  runId: overrides.runId,
  stage: overrides.stage ?? "plan",
  actor: overrides.actor ?? "assistant",
  title: overrides.title ?? "Agent plan started",
  summary: overrides.summary ?? "Working",
  inputProvenance: [],
  outputArtifacts: [],
  evidenceIds: [],
  status: overrides.status,
  createdAt: overrides.createdAt,
});

test("startup recovery closes unfinished events, invalidates approvals, and is idempotent", () => {
  const database = new AppDatabase(":memory:");
  try {
    database.appendEvent(event({
      id: "goal-1",
      runId: "run-1",
      stage: "goal",
      actor: "user",
      title: "Goal defined",
      summary: "Recover this run",
      status: "completed",
      createdAt: "2026-08-30T00:00:00.000Z",
    }));
    database.appendEvent(event({
      id: "plan-1",
      runId: "run-1",
      status: "running",
      createdAt: "2026-08-30T00:00:01.000Z",
    }));
    database.appendEvent(event({
      id: "approval-event-1",
      runId: "run-1",
      stage: "design",
      actor: "tool",
      title: "Workspace Propose Patch",
      status: "approval-required",
      createdAt: "2026-08-30T00:00:02.000Z",
    }));
    database.appendEvent(event({
      id: "execution-event-1",
      runId: "run-1",
      stage: "validate",
      actor: "tool",
      title: "Design workflow",
      status: "running",
      createdAt: "2026-08-30T00:00:03.000Z",
    }));
    database.saveApproval({
      id: "approval-1",
      runId: "run-1",
      threadId: "thread-1",
      workspacePath: "C:\\workspace",
      serviceSessionId: "session-1",
      tool: "workspace_propose_patch",
      arguments: { path: "designs/toggle.proto" },
      argumentsSha256: "0".repeat(64),
      risk: "write",
      status: "pending",
      createdAt: "2026-08-30T00:00:02.000Z",
      expiresAt: "2026-08-30T01:00:02.000Z",
    });

    const report = database.reconcileStartupState("Application restarted.", "Application restarted.");
    const recovered = database.getRunEvents("run-1");

    assert.equal(report.recoveredRuns, 1);
    assert.equal(report.recoveredEvents, 3);
    assert.equal(report.invalidatedApprovals, 1);
    assert.equal(database.getApproval("approval-1").status, "stale");
    assert.equal(recovered.find((item) => item.id === "plan-1").status, "interrupted");
    assert.equal(recovered.find((item) => item.id === "approval-event-1").status, "interrupted");
    assert.equal(recovered.find((item) => item.id === "execution-event-1").status, "effect-unknown");
    assert.equal(recovered.filter((item) => item.title === "Run interrupted during startup recovery").length, 1);
    assert.equal(database.listRuns()[0].status, "effect-unknown");

    const second = database.reconcileInterruptedRuns("Application restarted again.");
    assert.equal(second.recoveredRuns, 0);
    assert.equal(database.getRunEvents("run-1").filter((item) => item.title === "Run interrupted during startup recovery").length, 1);
  } finally {
    database.close();
  }
});

test("startup recovery quarantines malformed approval payloads and rejects an unchained projection injection", () => {
  const database = new AppDatabase(":memory:");
  try {
    database.appendEvent(event({
      id: "indexed-event",
      runId: "indexed-run",
      status: "running",
      createdAt: "2026-08-30T00:00:00.000Z",
    }));
    database.db.prepare(
      "INSERT INTO approvals(id, run_id, status, payload, created_at) VALUES(?, ?, ?, ?, ?)",
    ).run(
      "indexed-approval",
      "indexed-run",
      "pending",
      "not-json",
      "2026-08-30T00:00:01.000Z",
    );

    const report = database.reconcileStartupState("Restarted.", "Restarted.");
    const recovered = database.getRunEvents("indexed-run");
    const approval = database.getApproval("indexed-approval");

    assert.equal(report.recoveredRuns, 1);
    assert.equal(report.invalidatedApprovals, 1);
    assert.equal(recovered.some((item) => item.id === "indexed-event" && item.runId === "indexed-run"), true);
    assert.equal(approval.status, "stale");
    assert.equal(approval.id, "indexed-approval");
    assert.equal(approval.runId, "indexed-run");
    assert.match(approval.invalidationReason, /malformed and quarantined/i);
    assert.doesNotThrow(() => database.listApprovals());

    database.db.prepare(
      "INSERT INTO run_events(id, run_id, stage, status, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(
      "forged-event",
      "forged-run",
      "plan",
      "running",
      JSON.stringify({ id: "payload-event", runId: "payload-run", legacy: true }),
      "2026-08-30T00:00:02.000Z",
    );
    assert.throws(() => database.getRunEvents("forged-run"), /projection integrity/i);
  } finally {
    database.close();
  }
});

test("completed runs are not changed by startup recovery", () => {
  const database = new AppDatabase(":memory:");
  try {
    database.appendEvent(event({
      id: "plan-complete",
      runId: "run-complete",
      status: "completed",
      createdAt: "2026-08-30T00:00:00.000Z",
    }));

    const report = database.reconcileInterruptedRuns("Application restarted.");
    assert.equal(report.recoveredRuns, 0);
    assert.equal(database.getRunEvents("run-complete")[0].status, "completed");
  } finally {
    database.close();
  }
});
