import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchChatService } from "../src/main/services/research-chat.ts";
import { RESEARCH_STORAGE_LIMITS, ResearchChatRepository } from "../src/main/services/research-chat-repository.ts";
import { emptyResearchState, encodeResearchSession } from "../src/shared/research-session-state.ts";
import { pdfFixture } from "./helpers/research-document-fixtures.mjs";

const STAMP="2026-09-22T03:00:00.000Z";
const legacy=(id=randomUUID(),extra={})=>({id,title:"Study",createdAt:STAMP,updatedAt:STAMP,status:"idle",messages:[],documents:[],...extra});
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};}
function runtime(extra={}){return{scan:async()=>[],load:async()=>({}),getExecutionBinding:async()=>({contextLength:32768,instanceId:"fixture"}),countExecutionTokens:async()=>({tokens:500,method:"fixture"}),chat:async(_id,_payload,chunk)=>chunk({choices:[{delta:{content:"Done"}}]}),...extra};}
async function fixture(t,options={}){
  const base=resolve(import.meta.dirname,"../../../build/research-paging-20260922/tests");await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,"case-")),databasePath=join(root,"chat.sqlite"),instances=[];
  const db=new DatabaseSync(databasePath);db.exec("CREATE TABLE research_chats(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL)");db.close();
  const sql=fn=>{const db=new DatabaseSync(databasePath);try{return fn(db);}finally{db.close();}};
  const seed=(session,raw=JSON.stringify(session),columnTime=session.updatedAt)=>sql(db=>db.prepare("INSERT INTO research_chats VALUES(?,?,?,?)").run(session.id,root,columnTime,raw));
  const raw=id=>sql(db=>db.prepare("SELECT payload FROM research_chats WHERE id=?").get(id).payload);
  const open=overrides=>{const service=new ResearchChatService({workspace:root,databasePath,runtime:runtime(),...options,...overrides});instances.push(service);return service;};
  t.after(async()=>{for(const instance of instances)await instance.close();});return{root,databasePath,seed,raw,open,sql};
}
const get=async(service,id)=>(await service.request({action:"get",sessionId:id})).session;
async function getAllMessages(service,id){
  const pages=[];let response=await service.request({action:"messages",sessionId:id,limit:40});
  while(response.messagePage){pages.push(response.messagePage);const cursor=response.messagePage.nextCursor;if(!cursor)break;response=await service.request({action:"messages",sessionId:id,cursor,limit:40});}
  return pages.sort((a,b)=>a.startIndex-b.startIndex).flatMap(page=>page.messages);
}
async function completeIndex(service,limit=30){let result;do{result=await service.request({action:"list",limit});}while(result.sessionPage.indexingPending);return result;}

test("startup decodes no sessions, legacy indexing is bounded, and tied-time pages cover all rows exactly once",async t=>{
  const f=await fixture(t);const ids=[];
  for(let index=0;index<65;index++){const session=legacy();ids.push(session.id);f.seed(session);}
  const service=f.open();assert.equal(service.cache.stats().entries,0);
  assert.equal(f.sql(db=>db.prepare("SELECT COUNT(*) n FROM research_chat_summaries").get().n),0);
  const first=await service.request({action:"list",limit:10});assert.equal(first.sessions.length,10);assert.equal(first.sessionPage.indexingPending,35);assert.equal(service.cache.stats().entries,0);
  const stale=await service.request({action:"list",limit:10,cursor:first.sessionPage.nextCursor});assert.equal(stale.sessionPage.resetRequired,true);assert.deepEqual(stale.sessions,[]);
  let page=await completeIndex(service),seen=[];
  while(true){seen.push(...page.sessions.map(item=>item.id));if(!page.sessionPage.nextCursor)break;page=await service.request({action:"list",cursor:page.sessionPage.nextCursor});}
  assert.deepEqual(seen,[...ids].sort().reverse());assert.equal(new Set(seen).size,65);
  const last=await get(service,seen.at(-1));assert.equal(last.id,seen.at(-1));assert.deepEqual(last.messages,[]);assert.equal(service.cache.stats().entries,1);
});

test("indexed summaries bound legacy strings, normalize timestamps and reject a cursor from another page size/workspace",async t=>{
  const f=await fixture(t);const old=legacy(undefined,{updatedAt:"2026-09-21T23:00:00-04:00",title:"T".repeat(8000),modelId:"M".repeat(8000)});
  const latest=legacy(undefined,{updatedAt:"2026-09-22T03:01:00.000Z"});f.seed(old,undefined,"2099-01-01");f.seed(latest,undefined,"1900-01-01");
  const service=f.open();const page=await completeIndex(service,1);assert.equal(page.sessions[0].id,latest.id);
  const second=await service.request({action:"list",limit:1,cursor:page.sessionPage.nextCursor});assert.equal(second.sessions[0].updatedAt,STAMP);
  assert.equal(second.sessions[0].title.length,120);assert.equal(second.sessions[0].modelId.length,1024);assert.equal(JSON.parse(f.raw(old.id)).title.length,8000);
  await assert.rejects(service.request({action:"list",limit:2,cursor:page.sessionPage.nextCursor}),error=>error.code==="INVALID_CURSOR");
  const other=await fixture(t);await assert.rejects(other.open().request({action:"list",limit:1,cursor:page.sessionPage.nextCursor}),error=>error.code==="INVALID_CURSOR");
});

test("malformed, future and UTF-8-oversized rows beyond the first batch retain exact bytes and surface recovery notices",async t=>{
  const f=await fixture(t);for(let index=0;index<31;index++)f.seed(legacy(undefined,{updatedAt:"2026-09-23T00:00:00.000Z"}));
  const bad=legacy(),future=legacy(),large=legacy();const originals=new Map([[bad.id," { broken\n"],[future.id,JSON.stringify({...future,payloadSchema:"proto-workbench.research-session.v999"})],[large.id,JSON.stringify({...large,title:"🧪".repeat(1100)})]]);
  for(const [id,raw]of originals)f.seed({...legacy(id)},raw);
  const service=f.open({storageLimits:{payloadBytes:4096,indexBytes:4096}});
  const first=await service.request({action:"list"});assert.ok(first.sessionPage.indexingPending>0);
  const final=await completeIndex(service);assert.equal(final.recoveryIssueCount,3);assert.deepEqual(new Set(final.recoveryIssues.map(issue=>issue.code)),new Set(["MALFORMED_JSON","UNSUPPORTED_SCHEMA","PAYLOAD_TOO_LARGE"]));
  for(const [id,raw]of originals){assert.equal(f.raw(id),raw);await assert.rejects(get(service,id),/retained payload/);}
});

test("an older SQL writer invalidates the index and prior cursors without exposing stale navigation fields",async t=>{
  const f=await fixture(t);const records=[legacy(),legacy(),legacy()];for(const record of records)f.seed(record);
  const service=f.open();const page=await completeIndex(service,1),changed=records[0];
  const payload={...JSON.parse(f.raw(changed.id)),title:"External writer",updatedAt:"2027-01-01T00:00:00.000Z"};
  f.sql(db=>db.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(JSON.stringify(payload),changed.id));
  assert.equal(f.sql(db=>db.prepare("SELECT dirty FROM research_chat_summaries WHERE id=?").get(changed.id).dirty),1);
  const stale=await service.request({action:"list",limit:1,cursor:page.sessionPage.nextCursor});assert.equal(stale.sessionPage.resetRequired,true);
  const fresh=await service.request({action:"list",limit:1});assert.equal(fresh.sessions[0].id,changed.id);assert.equal(fresh.sessions[0].title,"External writer");
});

test("complete-session lazy reads retain old research-state sources through byte/count LRU eviction",async t=>{
  const f=await fixture(t);const original=legacy();original.messages=Array.from({length:61},(_,index)=>({id:randomUUID(),role:index%2?"assistant":"user",content:index===0?"Keep all data local.":`Message ${index}`,createdAt:STAMP}));
  const stored={...original,payloadSchema:"proto-workbench.research-session.v1",revision:1,researchState:{...emptyResearchState(),confirmedConstraints:[{id:"local",text:"Keep all data local.",sourceMessageId:original.messages[0].id,sourceRole:"user"}]}};
  f.seed(stored);const others=Array.from({length:4},()=>legacy());for(const other of others)f.seed(other);
  const service=f.open({storageLimits:{cacheEntries:1,cacheBytes:4000}});
  const opened=await get(service,stored.id);assert.equal(opened.messages.length,40);
  assert.equal((await getAllMessages(service,stored.id)).length,61);
  for(const other of others)await get(service,other.id);
  assert.ok(service.cache.stats().entries<=1);assert.ok(service.cache.stats().bytes<=4000);
  const restored=await get(service,stored.id);assert.equal(restored.messages.length,40);assert.equal((await getAllMessages(service,stored.id)).length,61);assert.equal(restored.researchState.confirmedConstraints[0].sourceMessageId,original.messages[0].id);assert.equal(f.raw(stored.id),JSON.stringify(stored));
});

test("binding discovery and generation keep their canonical session pinned while older pages are evicted",async t=>{
  const binding=gate(),model=gate();let entered;const started=new Promise(resolve=>{entered=resolve;});let first=true;
  const f=await fixture(t,{storageLimits:{cacheEntries:1,cacheBytes:4000},runtime:runtime({getExecutionBinding:async()=>{if(first){first=false;await binding.promise;}return{contextLength:32768,instanceId:"fixture"};},chat:async(_id,_payload,chunk,signal)=>{chunk({choices:[{delta:{content:"Held generation"}}]});entered();await Promise.race([model.promise,new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}))]);}})});
  const service=f.open();const id=(await service.request({action:"create"})).session.id;
  const sending=service.request({action:"send",sessionId:id,modelId:"fixture",content:"Start",documentIds:[]});
  assert.equal(service.cache.isPinned(id),true);
  for(let index=0;index<4;index++)await service.request({action:"create"});
  assert.equal(service.cache.isPinned(id),true);binding.release();await sending;await started;
  for(let index=0;index<4;index++)await service.request({action:"create"});
  assert.equal((await get(service,id)).messages.at(-1).content,"Held generation");assert.equal(service.cache.isPinned(id),true);
  model.release();await service.request({action:"cancel",sessionId:id});assert.equal(service.cache.stats().pinned,0);assert.ok(service.cache.stats().entries<=1);
});

test("async file reads and real PDF imports retain pins until their snapshots finish; close awaits pending reads",async t=>{
  const readGate=gate();const f=await fixture(t,{storageLimits:{cacheEntries:1},readFile:async()=>{await readGate.promise;return{path:"notes.txt",content:"Read evidence",sha256:"f".repeat(64)};}});
  const service=f.open();const id=(await service.request({action:"create"})).session.id;
  const reading=service.request({action:"read",sessionId:id,path:"notes.txt"});assert.equal(service.cache.isPinned(id),true);
  for(let index=0;index<3;index++)await service.request({action:"create"});
  readGate.release();assert.equal((await reading).session.documents[0].content,"Read evidence");assert.equal(service.cache.stats().pinned,0);
  const importing=service.request({action:"import",sessionId:id,name:"study.pdf",base64:pdfFixture().toString("base64")});assert.equal(service.cache.isPinned(id),true);
  await service.request({action:"create"});const imported=await importing;assert.equal(imported.session.documents[1].extraction.unitCount,2);assert.equal(service.cache.stats().pinned,0);
  const held=gate();const closingService=f.open({readFile:async()=>{await held.promise;return{path:"late.txt",content:"Finish read",sha256:"f".repeat(64)};}});
  const pending=closingService.request({action:"read",sessionId:id,path:"late.txt"});let closed=false;const closing=closingService.close().then(()=>{closed=true;});
  await Promise.resolve();assert.equal(closed,false);held.release();await pending;await closing;assert.equal(closed,true);
});

test("failed pin admission trims rejected sessions and ordinary saves release stable pin counts",async t=>{
  const held=gate();let first=true;const f=await fixture(t,{storageLimits:{cacheEntries:1,pinnedEntries:1},runtime:runtime({getExecutionBinding:async()=>{if(first){first=false;await held.promise;}return{contextLength:32768,instanceId:"fixture"};}})});
  const records=Array.from({length:6},()=>legacy());for(const record of records)f.seed(record);
  const service=f.open();const sending=service.request({action:"send",sessionId:records[0].id,modelId:"fixture",content:"Start",documentIds:[]});
  for(const record of records.slice(1)){await assert.rejects(get(service,record.id),error=>error.code==="CACHE_ADMISSION");assert.equal(service.cache.stats().entries,1);}
  held.release();await sending;await Promise.all([...service.running.values()].map(run=>run.done));
  await service.request({action:"rename",sessionId:records[0].id,title:"Updated"});assert.equal(service.cache.stats().pinned,0);
});

test("a second service created during generation cannot cancel, recover or normalize its live database owner",async t=>{
  const held=gate(),began=gate();const f=await fixture(t,{runtime:runtime({chat:async(_id,_payload,chunk,signal)=>{chunk({choices:[{delta:{content:"Still executing"}}]});began.release();await Promise.race([held.promise,new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}))]);}})});
  const first=f.open();const id=(await first.request({action:"create"})).session.id;
  await first.request({action:"send",sessionId:id,modelId:"fixture",content:"Start",documentIds:[]});await began.promise;const raw=f.raw(id);
  const second=f.open();let view=await get(second,id);assert.equal(view.status,"generating");assert.equal(view.execution.status,"live-elsewhere");assert.equal(view.execution.canCancel,false);assert.equal(view.execution.canRecover,false);assert.equal(f.raw(id),raw);
  for(const request of [{action:"cancel"},{action:"recover",expectedRevision:view.revision,confirmUnowned:true},{action:"rename",title:"Not owned"}])await assert.rejects(second.request({sessionId:id,...request}),error=>error.code==="EXECUTION_OWNERSHIP");
  held.release();await first.request({action:"cancel",sessionId:id});view=await get(second,id);assert.equal(view.status,"idle");assert.equal(view.execution.status,"none");
});

test("closed owners are explicitly recoverable; a live PID with another nonce and missing owner metadata remain blocked",async t=>{
  const f=await fixture(t);const record=legacy(undefined,{status:"generating",messages:[{id:randomUUID(),role:"assistant",content:"Partial",createdAt:STAMP,state:"streaming"}]});f.seed(record);
  const service=f.open();const other=new ResearchChatRepository(f.databasePath,f.root);const owner=other.ownerId;
  f.sql(db=>db.prepare("INSERT INTO research_chat_runs(session_id,owner_id,run_id,acquired_at) VALUES(?,?,?,?)").run(record.id,owner,randomUUID(),STAMP));
  let view=await get(service,record.id);assert.equal(view.execution.canRecover,false);
  f.sql(db=>db.prepare("UPDATE research_chat_owners SET process_nonce=? WHERE owner_id=?").run("unrecognized-nonce",owner));
  view=await get(service,record.id);assert.equal(view.execution.canRecover,false);
  other.close();view=await get(service,record.id);assert.equal(view.execution.status,"recoverable");
  view=(await service.request({action:"recover",sessionId:record.id,expectedRevision:view.revision})).session;assert.equal(view.status,"idle");assert.equal(view.messages[0].state,"stopped");
  assert.equal(view.execution.status,"none");
  const missing=legacy(undefined,{status:"generating"});f.seed(missing);
  f.sql(db=>db.prepare("INSERT INTO research_chat_runs(session_id,owner_id,run_id,acquired_at) VALUES(?,?,?,?)").run(missing.id,randomUUID(),randomUUID(),STAMP));
  view=await get(service,missing.id);assert.equal(view.execution.status,"owner-unknown");assert.equal(view.execution.canRecover,false);
});

test("oversized terminal saves retain the previous payload and leave a stopped execution explicitly recoverable",async t=>{
  const f=await fixture(t,{storageLimits:{payloadBytes:4096,indexBytes:4096},runtime:runtime({chat:async(_id,_payload,chunk)=>chunk({choices:[{delta:{content:"x".repeat(6000)}}]})})});
  const service=f.open();const id=(await service.request({action:"create"})).session.id;
  await service.request({action:"send",sessionId:id,modelId:"fixture",content:"Start",documentIds:[]});await Promise.all([...service.running.values()].map(run=>run.done));
  const raw=f.raw(id);assert.ok(Buffer.byteLength(raw)<=4096);let view=await get(service,id);
  assert.equal(view.status,"generating");assert.equal(view.execution.status,"recoverable");assert.equal(view.execution.canCancel,false);assert.equal(service.cache.stats().pinned,0);
  view=(await service.request({action:"recover",sessionId:id,expectedRevision:view.revision})).session;assert.equal(view.status,"idle");assert.equal(view.execution.status,"none");assert.equal(view.messages.at(-1).content,"");
});

test("CAS after a pinned asynchronous read discards its dirty document and reloads the external winner",async t=>{
  const held=gate();const f=await fixture(t,{readFile:async()=>{await held.promise;return{path:"notes.txt",content:"Losing document",sha256:"f".repeat(64)};}});
  const first=f.open();const id=(await first.request({action:"create"})).session.id;const pending=first.request({action:"read",sessionId:id,path:"notes.txt"});
  const second=f.open();await second.request({action:"rename",sessionId:id,title:"Winner"});const winner=f.raw(id);held.release();
  await assert.rejects(pending,error=>error.code==="REVISION_CONFLICT");assert.equal(f.raw(id),winner);
  const view=await get(first,id);assert.equal(view.title,"Winner");assert.equal(view.documents.length,0);assert.equal(first.cache.stats().pinned,0);
});

test("explicit recovery preserves partial tool output and artifact identity exactly, with a separate interruption annotation",async t=>{
  const f=await fixture(t);const output='  {"partial":true,"values":[3,7],"note":"未完成 🧪"}\n';
  const activity={id:randomUUID(),tool:"compute.run",input:{method:"fixture"},status:"running",startedAt:STAMP,finishedAt:STAMP,
    output,artifactPath:"build/chat/historical-partial.json",artifactSha256:"a".repeat(64),unknownExtension:{preserve:true}};
  const record=legacy(undefined,{status:"generating",messages:[{id:randomUUID(),role:"assistant",content:"Partial assistant text",createdAt:STAMP,state:"streaming",activity:[activity]}]});
  f.seed(record);const service=f.open();const initial=await get(service,record.id);
  const recovered=(await service.request({action:"recover",sessionId:record.id,expectedRevision:initial.revision,confirmUnowned:true})).session;
  const restored=recovered.messages[0].activity[0];
  assert.equal(restored.output,output);assert.equal(restored.artifactPath,activity.artifactPath);assert.equal(restored.artifactSha256,activity.artifactSha256);
  assert.equal(restored.finishedAt,STAMP);assert.deepEqual(restored.unknownExtension,activity.unknownExtension);
  assert.equal(restored.status,"error");assert.equal(restored.interruption.source,"explicit-recovery");assert.match(restored.interruption.message,/no tool was replayed/);
  await service.close();const reopened=f.open();assert.equal((await get(reopened,record.id)).messages[0].activity[0].output,output);
});

test("malformed optional interruption annotations are isolated with their exact original row retained",async t=>{
  const f=await fixture(t);const originals=new Map();
  for(const interruption of ["wrong shape",{source:"assistant",message:"Not host recovery",recordedAt:STAMP},
    {source:"explicit-recovery",message:{bad:"value"},recordedAt:STAMP},
    {source:"explicit-recovery",message:"Interrupted",recordedAt:"invalid-date"}]){
    const record=legacy(undefined,{messages:[{id:randomUUID(),role:"assistant",content:"Saved",createdAt:STAMP,
      activity:[{id:randomUUID(),tool:"compute.run",input:{},status:"error",startedAt:STAMP,output:"Keep this exactly",interruption}]}]});
    const raw=JSON.stringify(record,null,3);f.seed(record,raw);originals.set(record.id,raw);
  }
  const service=f.open();const listing=await service.request({action:"list"});assert.deepEqual(listing.sessions,[]);assert.equal(listing.recoveryIssueCount,4);
  assert.ok(listing.recoveryIssues.every(issue=>issue.code==="INVALID_SESSION"));
  for(const [id,raw]of originals)assert.equal(f.raw(id),raw);
});
