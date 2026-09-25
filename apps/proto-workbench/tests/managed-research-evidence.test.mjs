import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compileResearchPlan, deriveMethodContract, researchHash } from '../src/main/services/research-plan-compiler.ts';
import { collectManagedResearchEvidence } from '../src/main/services/managed-research-evidence.ts';

const hash = char => char.repeat(64), sourceHash = hash('a');
const runtime={runtime:{python:'test-runtime'},implementation:{sha256:hash('b')}};
const runtimeHash=researchHash(runtime);
function environment(optional=false){
  const tool={id:'descriptive_statistics',title:'Recorded statistics',description:'Software-only evidence fixture',available:true,dependency:[],implementation:'test-adapter',upstream_functions:[],missing_dependencies:[],input_schema:{type:'object',additionalProperties:false,required:['values'],properties:{values:{type:'array',items:{type:'number'}}}}};
  const catalog={ok:true,execution:'local',tools:[tool],upstream:{}};
  const step={id:'required',title:'Required statistics',tool:tool.id,arguments:{values:[2,4,6]},bindings:[],role:'required',datasetIds:['dataset-1'],methodIdentity:{contractSha256:deriveMethodContract(tool).contractSha256,runtimeSha256:runtimeHash},assumptions:['This fixture tests software bindings only.']};
  const spec={schemaVersion:'proto.study-spec.v1',studyId:randomUUID(),title:'Host checked evidence',question:'What do retained data say?',datasets:[{id:'dataset-1',version:1,sourcePath:'data.json',sha256:sourceHash,entityIds:['sample:S1'],units:['1'],referenceVersion:'reference-v1'}],steps:[step,...(optional?[{...structuredClone(step),id:'optional',title:'Optional exploration',role:'optional-exploration'}]:[])],proofObligations:[]};
  const compiled=compileResearchPlan(spec,catalog,{runtimeFingerprints:{[tool.id]:runtimeHash},datasetFingerprints:{'dataset-1':sourceHash}});assert.equal(compiled.ok,true);
  const binding={workflowId:randomUUID(),workflowRevision:1},id=randomUUID(),runId='c'.repeat(32),createdAt=new Date().toISOString();
  const runBinding={tool:tool.id,createdAt,manifestSha256:hash('c'),provenanceSha256:hash('d'),inputSha256:hash('e'),resultSha256:hash('f')};
  const opened={runId,tool:tool.id,createdAt,binding:runBinding,integrity:{status:'verified',checkedAt:createdAt,code:'VERIFIED',message:'Test host verified fixture',authority:'unsigned-local-artifacts'},sourceFreshness:{status:'current',checkedAt:createdAt,details:[]},request:{tool:tool.id,arguments:{values:[2,4,6]}},receipt:{ok:true,run_id:runId,tool:tool.id,result:{mean:4},execution_fingerprint:{fingerprint_sha256:hash('a'),cacheable:true,reasons:[],materials:{request:{},files:{},...structuredClone(runtime)},verified_unchanged:true}}};
  const execution={id,...binding,studyId:spec.studyId,name:spec.title,status:'succeeded',createdAt,updatedAt:createdAt,owner:{pid:123,instanceId:randomUUID()},forceSteps:[],steps:[{stepId:'required',title:step.title,tool:tool.id,status:'succeeded',runId,binding:structuredClone(runBinding)},...(optional?[{stepId:'optional',title:'Optional exploration',tool:tool.id,status:'failed',error:{code:'KNOWN_TOOL_ERROR',message:'Preserved failed exploration.',executionState:'tool-error'}}]:[])]};
  return {plan:compiled.plan,binding,execution,opened,openRun:async()=>structuredClone(opened),sourceHash:async()=>sourceHash};
}

test('host evidence binds a real workflow result and generated proof obligations without scientific promotion',async()=>{
  const input=environment(),result=await collectManagedResearchEvidence(input);
  assert.equal(result.verifiedRuns,1);assert.equal(result.missingRuns,0);assert.equal(result.completion.complete,true);
  assert.equal(result.graph.nodes.filter(node=>node.kind==='artifact')[0].sha256,input.opened.binding.resultSha256);
  assert.ok(result.graph.edges.some(edge=>edge.type==='consumes'));assert.ok(result.graph.edges.some(edge=>edge.type==='produces'));
  assert.equal(result.graph.nodes.some(node=>node.kind==='review'),false);
});
test('cross-Study, workflow revision, method identity and mutated plan reject before any source or run read',async()=>{
  for(const mutate of [input=>{input.execution.studyId=randomUUID()},input=>{input.execution.workflowRevision=2},input=>{input.execution.workflowId=randomUUID()},input=>{input.execution.steps[0].tool='different_tool'},input=>{input.plan.spec.question='Tampered'}]){
    const input=environment();let reads=0;input.sourceHash=async()=>{reads++;return sourceHash};input.openRun=async()=>{reads++;return input.opened};mutate(input);
    await assert.rejects(collectManagedResearchEvidence(input));assert.equal(reads,0);
  }
});
test('byte integrity and current source freshness remain independent after source changes',async()=>{
  const input=environment();input.sourceHash=async()=>hash('d');input.verifyDatasetSnapshot=async()=>true;
  const result=await collectManagedResearchEvidence(input);assert.equal(result.verifiedRuns,1);assert.equal(result.completion.complete,false);
  const artifact=result.graph.nodes.find(node=>node.kind==='artifact'),dataset=result.graph.nodes.find(node=>node.kind==='dataset');
  assert.equal(artifact.integrity,'verified');assert.equal(artifact.freshness,'stale');assert.equal(dataset.integrity,'verified');assert.equal(dataset.freshness,'stale');
});
test('source unavailable blocks completion without relabeling intact historical results as damaged',async()=>{
  const input=environment();input.sourceHash=async()=>{throw new Error('source missing')};const result=await collectManagedResearchEvidence(input);
  assert.equal(result.completion.complete,false);assert.equal(result.graph.nodes.find(node=>node.kind==='artifact').integrity,'verified');assert.ok(result.diagnostics.some(item=>item.code==='DATASET_CURRENT_UNAVAILABLE'));
});
test('saved run request, runtime, receipt identity and retained binding must all match the plan',async()=>{
  for(const mutate of [run=>{run.request.arguments.values=[9]},run=>{run.receipt.execution_fingerprint.materials.runtime.python='other'},run=>{run.binding.resultSha256=hash('a')},run=>{run.receipt.run_id='d'.repeat(32)},run=>{run.receipt.preview=true},run=>{delete run.receipt.execution_fingerprint},run=>{run.integrity.status='damaged'}]){
    const input=environment();mutate(input.opened);const result=await collectManagedResearchEvidence(input);assert.equal(result.completion.complete,false);assert.equal(result.runs.length,0);assert.equal(result.missingRuns,1);assert.ok(result.diagnostics.some(item=>item.code==='RUN_EVIDENCE_UNVERIFIED'));
  }
});
test('known optional failure remains visible without blocking, but unknown optional effect always blocks',async()=>{
  const input=environment(true);input.execution.status='failed';let result=await collectManagedResearchEvidence(input);
  assert.equal(result.completion.complete,true,JSON.stringify(result.completion));assert.deepEqual(result.completion.optionalFailures,['optional']);
  input.execution.steps[1].error.executionState='effect-unknown';result=await collectManagedResearchEvidence(input);assert.equal(result.completion.complete,false);assert.ok(result.completion.blockers.some(item=>item.code==='UNKNOWN_EFFECT'));
});
test('later known optional failure does not erase an unknown previous attempt',async()=>{
  const input=environment(true),previous=structuredClone(input.execution);previous.id=randomUUID();previous.steps[1].error.executionState='effect-unknown';input.priorExecutions=[previous];
  const result=await collectManagedResearchEvidence(input);assert.equal(result.completion.complete,false);assert.equal(result.facts.attempts.length,4);assert.ok(result.completion.blockers.some(item=>item.code==='UNKNOWN_EFFECT'));
});
test('active or unconfirmed cancelled work remains blocked even when optional',async()=>{
  for(const status of ['running','pending','cancelled','interrupted']){
    const input=environment(true);input.execution.steps[1].status=status;delete input.execution.steps[1].error;
    const result=await collectManagedResearchEvidence(input);assert.equal(result.completion.complete,false,status);
  }
});
test('upstream numeric binding is resolved from the verified saved result and a substituted downstream value rejects',async()=>{
  const input=environment();const spec=structuredClone(input.plan.spec),tool={id:'scale',title:'Scale',description:'Software fixture',available:true,dependency:[],implementation:'test-adapter',upstream_functions:[],missing_dependencies:[],input_schema:{type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'number'}}}};
  spec.steps.push({...structuredClone(spec.steps[0]),id:'scale',title:'Scale',tool:'scale',arguments:{},bindings:[{argument:'value',fromStep:'required',pointer:'/mean',type:'number'}],methodIdentity:{contractSha256:deriveMethodContract(tool).contractSha256,runtimeSha256:runtimeHash}});
  const first={...structuredClone(tool),id:'descriptive_statistics',input_schema:structuredClone(input.plan.methods[0].inputSchema),title:'Recorded statistics'};
  // Retain the same canonical contract fields used by the original fixture.
  spec.steps[0].methodIdentity.contractSha256=deriveMethodContract(first).contractSha256;
  const compiled=compileResearchPlan(spec,{ok:true,execution:'local',upstream:{},tools:[first,tool]},{runtimeFingerprints:{descriptive_statistics:runtimeHash,scale:runtimeHash},datasetFingerprints:{'dataset-1':sourceHash}});assert.equal(compiled.ok,true);input.plan=compiled.plan;
  const downstream=structuredClone(input.opened);downstream.runId='d'.repeat(32);downstream.tool='scale';downstream.binding.tool='scale';downstream.receipt.tool='scale';downstream.receipt.run_id=downstream.runId;downstream.request={tool:'scale',arguments:{value:4}};
  input.execution.steps.push({stepId:'scale',title:'Scale',tool:'scale',status:'succeeded',runId:downstream.runId,binding:downstream.binding});input.openRun=async id=>structuredClone(id===downstream.runId?downstream:input.opened);
  let result=await collectManagedResearchEvidence(input);assert.equal(result.completion.complete,true,JSON.stringify({completion:result.completion,diagnostics:result.diagnostics}));assert.equal(result.verifiedRuns,2);
  downstream.request.arguments.value=99;result=await collectManagedResearchEvidence(input);assert.equal(result.completion.complete,false);assert.ok(result.diagnostics.some(item=>item.message==='RUN_REQUEST_PLAN_MISMATCH'));
});
