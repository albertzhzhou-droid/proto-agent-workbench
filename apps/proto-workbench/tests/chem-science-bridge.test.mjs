import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChemScienceService,summarizeChemScience} from '../src/main/services/chem-science.ts';
import {ResearchToolBridge,researchSignature,CHEMISTRY_RESEARCH_GUIDANCE} from '../src/main/services/research-tools.ts';
import {isResearchBaseline} from '../src/shared/research-baseline.ts';
import {createServer} from 'node:http';
import {chemSciencePreview} from '../src/dev/chem-science-preview.ts';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
async function setup(t) {
  const base=join(repo,'build/chem-science-qa/bridge');await mkdir(base,{recursive:true});
  const workspace=await mkdtemp(join(base,'run-'));
  const service=new ChemScienceService({repoRoot:repo,workspacePath:workspace});
  t.after(()=>service.close());return {service,workspace};
}

test('real chemistry catalog, simulation, saved evidence and immutable readback',{timeout:60000},async t=>{
  const {service,workspace}=await setup(t);
  const catalog=await service.request({action:'catalog'});
  assert.equal(catalog.ok,true,JSON.stringify(catalog.error));
  assert.ok(catalog.data.operators.length>=10);
  assert.ok(catalog.data.operators.every(op=>op.input_schema&&op.example_input));
  const result=await service.request({action:'run',operator:'simulate_reaction_network',input:{example:'reversible',points:51}});
  assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.data.status,'completed');
  assert.equal(result.data.result.time_s.length,51);
  const curves=result.data.result.series;
  for(let i=0;i<51;i++)assert.ok(Math.abs(curves.reduce((total,s)=>total+s.concentration[i],0)-1)<1e-8);
  assert.ok(result.data.provenance.source_sha256);
  const restored=await service.request({action:'read',runId:result.data.runId});
  assert.deepEqual(restored.data.result,result.data.result);
  const history=await service.request({action:'history'});
  assert.equal(history.data.runs.length,1);assert.equal(history.data.runs[0].result,undefined);
  const summary=summarizeChemScience(result);
  assert.equal(summary.data.result.time_s.count,51);assert.equal(summary.read.arguments.runId,result.data.runId);
  assert.ok(summary.data.artifacts.result.endsWith('/result.json'));
  const duplicate=await service.request({action:'run',operator:'simulate_reaction_network',input:{example:'consecutive'},runId:result.data.runId});
  assert.equal(duplicate.ok,false);
  assert.deepEqual((await service.request({action:'read',runId:result.data.runId})).data.result,result.data.result);
  await writeFile(join(workspace,result.data.artifacts.result),'{}');
  const altered=await service.request({action:'read',runId:result.data.runId});
  assert.equal(altered.ok,false);assert.match(altered.error.message,/hash mismatch/);
});

test('real error, time limit and cancellation each retain an explicit failed receipt',{timeout:60000},async t=>{
  const {service}=await setup(t);await service.request({action:'catalog'});
  const invalid=await service.request({action:'run',operator:'analyze_molecule',input:{smiles:'not a smiles'}});
  assert.equal(invalid.ok,false);assert.equal(invalid.data.status,'error');assert.ok(invalid.data.artifacts.input);
  const timeout=await service.request({action:'run',operator:'analyze_molecule',input:{smiles:'CCO'},timeoutMs:100});
  assert.equal(timeout.ok,false);assert.equal(timeout.error.code,'TIMEOUT');assert.equal(timeout.data.status,'error');
  const runId=randomUUID();
  const pending=service.request({action:'run',operator:'simulate_reaction_network',input:{example:'parallel',points:1001},runId});
  await new Promise(resolve=>setTimeout(resolve,35));
  const cancel=await service.request({action:'cancel',runId});
  const result=await pending;
  assert.equal(result.ok,false);assert.equal(result.data.status,'cancelled');assert.equal(result.error.code,'CANCELLED');
  assert.equal(cancel.data.status,'cancelled');
  const saved=await service.request({action:'read',runId});assert.equal(saved.data.status,'cancelled');
  for(const request of [{action:'read',runId:'../outside'},{action:'run',operator:'workflow_approve',input:{}},{action:'run',operator:'analyze_molecule; calc',input:{}},{action:'run',operator:'analyze_molecule',input:{smiles:'CCO'},timeoutMs:300000}])assert.equal((await service.request(request)).ok,false);
  const controller=new AbortController();controller.abort();
  assert.equal((await service.request({action:'catalog'},controller.signal)).ok,false);
});

test('both Chat editions resolve one chemistry operator and preserve canonical deduplication',{timeout:60000},async t=>{
  const {service,workspace}=await setup(t);
  const mcp={tools:async()=>[],capabilities:async()=>({execution:{available:false,mode:'disabled'}})};
  const bridge=new ResearchToolBridge(mcp,{canonicalRootPath:async()=>workspace},undefined,service);
  const session={id:randomUUID(),moduleSettings:{profile:"custom",enabledOptional:["analysis.chemistry"]}},signal=new AbortController().signal;
  const catalog=await bridge.execute('science_catalog',{query:'analyze_molecule'},session,signal);
  assert.equal(catalog.tools.filter(tool=>tool.id==='chemistry.analyze_molecule').length,1);
  assert.equal(researchSignature('science_run',{name:'rdkit.analyze',arguments:{smiles:'CCO'}}),researchSignature('science_run',{name:'chemistry.analyze_molecule',arguments:{smiles:'CCO'}}));
  const result=await bridge.execute('science_run',{name:'rdkit.analyze',arguments:{smiles:'CCO'}},session,signal);
  assert.equal(result.ok,true);assert.ok(result.data.result);assert.ok(result.data.artifacts.manifest);
  const read=await bridge.execute('science_run',{name:'chemistry.read',arguments:{runId:result.data.runId}},session,signal);
  assert.equal(read.ok,true);assert.equal(read.data.runId,result.data.runId);
  const guide=await bridge.execute('science_run',{name:'openscience.chemistry',arguments:{}},session,signal);
  assert.equal(guide.source,CHEMISTRY_RESEARCH_GUIDANCE.source);
  assert.ok(guide.procedure.some(step=>step.includes('atomistic')));
  await assert.rejects(bridge.execute('science_run',{name:'chemistry.read',arguments:{runId:result.data.runId,action:'run'}},session,signal));
  await assert.rejects(bridge.execute('science_run',{name:'chemistry.workflow_approve',arguments:{}},session,signal),/not exposed/);
});

test('baseline requires the exact live publisher key and Q4_K_M quantization',()=>{
  assert.equal(isResearchBaseline({id:'provider-generated-hash',providerModelId:'unsloth/qwen3.8-27b',quantization:'Q4_K_M'}),true);
  assert.equal(isResearchBaseline({id:'qwen/qwen3.8-27b',quantization:'Q8_0'}),false);
  assert.equal(isResearchBaseline({id:'unsloth/qwen3.8-27b-obliterated',quantization:'Q4_K_M'}),false);
  assert.equal(isResearchBaseline({id:'unsloth/qwen3.8-27b',quantization:'Q8_0'}),false);
});

test('source preview serves real catalog only through the same-origin POST boundary',{timeout:45000},async t=>{
  let middleware;
  const server=createServer((request,response)=>middleware(request,response,()=>{response.statusCode=404;response.end();}));
  chemSciencePreview().configureServer({config:{root:join(repo,'apps/proto-workbench')},httpServer:server,middlewares:{use:fn=>{middleware=fn;}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const headers={'Content-Type':'application/json',Origin:origin,'Sec-Fetch-Site':'same-origin'};
  const live=await fetch(`${origin}/__proto/chem-science`,{method:'POST',headers,body:JSON.stringify({action:'catalog'})});
  assert.equal(live.status,200);assert.ok((await live.json()).data.operators.length>=10);
  const cross=await fetch(`${origin}/__proto/chem-science`,{method:'POST',headers:{...headers,Origin:'https://unrelated.example'},body:'{"action":"catalog"}'});
  assert.equal(cross.status,403);
  const query=await fetch(`${origin}/__proto/chem-science?operator=run`,{method:'POST',headers,body:'{"action":"catalog"}'});
  assert.equal(query.status,405);
  const get=await fetch(`${origin}/__proto/chem-science`,{headers});assert.equal(get.status,405);
});
