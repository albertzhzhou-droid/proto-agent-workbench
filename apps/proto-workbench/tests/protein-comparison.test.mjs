import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fixture from "../src/renderer/compute-preview.json" with {type:"json"};
import { parseProteinAlignment, proteinStudy, proteinTreeLayout, linkedProteinPosition } from "../src/renderer/protein-comparison.ts";
import { readVerifiedComputeResult } from "../src/renderer/compute-result-reader.ts";

// Source-recorded synthetic software examples, never material eligibility evidence.
const recorded=fixture.results.analyze_protein_comparison;
const example=fixture.catalog.tools.find(tool=>tool.id==="analyze_protein_comparison").example.aligned_sequences;
const clone=()=>structuredClone(recorded);
const hash=content=>createHash("sha256").update(content,"utf8").digest("hex");
const receiptFor=content=>({ok:true,tool:"analyze_protein_comparison",run_id:"a".repeat(32),result_sha256:hash(content),result:{preview_omitted:true}});

test("real computation reopening uses receipt-bound bytes, including an omitted or stale inline preview", async()=>{
  const content=JSON.stringify(recorded),receipt=receiptFor(content),paths=[];
  receipt.result={study_schema:"wrong-inline-result"};
  const result=await readVerifiedComputeResult(receipt,async path=>{paths.push(path);return {content,sha256:hash(content)};},"analyze_protein_comparison");
  assert.deepEqual(paths,[`build/compute/${receipt.run_id}/result.json`]);
  assert.deepEqual(result,JSON.parse(content));
  assert.doesNotThrow(()=>proteinStudy(result,example));
});

test("saved result tampering and independent reader-hash mismatch are both rejected",async()=>{
  const content=JSON.stringify(recorded),receipt=receiptFor(content);
  const changed=JSON.stringify({...recorded,alignment_length:99});
  await assert.rejects(readVerifiedComputeResult(receipt,async()=>({content:changed,sha256:receipt.result_sha256})),/no longer match/);
  await assert.rejects(readVerifiedComputeResult(receipt,async()=>({content,sha256:"0".repeat(64)})),/no longer match/);
});

test("wrong tool, incomplete execution and invalid run identities fail before reading",async()=>{
  const content=JSON.stringify(recorded),receipt=receiptFor(content);
  let reads=0;const read=async()=>{reads++;throw new Error("Must not read");};
  for(const patch of [{tool:"descriptive_statistics"},{ok:false},{run_id:"../outside"},{result_sha256:"f".repeat(63)}]){
    await assert.rejects(readVerifiedComputeResult({...receipt,...patch},read,"analyze_protein_comparison"));
  }
  assert.equal(reads,0);
});

test("result limits count UTF-8 bytes and parsed results must be objects",async()=>{
  const oversized=JSON.stringify({label:"界".repeat(1_500_000)});
  assert.ok(oversized.length<4*1024*1024);
  assert.ok(Buffer.byteLength(oversized)>4*1024*1024);
  await assert.rejects(readVerifiedComputeResult(receiptFor(oversized),async()=>({content:oversized,sha256:hash(oversized)})),/no longer match/);
  for(const content of ["null","[]","42"]){
    await assert.rejects(readVerifiedComputeResult(receiptFor(content),async()=>({content,sha256:hash(content)})),/result object/);
  }
});

test("recorded examples are distinct from live identities and still bind the expected tool",async()=>{
  const read=async()=>{throw new Error("A recorded replay must not read disk");};
  assert.deepEqual(await readVerifiedComputeResult({ok:true,tool:"analyze_protein_comparison",preview:true,result:recorded},read,"analyze_protein_comparison"),recorded);
  await assert.rejects(readVerifiedComputeResult({...receiptFor("{}"),preview:true,result:recorded},read),/live execution identity/);
  await assert.rejects(readVerifiedComputeResult({ok:true,preview:true,result:[]},read),/result object/);
});

test("alignment input normalizes case but rejects malformed and misaligned records",()=>{
  assert.deepEqual(parseProteinAlignment(">one\nacdefghikl\n>two\nAC-EFGHIKL"),[
    {name:"one",sequence:"ACDEFGHIKL"},{name:"two",sequence:"AC-EFGHIKL"}]);
  for(const text of ["ACDEFGHIKL",">one\nACDEFGHIKL\n>one\nACDEFGHIKL",">one\nACDEFGHIKL\n>two\nACDEFGHIKLM",
    ">one\nACDEXGHIKL\n>two\nACDEFGHIKL",">one\n----------\n>two\nACDEFGHIKL",">bad\x7fname\nACDEFGHIKL\n>two\nACDEFGHIKL"]){
    assert.throws(()=>parseProteinAlignment(text));
  }
});

test("Unicode lookalikes and expanding uppercase characters never become amino-acid evidence",()=>{
  for(const [unicode,canonical] of [["ACDıFGHIKL","ACDIFGHIKL"],["ACDſFGHIKL","ACDSFGHIKL"],["ACDßFGHIKL","ACDSSFGHIKL"]]){
    assert.equal(unicode.toUpperCase(),canonical);
    assert.throws(()=>parseProteinAlignment(`>synthetic-a\n${unicode}\n>synthetic-b\n${canonical}`),/ASCII/);
  }
  const unicodeRequest=example.map(row=>({...row,sequence:row.sequence.replace("I","ı")}));
  assert.throws(()=>proteinStudy(clone(),unicodeRequest),/submitted protein alignment/);
  assert.doesNotThrow(()=>proteinStudy(clone(),example.map(row=>({...row,sequence:row.sequence.toLowerCase()}))));
});

test("protein names use the backend's Unicode-code-point length limit",()=>{
  const name="🧬".repeat(100);
  assert.equal(name.length,200);assert.equal([...name].length,100);
  const rows=parseProteinAlignment(`>${name}\nACDEFGHIKL\n>synthetic-b\nACDEFGHIKL`);
  assert.equal(rows[0].name,name);
  assert.throws(()=>parseProteinAlignment(`>${name}🧬\nACDEFGHIKL\n>synthetic-b\nACDEFGHIKL`),/100 printable characters/);
});

test("recorded study is unchanged by validation and binds to the exact requested names and aligned sequences",()=>{
  const study=clone(),before=structuredClone(study);
  assert.deepEqual(proteinStudy(study,example),before);assert.deepEqual(study,before);
  assert.doesNotThrow(()=>proteinStudy(clone(),example.map(row=>({...row,sequence:row.sequence.toLowerCase()}))));
  for(const expected of [null,{},example.slice(1),[...example].reverse(),example.map((row,i)=>i?row:{...row,name:row.name.toUpperCase()}),
    example.map((row,i)=>i?row:{...row,sequence:"W"+row.sequence.slice(1)})]){
    assert.throws(()=>proteinStudy(clone(),expected),/submitted protein alignment/);
  }
});

test("real Python results with all-gap columns and two- or three-sequence studies pass the same renderer gate",()=>{
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const script="import json; from proto_agent.compute_protein_study import analyze_protein_comparison; rows=[{'name':'synthetic-a','sequence':'ACD-EFGHIKL'},{'name':'synthetic-b','sequence':'ACD-YFGHIKL'},{'name':'synthetic-c','sequence':'ACD-DFGHIKL'}]; print(json.dumps([analyze_protein_comparison({'aligned_sequences':rows[:n]}) for n in [2,3]]))";
  const results=JSON.parse(execFileSync(join(repo,".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),["-B","-c",script],{cwd:repo,encoding:"utf8",windowsHide:true}));
  for(const value of results){
    const study=proteinStudy(value,value.alignment.map(row=>({name:row.name,sequence:row.sequence})));
    assert.equal(study.conservation.columns[3].consensus,null);
    assert.equal(study.conservation.columns[3].entropy_bits,null);
    assert.equal(study.conservation.columns[3].occupancy_fraction,0);
    assert.equal(study.phylogeny===null,study.sequence_count===2);
  }
});

test("real backend studies preserve 100-code-point names through renderer validation and exact binding",()=>{
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const script="import json; from proto_agent.compute_protein_study import analyze_protein_comparison; rows=[{'name':chr(0x1f9ec)*100,'sequence':'acdefghikl'},{'name':'synthetic-b','sequence':'ACDEFGHIKL'},{'name':'synthetic-c','sequence':'ACDEYGHIKL'}]; print(json.dumps([analyze_protein_comparison({'aligned_sequences':rows[:n]}) for n in [2,3]], ensure_ascii=True))";
  const results=JSON.parse(execFileSync(join(repo,".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),["-B","-c",script],{cwd:repo,encoding:"utf8",windowsHide:true}));
  for(const value of results){
    const expected=value.alignment.map(row=>({name:row.name,sequence:row.sequence.toLowerCase()}));
    const study=proteinStudy(value,expected);
    assert.equal([...study.alignment[0].name].length,100);
    assert.equal(study.alignment[0].sequence,"ACDEFGHIKL");
  }
});

test("study rejects tampered source coordinates, digest, coordinate summaries and malformed schemas",()=>{
  const mutations=[
    study=>{study.study_schema="unknown";},
    study=>{study.alignment[0].sequence_sha256="0".repeat(64);},
    study=>{study.alignment[0].alignment_to_sequence[0]=1;},
    study=>{study.alignment[1].alignment_to_sequence[2]=2;},
    study=>{study.alignment[0].ungapped_sequence="W"+study.alignment[0].ungapped_sequence.slice(1);},
    study=>{study.coordinate_system.sequence_positions="1-based";},
    study=>{study.coordinate_system.alignment_columns="0-based";},
    study=>{study.alignment[0].name="injected\n>header";},
    study=>{study.alignment[0].sequence=study.alignment[0].sequence.toLowerCase();},
    study=>{study.phylogeny=null;},
    study=>{study.limitations=null;},
  ];
  for(const mutate of mutations){const study=clone();mutate(study);assert.throws(()=>proteinStudy(study));}
});

test("conservation is recomputed from aligned residues instead of trusting bounded percentages",()=>{
  for(const [field,value] of [["conservation_fraction",0.4],["occupancy_fraction",0.2],["consensus","W"],
    ["entropy_bits",1],["residue_identity_fraction",0.2],["gap_count",1],["position",2]]){
    const study=clone();study.conservation.columns[0][field]=value;
    assert.throws(()=>proteinStudy(study),/Conservation summary/);
  }
  for(const [field,value] of [["consensus","WWWWWWWWWWW"],["conserved_positions",[]],["conserved_threshold",0.9],["position_basis","0-based"]]){
    const study=clone();study.conservation[field]=value;
    assert.throws(()=>proteinStudy(study),/Conservation summary/);
  }
});

test("tree layout retains every source tip and falls back honestly for zero-length trees",()=>{
  const names=recorded.alignment.map(row=>row.name),graph=structuredClone(recorded.phylogeny.tree_graph);
  let layout=proteinTreeLayout(graph,names);
  assert.deepEqual(layout.nodes.filter(node=>node.name!==null).map(node=>node.name).sort(),[...names].sort());
  assert.ok(layout.nodes.every(node=>Number.isFinite(node.x)&&Number.isFinite(node.y)));
  graph.edges.forEach(edge=>edge.length=0);graph.display_root_edge.length=0;
  layout=proteinTreeLayout(graph,names);assert.equal(layout.scale,"topology");
  assert.ok(layout.nodes.every(node=>Number.isFinite(node.x)));
});

test("tree rejects duplicate identities, foreign or missing tips, and corrupt edge roots",()=>{
  const names=recorded.alignment.map(row=>row.name);
  const mutations=[
    graph=>{graph.nodes[0].id=graph.nodes[1].id;},
    graph=>{graph.nodes[0].id=Number.MAX_SAFE_INTEGER;},
    graph=>{graph.nodes[0].name="unrelated-source";},
    graph=>{graph.nodes[0].name=graph.nodes[1].name;},
    graph=>{graph.nodes[0].name=null;},
    graph=>{graph.edges[0].source=999;},
    graph=>{graph.edges[0].target=graph.edges[0].source;},
    graph=>{graph.edges[0].length=-1;},
    graph=>{graph.edges[0].length=NaN;},
    graph=>{graph.display_root_edge.length+=1;},
  ];
  for(const mutate of mutations){const graph=structuredClone(recorded.phylogeny.tree_graph);mutate(graph);assert.throws(()=>proteinTreeLayout(graph,names));}
});

test("tree rejects cycles and disconnected islands even when edge count looks like a tree",()=>{
  const graph={nodes:[{id:0,name:"a"},{id:1,name:"b"},{id:2,name:"c"},{id:3,name:null},{id:4,name:null},{id:5,name:null}],
    edges:[{source:3,target:4,length:0.1},{source:4,target:5,length:0.1},{source:5,target:3,length:0.1},
      {source:3,target:0,length:0.1},{source:4,target:1,length:0.1}],rooting:"arbitrary-display",display_root_edge:{source:3,target:0,length:0.1}};
  assert.throws(()=>proteinTreeLayout(graph,["a","b","c"]),/cycle/);
});

test("very large finite lengths never produce nonfinite SVG coordinates",()=>{
  const graph=structuredClone(recorded.phylogeny.tree_graph),names=recorded.alignment.map(row=>row.name);
  graph.edges.forEach(edge=>edge.length=1e307);graph.display_root_edge.length=1e307;
  assert.ok(proteinTreeLayout(graph,names).nodes.every(node=>Number.isFinite(node.x)));
  graph.edges.forEach(edge=>edge.length=Number.MAX_VALUE);graph.display_root_edge.length=Number.MAX_VALUE;
  assert.throws(()=>proteinTreeLayout(graph,names),/overflow/);
});

test("source linkage requires exact ID, sequence, verified digest and a canonical non-gap coordinate",()=>{
  const row=structuredClone(recorded.alignment[1]);
  const protein={id:row.name,sequence:row.ungapped_sequence,sequenceSha256:row.sequence_sha256};
  assert.deepEqual(linkedProteinPosition(row,3,[protein]),{proteinId:row.name,start:2,end:3});
  assert.equal(linkedProteinPosition(row,2,[protein]),undefined);
  for(const candidate of [{...protein,id:protein.id.toUpperCase()},{...protein,sequence:"W"+protein.sequence.slice(1)},
    {...protein,sequenceSha256:"0".repeat(64)}])assert.equal(linkedProteinPosition(row,3,[candidate]),undefined);
  assert.equal(linkedProteinPosition(row,3,[protein,protein]),undefined);
  for(const column of [-1,0.5,NaN,row.sequence.length])assert.equal(linkedProteinPosition(row,column,[protein]),undefined);
  row.alignment_to_sequence[3]=999;assert.equal(linkedProteinPosition(row,3,[protein]),undefined);
  row.alignment_to_sequence[3]=2;row.sequence_sha256="0".repeat(64);
  assert.equal(linkedProteinPosition(row,3,[{...protein,sequenceSha256:row.sequence_sha256}]),undefined);
});
