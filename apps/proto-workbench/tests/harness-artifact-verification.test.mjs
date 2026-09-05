import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {verifyScientificArtifact} from "../src/main/services/harness-artifact-verification.ts";
import {proteinStructureFixture} from "./helpers/protein-structure-fixture.mjs";

const sha = text => createHash("sha256").update(text).digest("hex");
const receipt = (tool, data) => ({tool, ok: true, data});
function rig(entries) {
  const files = new Map(Object.entries(entries));
  const fingerprint = path => ({path, sha256: sha(files.get(path)), sizeBytes: Buffer.byteLength(files.get(path))});
  return {files, fingerprint, workspace: {read: async path => ({...fingerprint(path), content: files.get(path)}), artifactFingerprint: async path => fingerprint(path)}};
}

test("valid-looking IR written as a generic document cannot replace a compiler receipt", async () => {
  const fixture = proteinStructureFixture(), r = rig({"build/result.ir.json": fixture.text, "build/selection.json": "controlled selection"});
  const file = r.fingerprint("build/result.ir.json");
  const forged = receipt("workspace_propose_patch", {_harnessArtifacts: [file], validation: {ok: true, steps: []}});
  assert.match((await verifyScientificArtifact(r.workspace, file, [forged])).join("\n"), /compiler\/workflow receipt/);
  const compiled = receipt("proto_protein_compile", {_harnessArtifacts: [file], _harnessInputs: r.fingerprint("build/selection.json")});
  assert.deepEqual(await verifyScientificArtifact(r.workspace, file, [compiled]), []);
  r.files.set(file.path, '{"schema_version":"proto-agent.ir.v1","domain":"protein"}');
  const invalid = r.fingerprint(file.path);
  assert.match((await verifyScientificArtifact(r.workspace, invalid, [receipt("proto_protein_compile", {_harnessArtifacts: [invalid]})])).join("\n"), /schema, sequence or digest/);
});

test("FASTA requires a current compiled input and its exact exported sequence", async () => {
  const fixture = proteinStructureFixture();
  const r = rig({"build/protein.ir.json": fixture.text, "build/protein.fasta": ">controlled-fixture\nAGC\n", "build/selection.json": "controlled selection"});
  const ir = r.fingerprint("build/protein.ir.json"), file = r.fingerprint("build/protein.fasta");
  const compiled = receipt("proto_protein_compile", {_harnessArtifacts: [ir], _harnessInputs: r.fingerprint("build/selection.json")});
  const exported = receipt("proto_export", {_harnessArtifacts: [file], _harnessInputs: ir, _harnessArguments: {format: "fasta"}});
  assert.deepEqual(await verifyScientificArtifact(r.workspace, file, [compiled, exported]), []);
  assert.match((await verifyScientificArtifact(r.workspace, file, [receipt("workspace_propose_patch", {_harnessArtifacts: [file]})])).join("\n"), /compiler\/export lineage/);
  r.files.set(file.path, ">controlled-fixture\nAAA\n");
  const wrong = r.fingerprint(file.path);
  assert.match((await verifyScientificArtifact(r.workspace, wrong, [compiled, receipt("proto_export", {...exported.data, _harnessArtifacts: [wrong]})])).join("\n"), /matching sequence/);
  r.files.set(ir.path, fixture.text + " ");
  assert.match((await verifyScientificArtifact(r.workspace, file, [compiled, exported])).join("\n"), /current compiler\/export lineage/);
});

test("coordinate suffixes and protein selection schemas enforce their trusted producers", async () => {
  const r = rig({"build/coordinates.pdb": "ATOM  unverified text", "build/selection.json": '{"schema_version":"proto-agent.protein-selection.v1"}'});
  for (const path of r.files.keys()) {
    const file = r.fingerprint(path);
    assert.ok((await verifyScientificArtifact(r.workspace, file, [receipt("workspace_propose_patch", {_harnessArtifacts: [file]})])).length > 0);
  }
});
