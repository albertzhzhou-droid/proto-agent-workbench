import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {sha256Text} from "../src/renderer/sha256.ts";
import {MAX_PREDICTION_RESIDUES,predictionPaeCell,predictionPaePixels,predictionResidueLabel,validateStructurePrediction} from "../src/renderer/structure-prediction.ts";

const recorded=JSON.parse(await readFile(new URL("../src/renderer/compute-preview.json",import.meta.url),"utf8"));
const base=recorded.results.import_colabfold_result;
const args=recorded.catalog.tools.find(tool=>tool.id==="import_colabfold_result").example;
const copy=()=>structuredClone(base);
function receipt(result=base) {
  return {ok:true,tool:"import_colabfold_result",run_id:"a".repeat(32),result_sha256:"b".repeat(64),
    inputs:Object.fromEntries(Object.entries(result.sources).map(([field,source])=>[`file:${field}`,{path:source.path,sha256:source.sha256}]))};
}
const validate=(result=copy(),request=args,run=receipt(result))=>validateStructurePrediction(result,request,run);

test("recorded bounded fixture preserves identities, source claims and pLDDT mapping",()=>{
  const result=validate();assert.equal(result.structure.residue_count,3);assert.equal(result.mapping.index_base,0);
  assert.equal(result.structure.residues[0].plddt,result.confidence.plddt.values[0]);
  assert.equal(result.structure.chains[0].sequence_sha256,sha256Text(result.structure.chains[0].sequence));
  assert.match(predictionResidueLabel(result.structure.residues[0]),/^index 0 · model 1 · chain A ·/);
  assert.notEqual(result,base);assert.notEqual(result.confidence.pae.values,base.confidence.pae.values);
});

test("row-major PAE selection and pixels preserve asymmetric [row][column] values",()=>{
  const raw=copy();raw.confidence.pae.values[0][1]=1.25;raw.confidence.pae.values[1][0]=9.5;
  raw.confidence.pae.observed_matrix_max=9.5;raw.confidence.pae.reported_max_pae=9.5;
  const result=validate(raw),upper=predictionPaeCell(result,0,1),lower=predictionPaeCell(result,1,0);
  assert.equal(upper.value,1.25);assert.equal(lower.value,9.5);
  assert.equal(upper.rowResidue.index,0);assert.equal(upper.columnResidue.index,1);
  const pixels=predictionPaePixels(result);assert.equal(pixels.length,3*3*4);
  assert.deepEqual([...pixels.subarray((1*3+0)*4,(1*3+0)*4+4)],[244,238,223,255]);
  assert.notDeepEqual([...pixels.subarray(4,8)],[...pixels.subarray(12,16)]);
});

test("absent PAE and scalar metrics remain unavailable without zeros or invented cells",()=>{
  const raw=copy();raw.confidence.pae={status:"unavailable",unit:"angstrom",reason:"scores JSON has no pae matrix",values:null};
  const result=validate(raw);assert.equal(predictionPaeCell(result,0,0),undefined);assert.equal(predictionPaePixels(result),undefined);
  assert.equal(result.confidence.ptm.status,"unavailable");assert.equal(result.confidence.ptm.value,null);
  raw.confidence.pae.values=[[0]];assert.throws(()=>validate(raw),/malformed contract/);
});

test("live rendering rejects missing, false and mismatched receipt source claims",()=>{
  assert.throws(()=>validate(copy(),{...args,structure_path:"build/another.pdb"}),/paths do not match/);
  for(const field of ["structure_path","scores_path"]) {
    const hash=receipt();hash.inputs[`file:${field}`].sha256="c".repeat(64);
    assert.throws(()=>validate(copy(),args,hash),/digests do not match/);
    const path=receipt();path.inputs[`file:${field}`].path="build/another.json";
    assert.throws(()=>validate(copy(),args,path),/do not match/);
  }
  for(const run of [{...receipt(),inputs:{}},{...receipt(),ok:false},{...receipt(),result_sha256:undefined},{...receipt(),run_id:undefined}])assert.throws(()=>validate(copy(),args,run));
});

test("example replay is allowed only without live execution or file-verification identity",()=>{
  const preview={ok:true,tool:"import_colabfold_result",preview:true,result:copy()};
  assert.equal(validate(copy(),args,preview).prediction_execution,"not-performed");
  for(const patch of [{run_id:"a".repeat(32)},{result_sha256:"b".repeat(64)},{inputs:receipt().inputs},{source:{}},{manifest_path:"build/manifest.json"}])assert.throws(()=>validate(copy(),args,{...preview,...patch}),/malformed contract/);
  assert.throws(()=>validate(copy(),{...args,scores_path:"build/other.json"},preview),/paths do not match/);
});

test("nonfinite, out-of-range and malformed confidence arrays are rejected",()=>{
  for(const invalid of [NaN,Infinity,-1,100.001,true,"90"]) {
    const raw=copy();raw.confidence.plddt.values[0]=invalid;assert.throws(()=>validate(raw));
  }
  for(const invalid of [NaN,Infinity,-1,1000.001,true,"2"]) {
    const raw=copy();raw.confidence.pae.values[0][0]=invalid;assert.throws(()=>validate(raw));
  }
  for(const mutate of [raw=>raw.confidence.pae.values[0].pop(),raw=>raw.confidence.pae.shape=[2,3],raw=>raw.confidence.plddt.values.pop(),raw=>raw.structure.residue_count=MAX_PREDICTION_RESIDUES+1]) {
    const raw=copy();mutate(raw);assert.throws(()=>validate(raw));
  }
  assert.equal(MAX_PREDICTION_RESIDUES,384);
});

test("per-residue identity, pLDDT and PDB mapping contradictions reject the entire result",()=>{
  const mutations=[
    raw=>raw.structure.residues[0].index=1,
    raw=>raw.structure.residues[0].identity.chain="B",
    raw=>raw.structure.residues[0].identity.model=2,
    raw=>raw.structure.residues[1].identity.residue_number=99,
    raw=>raw.structure.residues[0].identity.one_letter="Y",
    raw=>raw.structure.residues[0].identity.insertion_code="A",
    raw=>raw.structure.residues[0].identity.alternate_location="A",
    raw=>raw.structure.residues[0].identity.occupancy=0,
    raw=>raw.structure.residues[0].coordinates_angstrom[0]=Infinity,
    raw=>raw.structure.residues[0].plddt=1,
    raw=>raw.structure.residues[0].pdb_ca_bfactor_plddt=1,
    raw=>raw.structure.residues[0].plddt_source_pointer="/plddt/1",
    raw=>raw.structure.chains[0].start_index=1,
    raw=>raw.structure.chains[0].sequence_sha256="0".repeat(64),
  ];
  for(const mutate of mutations){const raw=copy();mutate(raw);assert.throws(()=>validate(raw));}
});

test("summary values, units, confidence source fields and unsupported model claims fail closed",()=>{
  for(const mutate of [raw=>raw.confidence.plddt.mean=99,raw=>raw.confidence.plddt.minimum=99,raw=>raw.confidence.pae.observed_matrix_max=10,
    raw=>raw.confidence.pae.reported_max_pae=10,raw=>raw.confidence.pae.unit="nm",raw=>raw.confidence.plddt.unit="percent",raw=>raw.mapping.same_prediction_provenance="verified",
    raw=>raw.prediction_execution="completed",raw=>raw.confidence.interpretation="experimentally-validated",
    raw=>raw.confidence.ptm={status:"available",value:0.5,unit:"score-0-1",source_field:"/iptm"}]) {
    const raw=copy();mutate(raw);assert.throws(()=>validate(raw));
  }
});

test("independent expected sequence status must match the actual request",()=>{
  const raw=copy(),expected=raw.structure.chains.map(item=>({chain:item.chain,sequence:item.sequence.toLowerCase()}));
  assert.throws(()=>validate(raw,{...args,expected_chains:expected}),/Expected chain sequences/);
  raw.mapping.expected_sequence_status="exact-match-uppercase-normalized";
  assert.equal(validate(raw,{...args,expected_chains:expected}).mapping.expected_sequence_status,"exact-match-uppercase-normalized");
  assert.throws(()=>validate(raw),/not requested/);
  expected[0].sequence="Y".repeat(expected[0].sequence.length);assert.throws(()=>validate(raw,{...args,expected_chains:expected}),/Expected chain sequences/);
});

test("malicious identities and unsafe paths cannot become rendering coordinates or HTML",()=>{
  for(const mutate of [raw=>raw.structure.residues[0].identity.residue_name='<svg onload="x">',raw=>raw.structure.chains[0].chain="<",raw=>raw.sources.structure_path.path="../../outside.pdb",raw=>raw.sources.structure_path.path="C:/outside.pdb",raw=>raw.sources.scores_path.path="build/a\x7f.json"]) {
    const raw=copy();mutate(raw);assert.throws(()=>validate(raw));
  }
});

test("PAE indices cannot wrap, round, truncate or index outside the returned map",()=>{
  const result=validate();
  for(const [row,col] of [[-1,0],[0,-1],[0,3],[3,0],[0.5,1],[NaN,0],[Infinity,0]])assert.throws(()=>predictionPaeCell(result,row,col),/zero-based/);
});
