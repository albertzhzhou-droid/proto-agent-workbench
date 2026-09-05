import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {deriveDnaEvidence,dnaEvidenceSource,verifyDnaEvidence} from "../src/main/services/mission-dna-contract.ts";

const repo=fileURLToPath(new URL("../../../",import.meta.url));
const python=process.env.PROTO_AGENT_PYTHON||join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python");
const sha=text=>createHash("sha256").update(text).digest("hex");
// Existing explicitly labelled toy IDs only. Python remains the actual compiler.
const fixtures=JSON.parse(execFileSync(python,["-c",String.raw`
import json, runpy
from proto_agent.compiler import compile_design_text
from proto_agent.parser import parse_design_text
from proto_agent.dna_placement import occurrence_ids
fixture=runpy.run_path('tests/test_dna_placements.py')
source=fixture['SOURCE'].replace('  terminator B0015','  cds tetR instance=c2\n  terminator B0015')
good=source.replace('cds tetR instance=c1','cds tetR instance=c1 orientation=reverse')
texts={'before':source,'good':good,'unchanged':source,
 'wrongOccurrence':source.replace('cds tetR instance=c2','cds tetR instance=c2 orientation=reverse'),
 'extraEdit':good.replace('cds tetR instance=c2','cds tetR instance=c2 orientation=reverse'),
 'changedPart':good.replace('cds tetR instance=c1','cds gfp_mock instance=c1'),
 'renamed':good.replace('instance=c2','instance=renamed_toy'),
 'linear':good.replace('topology circular','topology linear'),
 'linearOnly':source.replace('topology circular','topology linear'),
 'reordered':good.replace('  cds tetR instance=c1 orientation=reverse\n  cds tetR instance=c2','  cds tetR instance=c2\n  cds tetR instance=c1 orientation=reverse'),
 'legacy':fixture['SOURCE'].replace(' instance=p1','').replace(' instance=r1','').replace(' instance=c1','').replace(' instance=t1',''),
 'implicitCollision':fixture['SOURCE'].replace(' instance=p1','').replace('instance=r1','instance=occurrence_0001')}
rows={}
for key,text in texts.items():
 ir,diagnostics=compile_design_text(text,fixture['TOY_PARTS'],source_path='build/edit.proto')
 assert ir is not None,[item.to_dict() for item in diagnostics]
 parsed,errors=parse_design_text(text)
 projection=[{'name':c.name,'topology':c.topology,'parts':[{'type':p.type,'id':p.id,'instanceId':identifier,'orientation':p.orientation} for p,identifier in zip(c.parts,occurrence_ids(c.parts))]} for c in parsed.constructs]
 rows[key]={'source':text,'ir':ir,'projection':projection}
print(json.dumps(rows))
`],{cwd:repo,env:{...process.env,PYTHONPATH:join(repo,"src")},encoding:"utf8",windowsHide:true,timeout:10000,maxBuffer:2*1024*1024}));
const path="build/edit.proto",irPath="build/current.ir.json",partsPath=join(repo,"parts/ecoli_k12_library.json");
const partsText=readFileSync(partsPath,"utf8"),binding={partsPath,partsSha256:sha(partsText)};
const requirement={kind:"dna-edit",path,occurrenceOrientations:[{instanceId:"c1",orientation:"reverse"}],preservePartIdentities:true,preserveOccurrenceIds:true,onlyTargetOccurrences:true};
const receipt=(tool,data,ok=true)=>({tool,ok,data});
function scenario(name="good") {
 const current=fixtures[name],before=fixtures.before,irText=JSON.stringify(current.ir);
 const files=new Map([[resolve(repo,path),current.source],[resolve(repo,irPath),irText],[resolve(partsPath),partsText]]);
 const read=async requested=>{const actual=resolve(repo,requested),content=files.get(actual);if(content===undefined)throw new Error("Absent toy fixture");return {path:actual,content,sha256:sha(content)};};
 const workspace={read,artifactFingerprint:async requested=>{const file=await read(requested);return {path:file.path,sha256:file.sha256};}};
 const results=[receipt("workspace_read",{path:resolve(repo,path),sha256:sha(before.source),content:before.source}),
 receipt("workspace_propose_patch",{effect_state:"committed",patch:{targetPath:resolve(repo,path),baseSha256:sha(before.source),before:before.source,baseExists:true},validation:{source:resolve(repo,path),sha256:sha(current.source),ok:true,materialBinding:binding,steps:["proto_check","proto_workflow_run","proto_provenance_verify","proto_review_packet"].map(tool=>({tool,status:"completed"}))},_harnessArtifacts:[{path:resolve(repo,path),sha256:sha(current.source)},{path:resolve(repo,irPath),sha256:sha(irText)}]})];
 return {workspace,results,files,current,before,irText};
}

test("trusted explicit occurrence IDs, preserve clauses and topology bind without fixture constants",()=>{
 const [derived]=deriveDnaEvidence("Edit build/edit.proto. Set only occurrence target_99 to reverse. Preserve all part IDs and occurrence IDs. Set topology to linear.");
 assert.deepEqual(derived,{...requirement,occurrenceOrientations:[{instanceId:"target_99",orientation:"reverse"}],topology:"linear"});
 assert.deepEqual(deriveDnaEvidence("Inspect build/edit.proto. Do not reverse occurrence target_99. Summarize uncertainty."),[]);
 assert.equal(deriveDnaEvidence("Edit build/a.proto and build/b.proto. Set occurrence x to reverse.")[0].bindingError.includes("one explicit"),true);
 assert.equal(deriveDnaEvidence("Edit build/edit.proto. Set occurrence x to reverse. Set occurrence x to forward.")[0].bindingError.includes("conflict"),true);
});

test("generic gerunds, topology declarations and coordinated identity preservation retain obligations",()=>{
 const modified=deriveDnaEvidence("Read designs/source.proto, preview reversing only occurrence target_37, then save the candidate to that same file. Preserve every occurrence ID and source part identity.")[0];
 assert.deepEqual(modified.occurrenceOrientations,[{instanceId:"target_37",orientation:"reverse"}]);
 assert.equal(modified.preservePartIdentities,true);assert.equal(modified.preserveOccurrenceIds,true);assert.equal(modified.onlyTargetOccurrences,true);
 const repair=deriveDnaEvidence("Read designs/source.proto. Repair only the invalid topology declaration to linear while preserving every part and instance ID.")[0];
 assert.equal(repair.topology,"linear");assert.equal(repair.onlyTargetOccurrences,true);assert.equal(repair.preservePartIdentities,true);assert.equal(repair.preserveOccurrenceIds,true);
 assert.equal(deriveDnaEvidence("Edit designs/source.proto. Set instance x to reverse. Do not change part IDs.")[0].preservePartIdentities,true);
 assert.deepEqual(deriveDnaEvidence("修改 designs/source.proto。将实例 x 设置为反向。")[0].occurrenceOrientations,[{instanceId:"x",orientation:"reverse"}]);
 assert.deepEqual(deriveDnaEvidence("Edit designs/source.proto. Make occurrence marker_18 reversed.")[0].occurrenceOrientations,[{instanceId:"marker_18",orientation:"reverse"}]);
});

test("source identity projection agrees with Python for explicit, repeated, legacy and colliding implicit IDs",()=>{
 for(const fixture of Object.values(fixtures))assert.deepEqual(dnaEvidenceSource(fixture.source).constructs.map(({name,topology,parts})=>({name,topology,parts})),fixture.projection);
});

test("actual Python compiled reverse placement and preserved repeated identities satisfy the contract",async()=>{
 const s=scenario();assert.deepEqual(await verifyDnaEvidence(requirement,s.results,s.workspace,repo),[]);
});

for(const [variant,pattern] of [["unchanged",/orientation=reverse/],["wrongOccurrence",/orientation=reverse/],["extraEdit",/Only the requested/],["changedPart",/part identities/],["renamed",/occurrence IDs/],["reordered",/Only the requested/]])test(`successful compiler evidence cannot conceal ${variant}`,async()=>{
 const s=scenario(variant),diagnostics=await verifyDnaEvidence(requirement,s.results,s.workspace,repo);assert.match(diagnostics.join("\n"),pattern);
});

test("declared topology is checked against authoritative current IR",async()=>{
 const s=scenario();assert.match((await verifyDnaEvidence({...requirement,topology:"linear"},s.results,s.workspace,repo)).join("\n"),/topology linear/);
 const valid=scenario("linear");assert.deepEqual(await verifyDnaEvidence({...requirement,topology:"linear"},valid.results,valid.workspace,repo),[]);
});

test("postwrite reads, incorrect baseline hashes and mismatched before bytes cannot reset original identity",async()=>{
 for(const mutate of [s=>s.results.reverse(),s=>s.results[0].data.sha256="0".repeat(64),s=>s.results[1].data.patch.before=s.current.source]){
  const s=scenario();mutate(s);assert.ok((await verifyDnaEvidence(requirement,s.results,s.workspace,repo)).length);
 }
});

test("a committed validation failure remains the first-write baseline instead of a later corrected read",async()=>{
 const s=scenario("changedPart"),first=structuredClone(s.results[1]);
 first.ok=false;first.data.validation.ok=false;
 const later=structuredClone(s.results[1]);later.data.patch.before=s.current.source;later.data.patch.baseSha256=sha(s.current.source);
 s.results=[s.results[0],first,receipt("workspace_read",{path:resolve(repo,path),sha256:sha(s.current.source),content:s.current.source}),later];
 assert.match((await verifyDnaEvidence(requirement,s.results,s.workspace,repo)).join("\n"),/part identities/);
});

test("only a bad topology declaration can be repaired without changing other occurrences",async()=>{
 const s=scenario("linear"),invalid=s.before.source.replace("topology circular","topology invalid");
 s.results[0].data.content=invalid;s.results[0].data.sha256=sha(invalid);s.results[1].data.patch.before=invalid;s.results[1].data.patch.baseSha256=sha(invalid);
 const topologyOnly={...requirement,occurrenceOrientations:[],topology:"linear"};
 assert.match((await verifyDnaEvidence(topologyOnly,s.results,s.workspace,repo)).join("\n"),/Only the requested/);
 const good=scenario("linearOnly");good.results[0].data.content=invalid;good.results[0].data.sha256=sha(invalid);good.results[1].data.patch.before=invalid;good.results[1].data.patch.baseSha256=sha(invalid);
 assert.deepEqual(await verifyDnaEvidence(topologyOnly,good.results,good.workspace,repo),[]);
});

test("annotation whitespace and hash characters are preserved by the identity-only comparison",()=>{
 const first=fixtures.before.source+'  annotation\tnote_01 {"name":"A  B # C","type":"misc_feature","anchors":[{"instance_id":"c1","start":0,"end":1,"direction":0}],"origin":"user"}\n';
 const second=first.replace('A  B # C','A B # C');
 assert.notDeepEqual(dnaEvidenceSource(first),dnaEvidenceSource(second));
 assert.match(dnaEvidenceSource(first).constructs[0].other[0],/A  B # C/);
});

test("missing, forged, stale and wrong-source compiler lineage cannot become DNA acceptance",async()=>{
 for(const mutate of [
  s=>s.results[1].data.validation.ok=false,
  s=>s.results[1].data._harnessArtifacts[1].sha256="0".repeat(64),
  s=>s.files.set(resolve(partsPath),partsText+"\n"),
  s=>s.results[1].data.validation.source="build/other.proto",
  s=>s.results[1].tool="workspace_read",
 ]){const s=scenario();mutate(s);assert.match((await verifyDnaEvidence(requirement,s.results,s.workspace,repo)).join("\n"),/Compile .*current bound library/);}
});

test("a reopened IR must retain matching source and library provenance even with a current artifact receipt",async()=>{
 const s=scenario(),ir=JSON.parse(s.irText);ir.provenance.source="build/other.proto";
 const changed=JSON.stringify(ir);s.files.set(resolve(repo,irPath),changed);s.results[1].data._harnessArtifacts[1].sha256=sha(changed);
 assert.match((await verifyDnaEvidence(requirement,s.results,s.workspace,repo)).join("\n"),/Compile .*current bound library/);
});

test("literal occurrence case and unknown targets never match a nearby valid placement",async()=>{
 const s=scenario();for(const instanceId of ["C1","c10","missing"]){assert.match((await verifyDnaEvidence({...requirement,occurrenceOrientations:[{instanceId,orientation:"reverse"}]},s.results,s.workspace,repo)).join("\n"),/exactly one/);}
});
