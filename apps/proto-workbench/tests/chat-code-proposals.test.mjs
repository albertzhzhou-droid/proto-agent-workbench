import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentService } from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { RESEARCH_TOOLS, WORKFLOW_GUIDANCE, ResearchToolBridge, codePatchPathProblem, researchToolsFor } from "../src/main/services/research-tools.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chat-code-")));
  const database = new AppDatabase(":memory:");
  const files = new WorkspaceFiles(root, database);
  const agent = new AgentService(database, { get: () => undefined, getActiveModel: () => undefined }, files, { tools: async () => [], call: async () => ({ ok: true }) }, () => {}, undefined, root);
  const bridge = new ResearchToolBridge({ tools: async () => [], capabilities: async () => ({}) }, files, undefined, undefined, { open: (sessionId, request) => agent.openChatCodeRun(sessionId, request) });
  const session = { id: "3f6c1c7e-9d0e-4c61-8f45-0f4f6f1f9a10", workflow: "code", documents: [], messages: [{ role: "user", content: "Add a retry to fetch.py" }] };
  const run = (name, input, overrides = {}) => bridge.execute(name, input, { ...session, ...overrides }, new AbortController().signal);
  return { root, database, files, agent, run, cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("the code tool is offered only in the coding workflow and the guidance forbids claiming a change", () => {
  assert.ok(RESEARCH_TOOLS.some(tool => tool.function.name === "code_propose_patch"));
  assert.ok(researchToolsFor("code").some(tool => tool.function.name === "code_propose_patch"));
  for (const workflow of [undefined, "explore", "literature", "analysis", "reproduce"]) {
    assert.ok(!researchToolsFor(workflow).some(tool => tool.function.name === "code_propose_patch"), String(workflow));
  }
  assert.match(WORKFLOW_GUIDANCE.code, /never claim a change was made/i);
});

test("a proposal records a pending diff for review and leaves the workspace file untouched", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "fetch.py"), "def get():\n    return 1\n");
    await f.run("workspace_read", { path: "fetch.py" });
    const receipt = await f.run("code_propose_patch", { path: "fetch.py", content: "def get():\n    for _ in range(3):\n        pass\n    return 1\n", rationale: "Retry three times." });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.applied, false);
    assert.equal(receipt.status, "pending");
    assert.ok(receipt.added >= 1);
    assert.equal(await readFile(join(f.root, "fetch.py"), "utf8"), "def get():\n    return 1\n", "nothing was written");
    const patch = f.database.getPatch(receipt.patchId);
    assert.equal(patch.status, "pending");
    assert.match(patch.unifiedDiff, /range\(3\)/);
    // The run is the ordinary review record: it is in this workspace and shows up in the run list with its patch.
    f.agent.assertRunInWorkspace(patch.runId);
    const summary = f.database.listRuns().find(run => run.runId === patch.runId);
    assert.ok(summary, "the chat code run is listed");
    assert.match(summary.title, /retry to fetch\.py/i);
    assert.equal(f.database.listPatches(patch.runId).length, 1);
    // Applying still needs the human review path, and it works on this run.
    f.agent.assertPatchReadyForApproval(patch.id);
    const applied = await f.files.applyApprovedPatch(patch.id, patch.revision);
    assert.equal(applied.patch.status, "approved");
    assert.equal(applied.operation.state, "applied");
    assert.match(await readFile(join(f.root, "fetch.py"), "utf8"), /range\(3\)/);
    assert.ok(applied.checkpoint.id, "a checkpoint was recorded before the change");
  } finally { await f.cleanup(); }
});

test("one conversation shares one review run across proposals", async () => {
  const f = await fixture();
  try {
    const a = await f.run("code_propose_patch", { path: "a.py", content: "a = 1\n", rationale: "new" });
    const b = await f.run("code_propose_patch", { path: "b.py", content: "b = 1\n", rationale: "new" });
    assert.equal(f.database.getPatch(a.patchId).runId, f.database.getPatch(b.patchId).runId);
    assert.equal(a.created, true);
  } finally { await f.cleanup(); }
});

test("an existing file cannot be replaced unless this conversation read exactly its current content", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "x.py"), "x = 1\n");
    await assert.rejects(f.run("code_propose_patch", { path: "x.py", content: "x = 2\n", rationale: "r" }), /workspace_read before proposing/);
    await f.run("workspace_read", { path: "x.py" });
    await writeFile(join(f.root, "x.py"), "x = 99\n");
    await assert.rejects(f.run("code_propose_patch", { path: "x.py", content: "x = 2\n", rationale: "r" }), /changed after it was last read/);
    await f.run("workspace_read", { path: "x.py" });
    await assert.rejects(f.run("code_propose_patch", { path: "x.py", content: "x = 99\n", rationale: "r" }), /identical/);
    assert.equal(f.database.listRuns().length, 0, "refused proposals leave no review record");
    // A different conversation did not read it, so reading elsewhere does not unlock it.
    await assert.rejects(f.run("code_propose_patch", { path: "x.py", content: "x = 3\n", rationale: "r" }, { id: "8a1b2c3d-0000-4000-8000-000000000001" }), /workspace_read before proposing/);
  } finally { await f.cleanup(); }
});

test("protected locations, designs, other workflows and escapes are refused with no record", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "build"), { recursive: true });
    for (const path of [".git/config", "node_modules/pkg/index.js", "design.proto", "DESIGN.PROTO", "build/out.json", "sub/../.git/hooks/pre-commit", join(f.root, "build", "o.py")]) {
      await assert.rejects(f.run("code_propose_patch", { path, content: "x\n", rationale: "r" }), undefined, path);
    }
    await assert.rejects(f.run("code_propose_patch", { path: "../outside.py", content: "x\n", rationale: "r" }));
    await assert.rejects(f.run("code_propose_patch", { path: "ok.py", content: "x\n", rationale: "r" }, { workflow: "explore" }), /coding workflow only/);
    await assert.rejects(f.run("code_propose_patch", { path: "ok.py", content: "x".repeat(200_001), rationale: "r" }));
    await assert.rejects(f.run("code_propose_patch", { path: "ok.py", content: "x\n", rationale: "r", runId: "model-chosen" }), "extra keys are rejected");
    assert.equal(f.database.listRuns().length, 0);
  } finally { await f.cleanup(); }
});

test("a second proposal for a file with one already pending is refused rather than stacked", async () => {
  const f = await fixture();
  try {
    await f.run("code_propose_patch", { path: "n.py", content: "n = 1\n", rationale: "first" });
    await assert.rejects(f.run("code_propose_patch", { path: "n.py", content: "n = 2\n", rationale: "second" }), /already pending/);
  } finally { await f.cleanup(); }
});

test("path policy is separator and case insensitive", () => {
  assert.ok(codePatchPathProblem(".GIT\\config"));
  assert.ok(codePatchPathProblem("a/Node_Modules/b.js"));
  assert.ok(codePatchPathProblem("x/y.Proto"));
  assert.equal(codePatchPathProblem("src/app.py"), undefined);
});
