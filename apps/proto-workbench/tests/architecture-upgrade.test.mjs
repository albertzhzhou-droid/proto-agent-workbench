import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ResearchChatService} from '../src/main/services/research-chat.ts';
import {ResearchToolBridge} from '../src/main/services/research-tools.ts';
import {ChemScienceService} from '../src/main/services/chem-science.ts';
import {modulesForProfile} from '../src/shared/modules.ts';

async function settled(service,id) {
  for(let i=0;i<100;i++){const {session}=await service.request({action:'get',sessionId:id});if(session.status==='idle')return session;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Chat did not settle');
}

test('Chat refuses complete on a tool error and preserves the original model instance and send grant',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'proto-architecture-chat-'));
  let step=0,instance='instance-A',authorized;
  const runtime={scan:async()=>[],load:async()=>({}),getExecutionBinding:async()=>({instanceId:instance,modelFingerprint:'f'.repeat(64),contextLength:32768}),countExecutionTokens:async()=>({tokens:2000,method:'exact'}),chat:async(_id,_payload,chunk)=>{
    step++;if(step===1)chunk({choices:[{delta:{tool_calls:[{index:0,id:'model-call',function:{name:'workspace_search',arguments:'{"query":"evidence"}'}}]}}]});
    else chunk({choices:[{delta:{content:'The response text finished.'}}]});
  }};
  const service=new ResearchChatService({workspace,databasePath:join(workspace,'chat.sqlite'),runtime,tools:{execute:async()=>({isError:true,content:[{type:'text',text:'Tool rejected input'}]}),authorizeSend:grant=>{authorized=grant;},finishSend:()=>{}}});
  t.after(()=>service.close());
  const id=(await service.request({action:'create'})).session.id;
  await service.request({action:'send',sessionId:id,modelId:'model',content:'Find evidence',documentIds:[],networkEnabled:false,codeExecutionEnabled:false});
  let session=await settled(service,id);const reply=session.messages.at(-1);
  assert.equal(reply.state,'incomplete-evidence');assert.equal(reply.activity[0].status,'error');
  assert.equal(reply.modelBinding.instanceId,'instance-A');assert.deepEqual(authorized.risks,[]);
  assert.equal(reply.policyGrant.id,authorized.id);assert.equal(reply.policyGrant.scopeId,reply.id);
  instance='instance-B';session=(await service.request({action:'get',sessionId:id})).session;
  assert.equal(session.messages.at(-1).modelBinding.instanceId,'instance-A');
});

test('Chat network grants are scoped to a live send and cannot be restored from transcript data',async()=>{
  let dispatched=0,options;
  const worker={call:async(_name,_args,_signal,authorization,callOptions)=>{dispatched++;options=callOptions;assert.equal(authorization.approvalId,callOptions.decision.grantId);return {ok:true};},stop:async()=>{}};
  const mcp={tools:async()=>[{name:'proto_pubmed_search',description:'Search',inputSchema:{type:'object'}}],fork:()=>worker};
  const bridge=new ResearchToolBridge(mcp,{});
  const session={id:randomUUID(),messages:[{id:randomUUID()}],moduleSettings:{profile:'full',enabledOptional:modulesForProfile('full')}};
  const scopeId=session.messages[0].id,grant={id:randomUUID(),source:'session-send',actor:'local-user',surface:'chat',scopeId,risks:['network'],grantedAt:new Date().toISOString()};
  session.messages[0].policyGrant=grant;
  const invoke=()=>bridge.execute('science_run',{name:'proto_pubmed_search',arguments:{query:'test',offline:false}},session,new AbortController().signal,randomUUID());
  await assert.rejects(invoke(),/POLICY_DENIED/);assert.equal(dispatched,0);
  bridge.authorizeSend({...grant,risks:[]});await assert.rejects(invoke(),/POLICY_DENIED/);
  bridge.authorizeSend(grant);assert.equal((await invoke()).ok,true);assert.equal(options.scope.surface,'chat');assert.equal(options.scope.scopeId,scopeId);
  bridge.finishSend(scopeId);await assert.rejects(invoke(),/POLICY_DENIED/);assert.equal(dispatched,1);
});

test('interrupted Chem manifest remains visible as unverifiable and journal blocks replay',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'proto-architecture-chem-'));
  const service=new ChemScienceService({workspacePath:workspace,repoRoot:workspace});t.after(()=>service.close());
  const runId=randomUUID();let executions=0;
  service.worker=async request=>{
    if(request.operator==='catalog')return {ok:true,operator:'catalog',result:{operators:[{id:'formula_properties',available:true}]}};
    executions++;
    const path=join(workspace,'build','chem-science',runId,'manifest.json');
    await unlink(path);await mkdir(path); // Interruption during durable publication.
    return {ok:true,operator:request.operator,result:{mass:12}};
  };
  const request={action:'run',runId,operator:'formula_properties',input:{formula:'C'}};
  assert.equal((await service.request(request)).ok,false);
  assert.equal(service.executionRecord(`chemistry:${runId}`).state,'effect-unknown');
  const history=await service.request({action:'history'});assert.equal(history.ok,true);
  assert.equal(history.data.runs[0].status,'unverifiable');
  assert.equal((await service.request(request)).ok,false);assert.equal(executions,1);
});

test('Chem completed receipts are replayed and corruption stays visible in history',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'proto-architecture-chem-'));
  const service=new ChemScienceService({workspacePath:workspace,repoRoot:workspace});t.after(()=>service.close());
  let executions=0;
  service.worker=async request=>request.operator==='catalog'?{ok:true,operator:'catalog',result:{operators:[{id:'formula_properties',available:true}]}}:{ok:true,operator:request.operator,result:{mass:++executions}};
  const runId=randomUUID(),request={action:'run',runId,operator:'formula_properties',input:{formula:'C'}};
  const result=await service.request(request);assert.equal(result.ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(await service.request(request))),JSON.parse(JSON.stringify(result)));assert.equal(executions,1);
  assert.equal(result.data.maturity.scientific_validation,'not-established');
  const manifest=JSON.parse(await readFile(join(workspace,result.data.artifacts.manifest),'utf8'));
  assert.equal(manifest.evidenceStanding.humanReview,'required');
  const compute=JSON.parse(await readFile(join(workspace,result.data.artifacts.computeManifest),'utf8'));
  assert.equal(compute.schema_version,'proto-agent.compute.v1');assert.equal(compute.result_value_index.entries[0].pointer,'/result/mass');assert.equal(compute.result_value_index.entries[0].quantity,null);
  await writeFile(join(workspace,result.data.artifacts.result),'corrupted');
  assert.equal((await service.request({action:'history'})).data.runs[0].status,'unverifiable');
});
