import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { requestManagedResearch } from '../src/main/services/research-study-commands.ts';
import { ResearchProjectStore } from '../src/main/services/research-project-store.ts';
import { ManagedResearchRequestSchema } from '../src/shared/managed-research.ts';

const tool={id:'descriptive_statistics',title:'Descriptive statistics',description:'Test-only catalog',available:true,dependency:[],implementation:'test-fixture',upstream_functions:[],missing_dependencies:[],input_schema:{type:'object',properties:{values:{type:'array',items:{type:'number'},minItems:1}},required:['values'],additionalProperties:false}};
const source={values:[1,2,3,4,5]};
async function fixture(t) {
  const parent=resolve('build');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'managed-research-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'sources'));await writeFile(join(root,'sources','observations.json'),JSON.stringify(source));
  const calls=[],definitions=new Map();
  let enabled=true;
  const deps={executionEnabled:()=>enabled,catalog:async()=>({ok:true,execution:'local',tools:[tool],upstream:{}}),fingerprint:async()=>({ok:true,materials:{runtime:{testRuntime:'1'},implementation:{method:tool.id}}}),workflows:{async request(input){
    calls.push(input);
    if(input.action==='save') {const workflow={...input.draft,id:randomUUID(),studyId:input.studyId,revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};definitions.set(workflow.id,workflow);return {workflow};}
    if(input.action==='get')return {workflow:definitions.get(input.workflowId)};
    if(input.action==='preview')return {preview:{schema:'proto-agent.workflow-preview.v1',workflowId:input.workflowId,workflowRevision:1,requestedForceSteps:[],forcedClosure:[],steps:[],comparisonWarnings:[],canStart:true,resourceEstimate:{state:'unknown',reason:'Test fixture has no resource estimate.'},planSha256:'a'.repeat(64),generatedAt:new Date().toISOString()}};
    if(input.action==='start')return {execution:{id:randomUUID(),workflowId:input.workflowId,workflowRevision:1,studyId:input.studyId,status:'pending',steps:[]}};
    throw Error('Unexpected action '+input.action);
  }}};
  const invoke=input=>requestManagedResearch(root,input,deps);
  const created=await invoke({action:'create',name:'Bounded reference study',question:'What is the mean of these declared development observations?'});
  const draft={workflow:{name:'Mean reference',description:'Frozen development data',steps:[{id:'summary',title:tool.title,tool:tool.id,arguments:source,bindings:[]}]},datasets:[{id:'observations',version:1,sourcePath:'sources/observations.json',entityIds:['development-series'],units:['1'],referenceVersion:'synthetic-reference-v1'}],stepSemantics:[{stepId:'summary',role:'required',datasetIds:['observations'],assumptions:['Synthetic reference observations only. No biological inference.']}]};
  const compile=()=>invoke({action:'compile',studyId:created.study.id,expectedStudyRevision:created.study.revision,draft});
  return {root,invoke,created,draft,compile,calls,deps,disable:()=>{enabled=false;}};
}
test('Study commands freeze source-bound plans without executing and reopen a full capsule',async t=>{
  const f=await fixture(t), compiled=await f.compile();
  assert.ok(compiled.plan);assert.equal(f.calls.some(call=>call.action==='start'),false);
  const opened=await f.invoke({action:'get',studyId:f.created.study.id});assert.equal(opened.plans[0].id,compiled.plan.id);
  const exported=await f.invoke({action:'capsule',studyId:f.created.study.id,mode:'full'});
  const bytes=await readFile(join(f.root,exported.capsule.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),exported.capsule.sha256);
  const other=join(f.root,'second-project');await mkdir(other);
  const target=ResearchProjectStore.open(other);
  try{const report=target.importCapsule(bytes);assert.equal(report.integrity,'verified');const record=target.getVersion(compiled.plan.id);assert.equal(record.origin,'imported-unverified');const specs=target.listVersions(f.created.study.id,'study-spec');assert.equal(target.getVersion(specs[0].versionId).references.length,1);}finally{target.close();}
});
test('unsupported declared units never save a workflow or start computation',async t=>{
  const f=await fixture(t);f.draft.datasets[0].units=['bananas-per-second'];
  const result=await f.compile();assert.ok(result.diagnostics.some(item=>item.code==='UNIT_UNSUPPORTED'));assert.equal(f.calls.length,0);
});
test('literal computation cannot cite unrelated dataset bytes',async t=>{
  const f=await fixture(t);f.draft.workflow.steps[0].arguments={values:[100,200]};
  await assert.rejects(f.compile(),/DATASET_ARGUMENT_MISMATCH/);assert.equal(f.calls.length,0);
});
test('a source change blocks a frozen plan before start',async t=>{
  const f=await fixture(t),compiled=await f.compile();
  await writeFile(join(f.root,'sources','observations.json'),JSON.stringify({values:[999]}));
  await assert.rejects(f.invoke({action:'start',studyId:f.created.study.id,planId:compiled.plan.id,expectedPreviewSha256:'a'.repeat(64)}),/DATASET_ARGUMENT_MISMATCH|PLAN_STALE/);
  assert.equal(f.calls.some(call=>call.action==='start'),false);
});
test('disabled computation and cross-Study plan substitution fail before execution',async t=>{
  const f=await fixture(t),compiled=await f.compile();f.disable();
  await assert.rejects(f.invoke({action:'start',studyId:f.created.study.id,planId:compiled.plan.id,expectedPreviewSha256:'a'.repeat(64)}),/Enable computations/);
  const other=await f.invoke({action:'create',name:'Other Study',question:'A different question'});
  await assert.rejects(f.invoke({action:'preview',studyId:other.study.id,planId:compiled.plan.id}),/PLAN_SCOPE_MISMATCH/);
  assert.equal(f.calls.some(call=>call.action==='start'),false);
});
test('current reviewed plan invokes the existing workflow with the reviewed preview identity',async t=>{
  const f=await fixture(t),compiled=await f.compile();
  const result=await f.invoke({action:'start',studyId:f.created.study.id,planId:compiled.plan.id,expectedPreviewSha256:compiled.preview.planSha256});
  assert.equal(result.execution.status,'pending');const dispatched=f.calls.find(call=>call.action==='start');assert.equal(dispatched.expectedPlanSha256,compiled.preview.planSha256);assert.equal(dispatched.workflowId,compiled.plan.workflowId);
});
test('unresolved bound arguments report the runtime probe gap instead of inventing values',async t=>{
  const f=await fixture(t);f.draft.workflow.steps[0].bindings=[{argument:'values',fromStep:'prior',pointer:'/values',type:'array'}];
  await assert.rejects(f.compile(),/MANAGED_RUNTIME_PROBE_UNSUPPORTED/);assert.equal(f.calls.length,0);
});
test('IPC rejects forged production context or output paths on a Study command',()=>{
  assert.equal(ManagedResearchRequestSchema.safeParse({action:'list',context:{approved:true}}).success,false);
  assert.equal(ManagedResearchRequestSchema.safeParse({action:'capsule',studyId:randomUUID(),mode:'full',path:'outside'}).success,false);
});
