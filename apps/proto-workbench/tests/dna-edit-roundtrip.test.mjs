import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inverseDesignCommands } from "../src/shared/dna-edit-history.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const bridgeSource = String.raw`
import json, runpy, sys
from pathlib import Path
from proto_agent.compiler import compile_design_text
from proto_agent.design_edits import prepare_design_edit
request = json.load(sys.stdin)
fixture = runpy.run_path('tests/test_dna_placements.py')
source = request.get('source')
if source is None:
    # Existing toy IDs come from the repository's explicitly labelled fixture.
    source = fixture['SOURCE'].replace('  terminator B0015', '  # repeated toy resource, distinct occurrence\n  cds tetR instance=c2 orientation=reverse\n  terminator B0015')
    annotation = fixture['note'](direction=1)
    identifier = annotation.pop('id')
    source += '  annotation ' + identifier + ' ' + json.dumps(annotation) + '\n'
commands = request.get('commands', [])
result = prepare_design_edit(source, commands, parts_path=fixture['TOY_PARTS'], source_path='build/toy-roundtrip.proto', expected_source_sha256=request.get('expectedSourceSha256')) if commands else None
candidate = result['candidate_source'] if result and result['ok'] else source
ir, diagnostics = compile_design_text(candidate, fixture['TOY_PARTS'], source_path='build/toy-roundtrip.proto')
assert ir is not None, [item.to_dict() for item in diagnostics]
print(json.dumps({'source': source, 'result': result, 'ir': ir}))
`;
function bridge(request) {
  return JSON.parse(execFileSync(python, ["-c", bridgeSource], {cwd: repo, env: {...process.env, PYTHONPATH: join(repo, "src")},
    input: JSON.stringify(request), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024}));
}
function baseline(ir) {
  const construct = ir.constructs[0];
  return {construct: construct.name, order: construct.parts.map(part => part.instance_id),
    orientations: Object.fromEntries(construct.parts.map(part => [part.instance_id, part.placement.orientation])),
    annotations: construct.annotations.map(({id, name, type, anchors, origin}) => ({id, name, type, anchors, origin})),
  };
}

test("Node semantic undo and redo round-trip real Python placement, repeated resource and annotation compilation", {timeout: 20000}, () => {
  const original = bridge({});
  const annotation = {id: "note_02", name: "Toy multi-span review", type: "misc_feature", origin: "user", anchors: [
    {instance_id: "c2", start: 1, end: 4, direction: -1}, {instance_id: "p1", start: 0, end: 2, direction: 0},
  ]};
  const commands = [
    {type: "set_orientation", construct: "unit", instance_id: "c1", orientation: "reverse"},
    {type: "reorder_occurrences", construct: "unit", instance_ids: ["c2", "p1", "r1", "c1", "t1"]},
    {type: "upsert_annotation", construct: "unit", annotation: {...annotation, id: "note_01", name: "Toy replacement review"}},
    {type: "set_orientation", construct: "unit", instance_id: "c2", orientation: "forward"},
    {type: "delete_annotation", construct: "unit", annotation_id: "note_01"},
    {type: "upsert_annotation", construct: "unit", annotation},
  ];
  const inverses = inverseDesignCommands(commands, baseline(original.ir));
  const edited = bridge({source: original.source, commands});
  assert.equal(edited.result.ok, true, JSON.stringify(edited.result.diagnostics));
  assert.notEqual(edited.ir.constructs[0].sequence_sha256, original.ir.constructs[0].sequence_sha256);
  assert.equal(edited.ir.constructs[0].parts.filter(part => part.id === "tetR").length, 2);
  const restored = bridge({source: edited.result.candidate_source, commands: inverses, expectedSourceSha256: edited.result.candidate_sha256});
  assert.equal(restored.result.ok, true, JSON.stringify(restored.result.diagnostics));
  assert.deepEqual(restored.ir.constructs, original.ir.constructs);
  assert.match(restored.result.candidate_source, /# promoter occurrence comment\n  promoter pLac instance=p1 # local comment/);
  assert.match(restored.result.candidate_source, /# repeated toy resource, distinct occurrence\n  cds tetR instance=c2 orientation=reverse/);
  const redos = inverseDesignCommands(inverses, baseline(edited.ir));
  const redone = bridge({source: restored.result.candidate_source, commands: redos, expectedSourceSha256: restored.result.candidate_sha256});
  assert.equal(redone.result.ok, true, JSON.stringify(redone.result.diagnostics));
  assert.deepEqual(redone.ir.constructs, edited.ir.constructs);
  assert.equal(redone.ir.provenance.parts_sha256, original.ir.provenance.parts_sha256);
});

test("semantic undo still rejects stale source bytes at the Python transaction boundary", {timeout: 20000}, () => {
  const original = bridge({});
  const commands = [{type: "set_orientation", construct: "unit", instance_id: "c1", orientation: "reverse"}];
  const edited = bridge({source: original.source, commands});
  const inverse = inverseDesignCommands(commands, baseline(original.ir));
  const rejected = bridge({source: edited.result.candidate_source, commands: inverse, expectedSourceSha256: "0".repeat(64)});
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.diagnostics[0].code, "DNA_EDIT_REBASE_REQUIRED");
  assert.equal(rejected.result.candidate_source, edited.result.candidate_source);
  assert.deepEqual(rejected.ir.constructs, edited.ir.constructs);
});
