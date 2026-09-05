import test from "node:test";
import assert from "node:assert/strict";
import {deriveMissionEvidence, verifyMissionEvidence} from "../src/main/services/mission-evidence.ts";
import {materialEvidenceRecords} from "../src/main/services/mission-material-contract.ts";

const receipt = (tool, data = {}) => ({tool, ok: true, data});
const contract = (goal, deliverables = []) => ({goal, deliverables, evidenceRequirements: deriveMissionEvidence(goal)});
const workspace = {artifactFingerprint: async path => ({path, sha256: "current"}), read: async path => ({path, sha256: "current", content: "An ungrounded report exists."})};
const article = index => ({pmid: String(10000 + index), doi: `10.1234/paper${index}`});

test("general domain intent binds provider and requested counts without fixture routing", () => {
  assert.deepEqual(deriveMissionEvidence("Find 3 PubMed papers and cite their identifiers."), [{kind: "literature", providers: ["pubmed"], minimumRecords: 3, live: false, countPublicationsOnly: true}]);
  assert.equal(deriveMissionEvidence("查找三篇文献并总结")[0].minimumRecords, 3);
  assert.equal(deriveMissionEvidence("Find three current Crossref publications")[0].live, true);
  assert.deepEqual(deriveMissionEvidence("Create a plain task summary. Do not fetch structures."), []);
  assert.equal(deriveMissionEvidence("Find literature about chromophore structure").some(item => item.kind === "structure"), false);
  assert.deepEqual(deriveMissionEvidence("Fetch official protein coordinates"), [{kind: "structure", official: true}]);
});

test("empty workspace search and nonempty Markdown cannot complete literature tasks", async () => {
  const c = contract("Find 3 PubMed papers and create build/report.md", [{path: "build/report.md", kind: "document"}]);
  const results = [receipt("workspace_search", {matches: []}), receipt("workspace_propose_patch", {_harnessArtifacts: [{path: "build/report.md", sha256: "current"}]})];
  const errors = await verifyMissionEvidence(c, results, workspace);
  assert.ok(errors.some(error => error.includes("pubmed")));
  assert.ok(errors.some(error => error.includes("3 distinct")));
  assert.ok(errors.some(error => error.includes("cite at least 3")));
});

test("requested live providers, unique publication count and citation identities are checked", async () => {
  const c = contract("Find three live PubMed papers and Crossref metadata");
  const results = [receipt("proto_pubmed_search", {mode: "network", matches: [article(1), article(2), article(3)]}), receipt("proto_crossref_search", {mode: "network", matches: [article(1)]})];
  assert.deepEqual(await verifyMissionEvidence(c, results, workspace, "PMID:10001 PMID:10002 [Third](https://doi.org/10.1234/paper3)"), []);
  assert.ok((await verifyMissionEvidence(c, results, workspace, "PMID:10001 PMID:10002 PMID:10003 DOI:10.9999/invented")).some(error => error.includes("not returned")));
  assert.ok((await verifyMissionEvidence(c, results.slice(0, 1), workspace, "PMID:10001 PMID:10002 PMID:10003")).some(error => error.includes("crossref")));
  const cached = results.map(result => ({...result, data: {...result.data, mode: "cache"}}));
  assert.ok((await verifyMissionEvidence(c, cached, workspace, "PMID:10001 PMID:10002 PMID:10003")).some(error => error.includes("live network")));
  const duplicate = [receipt("proto_pubmed_search", {mode: "network", matches: [article(1), article(1), article(1)]})];
  assert.ok((await verifyMissionEvidence(c, duplicate, workspace, "PMID:10001")).some(error => error.includes("1 are available")));
});

test("a correct literature completion summary cannot supply missing or wrong citations in a saved report", async () => {
  const c = contract("Find 3 live PubMed papers and create build/report.md", [{path: "build/report.md", kind: "document"}]);
  const good = "PMID:10001 PMID:10002 DOI:10.1234/paper3";
  const results = [receipt("proto_pubmed_search", {mode: "network", matches: [article(1), article(2), article(3)]}), receipt("workspace_propose_patch", {_harnessArtifacts: [{path: "build/report.md", sha256: "current"}]})];
  const fs = content => ({...workspace, read: async path => ({path, sha256: "current", content})});
  assert.ok((await verifyMissionEvidence(c, results, fs("The report has no publication identifiers."), good)).some(error => error.includes("saved report must cite at least 3")));
  assert.ok((await verifyMissionEvidence(c, results, fs("PMID:10001 PMID:10002 DOI:10.9999/invented"), good)).some(error => error.includes("not returned")));
  assert.ok((await verifyMissionEvidence(c, results.slice(0, 1), fs(good), good)).length > 0);
  assert.deepEqual(await verifyMissionEvidence(c, results, fs(good), "Done."), []);
});

test("structure completion binds current source and exact coordinate readback", async () => {
  const c = contract("Associate an official PDB structure and create a report");
  const data = {_harnessInputs: {path: "protein.ir.json", sha256: "current"}, _harnessArtifacts: [{path: "structure.cif", sha256: "current"}, {path: "structure.json", sha256: "current"}], attachment: {id: "attachment", contentSha256: "current", source: {provider: "pdb"}}};
  const fetched = receipt("proto_structure_fetch", data), read = receipt("proto_structure_read", data);
  assert.deepEqual(await verifyMissionEvidence(c, [fetched, read], workspace), []);
  assert.ok((await verifyMissionEvidence(c, [fetched], workspace)).length);
  assert.ok((await verifyMissionEvidence(c, [fetched, read], {...workspace, artifactFingerprint: async path => ({path, sha256: "changed"})})).length);
  assert.ok((await verifyMissionEvidence(c, [fetched, {...read, data: {...data, attachment: {...data.attachment, id: "other"}}}], workspace)).length);
});

test("Crossref supplementary components cannot satisfy a requested paper count",async()=>{
  const c=contract("Find 3 Crossref papers");
  const results=[receipt("proto_crossref_search",{matches:[1,2,3].map(index=>({source_id:`DOI:10.1234/component${index}`,work_type:"component"}))})];
  assert.ok((await verifyMissionEvidence(c,results,workspace,"DOI:10.1234/component1 DOI:10.1234/component2 DOI:10.1234/component3")).some(error=>error.includes("0 are available")));
});

test("provenance and review require current actual receipts including recovered validation", async () => {
  const c = contract("Perform check/workflow/provenance/review");
  const data = {validation: {source: "design.proto", sha256: "current", ok: true, steps: ["proto_workflow_run", "proto_provenance_verify", "proto_review_packet"].map(tool => ({tool, status: "completed"}))}, _harnessArtifacts: [{path: "design.proto", sha256: "current"}, {path: "manifest.json", sha256: "current"}]};
  assert.deepEqual(await verifyMissionEvidence(c, [receipt("workspace_resume_validation", data)], workspace), []);
  assert.deepEqual(await verifyMissionEvidence(c, [receipt("workspace_resume_validation", {...data, _harnessArtifacts: data._harnessArtifacts.slice(0, 1), _harnessRecoveredProvenance: {path: "provenance.json", sha256: "current"}})], workspace), []);
  assert.ok((await verifyMissionEvidence(c, [receipt("workspace_resume_validation", {...data, _harnessArtifacts: data._harnessArtifacts.slice(0, 1), _harnessRecoveredProvenance: {path: "provenance.json", sha256: "stale"}})], workspace)).length >= 3);
  assert.ok((await verifyMissionEvidence(c, [receipt("workspace_propose_patch", {_harnessArtifacts: data._harnessArtifacts})], workspace)).length >= 3);
  assert.ok((await verifyMissionEvidence(c, [receipt("workspace_resume_validation", data)], {...workspace, artifactFingerprint: async path => ({path, sha256: "changed"})})).length >= 3);
});

const materialRecord = index => ({resource_id: `catalog:record-${index}`, sequence_sha256: String(index).repeat(64), sequence_length: index * 10,
  source: {provider: "Reviewed catalogue", record_id: `record-${index}`, url: `https://catalog.example/record-${index}`}, license: {id: `License-${index}`}});
const materialReport = records => JSON.stringify(records.map(record => ({resource_id: record.resource_id, sequence_sha256: record.sequence_sha256, source: record.source, license: record.license})));

test("material reporting obligations bind counts and exact requested fields without scientific-topic routing", () => {
  assert.deepEqual(deriveMissionEvidence("Search a materials catalogue. Record three distinct exact resource IDs, sequence hashes, source and rights fields."),
    [{kind: "materials", minimumRecords: 3, fields: ["sequence_sha256", "source", "license"], recordKind: "catalogue"}]);
  assert.deepEqual(deriveMissionEvidence("查找材料，记录三个资源的序列哈希、来源和许可。"),
    [{kind: "materials", minimumRecords: 3, fields: ["sequence_sha256", "source", "license"], recordKind: "catalogue"}]);
  assert.equal(deriveMissionEvidence("Search PubMed literature about green fluorescent protein. Create a report citing identifiers and source links.").some(item => item.kind === "materials"), false);
  assert.equal(deriveMissionEvidence("Search materials and create a DNA design. Preserve source identities. Create a report of validation gaps.").some(item => item.kind === "materials"), false);
  assert.deepEqual(deriveMissionEvidence("Search materials. Do not record sequence hashes or source fields. Create a plain summary."), []);
  const protein = deriveMissionEvidence("Inspect protein IR with proto_protein_inspect. Create a summary with one record for each exact protein ID, length and sequence_sha256. Create a table mapping each ID to its source and license.")[0];
  assert.deepEqual(protein, {kind: "materials", minimumRecords: 1, fields: ["sequence_sha256", "source", "license", "length"], recordKind: "protein", allReturnedRecords: true});
});

test("only saved current report bytes can satisfy a material artifact contract", async () => {
  const records = [materialRecord(1), materialRecord(2), materialRecord(3)];
  const c = contract("Record three exact resource IDs, sequence hashes, source and license in a report", [{path: "build/report.json", kind: "document"}]);
  const valid = materialReport(records), truncated = valid.replace(records[0].sequence_sha256, records[0].sequence_sha256.slice(2));
  const results = [receipt("proto_materials_search", {matches: records}), receipt("workspace_propose_patch", {_harnessArtifacts: [{path: "build/report.json", sha256: "current"}]})];
  const fs = text => ({...workspace, read: async path => ({path, sha256: "current", content: text})});
  assert.ok((await verifyMissionEvidence(c, results, fs(truncated), valid)).some(error => error.includes("MATERIAL_HASH_MISMATCH")));
  assert.deepEqual(await verifyMissionEvidence(c, results, fs(valid)), []);
  assert.ok((await verifyMissionEvidence(c, results.slice(0, 1), fs(valid), valid)).some(error => error.includes("MATERIAL_REPORT_REQUIRED")));
  assert.ok((await verifyMissionEvidence(c, results, {...fs(valid), read: async path => ({path, sha256: "changed", content: valid})}, valid)).some(error => error.includes("MATERIAL_REPORT_REQUIRED")));
  // Current bytes containing arbitrary model-authored records cannot become receipts.
  assert.ok((await verifyMissionEvidence(c, results.slice(1), fs(valid), valid)).some(error => error.includes("MATERIAL_RECORD_COUNT")));
});

test("protein metadata uses output-facing IDs, all inspected records, and current input binding", async () => {
  const proteins = [1, 2].map(index => ({...materialRecord(index), id: `protein_${index}`, length: index * 10}));
  const c = contract("Inspect protein IR with proto_protein_inspect. Create a summary for every protein ID, length and sequence_sha256.", [{path: "build/protein-summary.json", kind: "document"}]);
  assert.deepEqual(materialEvidenceRecords([receipt("proto_protein_inspect", {proteins})], c.evidenceRequirements[0]).map(row => row.resourceId), ["protein_1", "protein_2"]);
  const results = [receipt("proto_protein_inspect", {proteins, _harnessInputs: {path: "build/input.ir.json", sha256: "current"}}), receipt("workspace_propose_patch", {_harnessArtifacts: [{path: "build/protein-summary.json", sha256: "current"}]})];
  const fs = rows => ({...workspace, read: async path => ({path, sha256: "current", content: JSON.stringify(rows.map(row => ({id: row.id, length: row.length, sequence_sha256: row.sequence_sha256})))})});
  assert.deepEqual(await verifyMissionEvidence(c, results, fs(proteins)), []);
  assert.ok((await verifyMissionEvidence(c, results, fs(proteins.slice(0, 1)))).some(error => error.includes("2 distinct")));
  assert.ok((await verifyMissionEvidence(c, results, {...fs(proteins), artifactFingerprint: async path => ({path, sha256: "stale"})})).length > 0);
});

test("named protein reports keep their own field obligations across filename dots", async () => {
  const goal = "Inspect its protein IR with proto_protein_inspect. Create build/protein-summary.json with one record for each exact protein ID, length and sequence_sha256. Create build/evidence-table.md mapping each ID to its source and license.";
  const requirement = deriveMissionEvidence(goal)[0];
  assert.deepEqual(requirement.reports, [{paths: ["build/protein-summary.json"], fields: ["sequence_sha256", "length"]}, {paths: ["build/evidence-table.md"], fields: ["source", "license"]}]);
  const protein = {...materialRecord(1), id: "protein_1", length: 10};
  const c = contract(goal, requirement.reports.flatMap(report => report.paths.map(path => ({path, kind: "document"}))));
  const results = [receipt("proto_protein_inspect", {proteins: [protein], _harnessInputs: {path: "build/input.ir.json", sha256: "current"}}), receipt("workspace_propose_patch", {_harnessArtifacts: c.deliverables.map(item => ({path: item.path, sha256: "current"}))})];
  const complete = JSON.stringify([{id: protein.id, length: protein.length, sequence_sha256: protein.sequence_sha256, source: protein.source, license: protein.license}]);
  const fs = summary => ({...workspace, read: async path => ({path, sha256: "current", content: path.endsWith(".json") ? summary : complete})});
  assert.ok((await verifyMissionEvidence(c, results, fs("{}"), complete)).some(error => error.includes("build/protein-summary.json") && error.includes("MATERIAL_RECORD_COUNT")));
  assert.deepEqual(await verifyMissionEvidence(c, results, fs(complete)), []);
});

test("requested source fields are dynamic literals from current reads, scoped to their saved report", async () => {
  const goal = "Read inputs/origin.json. Create build/trace.md and copy its exact Trace key.";
  const c = contract(goal, [{path: "build/trace.md", kind: "document"}]);
  assert.deepEqual(c.evidenceRequirements, [{kind: "source-field", field: "Trace key", sourcePaths: ["inputs/origin.json"], reportPaths: ["build/trace.md"]}]);
  assert.deepEqual(deriveMissionEvidence("Read inputs/origin.json and create build/trace.md with its exact Trace key, then list uncertainties."), c.evidenceRequirements);
  const results = [receipt("workspace_read", {path: "inputs/origin.json", sha256: "current", content: JSON.stringify({trace_key: "Literal-AbC-731"})}), receipt("workspace_propose_patch", {_harnessArtifacts: [{path: "build/trace.md", sha256: "current"}]})];
  const fs = content => ({...workspace, read: async path => ({path, sha256: "current", content})});
  assert.ok((await verifyMissionEvidence(c, results, fs("Trace key: Literal-AbC-73"), "Literal-AbC-731")).some(error => error.includes("SOURCE_FIELD_MISMATCH")));
  assert.ok((await verifyMissionEvidence(c, results, fs("Trace key: Literal-AbC-7310"))).some(error => error.includes("SOURCE_FIELD_MISMATCH")));
  assert.ok((await verifyMissionEvidence(c, results, fs("**Trace key**: Literal-abc-731\nUnrelated example: Literal-AbC-731"))).some(error => error.includes("SOURCE_FIELD_MISMATCH")));
  assert.deepEqual(await verifyMissionEvidence(c, results, fs("Trace key: Literal-AbC-731")), []);
  assert.ok((await verifyMissionEvidence(c, results, {...fs("Literal-AbC-731"), artifactFingerprint: async path => ({path, sha256: "stale"})})).some(error => error.includes("SOURCE_FIELD_UNBOUND")));
  const ambiguous = [{...results[0], data: {...results[0].data, content: "Trace key: first\nTrace key: second\n"}}, results[1]];
  assert.ok((await verifyMissionEvidence(c, ambiguous, fs("first second"))).some(error => error.includes("SOURCE_FIELD_UNBOUND")));
});

test("nearest source/report scopes and quoted, dotted or verbatim literal labels remain precise", async () => {
  const goal = "Read inputs/a.json. Create build/a.md with its exact Trace key. Read inputs/b.json. Create build/b.md with its exact Trace key.";
  const c = contract(goal, [{path: "build/a.md", kind: "document"}, {path: "build/b.md", kind: "document"}]);
  assert.deepEqual(c.evidenceRequirements.map(item => [item.sourcePaths, item.reportPaths]), [[["inputs/a.json"], ["build/a.md"]], [["inputs/b.json"], ["build/b.md"]]]);
  const results = [receipt("workspace_read", {path: "inputs/a.json", sha256: "current", content: '{"trace_key":"First-A"}'}), receipt("workspace_read", {path: "inputs/b.json", sha256: "current", content: '{"trace_key":"Second-B"}'}), receipt("workspace_propose_patch", {_harnessArtifacts: c.deliverables.map(item => ({path: item.path, sha256: "current"}))})];
  const fs = {...workspace, read: async path => ({path, sha256: "current", content: `Trace key: ${path.endsWith("a.md") ? "First-A" : "Second-B"}`})};
  assert.deepEqual(await verifyMissionEvidence(c, results, fs), []);
  for (const instruction of ["copy its exact `Trace key`", "copy the Trace key verbatim"]) assert.equal(deriveMissionEvidence(`Read inputs/a.json. Create build/a.md and ${instruction}.`)[0].field, "Trace key");
  const nested = contract("Read inputs/a.json. Create build/a.md and copy its exact provenance.run_id.", [{path: "build/a.md", kind: "document"}]);
  assert.equal(nested.evidenceRequirements[0].field, "provenance.run_id");
  assert.deepEqual(await verifyMissionEvidence(nested, [{...results[0], data: {...results[0].data, content: '{"provenance":{"run_id":"First-A"}}'}}, results[2]], {...fs, read: async path => ({path, sha256: "current", content: "provenance.run_id: First-A"})}), []);
});

test("plain write verbs and adjacent sentence requirements bind the actual named report", () => {
  const inline = deriveMissionEvidence("Inspect protein IR. Write build/result.v1.json with each protein ID, length and sequence_sha256.")[0];
  assert.deepEqual(inline.reports, [{paths: ["build/result.v1.json"], fields: ["sequence_sha256", "length"]}]);
  const adjacent = deriveMissionEvidence("Inspect protein IR. Write build/result.v1.json. Include each protein ID, length and sequence_sha256.")[0];
  assert.deepEqual(adjacent.reports, inline.reports);
});

test("every generated artifact excludes read-only inputs and each named report must satisfy its own contract", async () => {
  const goal = "Create build/first.md and build/second.md with a report of every generated artifact path and SHA-256.";
  const c = contract(goal, [{path: "build/first.md", kind: "document"}, {path: "build/second.md", kind: "document"}]);
  assert.equal(c.evidenceRequirements[0].allRecords, true); assert.equal(c.evidenceRequirements[0].generatedOnly, true);
  const artifacts = [1, 2].map(index => ({path: `build/generated-${index}.json`, sha256: String(index).repeat(64)}));
  const result = receipt("proto_compile", {_harnessArtifacts: artifacts});
  const output = receipt("workspace_propose_patch", {_harnessArtifacts: c.deliverables.map(item => ({path: item.path, sha256: "current"}))});
  const fs = reports => ({read: async path => ({path, sha256: "current", content: reports[path]}), artifactFingerprint: async path => ({path, sha256: artifacts.find(item => item.path === path)?.sha256 ?? "current"})});
  const complete = JSON.stringify(artifacts);
  assert.ok((await verifyMissionEvidence(c, [result, output], fs({"build/first.md": complete, "build/second.md": "Nothing to report."}))).some(error => error.includes("build/second.md")));
  assert.ok((await verifyMissionEvidence(c, [result, output], fs({"build/first.md": JSON.stringify([artifacts[0]]), "build/second.md": complete}))).some(error => error.includes("build/first.md")));
  assert.deepEqual(await verifyMissionEvidence(c, [result, output], fs({"build/first.md": complete, "build/second.md": complete})), []);
  assert.ok((await verifyMissionEvidence(c, [receipt("workspace_read", {...artifacts[0], content: "input"}), output], fs({"build/first.md": complete, "build/second.md": complete}))).some(error => error.includes("ARTIFACT_REPORT_MISSING")));
});

test("artifact metadata reports bind each current path to its own full digest", async () => {
  const goal = "Inspect returned manifests and report their exact paths and SHA-256 values. Create build/audit.md.";
  const c = contract(goal, [{path: "build/audit.md", kind: "document"}]);
  assert.deepEqual(c.evidenceRequirements, [{kind: "artifact-report", minimumRecords: 1, category: "metadata"}]);
  const first = {path: "build/run/manifest.json", sha256: "a".repeat(64)}, second = {path: "build/run/provenance.json", sha256: "b".repeat(64)};
  const results = [receipt("proto_workflow_run", {_harnessArtifacts: [first, second]}), receipt("workspace_propose_patch", {_harnessArtifacts: [{path: "build/audit.md", sha256: "current"}]})];
  const complete = JSON.stringify([first, second]);
  const fs = content => ({read: async path => ({path, sha256: "current", content}), artifactFingerprint: async path => ({path, sha256: path.includes("provenance") ? second.sha256 : first.sha256})});
  assert.deepEqual(await verifyMissionEvidence(c, results, fs(complete)), []);
  assert.ok((await verifyMissionEvidence(c, results, fs(JSON.stringify([{...first, sha256: second.sha256}, {...second, sha256: first.sha256}])), complete)).some(error => error.includes("ARTIFACT_REPORT_HASH_MISMATCH")));
  assert.ok((await verifyMissionEvidence(c, results, fs(JSON.stringify([first])), complete)).some(error => error.includes("ARTIFACT_REPORT_MISSING")));
  assert.deepEqual(results[0].data._harnessArtifacts, [first, second], "normalization must not mutate durable receipt data");
});
