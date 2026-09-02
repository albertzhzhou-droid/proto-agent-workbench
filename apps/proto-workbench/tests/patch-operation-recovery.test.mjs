import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { runAllowedActions } from "../src/shared/run-lifecycle.ts";

const FIXTURE_PREFIX = "proto-workbench-patch-operation-";

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
  const fixture = {
    root,
    databasePath: join(root, "state.sqlite"),
    database: undefined,
    workspace: undefined,
  };
  fixture.database = new AppDatabase(fixture.databasePath);
  fixture.workspace = new WorkspaceFiles(root, fixture.database);
  fixture.reopen = () => {
    fixture.database.close();
    fixture.database = new AppDatabase(fixture.databasePath);
    fixture.workspace = new WorkspaceFiles(root, fixture.database);
  };
  try {
    await run(fixture);
  } finally {
    try {
      fixture.database.close();
    } catch {
      // The test may deliberately close the first connection to simulate restart.
    }
    assert.ok(basename(root).startsWith(FIXTURE_PREFIX), "fixture cleanup must stay in its owned temp directory");
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function prepareApplying(database, workspace, input) {
  const targetPath = join(input.root, input.name);
  await writeFile(targetPath, input.before, "utf8");
  const patch = await workspace.proposePatch({
    runId: input.runId,
    targetPath,
    after: input.after,
    rationale: `Exercise ${input.runId} recovery.`,
  });
  const prepared = database.preparePatchOperation(patch.id, patch.revision, {
    targetPath: patch.targetPath,
    existed: patch.baseExists,
    content: patch.before,
    sha256: patch.baseSha256,
    resultSha256: sha256(patch.after),
    resultExists: patch.afterExists,
  });
  const operation = database.markPatchOperationApplying(prepared.operation.id, prepared.operation.revision);
  return { targetPath, patch, operation, checkpoint: prepared.checkpoint };
}

async function prepareApplyingReverse(database, workspace, input) {
  const targetPath = join(input.root, input.name);
  await writeFile(targetPath, input.before, "utf8");
  const original = await workspace.proposePatch({
    runId: input.runId,
    targetPath,
    after: input.after,
    rationale: `Exercise ${input.runId} durable reverse recovery.`,
  });
  const applied = await workspace.applyApprovedPatch(original.id, original.revision);
  const reverse = await workspace.prepareCheckpointRestore(
    applied.checkpoint.id,
    applied.checkpoint.revision,
  );
  const prepared = database.preparePatchOperation(reverse.id, reverse.revision, {
    targetPath: reverse.targetPath,
    existed: reverse.baseExists,
    content: reverse.before,
    sha256: reverse.baseSha256,
    resultSha256: sha256(reverse.after),
    resultExists: reverse.afterExists,
  });
  const applying = database.markPatchOperationApplying(
    prepared.operation.id,
    prepared.operation.revision,
  );
  return { targetPath, original, applied, reverse, applying };
}

test("a successful controlled apply persists existence CAS, operation, and checkpoint before validation", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const targetPath = join(root, "successful.proto");
    const before = "design recovery_v1 chassis ecoli_k12\n";
    const after = "design recovery_v2 chassis ecoli_k12\n";
    await writeFile(targetPath, before, "utf8");

    const patch = await workspace.proposePatch({
      runId: "run-successful-apply",
      targetPath,
      after,
      rationale: "Create a durable checkpoint before the reviewed write.",
    });

    assert.equal(patch.baseExists, true);
    assert.equal(patch.afterExists, true);
    assert.equal(patch.baseSha256, sha256(before));

    const applied = await workspace.applyApprovedPatch(patch.id, patch.revision);

    assert.equal(await readFile(targetPath, "utf8"), after);
    assert.equal(applied.patch.status, "approved");
    assert.equal(applied.patch.revision, 1);
    assert.equal(applied.operation.state, "applied");
    assert.equal(applied.operation.baseExists, true);
    assert.equal(applied.operation.resultExists, true);
    assert.equal(applied.operation.resultSha256, sha256(after));
    assert.equal(applied.checkpoint.existed, true);
    assert.equal(applied.checkpoint.sha256, sha256(before));
    assert.equal(applied.checkpoint.resultSha256, sha256(after));
    assert.equal(applied.checkpoint.restoreState, "available");
    assert.equal(database.getCheckpointSnapshot(applied.checkpoint.id).content, before);
  });
});

test("existence CAS distinguishes an absent base from a third-party empty file", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const targetPath = join(root, "created-after-review.md");
    const patch = await workspace.proposePatch({
      runId: "run-existence-cas",
      targetPath,
      after: "reviewed content\n",
      rationale: "Create a file only if it remains absent.",
    });

    assert.equal(patch.baseExists, false);
    assert.equal(patch.baseSha256, sha256(""));
    assert.equal(patch.afterExists, true);

    await writeFile(targetPath, "", "utf8");
    await assert.rejects(
      workspace.applyApprovedPatch(patch.id, patch.revision),
      /file changed after this patch was proposed/i,
    );

    assert.equal(await readFile(targetPath, "utf8"), "");
    assert.equal(database.getPatch(patch.id).status, "stale");
    assert.equal(database.getPatchOperationForPatch(patch.id), undefined);
    assert.equal(database.listFileCheckpoints(patch.runId).length, 0);
  });
});

test("startup reconciliation classifies base, intended result, and conflict without replaying a write", async () => {
  await withWorkspace(async (fixture) => {
    const base = await prepareApplying(fixture.database, fixture.workspace, {
      root: fixture.root,
      name: "reconcile-base.proto",
      runId: "run-reconcile-base",
      before: "design base_case chassis ecoli_k12\n",
      after: "design base_result chassis ecoli_k12\n",
    });
    const result = await prepareApplying(fixture.database, fixture.workspace, {
      root: fixture.root,
      name: "reconcile-result.proto",
      runId: "run-reconcile-result",
      before: "design result_case chassis ecoli_k12\n",
      after: "design intended_result chassis ecoli_k12\n",
    });
    const conflict = await prepareApplying(fixture.database, fixture.workspace, {
      root: fixture.root,
      name: "reconcile-conflict.proto",
      runId: "run-reconcile-conflict",
      before: "design conflict_case chassis ecoli_k12\n",
      after: "design conflict_result chassis ecoli_k12\n",
    });

    await writeFile(result.targetPath, result.patch.after, "utf8");
    const thirdParty = "design third_party_edit chassis ecoli_k12\n";
    await writeFile(conflict.targetPath, thirdParty, "utf8");

    fixture.reopen();
    const report = await fixture.workspace.reconcilePatchOperations();

    assert.deepEqual(report, { reconciled: 3, conflicted: 1 });

    const baseRecovered = fixture.database.getPatchOperation(base.operation.id);
    assert.equal(baseRecovered.state, "prepared");
    assert.match(baseRecovered.error, /no file effect was observed/i);
    assert.equal(fixture.database.getPatch(base.patch.id).status, "pending");
    assert.equal(await readFile(base.targetPath, "utf8"), base.patch.before);

    const resultRecovered = fixture.database.getPatchOperation(result.operation.id);
    assert.equal(resultRecovered.state, "applied");
    assert.equal(resultRecovered.observedSha256, sha256(result.patch.after));
    assert.equal(fixture.database.getPatch(result.patch.id).status, "approved");
    assert.equal(await readFile(result.targetPath, "utf8"), result.patch.after);

    const conflictRecovered = fixture.database.getPatchOperation(conflict.operation.id);
    assert.equal(conflictRecovered.state, "conflict");
    assert.equal(conflictRecovered.observedSha256, sha256(thirdParty));
    assert.match(conflictRecovered.error, /matches neither/i);
    assert.equal(fixture.database.getPatch(conflict.patch.id).status, "pending");
    assert.equal(await readFile(conflict.targetPath, "utf8"), thirdParty);
  });
});

test("checkpoint restore creates only a pending reverse patch and preserves the current file", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const targetPath = join(root, "new-artifact.md");
    const currentContent = "generated reviewed artifact\n";
    const original = await workspace.proposePatch({
      runId: "run-restore-proposal",
      targetPath,
      after: currentContent,
      rationale: "Create a reviewed artifact from an absent base.",
    });
    const applied = await workspace.applyApprovedPatch(original.id, original.revision);

    assert.equal(applied.checkpoint.existed, false);
    assert.equal(await readFile(targetPath, "utf8"), currentContent);

    const restore = await workspace.prepareCheckpointRestore(
      applied.checkpoint.id,
      applied.checkpoint.revision,
    );

    assert.equal(restore.status, "pending");
    assert.equal(restore.revision, 0);
    assert.equal(restore.restoresCheckpointId, applied.checkpoint.id);
    assert.equal(restore.baseExists, true);
    assert.equal(restore.baseSha256, sha256(currentContent));
    assert.equal(restore.before, currentContent);
    assert.equal(restore.after, "");
    assert.equal(restore.afterExists, false);
    assert.equal(await readFile(targetPath, "utf8"), currentContent, "preparing restore must not change the file");
    assert.equal(database.getPatchOperationForPatch(restore.id), undefined, "restore remains a reviewable proposal");

    const checkpoint = database.getFileCheckpoint(applied.checkpoint.id);
    assert.equal(checkpoint.restoreState, "restore-proposed");
    assert.equal(checkpoint.restorePatchId, restore.id);
    assert.deepEqual(
      database.listPatches(original.runId).map((candidate) => candidate.id).sort(),
      [original.id, restore.id].sort(),
    );
  });
});

test("applying a reverse patch restores content and existence while rolling back its source operation", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const scenarios = [
      {
        suffix: "content",
        existed: true,
        before: "checkpoint content before the reviewed change\n",
        after: "reviewed replacement content\n",
      },
      {
        suffix: "existence",
        existed: false,
        before: "",
        after: "reviewed newly created content\n",
      },
    ];

    for (const scenario of scenarios) {
      const targetPath = join(root, `restore-${scenario.suffix}.md`);
      if (scenario.existed) await writeFile(targetPath, scenario.before, "utf8");
      const original = await workspace.proposePatch({
        runId: `run-apply-reverse-${scenario.suffix}`,
        targetPath,
        after: scenario.after,
        rationale: "Apply a reviewed change before exercising its reverse patch.",
      });
      const applied = await workspace.applyApprovedPatch(original.id, original.revision);
      const reverse = await workspace.prepareCheckpointRestore(
        applied.checkpoint.id,
        applied.checkpoint.revision,
      );

      assert.equal(reverse.status, "pending");
      assert.equal(reverse.afterExists, scenario.existed);
      const restored = await workspace.applyApprovedPatch(reverse.id, reverse.revision);

      assert.equal(restored.patch.id, reverse.id);
      assert.equal(restored.patch.status, "approved");
      assert.equal(restored.operation.patchId, reverse.id);
      assert.equal(restored.operation.state, "applied");
      assert.equal(database.getPatchOperationForPatch(reverse.id).state, "applied");

      const originalCheckpoint = database.getFileCheckpoint(applied.checkpoint.id);
      assert.equal(originalCheckpoint.restoreState, "restored");
      assert.equal(originalCheckpoint.restorePatchId, reverse.id);
      assert.ok(originalCheckpoint.restoredAt);
      assert.equal(database.getPatchOperation(applied.operation.id).state, "rolled-back");
      assert.equal(database.getPatch(original.id).status, "rolled-back");

      assert.equal(await pathExists(targetPath), scenario.existed);
      if (scenario.existed) assert.equal(await readFile(targetPath, "utf8"), scenario.before);
    }
  });
});

test("reconciliation atomically finalizes an applying reverse operation whose result is already on disk", async () => {
  await withWorkspace(async (fixture) => {
    const scenario = await prepareApplyingReverse(fixture.database, fixture.workspace, {
      root: fixture.root,
      name: "reconcile-reverse-result.md",
      runId: "run-reconcile-reverse-result",
      before: "durable checkpoint content\n",
      after: "reviewed replacement before restart\n",
    });

    await writeFile(scenario.targetPath, scenario.reverse.after, "utf8");
    fixture.reopen();
    const reconciled = await fixture.workspace.reconcilePatchOperation(
      scenario.applying.id,
      scenario.applying.revision,
    );

    assert.equal(reconciled.state, "applied");
    assert.equal(reconciled.observedSha256, sha256(scenario.reverse.after));
    assert.equal(fixture.database.getPatch(scenario.reverse.id).status, "approved");
    assert.equal(fixture.database.getPatchOperationForPatch(scenario.reverse.id).state, "applied");
    const sourceCheckpoint = fixture.database.getFileCheckpoint(scenario.applied.checkpoint.id);
    assert.equal(sourceCheckpoint.restoreState, "restored");
    assert.equal(sourceCheckpoint.restorePatchId, scenario.reverse.id);
    assert.equal(fixture.database.getPatchOperation(scenario.applied.operation.id).state, "rolled-back");
    assert.equal(fixture.database.getPatch(scenario.original.id).status, "rolled-back");
    assert.equal(await readFile(scenario.targetPath, "utf8"), scenario.reverse.after);
  });
});

test("a conflicted reverse operation stays pending, then returns to its reviewable prepared state at base", async () => {
  await withWorkspace(async (fixture) => {
    const scenario = await prepareApplyingReverse(fixture.database, fixture.workspace, {
      root: fixture.root,
      name: "reconcile-reverse-conflict-base.md",
      runId: "run-reconcile-reverse-conflict-base",
      before: "checkpoint content to restore later\n",
      after: "reviewed current content\n",
    });
    const thirdParty = "third-party content during reverse apply\n";
    await writeFile(scenario.targetPath, thirdParty, "utf8");

    fixture.reopen();
    const conflicted = await fixture.workspace.reconcilePatchOperation(
      scenario.applying.id,
      scenario.applying.revision,
    );

    assert.equal(conflicted.state, "conflict");
    assert.equal(conflicted.observedSha256, sha256(thirdParty));
    assert.equal(fixture.database.getPatch(scenario.reverse.id).status, "pending");
    assert.equal(fixture.database.getFileCheckpoint(scenario.applied.checkpoint.id).restoreState, "restore-proposed");
    assert.equal(fixture.database.getPatchOperation(scenario.applied.operation.id).state, "applied");
    assert.equal(fixture.database.getPatch(scenario.original.id).status, "approved");

    const conflictActions = runAllowedActions({
      events: [],
      patches: fixture.database.listPatches(scenario.original.runId),
      patchOperations: [
        conflicted,
        fixture.database.getPatchOperation(scenario.applied.operation.id),
      ],
      checkpoints: fixture.database.listFileCheckpoints(scenario.original.runId),
    });
    assert.deepEqual(
      Object.entries(conflictActions).filter(([, allowed]) => allowed).map(([action]) => action),
      ["reconcilePatchEffect"],
      "a conflict must expose only the explicit reconcile action",
    );

    await writeFile(scenario.targetPath, scenario.reverse.before, "utf8");
    fixture.reopen();
    const prepared = await fixture.workspace.reconcilePatchOperation(conflicted.id, conflicted.revision);

    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.observedSha256, sha256(scenario.reverse.before));
    assert.equal(fixture.database.getPatch(scenario.reverse.id).status, "pending");
    assert.equal(await readFile(scenario.targetPath, "utf8"), scenario.reverse.before);
    const preparedActions = runAllowedActions({
      events: [],
      patches: fixture.database.listPatches(scenario.original.runId),
      patchOperations: [
        prepared,
        fixture.database.getPatchOperation(scenario.applied.operation.id),
      ],
      checkpoints: fixture.database.listFileCheckpoints(scenario.original.runId),
    });
    assert.equal(preparedActions.approvePatch, true);
    assert.equal(preparedActions.rejectPatch, false);
    assert.equal(preparedActions.reconcilePatchEffect, false);
  });
});

test("a conflicted reverse operation atomically finalizes when its result later appears", async () => {
  await withWorkspace(async (fixture) => {
    const scenario = await prepareApplyingReverse(fixture.database, fixture.workspace, {
      root: fixture.root,
      name: "reconcile-reverse-conflict-result.md",
      runId: "run-reconcile-reverse-conflict-result",
      before: "checkpoint result recovered after conflict\n",
      after: "reviewed replacement before conflict\n",
    });
    const thirdParty = "unrelated content observed during recovery\n";
    await writeFile(scenario.targetPath, thirdParty, "utf8");

    fixture.reopen();
    const conflicted = await fixture.workspace.reconcilePatchOperation(
      scenario.applying.id,
      scenario.applying.revision,
    );
    assert.equal(conflicted.state, "conflict");
    assert.equal(fixture.database.getPatch(scenario.reverse.id).status, "pending");

    await writeFile(scenario.targetPath, scenario.reverse.after, "utf8");
    fixture.reopen();
    const reconciled = await fixture.workspace.reconcilePatchOperation(conflicted.id, conflicted.revision);

    assert.equal(reconciled.state, "applied");
    assert.equal(reconciled.observedSha256, sha256(scenario.reverse.after));
    assert.equal(fixture.database.getPatch(scenario.reverse.id).status, "approved");
    assert.equal(fixture.database.getPatchOperationForPatch(scenario.reverse.id).state, "applied");
    const sourceCheckpoint = fixture.database.getFileCheckpoint(scenario.applied.checkpoint.id);
    assert.equal(sourceCheckpoint.restoreState, "restored");
    assert.equal(sourceCheckpoint.restorePatchId, scenario.reverse.id);
    assert.equal(fixture.database.getPatchOperation(scenario.applied.operation.id).state, "rolled-back");
    assert.equal(fixture.database.getPatch(scenario.original.id).status, "rolled-back");
    assert.equal(await readFile(scenario.targetPath, "utf8"), scenario.reverse.after);
  });
});

test("rejecting a reverse patch releases its checkpoint reservation and allows another proposal", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const targetPath = join(root, "reject-reverse.md");
    const before = "checkpoint before rejection\n";
    const after = "reviewed content remains after rejection\n";
    await writeFile(targetPath, before, "utf8");
    const original = await workspace.proposePatch({
      runId: "run-reject-reverse",
      targetPath,
      after,
      rationale: "Exercise rejection of a checkpoint reverse patch.",
    });
    const applied = await workspace.applyApprovedPatch(original.id, original.revision);
    const firstReverse = await workspace.prepareCheckpointRestore(
      applied.checkpoint.id,
      applied.checkpoint.revision,
    );

    const reserved = database.getFileCheckpoint(applied.checkpoint.id);
    assert.equal(reserved.restoreState, "restore-proposed");
    assert.equal(reserved.restorePatchId, firstReverse.id);

    const rejected = workspace.rejectPatch(firstReverse.id, firstReverse.revision);
    assert.equal(rejected.status, "rejected");
    assert.equal(await readFile(targetPath, "utf8"), after);

    const released = database.getFileCheckpoint(applied.checkpoint.id);
    assert.equal(released.restoreState, "available");
    assert.equal(released.restorePatchId, undefined);
    assert.equal(database.getPatchOperation(applied.operation.id).state, "applied");

    const secondReverse = await workspace.prepareCheckpointRestore(released.id, released.revision);
    assert.equal(secondReverse.status, "pending");
    assert.equal(secondReverse.restoresCheckpointId, released.id);
    assert.notEqual(secondReverse.id, firstReverse.id);
    const reservedAgain = database.getFileCheckpoint(released.id);
    assert.equal(reservedAgain.restoreState, "restore-proposed");
    assert.equal(reservedAgain.restorePatchId, secondReverse.id);
    assert.equal(await readFile(targetPath, "utf8"), after, "neither reject nor re-prepare may alter the file");
  });
});

test("a reverse patch that becomes stale before approval releases its restore reservation", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const targetPath = join(root, "stale-reverse.md");
    const before = "checkpoint before stale proposal\n";
    const after = "reviewed current result\n";
    await writeFile(targetPath, before, "utf8");
    const original = await workspace.proposePatch({
      runId: "run-stale-reverse",
      targetPath,
      after,
      rationale: "Exercise a restore proposal that becomes stale before approval.",
    });
    const applied = await workspace.applyApprovedPatch(original.id, original.revision);
    const staleReverse = await workspace.prepareCheckpointRestore(
      applied.checkpoint.id,
      applied.checkpoint.revision,
    );
    const thirdParty = "third-party content written after reverse review\n";
    await writeFile(targetPath, thirdParty, "utf8");

    await assert.rejects(
      workspace.applyApprovedPatch(staleReverse.id, staleReverse.revision),
      /file changed after this patch was proposed/i,
    );

    assert.equal(database.getPatch(staleReverse.id).status, "stale");
    assert.equal(database.getPatchOperationForPatch(staleReverse.id), undefined);
    assert.equal(await readFile(targetPath, "utf8"), thirdParty);
    const released = database.getFileCheckpoint(applied.checkpoint.id);
    assert.equal(released.restoreState, "available");
    assert.equal(released.restorePatchId, undefined);
    assert.equal(database.getPatchOperation(applied.operation.id).state, "applied");

    await writeFile(targetPath, after, "utf8");
    const secondReverse = await workspace.prepareCheckpointRestore(released.id, released.revision);
    assert.equal(secondReverse.status, "pending");
    assert.equal(secondReverse.restoresCheckpointId, released.id);
    assert.notEqual(secondReverse.id, staleReverse.id);
  });
});

test("checkpoint restore fails closed after a third-party edit and creates no reverse patch", async () => {
  await withWorkspace(async ({ root, database, workspace }) => {
    const targetPath = join(root, "third-party.md");
    const before = "original checkpoint content\n";
    const after = "reviewed applied content\n";
    await writeFile(targetPath, before, "utf8");
    const original = await workspace.proposePatch({
      runId: "run-restore-conflict",
      targetPath,
      after,
      rationale: "Apply content before testing restore conflict handling.",
    });
    const applied = await workspace.applyApprovedPatch(original.id, original.revision);
    const thirdParty = "newer third-party content\n";
    await writeFile(targetPath, thirdParty, "utf8");

    await assert.rejects(
      workspace.prepareCheckpointRestore(applied.checkpoint.id, applied.checkpoint.revision),
      /file changed after this checkpoint was created/i,
    );

    assert.equal(await readFile(targetPath, "utf8"), thirdParty);
    assert.equal(database.listPatches(original.runId).length, 1, "no reverse patch is created on conflict");
    assert.equal(database.getPatchOperationForPatch(original.id).state, "applied");
    const checkpoint = database.getFileCheckpoint(applied.checkpoint.id);
    assert.equal(checkpoint.restoreState, "conflict");
    assert.match(checkpoint.conflictReason, /will not overwrite the newer content/i);
  });
});
