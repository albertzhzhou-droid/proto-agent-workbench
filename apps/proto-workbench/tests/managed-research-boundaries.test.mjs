import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { requestManagedResearch } from '../src/main/services/research-study-commands.ts';
import { ResearchProjectStore } from '../src/main/services/research-project-store.ts';
import { requestComputeStudies } from '../src/main/services/compute-studies.ts';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const base=join(repository,'build','managed-research-boundaries');await mkdir(base,{recursive:true});
const runRoot=await mkdtemp(join(base,'host-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const tool={id:'descriptive_statistics',title:'Statistics fixture',description:'Synthetic software fixture only',available:true,dependency:[],implementation:'synthetic-format',upstream_functions:[],missing_dependencies:[],input_schema:{type:'object',properties:{values:{type:'array',items:{type:'number'}}},required:['values'],additionalProperties:false}};
const source={values:[1,2,3]};
// Fingerprint fields below are synthetic format evidence. No worker/runtime or scientific result is certified by these fixtures.
function fixtureFingerprint(request){
  const materials={request:structuredClone(request),files:{},runtime:{fixture:'only'},implementation:{method:request.tool}};
  return {ok:true,schema_version:'proto-agent.compute-fingerprint.v1',fingerprint_sha256:hash(JSON.stringify(materials)),cacheable:true,reasons:[],materials};
}
async function put(root,path,bytes){const full=join(root,path);await mkdir(dirname(full),{recursive:true});await writeFile(full,bytes);}
async function fixture(name){
  const root=join(runRoot,name);await mkdir(root);await put(root,'sources/observations.json',JSON.stringify(source));
  const definitions=new Map(), calls=[], probes=[];
  const env={root,calls,probes,execution:null,tool:structuredClone(tool)};
  const deps={executionEnabled:()=>true,catalog:async()=>({ok:true,execution:'local',tools:[env.tool],upstream:{}}),fingerprint:async request=>{probes.push(request);return fixtureFingerprint(request);},workflows:{async request(input){
    calls.push(input);
    if(input.action==='save'){const workflow={...input.draft,id:randomUUID(),studyId:input.studyId,revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};definitions.set(workflow.id,workflow);return {workflow};}
    if(input.action==='get')return {workflow:definitions.get(input.workflowId),executions:[]};
    if(input.action==='preview')return {preview:{workflowId:input.workflowId,workflowRevision:1,canStart:true,planSha256:'a'.repeat(64),steps:[]}};
    if(input.action==='get-execution')return {execution:{...env.execution,workflowId:input.workflowId,studyId:input.studyId}};
    throw Error('Unexpected fixture action: '+input.action);
  }}};
  env.invoke=request=>requestManagedResearch(root,request,deps);
  env.study=(await env.invoke({action:'create',name:'Source binding fixture',question:'How do the declared fixture values compare?'})).study;
  env.draft={workflow:{name:'Fixture statistics',description:'Synthetic software tests',steps:[{id:'summary',title:tool.title,tool:tool.id,arguments:structuredClone(source),bindings:[]}]},datasets:[{id:'observations',version:1,sourcePath:'sources/observations.json',entityIds:['fixture'],units:['1'],referenceVersion:'synthetic-v1'}],stepSemantics:[{stepId:'summary',role:'required',datasetIds:['observations'],assumptions:['Synthetic fixture values; no scientific validity claim.']}]};
  env.compile=(study=env.study)=>env.invoke({action:'compile',studyId:study.id,expectedStudyRevision:study.revision,draft:env.draft});
  return env;
}

test('shared source bytes have one object identity on both the StudySpec and frozen plan',async()=>{
  const env=await fixture('dedup');
  env.draft.datasets.push({...env.draft.datasets[0],id:'replicated-declaration'});
  env.draft.stepSemantics[0].datasetIds.push('replicated-declaration');
  const compiled=await env.compile();assert.ok(compiled.plan);
  const store=ResearchProjectStore.open(env.root);
  try{
    const plan=store.getVersion(compiled.plan.id),spec=store.getHead(env.study.id,'study-spec');
    assert.equal(plan.references.length,1);assert.deepEqual(plan.references,spec.references);
    assert.equal(plan.references[0].sha256,hash(Buffer.from(JSON.stringify(source))));
    assert.equal(plan.value.plan.spec.datasets.length,2);
  }finally{store.close();}
});

test('corruption of retained source bytes blocks plan reopening, preview and capsule export',async()=>{
  const env=await fixture('corrupt-source'),compiled=await env.compile();
  const store=ResearchProjectStore.open(env.root);let identity;
  try{identity=store.getVersion(compiled.plan.id).references[0];}finally{store.close();}
  await writeFile(join(env.root,'.proto','objects','sha256',identity.sha256.slice(0,2),identity.sha256),Buffer.alloc(identity.size,42));
  await assert.rejects(env.invoke({action:'get',studyId:env.study.id}),error=>error?.code==='OBJECT_CORRUPT');
  await assert.rejects(env.invoke({action:'preview',studyId:env.study.id,planId:compiled.plan.id}),error=>error?.code==='OBJECT_CORRUPT');
  await assert.rejects(env.invoke({action:'capsule',studyId:env.study.id,mode:'full'}),error=>error?.code==='OBJECT_CORRUPT');
});

test('absolute, traversal, stream and project control paths reject before any source/runtime probe',async()=>{
  const env=await fixture('invalid-paths');
  for(const path of [join(env.root,'sources','observations.json'),'sources/../sources/observations.json','sources//observations.json','sources/observations.json:stream','sources/NUL.txt','.proto/project.sqlite','.git/config','.codex/config.toml','sources/.env.local','sources/id_ed25519']){
    env.draft.datasets[0].sourcePath=path;
    await assert.rejects(env.compile(),/DATASET_PATH_INVALID|DATASET_SOURCE_CONTROLLED/);
  }
  assert.equal(env.probes.length,0);assert.equal(env.calls.length,0);
});

test('source ancestors cannot be junctions while normalized backslash paths remain accepted',async()=>{
  const env=await fixture('linked-source'),outside=join(runRoot,'linked-source-other');await mkdir(outside);
  await put(outside,'observations.json',JSON.stringify(source));
  await symlink(outside,join(env.root,'linked'),process.platform==='win32'?'junction':'dir');
  env.draft.datasets[0].sourcePath='linked/observations.json';
  await assert.rejects(env.compile(),/symbolic links or junctions/);assert.equal(env.probes.length,0);
  if(process.platform==='win32'){
    env.draft.datasets[0].sourcePath='sources\\observations.json';
    const result=await env.compile();assert.ok(result.plan);
  }
});

test('inline JSON equality cannot authorize an undeclared real file input',async()=>{
  const env=await fixture('file-probe-binding');
  env.tool={...env.tool,id:'fixture_file_reader',file_inputs:{path:{kind:'file'}},input_schema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
  const argumentsValue={path:'sources/unrelated.csv'};
  await put(env.root,'sources/observations.json',JSON.stringify(argumentsValue));
  env.draft.workflow.steps[0].tool=env.tool.id;env.draft.workflow.steps[0].arguments=argumentsValue;
  await assert.rejects(env.compile(),/DATASET_ARGUMENT_MISMATCH/);
  assert.equal(env.probes.length,0);assert.equal(env.calls.length,0);
  argumentsValue.path='.proto/project.sqlite';
  await put(env.root,'sources/observations.json',JSON.stringify(argumentsValue));
  await assert.rejects(env.compile(),/DATASET_SOURCE_CONTROLLED/);assert.equal(env.probes.length,0);
});

async function publishRun(root){
  const runId=randomUUID().replaceAll('-',''),prefix=`build/compute/${runId}`,sourcePath=`sources/${runId}.json`;
  const request={tool:tool.id,arguments:source},input=Buffer.from(JSON.stringify(request)+'\n'),result=Buffer.from(JSON.stringify({mean:2,fixture:'synthetic producer; not executed science'})+'\n');
  const fingerprint=fixtureFingerprint(request),{ok:_,schema_version:__,...executionFingerprint}=fingerprint;
  const record=(name,path,bytes)=>({name,path,sha256:hash(bytes),size:bytes.length});
  const manifest={schema_version:'proto-agent.compute.v1',ok:true,run_id:runId,tool:tool.id,created_at:new Date().toISOString(),implementation:'synthetic-format-fixture',implementation_version:1,upstream_commit:null,method_references:[],upstream_functions:[],runtime:{fixture:'not-executed'},review_status:'human_review_required',scope:'Synthetic saved format only. The verified_unchanged field exercises retained fingerprint checks; no scientific worker executed.',source:{path:sourcePath,sha256:hash(input)},inputs:{request_snapshot:`${prefix}/input.json`},artifacts:[`${prefix}/result.json`],result_sha256:hash(result),execution_fingerprint:{...executionFingerprint,verified_unchanged:true}};
  const manifestBytes=Buffer.from(JSON.stringify(manifest)+'\n');
  const provenance={schema_version:'proto-agent.provenance.v1',run_id:runId,created_at:manifest.created_at,subject:record('manifest',`compute/${runId}/manifest.json`,manifestBytes),materials:[record('input:request_snapshot',`${prefix}/input.json`,input)],artifacts:[record('artifact:0',`compute/${runId}/result.json`,result)],tool:{name:'fixture',version:'1',python:'not-executed',platform:'fixture'},policy:{digest:'sha256',signature:'none',path_mode:'root-relative-single-link-regular-files-no-reparse-points'}};
  for(const [path,bytes] of [[sourcePath,input],[`${prefix}/input.json`,input],[`${prefix}/result.json`,result],[`${prefix}/manifest.json`,manifestBytes],[`${prefix}/provenance.json`,Buffer.from(JSON.stringify(provenance)+'\n')]])await put(root,path,bytes);
  const opened=(await requestComputeStudies(root,{action:'open-run',runId})).run;
  assert.equal(opened.integrity.status,'verified',JSON.stringify(opened.integrity));
  return {runId,binding:opened.binding,request,fingerprint,createdAt:manifest.created_at};
}

test('the same verified run can be retained by two Studies without colliding immutable version IDs',async()=>{
  const env=await fixture('cross-study-run');
  const first=await env.compile();
  const secondStudy=(await env.invoke({action:'create',name:'Second fixture Study',question:'A separate comparison of the same saved fixture'})).study;
  const second=await env.compile(secondStudy),run=await publishRun(env.root),executionId=randomUUID();
  env.execution={id:executionId,workflowId:first.plan.workflowId,workflowRevision:1,studyId:env.study.id,name:env.draft.workflow.name,status:'succeeded',createdAt:run.createdAt,updatedAt:run.createdAt,finishedAt:run.createdAt,owner:{pid:process.pid,instanceId:randomUUID()},forceSteps:[],steps:[{stepId:'summary',title:tool.title,tool:tool.id,status:'succeeded',operationId:randomUUID(),startedAt:run.createdAt,finishedAt:run.createdAt,request:run.request,fingerprint:run.fingerprint,runId:run.runId,binding:run.binding}]};
  const firstEvidence=await env.invoke({action:'execution',studyId:env.study.id,planId:first.plan.id,executionId});
  const secondEvidence=await env.invoke({action:'execution',studyId:secondStudy.id,planId:second.plan.id,executionId});
  assert.equal(firstEvidence.evidence.verifiedRuns,1,JSON.stringify(firstEvidence.diagnostics));assert.equal(secondEvidence.evidence.verifiedRuns,1,JSON.stringify(secondEvidence.diagnostics));
  const store=ResearchProjectStore.open(env.root);
  try{
    const firstRecord=store.getHead(env.study.id,'run-evidence'),secondRecord=store.getHead(secondStudy.id,'run-evidence');
    assert.notEqual(firstRecord.versionId,secondRecord.versionId);
    assert.deepEqual(firstRecord.object,secondRecord.object);
    assert.equal(firstRecord.value.runId,run.runId);assert.equal(secondRecord.value.runId,run.runId);
  }finally{store.close();}
});
