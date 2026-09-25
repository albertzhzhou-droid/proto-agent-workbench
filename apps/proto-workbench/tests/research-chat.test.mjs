import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdir} from "node:fs/promises";
import {canonicalMkdtemp as mkdtemp} from "./helpers/canonical-temp.mjs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ResearchChatService} from "../src/main/services/research-chat.ts";
import {retainChatContext} from "../src/main/services/chat-context.ts";
import {canonicalScienceTools,resolveScienceTool} from "../src/shared/research-tool-registry.ts";
import {researchSignature,repeatedResearchCall} from "../src/main/services/research-tools.ts";
import {resolveToolContract} from "../src/shared/tool-contracts.ts";
import {DatabaseSync} from "node:sqlite";
import {ToolExecutionJournal} from "../src/main/services/tool-execution-journal.ts";

async function setup(t,options={}) {
  const workspace=await mkdtemp(join(tmpdir(),"proto-chat-"));
  const runtime={scan:async()=>[],load:async()=>({}),getExecutionBinding:async()=>({contextLength:32768,instanceId:"loaded"}),countExecutionTokens:async()=>({tokens:1500,method:"exact"}),chat:async(_id,_payload,chunk)=>chunk({choices:[{delta:{content:"A grounded reply"}}]}),...options.runtime};
  const service=new ResearchChatService({databasePath:join(workspace,"chat.sqlite"),workspace,runtime,tools:options.tools});
  t.after(()=>service.close());
  const {session}=await service.request({action:"create"});
  return {service,workspace,id:session.id,runtime};
}
async function settled(service,id) {
  for(let i=0;i<100;i++) {const {session}=await service.request({action:"get",sessionId:id});if(session.status==="idle")return session;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error("response did not settle");
}
test("preserves complete transcript, document snapshots, and optimistic document revisions",async t=>{
  const {service,id,workspace}=await setup(t);
  const {session}=await service.request({action:"document",sessionId:id,name:"notes.md",content:"original evidence"});
  const doc=session.documents[0];
  await service.request({action:"send",sessionId:id,modelId:"exact-model",content:"Summarize",documentIds:[doc.id]});
  await settled(service,id);
  await service.request({action:"document",sessionId:id,name:"notes.md",content:"revised evidence",documentId:doc.id,expectedRevision:1});
  await assert.rejects(service.request({action:"document",sessionId:id,name:"notes.md",content:"stale",documentId:doc.id,expectedRevision:1}),/revision changed/);
  const current=(await service.request({action:"get",sessionId:id})).session;
  assert.equal(current.messages[0].documents[0].content,"original evidence");
  const exported=await service.request({action:"export",sessionId:id,documentId:doc.id,expectedRevision:2});
  assert.equal(await readFile(exported.exportPath,"utf8"),"revised evidence");
  assert.ok(exported.exportPath.startsWith(join(workspace,"build","chat")));
});
test("streams, executes a tool once, feeds its receipt back and records an artifact",async t=>{
  let inference=0, executions=0;
  const {service,id,workspace}=await setup(t,{tools:{execute:async(name,input)=>{executions++;assert.equal(name,"workspace_search");assert.equal(input.query,"data");return {ok:true,rows:7};}},runtime:{chat:async(_id,payload,chunk)=>{
    inference++;
    if(inference===1){chunk({choices:[{delta:{tool_calls:[{index:0,id:"call-a",function:{name:"workspace_search",arguments:'{"que'}}]}}]});chunk({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'ry":"data"}'}}]}}]});}
    else {assert.ok(payload.messages.some(message=>message.role==="tool"&&message.tool_call_id==="call-a"&&message.content.includes('"rows": 7')));chunk({choices:[{delta:{content:"There are 7 rows."}}]});}
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Inspect data",documentIds:[]});
  const session=await settled(service,id);
  assert.equal(session.error,undefined);assert.equal(executions,1);assert.equal(inference,2);
  const activity=session.messages[1].activity[0];assert.equal(activity.status,"complete");
  assert.equal(JSON.parse(await readFile(join(workspace,activity.artifactPath),"utf8")).rows,7);
});
test("conversation_read returns a complete earlier message without transcript truncation",async t=>{
  let inference=0;
  const {service,id}=await setup(t,{tools:{execute:async()=>{throw Error("External execution was not expected.");}},runtime:{chat:async(_id,payload,chunk)=>{
    inference++;
    if(inference===1)chunk({choices:[{delta:{content:"First response"}}]});
    else if(inference===2)chunk({choices:[{delta:{tool_calls:[{index:0,id:"read-old",function:{name:"conversation_read",arguments:'{"startIndex":0,"limit":1}'}}]}}]});
    else {const result=payload.messages.find(message=>message.role==="tool"&&message.tool_call_id==="read-old");assert.match(result.content,/First user question/);chunk({choices:[{delta:{content:"Recovered source context"}}]});}
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"First user question",documentIds:[]});
  await settled(service,id);
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Continue from earlier evidence",documentIds:[]});
  const session=await settled(service,id);
  assert.equal(session.error,undefined);assert.equal(inference,3);
  assert.equal(session.messages.at(-1).activity[0].tool,"conversation_read");
  assert.equal(session.messages.at(-1).activity[0].status,"complete");
});
test("cancellation persists a stopped response without fabricating completion",async t=>{
  const {service,id}=await setup(t,{runtime:{chat:async(_id,_payload,chunk,signal)=>{chunk({choices:[{delta:{content:"partial"}}]});await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error("aborted"));else signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});});}}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Run",documentIds:[]});
  const {session}=await service.request({action:"cancel",sessionId:id});
  assert.equal(session.status,"idle");assert.equal(session.messages[1].state,"stopped");
});
test("unbound models and cross-workspace conversations are rejected",async t=>{
  const {service,id}=await setup(t,{runtime:{getExecutionBinding:async()=>{throw Error("not loaded");}}});
  await assert.rejects(service.request({action:"send",sessionId:id,modelId:"removed",content:"run",documentIds:[]}),/not loaded/);
  assert.equal((await service.request({action:"get",sessionId:id})).session.messages.length,0);
  await assert.rejects(service.request({action:"get",sessionId:"619f7278-0693-49da-a497-4c7a3fc56b11"}),/current workspace/);
});
test("retention drops whole turns and never truncates the newest request",()=>{
  const history=[{id:"old-user",role:"user",content:"old ".repeat(1000),createdAt:"2026-09-22T00:00:00.000Z"},{id:"old-assistant",role:"assistant",content:"reply",createdAt:"2026-09-22T00:00:01.000Z",state:"complete"},{id:"current-user",role:"user",content:"Keep 你好 🧪 exactly",createdAt:"2026-09-22T00:00:02.000Z"}];
  const retained=retainChatContext(history,2300);
  assert.equal(retained.omittedMessages,2);assert.equal(retained.messages.at(-1).content,"Keep 你好 🧪 exactly");
  assert.equal(history.length,3);
  assert.throws(()=>retainChatContext([{role:"user",content:"huge".repeat(10000)}],2300),/exceed/);
});
test("canonical registry resolves legacy names without duplicate capabilities",()=>{
  const tools=canonicalScienceTools([{name:"proto_compute_run"},{name:"proto_compute_run"},{name:"proto_run_analysis"}]);
  assert.equal(tools.length,2);assert.equal(resolveScienceTool(tools,"biomni.run").id,"compute.run");assert.equal(resolveScienceTool(tools,"code.python").name,"proto_run_analysis");
  assert.equal(researchSignature("search",{a:1,b:2}),researchSignature("search",{b:2,a:1}));
  assert.ok(repeatedResearchCall(Array.from({length:3},()=>({tool:"search",input:{a:1},status:"complete"})),"search",{a:1}));
});

test("equivalent scientific aliases reuse one successful search but never cache failures",async t=>{
  let inference=0,executions=0;
  const names=["proto_pubmed_search","query_pubmed","literature.pubmed"];
  const {service,id,workspace}=await setup(t,{tools:{execute:async()=>({ok:++executions>1,rows:1})},runtime:{chat:async(_id,_payload,chunk)=>{
    if(inference<3) chunk({choices:[{delta:{tool_calls:[{index:0,id:`search-${inference}`,function:{name:"science_run",arguments:JSON.stringify({name:names[inference++],arguments:{query:"DESeq2",offline:false}})}}]}}]});
    else chunk({choices:[{delta:{content:"Source received"}}]});
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Find paper",documentIds:[]});
  const session=await settled(service,id);
  assert.equal(session.error,undefined);assert.equal(executions,2);
  assert.equal(session.messages[1].activity[0].status,"error");
  assert.equal(session.messages[1].activity[2].cached,true);
  assert.match(session.messages[1].activity[1].artifactSha256,/^[a-f0-9]{64}$/);
  assert.equal(session.messages[1].activity[2].artifactSha256,session.messages[1].activity[1].artifactSha256);
  assert.equal(session.messages[1].activity[2].artifactPath,session.messages[1].activity[1].artifactPath);
  for(const [index,activity] of session.messages[1].activity.entries()) {
    assert.equal(activity.input.name,names[index]);
    assert.equal(activity.capabilityId,resolveToolContract(names[index]).capabilityId);
    assert.equal(activity.backendTool,resolveToolContract(names[index]).name);
  }
  const db=new DatabaseSync(join(workspace,"chat.sqlite"));
  try {
    const saved=JSON.parse(db.prepare("SELECT payload FROM research_chats WHERE id=?").get(id).payload);
    for(const activity of saved.messages[1].activity) {
      assert.equal(activity.capabilityId,resolveToolContract(activity.input.name).capabilityId);
      assert.equal(activity.backendTool,resolveToolContract(activity.input.name).name);
    }
  } finally {db.close();}
});

test("explicit blocked reports persist an abstention receipt and stop later calls in the same model batch",async t=>{
  let inferences=0,executions=0;
  const declaration={reason:"The required measurements are unavailable.",unmetRequirements:["A reviewed input dataset with declared units"]};
  const {service,id,workspace,runtime}=await setup(t,{tools:{execute:async()=>{executions++;return {ok:true};}},runtime:{chat:async(_id,_payload,chunk)=>{
    inferences++;
    chunk({choices:[{delta:{tool_calls:[
      {index:0,id:"blocked",function:{name:"research_report_blocked",arguments:JSON.stringify(declaration)}},
      {index:1,id:"must-not-run",function:{name:"workspace_search",arguments:'{"query":"guessed input"}'}},
    ]}}]});
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Compute the result",documentIds:[]});
  const session=await settled(service,id),message=session.messages.at(-1),activity=message.activity[0];
  assert.equal(session.error,undefined);assert.equal(message.state,"blocked");
  assert.equal(message.blocked.reason,declaration.reason);assert.deepEqual(message.blocked.unmetRequirements,declaration.unmetRequirements);
  assert.equal(message.content,declaration.reason);assert.equal(inferences,1);assert.equal(executions,0);assert.equal(message.activity.length,1);
  assert.equal(activity.blocked,true);assert.equal(activity.status,"complete");
  const receipt=JSON.parse(await readFile(join(workspace,activity.artifactPath),"utf8"));
  assert.equal(receipt.code,"RESEARCH_REPORTED_BLOCKED");assert.equal(receipt.blocked,true);assert.deepEqual(receipt.unmetRequirements,declaration.unmetRequirements);
  await service.close();
  const reopened=new ResearchChatService({databasePath:join(workspace,"chat.sqlite"),workspace,runtime});t.after(()=>reopened.close());
  const saved=(await reopened.request({action:"get",sessionId:id})).session.messages.at(-1);
  assert.equal(saved.state,"blocked");assert.deepEqual(saved.blocked,message.blocked);assert.equal(saved.activity[0].artifactSha256,activity.artifactSha256);
});

test("malformed blocked declarations remain tool errors instead of claiming abstention",async t=>{
  let inferences=0;
  const {service,id}=await setup(t,{tools:{execute:async()=>{throw Error("Unexpected external call");}},runtime:{chat:async(_id,_payload,chunk)=>{
    if(inferences++===0)chunk({choices:[{delta:{tool_calls:[{index:0,id:"invalid-block",function:{name:"research_report_blocked",arguments:'{"reason":"","unmetRequirements":[]}'}}]}}]});
    else chunk({choices:[{delta:{content:"The requested declaration was rejected."}}]});
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Report missing input",documentIds:[]});
  const message=(await settled(service,id)).messages.at(-1);
  assert.equal(message.state,"incomplete-evidence");assert.equal(message.blocked,undefined);assert.equal(message.activity[0].status,"error");
});

test("Chat completion uses durable exact-input retry evidence while retaining both outcomes",async t=>{
  const db=new DatabaseSync(":memory:"),journal=new ToolExecutionJournal(db);t.after(()=>db.close());
  let inferences=0,executions=0;
  const {service,id}=await setup(t,{tools:{executionRecord:operationId=>journal.get(operationId),execute:async(_name,input,session,_signal,operationId)=>{
    const identity={operationId,scope:{surface:"chat",scopeId:session.messages.at(-1).id,parentOperationId:session.id},tool:resolveToolContract(input.name).name,arguments:input.arguments,effect:"write"};
    const start=journal.begin(identity);journal.markDispatched(identity,start.leaseId);
    const receipt=++executions===1?{ok:false,error:"Known calculation failure"}:{ok:true,result:2};journal.complete(identity,start.leaseId,receipt);return receipt;
  }},runtime:{chat:async(_id,_payload,chunk)=>{
    if(inferences<2)chunk({choices:[{delta:{tool_calls:[{index:0,id:`try-${inferences++}`,function:{name:"science_run",arguments:'{"name":"compute.run","arguments":{"path":"input.json"}}'}}]}}]});
    else chunk({choices:[{delta:{content:"The exact requested calculation succeeded on retry."}}]});
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Calculate",documentIds:[]});
  const message=(await settled(service,id)).messages.at(-1);
  assert.equal(message.state,"complete");assert.deepEqual(message.activity.map(item=>item.status),["error","complete"]);
  assert.deepEqual(message.activity.map(item=>item.execution.outcome),["tool-error","ok"]);
  assert.equal(message.activity[0].execution.argumentsSha256,message.activity[1].execution.argumentsSha256);
  assert.notEqual(message.activity[0].execution.operationId,message.activity[1].execution.operationId);
  assert.equal(message.activity[1].execution.capabilityId,"compute.run");
});

test("response token exhaustion preserves partial text without reporting completion",async t=>{
  const {service,id}=await setup(t,{runtime:{chat:async(_id,_payload,chunk)=>chunk({choices:[{delta:{content:"unfinished"},finish_reason:"length"}]})}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Answer",documentIds:[]});
  const session=await settled(service,id);
  assert.equal(session.messages[1].state,"error");assert.equal(session.messages[1].content,"unfinished");assert.match(session.error,/response limit/);
});

test("Chat refresh keeps an applied effect review incomplete until a verified recovery receipt exists",async t=>{
  const db=new DatabaseSync(":memory:"),journal=new ToolExecutionJournal(db);t.after(()=>db.close());
  let inferences=0;
  const {service,id}=await setup(t,{tools:{executionRecord:operationId=>journal.get(operationId),execute:async(_name,input,session,_signal,operationId)=>{
    const identity={operationId,scope:{surface:"chat",scopeId:session.messages.at(-1).id,parentOperationId:session.id},tool:"proto_compute_run",arguments:input.arguments,effect:"write"};
    const start=journal.begin(identity);journal.markDispatched(identity,start.leaseId);
    const receipt={ok:true,effect_state:"unknown"};journal.complete(identity,start.leaseId,receipt);return receipt;
  }},runtime:{chat:async(_id,_payload,chunk)=>{
    if(inferences++===0)chunk({choices:[{delta:{tool_calls:[{index:0,id:"ambiguous-call",function:{name:"science_run",arguments:'{"name":"compute.run","arguments":{"path":"input.json"}}'}}]}}]});
    else chunk({choices:[{delta:{content:"The result requires inspection."}}]});
  }}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Calculate",documentIds:[]});
  let message=(await settled(service,id)).messages.at(-1);
  const operationId=message.activity[0].execution.operationId;
  journal.reconcile(operationId,"applied","reviewer","build/effect-proof.json");
  message=(await service.request({action:"get",sessionId:id})).session.messages.at(-1);
  assert.equal(message.state,"incomplete-evidence");assert.equal(message.activity[0].status,"error");
  assert.equal(message.activity[0].execution.outcome,"ok","observed tool outcome does not override the missing recovered receipt");
  journal.recordReconciledReceipt(operationId,{ok:true,artifacts:["build/result.json"]});
  message=(await service.request({action:"get",sessionId:id})).session.messages.at(-1);
  assert.equal(message.state,"complete");assert.equal(message.activity[0].status,"complete");
});

test("cancelling an active tool clears its running state",async t=>{
  let started;
  const ready=new Promise(resolve=>started=resolve);
  const {service,id}=await setup(t,{tools:{execute:async(_name,_input,_session,signal)=>{started();await new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));}},runtime:{chat:async(_id,_payload,chunk)=>chunk({choices:[{delta:{tool_calls:[{index:0,id:"long-tool",function:{name:"workspace_search",arguments:'{"query":"data"}'}}]}}]})}});
  await service.request({action:"send",sessionId:id,modelId:"exact",content:"Search",documentIds:[]});await ready;
  const {session}=await service.request({action:"cancel",sessionId:id});
  assert.equal(session.messages[1].state,"stopped");assert.equal(session.messages[1].activity[0].status,"error");assert.match(session.messages[1].activity[0].output,/cancellation/);
});

test("external links cannot invoke local protocols or embed credentials",async t=>{
  const {service}=await setup(t);
  for(const url of ["file:///C:/Windows/system.ini","javascript:alert(1)","https://user:secret@example.com/"]) await assert.rejects(service.request({action:"open_link",url}));
});
