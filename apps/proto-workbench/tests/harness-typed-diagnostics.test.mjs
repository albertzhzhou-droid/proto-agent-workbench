import test from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {HarnessWorkspace} from "../src/main/services/harness-workspace.ts";
import {harnessDiagnostic, conflictingReceiptDiagnostics} from "../src/main/services/harness-diagnostics.ts";
import {verifyScientificArtifact} from "../src/main/services/harness-artifact-verification.ts";
import {verifyMissionDiagnostics, verifyMissionEvidence} from "../src/main/services/mission-evidence.ts";
import {toolContract} from "../src/shared/tool-contracts.ts";
import {proteinStructureFixture} from "./helpers/protein-structure-fixture.mjs";

const first = "1".repeat(64), second = "2".repeat(64), root = resolve("synthetic-diagnostics-fixture");
const receipt = (handle, data, tool = "workspace_propose_patch", ok = true) => ({handle, tool, ok, data});
const committed = (handle, operationId, sha256, revision = 1) => receipt(handle, {
  operation: {id: operationId, targetPath: "build/report.md", resultSha256: sha256, revision, state: "verified"},
  _harnessArtifacts: [{path: "build/report.md", sha256, sizeBytes: 5}],
});
function verifier(workspace, results, extra = {}, availableToolNames, checkpointOverrides = {}) {
  const byHandle = new Map(results.map(result => [result.handle, result]));
  const files = new HarnessWorkspace(workspace, {}, {}, {read: (_run, handle) => byHandle.get(handle)}, async () => [], () => {});
  const checkpoint = {createdAt: new Date().toISOString(), resultHandles: [...byHandle.keys()], ...checkpointOverrides, contract: {
    runId: "synthetic-diagnostic-run", workspacePath: root, goal: "Inspect a synthetic software fixture.",
    deliverables: [], evidenceRequirements: [], ...extra,
  }};
  return files.verify(checkpoint, "", availableToolNames);
}

test("workspace verifier retains permanent classes and exact original messages", async () => {
  const results = [receipt("saved", {_harnessArtifacts: [{path: "build/report.png", sha256: first}]})];
  const binary = await verifier({artifactFingerprint: async path => ({path, sha256: first, sizeBytes: 5, detectedFormat: "png"})}, results,
    {deliverables: [{path: "build/report.png", kind: "document"}]});
  assert.equal(binary.diagnostics.length, 1);
  assert.deepEqual(binary.diagnostics[0], {
    code: "RENDERER_RECEIPT_UNAVAILABLE", blockingClass: "unsupported", subject: "build/report.png", evidenceRefs: ["saved"],
    message: "Binary deliverable requires a trusted renderer/exporter receipt; this autonomous tool set cannot produce that receipt: build/report.png",
  });
  const unreadable = await verifier({artifactFingerprint: async () => {throw new Error("missing fixture");}}, results,
    {deliverables: [{path: "build/report.md", kind: "document"}]});
  assert.equal(unreadable.diagnostics[0].blockingClass, "stale");
  assert.equal(unreadable.diagnostics[0].message, "Cannot reopen build/report.md: Error: missing fixture");
  const stale = await verifier({read: async path => ({path, sha256: second})}, results,
    {materialBinding: {partsPath: "build/parts.json", partsSha256: first}});
  assert.equal(stale.diagnostics[0].blockingClass, "stale");
  assert.equal(stale.diagnostics[0].message, "The bound material snapshot changed or is unavailable.");
});

test("default diagnostics remain repairable while exact unread dependencies stay explicit", async () => {
  assert.equal(harnessDiagnostic("NEW_UNCLASSIFIED_CODE", "fixture", "Unchanged prose").blockingClass, "repairable");
  const result = await verifier({}, [receipt("read", {path: "different-input.txt"}, "workspace_read")], {requiredReads: ["input.txt"]});
  assert.deepEqual(result.diagnostics.map(({code, blockingClass, subject}) => ({code, blockingClass, subject})),
    [{code: "REQUIRED_INPUT_UNREAD", blockingClass: "dependency-missing", subject: "input.txt"}]);
});

test("scientific version and reopen diagnostics retain machine-readable permanent classes", async () => {
  const fingerprint = {path: "build/future.json", sha256: first};
  const results = [receipt("saved", {_harnessArtifacts: [fingerprint]})];
  const unsupported = await verifyScientificArtifact({read: async () => ({content: '{"schema_version":"proto-agent.run.v999"}'})}, fingerprint, results);
  assert.equal(unsupported[0].code, "UNSUPPORTED_VERSION");
  assert.equal(unsupported[0].blockingClass, "unsupported");
  assert.deepEqual(unsupported[0].evidenceRefs, ["saved"]);
  const unreadable = await verifyScientificArtifact({read: async () => {throw new Error("unreadable");}}, fingerprint, results);
  assert.equal(unreadable[0].code, "DELIVERABLE_UNREADABLE");
  assert.equal(unreadable[0].blockingClass, "stale");
});

test("typed mission diagnostics preserve the legacy display API without losing material conflicts", async () => {
  const material = hash => ({resource_id: "synthetic-record", sequence_sha256: hash});
  const results = [receipt("catalogue-a", {snapshot_id: "fixture", resource: material(first)}, "proto_materials_get"),
    receipt("catalogue-b", {snapshot_id: "fixture", resource: material(second)}, "proto_materials_get")];
  const contract = {goal: "Fixture metadata", deliverables: [], evidenceRequirements: [
    {kind: "materials", recordKind: "catalogue", fields: ["sequence_sha256"], minimumRecords: 1},
  ]};
  const typed = await verifyMissionDiagnostics(contract, results, {}, "synthetic-record");
  assert.deepEqual(typed.map(diagnostic => diagnostic.message), await verifyMissionEvidence(contract, results, {}, "synthetic-record"));
  assert.equal(typed.find(diagnostic => diagnostic.code === "MATERIAL_RECEIPT_CONFLICT").blockingClass, "conflicting");
  assert.ok(typed.every(diagnostic => diagnostic.evidenceRefs.length === 2));
});

test("conflicting committed receipts are deterministic and never resolved by recency", async () => {
  const results = [committed("earlier", "operation-a", first), committed("later", "operation-a", second, 2)];
  const diagnostics = conflictingReceiptDiagnostics(results, root);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].blockingClass, "conflicting");
  assert.deepEqual(diagnostics[0].evidenceRefs, ["earlier", "later"]);
  assert.deepEqual(conflictingReceiptDiagnostics([...results].reverse(), root), diagnostics);
  const verified = await verifier({}, results);
  assert.equal(verified.ok, false);
  assert.deepEqual(verified.diagnostics, diagnostics);
});

test("normal committed revisions and duplicate readbacks are not contradictory", () => {
  const initial = committed("initial", "operation-a", first);
  const next = committed("next", "operation-b", second);
  next.data.operation.baseSha256 = first;
  const readback = committed("readback", "operation-b", second, 9);
  next.data._harnessArtifacts.push({path: "build/derived.json", sha256: first, sizeBytes: 10});
  readback.data._harnessArtifacts.push({path: "build/derived.json", sha256: second, sizeBytes: 10});
  const failed = {...committed("failed", "operation-b", first), ok: false};
  assert.deepEqual(conflictingReceiptDiagnostics([initial, next, readback, failed], root), []);
});

test("immutable artifact sizes and version-bound material fields detect real contradictions", () => {
  const one = committed("size-a", "operation-a", first), two = committed("size-b", "operation-b", first);
  two.data._harnessArtifacts[0].sizeBytes = 6;
  assert.equal(conflictingReceiptDiagnostics([one, two], root)[0].blockingClass, "conflicting");
  const material = (handle, snapshot, hash, source = {provider: "fixture", release: "1"}) => receipt(handle,
    {snapshot_id: snapshot, resource: {resource_id: "fixture-record", sequence_sha256: hash, source}}, "proto_materials_get");
  const original = material("first", "snapshot-one", first);
  assert.deepEqual(conflictingReceiptDiagnostics([original, material("next", "snapshot-two", second)], root), []);
  assert.deepEqual(conflictingReceiptDiagnostics([original, material("same", "snapshot-one", first, {release: "1", provider: "fixture"})], root), []);
  assert.equal(conflictingReceiptDiagnostics([original, material("different", "snapshot-one", second)], root).length, 1);
});

test("structure attachment claims are compared only within the same input revision", () => {
  const structure = (handle, inputHash, contentHash) => receipt(handle,
    {_harnessInputs: {path: "build/fixture.ir.json", sha256: inputHash}, attachment: {id: "attachment-one", contentSha256: contentHash}}, "proto_structure_read");
  const firstVersion = structure("first", first, first);
  assert.deepEqual(conflictingReceiptDiagnostics([firstVersion, structure("next", second, second)], root), []);
  assert.equal(conflictingReceiptDiagnostics([firstVersion, structure("conflict", first, second)], root).length, 1);
});

test("remedies use actual producer inventory, authority and remaining caps", async () => {
  const workspace = {artifactFingerprint: async path => ({path, sha256: first, sizeBytes: 0})};
  const results = [receipt("read", {path: "input.txt"}, "workspace_read")];
  const contract = {deliverables: [{path: "build/report.md", kind: "document"}], mode: "act", scope: {writeRoots: ["build"], network: false, execution: false}};
  const verify = (extra = {}, names = ["workspace_propose_patch"], checkpoint) => verifier(workspace, results, {...contract, ...extra}, names, checkpoint);
  const repairable = await verify();
  assert.equal(repairable.diagnostics[0].blockingClass, "repairable");
  assert.equal(repairable.diagnostics[0].remedy.tool, "workspace_propose_patch");
  for (const blocked of [await verify({}, []), await verify({mode: "plan"}), await verify({scope: {...contract.scope, writeRoots: ["analyses"]}}),
    await verify({}, undefined, {toolCallCounts: {workspace_propose_patch: toolContract("workspace_propose_patch").maxCallsPerRun}})]) {
    assert.equal(blocked.diagnostics[0].blockingClass, "unsupported");
    assert.equal(blocked.diagnostics[0].remedy, undefined);
  }
  const unknownInventory = await verifier(workspace, results, contract);
  assert.equal(unknownInventory.diagnostics[0].blockingClass, "repairable", "A persisted discovery subset cannot prove tool absence");
});

test("compiler remedies respect actual protein lineage and material preconditions", async () => {
  const path = "build/fixture.ir.json", fixture = proteinStructureFixture();
  const workspace = {artifactFingerprint: async value => ({path: value, sha256: first, sizeBytes: fixture.text.length}), read: async value => ({path: value, content: fixture.text, sha256: first})};
  const results = [receipt("saved", {_harnessArtifacts: [{path, sha256: first}]})];
  const contract = {deliverables: [{path, kind: "document"}], mode: "act", scope: {writeRoots: ["build"], network: false, execution: false}};
  const repairable = await verifier(workspace, results, contract, ["proto_compile", "proto_protein_compile"]);
  assert.equal(repairable.diagnostics[0].remedy.tool, "proto_protein_compile");
  const unavailable = await verifier(workspace, results, contract, ["proto_compile"]);
  assert.equal(unavailable.diagnostics[0].blockingClass, "unsupported");
});

test("a permitted materialization prerequisite prevents false unsupported compilation", async () => {
  const path = "build/fixture.ir.json";
  const workspace = {artifactFingerprint: async value => ({path: value, sha256: first, sizeBytes: 16}), read: async value => ({path: value, content: '{"domain":"dna"}', sha256: first})};
  const results = [receipt("saved", {_harnessArtifacts: [{path, sha256: first}]})];
  const contract = {deliverables: [{path, kind: "document"}], mode: "act", scope: {writeRoots: ["build"], network: false, execution: false}};
  const names = ["proto_compile", "proto_materials_materialize"];
  const possible = await verifier(workspace, results, contract, names);
  assert.ok(possible.diagnostics.every(diagnostic => diagnostic.blockingClass === "repairable"));
  assert.ok(possible.diagnostics.every(diagnostic => diagnostic.remedy.tool === "proto_materials_materialize"));
  const unavailable = await verifier(workspace, results, contract, names, {toolCallCounts: {proto_materials_materialize: toolContract("proto_materials_materialize").maxCallsPerRun}});
  assert.ok(unavailable.diagnostics.every(diagnostic => diagnostic.blockingClass === "unsupported"));
});
