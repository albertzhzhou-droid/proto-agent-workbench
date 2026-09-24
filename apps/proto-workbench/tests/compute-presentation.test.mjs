import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import fixture from "../src/renderer/compute-preview.json" with {type: "json"};
import { fieldsFor, requestArguments, categoryFor, domainTitles, toolMatches, resultTables, resultSeries, ComputeInputError } from "../src/renderer/compute-presentation.ts";
import { previewCompute } from "../src/renderer/compute-preview.ts";
import { validateIpcArguments } from "../src/main/ipc-security.ts";
import { IPC } from "../src/shared/ipc.ts";
import {computeInputsChanged} from "../src/renderer/compute-presentation.ts";

test("result input comparison ignores JSON formatting and detects actual edits or invalid drafts",()=>{
  const tool=fixture.catalog.tools.find(t=>t.id==='normalize_gene_expression_counts');
  const fields=fieldsFor(tool);
  fields.counts=JSON.stringify(tool.example.counts);
  assert.equal(computeInputsChanged(tool,fields,tool.example),false);
  fields.counts='[[1,2],[3,4]]';assert.equal(computeInputsChanged(tool,fields,tool.example),true);
  fields.counts='[';assert.equal(computeInputsChanged(tool,fields,tool.example),true);
});

test("every registered method reaches a collection, form, IPC and recorded result without input drift", async () => {
  const groups = new Set();
  for (const tool of fixture.catalog.tools) {
    assert.ok(tool.category, tool.id);
    assert.ok(domainTitles[categoryFor(tool).section], tool.id);
    groups.add(categoryFor(tool).id);
    const args = requestArguments(tool, fieldsFor(tool));
    assert.deepEqual(args, tool.example, tool.id);
    validateIpcArguments(IPC.computeCatalog, [tool.id]);
    validateIpcArguments(IPC.computeRun, [{tool: tool.id, arguments: args}]);
    const run = await previewCompute.run({tool: tool.id, arguments: args});
    assert.ok(run.result && Object.keys(run.result).length, tool.id);
    assert.doesNotThrow(() => {resultTables(run.result); resultSeries(run.result);}, tool.id);
    assert.ok(toolMatches(tool, tool.id), tool.id);
  }
  assert.equal(groups.size, 19);
});

test("recorded UI catalog stays aligned with the live Python registry and file contracts", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const script = "import json; from proto_agent.compute import compute_catalog; print(json.dumps([compute_catalog(t['id'])['tools'][0] for t in compute_catalog()['tools']]))";
  const catalog = JSON.parse(execFileSync(join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), ["-c", script], {cwd:repo, encoding:"utf8", maxBuffer: 4*1024*1024, windowsHide:true}));
  assert.deepEqual(fixture.catalog.tools.map(t => t.id).sort(), catalog.map(t => t.id).sort());
  for (const tool of catalog) {
    const preview = fixture.catalog.tools.find(t => t.id === tool.id);
    // Historical replay inputs can intentionally differ from registry defaults;
    // scientific metadata and schemas must still track the authoritative source.
    const metadata = entry => Object.fromEntries(Object.entries(entry).filter(([key]) =>
      !["example", "available", "missing_dependencies"].includes(key)));
    assert.deepEqual(metadata(preview), metadata(tool), tool.id);
  }
});

test("recorded research examples retain uncertainty, mapping and tree evidence", () => {
  assert.match(fixture.recording.notice, /Synthetic software examples/);
  const comparison = fixture.results.compare_two_groups;
  assert.equal(comparison.confidence_interval.status, "available");
  assert.ok(comparison.confidence_interval.lower <= comparison.mean_difference);
  assert.ok(comparison.confidence_interval.upper >= comparison.mean_difference);
  const structure = fixture.results.compare_protein_structures;
  assert.equal(structure.method_version, "pdb-ca-sequence-kabsch.v2");
  assert.equal(structure.chain_a, "A");
  assert.equal(structure.mapping.fitted_residue_pairs, structure.common_residues);
  assert.ok(structure.per_residue.every(row => row.residue_a && row.residue_b));
  const phylogeny = fixture.results.analyze_protein_phylogeny;
  const names = fixture.catalog.tools.find(tool => tool.id === "analyze_protein_phylogeny").example.aligned_sequences.map(row => row.name);
  assert.deepEqual(phylogeny.tree_graph.nodes.filter(node => node.name !== null).map(node => node.name).sort(), names.sort());
  const study = fixture.results.analyze_protein_comparison;
  assert.equal(study.sequence_count, 3);
  assert.ok(study.phylogeny.tree_graph.edges.length > 0);
  assert.ok(study.alignment.every(row => /^[a-f0-9]{64}$/.test(row.sequence_sha256)));
});

test("nested fields, integer bounds, missing values and invalid paths identify the field to fix", () => {
  const get = id => fixture.catalog.tools.find(t => t.id === id);
  for (const [id, field, raw] of [
    ["principal_component_analysis", "n_components", "1.2"],
    ["descriptive_statistics", "values", "[]"],
    ["descriptive_statistics", "values", "[1, true]"],
    ["descriptive_statistics", "values", "[1e999]"],
    ["descriptive_statistics", "values", ""],
    ["simulate_whole_cell_ode_model", "rates", '{"unrecognized":2}'],
    ["batch_register_images", "moving_image_paths", "../outside.nii.gz"],
    ["batch_register_images", "moving_image_paths", "C:\\outside.nii.gz"],
    ["batch_register_images", "moving_image_paths", "data/wrong.exe"],
  ]) {
    const tool = get(id);
    assert.throws(() => requestArguments(tool, {...fieldsFor(tool), [field]:raw}), e => e instanceof ComputeInputError && e.field === field, id);
  }
  const batch = get("batch_register_images");
  const paths = ["data/first.nii.gz", "data/second.nii.gz"];
  assert.deepEqual(requestArguments(batch, {...fieldsFor(batch), moving_image_paths:paths.join("\n")}).moving_image_paths, paths);
  assert.deepEqual(requestArguments(batch, {...fieldsFor(batch), moving_image_paths:JSON.stringify(paths)}).moving_image_paths, paths);
  for (const bad of ["../run", "unsafe/path", "tool;run", "tool-name", "0tool"]) assert.throws(() => validateIpcArguments(IPC.computeCatalog, [bad]));
});

test("result views keep source values, bound tables and only plot explicit time series", () => {
  const result = {times:[0, 2, 3], x:[1, 3, 5], unrelated:[90, 4], tracks:Array.from({length:80}, (_,i) => ({id:i, value:i/3, nested:{a:1}}))};
  const original = structuredClone(result);
  const [table] = resultTables(result);
  assert.equal(table.total, 80); assert.equal(table.rows.length, 50);
  assert.deepEqual(table.columns, ["id", "value"]);
  assert.deepEqual(resultSeries(result), {times:[0,2,3], series:[["x",[1,3,5]]]});
  assert.equal(resultSeries({values:[1,2,3]}), undefined);
  assert.deepEqual(result, original);
});
