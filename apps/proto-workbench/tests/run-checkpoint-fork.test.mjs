import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { buildMissionRecipe } from "../src/main/services/resume-contract.ts";
import { workspaceBindingIdentity } from "../src/main/services/run-checkpoints.ts";

const now = "2026-08-30T21:00:00.000Z";
const resumeDigest = "c".repeat(64);
const testRoot = resolve("tests", `.tmp-run-checkpoint-${process.pid}`);

test.before(async () => {
  await mkdir(testRoot, { recursive: true });
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("checkpoint fork clones only a bounded message prefix with fresh IDs and is idempotent", async () => {
  const sentinel = resolve(testRoot, "workspace-sentinel.txt");
  await writeFile(sentinel, "unchanged", "utf8");
  const database = new AppDatabase(":memory:");
  database.createThread({
    id: "source-thread",
    workspacePath: testRoot,
    title: "Source task",
    mode: "act",
    modelId: "model-1",
    createdAt: now,
    updatedAt: now,
  });
  for (const [index, role] of ["user", "assistant", "tool"].entries()) {
    database.addMessage("source-thread", {
      id: `source-message-${index}`,
      role,
      content: `message ${index}`,
      toolName: role === "tool" ? "fixture_tool" : undefined,
      createdAt: now,
    });
  }
  database.recordRunStart({
    id: "goal-event",
    runId: "run-1",
    stage: "goal",
    actor: "user",
    title: "Goal",
    summary: "Task context",
    inputProvenance: [],
    outputArtifacts: ["build/result.json"],
    evidenceIds: [],
    status: "completed",
    createdAt: now,
  }, "source-thread", testRoot);

  database.db.prepare(
    "INSERT INTO approvals(id, run_id, status, revision, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run("approval-1", "run-1", "pending", 0, "{}", now);
  database.db.prepare(
    "INSERT INTO patches(id, run_id, target_path, status, revision, payload, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
  ).run("patch-1", "run-1", "designs/example.proto", "pending", 0, "{}", now);
  database.db.prepare(
    "INSERT INTO reviews(run_id, payload, updated_at) VALUES(?, ?, ?)",
  ).run("run-1", "{}", now);

  const checkpoint = database.createRunCheckpoint({
    id: "checkpoint-1",
    runId: "run-1",
    messagePrefixLength: 2,
    artifactRefs: ["build/result.json", "evidence/card.json"],
    createdAt: now,
  });
  assert.equal(checkpoint.messages.length, 2);
  assert.deepEqual(checkpoint.artifactRefs, ["build/result.json", "evidence/card.json"]);
  assert.equal(checkpoint.historyHead.sequence, 1);

  const preservedCounts = tableCounts(database, [
    "approvals",
    "reviews",
    "patches",
    "patch_operations",
    "file_checkpoints",
  ]);
  const first = database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "fork-request-1",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
    createdAt: now,
  });
  assert.notEqual(first.thread.id, "source-thread");
  assert.deepEqual(first.messages.map((message) => message.content), ["message 0", "message 1"]);
  assert.ok(first.messages.every((message) => !message.id.startsWith("source-message-")));
  assert.deepEqual(tableCounts(database, Object.keys(preservedCounts)), preservedCounts);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");

  const replay = database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "fork-request-1",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
    createdAt: now,
  });
  assert.equal(replay.fork.id, first.fork.id);
  assert.equal(replay.thread.id, first.thread.id);
  assert.deepEqual(replay.messages.map((message) => message.id), first.messages.map((message) => message.id));
  assert.equal(Number(database.db.prepare("SELECT COUNT(*) AS count FROM run_forks").get().count), 1);
  assert.throws(() => database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "fork-request-1",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
    title: "Different retry title",
  }), /different fork request/);
  assert.deepEqual(database.listRunCheckpoints("run-1").map((item) => item.id), [checkpoint.id]);
  assert.deepEqual(database.listRunForks({ runId: "run-1" }).map((item) => item.id), [first.fork.id]);
  assert.deepEqual(
    database.listRunForks({ checkpointIds: [checkpoint.id, checkpoint.id] }).map((item) => item.id),
    [first.fork.id],
  );
  assert.deepEqual(database.listRunForks({ checkpointIds: [] }), []);

  assert.throws(() => database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "wrong-digest",
    expectedSnapshotDigest: "0".repeat(64),
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
  }), /snapshot digest/);
  assert.throws(() => database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "wrong-workspace",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: resolve(testRoot, "other"),
  }), /different workspace identity/);
  assert.throws(
    () => database.db.prepare("UPDATE run_checkpoints SET run_id = 'other'").run(),
    /immutable/,
  );
  assert.throws(
    () => database.db.prepare("DELETE FROM run_forks").run(),
    /immutable/,
  );
  database.close();
});

test("assistant message and task checkpoint commit atomically and hydrate one RunDetail snapshot", () => {
  const database = new AppDatabase(":memory:");
  database.createThread({
    id: "atomic-thread",
    workspacePath: testRoot,
    title: "Atomic boundary",
    mode: "act",
    createdAt: now,
    updatedAt: now,
  });
  database.createThread({
    id: "other-thread",
    workspacePath: testRoot,
    title: "Other task",
    mode: "act",
    createdAt: now,
    updatedAt: now,
  });
  database.recordRunStart({
    id: "atomic-goal",
    runId: "atomic-run",
    stage: "goal",
    actor: "user",
    title: "Goal",
    summary: "Persist a logical task boundary",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: now,
  }, "atomic-thread", testRoot);

  assert.throws(() => database.commitMessageWithRunCheckpoint(
    "atomic-run",
    "other-thread",
    { id: "must-rollback", role: "assistant", content: "not committed", createdAt: now },
  ), /does not match/);
  assert.deepEqual(database.getMessages("other-thread"), []);
  assert.deepEqual(database.listRunCheckpoints("atomic-run"), []);

  const checkpoint = database.commitMessageWithRunCheckpoint(
    "atomic-run",
    "atomic-thread",
    { id: "assistant-final", role: "assistant", content: "Task boundary committed.", createdAt: now },
    ["build/result.json"],
  );
  const detail = database.getRunDetail("atomic-run");
  assert.deepEqual(detail.messages.map((message) => message.id), ["assistant-final"]);
  assert.deepEqual(detail.taskCheckpoints.map((item) => item.id), [checkpoint.id]);
  assert.equal(detail.taskCheckpoints[0].messages.at(-1).sourceMessageId, "assistant-final");
  assert.deepEqual(detail.runForks, []);
  assert.equal(detail.eventHistory.length, 1);
  assert.deepEqual(detail.historyHead, checkpoint.historyHead);
  assert.match(detail.revision, /\|task-checkpoints:1:/);
  database.close();
});

test("Mission Recipe persists inside the immutable checkpoint digest and fails closed after tampering", () => {
  const database = new AppDatabase(":memory:");
  const sourceThread = {
    id: "recipe-thread",
    workspacePath: testRoot,
    title: "Evidence recovery",
    mode: "plan",
    modelId: "model-1",
    createdAt: now,
    updatedAt: now,
  };
  database.createThread(sourceThread);
  database.addMessage(sourceThread.id, {
    id: "recipe-goal",
    role: "user",
    content: "Review the evidence and prepare a plan.",
    createdAt: now,
  });
  database.recordRunStart({ ...runStartEvent("recipe-run-goal"), runId: "recipe-run" }, sourceThread.id, testRoot);
  const recipe = buildMissionRecipe({
    thread: sourceThread,
    goal: "Review the evidence and prepare a plan.",
    workspaceIdentity: workspaceBindingIdentity(testRoot),
    model: {
      id: "model-1",
      name: "Local model",
      path: "C:/models/model.gguf",
      files: ["model.gguf"],
      sizeBytes: 100,
      architecture: "qwen",
      quantization: "Q4_K_M",
      contextLength: 32768,
      vision: false,
      toolCapability: "agent-ready",
      fingerprint: "b".repeat(64),
      estimatedVramBytes: 100,
      loadState: "active",
      pinned: false,
      metadataSource: "gguf",
    },
    runtime: { available: true, backend: "cuda", degraded: false, detail: "ready" },
    moduleIntegrity: {
      ok: true,
      enforced: true,
      manifestPath: "module-manifest.json",
      manifestSha256: "c".repeat(64),
      checkedAt: now,
      modules: [{
        moduleId: "core.audit",
        version: 1,
        core: true,
        status: "verified",
        disposition: "loaded",
        moduleSha256: "d".repeat(64),
        checkedArtifacts: 1,
        diagnostics: [],
      }],
    },
    capabilities: {
      workspace: "file:///workspace",
      execution: {
        mode: "disabled",
        available: false,
        configured: false,
        provider_visible: false,
        smoke_verified: false,
        image_digest_pinned: false,
      },
      networkPaths: [],
      networkEnabled: false,
      networkAuthorization: "per-call-hmac-capability",
      filesystemSafety: {
        relativePathsOnly: true,
        reparsePointsAllowed: false,
        atomicReplace: true,
        windowsResidualSameUserRenameRace: true,
      },
    },
    toolNames: ["workspace_read", "workspace_search"],
    createdAt: now,
  });
  const checkpoint = database.createRunCheckpoint({
    id: "recipe-checkpoint",
    runId: "recipe-run",
    missionRecipe: recipe,
    createdAt: now,
  });
  assert.equal(checkpoint.missionRecipe?.digest, recipe.digest);
  assert.equal(database.getRunCheckpoint(checkpoint.id)?.missionRecipe?.goal, recipe.goal);

  database.db.exec("DROP TRIGGER run_checkpoints_no_update");
  const stored = JSON.parse(database.db.prepare("SELECT payload FROM run_checkpoints WHERE id = ?").get(checkpoint.id).payload);
  stored.missionRecipe.goal = "tampered goal";
  database.db.prepare("UPDATE run_checkpoints SET payload = ? WHERE id = ?").run(JSON.stringify(stored), checkpoint.id);
  assert.throws(() => database.getRunCheckpoint(checkpoint.id), /mission recipe/i);
  database.close();
});

test("recordRunStart rejects a conflicting run binding without appending history", () => {
  const database = new AppDatabase(":memory:");
  database.createThread(thread("thread-a", testRoot));
  database.createThread(thread("thread-b", resolve(testRoot, "other")));
  database.recordRunStart(runStartEvent("goal-a"), "thread-a", testRoot);
  assert.throws(
    () => database.recordRunStart(runStartEvent("goal-b"), "thread-b", resolve(testRoot, "other")),
    /different task thread/,
  );
  assert.deepEqual(database.getRunContext("run-1"), { threadId: "thread-a", workspacePath: testRoot });
  assert.equal(database.getRunEventHistory("run-1").length, 1);
  database.close();
});

test("fork failure rolls its writes back to a savepoint inside an outer transaction", () => {
  const database = new AppDatabase(":memory:");
  database.createThread(thread("source-thread", testRoot));
  database.addMessage("source-thread", {
    id: "message-1",
    role: "user",
    content: "source",
    createdAt: now,
  });
  database.recordRunStart(runStartEvent("goal"), "source-thread", testRoot);
  const checkpoint = database.createRunCheckpoint({ id: "checkpoint-savepoint", runId: "run-1" });
  database.db.exec(`
    CREATE TRIGGER reject_fork_messages
    BEFORE INSERT ON messages
    WHEN NEW.thread_id <> 'source-thread'
    BEGIN
      SELECT RAISE(ABORT, 'injected message failure');
    END;
    BEGIN IMMEDIATE;
  `);
  assert.throws(() => database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "savepoint-failure",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
  }), /injected message failure/);
  assert.equal(database.db.isTransaction, true);
  assert.equal(Number(database.db.prepare("SELECT COUNT(*) AS count FROM threads").get().count), 1);
  assert.equal(Number(database.db.prepare("SELECT COUNT(*) AS count FROM run_forks").get().count), 0);
  database.db.exec("ROLLBACK");
  database.close();
});

test("forged checkpoint and fork payload bindings fail closed before cross-task hydration", () => {
  const database = new AppDatabase(":memory:");
  database.createThread(thread("source-thread", testRoot));
  database.createThread(thread("secret-thread", testRoot));
  database.addMessage("source-thread", { id: "source-message", role: "user", content: "public", createdAt: now });
  database.addMessage("secret-thread", { id: "secret-message", role: "user", content: "secret", createdAt: now });
  database.recordRunStart(runStartEvent("goal"), "source-thread", testRoot);
  const checkpoint = database.createRunCheckpoint({ id: "checkpoint-forgery", runId: "run-1" });
  const result = database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "fork-forgery",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
  });
  database.db.exec("DROP TRIGGER run_forks_no_update");
  const forgedFork = JSON.parse(
    database.db.prepare("SELECT payload FROM run_forks WHERE id = ?").get(result.fork.id).payload,
  );
  forgedFork.forkThreadId = "secret-thread";
  database.db.prepare("UPDATE run_forks SET payload = ? WHERE id = ?")
    .run(JSON.stringify(forgedFork), result.fork.id);
  assert.throws(() => database.listRunForks({ runId: "run-1" }), /columns conflict/);
  assert.throws(() => database.forkRunCheckpoint({
    checkpointId: checkpoint.id,
    idempotencyKey: "fork-forgery",
    expectedSnapshotDigest: checkpoint.snapshotDigest,
    expectedResumeContractDigest: resumeDigest,
    expectedWorkspacePath: testRoot,
  }), /columns conflict/);

  database.db.exec("DROP TRIGGER run_checkpoints_no_update");
  const stored = JSON.parse(database.db.prepare("SELECT payload FROM run_checkpoints WHERE id = ?").get(checkpoint.id).payload);
  stored.runId = "other-run";
  database.db.prepare("UPDATE run_checkpoints SET payload = ? WHERE id = ?").run(JSON.stringify(stored), checkpoint.id);
  assert.throws(() => database.getRunCheckpoint(checkpoint.id), /columns conflict/);
  database.close();
});

function thread(id, workspacePath) {
  return { id, workspacePath, title: id, mode: "act", createdAt: now, updatedAt: now };
}

function runStartEvent(id) {
  return {
    id,
    runId: "run-1",
    stage: "goal",
    actor: "user",
    title: "Goal",
    summary: "Task context",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: now,
  };
}

function tableCounts(database, tables) {
  return Object.fromEntries(tables.map((table) => [
    table,
    Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
  ]));
}
