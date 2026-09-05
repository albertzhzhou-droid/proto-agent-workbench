import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { deriveMissionCapabilities, deriveMissionTargets } from "../src/main/services/mission-contract.ts";

test("direct service missions honor explicit network and execution intent while retaining offline requests", () => {
  assert.deepEqual(deriveMissionCapabilities("Use live network PubMed and Crossref searches"), {network: true, execution: false});
  assert.deepEqual(deriveMissionCapabilities("Search official PDB metadata and fetch coordinates"), {network: true, execution: false});
  assert.deepEqual(deriveMissionCapabilities("Search governed materials and run the design workflow"), {network: false, execution: false});
  assert.deepEqual(deriveMissionCapabilities("Inspect cached PubMed results offline only"), {network: false, execution: false});
  assert.deepEqual(deriveMissionCapabilities("Run the Python script"), {network: false, execution: true});
});

test("explicit PDF output remains a mandatory artifact target", () => {
  const targets = deriveMissionTargets("Read inputs/brief.md and export build/report.pdf", "C:\\workspace");
  assert.ok(targets.deliverables.some(item => item.path === "build/report.pdf"));
});

const root = resolve("mission-fixture");
test("original input and output paths are bound before a model declares a plan", () => {
  const result = deriveMissionTargets("Read `designs/input.proto` and save the review to `build/result.md` and `build/evidence.json`.", root);
  assert.deepEqual(result.requiredReads, ["designs/input.proto"]);
  assert.deepEqual(result.writeTargets, ["build/result.md", "build/evidence.json"]);
  assert.equal(result.requiresArtifacts, true);
});
test("Chinese edit requests preserve the read baseline and all explicit outputs", () => {
  const result = deriveMissionTargets("读取 designs/input.proto，然后修改 designs/input.proto，生成 build/result.md", root);
  assert.deepEqual(result.requiredReads, ["designs/input.proto"]);
  assert.deepEqual(result.deliverables, [{path: "designs/input.proto", kind: "dna"}, {path: "build/result.md", kind: "document"}]);
});
test("read-only request and external links do not grant write targets", () => {
  const result = deriveMissionTargets("Read input.md and inspect https://example.invalid/reference.md. Do not modify input.md.", root);
  assert.deepEqual(result.writeTargets, []);
  assert.deepEqual(result.requiredReads, ["input.md"]);
  assert.equal(result.requiresArtifacts, false);
});
test("explicit protein artifacts receive domain acceptance requirements", () => {
  const result = deriveMissionTargets("Create a protein selection in build/protein.json and export build/protein.fasta", root);
  assert.deepEqual(result.deliverables, [{path: "build/protein.json", kind: "protein"}, {path: "build/protein.fasta", kind: "protein"}]);
});
test("protein report JSON stays a document while explicitly typed IR and FASTA keep scientific requirements", () => {
  const result = deriveMissionTargets("Create build/protein-summary.json with protein IDs and lengths, save build/result.protein.ir.json and export build/protein.fasta", root);
  assert.deepEqual(result.deliverables, [
    {path: "build/protein-summary.json", kind: "document"},
    {path: "build/result.protein.ir.json", kind: "protein"},
    {path: "build/protein.fasta", kind: "protein"},
  ]);
});
test("an unspecified output requires a plan without inventing filenames", () => {
  assert.deepEqual(deriveMissionTargets("创建一个经过软件校验的设计", root), {deliverables: [], requiredReads: [], writeTargets: [], requiresArtifacts: true});
});
test("compile input remains a required read while the explicit compile destination is mandatory",()=>{
  const result=deriveMissionTargets("Compile build/input.proto to build/output.ir.json",root);
  assert.deepEqual(result.requiredReads,["build/input.proto"]);
  assert.deepEqual(result.writeTargets,["build/output.ir.json"]);
  const protein=deriveMissionTargets("Validate the protein selection, compile it to build/resumed-protein.ir.json and export build/resumed-protein.fasta",root);
  assert.deepEqual(protein.writeTargets,["build/resumed-protein.ir.json","build/resumed-protein.fasta"]);
});
