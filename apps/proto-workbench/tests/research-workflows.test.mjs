import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {hostname} from 'node:os';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {ResearchWorkflowService} from '../src/main/services/research-workflows.ts';
import {requestComputeStudies} from '../src/main/services/compute-studies.ts';
import {ToolExecutionJournal} from '../src/main/services/tool-execution-journal.ts';
import {invokeJournaledTool} from '../src/main/services/execution-kernel.ts';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const base=join(repository,'build','research-workflows-20260922');await mkdir(base,{recursive:true});
const runRoot=await mkdtemp(join(base,'service-regressions-'));
await writeFile(join(runRoot,'scope.json'),JSON.stringify({scope:'Synthetic fixed-compute producer and fingerprint fixtures; real SQLite, Compute artifact verification, ownership and DAG orchestration. No scientific/model execution claim.',createdAt:new Date().toISOString()}));
const hash=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
const data=value=>JSON.parse(JSON.stringify(value));
const hasCode=code=>error=>error?.code===code;
const fileRecord=(name,path,bytes)=>({name,path,sha256:hash(bytes),size:bytes.length});
async function put(root,path,bytes){const full=join(root,...path.split('/'));await mkdir(dirname(full),{recursive:true});await writeFile(full,bytes);}
function sql(path,callback){const db=new DatabaseSync(path);try{return callback(db);}finally{db.close();}}
const binding=(fromStep,argument='value',type='number',pointer='/value')=>({fromStep,argument,type,pointer});
const draft=()=>({name:'Synthetic reusable calculation',description:'Software workflow fixture only.',steps:[
  {id:'source',title:'Read fixture',tool:'read_number',arguments:{path:'data/value.txt'},bindings:[]},
  {id:'scale',title:'Scale saved value',tool:'scale_number',arguments:{factor:2},bindings:[binding('source')]},
  {id:'child',title:'Scale again',tool:'scale_number',arguments:{factor:3},bindings:[binding('scale')]},
  {id:'independent',title:'Independent branch',tool:'scale_number',arguments:{value:7,factor:5},bindings:[]},
]});
async function environment(context,name){
  const root=join(runRoot,name);await mkdir(root,{recursive:true});await put(root,'data/value.txt',Buffer.from('4\n'));
  const study=(await requestComputeStudies(root,{action:'create',name:'Synthetic workflow project',question:'Storage and selective rerun checks'})).study;
  const env={root,study,runtime:'runtime-1',codes:{read_number:'reader-1',scale_number:'scale-1'},calls:[],fail:new Set(),uncacheable:new Set(),owner:'alive',services:[]};
  const schemas={read_number:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},scale_number:{type:'object',properties:{value:{type:'number'},factor:{type:'number'}},required:['value','factor'],additionalProperties:false}};
  env.fingerprint=async request=>{
    const bytes=request.tool==='read_number'?await readFile(join(root,request.arguments.path)):undefined;
    const material={request:data(request),files:bytes?{path:request.arguments.path,sha256:hash(bytes)}:{},implementation:env.codes[request.tool],runtime:env.runtime};
    return {ok:true,schema_version:'proto-agent.compute-fingerprint.v1',fingerprint_sha256:hash(JSON.stringify(material)),cacheable:!env.uncacheable.has(request.tool),reasons:env.uncacheable.has(request.tool)?['Synthetic nondeterministic policy']:[],materials:material};
  };
  env.dependencies={
    catalog:async tool=>({ok:true,execution:'local',tools:schemas[tool]?[{id:tool,title:tool,description:'Synthetic test producer',available:true,dependency:[],implementation:'synthetic',upstream_functions:[],missing_dependencies:[],input_schema:schemas[tool]}]:[],upstream:{}}),
    fingerprint:request=>env.fingerprint(request),
    ownerState:async()=>env.owner,
    openRun:async id=>(await requestComputeStudies(root,{action:'open-run',runId:id})).run,
    run:async(request,executionContext)=>{
      env.calls.push({request:data(request),context:executionContext});
      if(env.beforeRun)await env.beforeRun(request,executionContext);
      if(env.fail.has(executionContext.stepId))return {ok:false,diagnostics:[{message:'Synthetic producer failed; no success receipt.'}]};
      const fingerprint=await env.fingerprint(request),id=randomUUID().replaceAll('-',''),prefix=`build/compute/${id}`;
      const input=encode(request),source=`build/workflow-test-requests/${id}.json`;
      const result=encode({value:request.tool==='read_number'?Number((await readFile(join(root,request.arguments.path),'utf8')).trim()):request.arguments.value*request.arguments.factor,fixture:'synthetic arithmetic only'});
      const materials=[fileRecord('input:request_snapshot',`${prefix}/input.json`,input)],inputs={request_snapshot:`${prefix}/input.json`};
      if(request.tool==='read_number'){
        const bytes=await readFile(join(root,request.arguments.path));inputs['file:path']={path:request.arguments.path,sha256:hash(bytes)};
        materials.push(fileRecord('input:file:path',request.arguments.path,bytes));
      }
      const manifest={schema_version:'proto-agent.compute.v1',ok:true,run_id:id,tool:request.tool,created_at:new Date().toISOString(),implementation:'synthetic-format-fixture',implementation_version:1,upstream_commit:null,method_references:[],upstream_functions:[],runtime:{fixture:'not-executed'},review_status:'human_review_required',scope:'Synthetic workflow service fixture; no scientific acceptance.',source:{path:source,sha256:hash(input)},inputs,artifacts:[`${prefix}/result.json`],result_sha256:hash(result),execution_fingerprint:{fingerprint_sha256:fingerprint.fingerprint_sha256,cacheable:fingerprint.cacheable,verified_unchanged:true,materials:fingerprint.materials,reasons:fingerprint.reasons}};
      const manifestBytes=encode(manifest),provenance=encode({schema_version:'proto-agent.provenance.v1',run_id:id,created_at:manifest.created_at,subject:fileRecord('manifest',`compute/${id}/manifest.json`,manifestBytes),materials,artifacts:[fileRecord('artifact:0',`compute/${id}/result.json`,result)],tool:{name:'synthetic',version:'1',python:'not-executed',platform:'fixture'},policy:{digest:'sha256',signature:'none',path_mode:'root-relative-single-link-regular-files-no-reparse-points'}});
      for(const [path,bytes] of [[source,input],[`${prefix}/input.json`,input],[`${prefix}/result.json`,result],[`${prefix}/manifest.json`,manifestBytes],[`${prefix}/provenance.json`,provenance]])await put(root,path,bytes);
      if(env.afterPublish)await env.afterPublish(request,manifest);
      return {...manifest,manifest_path:`${prefix}/manifest.json`,result:JSON.parse(result)};
    },
  };
  env.makeService=()=>{const service=new ResearchWorkflowService(root,env.dependencies);env.services.push(service);return service;};
  env.service=env.makeService();env.database=join(root,'build','compute-studies','studies.sqlite');
  env.save=async(value=draft(),workflow)=>{const reply=await env.service.request({action:'save',studyId:study.id,draft:value,...(workflow?{workflowId:workflow.id,expectedRevision:workflow.revision}:{})});assert.equal(reply.validation.ok,true,JSON.stringify(reply.validation));return reply.workflow;};
  // Starting is gated on a preview the caller has seen, so the helper reproduces
  // that order rather than fabricating a plan hash.
  env.preview=async(workflow,forceSteps=[])=>(await env.service.request({action:'preview',studyId:study.id,workflowId:workflow.id,expectedRevision:workflow.revision,forceSteps})).preview;
  env.start=async(workflow,forceSteps=[])=>{const preview=await env.preview(workflow,forceSteps);
    const reply=await env.service.request({action:'start',studyId:study.id,workflowId:workflow.id,expectedRevision:workflow.revision,expectedPlanSha256:preview.planSha256,forceSteps});return reply.execution;};
  env.get=async(workflow,execution)=>(await env.service.request({action:'get-execution',studyId:study.id,workflowId:workflow.id,executionId:execution.id})).execution;
  env.finish=async(workflow,forceSteps=[])=>{const started=await env.start(workflow,forceSteps);await env.service.wait(started.id);return env.get(workflow,started);};
  context.after(async()=>{for(const service of env.services)await service.close();});return env;
}
const statuses=execution=>Object.fromEntries(execution.steps.map(step=>[step.stepId,step.status]));

test('saved versions persist and expected revision protects against two writers',async context=>{
  const env=await environment(context,'versions-cas'),first=await env.save();
  const secondService=env.makeService(),edited={...draft(),name:'Edited version'};
  const second=await env.save(edited,first);
  await assert.rejects(secondService.request({action:'save',studyId:env.study.id,workflowId:first.id,expectedRevision:1,draft:edited}),hasCode('WORKFLOW_CONFLICT'));
  const prior=await secondService.request({action:'get',studyId:env.study.id,workflowId:first.id,revision:1});
  assert.equal(prior.workflow.name,first.name);assert.equal(prior.workflow.revision,1);
  assert.deepEqual(prior.versions.map(item=>item.revision),[2,1]);
  assert.equal((await secondService.request({action:'list',studyId:env.study.id})).workflows[0].revision,second.revision);
  assert.equal(sql(env.database,db=>db.prepare('SELECT count(*) n FROM research_workflow_versions').get()).n,2);
});

test('cycle, missing source, binding/literal collisions and declared destination types reject before save',async context=>{
  const env=await environment(context,'typed-validation');
  const cases=[
    ['WORKFLOW_CYCLE',value=>{value.steps[0].arguments={};value.steps[0].bindings=[binding('child','path','string')];}],
    ['DEPENDENCY_INVALID',value=>{value.steps[1].bindings[0].fromStep='absent';}],
    ['BINDING_COLLISION',value=>{value.steps[1].arguments.value=4;}],
    ['BINDING_TYPE',value=>{value.steps[1].bindings[0].type='string';}],
    ['WORKFLOW_POINTER',value=>{value.steps[1].bindings[0].pointer='/bad~2escape';}],
    ['ARGUMENT_TYPE',value=>{value.steps[1].arguments.factor='two';}],
  ];
  for(const [code,mutate] of cases){const value=draft();mutate(value);const reply=await env.service.request({action:'save',studyId:env.study.id,draft:value});assert.equal(reply.workflow,undefined);assert.ok(reply.validation.diagnostics.some(item=>item.code===code),JSON.stringify(reply.validation));}
  assert.equal((await env.service.request({action:'list',studyId:env.study.id})).workflows.length,0);assert.equal(env.calls.length,0);
});

test('exact saved fingerprints reuse every branch and persist all step attempts',async context=>{
  const env=await environment(context,'exact-reuse'),workflow=await env.save();
  const first=await env.finish(workflow);assert.equal(first.status,'succeeded');assert.equal(env.calls.length,4);
  const second=await env.finish(workflow);assert.equal(second.status,'succeeded');assert.deepEqual(statuses(second),{source:'reused',scale:'reused',child:'reused',independent:'reused'});assert.equal(env.calls.length,4);
  assert.deepEqual(second.steps.map(item=>item.runId),first.steps.map(item=>item.runId));
  const child=await env.dependencies.openRun(first.steps.find(step=>step.stepId==='child').runId);assert.equal(child.receipt.result.value,24);
  assert.equal(sql(env.database,db=>db.prepare('SELECT count(*) n FROM research_workflow_attempts').get()).n,8);
  await env.service.close();env.service=env.makeService();const reopened=await env.get(workflow,second);assert.equal(reopened.status,'succeeded');assert.deepEqual(statuses(reopened),statuses(second));
});

test('data, parameters, runtime and implementation changes invalidate the affected dependency branches',async context=>{
  const env=await environment(context,'selective-invalidation');let workflow=await env.save();await env.finish(workflow);
  await put(env.root,'data/value.txt',Buffer.from('6\n'));
  const changedData=await env.finish(workflow);assert.deepEqual(statuses(changedData),{source:'succeeded',scale:'succeeded',child:'succeeded',independent:'reused'});
  const edited=draft();edited.steps[1].arguments.factor=4;workflow=await env.save(edited,workflow);
  const changedParameter=await env.finish(workflow);assert.deepEqual(statuses(changedParameter),{source:'reused',scale:'succeeded',child:'succeeded',independent:'reused'});
  env.codes.read_number='reader-2';const changedCode=await env.finish(workflow);assert.deepEqual(statuses(changedCode),{source:'succeeded',scale:'succeeded',child:'succeeded',independent:'reused'});
  env.runtime='runtime-2';const changedRuntime=await env.finish(workflow);assert.ok(changedRuntime.steps.every(step=>step.status==='succeeded'));
});

test('forcing one step reruns all its descendants while an independent branch remains reusable',async context=>{
  const env=await environment(context,'force-descendants'),workflow=await env.save();await env.finish(workflow);
  const result=await env.finish(workflow,['source']);assert.deepEqual(new Set(result.forceSteps),new Set(['source','scale','child']));assert.deepEqual(statuses(result),{source:'succeeded',scale:'succeeded',child:'succeeded',independent:'reused'});
  assert.equal(env.calls.length,7);
});

test('cache entries never cross workflow identity and tampered results are recomputed with descendants',async context=>{
  const env=await environment(context,'cache-identity'),one=await env.save(),first=await env.finish(one);
  const two=await env.save();const unrelated=await env.finish(two);assert.ok(unrelated.steps.every(step=>step.status==='succeeded'));assert.equal(env.calls.length,8);
  const source=first.steps.find(step=>step.stepId==='source');const path=join(env.root,'build','compute',source.runId,'result.json');await writeFile(path,(await readFile(path,'utf8'))+' ');
  const rerun=await env.finish(one);assert.deepEqual(statuses(rerun),{source:'succeeded',scale:'succeeded',child:'succeeded',independent:'reused'});assert.notEqual(rerun.steps[0].runId,source.runId);assert.match(rerun.steps[0].cacheReason,/not reused/);
});

test('a failed branch blocks descendants and explicit recovery preserves the previous terminal attempt',async context=>{
  const env=await environment(context,'failed-branch'),workflow=await env.save();env.fail.add('scale');
  const first=await env.finish(workflow);assert.equal(first.status,'failed');assert.deepEqual(statuses(first),{source:'succeeded',scale:'failed',child:'blocked',independent:'succeeded'});assert.deepEqual(first.steps[2].blockedBy,['scale']);
  env.fail.clear();const recovered=(await env.service.request({action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:first.id,acknowledgeInterrupted:true})).execution;
  await env.service.wait(recovered.id);const second=await env.get(workflow,recovered);assert.equal(second.parentExecutionId,first.id);assert.deepEqual(statuses(second),{source:'reused',scale:'succeeded',child:'succeeded',independent:'reused'});
  assert.equal(first.steps.find(step=>step.stepId==='scale').error.executionState,'tool-error');
  assert.notEqual(second.steps.find(step=>step.stepId==='scale').operationId,first.steps.find(step=>step.stepId==='scale').operationId,'Known tool-error receipts permit an explicit recovery retry.');
  assert.deepEqual(statuses(await env.get(workflow,first)),statuses(first));
});

test('failed unknown-effect writes retain their operation identity on recovery and never redispatch',async context=>{
  const env=await environment(context,'unknown-effect-recovery'),workflow=await env.save();
  const db=new DatabaseSync(':memory:'),journal=new ToolExecutionJournal(db),produce=env.dependencies.run,dispatches=[];
  context.after(()=>db.close());
  env.dependencies.run=(request,run)=>invokeJournaledTool({journal,operationId:run.operationId,scope:{surface:'workflow',scopeId:run.operationId},tool:'proto_compute_run',arguments:{path:`build/compute-inputs/${run.operationId}.json`}},async mark=>{
    mark();dispatches.push({step:run.stepId,operationId:run.operationId});
    if(run.stepId==='scale')throw Object.assign(new Error('Synthetic transport stopped after dispatch.'),{code:'TOOL_EFFECT_UNKNOWN',effectState:'unknown'});
    return produce(request,run);
  });
  const first=await env.finish(workflow),failed=first.steps.find(step=>step.stepId==='scale');
  assert.equal(failed.status,'failed');assert.equal(failed.error.executionState,'effect-unknown');assert.equal(journal.get(failed.operationId).state,'effect-unknown');
  const recovered=(await env.service.request({action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:first.id,acknowledgeInterrupted:true})).execution;
  await env.service.wait(recovered.id);const second=await env.get(workflow,recovered);
  assert.equal(second.steps.find(step=>step.stepId==='scale').operationId,failed.operationId);
  assert.equal(second.steps.find(step=>step.stepId==='scale').error.code,'TOOL_EFFECT_UNKNOWN');
  assert.equal(dispatches.filter(item=>item.step==='scale').length,1);
  // An older saved failure has no effect verdict. Retaining its operation ID is
  // conservative; the journal remains the authority for replay eligibility.
  sql(env.database,database=>{
    const row=database.prepare('SELECT payload FROM research_workflow_executions WHERE id=?').get(first.id),value=JSON.parse(row.payload),step=value.steps.find(step=>step.stepId==='scale');
    delete step.error.executionState;step.error.code='STEP_FAILED';
    database.prepare('UPDATE research_workflow_executions SET payload=? WHERE id=?').run(JSON.stringify(value),first.id);
    database.prepare('UPDATE research_workflow_attempts SET payload=? WHERE execution_id=? AND step_id=?').run(JSON.stringify(step),first.id,'scale');
  });
  const legacyRecovery=(await env.service.request({action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:first.id,acknowledgeInterrupted:true})).execution;
  await env.service.wait(legacyRecovery.id);
  assert.equal((await env.get(workflow,legacyRecovery)).steps.find(step=>step.stepId==='scale').operationId,failed.operationId);
  assert.equal(dispatches.filter(item=>item.step==='scale').length,1);
});

test('recovery retains the forced rerun intent instead of silently reusing an older cached branch',async context=>{
  const env=await environment(context,'force-recovery'),workflow=await env.save();await env.finish(workflow);
  env.fail.add('scale');const failed=await env.finish(workflow,['source']);assert.equal(failed.status,'failed');
  env.fail.clear();const recovered=(await env.service.request({action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:failed.id,acknowledgeInterrupted:true})).execution;
  await env.service.wait(recovered.id);const finished=await env.get(workflow,recovered);
  assert.deepEqual(finished.forceSteps,['source','scale','child']);
  assert.deepEqual(statuses(finished),{source:'succeeded',scale:'succeeded',child:'succeeded',independent:'reused'});
  assert.notEqual(finished.steps[0].runId,failed.steps[0].runId);assert.equal((await env.get(workflow,failed)).status,'failed');
});

test('start is observable before completion, duplicate active execution rejects and cancellation waits for its own callback',async context=>{
  const env=await environment(context,'owned-cancellation'),workflow=await env.save();let entered;const entering=new Promise(resolve=>{entered=resolve;});
  env.beforeRun=async(_request,{signal})=>{entered();await new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{env.abortObserved=true;reject(new Error('Synthetic operation cancelled'));},{once:true});});};
  const started=await env.start(workflow);await entering;
  assert.equal((await env.get(workflow,started)).status,'running');
  await assert.rejects(env.start(workflow),hasCode('EXECUTION_ACTIVE'));
  const foreign=env.makeService();await assert.rejects(foreign.request({action:'cancel',studyId:env.study.id,workflowId:workflow.id,executionId:started.id}),hasCode('EXECUTION_OWNERSHIP'));
  await env.service.request({action:'cancel',studyId:env.study.id,workflowId:workflow.id,executionId:started.id});await env.service.wait(started.id);
  const finished=await env.get(workflow,started);assert.equal(finished.status,'cancelled');assert.equal(env.abortObserved,true);assert.ok(finished.steps.every(step=>step.status==='cancelled'));
});

function orphan(env,workflow,completed){
  const id=randomUUID(),execution={...data(completed),id,status:'running',owner:{pid:2147480000,instanceId:randomUUID()},steps:data(completed.steps)};
  delete execution.finishedAt;delete execution.recoveryAvailable;delete execution.recoveryReason;
  execution.steps[1]={stepId:'scale',title:workflow.steps[1].title,tool:workflow.steps[1].tool,status:'running',startedAt:new Date().toISOString()};
  execution.steps[2]={stepId:'child',title:workflow.steps[2].title,tool:workflow.steps[2].tool,status:'pending'};
  sql(env.database,db=>{db.prepare('INSERT INTO research_workflow_executions VALUES(?,?,?,?,?,?,?,?)').run(id,workflow.id,env.study.id,workflow.revision,'running',1,hostname(),JSON.stringify(execution));for(const step of execution.steps)db.prepare('INSERT INTO research_workflow_attempts VALUES(?,?,?,?)').run(randomUUID(),id,step.stepId,JSON.stringify(step));});return execution;
}

test('orphan recovery requires absent owned job plus confirmed process death; unknown or live owner is never a stale timeout',async context=>{
  const env=await environment(context,'orphan-recovery'),workflow=await env.save(),completed=await env.finish(workflow),unfinished=orphan(env,workflow,completed);
  const request={action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:unfinished.id,acknowledgeInterrupted:true};
  for(const state of ['alive','unknown']){env.owner=state;assert.equal((await env.get(workflow,unfinished)).recoveryAvailable,false);await assert.rejects(env.service.request(request),hasCode('RECOVERY_UNAVAILABLE'));}
  env.owner='dead';assert.equal((await env.get(workflow,unfinished)).recoveryAvailable,true);assert.equal(env.calls.length,4,'Inspection alone must not replay tools');
  const resumed=(await env.service.request(request)).execution;await env.service.wait(resumed.id);
  assert.equal((await env.get(workflow,resumed)).status,'succeeded');
  const retained=await env.get(workflow,unfinished);assert.equal(retained.status,'interrupted');assert.equal(retained.steps[0].status,'succeeded');assert.equal(retained.steps[1].status,'interrupted');assert.equal(retained.steps[2].status,'interrupted');
});

test('explicit recovery preserves the operation ID for an interrupted workflow step',async context=>{
  const env=await environment(context,'operation-id-recovery'),workflow=await env.save();env.uncacheable.add('scale_number');
  const completed=await env.finish(workflow),unfinished=orphan(env,workflow,completed);
  const previousAttempt=sql(env.database,db=>db.prepare('SELECT id FROM research_workflow_attempts WHERE execution_id=? AND step_id=?').get(unfinished.id,'scale').id);
  env.owner='dead';
  const resumed=(await env.service.request({action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:unfinished.id,acknowledgeInterrupted:true})).execution;
  await env.service.wait(resumed.id);
  const recoveredScale=env.calls.filter(call=>call.context.stepId==='scale').at(-1);
  assert.equal(recoveredScale.context.operationId,previousAttempt);
  assert.equal((await env.get(workflow,resumed)).steps.find(step=>step.stepId==='scale').operationId,previousAttempt);
});

test('tampered nested state or owner metadata cannot acquire terminal recovery authority',async context=>{
  const env=await environment(context,'damaged-record'),workflow=await env.save(),completed=await env.finish(workflow);
  const original=sql(env.database,db=>db.prepare('SELECT payload FROM research_workflow_executions WHERE id=?').get(completed.id).payload);
  for(const mutate of [value=>{value.owner.pid=-1;},value=>{value.status='unknown';},value=>{value.steps[0].status='unknown';},value=>{value.steps[0].binding.resultSha256='false';},value=>{value.steps[0].fingerprint.cacheable='yes';}]){
    const value=JSON.parse(original);mutate(value);sql(env.database,db=>db.prepare('UPDATE research_workflow_executions SET payload=? WHERE id=?').run(JSON.stringify(value),completed.id));
    await assert.rejects(env.get(workflow,completed),hasCode('EXECUTION_DAMAGED'));
    await assert.rejects(env.service.request({action:'recover',studyId:env.study.id,workflowId:workflow.id,executionId:completed.id,acknowledgeInterrupted:true}),hasCode('EXECUTION_DAMAGED'));
  }
  sql(env.database,db=>db.prepare('UPDATE research_workflow_executions SET payload=? WHERE id=?').run(original,completed.id));
});

test('successful noncacheable runs and later source changes preserve success without permitting cached reuse',async context=>{
  const env=await environment(context,'uncacheable-success');const single={...draft(),steps:[draft().steps[0]]},workflow=await env.save(single);
  env.uncacheable.add('read_number');const first=await env.finish(workflow);assert.equal(first.status,'succeeded');const second=await env.finish(workflow);assert.equal(second.steps[0].status,'succeeded');assert.equal(env.calls.length,2);
  env.uncacheable.clear();env.afterPublish=async()=>{await put(env.root,'data/value.txt',Buffer.from('9\n'));env.afterPublish=undefined;};
  const changed=await env.finish(workflow);assert.equal(changed.status,'succeeded');assert.match(changed.steps[0].cacheReason,/prevents cache reuse/);
  const next=await env.finish(workflow);assert.equal(next.steps[0].status,'succeeded');assert.equal(env.calls.length,4);
});

test('actual saved pointer types are checked before a downstream run is launched',async context=>{
  const env=await environment(context,'resolved-type'),value=draft();value.steps[1].bindings[0].pointer='/fixture';const workflow=await env.save(value);
  const result=await env.finish(workflow);assert.equal(result.status,'failed');assert.equal(result.steps[1].error.code,'BINDING_VALUE_TYPE');assert.equal(result.steps[2].status,'blocked');assert.equal(env.calls.filter(call=>call.context.stepId==='scale').length,0);
});

test('a completed artifact observed after cancellation remains linked to the cancelled attempt without entering cache',async context=>{
  const env=await environment(context,'cancel-observed-artifact'),workflow=await env.save();
  env.afterPublish=async(_request,_receipt)=>{
    const current=env.calls.at(-1).context;
    await env.service.request({action:'cancel',studyId:env.study.id,workflowId:workflow.id,executionId:current.executionId});
    env.afterPublish=undefined;
  };
  const result=await env.finish(workflow);assert.equal(result.status,'cancelled');
  const observed=result.steps[0];assert.equal(observed.status,'cancelled');assert.match(observed.runId,/^[a-f0-9]{32}$/);assert.ok(observed.binding);
  assert.equal((await env.dependencies.openRun(observed.runId)).integrity.status,'verified');
  assert.match(observed.cacheReason,/effect review/);assert.equal(sql(env.database,db=>db.prepare('SELECT count(*) n FROM research_workflow_cache').get()).n,0);
});

test('graceful close aborts and awaits an owned job before another service reopens terminal state',async context=>{
  const env=await environment(context,'graceful-close'),workflow=await env.save();let entered;const entering=new Promise(resolve=>{entered=resolve;});
  env.beforeRun=async(_request,{signal})=>{entered();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{env.abortObserved=true;reject(new Error('Stopped by close'));},{once:true}));};
  const started=await env.start(workflow);await entering;await env.service.close();assert.equal(env.abortObserved,true);
  env.service=env.makeService();assert.equal((await env.get(workflow,started)).status,'cancelled');
});

test('the complete bounded execution history remains visible and refuses an additional execution without dropping evidence',async context=>{
  const env=await environment(context,'execution-retention-bound'),workflow=await env.save(),completed=await env.finish(workflow);
  const original=sql(env.database,db=>JSON.parse(db.prepare('SELECT payload FROM research_workflow_executions WHERE id=?').get(completed.id).payload));
  sql(env.database,db=>{
    db.exec('BEGIN');
    for(let index=1;index<100;index++){
      const value={...data(original),id:randomUUID()};
      db.prepare('INSERT INTO research_workflow_executions VALUES(?,?,?,?,?,?,?,?)').run(value.id,workflow.id,env.study.id,workflow.revision,'succeeded',1,hostname(),JSON.stringify(value));
      for(const step of value.steps)db.prepare('INSERT INTO research_workflow_attempts VALUES(?,?,?,?)').run(randomUUID(),value.id,step.stepId,JSON.stringify(step));
    }
    db.exec('COMMIT');
  });
  const listed=await env.service.request({action:'get',studyId:env.study.id,workflowId:workflow.id});assert.equal(listed.executions.length,100);assert.ok(listed.executions.some(item=>item.id===completed.id));
  await assert.rejects(env.start(workflow),hasCode('EXECUTION_HISTORY_LIMIT'));
  assert.equal(sql(env.database,db=>db.prepare('SELECT count(*) n FROM research_workflow_executions').get()).n,100);
});
