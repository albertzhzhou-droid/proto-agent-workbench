import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { HarnessController } from "../src/main/services/harness-controller.ts";
import { HarnessWorkspace, harnessToolEffect } from "../src/main/services/harness-workspace.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const python = process.env.PROTO_AGENT_PYTHON || join(REPO, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const definition = (name, properties, required = Object.keys(properties)) => ({type: "function", function: {name, description: name, parameters: {type: "object", properties, required, additionalProperties: false}}});
const read = path => ["workspace_read", {path}];
const write = (path, content = "# Model-authored result\n\nThe local fixture was inspected.\n") => ["workspace_propose_patch", {path, content, rationale: "Fulfill the original mission deliverable"}];
const finish = () => ["harness_finish", {summary: "The requested artifact is saved and verified."}];
const plan = (path = "build/result.md") => ["harness_plan", {deliverables: [{path, kind: "document"}]}];
const sha = value => createHash("sha256").update(value).digest("hex");

async function rig(t, turns, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "proto-harness-integration-"));
  await mkdir(join(root, "build"));
  await writeFile(join(root, "input.md"), "Controlled software test input; no scientific conclusion.\n");
  const databasePath = join(root, "state.sqlite");
  let database = new AppDatabase(databasePath);
  const mcp = new McpClient({packaged: false, resourcesPath: "", repoRoot: REPO, workspacePath: root,
    workspaceCapability: randomBytes(32).toString("hex"), materialsRoot: join(root, "isolated-materials"), pythonExecutable: python}, {startupTimeoutMs: 10000, controlTimeoutMs: 10000});
  t.after(async () => { await mcp.stop(); database.close(); await rm(root, {recursive: true, force: true}); });
  const scientificTools = (await mcp.tools()).map(tool => ({type: "function", function: {name: tool.name, description: tool.description, parameters: tool.inputSchema}}));
  const tools = [definition("workspace_read", {path: {type: "string"}}), definition("workspace_search", {query: {type: "string"}}),
    definition("workspace_propose_patch", {path: {type: "string"}, content: {type: "string"}, rationale: {type: "string"}}), ...scientificTools];
  const effects = [], patches = [], states = [];
  let store, files, workspace, controller;
  const rebuild = () => {
    store = new HarnessStore(database.db);
    workspace = new WorkspaceFiles(root, database);
    // The document path has no domain validator. DNA/protein scientific checks
    // below exercise the real Python sidecar directly instead of this callback.
    files = new HarnessWorkspace(workspace, database, mcp, store, async () => [], patch => patches.push(patch));
    controller = new HarnessController(store, {
      tools, binding: async () => ({modelId: "qwen3.8-27b@q4_k_m", instanceId: "mock-instance", contextLength: 32768, ownedByWorkbench: false, observedAt: new Date().toISOString()}),
      count: async () => ({tokens: 2048, method: "exact"}),
      chat: async (payload, onChunk, signal) => {
        signal.throwIfAborted(); payload._onQueueState?.("active");
        const turn = turns.shift();
        if (!turn) throw new Error("No additional model output was scripted");
        if (typeof turn === "function") return turn(payload, onChunk, signal);
        onChunk({usage: {completion_tokens: 20}, choices: [{finish_reason: "tool_calls", delta: {tool_calls: turn.map(([name, args], index) => ({index, function: {name, arguments: JSON.stringify(args)}}))}}]});
      },
      execute: async (...args) => {effects.push(args[0]); return files.execute(...args);},
      effect: harnessToolEffect, verify: c => files.verify(c), publish: c => states.push(c.state), delta() {},
    });
  };
  rebuild();
  const c = controller.create({schema: "proto-workbench.mission.v1", runId: "run-integration", threadId: "thread-integration", workspacePath: root,
    goal: "Read input.md and write build/result.md", modelId: "qwen3.8-27b@q4_k_m", mode: "act", contextTokens: 32768,
    scope: {writeRoots: ["build"], network: false, execution: false}, deliverables: [{path: "build/result.md", kind: "document"}], requiredReads: ["input.md"], requiresArtifacts: true,
    budgets: {activeTimeMs: 30000, maxRounds: 12, maxGeneratedTokens: 20000}, ...overrides}, "Execute only this controlled test mission. Do not invent evidence.");
  return {root, mcp, c, effects, patches, states, tools,
    get database() {return database;}, get store() {return store;}, get files() {return files;}, get workspace() {return workspace;}, get controller() {return controller;},
    reopen() { database.close(); database = new AppDatabase(databasePath); rebuild(); return store.get(c.contract.runId); },
  };
}

test("real database and filesystem commit a scoped model-authored artifact and retain receipts", async t => {
  const r = await rig(t, [[read("input.md")], [plan()], [write("build/result.md")], [finish()]]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed", JSON.stringify(r.c.error));
  assert.match(await readFile(join(r.root, "build/result.md"), "utf8"), /Model-authored/);
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].status, "approved");
  const receipt = r.c.resultHandles.map(h => r.store.read(r.c.contract.runId, h)).find(item => item.tool === "workspace_propose_patch");
  assert.equal(receipt.data.operation.state, "verified");
  assert.equal(receipt.data._harnessArtifacts[0].sha256, sha(await readFile(join(r.root, "build/result.md"))));
  assert.deepEqual((await r.files.verify(r.c)).diagnostics, []);
});

test("model cannot substitute an easier deliverable or silently skip a required read", async t => {
  const r = await rig(t, [[plan("build/other.md")], [write("build/other.md")], [finish()]]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "incomplete");
  const verified = await r.files.verify(r.c);
  assert.equal(verified.ok, false);
  assert.ok(verified.diagnostics.some(message => message.includes("input.md")));
  assert.ok(verified.diagnostics.some(message => message.includes("build/result.md")));
});

test("post-commit crash resumes from real durable result without applying a write twice", async t => {
  const r = await rig(t, [[read("input.md")], [finish()]]);
  const call = {id: "committed-before-checkpoint", type: "function", function: {name: "workspace_propose_patch", arguments: JSON.stringify(write("build/result.md")[1])}};
  r.c.pendingCalls = [call];
  r.c.messages.push({role: "assistant", content: "", tool_calls: [call]});
  r.store.save(r.c);
  r.store.intent(r.c.contract.runId, call.id, call.function.name, JSON.parse(call.function.arguments), "write");
  const result = await r.files.execute(call.function.name, JSON.parse(call.function.arguments), call.id, r.c, new AbortController().signal);
  r.store.record(r.c.contract.runId, call.id, call.function.name, result);
  assert.equal(r.patches.length, 1);
  const resumed = r.reopen();
  await r.controller.run(resumed, new AbortController().signal);
  assert.equal(resumed.state, "completed", JSON.stringify(resumed.error));
  assert.equal(r.patches.length, 1);
  assert.deepEqual(r.effects, ["workspace_read"]);
});

test("tampering with a committed deliverable invalidates completion evidence", async t => {
  const r = await rig(t, [[read("input.md")], [write("build/result.md")], [finish()]]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed");
  await writeFile(join(r.root, "build/result.md"), "Changed outside the mission transaction\n");
  const verified = await r.files.verify(r.c);
  assert.equal(verified.ok, false);
  assert.ok(verified.diagnostics.some(message => message.includes("matching committed artifact digest")));
});

test("real MCP schemas expose DNA preview and protein validation; absolute host paths normalize before Python", async t => {
  const r = await rig(t, []);
  const source = "# Toy development fixture only\n design preview_toy chassis ecoli_k12\nconstruct unit:\n  promoter pLac instance=p1\n  rbs B0034 instance=r1\n  cds tetR instance=c1\n  terminator B0015 instance=t1\n".replace("\n design", "\ndesign");
  await writeFile(join(r.root, "build/fixture.proto"), source);
  await copyFile(join(REPO, "parts/ecoli_k12_library.json"), join(r.root, "build/fixture-parts.json"));
  const parts = await r.workspace.read("build/fixture-parts.json");
  // This binding is test-only and explicit; production obtains it solely from governed materialization.
  r.c.contract.materialBinding = {partsPath: parts.path, partsSha256: parts.sha256};
  const preview = await r.files.execute("proto_design_edit", {path: join(r.root, "build/fixture.proto"), parts_path: parts.path,
    expected_source_sha256: sha(source), expected_parts_sha256: parts.sha256,
    commands: [{type: "set_orientation", construct: "unit", instance_id: "c1", orientation: "reverse"}]}, "preview", r.c, new AbortController().signal);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.match(preview.candidate_source, /instance=c1 orientation=reverse/);
  assert.equal(preview._harnessArguments.path, "build/fixture.proto");
  assert.equal(await readFile(join(r.root, "build/fixture.proto"), "utf8"), source);
  await writeFile(join(r.root, "build/invalid-protein.json"), "{}");
  const invalid = await r.files.execute("proto_protein_validate", {path: join(r.root, "build/invalid-protein.json")}, "protein-check", r.c, new AbortController().signal);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.domain, "protein");
  assert.deepEqual(invalid.artifacts, []);
});

test("the final allowed generation can execute its finish call and durable pending results can reconcile", async t => {
  const r = await rig(t, [[read("input.md")], [write("build/result.md")], [finish()]], {budgets: {activeTimeMs: 30000, maxRounds: 3, maxGeneratedTokens: 20000}});
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed", "Budget limits apply before the next generation, after pending tool effects have been reconciled");
  assert.equal(r.c.round, 3);
});

test("an existing target requires a read receipt and stale model reads cannot overwrite external edits", async t => {
  const r = await rig(t, []);
  await writeFile(join(r.root, "build/result.md"), "Original baseline\n");
  const signal = new AbortController().signal;
  const args = write("build/result.md")[1];
  const unread = await r.files.execute("workspace_propose_patch", args, "unread", r.c, signal);
  assert.equal(unread.code, "BASELINE_READ_REQUIRED");
  const readResult = await r.files.execute("workspace_read", {path: "build/result.md"}, "baseline", r.c, signal);
  const receipt = r.store.record(r.c.contract.runId, "baseline", "workspace_read", readResult);
  r.c.resultHandles.push(receipt.handle);
  await writeFile(join(r.root, "build/result.md"), "External concurrent edit\n");
  const stale = await r.files.execute("workspace_propose_patch", args, "stale", r.c, signal);
  assert.equal(stale.code, "BASELINE_CHANGED");
  assert.equal(await readFile(join(r.root, "build/result.md"), "utf8"), "External concurrent edit\n");
  assert.equal(r.patches.length, 0);
});

test("binary deliverables use exact byte fingerprints but cannot be forged through text tools", async t => {
  const r = await rig(t, [], {deliverables: [{path: "build/figure.png", kind: "document"}], requiredReads: []});
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(join(r.root, "build/figure.png"), bytes);
  const fingerprint = await r.workspace.artifactFingerprint("build/figure.png");
  assert.equal(fingerprint.sha256, sha(bytes));
  assert.equal(fingerprint.sizeBytes, bytes.length);
  const receipt = r.store.record(r.c.contract.runId, "export", "proto_export", {ok: true, artifacts: [fingerprint.path], _harnessArtifacts: [fingerprint]});
  r.c.resultHandles.push(receipt.handle);
  assert.equal(fingerprint.detectedFormat, "png");
  assert.match((await r.files.verify(r.c)).diagnostics.join("\n"), /trusted renderer\/exporter receipt/);
  bytes[9] = 42;
  await writeFile(join(r.root, "build/figure.png"), bytes);
  assert.match((await r.files.verify(r.c)).diagnostics.join("\n"), /matching committed artifact digest/);
  await writeFile(join(r.root, "build/figure.png"), Buffer.alloc(0));
  assert.match((await r.files.verify(r.c)).diagnostics.join("\n"), /Empty deliverable/);
  await writeFile(join(r.root, "build/figure.png"), "This is plain text with a .png suffix.");
  assert.match((await r.files.verify(r.c)).diagnostics.join("\n"), /not a structurally valid PNG/);
});
