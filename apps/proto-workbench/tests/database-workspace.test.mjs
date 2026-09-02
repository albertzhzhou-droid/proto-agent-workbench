import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";

const testRoot = resolve("tests", `.tmp-workspace-${process.pid}`);

test.before(async () => {
  await mkdir(testRoot, { recursive: true });
});

test.after(async () => {
  const relative = testRoot.slice(resolve(".").length);
  assert.ok(relative.includes("tests"), "test cleanup must stay under the app workspace");
  await rm(testRoot, { recursive: true, force: true });
});

test("SQLite store persists threads and run events", () => {
  const database = new AppDatabase(":memory:");
  const now = new Date().toISOString();
  database.createThread({
    id: "thread-1",
    workspacePath: testRoot,
    title: "Test run",
    mode: "act",
    createdAt: now,
    updatedAt: now,
  });
  database.appendEvent({
    id: "event-1",
    runId: "run-1",
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "Design a complex evidence-backed Proto workflow without inventing biological part IDs",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: now,
  });
  assert.equal(database.listThreads()[0].id, "thread-1");
  assert.equal(database.updateThread("thread-1", { mode: "plan" }).mode, "plan");
  assert.equal(database.getRunEvents("run-1")[0].title, "Goal defined");
  assert.match(database.listRuns()[0].title, /^Design a complex evidence-backed Proto workflow/);
  database.appendEvent({
    id: "plan-1",
    runId: "run-1",
    stage: "plan",
    actor: "assistant",
    title: "Agent plan started",
    summary: "Tool budget exhausted.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "failed",
    createdAt: now,
  });
  database.appendEvent({
    id: "tool-1",
    runId: "run-1",
    stage: "plan",
    actor: "tool",
    title: "Search Parts",
    summary: "Tool completed.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
  });
  assert.equal(database.listRuns()[0].status, "failed");
  database.appendEvent({
    id: "transient-design-failure",
    runId: "run-1",
    stage: "design",
    actor: "tool",
    title: "Propose Patch",
    summary: "The first proposal was incomplete.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "failed",
    createdAt: new Date(Date.parse(now) + 1_500).toISOString(),
  });
  database.appendEvent({
    id: "plan-1",
    runId: "run-1",
    stage: "plan",
    actor: "assistant",
    title: "Agent plan started",
    summary: "Recovered and ready for review.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: now,
  });
  assert.equal(database.listRuns()[0].status, "completed");
  assert.equal(database.listRuns()[0].archived, false);
  database.setRunArchived("run-1", true);
  assert.equal(database.listRuns().length, 0);
  assert.equal(database.listRuns(true)[0].archived, true);
  const comment = database.addReviewComment("run-1", "Review note");
  assert.equal(database.listReviewComments("run-1")[0].id, comment.id);
  database.close();
});

test("workspace patch is reviewable, stale-safe, and path-contained", async () => {
  const database = new AppDatabase(":memory:");
  const path = resolve(testRoot, "sample.proto");
  await writeFile(path, "design sample chassis ecoli_k12\n", "utf8");
  const workspace = new WorkspaceFiles(testRoot, database);
  const patch = await workspace.proposePatch({
    runId: "run-1",
    targetPath: "sample.proto",
    after: "design sample_v2 chassis ecoli_k12\n",
    rationale: "Test controlled edit",
  });
  assert.match(patch.unifiedDiff, /sample_v2/);
  const applied = await workspace.applyApprovedPatch(patch.id, patch.revision);
  assert.equal(applied.patch.status, "approved");
  assert.equal(applied.operation.state, "applied");
  assert.equal(applied.checkpoint.restoreState, "available");
  assert.equal(await readFile(path, "utf8"), "design sample_v2 chassis ecoli_k12\n");
  await assert.rejects(() => workspace.read("..\\outside.txt"), /outside the selected workspace/);
  database.close();
});
