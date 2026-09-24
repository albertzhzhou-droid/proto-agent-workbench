import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {extractResearchFacts, extractUnlocatableResearchValues, reopenResearchEvidence, verifyStructuredResearchClaim} from "../src/main/services/research-evidence.ts";
import {TOOL_CONTRACTS,resolveToolContract} from "../src/shared/tool-contracts.ts";

const retained = JSON.parse(await readFile(new URL("./fixtures/research-evidence/acid-base-retained.json", import.meta.url), "utf8"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const activity = (patch={}) => ({id:"retained-case",tool:"science_run",input:structuredClone(retained.requested),status:"complete",startedAt:"2026-09-19T21:10:51.154Z",artifactPath:`build/chat/${randomUUID()}/tool-results/${randomUUID()}.json`,artifactSha256:"a".repeat(64),...patch});
const evidenceFor = facts => ({schema:"proto-workbench.research-evidence.v1",status:"bound-facts",scope:"saved-tool-receipt-fields-only",interpretation:"unreviewed",facts,diagnostics:[]});
const claimFor = fact => ({kind:"fact",factId:fact.id,subjectId:fact.subjectId,quantity:fact.quantity,value:fact.value,unit:fact.unit});

test("retained acid-base receipt binds alpha identity, value, unit and context without inventing a formula",()=>{
  assert.equal(retained.provenance.trace_sha256,"58c614f2945792b96dea288eabdcdd8c158c3f546f49f545557673b5812b6c55");
  assert.match(retained.observed_text,/H₂A/);
  const facts=extractResearchFacts(activity(),retained.receipt);
  assert.equal(facts.length,2);
  assert.deepEqual(facts.map(({subjectId,value,unit})=>({subjectId,value,unit})),[
    {subjectId:"alpha_0",value:0.5,unit:"dimensionless"},{subjectId:"alpha_1",value:0.5,unit:"dimensionless"},
  ]);
  assert.deepEqual(facts[0].context,{pH:4.76,protons_lost:0,formal_charge:0});
  assert.equal(facts[0].identityPointer,"/data/result/species/0/id");
  assert.equal(facts[0].valuePointer,"/data/result/rows/0/alpha_0");
  assert.equal(facts[0].unitSource,"/data/result/visualization/y_unit");
  assert.ok(!JSON.stringify(facts).includes("H₂A"));
});

test("explicit retained-label claim mismatches; synthetic unit and value negatives stay distinct",()=>{
  const evidence=evidenceFor(extractResearchFacts(activity(),retained.receipt)), claim=claimFor(evidence.facts[0]);
  assert.equal(verifyStructuredResearchClaim(evidence,claim).status,"bound");
  assert.deepEqual(verifyStructuredResearchClaim(evidence,{...claim,subjectId:"H₂A"}),{status:"mismatch",diagnostics:["SUBJECTID_MISMATCH"]});
  // Synthetic negatives, not asserted to be additional observed model failures.
  assert.deepEqual(verifyStructuredResearchClaim(evidence,{...claim,unit:"mol/L"}),{status:"mismatch",diagnostics:["UNIT_MISMATCH"]});
  assert.deepEqual(verifyStructuredResearchClaim(evidence,{...claim,value:50,unit:"%"}),{status:"mismatch",diagnostics:["VALUE_MISMATCH","UNIT_MISMATCH"]});
  assert.deepEqual(verifyStructuredResearchClaim(evidence,{...claim,factId:"missing"}),{status:"mismatch",diagnostics:["UNKNOWN_FACT"]});
  assert.equal(verifyStructuredResearchClaim(evidence,{...claim,citation:"unbound"}).status,"mismatch");
});

test("ordinary text and explicit inference never receive a bound claim status",()=>{
  const evidence=evidenceFor(extractResearchFacts(activity(),retained.receipt));
  assert.equal(verifyStructuredResearchClaim(evidence,retained.observed_text).status,"mismatch");
  assert.deepEqual(verifyStructuredResearchClaim(evidence,{kind:"inference",text:retained.observed_text}),{status:"unreviewed",diagnostics:["CLAIM_NOT_CHECKED"]});
  assert.equal(verifyStructuredResearchClaim({...evidence,status:"unreviewed"},claimFor(evidence.facts[0])).status,"unreviewed");
});

test("unsupported operators, incomplete executions and missing host digests cannot project facts",()=>{
  for(const patch of [{input:{name:"chemistry.other"}},{status:"error"},{status:"running"},{artifactSha256:undefined},{artifactPath:undefined}]) {
    assert.deepEqual(extractResearchFacts(activity(patch),retained.receipt),[]);
  }
  assert.deepEqual(extractResearchFacts(activity({input:{name:"compute.run",arguments:{path:"other.json"}}}),{ok:true,tool:"another_operator",result:{value:7}}),[]);
});

test("species relabeling, input changes and oversized fact sets reject the entire projection",()=>{
  const wrongSpecies=structuredClone(retained.receipt);wrongSpecies.data.result.species[0].id="H₂A";
  assert.throws(()=>extractResearchFacts(activity(),wrongSpecies),/SPECIES_CONTRACT_MISMATCH/);
  const wrongInput=structuredClone(retained.receipt);wrongInput.data.input.ph_values=[5];
  assert.throws(()=>extractResearchFacts(activity(),wrongInput),/RECEIPT_INPUT_MISMATCH/);
  const oversized=structuredClone(retained.receipt);oversized.data.input.ph_values=Array(65).fill(4.76);oversized.data.result.rows=Array(65).fill(oversized.data.result.rows[0]);
  assert.throws(()=>extractResearchFacts(activity({input:{...retained.requested,arguments:oversized.data.input}}),oversized),/FACT_LIMIT_EXCEEDED/);
});

test("qPCR contract preserves sample and group context and declares its unit source",()=>{
  const call=activity({input:{name:"compute.run",arguments:{path:"input.json"}}});
  const receipt={ok:true,tool:"analyze_qpcr_relative_expression",run_id:"test-run",source:{path:"input.json",sha256:"b".repeat(64)},result:{control_group:"control",rows:[{id:"control-1",group:"control",relative_expression:1},{id:"treated-1",group:"treated",relative_expression:4}]}};
  const facts=extractResearchFacts(call,receipt);
  assert.deepEqual(facts.map(f=>[f.subjectId,f.value]),[["control-1",1],["treated-1",4]]);
  assert.deepEqual(facts[1].context,{group:"treated",control_group:"control"});
  assert.equal(facts[1].unit,"dimensionless");assert.equal(facts[1].unitSource,"operator-contract:qpcr-relative-expression/v1");
  assert.throws(()=>extractResearchFacts({...call,input:{name:"compute.run",arguments:{path:"another.json"}}},receipt),/RECEIPT_INPUT_MISMATCH/);
  const withoutSource=structuredClone(receipt);delete withoutSource.source;
  assert.throws(()=>extractResearchFacts(call,withoutSource),/UNSUPPORTED_RESULT_CONTRACT/);
  const unsafeId=structuredClone(receipt);unsafeId.result.rows[0].id="sample\x7f";
  assert.throws(()=>extractResearchFacts(call,unsafeId),/UNSUPPORTED_RESULT_CONTRACT/);
  receipt.result.rows[1].id="control-1";
  assert.throws(()=>extractResearchFacts(call,receipt),/AMBIGUOUS_SAMPLE_IDENTITY/);
});

async function savedReceipt(payload=retained.receipt) {
  const workspace=await mkdtemp(join(tmpdir(),"proto-evidence-")),sessionId=randomUUID();
  const directory=join(workspace,"build","chat",sessionId,"tool-results");await mkdir(directory,{recursive:true});
  const path=`build/chat/${sessionId}/tool-results/${randomUUID()}.json`,bytes=JSON.stringify(payload);
  await writeFile(join(workspace,path),bytes);
  return {workspace,sessionId,path,call:activity({artifactPath:path,artifactSha256:digest(bytes)})};
}

test("reopening hashes the complete receipt, ignores cached preview, and detects later changes",async()=>{
  const {workspace,sessionId,path,call}=await savedReceipt();call.output='{"alpha_0":999}';
  const good=await reopenResearchEvidence(workspace,sessionId,call);
  assert.equal(good.status,"bound-facts");assert.equal(good.facts[0].value,0.5);
  const changed=structuredClone(retained.receipt);changed.data.result.rows[0].alpha_0=0.7;
  await writeFile(join(workspace,path),JSON.stringify(changed));
  const bad=await reopenResearchEvidence(workspace,sessionId,call);
  assert.equal(bad.status,"mismatch");assert.deepEqual(bad.facts,[]);assert.deepEqual(bad.diagnostics,["RECEIPT_DIGEST_MISMATCH"]);
});

test("legacy records and cross-session paths remain unbound even with forged persisted projections",async()=>{
  const {workspace,sessionId,call}=await savedReceipt();
  call.evidence=evidenceFor([{subjectId:"forged",value:999}]);
  const legacy=await reopenResearchEvidence(workspace,sessionId,{...call,artifactSha256:undefined});
  assert.equal(legacy.status,"unreviewed");assert.deepEqual(legacy.facts,[]);assert.deepEqual(legacy.diagnostics,["NO_HOST_RECEIPT_DIGEST"]);
  const foreign=await reopenResearchEvidence(workspace,randomUUID(),call);
  assert.equal(foreign.status,"mismatch");assert.deepEqual(foreign.facts,[]);assert.deepEqual(foreign.diagnostics,["RECEIPT_PATH_MISMATCH"]);
  const traversal=await reopenResearchEvidence(workspace,"../../outside",call);
  assert.equal(traversal.status,"mismatch");assert.deepEqual(traversal.diagnostics,["RECEIPT_PATH_MISMATCH"]);
});

test("oversized and malformed receipts produce no partial facts",async()=>{
  const oversized=await savedReceipt({...retained.receipt,padding:"x".repeat(1024*1024)});
  const large=await reopenResearchEvidence(oversized.workspace,oversized.sessionId,oversized.call);
  assert.deepEqual(large.facts,[]);assert.deepEqual(large.diagnostics,["RECEIPT_FILE_UNSAFE"]);
  const malformed=structuredClone(retained.receipt);delete malformed.data.result.visualization.y_unit;
  const saved=await savedReceipt(malformed), result=await reopenResearchEvidence(saved.workspace,saved.sessionId,saved.call);
  assert.equal(result.status,"unreviewed");assert.deepEqual(result.facts,[]);
});

function valueReadCase(patch={}) {
  const receipt={ok:true,schema_version:"proto.compute-value-evidence.v1",result_path:"build/compute/example/result.json",result_sha256:"b".repeat(64),manifest_sha256:"c".repeat(64),pointer:"/mean/value",json_type:"number",value:1.25,value_text:"1.25",value_encoding:"json-number",value_sha256:digest("1.25"),quantity:{schema_version:"proto-agent.quantity.v1",unit:"dimensionless",quantity_kind:"ratio",entity_id:"sample-a",dataset_id:"dataset-a",contract_validated:true},result_index_status:"complete",scientific_validation:"not-established",review_status:"human_review_required",source_role:"saved-computation-output; integrity-bound, not an independent scientific validation",...patch};
  const input={name:"compute.value.read",arguments:{path:receipt.result_path,pointer:receipt.pointer,expected_result_sha256:receipt.result_sha256,expected_manifest_sha256:receipt.manifest_sha256}};
  return {receipt,call:activity({input})};
}

test("all registered read aliases and a newly registered name use the same fact projection",()=>{
  const {receipt,call}=valueReadCase(),contract=resolveToolContract(call.input.name);
  const newAlias="test-only.compute-value.alias";
  // Register only at the authoritative resolver boundary. The evidence reader
  // must not need another literal alias table when this registry gains a name.
  TOOL_CONTRACTS.set(newAlias,contract);
  try {
    for(const name of [contract.name,contract.capabilityId,...contract.aliases,newAlias]) {
      const facts=extractResearchFacts({...call,input:{...call.input,name}},receipt);
      assert.equal(facts.length,1,name);assert.equal(facts[0].value,1.25);assert.equal(facts[0].subjectId,"sample-a");
    }
  } finally {TOOL_CONTRACTS.delete(newAlias);}
});

test("unlocatable numeric and missing values stay visible with exact text and no inferred units",async()=>{
  const cases=[
    [{quantity:null},"QUANTITY_CONTRACT_MISSING","1.25"],
    [{json_type:"integer",value:"9007199254740993",value_text:"9007199254740993",value_encoding:"decimal-string"},"NON_NUMERIC_QUANTITY","9007199254740993"],
    [{json_type:"null",value:null,value_text:null,value_encoding:"json-null"},"MISSING_VALUE",null],
  ];
  for(const [patch,reason,valueText] of cases) {
    const {receipt,call}=valueReadCase(patch),saved=await savedReceipt(receipt);
    saved.call.input=call.input;
    const result=await reopenResearchEvidence(saved.workspace,saved.sessionId,saved.call);
    assert.equal(result.status,"unlocatable");assert.deepEqual(result.facts,[]);
    assert.equal(result.unlocatableValues[0].reason,reason);assert.equal(result.unlocatableValues[0].valueText,valueText);
    assert.equal(result.unlocatableValues[0].resultPointer,receipt.pointer);assert.equal(result.unlocatableValues[0].unit,undefined);
    assert.equal(verifyStructuredResearchClaim(result,{kind:"inference",text:"Unavailable quantity"}).status,"unreviewed");
    const wrong={...saved.call,input:{...call.input,arguments:{...call.input.arguments,pointer:"/other"}}};
    assert.throws(()=>extractUnlocatableResearchValues(wrong,receipt),/RECEIPT_INPUT_MISMATCH/);
  }
});
