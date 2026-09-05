import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, rm, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AppDatabase} from "../src/main/services/database.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {executeHarnessStructureTool, HARNESS_STRUCTURE_TOOLS} from "../src/main/services/harness-structure-tools.ts";
import {ProteinStructureService} from "../src/main/services/protein-structures.ts";
import {proteinStructureFixture, PDB_FIXTURE} from "./helpers/protein-structure-fixture.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
async function rig(t) {
  const root = await mkdtemp(join(tmpdir(), "proto-harness-structure-"));
  const fixture = proteinStructureFixture();
  await writeFile(join(root, fixture.target.artifactPath), fixture.text);
  await writeFile(join(root, "coordinates.pdb"), PDB_FIXTURE);
  const database = new AppDatabase(join(root, "state.sqlite"));
  const workspace = new WorkspaceFiles(root, database);
  t.after(async () => {database.close(); await rm(root, {recursive: true, force: true});});
  const args = {ir_path: fixture.target.artifactPath, protein_id: fixture.target.proteinId, expected_artifact_sha256: fixture.target.artifactSha256};
  const call = (name, extra = {}) => executeHarnessStructureTool(name, {...args, ...extra}, workspace, root, new AbortController().signal);
  return {root, workspace, fixture, args, call};
}

test("structure discovery exposes bounded schemas without a model-supplied image upload", () => {
  assert.equal(HARNESS_STRUCTURE_TOOLS.length, 6);
  assert.ok(HARNESS_STRUCTURE_TOOLS.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal(HARNESS_STRUCTURE_TOOLS.some(tool => /image|png/i.test(tool.name)), false);
});

test("verified protein inspection and empty structure listing create no directories", async t => {
  const r = await rig(t), before = await readdir(r.root);
  const inspected = await r.call("proto_protein_inspect");
  assert.equal(inspected.artifact_sha256, r.fixture.target.artifactSha256);
  assert.equal(inspected.proteins[0].sequence_sha256, r.fixture.target.sequenceSha256);
  assert.equal("sequence" in inspected.proteins[0], false);
  const listed = await r.call("proto_structure_list");
  assert.deepEqual(listed.attachments, []);
  assert.equal(listed.mapping_status, "unverified");
  assert.deepEqual(await readdir(r.root), before);
});

test("workspace coordinate imports preserve exact source identity and expose bounded pages", async t => {
  const r = await rig(t);
  const imported = await r.call("proto_structure_import_workspace", {path: "coordinates.pdb", expected_source_sha256: sha(PDB_FIXTURE)});
  assert.equal(imported.ok, true);
  assert.equal(imported.attachment.source.provider, "local");
  assert.equal(imported.attachment.source.license, "NOASSERTION");
  assert.equal(imported.mapping_status, "unverified");
  assert.equal(imported.artifacts.length, 2);
  for (const path of imported.artifacts) assert.ok((await r.workspace.artifactFingerprint(path)).sizeBytes > 0);
  const page = await r.call("proto_structure_read", {attachment_id: imported.attachment.id, offset: 0, limit: 30});
  assert.equal(page.content, PDB_FIXTURE.slice(0, 30));
  assert.equal(page.next_offset, 30);
  const next = await r.call("proto_structure_read", {attachment_id: imported.attachment.id, offset: page.next_offset, limit: 30});
  assert.equal(next.content, PDB_FIXTURE.slice(30, 60));
});

test("stale IR and coordinate hashes cannot produce attachments", async t => {
  const r = await rig(t);
  assert.equal((await r.call("proto_structure_list", {expected_artifact_sha256: "0".repeat(64)})).code, "PROTEIN_IR_CHANGED");
  await assert.rejects(r.call("proto_structure_import_workspace", {path: "coordinates.pdb", expected_source_sha256: "0".repeat(64)}), /changed/);
  assert.deepEqual((await r.call("proto_structure_list")).attachments, []);
  await assert.rejects(r.call("proto_structure_import_workspace", {path: "../outside.pdb", expected_source_sha256: sha(PDB_FIXTURE)}), /workspace/i);
});

test("task cancellation reaches a structure network request and no attachment is written", async t => {
  const r = await rig(t), controller = new AbortController(); let started;
  const ready = new Promise(resolve => {started = resolve;});
  const service = new ProteinStructureService(r.root, {signal: controller.signal, fetch: async (_url, init) => {
    started(); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), {once: true}));
  }});
  const request = service.fetch({target: r.fixture.target, provider: "pdb", accession: "1ABC"});
  await ready; controller.abort(new Error("Controlled mission cancellation"));
  await assert.rejects(request, /Controlled mission cancellation/);
  assert.deepEqual((await r.call("proto_structure_list")).attachments, []);
});
