import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import test from "node:test";

registerHooks({load(url,context,nextLoad){
  if(url.endsWith("/renderer/mock-api.ts"))return {format:"module",shortCircuit:true,source:"export const workbenchApi = () => globalThis.__researchPagingApi;"};
  return nextLoad(url,context);
}});
const {useResearchChat:store}=await import("../src/renderer/research-chat-store.ts");
const {RESEARCH_SESSION_SCHEMA,emptyResearchState}=await import("../src/shared/research-session-state.ts");
const {SESSION_WINDOW_LIMIT,researchActivityPresentation}=await import("../src/renderer/research-chat-paging.ts");
const summary=id=>({id:String(id),title:`Conversation ${id}`,updatedAt:"2026-09-22T00:00:00Z",status:"idle"});
const session=(id,revision=1,execution)=>({...summary(id),createdAt:"2026-09-22T00:00:00Z",messages:[],documents:[],payloadSchema:RESEARCH_SESSION_SCHEMA,revision,researchState:emptyResearchState(),...(execution?{execution}:{})});
const transcriptMessage=(id,role="user")=>({id,role,content:id,createdAt:"2026-09-22T00:00:00Z",...(role==="assistant"?{state:"complete"}:{})});
const page=(ids,generation="g1",nextCursor=null,extra={})=>({sessions:ids.map(id=>typeof id==="object"?id:summary(id)),sessionPage:{generation,nextCursor,indexingPending:0,...extra}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const install=request=>{store.getState().reset();globalThis.__researchPagingApi={chat:{request}};};
const ids=()=>store.getState().sessions.map(item=>item.id);

test("polls preserve expanded pages, deduplicate boundary IDs, and retain the older cursor",async()=>{
  let reads=0;
  install(async input=>{assert.ok(input.limit<=30);return input.cursor?page(["b","c"],"g1","p3"):page(reads++?[{...summary("a"),title:"Updated"},"b"]:["a","b"],"g1","p2");});
  await store.getState().refresh();await store.getState().loadOlderSessions();await store.getState().refresh();
  assert.deepEqual(ids(),["a","b","c"]);assert.equal(store.getState().sessions[0].title,"Updated");assert.equal(store.getState().listNextCursor,"p3");
});

test("transcript pages merge chronologically and survive a newer bounded session snapshot",async()=>{
  let latest={sessionId:"conversation",revision:1,totalMessages:2,startIndex:1,transcriptSha256:"a".repeat(64),nextCursor:"before-1",messages:[transcriptMessage("m1","assistant")]};
  let older={sessionId:"conversation",revision:1,totalMessages:2,startIndex:0,transcriptSha256:"a".repeat(64),nextCursor:null,messages:[transcriptMessage("m0")]};
  install(async input=>{
    if(input.action==="get")return {session:{...session("conversation",latest.revision),messages:latest.messages},messagePage:latest};
    if(input.action==="messages")return {messagePage:older};
    return page([],"g1");
  });
  await store.getState().select("conversation");
  assert.deepEqual(store.getState().session.messages.map(message=>message.id),["m1"]);
  await store.getState().loadOlderMessages();
  assert.deepEqual(store.getState().session.messages.map(message=>message.id),["m0","m1"]);
  assert.equal(store.getState().messagePage.nextCursor,null);

  latest={sessionId:"conversation",revision:2,totalMessages:4,startIndex:2,transcriptSha256:"b".repeat(64),nextCursor:"before-2",messages:[transcriptMessage("m2"),transcriptMessage("m3","assistant")]};
  await store.getState().request({action:"get",sessionId:"conversation"});
  assert.deepEqual(store.getState().session.messages.map(message=>message.id),["m0","m1","m2","m3"]);
  assert.equal(store.getState().messagePage.startIndex,0);
  assert.equal(store.getState().messagePage.nextCursor,null);
});

test("generation changes preserve old pages, selection and draft until explicit reset",async()=>{
  let generation="g1",calls=0;
  install(async input=>input.action==="get"?{session:session(input.sessionId)}:(calls++,page([generation],generation,"older")));
  await store.getState().refresh();await store.getState().select("outside");store.getState().setDraft("Keep draft");
  generation="g2";await store.getState().refresh();assert.deepEqual(ids(),["g1"]);assert.equal(store.getState().listChanged,true);
  const before=calls;await store.getState().loadOlderSessions();assert.equal(calls,before);
  await store.getState().reloadSessions();assert.deepEqual(ids(),["g2"]);assert.equal(store.getState().listChanged,false);
  assert.equal(store.getState().session.id,"outside");assert.equal(store.getState().draft,"Keep draft");
});

test("expired cursors preserve visible rows and expose indexing progress without substituting a first page",async()=>{
  install(async input=>input.cursor?page([],"g2",null,{resetRequired:true,indexingPending:7}):page(["old"],"g1","old-cursor"));
  await store.getState().refresh();await store.getState().loadOlderSessions();
  assert.deepEqual(ids(),["old"]);assert.equal(store.getState().listChanged,true);assert.equal(store.getState().listIndexingPending,7);
});

test("late list success and failure cannot overwrite a newer explicit refresh",async()=>{
  const old=deferred(),failure=deferred();let calls=0;
  install(()=>++calls===1?old.promise:calls===2?Promise.resolve(page(["new"],"g2")):calls===3?failure.promise:Promise.resolve(page(["latest"],"g3")));
  const first=store.getState().refresh();await store.getState().reloadSessions();old.resolve(page(["obsolete"],"g0"));await first;
  assert.deepEqual(ids(),["new"]);
  const failed=store.getState().refresh();await store.getState().reloadSessions();failure.reject(Error("Old failure"));await failed;
  assert.deepEqual(ids(),["latest"]);assert.equal(store.getState().listError,undefined);assert.equal(store.getState().listBusy,false);
});

test("workspace reset clears its generation and rejects pending older rows and loading flags",async()=>{
  const pending=deferred();let workspace="old";
  install(input=>input.cursor?pending.promise:Promise.resolve(page([workspace],workspace,"older")));
  await store.getState().refresh();const old=store.getState().loadOlderSessions();store.getState().reset();
  assert.equal(store.getState().listGeneration,undefined);workspace="new";await store.getState().refresh();
  pending.resolve(page(["old-2"],"old"));await old;
  assert.deepEqual(ids(),["new"]);assert.equal(store.getState().listGeneration,"new");assert.equal(store.getState().listBusy,false);
});

test("duplicate older clicks dispatch once while an independent selection retains its draft",async()=>{
  const pending=deferred();let calls=0;
  install(input=>input.action==="get"?Promise.resolve({session:session(input.sessionId)}):input.cursor?(calls++,pending.promise):Promise.resolve(page(["a"],"g1","older")));
  await store.getState().refresh();const first=store.getState().loadOlderSessions(),second=store.getState().loadOlderSessions();
  await store.getState().select("unlisted");store.getState().setDraft("Unlisted draft");pending.resolve(page(["b"],"g1"));await Promise.all([first,second]);
  assert.equal(calls,1);assert.deepEqual(ids(),["a","b"]);assert.equal(store.getState().session.id,"unlisted");assert.equal(store.getState().draft,"Unlisted draft");
});

test("bounded windows reach older groups while off-page owned responses remain cancellable",async()=>{
  let calls=0;const cancellations=[];
  install(async input=>{
    if(input.action==="get")return {session:{...session(input.sessionId,1,{status:"owned",canCancel:true,canRecover:false,reason:"Owned"}),status:"generating"}};
    if(input.action==="cancel"){cancellations.push(input.sessionId);return {session:session(input.sessionId,2,{status:"none",canCancel:false,canRecover:false,reason:"Idle"})};}
    calls++;const start=Number(input.cursor??0),end=Math.min(450,start+input.limit);
    return page(Array.from({length:end-start},(_,i)=>start+i),"stable",end<450?String(end):null);
  });
  await store.getState().refresh();await store.getState().select("400");
  for(let index=0;index<6;index++)await store.getState().loadOlderSessions();
  assert.equal(ids().length,SESSION_WINDOW_LIMIT);assert.equal(new Set(ids()).size,200);
  const before=calls;await store.getState().loadOlderSessions();assert.equal(calls,before);
  await store.getState().nextSessionWindow();assert.equal(ids().length,30);assert.equal(ids()[0],"200");assert.equal(store.getState().listWindowOffset,200);
  await store.getState().refresh();assert.equal(ids()[0],"200");assert.equal(ids().length,30);
  await store.getState().cancel();assert.deepEqual(cancellations,["400"]);assert.equal(store.getState().session.id,"400");
  await store.getState().reloadSessions();assert.equal(ids()[0],"0");assert.equal(store.getState().listWindowOffset,0);assert.equal(store.getState().session.id,"400");
});

test("list failure does not prevent reading the selected complete conversation",async()=>{
  let revision=1;
  install(async input=>{if(input.action==="get")return {session:session(input.sessionId,revision)};throw Error("List unavailable");});
  await store.getState().select("selected");revision=2;await store.getState().refresh();
  assert.equal(store.getState().session.revision,2);assert.equal(store.getState().listError,"List unavailable");assert.equal(store.getState().error,undefined);
});

test("same-revision stale reads cannot regress execution ownership metadata",async()=>{
  const old=deferred();let calls=0;
  install(()=>++calls===1?Promise.resolve({session:session("a")}):calls===2?old.promise:Promise.resolve({session:session("a",1,{status:"live-elsewhere",canCancel:false,canRecover:false,reason:"Foreign owner"})}));
  await store.getState().select("a");const pending=store.getState().request({action:"get",sessionId:"a"});await store.getState().request({action:"get",sessionId:"a"});
  old.resolve({session:session("a",1,{status:"owned",canCancel:true,canRecover:false,reason:"Old owner"})});await pending;
  assert.equal(store.getState().session.execution.status,"live-elsewhere");
});

test("indexing and capped recovery details preserve a distinct total notice count",async()=>{
  const issues=Array.from({length:60},(_,i)=>({sessionId:String(i),code:"RETAINED",message:"Original retained",disposition:"retained-unopened"}));
  install(async()=>({...page([],"g1",null,{indexingPending:91}),recoveryIssues:issues,recoveryIssueCount:300}));
  await store.getState().refresh();assert.equal(store.getState().listIndexingPending,91);assert.equal(store.getState().recoveryIssues.length,50);assert.equal(store.getState().recoveryIssueCount,300);
});

test("unowned recovery requires explicit confirmation and captures revision without replaying tools",async()=>{
  const sent=[];
  install(async input=>{sent.push(input);return {session:session("legacy",input.action==="recover"?8:7,input.action==="recover"?{status:"none",canCancel:false,canRecover:false,reason:"Preserved"}:{status:"owner-unknown",canCancel:false,canRecover:true,reason:"No owner"})};});
  await store.getState().select("legacy");await store.getState().recover();assert.equal(sent.length,1);await store.getState().recover(true);
  assert.deepEqual(sent[1],{action:"recover",sessionId:"legacy",expectedRevision:7,confirmUnowned:true});assert.equal(sent.length,2);assert.equal(store.getState().session.revision,8);assert.equal(store.getState().busy,false);
});

test("live foreign ownership dispatches neither cancel nor recover",async()=>{
  const sent=[];install(async input=>{sent.push(input);return {session:{...session("foreign",1,{status:"live-elsewhere",canCancel:false,canRecover:false,reason:"Elsewhere"}),status:"generating"}};});
  await store.getState().select("foreign");await store.getState().cancel();await store.getState().recover(true);assert.deepEqual(sent.map(input=>input.action),["get"]);
});

test("an idle session with unfinished execution cannot send and keeps its unsent prompt",async()=>{
  const sent=[];install(async input=>{sent.push(input);return {session:session("unfinished",3,{status:"recoverable",canCancel:false,canRecover:true,reason:"Old activity unfinished"})};});
  await store.getState().select("unfinished");store.getState().setDraft("Keep prompt");await store.getState().send();
  assert.deepEqual(sent.map(input=>input.action),["get"]);assert.equal(store.getState().draft,"Keep prompt");
});

test("recorded unfinished work does not animate as live work and recovery errors remain errors",()=>{
  for(const state of [undefined,"none","owner-unknown","recoverable"])assert.deepEqual(researchActivityPresentation("running",state),{spinning:false,unconfirmed:true,label:"Completion unconfirmed"});
  for(const state of ["owned","live-elsewhere"])assert.deepEqual(researchActivityPresentation("running",state),{spinning:true,unconfirmed:false,label:"running"});
  assert.deepEqual(researchActivityPresentation("error","none"),{spinning:false,unconfirmed:false,label:"error"});assert.equal(researchActivityPresentation("complete","none").label,"Executed");
});
