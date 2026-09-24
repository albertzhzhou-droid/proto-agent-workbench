import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {ResearchChatService} from "../src/main/services/research-chat.ts";

const retained=JSON.parse(await readFile(new URL("./fixtures/research-evidence/acid-base-retained.json",import.meta.url),"utf8"));
async function finished(service,id) {
  for(let index=0;index<100;index++) {
    const {session}=await service.request({action:"get",sessionId:id});
    if(session.status==="idle") return session;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error("Fixture response did not settle");
}
async function setup(t,count=1) {
  const workspace=await mkdtemp(join(tmpdir(),"proto-chat-evidence-")), databasePath=join(workspace,"chat.sqlite");
  let step=0;
  const runtime={scan:async()=>[],load:async()=>({}),getExecutionBinding:async()=>({contextLength:32768,instanceId:"fixture"}),countExecutionTokens:async()=>({tokens:1500,method:"fixture"}),chat:async(_id,_request,chunk)=>{
    if(step<count) chunk({choices:[{delta:{tool_calls:[{index:0,id:`fixture-${step++}`,function:{name:"science_run",arguments:JSON.stringify(retained.requested)}}]}}]});
    else chunk({choices:[{delta:{content:retained.observed_text}}]});
  }};
  const options={databasePath,workspace,runtime,tools:{execute:async()=>structuredClone(retained.receipt)}};
  const service=new ResearchChatService(options);t.after(()=>service.close());
  const {session}=await service.request({action:"create"});
  await service.request({action:"send",sessionId:session.id,modelId:"fixture-no-model-execution",content:"Retained failure regression fixture",documentIds:[]});
  return {service,options,workspace,databasePath,session:await finished(service,session.id)};
}

test("real service saves a receipt digest and shows bound fields alongside unchanged unreviewed model text",async t=>{
  const {service,workspace,session}=await setup(t);
  const message=session.messages[1], call=message.activity[0];
  assert.equal(message.state,"complete");assert.equal(message.content,retained.observed_text);
  assert.equal(call.evidence.status,"bound-facts");assert.equal(call.evidence.interpretation,"unreviewed");
  assert.equal(call.evidence.facts[0].subjectId,"alpha_0");
  const bytes=await readFile(join(workspace,call.artifactPath));
  assert.equal(call.artifactSha256,createHash("sha256").update(bytes).digest("hex"));
  await writeFile(join(workspace,call.artifactPath),"{}");
  const reopened=(await service.request({action:"get",sessionId:session.id})).session;
  assert.equal(reopened.messages[1].activity[0].evidence.status,"mismatch");
  assert.deepEqual(reopened.messages[1].activity[0].evidence.facts,[]);
  assert.equal(reopened.messages[1].content,retained.observed_text);
});

test("SQLite reload never promotes old digest-free records or trusts stored evidence cards",async t=>{
  const {service,options,databasePath,session}=await setup(t);await service.close();
  const db=new DatabaseSync(databasePath);
  const saved=JSON.parse(db.prepare("SELECT payload FROM research_chats WHERE id=?").get(session.id).payload);
  const call=saved.messages[1].activity[0];delete call.artifactSha256;
  call.evidence={schema:"proto-workbench.research-evidence.v1",status:"bound-facts",facts:[{subjectId:"forged",value:999}],diagnostics:[]};
  db.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(JSON.stringify(saved),session.id);db.close();
  const reloaded=new ResearchChatService(options);t.after(()=>reloaded.close());
  const current=(await reloaded.request({action:"get",sessionId:session.id})).session.messages[1].activity[0];
  assert.equal(current.evidence.status,"unreviewed");assert.deepEqual(current.evidence.facts,[]);
  assert.deepEqual(current.evidence.diagnostics,["NO_HOST_RECEIPT_DIGEST"]);
});

test("snapshot work is bounded and older candidates are explicitly unreviewed",async t=>{
  // The repetition guard intentionally stops the fourth identical call. Seed
  // additional historical activities through SQLite to test snapshot work only.
  const {service,options,databasePath,session}=await setup(t);await service.close();
  const db=new DatabaseSync(databasePath), saved=JSON.parse(db.prepare("SELECT payload FROM research_chats WHERE id=?").get(session.id).payload);
  const original=saved.messages[1].activity[0];
  saved.messages[1].activity=Array.from({length:10},(_,i)=>({...original,id:`historical-${i}`}));
  db.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(JSON.stringify(saved),session.id);db.close();
  const reloaded=new ResearchChatService(options);t.after(()=>reloaded.close());
  const calls=(await reloaded.request({action:"get",sessionId:session.id})).session.messages[1].activity;
  assert.equal(calls.filter(call=>call.evidence.status==="bound-facts").length,8);
  assert.equal(calls.filter(call=>call.evidence.diagnostics.includes("SNAPSHOT_PROJECTION_LIMIT")).length,2);
});
